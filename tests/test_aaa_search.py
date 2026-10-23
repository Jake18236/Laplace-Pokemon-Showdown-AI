import unittest

from poke_engine import Move, Pokemon, Side, State
from laplace.aaa.metagame import AAAMetagame
from laplace.agent.metagame import RANDBATS
from laplace.agent.engine_search import _search_world
from laplace.agent.search_backend import search, no_tera_engine


class AAASearchTest(unittest.TestCase):
    def setUp(self):
        mon = Pokemon(id="pikachu", types=("electric", "typeless"),
                      moves=[Move(id="thunderbolt"), Move(id="tackle")], tera_type="water")
        self.state = State(side_one=Side(pokemon=[mon]), side_two=Side(pokemon=[mon]))

    def test_aaa_native_search_excludes_tera_for_both_sides(self):
        self.assertFalse(AAAMetagame.allow_tera)
        result = search(self.state, 20, allow_tera=AAAMetagame.allow_tera)
        for side in (result.side_one, result.side_two):
            choices = [o.move_choice for o in side]
            self.assertIn("thunderbolt", choices)
            self.assertFalse(any(c.endswith("-tera") for c in choices), choices)

    def test_parallel_worker_uses_same_rules(self):
        result = _search_world(self.state.to_string(), 20, 1, allow_tera=False)
        self.assertIsNotNone(result)
        for side in result[:2]:
            self.assertFalse(any(choice.endswith("-tera") for choice, _ in side))

    def test_normal_formats_keep_tera(self):
        result = search(self.state, 20, allow_tera=RANDBATS.allow_tera)
        for side in (result.side_one, result.side_two):
            self.assertTrue(any(o.move_choice.endswith("-tera") for o in side))

    def test_conversion_preserves_types_without_faking_terastallization(self):
        converted = no_tera_engine().State.from_string(self.state.to_string())
        for side, original in ((converted.side_one, self.state.side_one),
                               (converted.side_two, self.state.side_two)):
            self.assertEqual(tuple(t.lower() for t in side.pokemon[0].types),
                             tuple(t.lower() for t in original.pokemon[0].types))
            self.assertFalse(side.pokemon[0].terastallized)


if __name__ == "__main__":
    unittest.main()
