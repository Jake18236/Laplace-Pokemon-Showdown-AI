r"""Gen 9 Almost Any Ability, as the object `EnginePlayer` plugs in.

Reuses the OU determinizer and team preview wholesale. What differs:

  * the priors come from data/aaa/ (Smogon's gen9almostanyability stats), swapped into the
    OU adapter with adapter.set_prior -- one format per process, same trade-off as
    ladder.configure;
  * abilities are never inferred from the dex. poke-env, as far as I know, marks a species
    with exactly one dex ability as having it; that is false here, so _sanitize clears any
    such assumption the protocol has not confirmed;
  * revealed abilities are tracked from the raw protocol BEFORE poke-env parses it
    (observe), so they are available to the guards on the very turn they are revealed;
  * Illusion is only modelled if the usage feed says Zoroark actually runs it (it may be
    banned in the current ruleset -- the data decides, not this file).
"""

import re

from poke_env.data import to_id_str

from laplace import paths
from laplace.aaa.knowledge import AAAKnowledge
from laplace.agent.metagame import Metagame
from laplace.ou import adapter, teampreview
from laplace.ou.usage import CuratedSets, UsageStats

# "ability: Rough Skin" or "[from] ability: Rough Skin"
_ABILITY = re.compile(r"^(?:\[from\] )?ability: (.+)$")


class AAAMetagame(Metagame):
    name = "gen9almostanyability"
    needs_team = True

    def __init__(self, fixed_lead=None, curated_frac=None):
        usage = UsageStats(paths.AAA_USAGE)
        curated = CuratedSets(paths.AAA_SETS, usage=usage)
        super().__init__(knowledge=AAAKnowledge(usage, curated))
        adapter.set_prior(usage, curated, self.knowledge)
        teampreview.set_prior(usage, self.knowledge)
        self.fixed_lead = fixed_lead
        self.curated_frac = curated_frac
        self.illusion = max(usage.abilities("zoroark").get("illusion", 0.0),
                            usage.abilities("zoroarkhisui").get("illusion", 0.0)) > 0.05
        self._revealed = {}          # battle_tag -> {"p2: Nickname": ability_id}

    # --- what the search calls ------------------------------------------------

    def build_state(self, battle, **kwargs):
        if self.curated_frac is not None and kwargs.get("use_joint", True):
            kwargs["use_joint"] = self.curated_frac
        self._sanitize(battle)
        return adapter.build_state(battle, allow_illusion=self.illusion, **kwargs)

    def teampreview(self, battle, player):
        return teampreview.choose_order(battle, fixed_lead=self.fixed_lead)

    def observe(self, battle_tag, split_messages):
        """Record every ability the protocol attributes to a Pokemon, from the raw lines.

        Owner rules (checked against the common line shapes):
          |-ability|p2a: X|Name|...              X has Name
          ...|[from] ability: Name|[of] p2a: X   X has Name  ([of] wins when present)
          |-immune|p2a: X|[from] ability: Name   X has Name  (no [of]: the first ident)
          |-block|p1a: A|ability: Damp|..|[of] p2a: X   X has Damp
        Keys are "p2: Nickname", the same shape as poke-env's opponent_team keys."""
        seen = self._revealed.setdefault(battle_tag, {})
        for msg in split_messages:
            if len(msg) < 4:
                continue
            owner = ability = None
            if msg[1] == "-ability":
                owner, ability = msg[2], msg[3]
            else:
                of = next((p[5:].strip() for p in msg[3:] if p.startswith("[of] ")), None)
                for part in msg[3:]:
                    hit = _ABILITY.match(part)
                    if hit:
                        owner, ability = of or msg[2], hit.group(1)
                        break
            if owner and ability and ": " in owner:
                side, name = owner.split(": ", 1)
                seen[f"{side[:2]}: {name}"] = to_id_str(ability)

    def forget(self, battle_tag):
        self._revealed.pop(battle_tag, None)

    def _sanitize(self, battle):
        """Undo poke-env's 'only one dex ability, so it must have it' for the opponent.

        Conservative on purpose: only a single-ability species whose ability the tracker
        has NOT seen revealed is touched. Anything poke-env learned some other way stays."""
        seen = self._revealed.get(battle.battle_tag, {})
        for key, mon in battle.opponent_team.items():
            if key in seen or not getattr(mon, "ability", None):
                continue
            legal = [to_id_str(a) for a in (mon.possible_abilities or [])]
            if len(legal) == 1 and to_id_str(mon.ability) == legal[0]:
                try:
                    mon._ability = None
                except Exception:
                    pass

    def ready(self):
        usage = self.knowledge.usage
        curated = self.knowledge.curated
        if not usage.loaded:
            return False, ("AAA usage priors MISSING -- opponent sets will be guessed from "
                           "revealed moves only. Run: python -m laplace.cli.fetch_ou_data "
                           "--format gen9almostanyability")
        meta = usage.meta
        sets = (f"{len(curated.by_species)} species with curated sets" if curated.loaded
                else "no curated sets (usage marginals only)")
        return True, (f"AAA priors: {len(usage.by_species)} species from "
                      f"{meta.get('_month')} @ {meta.get('_cutoff')}, {sets}")


AAA = None   # built on demand by ladder.configure; construction swaps the module-level priors
