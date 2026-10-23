import asyncio
import json
import unittest

from poke_env import AccountConfiguration
from poke_env.concurrency import POKE_LOOP
from laplace.advisor.player import AdvisorPlayer
from laplace.advisor.server import Advisor


class AdvisorResetTest(unittest.TestCase):
    def test_multiple_unfinished_rooms_do_not_block_new_battles(self):
        agent = AdvisorPlayer(account_configuration=AccountConfiguration("Tester", None),
                              battle_format="gen9randombattle", start_listening=False)

        async def scenario():
            for number in range(3):
                await asyncio.wait_for(agent._create_battle([">battle", "gen9randombattle", str(number)]), 0.2)
            self.assertEqual(len(agent.battles), 3)
            for tag in list(agent.battles):
                agent.forget(tag)

        asyncio.run_coroutine_threadsafe(scenario(), POKE_LOOP).result(timeout=3)

    def test_repeated_reset_releases_active_battle_slot(self):
        agent = AdvisorPlayer(account_configuration=AccountConfiguration("Tester", None),
                              battle_format="gen9randombattle", start_listening=False,
                              max_concurrent_battles=1)

        async def scenario():
            info = [">battle", "gen9randombattle", "123"]
            for _ in range(3):
                battle = await asyncio.wait_for(agent._create_battle(info), timeout=0.2)
                self.assertEqual(agent._battle_count_queue.qsize(), 1)
                agent.forget(battle.battle_tag)
                self.assertEqual(agent._battle_count_queue.qsize(), 0)
            agent.forget("battle-gen9randombattle-123")
            self.assertEqual(agent._battle_count_queue.qsize(), 0)

        asyncio.run_coroutine_threadsafe(scenario(), POKE_LOOP).result(timeout=3)

    def test_full_log_reload_and_atomic_reset_can_repeat(self):
        agent = AdvisorPlayer(account_configuration=AccountConfiguration("Tester", None),
                              battle_format="gen9randombattle", start_listening=False,
                              max_concurrent_battles=1)
        seen = []

        async def record_request(battle, **kwargs):
            seen.append((battle.turn, battle.last_request["rqid"]))

        agent._handle_battle_request = record_request
        advisor = Advisor.__new__(Advisor)
        advisor.agent = agent
        advisor.fmt = "gen9randombattle"
        advisor.status = {}
        advisor._ensure_agent = lambda user: agent
        room = "battle-gen9randombattle-123"
        request = {"rqid": 5, "active": [{"moves": [{"move": "Thunderbolt", "id": "thunderbolt",
                    "pp": 10, "maxpp": 24, "target": "normal", "disabled": False}]}],
                   "side": {"id": "p1", "name": "Tester", "pokemon": [{
                       "ident": "p1: Pikachu", "details": "Pikachu, L100", "condition": "100/100",
                       "active": True, "stats": {"atk": 100, "def": 100, "spa": 100, "spd": 100, "spe": 100},
                       "moves": ["thunderbolt"], "baseAbility": "static", "item": "", "pokeball": "pokeball"}]}}
        history = [">" + room, "|init|battle", "|gametype|singles", "|gen|9",
                   "|player|p1|Tester|1|1500", "|player|p2|Opponent|1|1500", "|start",
                   "|switch|p1a: Pikachu|Pikachu, L100|100/100",
                   "|switch|p2a: Eevee|Eevee, L100|100/100", "|turn|3"]
        body = {"room": room, "user": "Tester", "data": "\n".join(history + ["|request|" + json.dumps(request)])}
        for operation in (advisor._feed, advisor._feed, advisor._reset, advisor._reset):
            operation(body)
            self.assertNotIn(room, advisor.status)
            self.assertEqual(agent._battle_count_queue.qsize(), 1)
        self.assertEqual(seen, [(3, 5)] * 4)
        # Replaying a finished log must not release a slot twice or search again.
        finished = dict(body, data="\n".join(history + ["|win|Tester"]))
        advisor._feed(finished)
        advisor._feed(finished)
        advisor._reset({"room": room})
        self.assertEqual(agent._battle_count_queue.qsize(), 0)
        self.assertEqual(len(seen), 4)


if __name__ == "__main__":
    unittest.main()
