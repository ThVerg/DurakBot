"""Heuristic agent plus the exact endgame solver.

When the position is perfect information (talon empty and two players left,
or two players with only the face-up trump card left in the talon), the agent
plays the solver's best move. Otherwise, or when the solver runs over its time
budget, or when the position is lost against perfect play (every move loses,
so the heuristic's move gives an imperfect opponent the most chances to err),
it plays the heuristic move.
"""

from __future__ import annotations

from .. import solver
from ..engine import DurakGame
from . import Agent, register
from .heuristic import HeuristicAgent


class SolverAgent(Agent):
    name = "solver"

    def __init__(self, seed: int | None = None, time_limit: float = 1.0, node_limit: int | None = None,
                 **heuristic_params):
        self.heuristic = HeuristicAgent(seed=seed, **heuristic_params)
        self.time_limit = time_limit
        self.node_limit = node_limit
        self.stats = {"solved": 0, "fallback": 0, "lost": 0}

    def reset(self) -> None:
        self.heuristic.reset()

    def act(self, game: DurakGame, player: int) -> int:
        legal = game.legal_actions()
        if len(legal) == 1:
            return legal[0]
        if solver.applicable(game):
            r = solver.solve(game, player, time_limit=self.time_limit, node_limit=self.node_limit)
            if r is None:
                self.stats["fallback"] += 1
            else:
                value, action = r
                if value > solver.LOSS:
                    self.stats["solved"] += 1
                    return action
                self.stats["lost"] += 1
        return self.heuristic.act(game, player)


register("solver", SolverAgent)
