"""Tests for the difficulty levels (durak/agents/levels.py)."""

import random

import pytest

from durak.agents import get_agent
from durak.agents.levels import LEVELS, LevelAgent
from durak.engine import DurakGame

LEVEL_NAMES = ["novice", "intermediate", "expert", "grandmaster"]


def test_registered_with_descriptions():
    for name in LEVEL_NAMES:
        a = get_agent(name)
        assert a.name == name
        assert isinstance(a.description, str) and len(a.description) > 30
    assert LEVELS["grandmaster"]["search"] and LEVELS["grandmaster"]["use_solver"]


@pytest.mark.parametrize("name", ["novice", "intermediate", "expert"])
@pytest.mark.parametrize("n", [2, 4])
def test_levels_play_legal_games(name, n):
    agents = [get_agent(name, seed=p) for p in range(n)]
    rng = random.Random(n)
    g = DurakGame(seed=11, num_players=n)
    while not g.done:
        p = g.current_player
        a = agents[p].act(g.determinize(p, rng), p)
        assert g.is_legal(a)
        g.step(a)


def test_grandmaster_moves_are_legal():
    a = get_agent("grandmaster")
    g = DurakGame(seed=3, num_players=3)
    rng = random.Random(0)
    for _ in range(10):
        p = g.current_player
        g.step(a.act(g.determinize(p, rng), p))


def test_nucleus_never_plays_implausible_moves():
    a = LevelAgent(temperature=5.0, top_p=0.9, seed=0)
    probs = {1: 0.6, 2: 0.25, 3: 0.08, 4: 0.05, 36: 0.02}
    seen = {a._sample(probs) for _ in range(2000)}
    assert seen == {1, 2, 3}  # 4 and PASS lie outside the 90% nucleus


def test_uses_only_legal_information():
    for name in ("novice", "expert"):
        rng = random.Random(1)
        g = DurakGame(seed=5, num_players=3)
        drive = get_agent("heuristic")
        checks = 0
        while not g.done:
            p = g.current_player
            if rng.random() < 0.3:
                a1 = get_agent(name, seed=7).act(g.determinize(p, random.Random(1)), p)
                a2 = get_agent(name, seed=7).act(g.determinize(p, random.Random(2)), p)
                assert a1 == a2
                checks += 1
            g.step(drive.act(g, p))
        assert checks > 5
