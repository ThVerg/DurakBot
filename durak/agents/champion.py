"""The trained RL champion (any N = 2..6).

* Exact endgame solver whenever it applies (talon empty and two players left,
  i.e. the end of every game): in a proven win/draw it plays the solver's
  move; in a proven loss (all moves lose vs perfect play) or on timeout it
  keeps the policy's move, which gives the best practical chances.
* Otherwise the policy network (greedy) from ``checkpoints/champion.pt``,
  refined by PIMC search (``durak.rl.search``): with 2 active players full
  policy rollouts, with 3+ active players value-cutoff rollouts; determinizations
  are belief-weighted when the network has a belief head. Total budget ~0.95 s
  per move. ``"champion_fast"`` is policy + solver only.

Uses only the acting player's information: the observation is built from the
player's own hand, public state, ``game.known`` and the public action log; the
solver only runs in perfect-information positions. Hidden fields of a real
game passed in are never read.

``evaluate(game, player)`` returns the estimated probability that ``player``
does NOT end up as the durak (value/durak head, or exact when solvable).
"""

from __future__ import annotations

import math
import os
import random
import threading
import time

import numpy as np
import torch

from . import Agent, register
from ..engine import PASS, DurakGame

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_PATH = os.path.join(ROOT, "checkpoints", "champion.pt")

_LOCK = threading.Lock()
_MODELS: dict[str, tuple[float, object]] = {}  # path -> (mtime, model)
_LAST_CHECK: dict[str, float] = {}


def _load(path: str):
    """Load (and hot-reload when the file changes, checked every 30 s)."""
    from ..rl.model import load_model

    with _LOCK:
        now = time.time()
        cached = _MODELS.get(path)
        if cached is not None and now - _LAST_CHECK.get(path, 0) < 30:
            return cached[1]
        _LAST_CHECK[path] = now
        mtime = os.path.getmtime(path)
        if cached is not None and cached[0] == mtime:
            return cached[1]
        try:
            model, _ = load_model(path)
        except Exception:
            if cached is not None:  # e.g. file mid-write: keep the previous model
                return cached[1]
            raise
        _MODELS[path] = (mtime, model)
        return model


class ChampionAgent(Agent):
    name = "champion"

    def __init__(self, path: str | None = None, use_solver: bool = True, solver_time: float = 0.6,
                 temperature: float = 0.0, seed: int | None = None, threads: int | None = 1,
                 search: bool = True, search_dets: int = 32, search_time: float = 0.8,
                 move_budget: float = 0.95, search_multi: bool = True, belief_dets: bool = True,
                 multi_depth: int = 2, multi_dets: int = 12):
        self.path = path or DEFAULT_PATH
        self.use_solver = use_solver
        self.solver_time = solver_time
        self.temperature = temperature
        self.rng = np.random.default_rng(seed)
        self.search = search
        self.search_dets = search_dets
        self.search_time = search_time
        self.move_budget = move_budget
        self.search_multi = search_multi
        self.belief_dets = belief_dets
        self.multi_depth = multi_depth
        self.multi_dets = multi_dets
        self._prng = random.Random(seed)
        if threads:
            torch.set_num_threads(threads)
        self._tracker = None
        self._tracker_log = None
        _load(self.path)

    def reset(self) -> None:
        self._tracker = None
        self._tracker_log = None

    # ------------------------------------------------------------ helpers
    def _tracker_for(self, game: DurakGame):
        """Public-log tracker, reused incrementally when the log extends the
        previously seen one (the arena hands us a fresh copy every move)."""
        from ..rl.encoding import PublicTracker

        log = game.log
        t = self._tracker
        if t is not None and t.n == game.num_players:
            n = t.n_events
            if n <= len(log) and self._tracker_log == log[:n]:
                t.sync(game)
                self._tracker_log = list(log)
                return t
        t = PublicTracker.from_game(game)
        self._tracker = t
        self._tracker_log = list(log)
        return t

    def _forward(self, game: DurakGame, player: int):
        from ..rl.encoding import encode_parts, build_batch

        model = _load(self.path)
        parts = encode_parts(game, player, self._tracker_for(game))
        obs, mask = build_batch([parts])
        with torch.inference_mode():
            logits, v, d, bel = model(torch.from_numpy(obs), torch.from_numpy(mask))
        self._last_belief = None
        if bel is not None:  # canonical [36,6] -> real card order
            pc = torch.softmax(bel[0], -1).numpy()
            canon = parts[3]
            idx = [canon[c // 9] * 9 + c % 9 for c in range(36)]
            self._last_belief = pc[idx]
        return logits[0].numpy(), float(v[0]), float(d[0]), parts[3]

    def belief(self, game: DurakGame, player: int):
        """[36 real cards, 6 locations (opp rel seat 1..5, talon)] probabilities, or None."""
        self._forward(game, player)
        return self._last_belief

    def policy(self, game: DurakGame, player: int) -> dict[int, float]:
        """Policy distribution over real legal actions."""
        logits, _, _, canon = self._forward(game, player)
        legal = game.legal_actions()
        cl = {a: logits[_canon(a, canon)] for a in legal}
        m = max(cl.values())
        z = sum(math.exp(x - m) for x in cl.values())
        return {a: math.exp(x - m) / z for a, x in cl.items()}

    # ---------------------------------------------------------------- act
    def act(self, game: DurakGame, player: int) -> int:
        legal = game.legal_actions()
        if len(legal) == 1:
            return legal[0]
        t0 = time.perf_counter()
        if self.use_solver:
            res = self._solve(game, player, self.solver_time)
            # proven win/draw: play the solver's move. Proven loss: every move
            # loses vs perfect play, so keep the policy's (practical) choice.
            if res is not None and res[0] >= 0 and res[1] in legal:
                return res[1]
        probs = self.policy(game, player)
        # PIMC within a total per-move budget of ~0.9 s (solver time included)
        budget = min(self.search_time, self.move_budget - (time.perf_counter() - t0))
        n_active = game.num_players - len(game.finished)
        if self.search and budget > 0.15 and (n_active == 2 or self.search_multi):
            from ..rl.search import pimc_action

            bel = self._last_belief if self.belief_dets else None
            if n_active == 2:
                kw = dict(n_det=self.search_dets, mode="rollout")
            else:
                kw = dict(n_det=self.multi_dets, mode="value", depth=self.multi_depth)
            r = pimc_action(_load(self.path), game, player, self._tracker_for(game), probs,
                            time_budget=budget, rng=self._prng, belief=bel, **kw)
            if r is not None:
                return r[0]
        if self.temperature > 0:
            acts = list(probs)
            p = np.array([probs[a] for a in acts]) ** (1.0 / self.temperature)
            return int(acts[self.rng.choice(len(acts), p=p / p.sum())])
        return max(probs, key=probs.get)

    @staticmethod
    def _solve(game: DurakGame, player: int, time_limit: float):
        """Exact (value, action) when the position is perfect-information."""
        try:
            from .. import solver
        except ImportError:
            return None
        if not solver.applicable(game) or player not in game.active_players:
            return None
        try:
            return solver.solve(game, player, time_limit=time_limit)
        except Exception:
            return None

    # ----------------------------------------------------------- evaluate
    def evaluate(self, game: DurakGame, player: int) -> float:
        """Estimated probability that ``player`` is NOT the durak."""
        if game.done:
            return 0.0 if game.loser == player else 1.0
        if player not in game.active_players:
            return 1.0
        if self.use_solver:
            res = self._solve(game, player, min(self.solver_time, 0.3))
            if res is not None:
                return 0.0 if res[0] < 0 else 1.0
        _, _, d, _ = self._forward(game, player)
        return 1.0 / (1.0 + math.exp(d))


def _canon(a: int, canon) -> int:
    return a if a == PASS else canon[a // 9] * 9 + a % 9


register("champion", ChampionAgent)
register("champion_fast", lambda **kw: ChampionAgent(**{"search": False, **kw}))  # policy + solver only
