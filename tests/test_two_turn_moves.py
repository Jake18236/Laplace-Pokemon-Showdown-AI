import unittest

from poke_env.battle import Pokemon as TrackedPokemon
from poke_engine import Move, Pokemon, Side, State, generate_instructions
from laplace.agent.poke_engine_adapter import _volatile_set, _boosts
from laplace.agent.search_backend import search


class TwoTurnMovesTest(unittest.TestCase):
    def test_prepare_and_release_follow_tracker(self):
        mon = TrackedPokemon(gen=9, species="basculegion")
        mon.prepare("Phantom Force", None)
        self.assertIn("phantomforce", _volatile_set(mon))
        mon.moved("phantomforce")
        self.assertNotIn("phantomforce", _volatile_set(mon))
        mon.prepare("Phantom Force", None)
        mon.switch_out({})
        self.assertNotIn("phantomforce", _volatile_set(mon))

    def state(self, speed):
        tracked = TrackedPokemon(gen=9, species="basculegion")
        tracked.prepare("Phantom Force", None)
        attacker = Pokemon(id="tyranitar", types=("rock", "dark"),
                           moves=[Move(id="crunch")], speed=speed)
        defender = Pokemon(id="basculegion", types=("water", "ghost"),
                           moves=[Move(id="phantomforce"), Move(id="surf")], speed=100)
        boosted = TrackedPokemon(gen=9, species="tyranitar")
        boosted.boost("atk", 1)
        return State(side_one=Side(pokemon=[attacker], **_boosts(boosted)),
                     side_two=Side(pokemon=[defender], volatile_statuses=_volatile_set(tracked)))

    def test_fast_crunch_misses_but_slower_crunch_can_hit_after_return(self):
        fast = self.state(200)
        self.assertEqual(fast.side_one.attack_boost, 1)
        for branch in generate_instructions(fast, "crunch", "phantomforce"):
            self.assertNotIn("Damage SideTwo", repr(branch.instruction_list))
        slow = self.state(50)
        self.assertTrue(any("Damage SideTwo" in repr(b.instruction_list)
                            for b in generate_instructions(slow, "crunch", "phantomforce")))

    def test_aaa_search_forces_prepared_move_instead_of_imagining_other_attacks(self):
        result = search(self.state(200), 10, allow_tera=False)
        self.assertEqual([o.move_choice for o in result.side_two], ["phantomforce"])


if __name__ == "__main__":
    unittest.main()
