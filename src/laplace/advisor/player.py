r"""The bot, run as an ADVISOR: it searches and explains, but never sends a move.

The userscript forwards the Showdown protocol for the user's own battle. This player is fed
those payloads exactly as poke-env would receive them from the websocket, so the whole
pipeline (battle tracking, hazard / Scarf / ability inference, determinized MCTS, guards)
runs unchanged. The only things cut are the outputs: ps_client.send_message is replaced by a
no-op, so nothing it decides ever reaches the server, and the search's observer events are
condensed into a JSON dict per decision for the overlay.

Advisor-specific config (set by server.py, not here):
  mix_root=False        advice should be the top-ranked line, not a sampled one
  futility_guard=False  it reads OUR decision history, and the user's actual clicks are not
                        the bot's -- the history would describe a game that never happened
"""

import time
from collections import Counter

from laplace.agent.engine_search import EnginePlayer
from laplace.analysis.live_analysis import LiveAnalyzer, _pretty, _species_name
from poke_env.data import to_id_str


def _action_for_choice(battle, choice):
    """Map the engine choice to the exact slots in Showdown's current request."""
    request = battle.last_request
    if choice.startswith("switch "):
        species = choice.split(" ", 1)[1]
        mon = next((m for m in battle.available_switches
                    if species in (to_id_str(m.species), to_id_str(m.base_species))), None)
        if mon is not None:
            for slot, entry in enumerate(request.get("side", {}).get("pokemon", []), 1):
                if battle.team.get(entry["ident"]) is mon:
                    return {"type": "switch", "slot": slot}
        return None
    tera = choice.endswith("-tera")
    move = choice[:-5] if tera else choice
    for slot, entry in enumerate((request.get("active") or [{}])[0].get("moves", []), 1):
        if to_id_str(entry.get("id") or entry.get("move", "")) == move and not entry.get("disabled"):
            return {"type": "move", "slot": slot, "tera": tera}
    return None


class _Quiet(LiveAnalyzer):
    """LiveAnalyzer with the printing removed -- used only for its per-turn accumulators."""

    def line(self, text=""):
        pass

    def _progress(self, text):
        pass

    def _close_progress(self):
        pass


class AdviceCollector:
    """EnginePlayer observer -> one advice dict per decision, written to `sink[room]`."""

    N_CANDIDATES = 5

    def __init__(self):
        self.q = _Quiet("", color=False, unicode=False)
        self.sink = {}

    def bind(self, agent):
        self.q.attach(agent)
        self.sink = agent.advice

    def __call__(self, event, **data):
        if event == "decision":
            self._decision(**data)
        else:
            self.q(event, **data)

    def _decision(self, battle, choice, ranked, mixed, reorders, fallback, ms):
        q = self.q
        room = battle.battle_tag
        if fallback or choice.startswith("<"):
            self.sink[room] = {"kind": "error", "turn": battle.turn, "seq": time.time_ns(),
                               "message": "No usable search result this turn "
                                          "(a world may have failed -- see the server log)."}
            return
        shares, wins = q._pooled_shares()
        evals = q._choice_evals()
        n_ok, n_total = len(q._worlds), q._budget[0]
        candidates = []
        for ch, _score in ranked[:self.N_CANDIDATES]:
            candidates.append({
                "choice": ch, "label": _pretty(ch), "best": ch == choice,
                "share": round(shares.get(ch, 0.0), 3), "worlds": wins.get(ch, 0),
                "eval": round(evals[ch], 3) if ch in evals else None,
                "veto": q._vetoed.get(ch),
            })
        reply, reply_share = q._expected_reply()
        sets = [w["set"] for w in q._worlds if w["set"]]
        guesses = {key: Counter(s[i] for s in sets).most_common(3)
                   for i, key in enumerate(("item", "ability", "tera"))}
        if not q.agent.metagame.allow_tera:
            guesses.pop("tera", None)
        ev = q._mean_eval()
        self.sink[room] = {
            "kind": "switch" if choice.startswith("switch ") else "move",
            "choice": choice, "label": _pretty(choice), "tera": choice.endswith("-tera"),
            "turn": battle.turn, "force_switch": bool(getattr(battle, "force_switch", False)),
            "rqid": battle.last_request.get("rqid"),
            "action": _action_for_choice(battle, choice),
            "eval": round(ev, 3) if ev is not None else None,
            "ms": round(ms), "worlds": f"{n_ok}/{n_total}", "worlds_total": n_total,
            "candidates": candidates,
            "expects": ({"label": _pretty(reply), "share": round(reply_share, 3)}
                        if reply and reply != "No Move" else None),
            "guesses": guesses,
            "stages": [{"name": n, "was": _pretty(w), "now": _pretty(nw)}
                       for n, changed, w, nw in q._stages if changed],
            "mixed": bool(mixed), "seq": time.time_ns(),
        }


class AdvisorPlayer(EnginePlayer):
    """EnginePlayer that thinks and reports but never speaks."""

    def __init__(self, *args, **kwargs):
        # Observed rooms are not ladder jobs. An abandoned/spectated battle must
        # never occupy the only slot and block every subsequent room's init.
        kwargs.setdefault("max_concurrent_battles", 0)
        super().__init__(*args, **kwargs)
        self.advice = {}                       # battle_tag -> latest advice dict
        if isinstance(self.observer, AdviceCollector):
            self.observer.bind(self)

        async def _swallow(message, room="", *args, **kwargs):
            return None                        # /choose, /timer on, /leave ... never sent

        self.ps_client.send_message = _swallow

    def forget(self, tag):
        """Drop everything held for one battle -- used by the overlay's resync button.

        Seven dicts keyed by battle_tag (see the TODO in EnginePlayer), plus poke-env's own."""
        battle = self._battles.pop(tag, None)
        # poke-env reserves a slot in _create_battle and normally releases it on
        # win/tie. Resetting an unfinished battle must release that slot too, or
        # the next init waits forever on a full queue. Call on poke-env's loop.
        if battle is not None and not battle.finished:
            self._battle_count_queue.get_nowait()
            self._battle_count_queue.task_done()
        for d in (self._opp_tracker, self._opp_speed, self._opp_item, self._opp_hazards,
                  self._pending, self._futility_hist, self.traces, self.advice):
            d.pop(tag, None)
        getattr(self.metagame, "forget", lambda t: None)(tag)

    def teampreview(self, battle):
        order = super().teampreview(battle)
        try:
            team = list(battle.team.values())
            digits = [int(c) for c in str(order).replace("/team", "").strip() if c.isdigit()]
            names = [_species_name(team[i - 1].species) for i in digits if 0 < i <= len(team)]
            self.advice[battle.battle_tag] = {
                "kind": "lead", "turn": 0, "seq": time.time_ns(),
                "lead": names[0] if names else None, "order": names,
                "rqid": battle.last_request.get("rqid"), "team_order": digits}
        except Exception:
            pass
        return order

    def random_teampreview(self, battle):
        # poke-env takes this path when it was given no team of its own, which is the
        # advisor's situation. Same decision either way.
        return self.teampreview(battle)
