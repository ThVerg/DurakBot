"""Game sessions: wraps a DurakGame, drives the bots and produces
viewer-specific (leak-free) state snapshots and event lists.

The engine is the single source of truth for rules: we only call
``legal_actions()`` / ``step()`` and *describe* what happened by diffing
public state before and after each step.
"""

from __future__ import annotations

import logging
import random
import threading
import time
import uuid
from typing import Any

from durak.agents import Agent, available_agents, get_agent
from durak.cards import mask_to_list, popcount
from durak.engine import ATTACK, DEFEND, PASS, PHASE_NAMES, DurakGame

from .bots_meta import BOT_PREFERENCE, PERSONAS, bot_label  # noqa: F401  (re-exported)

log = logging.getLogger("durak.server")

_usable_lock = threading.Lock()
_usable: dict[str, tuple[bool, float, str | None]] = {}  # name -> (ok, checked_at, error)


def bot_status(name: str) -> tuple[bool, str | None]:
    """Whether ``get_agent(name)`` currently works (e.g. a checkpoint exists).
    Failures are re-checked every 30 s, successes are cached."""
    with _usable_lock:
        cached = _usable.get(name)
        if cached and (cached[0] or time.time() - cached[1] < 30):
            return cached[0], cached[2]
    try:
        get_agent(name)
        res = (True, time.time(), None)
    except Exception as e:  # missing checkpoint, import error, ...
        log.warning("bot %s unavailable: %s", name, e)
        res = (False, time.time(), f"{type(e).__name__}: {e}")
    with _usable_lock:
        _usable[name] = res
    return res[0], res[2]


def usable_agents() -> list[str]:
    return [n for n in available_agents() if bot_status(n)[0]]


def default_bot() -> str:
    usable = usable_agents()
    for name in BOT_PREFERENCE:
        if name in usable:
            return name
    return usable[0] if usable else "random"


# --------------------------------------------------------------- evaluation
_analyst_lock = threading.Lock()
_analyst_checked = 0.0
_analyst_name: str | None = None


def analyst_name() -> str | None:
    """Registry name of an agent with ``evaluate`` + ``policy`` (the champion)."""
    global _analyst_checked, _analyst_name
    with _analyst_lock:
        if _analyst_name is not None or time.time() - _analyst_checked < 30:
            return _analyst_name
        _analyst_checked = time.time()
        for name in ("champion_fast", "champion"):
            if name in available_agents() and bot_status(name)[0]:
                try:
                    a = get_agent(name)
                    if callable(getattr(a, "evaluate", None)):
                        _analyst_name = name
                        break
                except Exception:  # pragma: no cover
                    log.exception("analyst %s unavailable", name)
        return _analyst_name


def make_analyst():
    """A fresh champion instance (own public-log tracker; thread-confined)."""
    name = analyst_name()
    return get_agent(name) if name else None


def evaluator_available() -> bool:
    return analyst_name() is not None


# ------------------------------------------------------------------ session
class GameSession:
    def __init__(
        self,
        num_players: int,
        human_seat: int | None,
        bots: list[str],
        seed: int | None = None,
        debug_reveal: bool = False,
    ):
        self.id = uuid.uuid4().hex[:12]
        self.seed = seed if seed is not None else random.randrange(2**31)
        self.game = DurakGame(seed=self.seed, num_players=num_players)
        self.num_players = num_players
        self.human_seat = human_seat
        self.mode = "play" if human_seat is not None else "spectate"
        self.seat_bots: list[str | None] = [None if p == human_seat else bots[p] for p in range(num_players)]
        self.agents: list[Agent | None] = []
        for p in range(num_players):
            name = self.seat_bots[p]
            if name is None:
                self.agents.append(None)
                continue
            try:
                agent = get_agent(name, seed=self.seed * 7 + p) if name == "random" else get_agent(name)
            except TypeError:
                agent = get_agent(name)
            agent.reset()
            self.agents.append(agent)
        self.rng = random.Random(self.seed ^ 0x5EED)
        self.debug_reveal = bool(debug_reveal)
        self.debug_used = self.debug_reveal
        self.lock = threading.Lock()
        self.history: list[dict] = []  # steps without views
        self.recorded = False
        self.created = time.time()
        self.touched = time.time()
        self.analysis: dict | None = None  # post-game analysis (server/analysis.py)
        self.hints_used = 0
        personas = list(range(len(PERSONAS)))
        random.Random(self.seed).shuffle(personas)
        self.personas: list[str | None] = []
        self.names: list[str] = []
        for p in range(num_players):
            if p == human_seat:
                self.personas.append(None)
                self.names.append("You")
            else:
                per = PERSONAS[personas[p % len(personas)]]
                self.personas.append(per["key"])
                self.names.append(per["name"])

    # ---------------------------------------------------------- helpers
    def needs_human(self, g: DurakGame | None = None) -> bool:
        g = g or self.game
        return not g.done and self.human_seat is not None and g.current_player == self.human_seat

    @staticmethod
    def pass_label_of(g: DurakGame) -> str | None:
        if g.done:
            return None
        if g.phase == DEFEND:
            return "take"
        if g.phase == ATTACK:
            if not g.attack_cards:
                return None  # leading: PASS is not legal
            # Only the last thrower in priority order ends the bout with a pass.
            return "bita" if g.thrower_idx == len(g.throwers) - 1 else "pass"
        return "done"

    def pass_label(self) -> str | None:
        return self.pass_label_of(self.game)

    def reveal_all(self) -> bool:
        return self.mode == "spectate" or self.debug_reveal

    @staticmethod
    def end_reason(g: DurakGame) -> str | None:
        if not g.done:
            return None
        if g.loser is not None:
            return "durak"
        stall = getattr(g, "stall", 0)
        limit = getattr(g.config, "stall_bouts", None)
        if limit and stall >= limit:
            return "stalemate"
        return "draw"

    # ----------------------------------------------------------- stepping
    def _bot_action(self, p: int) -> int:
        g = self.game
        agent = self.agents[p]
        legal = g.legal_actions()
        try:
            view = g.determinize(p, self.rng)
            a = int(agent.act(view, p))
        except Exception:
            log.exception("bot %s failed at seat %d; playing random", self.seat_bots[p], p)
            a = -1
        if a not in legal:
            log.warning("bot %s chose illegal action %s; playing random", self.seat_bots[p], a)
            a = self.rng.choice(legal)
        return a

    def apply(self, action: int, think_ms: int | None = None) -> dict:
        """Apply ``action`` for the current player and describe what happened."""
        g = self.game
        player = g.current_player
        phase = g.phase
        throwers = list(g.throwers)
        tidx = g.thrower_idx
        attacker, defender = g.attacker, g.defender
        table = list(g.attack_cards) + list(g.defense_cards)
        leading = not g.attack_cards
        hands_before = list(g.hands)
        talon_before = len(g.talon)
        finished_before = list(g.finished)
        bout_before = g.bout_index
        pass_label = self.pass_label()

        g.step(action)  # raises ValueError on illegal actions

        if action == PASS:
            card = None
            kind = pass_label  # bita / pass / take / done
        elif phase == ATTACK:
            card, kind = action, ("lead" if leading else "throw")
        elif phase == DEFEND:
            card, kind = action, "beat"
        else:
            card, kind = action, "throw_in"

        events: list[dict] = []
        if g.bout_index != bout_before:
            table_mask = 0
            for c in table:
                table_mask |= 1 << c
            if card is not None:
                table_mask |= 1 << card
            table_cards = mask_to_list(table_mask)
            if kind == "bita":
                events.append({"type": "bita", "cards": table_cards})
            else:
                events.append({"type": "pickup", "player": defender, "cards": table_cards})
            # Draw order: main attacker, others clockwise, defender last.
            n = self.num_players
            order = [attacker]
            for k in range(1, n):
                q = (attacker + k) % n
                if q not in finished_before and q != defender:
                    order.append(q)
            order.append(defender)
            drawn_any = []
            for q in order:
                new = g.hands[q] & ~hands_before[q] & ~table_mask
                cnt = popcount(new)
                if cnt:
                    ev: dict[str, Any] = {"type": "draw", "player": q, "count": cnt}
                    # Debug reveal is live-only: history never keeps bots' drawn cards.
                    if q == self.human_seat or self.mode == "spectate":
                        ev["cards"] = mask_to_list(new)
                    events.append(ev)
                    drawn_any.append(ev)
            if talon_before and not g.talon and drawn_any:
                drawn_any[-1]["took_trump_card"] = True
                events.append({"type": "talon_empty"})
            for q in g.finished:
                if q not in finished_before:
                    events.append({"type": "out", "player": q, "place": g.finished.index(q) + 1})
            if g.done:
                events.append({"type": "game_over", "loser": g.loser, "reason": self.end_reason(g)})
            else:
                events.append({"type": "new_bout", "attacker": g.attacker, "defender": g.defender})

        step = {
            "seq": len(self.history),
            "player": player,
            "action": action,
            "card": card,
            "kind": kind,
            "phase": PHASE_NAMES[phase],
            "events": events,
            "thrower_slot": tidx if phase != DEFEND else None,
            "num_throwers": len(throwers),
        }
        if think_ms is not None:
            step["think_ms"] = think_ms
        self.history.append(step)
        return step

    def human_act(self, action: int, auto: bool = True) -> list[dict]:
        if self.game.done:
            raise GameError(409, "game is over")
        if not self.needs_human():
            raise GameError(409, "not your turn")
        if not self.game.is_legal(action):
            raise GameError(400, f"illegal action {action}")
        steps = [self._with_view(self.apply(action))]
        if auto:
            steps += self.run_bots()
        return steps

    def run_bots(self, max_steps: int | None = None, until_bout_end: bool = False) -> list[dict]:
        """Play bot moves until it's the human's turn (or the game ends).
        If the human is out, the rest of the game is played automatically."""
        out = []
        g = self.game
        while not g.done and not self.needs_human():
            if max_steps is not None and len(out) >= max_steps:
                break
            p = g.current_player
            t0 = time.perf_counter()
            a = self._bot_action(p)
            step = self.apply(a, think_ms=int((time.perf_counter() - t0) * 1000))
            out.append(self._with_view(step))
            if until_bout_end and step["events"]:
                break
        return out

    def _with_view(self, step: dict) -> dict:
        return {**step, "view": self.view(compact=True)}

    # ------------------------------------------------------------- views
    def view(self, compact: bool = False, game: DurakGame | None = None, reveal: bool | None = None) -> dict:
        """Snapshot of everything the viewer may see. Hidden bot cards are
        only included in spectate mode or with the debug reveal flag.
        ``game`` lets the replay build views of historical positions."""
        g = game or self.game
        me = self.human_seat
        if reveal is None:
            reveal = self.reveal_all()
        to_move = None if g.done else g.current_player
        thrower_set = set(g.throwers)
        players = []
        for p in range(self.num_players):
            entry: dict[str, Any] = {
                "seat": p,
                "name": self.names[p],
                "persona": self.personas[p],
                "bot": self.seat_bots[p],
                "is_human": p == me,
                "hand_size": popcount(g.hands[p]),
                "known": [] if p == me else mask_to_list(g.known[p]),
                "is_attacker": not g.done and p == g.attacker,
                "is_defender": not g.done and p == g.defender,
                "is_thrower": not g.done and p in thrower_set and p != g.attacker,
                "to_move": p == to_move,
                "out": p in g.finished,
                "place": g.finished.index(p) + 1 if p in g.finished else None,
                "is_durak": g.done and g.loser == p,
            }
            if p == me or reveal:
                entry["hand"] = mask_to_list(g.hands[p])
            players.append(entry)

        table = [
            {"attack": a, "defense": g.defense_cards[i] if i < len(g.defense_cards) else None}
            for i, a in enumerate(g.attack_cards)
        ]
        your_turn = self.needs_human(g)
        state: dict[str, Any] = {
            "game_id": self.id,
            "mode": self.mode,
            "num_players": self.num_players,
            "human_seat": me,
            "debug_reveal": self.debug_reveal and game is None,
            "players": players,
            "hand": mask_to_list(g.hands[me]) if me is not None else [],
            "table": table,
            "bout_limit": g.bout_limit,
            "first_bout": g.first_bout,
            "trump_card": g.trump_card,
            "trump_suit": g.trump,
            "talon_size": len(g.talon),
            "discard_count": popcount(g.discard),
            "attacker": g.attacker,
            "defender": g.defender,
            "throwers": list(g.throwers),
            "thrower_idx": g.thrower_idx,
            "phase": PHASE_NAMES[g.phase],
            "to_move": to_move,
            "your_turn": your_turn,
            "legal": g.legal_actions() if your_turn else [],
            "pass_label": self.pass_label_of(g) if your_turn else None,
            "bout": g.bout_index,
            "moves": len(g.log),
            "stall": getattr(g, "stall", 0),
            "done": g.done,
            "loser": g.loser if g.done else None,
            "finished": list(g.finished),
            "result": self.result(g),
        }
        if not compact:
            state["discard"] = mask_to_list(g.discard)
            state["seed"] = self.seed if (g.done or reveal) and game is None else None
        return state

    def result(self, g: DurakGame | None = None) -> dict | None:
        g = g or self.game
        if not g.done:
            return None
        res: dict[str, Any] = {
            "loser": g.loser,
            "draw": g.loser is None,
            "reason": self.end_reason(g),
            "finished": list(g.finished),
        }
        me = self.human_seat
        if me is not None:
            if g.loser is None:
                res["human"] = "draw"
                res["place"] = g.finished.index(me) + 1 if me in g.finished else None
            elif g.loser == me:
                res["human"] = "durak"
                res["place"] = self.num_players
            else:
                res["human"] = "safe"
                res["place"] = g.finished.index(me) + 1
        return res

    def record_dict(self) -> dict:
        g = self.game
        res = self.result() or {}
        return {
            "id": self.id,
            "mode": self.mode,
            "num_players": self.num_players,
            "human_seat": self.human_seat,
            "seats": [b if b is not None else "human" for b in self.seat_bots],
            "loser": g.loser,
            "finished": list(g.finished),
            "human_result": res.get("human"),
            "human_place": res.get("place") if res.get("human") != "draw" else None,
            "moves": len(g.log),
            "seed": self.seed,
            "debug_used": self.debug_used,
            "end_reason": res.get("reason"),
            "hints_used": self.hints_used,
        }

    def replay_game(self, upto: int) -> DurakGame:
        """Re-create the real game after ``upto`` moves (server-side only)."""
        g = DurakGame(seed=self.seed, num_players=self.num_players, config=self.game.config)
        for _, a in self.game.log[:upto]:
            g.step(a)
        return g

    def evaluate(self) -> dict:
        """Champion's estimate of P(not durak). For the human only, computed on
        determinizations from the human's point of view (no leakage)."""
        agent = make_analyst()
        g = self.game
        if agent is None:
            return {"available": False, "values": {}}
        if g.done:
            return {"available": True, "values": {}}
        seats = [self.human_seat] if self.human_seat is not None else list(range(self.num_players))
        values = {}
        rng = random.Random(self.seed * 31 + len(g.log))
        for p in seats:
            if not g.is_active(p):
                continue
            try:
                samples = [float(agent.evaluate(g.determinize(p, rng), p)) for _ in range(2)]
                values[str(p)] = round(max(0.0, min(1.0, sum(samples) / len(samples))), 4)
            except Exception:  # pragma: no cover
                log.exception("evaluate failed")
                return {"available": False, "values": {}}
        return {"available": True, "values": values}


class GameError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail
