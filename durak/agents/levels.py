"""Difficulty levels for human opponents: novice, intermediate, expert, grandmaster.

Every level plays from the RL champion's policy network, so its mistakes are
the kind of moves the network itself considers plausible, the way a weaker
human errs. They are not random blunders. Strength is controlled by:

* ``temperature``: softens the policy before sampling (1 = the policy as
  trained; higher = more lapses);
* ``top_p``: nucleus cut-off. Only the most likely moves covering ``top_p`` of
  the probability mass are ever played, so absurd moves never happen;
* ``use_solver``: perfect endgame play when the position is solvable;
* ``search``: the champion's PIMC search in 2-player positions;
* ``blunder``: probability of a "beginner move" instead of the policy move.
  A beginner move is legal and plausible-looking but unskilled: lead any
  non-trump, beat with any beater (trumps too), sometimes add or throw in, take
  when unable to beat. This is how inexperienced humans play: no card
  counting, no tempo. It may depend on the player count (dict {N: p}).

``grandmaster`` is the full champion (policy + endgame solver + search).
Elo per player count is measured by ``durak.ladder`` (see ``runs/ladder.json``).
Each level has a ``description`` for the website.
"""

from __future__ import annotations

import random

from ..cards import rank_of, suit_of
from ..engine import DEFEND, PASS, DurakGame
from . import Agent, register

# Calibrated with durak.ladder (runs/ladder.json, "levels_elo"). The beginner-
# move rate per player count gives tiers about 200 Elo apart for N = 2..5. The
# 6-player Elo scale is compressed (more luck), so gaps there are ~150.
LEVELS = {
    "novice": dict(
        temperature=1.0, top_p=0.9, use_solver=False, search=False,
        blunder={2: 0.9, 3: 0.95, 4: 1.0, 5: 1.0, 6: 1.0},
        description="A beginner: knows the rules and plays natural-looking cards, but doesn't count "
                    "cards, spends trumps freely and throws in more or less at random.",
    ),
    "intermediate": dict(
        temperature=1.0, top_p=0.9, use_solver=False, search=False,
        blunder={2: 0.5, 3: 0.5, 4: 0.55, 5: 0.5, 6: 0.55},
        description="A casual player: often finds the good move but about every other decision "
                    "is made on instinct, without counting cards or thinking about the endgame.",
    ),
    "expert": dict(
        temperature=0.0, top_p=1.0, use_solver=True, search=False,
        blunder={2: 0.3, 3: 0.22, 4: 0.18, 5: 0.17, 6: 0.2},
        description="A strong club player: usually plays the champion network's best move and "
                    "endgames perfectly, but has occasional lapses in concentration.",
    ),
    "grandmaster": dict(
        temperature=0.0, top_p=1.0, use_solver=True, search=True, blunder=0.0,
        description="The full champion: network policy, look-ahead search when two players remain "
                    "and a perfect endgame solver. Our strongest bot.",
    ),
}


class LevelAgent(Agent):
    """Champion-policy agent with temperature / nucleus sampling."""

    name = "level"

    def __init__(self, temperature: float = 1.0, top_p: float = 0.9, use_solver: bool = False,
                 search: bool = False, seed: int | None = None, path: str | None = None,
                 description: str = "", solver_time: float = 0.6, level: str | None = None,
                 blunder: float | dict = 0.0):
        from .champion import ChampionAgent

        self.temperature = temperature
        self.top_p = top_p
        self.blunder = blunder
        self.description = description
        if level:
            self.name = level
        self.rng = random.Random(seed)
        self.champion = ChampionAgent(path=path, use_solver=use_solver, search=search, seed=seed,
                                      solver_time=solver_time)

    def reset(self) -> None:
        self.champion.reset()

    def act(self, game: DurakGame, player: int) -> int:
        legal = game.legal_actions()
        if len(legal) == 1:
            return legal[0]
        b = self.blunder.get(game.num_players, 0.0) if isinstance(self.blunder, dict) else self.blunder
        if b > 0 and self.rng.random() < b:
            return self._beginner_move(game, player, legal)
        if self.temperature <= 0:
            return self.champion.act(game, player)
        if self.champion.use_solver:
            res = self.champion._solve(game, player, self.champion.solver_time)
            if res is not None and res[0] >= 0 and res[1] in legal:
                return res[1]
        probs = self.champion.policy(game, player)
        return self._sample(probs)

    def _beginner_move(self, game: DurakGame, player: int, legal: list[int]) -> int:
        """Legal, natural-looking but unskilled move (no counting, no planning)."""
        trump = game.trump
        cards = [a for a in legal if a != PASS]
        non_trump = [c for c in cards if suit_of(c) != trump]
        if game.phase == DEFEND:
            if not cards:
                return PASS
            if self.rng.random() < 0.1:
                return PASS  # takes too readily now and then
            return self.rng.choice(cards)  # any beater, trumps included
        if not game.attack_cards:  # lead
            pool = non_trump or cards
            pool.sort(key=rank_of)
            # tends to lead lowish cards, but not reliably the lowest
            return pool[min(len(pool) - 1, int(self.rng.random() ** 2 * len(pool)))]
        if not cards:
            return PASS
        # add / throw in: sometimes, mostly non-trumps
        pool = non_trump if non_trump and self.rng.random() < 0.85 else cards
        if self.rng.random() < 0.5:
            return self.rng.choice(pool)
        return PASS

    def _sample(self, probs: dict[int, float]) -> int:
        items = sorted(probs.items(), key=lambda kv: -kv[1])
        # nucleus on the original policy: never play moves outside top_p
        kept, cum = [], 0.0
        for a, p in items:
            kept.append((a, p))
            cum += p
            if cum >= self.top_p:
                break
        w = [p ** (1.0 / self.temperature) for _, p in kept]
        r = self.rng.random() * sum(w)
        for (a, _), x in zip(kept, w):
            r -= x
            if r <= 0:
                return a
        return kept[-1][0]


def make_level(level: str, **overrides) -> LevelAgent:
    cfg = {**LEVELS[level], **overrides}
    return LevelAgent(level=level, **cfg)


for _name in LEVELS:
    register(_name, lambda _n=_name, **kw: make_level(_n, **kw))
