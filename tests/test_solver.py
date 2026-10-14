"""Tests for the exact endgame solver (durak/solver.py)."""

import random

import pytest

from durak import solver
from durak.agents import get_agent
from durak.engine import ATTACK, DEFEND, PASS, THROW_IN, DurakGame
from durak.testing import make_position, mask

NATIVE = solver.native_available()
SOLVER_CLASSES = [solver.EndgameSolver] + ([solver.NativeEndgameSolver] if NATIVE else [])


def _small_endgames(n_seeds, max_cards, seed=1, players=(2, 2, 3, 4, 5, 6)):
    """Random-play positions that are perfect information with at most
    ``max_cards`` cards in hands + on the table (all phases)."""
    rng = random.Random(seed)
    out = []
    for s in range(n_seeds):
        n = rng.choice(players)
        g = DurakGame(seed=s, num_players=n)
        while not g.done:
            if solver.applicable(g):
                tot = sum(g.hands[p].bit_count() for p in g.active_players) + g.table_mask.bit_count()
                if tot <= max_cards:
                    out.append(g.clone())
            g.step(rng.choice(g.legal_actions()))
    return out


def _talon_one_positions(n, seed=2):
    """2-player positions whose talon is only the face-up trump card. Hands
    are small, so the trump card is drawn; one hand sometimes has 6 cards,
    which exercises the 'drawn by the defender' branch."""
    rng = random.Random(seed)
    out = []
    for _ in range(n):
        deck = list(range(36))
        rng.shuffle(deck)
        tc = deck.pop()
        na = rng.choice([1, 2, 3, 6])
        nd_max = 1 if na == 6 else 3
        nd = rng.randint(1, nd_max)
        hands = [deck[:na], deck[na:na + nd]]
        if rng.random() < 0.5:
            hands.reverse()
        g = make_position(2, hands, talon=[tc], attacker=rng.randrange(2))
        out.append(g)
        # also a few positions inside the bout
        g2 = g.clone()
        for _ in range(rng.randrange(4)):
            if g2.done:
                break
            g2.step(rng.choice(g2.legal_actions()))
        if not g2.done and solver.applicable(g2):
            out.append(g2)
    return out


POSITIONS = _small_endgames(150, 6) + _talon_one_positions(60)
_BF: dict = {}


def bf_value(i, pl, action=None):
    """Brute-force value of POSITIONS[i] (optionally after ``action``), cached
    across the Python and native parametrizations."""
    key = (i, pl, action)
    if key not in _BF:
        g = POSITIONS[i].clone()
        if action is not None:
            g.step(action)
        _BF[key] = solver.brute_force(g, pl)
    return _BF[key]


def test_positions_cover_all_phases_and_talon_one():
    phases = {g.phase for g in POSITIONS}
    assert phases == {ATTACK, DEFEND, THROW_IN}
    assert any(len(g.talon) == 1 for g in POSITIONS)
    assert any(g.num_players > 2 for g in POSITIONS)


@pytest.mark.parametrize("cls", SOLVER_CLASSES, ids=lambda c: c.__name__)
def test_matches_brute_force(cls):
    checked = 0
    for i, g in enumerate(POSITIONS):
        for pl in g.active_players:
            bf = bf_value(i, pl)
            r = cls(g.trump_card).solve_game(g, pl, None)
            assert r is not None and r[0] == bf, (pl, r, bf, g)
            # the returned action really achieves the value
            assert bf_value(i, pl, r[1]) == bf
            checked += 1
    assert checked > 200


@pytest.mark.parametrize("cls", SOLVER_CLASSES, ids=lambda c: c.__name__)
def test_action_values_match_brute_force(cls):
    for i in range(0, len(POSITIONS), 3):
        g = POSITIONS[i]
        pl = g.current_player
        av = cls(g.trump_card).action_values(g, pl, None)
        assert set(av) == set(g.legal_actions())
        for act, v in av.items():
            assert bf_value(i, pl, act) == v


def test_applicable():
    g = DurakGame(seed=0, num_players=2)
    assert not solver.applicable(g)  # big talon
    assert solver.solve(g, 0) is None
    g = make_position(2, ["6S 7S", "8H"], trump="H")
    assert solver.applicable(g)
    g = make_position(3, ["6S 7S", "8H", "9C"], trump="H")
    assert not solver.applicable(g)  # 3 active
    g = make_position(3, ["6S 7S", "", "9C"], trump="H", finished=[1])
    assert solver.applicable(g)
    # 2 players, talon = only the face-up trump card: perfect information
    g = make_position(2, ["6S 7S", "8H"], talon=["AH"])
    assert solver.applicable(g)
    g = make_position(2, ["6S 7S", "8H"], talon=["AH", "6C"])
    assert not solver.applicable(g)


def test_known_values():
    # Attacker's last card cannot be beaten: attacker goes out, defender is durak.
    g = make_position(2, ["AS", "6S 7H"], trump="H")
    assert solver.solve(g, 0, None) == (1, solver.solve(g, 0, None)[1])
    assert solver.solve(g, 0, None)[0] == 1 and solver.solve(g, 1, None)[0] == -1
    # Single card each, defender beats it: both run out together -> draw.
    g = make_position(2, ["6S", "7S"], trump="H")
    assert solver.solve(g, 0, None)[0] == 0
    # Whole hand of one rank within the limit: attacker wins.
    g = make_position(2, ["6S 6C 6D", "AS AC AD AH"], trump="H")
    assert solver.solve(g, 0, None)[0] == 1
    # Defender to move with a choice: must beat with the right card.
    g = make_position(2, ["6S 9S", "7S KS 6H"], trump="H")
    g.step(mask("6S").bit_length() - 1)  # attack 6S
    assert g.phase == DEFEND
    v, a = solver.solve(g, 1, None)
    c = g.clone()
    c.step(a)
    assert solver.brute_force(c, 1) == v == solver.brute_force(g.clone(), 1)


def test_multiplayer_seats_irrelevant():
    # Same 2-player endgame embedded at different seats of a 5-player table.
    base = make_position(2, ["6S 9C JD", "7S 8C AH QD"], trump="H")
    v0 = solver.solve(base, 0, None)[0]
    for seats in [(0, 3), (2, 4), (4, 1)]:
        hands = [""] * 5
        hands[seats[0]], hands[seats[1]] = "6S 9C JD", "7S 8C AH QD"
        finished = [p for p in range(5) if p not in seats]
        g = make_position(5, hands, trump="H", attacker=seats[0], finished=finished)
        assert g.defender == seats[1]
        assert solver.solve(g, seats[0], None)[0] == v0
        assert solver.solve(g, seats[1], None)[0] == -v0
        assert solver.solve(g, finished[0], None) is None  # finished player


def test_determinized_copy_gives_same_answer():
    rng = random.Random(5)
    for g in POSITIONS[:60]:
        p = g.current_player
        d = g.determinize(p, rng)
        assert solver.solve(d, p, None) == solver.solve(g, p, None)


def test_budget_returns_none():
    # A large endgame with a tiny node budget cannot be solved.
    g = make_position(2, ["6S 7S 8S 9S 10S JS 6C 7C 8C 9C", "QS KS AS 10C JC QC 6D 7D 8D 6H 7H"], trump="H")
    solver._SOLVERS.clear()
    if NATIVE:
        solver._load_native().dk_clear()
    assert solver.solve(g, 0, node_limit=50) is None
    assert solver.action_values(g, 0, node_limit=50) is None


@pytest.mark.skipif(not NATIVE, reason="no C compiler")
def test_native_matches_python_on_larger_positions():
    # Endgames reached by heuristic play, solved by both implementations.
    h = get_agent("heuristic")
    n_checked = 0
    for seed in range(12):
        g = DurakGame(seed=500 + seed, num_players=2 + seed % 3)
        while not g.done:
            if solver.applicable(g):
                tot = sum(g.hands[p].bit_count() for p in g.active_players)
                if tot <= 12:
                    p = g.current_player
                    rp = solver.EndgameSolver(g.trump_card).solve_game(g, p, None, node_limit=300_000)
                    rn = solver.NativeEndgameSolver(g.trump_card).solve_game(g, p, None, node_limit=3_000_000)
                    if rp is not None and rn is not None:
                        assert rp[0] == rn[0]
                        n_checked += 1
                    break
            g.step(h.act(g, g.current_player))
    assert n_checked >= 5


def test_solver_agent_plays_full_games():
    for n in (2, 3, 4):
        agents = [get_agent("solver", time_limit=0.5) for _ in range(n)]
        g = DurakGame(seed=42 + n, num_players=n)
        rng = random.Random(0)
        while not g.done:
            p = g.current_player
            a = agents[p].act(g.determinize(p, rng), p)
            g.step(a)
        assert g.done


def test_solver_agent_realizes_solved_value():
    # From a solved winning position, the solver agent (playing both sides)
    # reaches exactly the solved result.
    rng = random.Random(3)
    agent = get_agent("solver", time_limit=None)
    done = 0
    for g0 in POSITIONS[:80]:
        p = g0.current_player
        v = solver.solve(g0, p, None)[0]
        g = g0.clone()
        while not g.done:
            q = g.current_player
            g.step(agent.act(g.determinize(q, rng), q))
        res = 0 if g.loser is None else (-1 if g.loser == p else 1)
        if v == 1:
            assert res == 1
        elif v == 0:
            assert res >= 0
        done += 1
    assert done == 80


def test_pass_constant():
    assert PASS == 36


@pytest.mark.skipif(not NATIVE, reason="no C compiler")
def test_real_large_endgame_regression():
    # 11 vs 5 cards after takes, from a heuristic 4-player game: the attacker
    # (seat 0) wins. Needs ~1.4M nodes with the tuned ordering + dominance
    # pruning; the budget guards against performance regressions.
    g = make_position(4, ["9S 9C JC QC KC 6D 9D JD 9H 10H QH", "10S 10C 7D 10D 7H", "", ""],
                      trump="C", trump_card="8C", attacker=0, finished=[3, 2])
    solver._SOLVERS.clear()
    solver._load_native().dk_clear()
    r = solver.solve(g, 0, time_limit=None, node_limit=6_000_000)
    assert r is not None and r[0] == 1
    c = g.clone()
    c.step(r[1])
    assert solver.solve(c, 0, time_limit=None, node_limit=6_000_000)[0] == 1


def test_dominance_pruning_exact_on_dominance_positions():
    """Positions where the pruning actually fires (singleton-rank adjacent
    cards in one hand) still match brute force."""
    rng = random.Random(9)
    fired = 0
    for _ in range(150):
        deck = list(range(36))
        rng.shuffle(deck)
        na, nd = rng.randint(1, 3), rng.randint(1, 3)
        g = make_position(2, [deck[:na], deck[na:na + nd]], trump=rng.randrange(4), attacker=0)
        s = solver.EndgameSolver(g.trump_card)
        live = g.hands[0] | g.hands[1]
        if s._prune_dominated(g.hands[0], g.hands[0], live) != g.hands[0]:
            fired += 1
        for cls in SOLVER_CLASSES:
            assert cls(g.trump_card).solve_game(g, 0, None)[0] == solver.brute_force(g.clone(), 0)
    assert fired > 10
