r"""Local advisor server: the userscript streams the battle in, advice comes back out.

    python -m laplace.advisor.server                              # gen9almostanyability
    python -m laplace.advisor.server --format gen9ou
    python -m laplace.advisor.server --worlds 12 --time-ms 200    # more search per turn

or just double-click start-advisor.bat. Then open
    http://127.0.0.1:8765/laplace-advisor.user.js
in a browser with Tampermonkey installed, and click Install.

Endpoints (all need the header X-Laplace: 1, which a random web page cannot send
cross-origin without a CORS preflight this server never approves):
    POST /feed    {user, room, data}   raw protocol payload for one battle room
    POST /reset   {room}               forget a battle (the overlay's resync button)
    GET  /advice?room=<tag>            latest advice + status for that room
    GET  /ping                         liveness + which format this server analyses

Bound to 127.0.0.1 only. The payloads include your team (it is in the |request|); they never
leave this machine.

Threading: HTTP handlers only enqueue. ONE worker thread feeds payloads, in order, to the
player on poke-env's event loop -- the search blocks that loop for ~1-2s per decision, which
is fine because nothing else is waiting on it.
"""

import argparse
import asyncio
import concurrent.futures
import json
import os
import queue
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

# ladder FIRST: its module-level --fork block must run before poke_engine is imported.
from laplace.cli import ladder
from laplace.advisor.player import AdviceCollector, AdvisorPlayer
from laplace import paths

from poke_env import AccountConfiguration
from poke_env.data import to_id_str

USERSCRIPT = os.path.join(paths.ROOT, "userscript", "laplace-advisor.user.js")
FEED_TIMEOUT_S = 90


def _loop(agent):
    loop = getattr(agent.ps_client, "loop", None)
    if loop is None:
        from poke_env.concurrency import POKE_LOOP as loop
    return loop


class Advisor:
    def __init__(self, fmt, agent_kw):
        self.fmt = fmt
        self.agent_kw = agent_kw
        self.agent = None
        self.user = None
        self.q = queue.Queue()
        self.thinking = False
        self.thinking_room = None
        self.status = {}                      # room -> {"error"/"ignored": text}
        self.instance = uuid.uuid4().hex
        threading.Thread(target=self._worker, daemon=True).start()

    # --- agent ---------------------------------------------------------------

    def _ensure_agent(self, user):
        uid = to_id_str(user or "advisor")
        if self.agent is not None and uid == self.user:
            return self.agent
        self.agent = ladder.build_agent(
            AccountConfiguration(user or "advisor", None),
            fork=ladder.FORK_MODE and not ladder.FORK_BASELINE,
            cls=AdvisorPlayer, observer=AdviceCollector(), **self.agent_kw)
        self.user = uid
        return self.agent

    # --- worker --------------------------------------------------------------

    def _worker(self):
        while True:
            kind, body = self.q.get()
            self.thinking = True
            room = body.get("room", "")
            self.thinking_room = room
            try:
                (self._reset if kind == "reset" else self._feed)(body)
            except Exception as exc:                       # never let the worker die
                self.status[room] = {"error": f"server error: {exc!r}"}
                print(f"  ERROR on {room}: {exc!r}", flush=True)
            finally:
                self.thinking = False
                self.thinking_room = None
                self.q.task_done()

    def _reset(self, body):
        if self.agent is not None:
            agent = self.agent

            async def forget():
                agent.forget(body["room"])

            asyncio.run_coroutine_threadsafe(forget(), _loop(agent)).result(timeout=FEED_TIMEOUT_S)
        self.status.pop(body["room"], None)
        # New clients send the snapshot with the reset so no live feed can land
        # between forgetting a room and rebuilding it. Old reset-only clients work.
        if body.get("data"):
            self._feed(body)

    def _feed(self, body):
        room, data = body["room"], body["data"]
        agent = self._ensure_agent(body.get("user"))
        parts = room.split("-")
        if len(parts) < 2 or parts[1] != self.fmt:
            self.status[room] = {"ignored": f"{parts[1] if len(parts) > 1 else '?'} "
                                            f"(this advisor runs {self.fmt})"}
            return
        if room not in agent.battles and "|init|battle" not in data:
            self.status[room] = {"error": "Missed the start of this battle -- press the "
                                          "resync button (⟳)."}
            return
        before = (agent.advice.get(room) or {}).get("seq")
        split = [m.split("|") for m in data.split("\n")]
        async def deliver():
            # Page reload/reconnect also sends a complete init log. Do not replay
            # it over an existing battle (or process its win/tie a second time).
            if len(split) > 1 and split[1][1:3] == ["init", "battle"]:
                agent.forget(room)
            await agent._handle_battle_message(split)

        fut = asyncio.run_coroutine_threadsafe(deliver(), _loop(agent))
        try:
            fut.result(timeout=FEED_TIMEOUT_S)
            self.status.pop(room, None)
        except concurrent.futures.TimeoutError:
            fut.cancel()
            self.status[room] = {"error": "Timed out processing this battle -- try resync."}
            return
        a = agent.advice.get(room)
        if a and a.get("seq") != before:
            if a["kind"] == "lead":
                print(f"  {room[-14:]}  lead: {a['lead']}", flush=True)
            elif a["kind"] == "error":
                print(f"  {room[-14:]}  T{a['turn']}: {a['message']}", flush=True)
            else:
                ev = f"  eval {a['eval']:.2f}" if a["eval"] is not None else ""
                print(f"  {room[-14:]}  T{a['turn']}: {a['label']}{ev}  "
                      f"[{a['ms'] / 1000:.1f}s, {a['worlds']} worlds]", flush=True)

    # --- reads (HTTP threads) ------------------------------------------------

    def advice_for(self, room):
        a = self.agent.advice.get(room) if self.agent is not None else None
        return {"ok": True, "format": self.fmt, "room": room, "advice": a,
                "instance": self.instance,
                "needs_sync": self.agent is None or room not in self.agent.battles,
                "thinking": self.thinking and self.thinking_room == room, "queued": self.q.qsize(),
                "status": self.status.get(room)}


def make_handler(adv):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def _send(self, obj, code=200, ctype="application/json", raw=None):
            body = raw if raw is not None else json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _guard(self):
            if self.headers.get("X-Laplace") != "1":
                self._send({"ok": False, "error": "forbidden"}, 403)
                return False
            return True

        def do_GET(self):
            url = urlparse(self.path)
            if url.path == "/laplace-advisor.user.js":     # the install URL, no header possible
                try:
                    with open(USERSCRIPT, "rb") as f:
                        self._send(None, ctype="text/javascript; charset=utf-8", raw=f.read())
                except OSError:
                    self._send({"ok": False, "error": f"missing {USERSCRIPT}"}, 404)
                return
            if not self._guard():
                return
            if url.path == "/ping":
                self._send({"ok": True, "format": adv.fmt})
            elif url.path == "/advice":
                self._send(adv.advice_for(parse_qs(url.query).get("room", [""])[0]))
            else:
                self._send({"ok": False}, 404)

        def do_POST(self):
            if not self._guard():
                return
            try:
                size = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(size) or b"{}")
            except ValueError:
                self._send({"ok": False, "error": "bad json"}, 400)
                return
            path = urlparse(self.path).path
            if path in ("/feed", "/reset") and "room" in body:
                adv.q.put(("reset" if path == "/reset" else "feed", body))
                self._send({"ok": True})
            else:
                self._send({"ok": False}, 404)

    return Handler


def main():
    ap = argparse.ArgumentParser(description="Local Laplace move advisor for the browser.")
    ap.add_argument("--format", default="gen9almostanyability", choices=sorted(ladder.FORMATS),
                    help="the one format this server analyses (default gen9almostanyability)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--worlds", type=int, default=None, help="determinized worlds per turn")
    ap.add_argument("--time-ms", type=int, default=None, help="MCTS ms per world")
    ap.add_argument("--threads", type=int, default=None, help="engine threads per world")
    ap.add_argument("--scarf", action="store_true",
                    help="force the Choice Scarf speed inference on (off for AAA by default)")
    ap.add_argument("--fork", action="store_true", help="fork engine; handled at import time")
    ap.add_argument("--fork-baseline", action="store_true", help="handled at import time")
    args = ap.parse_args()

    profile = ladder.configure(args.format, require_team=False)
    agent_kw = dict(start_listening=False, record=False, mix_root=False, futility_guard=False)
    for key, val in (("n_determinizations", args.worlds), ("search_time_ms", args.time_ms),
                     ("threads", args.threads)):
        if val is not None:
            agent_kw[key] = val
    if args.scarf:
        agent_kw["speed_inference"] = True

    ready = getattr(profile.metagame, "ready", None)
    if ready is not None:
        ok, message = ready()
        print(f"  {'' if ok else 'WARNING: '}{message}", flush=True)

    adv = Advisor(profile.name, agent_kw)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(adv))
    print(f"Laplace advisor ({profile.name}) on http://127.0.0.1:{args.port}\n"
          f"  install the userscript: http://127.0.0.1:{args.port}/laplace-advisor.user.js\n"
          f"  Ctrl-C to stop.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.", flush=True)


if __name__ == "__main__":
    main()
