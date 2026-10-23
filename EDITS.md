# Edits to existing files

Everything else in this bundle is new files; copy them into the repo at the same relative
paths. These are the changes to files you already have. Each is small and self-contained.

## 1. `src/laplace/paths.py` — append

```python
# --- Gen 9 Almost Any Ability -------------------------------------------------
# Built by `python -m laplace.cli.fetch_ou_data --format gen9almostanyability`.
AAA_DATA_DIR = os.path.join(DATA_DIR, "aaa")
AAA_USAGE = os.path.join(AAA_DATA_DIR, "usage_gen9almostanyability.json")
AAA_SETS = os.path.join(AAA_DATA_DIR, "sets_gen9almostanyability.json")
AAA_REPLAY_DIR = os.path.join(REPLAYS_DIR, "ladder_aaa")
```

## 2. `src/laplace/agent/metagame.py` — add to class `Metagame` (after `teampreview`)

```python
    def observe(self, battle_tag, split_messages):
        """Look at a raw payload BEFORE poke-env parses it. Default: nothing.

        Runs ahead of the parse on purpose: poke-env can call choose_move while handling
        this very payload, so anything a guard needs from these lines has to be recorded
        first."""
```

## 3. `src/laplace/agent/engine_search.py` — in `_handle_battle_message`

Insert between the `if len(split_messages) == 1: return` block and `await super()._handle_battle_message(split_messages)`:

```python
        try:
            self.metagame.observe(split_messages[0][0].replace(">", "").strip(),
                                  split_messages)
        except Exception:
            self.diag["observe_err"] = self.diag.get("observe_err", 0) + 1
```

## 4. `src/laplace/ou/adapter.py`

**a)** Right after the `from laplace.ou.usage import ...` line:

```python
def set_prior(usage, curated, knowledge):
    """Swap the set prior this module samples from. One format per process -- the same
    trade-off as ladder.configure, and for the same reason (see AAAMetagame)."""
    global USAGE, CURATED, KNOWLEDGE
    USAGE, CURATED, KNOWLEDGE = usage, curated, knowledge
```

**b)** `_opp_side` signature and its first lines:

```python
def _opp_side(battle, *, opp_used_since_switch=None, opp_speed_hints=None,
              opp_item_hints=None, pending=None, use_curated=True, allow_illusion=True):
    speed_hints = opp_speed_hints or {}
    item_hints = opp_item_hints or {}
    illusion = _illusion_candidates(battle) if allow_illusion else ()
```

**c)** `build_state`: add `allow_illusion=True` to the signature, and pass
`allow_illusion=allow_illusion` in the `_opp_side(...)` call.

## 5. `src/laplace/ou/teampreview.py` — append

```python
def set_prior(usage, knowledge):
    """Swap the prior the lead scorer reads (see ou.adapter.set_prior)."""
    global USAGE, KNOWLEDGE
    USAGE, KNOWLEDGE = usage, knowledge
```

## 6. `src/laplace/cli/ladder.py`

**a)** `FormatProfile.__init__`: add parameter `agent_kwargs=None` and the line
`self.agent_kwargs = dict(agent_kwargs or {})`.

**b)** `FORMATS`: add

```python
    # AAA: the Scarf verdict is OFF. Any Pokemon can carry Swift Swim / Unburden / Chlorophyll
    # / Quick Feet, so "it outsped me" no longer implies a Choice Scarf, and a false verdict
    # pins choicescarf into every world for the rest of the game.
    "gen9almostanyability": lambda: FormatProfile(
        "gen9almostanyability", paths.AAA_REPLAY_DIR, elo_seed=0, needs_team=True,
        use_value_net=False, stop_on_record=False,
        agent_kwargs={"speed_inference": False}),
```

**c)** `configure`: new signature and branch.

```python
def configure(fmt, team=None, lead=None, require_team=True):
    ...
    if fmt == "gen9ou":
        from laplace.ou.metagame import OUMetagame
        profile.metagame = OUMetagame(fixed_lead=lead)
    elif fmt == "gen9almostanyability":
        from laplace.aaa.metagame import AAAMetagame
        profile.metagame = AAAMetagame(fixed_lead=lead)
    if profile.needs_team and require_team:
        ...   # unchanged
```

**d)** `build_agent`: right after the `kwargs = dict(...)` block, before `if PROFILE.team_text:`

```python
    kwargs.update(PROFILE.agent_kwargs)
```

## 7. `src/laplace/cli/fetch_ou_data.py`

**a)** Replace the `FORMAT = ...` / `DEFAULT_CUTOFF = ...` lines with:

```python
FORMAT = "gen9ou"
DEFAULT_CUTOFF = 1825

# Per-format: default ladder cutoff, how many abilities to keep, and where the files go.
# AAA keeps many more abilities because the distribution is far flatter than OU's, and uses
# a lower default cutoff because OM ladders have thin top-cut samples. If the month/cutoff
# 404s, check the cutoffs actually published at https://www.smogon.com/stats/<month>/chaos/
FORMATS = {
    "gen9ou": {"cutoff": 1825, "keep_abilities": 8,
               "usage": paths.OU_USAGE, "sets": paths.OU_SETS},
    "gen9almostanyability": {"cutoff": 1630, "keep_abilities": 20,
                             "usage": paths.AAA_USAGE, "sets": paths.AAA_SETS},
}
```

**b)** `condense_usage(chaos)` becomes `condense_usage(chaos, keep_abilities=8)`, and its
abilities line becomes `"abilities": _norm(info.get("Abilities", {}), keep_abilities),`.

**c)** Add `import urllib.error` at the top, and replace `main()`:

```python
def main():
    ap = argparse.ArgumentParser(description="Download and condense the Gen 9 set priors.")
    ap.add_argument("--month", default=None, metavar="YYYY-MM",
                    help="Smogon stats month (default: the latest published)")
    ap.add_argument("--cutoff", type=int, default=None,
                    help="ladder rating cutoff of the usage sample (default: per format)")
    ap.add_argument("--format", default=FORMAT, choices=sorted(FORMATS),
                    help=f"tier (default {FORMAT})")
    ap.add_argument("--usage-only", action="store_true", help="skip the curated sets")
    ap.add_argument("--sets-only", action="store_true", help="skip the usage statistics")
    args = ap.parse_args()

    cfg = FORMATS[args.format]
    cutoff = args.cutoff or cfg["cutoff"]
    os.makedirs(os.path.dirname(cfg["usage"]), exist_ok=True)

    if not args.sets_only:
        month = args.month or latest_month(args.format, cutoff)
        url = CHAOS_URL.format(month=month, fmt=args.format, cutoff=cutoff)
        print(f"usage stats  {url}", flush=True)
        chaos = json.loads(gzip.decompress(_get(url)))
        info = chaos.get("info", {})
        usage = condense_usage(chaos, keep_abilities=cfg["keep_abilities"])
        payload = {"_source": url, "_month": month, "_cutoff": cutoff,
                   "_battles": info.get("number of battles"), "data": usage}
        with open(cfg["usage"], "w", encoding="utf-8") as f:
            json.dump(payload, f, separators=(",", ":"))
        print(f"  {len(usage)} species  ->  {cfg['usage']} "
              f"({os.path.getsize(cfg['usage']) / 1e6:.1f} MB, "
              f"{info.get('number of battles')} battles)", flush=True)

    if not args.usage_only:
        url = SETS_URL.format(fmt=args.format)
        print(f"curated sets {url}", flush=True)
        try:
            sets = condense_sets(json.loads(_get(url)))
        except urllib.error.HTTPError as exc:
            if args.format == FORMAT or exc.code != 404:
                raise
            # Not every tier has analysis sets published. An empty file is a valid answer:
            # the sampler falls back to the usage marginals for every world.
            print("  no curated sets are published for this format; "
                  "writing an empty file (marginals only).", flush=True)
            sets = {}
        with open(cfg["sets"], "w", encoding="utf-8") as f:
            json.dump({"_source": url, "data": sets}, f, separators=(",", ":"))
        n_sets = sum(len(v) for v in sets.values())
        print(f"  {len(sets)} species / {n_sets} sets  ->  {cfg['sets']} "
              f"({os.path.getsize(cfg['sets']) / 1e3:.0f} KB)", flush=True)
```

## 8. `pyproject.toml` — add under `[project.scripts]`

```toml
laplace-advise = "laplace.advisor.server:main"
```

## Then

```powershell
python -m laplace.cli.fetch_ou_data --format gen9almostanyability
```

and double-click `start-advisor.bat`.
