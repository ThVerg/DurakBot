"""Tests for the arena (durak/arena.py), including that peeking at hands in
the game object an agent receives gives no hidden information."""

import random

import pytest

from durak import arena
from durak.agents import Agent, RandomAgent, get_agent
from durak.agents.heuristic import HeuristicAgent
from durak.cards import beaters_mask
from durak.engine import PASS, DurakGame


def test_play_match_basic_accounting():
    for n in (2, 3, 4):
        r = arena.play_match("random", "random", num_players=n, n_games=60, seed=1, workers=1)
        assert r["games"] % n == 0 and r["games"] >= 60
        assert r["deals"] * n == r["games"]
        total = r["a_durak_rate"] * r["games"] + r["b_durak_rate"] * r["games"] * (n - 1) + r["draw_rate"] * r["games"]
        assert total == pytest.approx(r["games"])
        assert r["baseline"] == pytest.approx(1 / n)
        assert 0 <= r["a_durak_ci95"] < 1
        assert 0 <= r["a_durak_rate"] <= 1 and 0 <= r["b_durak_rate"] <= 1
        assert r["timeout_rate"] == 0 and 0 <= r["stall_rate"] <= r["draw_rate"]


def test_reproducible():
    r1 = arena.play_match("random", "random", 3, 30, seed=8)
    r2 = arena.play_match("random", "random", 3, 30, seed=8)
    assert r1["a_durak_rate"] == r2["a_durak_rate"] and r1["mean_steps"] == r2["mean_steps"]


def test_workers_give_same_result_as_serial():
    r1 = arena.play_match("random", "random", 3, 30, seed=4, workers=1)
    r2 = arena.play_match("random", "random", 3, 30, seed=4, workers=2)
    for k in ("games", "a_durak_rate", "b_durak_rate", "draw_rate", "mean_steps"):
        assert r1[k] == r2[k]


def test_factories_and_names():
    r = arena.play_match(lambda: HeuristicAgent(), RandomAgent, 2, 20, seed=0)
    assert r["games"] == 20
    with pytest.raises(KeyError):
        arena.play_match("no_such_agent", "random", 2, 2)


def test_illegal_action_raises():
    class Bad(Agent):
        def act(self, game, player):
            return 37

    with pytest.raises(ValueError):
        arena.play_match(Bad, "random", 2, 2)


def test_cli_runs(capsys):
    arena.main(["random", "random", "--players", "3", "--games", "9", "--seed", "2"])
    out = capsys.readouterr().out
    assert "durak rate" in out and "games/s" in out


# ------------------------------------------------------------ anti-cheating
class Peeker(Agent):
    """Cheats: reads every opponent's hand in the game object it is given and
    'predicts' the opponents' hidden cards from it. Records its accuracy
    against the true hands, captured by spying on ``determinize``."""

    log: list = []

    def act(self, game, player):
        real = Peeker.current_real
        for q in range(game.num_players):
            if q == player or q in game.finished:
                continue
            hidden_real = real.hands[q] & ~real.known[q]
            n_hidden = hidden_real.bit_count()
            if n_hidden == 0:
                continue
            guess = game.hands[q] & ~game.known[q]
            pool = real.unseen_mask(player).bit_count()
            Peeker.log.append(((guess & hidden_real).bit_count(), n_hidden, pool))
        return random.Random(len(game.log)).choice(game.legal_actions())


def _peek_accuracy(monkeypatch, leak: bool):
    orig = DurakGame.determinize

    def spy(self, player, rng):
        Peeker.current_real = self
        return self.clone() if leak else orig(self, player, rng)

    monkeypatch.setattr(DurakGame, "determinize", spy)
    Peeker.log = []
    arena.play_match(Peeker, "random", num_players=3, n_games=30, seed=9, workers=1)
    hits = sum(h for h, _, _ in Peeker.log)
    total = sum(n for _, n, _ in Peeker.log)
    # chance level: each hidden card of q is guessed right with prob n/pool
    chance = sum(n * n / pool for _, n, pool in Peeker.log) / total
    return hits / total, chance


def test_peeking_at_the_view_is_no_better_than_chance(monkeypatch):
    acc, chance = _peek_accuracy(monkeypatch, leak=False)
    assert acc < chance + 0.05, (acc, chance)
    assert chance < 0.8


def test_peek_test_has_power_with_a_leaky_arena(monkeypatch):
    acc, _ = _peek_accuracy(monkeypatch, leak=True)
    assert acc == 1.0


class CheatHeuristic(HeuristicAgent):
    """Heuristic that replaces card counting by reading opponents' hands from
    the game it is given, and leads cards the defender cannot beat."""

    def _p_can_beat(self, game, me, q, c, model=None):
        return 1.0 if game.hands[q] & beaters_mask(c, game.trump) else 0.0

    def _p_throwers_hold(self, game, me, cards_mask, model):
        return 1.0 if any(game.hands[q] & cards_mask for q in game.throwers if q != me) else 0.0


class HonestTwin(CheatHeuristic):
    """Same code, but it first re-samples the hidden cards itself, so whatever
    it 'reads' is random by construction: an honest agent."""

    def __init__(self):
        super().__init__()
        self.r = random.Random(123)

    def act(self, game, player):
        return super().act(game.determinize(player, self.r), player)


def test_cheating_agent_gains_nothing():
    # Under the arena, the cheater's durak rate equals its honest twin's
    # (statistically, using the same deals).
    n_games = 1200
    rc = arena.play_match(CheatHeuristic, HeuristicAgent, 2, n_games, seed=5, workers=2)
    rh = arena.play_match(HonestTwin, HeuristicAgent, 2, n_games, seed=5, workers=2)
    diff = abs(rc["a_durak_rate"] - rh["a_durak_rate"])
    tol = 2.5 * (rc["a_durak_ci95"] ** 2 + rh["a_durak_ci95"] ** 2) ** 0.5
    assert diff < max(tol, 0.03), (rc["a_durak_rate"], rh["a_durak_rate"])


def test_agents_never_get_the_real_game():
    seen = []

    class Spy(Agent):
        def act(self, game, player):
            seen.append(game)
            return game.legal_actions()[0] if PASS not in game.legal_actions() else PASS

    agents = [Spy(), get_agent("random", seed=1)]
    g = arena.play_game(agents, 77, 2, random.Random(0))
    assert seen and all(v is not g for v in seen)
