"""Tests for the heuristic and solver agents."""

import random

import pytest

from durak import arena
from durak.agents import available_agents, get_agent
from durak.agents.heuristic import HeuristicAgent
from durak.engine import DurakGame


def test_registry():
    names = available_agents()
    assert {"random", "heuristic", "solver"} <= set(names)
    assert isinstance(get_agent("heuristic"), HeuristicAgent)
    with pytest.raises(TypeError):
        HeuristicAgent(no_such_param=1)


@pytest.mark.parametrize("name", ["heuristic", "solver"])
@pytest.mark.parametrize("n", [2, 3, 4, 5, 6])
def test_plays_legal_full_games(name, n):
    rng = random.Random(n)
    for seed in range(3):
        agents = [get_agent(name) for _ in range(n)]
        g = DurakGame(seed=seed, num_players=n)
        steps = 0
        while not g.done and steps < 5000:
            p = g.current_player
            a = agents[p].act(g.determinize(p, rng), p)
            assert g.is_legal(a)
            g.step(a)
            steps += 1


@pytest.mark.parametrize("name", ["heuristic", "solver"])
def test_uses_only_legal_information(name):
    """The action must not depend on how hidden cards are distributed: two
    different determinizations of the same state give the same action."""
    kw = {"time_limit": None, "node_limit": 20_000} if name == "solver" else {}
    rng = random.Random(0)
    checked = 0
    for seed in range(40):
        n = 2 + seed % 5
        g = DurakGame(seed=seed, num_players=n)
        driver = get_agent("heuristic")
        while not g.done:
            p = g.current_player
            if rng.random() < 0.3:
                a1 = get_agent(name, **kw).act(g.determinize(p, random.Random(1)), p)
                a2 = get_agent(name, **kw).act(g.determinize(p, random.Random(2)), p)
                assert a1 == a2, (name, seed, g)
                checked += 1
            g.step(driver.act(g, p))
    assert checked > 300


@pytest.mark.parametrize("n", [2, 4])
def test_heuristic_beats_random(n):
    r = arena.play_match("heuristic", "random", n, 120, seed=3)
    assert r["a_durak_rate"] < 0.1


def test_cycle_valve_ends_long_games():
    # With an empty talon and 3+ players, cards can circulate forever; the
    # heuristic's random valve must end such games.
    for deal in range(40):
        agents = [get_agent("heuristic", seed=deal * 10 + p) for p in range(4)]
        g = arena.play_game(agents, 1000 + deal, 4, random.Random(deal), max_steps=4000)
        assert g.done
