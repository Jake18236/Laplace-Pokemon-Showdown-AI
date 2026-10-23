r"""AAA ability prediction.

OUKnowledge.predicted_abilities leans on the dex twice, and both are wrong in Almost Any
Ability:

  * it filters the usage feed to abilities the species can legally have -- in AAA the
    legal set is nearly every ability, so Great Tusk running Levitate is a real set;
  * it reports 1.0 for a species with a single dex ability -- in AAA that says nothing.

The absorb guard vetoes a move outright at >= 0.99, so the contract that matters is the
meaning of 1.0: CERTAIN. Here the only certainty is a server-revealed ability. Everything
else comes from the usage feed, scaled down by UNOBSERVED so that even a species the ladder
runs 100% on one ability stays under the guard's bar -- the feed is a sample of what people
play, not a proof of what is possible.
"""

from poke_env.data import to_id_str

from laplace.ou.knowledge import OUKnowledge


class AAAKnowledge(OUKnowledge):
    # Probability mass reserved for "some ability the feed has never seen on this species".
    # Must stay > 1 - 0.99 so no unrevealed ability can reach the guards' certainty bar.
    UNOBSERVED = 0.03

    def predicted_abilities(self, mon):
        if mon is None:
            return {}
        if mon.ability:
            return {to_id_str(mon.ability): 1.0}
        sid = self.key(mon)
        probs = self.usage.abilities(sid) if sid else {}
        return {a: p * (1.0 - self.UNOBSERVED) for a, p in probs.items()}
