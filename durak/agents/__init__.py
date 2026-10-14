"""Agent interface and registry.

An agent picks an action for ``player`` given a game. Agents MUST only use
information ``player`` is entitled to: ``game.info_state(player)``, the
public fields, ``game.hands[player]``, ``game.known``, ``game.log`` and
``game.determinize(player, rng)``. The arena enforces this by passing agents a
determinized copy of the real game, so peeking at hidden cards is useless.
"""

from __future__ import annotations

import random
from typing import Callable

from ..engine import DurakGame


class Agent:
    name = "agent"

    def act(self, game: DurakGame, player: int) -> int:
        raise NotImplementedError

    def reset(self) -> None:
        """Called at the start of every game."""


class RandomAgent(Agent):
    name = "random"

    def __init__(self, seed: int | None = None):
        self.rng = random.Random(seed)

    def act(self, game: DurakGame, player: int) -> int:
        return self.rng.choice(game.legal_actions())


_REGISTRY: dict[str, Callable[..., Agent]] = {"random": RandomAgent}


def register(name: str, factory: Callable[..., Agent]) -> None:
    _REGISTRY[name] = factory


def available_agents() -> list[str]:
    _load_builtin()
    return sorted(_REGISTRY)


def get_agent(name: str, **kwargs) -> Agent:
    _load_builtin()
    if name not in _REGISTRY:
        raise KeyError(f"unknown agent {name!r}; available: {sorted(_REGISTRY)}")
    return _REGISTRY[name](**kwargs)


def _load_builtin() -> None:
    # Import modules that call register(); missing ones are skipped so the
    # registry works while parts of the project are still being built.
    import importlib

    for mod in ("durak.agents.heuristic", "durak.agents.solver_agent", "durak.agents.champion", "durak.agents.levels"):
        try:
            importlib.import_module(mod)
        except ModuleNotFoundError as e:
            if e.name != mod:
                raise
