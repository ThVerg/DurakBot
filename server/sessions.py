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

log = logging.getLogger("durak.server")

BOT_PREFERENCE = ("champion", "solver", "heuristic", "random")
BOT_LABELS = {
    "champion": "Champion",
    "solver": "Solver",
    "heuristic": "Heuristic",
    "random": "Random",
}
NAMES = ["Anya", "Boris", "Dasha", "Fyodor", "Galya", "Ivan"]


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


def bot_label(name: str) -> str:
    return BOT_LABELS.get(name, name.replace("_", " ").title())


# --------------------------------------------------------------- evaluation
_eval_lock = threading.Lock()
_eval_call_lock = threading.Lock()
_eval_fn: Any = None
_eval_checked = 0.0


def get_evaluator():
    """Return the champion's ``evaluate(game, player) -> float`` if it exists."""
    global _eval_fn, _eval_checked
    with _eval_lock:
        if _eval_fn is not None:
            return _eval_fn
        if time.time() - _eval_checked < 30:  # don't retry imports on every call
            return None
        _eval_checked = time.time()
        if "champion" not in available_agents() or not bot_status("champion")[0]:
            return None
        try:
            import durak.agents.champion as champ

            fn = getattr(champ, "evaluate", None)
            if fn is None:
                agent = get_agent("champion")
                fn = getattr(agent, "evaluate", None)
            if callable(fn):
                _eval_fn = fn
        except Exception:  # pragma: no cover - depends on other agent's code
            log.exception("champion evaluator unavailable")
        return _eval_fn


def evaluator_available() -> bool:
    return get_evaluator() is not None


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
        names = list(NAMES)
        random.Random(self.seed).shuffle(names)
        self.names = ["You" if p == human_seat else names[p] for p in range(num_players)]

    # ---------------------------------------------------------- helpers
    @property
    def viewer(self) -> int | None:
        return self.human_seat

    def human_active(self) -> bool:
        return self.human_seat is not None and self.game.is_active(self.human_seat)

    def needs_human(self) -> bool:
        g = self.game
        return not g.done and self.human_seat is not None and g.current_player == self.human_seat

    def pass_label(self) -> str | None:
        g = self.game
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

    def reveal_all(self) -> bool:
        return self.mode == "spectate" or self.debug_reveal

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

    def apply(self, action: int) -> dict:
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
                events.append({"type": "game_over", "loser": g.loser})
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
        self.history.append(step)
        return step

    def human_act(self, action: int) -> list[dict]:
        if self.game.done:
            raise GameError(409, "game is over")
        if not self.needs_human():
            raise GameError(409, "not your turn")
        if not self.game.is_legal(action):
            raise GameError(400, f"illegal action {action}")
        steps = [self._with_view(self.apply(action))]
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
            step = self.apply(self._bot_action(p))
            out.append(self._with_view(step))
            if until_bout_end and step["events"]:
                break
        return out

    def _with_view(self, step: dict) -> dict:
        return {**step, "view": self.view(compact=True)}

    # ------------------------------------------------------------- views
    def view(self, compact: bool = False) -> dict:
        """Snapshot of everything the viewer may see. Hidden bot cards are
        only included in spectate mode or with the debug reveal flag."""
        g = self.game
        me = self.human_seat
        reveal = self.reveal_all()
        to_move = None if g.done else g.current_player
        thrower_set = set(g.throwers)
        players = []
        for p in range(self.num_players):
            entry: dict[str, Any] = {
                "seat": p,
                "name": self.names[p],
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
        your_turn = self.needs_human()
        state: dict[str, Any] = {
            "game_id": self.id,
            "mode": self.mode,
            "num_players": self.num_players,
            "human_seat": me,
            "debug_reveal": self.debug_reveal,
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
            "pass_label": self.pass_label() if your_turn else None,
            "bout": g.bout_index,
            "moves": len(g.log),
            "done": g.done,
            "loser": g.loser if g.done else None,
            "finished": list(g.finished),
            "result": self.result(),
        }
        if not compact:
            state["discard"] = mask_to_list(g.discard)
            state["seed"] = self.seed if (g.done or reveal) else None
        return state

    def result(self) -> dict | None:
        g = self.game
        if not g.done:
            return None
        res: dict[str, Any] = {"loser": g.loser, "draw": g.loser is None, "finished": list(g.finished)}
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
        }

    def evaluate(self) -> dict:
        """Champion's estimate of P(not durak). For the human only, computed on
        a determinization from the human's point of view (no leakage)."""
        fn = get_evaluator()
        g = self.game
        if fn is None:
            return {"available": False, "values": {}}
        if g.done:
            return {"available": True, "values": {}}
        seats = [self.human_seat] if self.human_seat is not None else list(range(self.num_players))
        values = {}
        with _eval_call_lock:
            for p in seats:
                if not g.is_active(p):
                    continue
                try:
                    samples = [float(fn(g.determinize(p, self.rng), p)) for _ in range(2)]
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
