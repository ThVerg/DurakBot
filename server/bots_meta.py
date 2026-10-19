"""Presentation metadata for the bots in the registry (labels, tiers,
descriptions in English and Russian). Unknown bots fall back gracefully."""

from __future__ import annotations

from typing import Any

# Ordered roughly by strength; `tier` 0..5 drives the star rating in the UI.
BOT_META: dict[str, dict[str, Any]] = {
    "random": {
        "label": {"en": "Random", "ru": "Случайный"},
        "desc": {"en": "Plays any legal card. A warm-up opponent.", "ru": "Ходит любой разрешённой картой. Для разминки."},
        "tier": 0,
    },
    "novice": {
        "label": {"en": "Novice", "ru": "Новичок"},
        "desc": {"en": "Knows the rules, makes beginner mistakes.", "ru": "Знает правила, но ошибается как новичок."},
        "tier": 1,
    },
    "intermediate": {
        "label": {"en": "Intermediate", "ru": "Любитель"},
        "desc": {"en": "Casual player: often finds the good move, but plays many decisions on instinct.", "ru": "Любитель: часто находит хороший ход, но многое играет на интуиции."},
        "tier": 2,
    },
    "heuristic": {
        "label": {"en": "Heuristic", "ru": "Эвристик"},
        "desc": {"en": "Strong rule-based play with card counting.", "ru": "Сильная игра по правилам и подсчёт карт."},
        "tier": 2,
    },
    "expert": {
        "label": {"en": "Expert", "ru": "Эксперт"},
        "desc": {"en": "Tough opponent with endgame calculation.", "ru": "Сильный соперник, просчитывает эндшпиль."},
        "tier": 3,
    },
    "solver": {
        "label": {"en": "Solver", "ru": "Решатель"},
        "desc": {"en": "Heuristic play plus a perfect endgame solver.", "ru": "Эвристика плюс точный решатель эндшпиля."},
        "tier": 3,
    },
    "champion_fast": {
        "label": {"en": "Champion (fast)", "ru": "Чемпион (быстрый)"},
        "desc": {"en": "Trained neural network + endgame solver, no search.", "ru": "Обученная нейросеть и решатель, без перебора."},
        "tier": 4,
    },
    "grandmaster": {
        "label": {"en": "Grandmaster", "ru": "Гроссмейстер"},
        "desc": {"en": "The strongest setting. Good luck.", "ru": "Самый сильный уровень. Удачи."},
        "tier": 5,
    },
    "champion": {
        "label": {"en": "Champion", "ru": "Чемпион"},
        "desc": {"en": "Trained RL network with search and an exact endgame solver.", "ru": "Нейросеть (RL) с перебором и точным решателем эндшпиля."},
        "tier": 5,
    },
}

# Preferred default opponent, strongest first.
BOT_PREFERENCE = ("champion", "grandmaster", "solver", "expert", "heuristic", "intermediate", "novice", "random")


def bot_meta(name: str, agent_cls: Any = None) -> dict[str, Any]:
    meta = BOT_META.get(name)
    if meta is None:
        pretty = name.replace("_", " ").title()
        desc = getattr(agent_cls, "description", None) or getattr(agent_cls, "__doc__", None) or ""
        desc = desc.strip().split("\n")[0] if isinstance(desc, str) else ""
        meta = {"label": {"en": pretty, "ru": pretty}, "desc": {"en": desc, "ru": desc}, "tier": None}
    return {"label": meta["label"], "desc": meta["desc"], "tier": meta["tier"]}


def bot_label(name: str) -> str:
    return bot_meta(name)["label"]["en"]


# Bot personalities. Names are localized in the UI from the persona key.
PERSONAS = [
    {"key": "zina", "name": "Babushka Zina"},
    {"key": "misha", "name": "Uncle Misha"},
    {"key": "sveta", "name": "Sveta"},
    {"key": "kostya", "name": "Kostya"},
    {"key": "lev", "name": "Professor Lev"},
    {"key": "dasha", "name": "Dasha"},
    {"key": "grisha", "name": "Grisha"},
]
