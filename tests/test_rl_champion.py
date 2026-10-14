"""Champion agent: legal moves for all N, cheat-safety, evaluate(), speed."""

import os
import random
import time

import pytest

from durak.agents import get_agent
from durak.engine import DurakGame
from durak.rl.model import ActorCritic, save_model

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHAMP = os.path.join(ROOT, "checkpoints", "champion.pt")


@pytest.fixture(scope="module")
def ckpt(tmp_path_factory):
    if os.path.exists(CHAMP):
        return CHAMP
    p = tmp_path_factory.mktemp("ck") / "rand.pt"
    save_model(ActorCritic(hidden=64, blocks=1), str(p), version=0)
    return str(p)


def play(agent_seats, n, seed, ckpt):
    rng = random.Random(seed)
    g = DurakGame(seed=seed, num_players=n)
    agents = {p: get_agent("champion", path=ckpt, solver_time=0.2) for p in agent_seats}
    for a in agents.values():
        a.reset()
    rnd = get_agent("random", seed=seed)
    steps = 0
    while not g.done:
        p = g.current_player
        view = g.determinize(p, rng)  # what the arena hands an agent
        if p in agents:
            a = agents[p].act(view, p)
            assert a in g.legal_actions()
            v = agents[p].evaluate(view, p)
            assert 0.0 <= v <= 1.0
        else:
            a = rnd.act(view, p)
        g.step(a)
        steps += 1
        if steps > 1500:  # deterministic policies can cycle; legality is what we test
            break
    return g


@pytest.mark.parametrize("n", [2, 3, 4, 5, 6])
def test_champion_legal_all_n(n, ckpt):
    for seed in range(3):
        play(set(range(n)) if seed == 0 else {seed % n}, n, 100 * n + seed, ckpt)


def test_champion_on_real_game_and_views_agree(ckpt):
    """Given the real game or any determinization, the champion acts the same
    (it only uses the acting player's information)."""
    ag = get_agent("champion", path=ckpt, use_solver=False, search=False)
    rng = random.Random(0)
    for n in (2, 4, 6):
        g = DurakGame(seed=7 + n, num_players=n)
        while not g.done and len(g.log) < 400:
            p = g.current_player
            a = ag.act(g, p)
            for _ in range(2):
                assert ag.act(g.determinize(p, rng), p) == a
            assert abs(ag.evaluate(g, p) - ag.evaluate(g.determinize(p, rng), p)) < 1e-6
            g.step(a)


def test_champion_move_time(ckpt):
    ag = get_agent("champion", path=ckpt)
    rng = random.Random(1)
    worst = 0.0
    for n in (2, 4):
        g = DurakGame(seed=3, num_players=n)
        while not g.done and len(g.log) < 600:
            p = g.current_player
            t = time.perf_counter()
            a = ag.act(g.determinize(p, rng), p)
            worst = max(worst, time.perf_counter() - t)
            g.step(a)
    assert worst < 1.5


def test_evaluate_terminal(ckpt):
    ag = get_agent("champion", path=ckpt)
    g = DurakGame(seed=1, num_players=3)
    rng = random.Random(2)
    while not g.done:
        g.step(rng.choice(g.legal_actions()))
    for p in range(3):
        assert ag.evaluate(g, p) == (0.0 if g.loser == p else 1.0)
