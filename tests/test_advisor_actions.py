import unittest
from types import SimpleNamespace

from laplace.advisor.player import _action_for_choice


class AdvisorActionsTest(unittest.TestCase):
    def setUp(self):
        self.mon = SimpleNamespace(species="rotomwash", base_species="rotom")
        self.battle = SimpleNamespace(
            last_request={"active": [{"moves": [
                {"id": "thunderbolt"}, {"id": "voltswitch", "disabled": True}
            ]}], "side": {"pokemon": [{"ident": "p1: Active"}, {"ident": "p1: Nickname"}]}},
            available_switches=[self.mon], team={"p1: Nickname": self.mon},
        )

    def test_exact_move_slot_and_tera(self):
        self.assertEqual(_action_for_choice(self.battle, "thunderbolt-tera"),
                         {"type": "move", "slot": 1, "tera": True})
        self.assertIsNone(_action_for_choice(self.battle, "voltswitch"))
        self.assertIsNone(_action_for_choice(self.battle, "tackle"))

    def test_switch_slot_uses_request_order_and_handles_nicknames(self):
        for choice in ("switch rotomwash", "switch rotom"):
            self.assertEqual(_action_for_choice(self.battle, choice), {"type": "switch", "slot": 2})
        self.assertIsNone(_action_for_choice(self.battle, "switch pikachu"))


if __name__ == "__main__":
    unittest.main()
