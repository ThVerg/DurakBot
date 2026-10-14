"""Coach features: move hints, post-game analysis and replay.

Security invariant: everything here is computed from the human's
information set only. The champion never sees the real game; it only sees
``game.determinize(human, rng)`` samples (and clones stepped from them), so
the outputs are independent of where the hidden cards really are.
"""

from __future__ import annotations

import logging
import random
import threading
import time
from typing import Any

from durak.engine import DurakGame

from .sessions import GameError, GameSession, make_analyst

log = logging.getLogger("durak.server")

ANALYSIS_TIME_BUDGET = 120.0  # seconds; partial results after that


def _exact(g: DurakGame) -> bool:
    """Perfect information (talon empty, two players left): one sample is exact."""
    try:
        from durak import solver

        return bool(solver.applicable(g))
    except Exception:  # pragma: no cover
        return False


def _value(agent, g: DurakGame, me: int) -> float:
    return max(0.0, min(1.0, float(agent.evaluate(g, me))))


def action_values(agent, g: DurakGame, me: int, rng: random.Random, dets: int) -> tuple[dict[int, float], float, bool]:
    """P(``me`` not durak) after each legal action, averaged over
    determinizations of ``me``'s information set; plus the current value."""
    exact = _exact(g)
    samples = [g.determinize(me, rng) for _ in range(1 if exact else dets)]
    legal = g.legal_actions()
    values: dict[int, float] = {}
    for a in legal:
        acc = 0.0
        for s in samples:
            s2 = s.clone()
            s2.step(a)
            acc += _value(agent, s2, me)
        values[a] = acc / len(samples)
    current = sum(_value(agent, s, me) for s in samples) / len(samples)
    return values, current, exact


def compute_hint(sess: GameSession) -> dict[str, Any]:
    g = sess.game
    me = sess.human_seat
    if me is None or not sess.needs_human():
        raise GameError(409, "hints are only available on your turn")
    legal = g.legal_actions()
    agent = make_analyst()
    if agent is not None:
        try:
            return _champion_hint(sess, agent, g, me, legal)
        except Exception:
            log.exception("champion hint failed; falling back to the default bot")
    # Fall back to the strongest working bot's choice, without win %.
    from durak.agents import get_agent

    from .sessions import default_bot

    rng = random.Random(sess.seed * 1009 + len(g.log))
    a = legal[0]
    for name in (default_bot(), "heuristic", "random"):
        try:
            a = int(get_agent(name).act(g.determinize(me, rng), me))
            if a in legal:
                break
        except Exception:
            continue
    return {
        "available": True,
        "has_values": False,
        "recommended": a if a in legal else legal[0],
        "moves": [{"action": x, "win": None, "policy": None} for x in legal],
    }


def _champion_hint(sess, agent, g: DurakGame, me: int, legal: list[int]) -> dict[str, Any]:
    rng = random.Random(sess.seed * 1009 + len(g.log))
    values, current, exact = action_values(agent, g, me, rng, dets=8)
    # The policy only depends on public info + our own hand.
    policy = agent.policy(g.determinize(me, rng), me)
    best = max(legal, key=lambda a: (round(values[a], 3), policy.get(a, 0.0)))
    # The policy's favourite, unless the evaluated win chance clearly prefers
    # another move (search-like refinement over determinizations).
    top = max(legal, key=lambda a: policy.get(a, 0.0))
    recommended = best if (exact or values[best] - values[top] > 0.03) else top
    moves = sorted(
        ({"action": a, "win": round(values[a], 4), "policy": round(float(policy.get(a, 0.0)), 4)} for a in legal),
        key=lambda m: (-m["win"], -m["policy"]),
    )
    return {
        "available": True,
        "has_values": True,
        "exact": exact,
        "current": round(current, 4),
        "recommended": recommended,
        "best": best,
        "moves": moves,
    }


# ------------------------------------------------------------------ analysis
def _run_analysis(sess: GameSession, state: dict) -> None:
    try:
        agent = make_analyst()
        if agent is None:
            state.update(status="unavailable")
            return
        me = sess.human_seat
        moves = list(sess.game.log)
        g = DurakGame(seed=sess.seed, num_players=sess.num_players, config=sess.game.config)
        rng = random.Random(sess.seed * 7919)
        t0 = time.time()
        timeline: list[dict] = []
        decisions: list[dict] = []
        for k in range(len(moves) + 1):
            if time.time() - t0 > ANALYSIS_TIME_BUDGET:
                state["partial"] = True
                break
            if g.done:
                v = 0.0 if g.loser == me else 1.0
                vals = None
            elif not g.is_active(me):
                v, vals = 1.0, None
            elif k < len(moves) and moves[k][0] == me and len(g.legal_actions()) > 1:
                vals, v, _ = action_values(agent, g, me, rng, dets=3)
            else:
                exact = _exact(g)
                samples = [g.determinize(me, rng) for _ in range(1 if exact else 3)]
                v = sum(_value(agent, s, me) for s in samples) / len(samples)
                vals = None
            timeline.append({"seq": k, "win": round(v, 4)})
            if k < len(moves):
                p, a = moves[k]
                if vals is not None and p == me:
                    best = max(vals, key=lambda x: vals[x])
                    decisions.append({
                        "seq": k,
                        "chosen": a,
                        "best": best,
                        "chosen_win": round(vals[a], 4),
                        "best_win": round(vals[best], 4),
                        "loss": round(max(0.0, vals[best] - vals[a]), 4),
                        "values": [{"action": x, "win": round(y, 4)} for x, y in sorted(vals.items(), key=lambda t: -t[1])],
                    })
                g.step(a)
            state["progress"] = round((k + 1) / (len(moves) + 1), 3)
        mistakes = sorted((d for d in decisions if d["loss"] >= 0.04), key=lambda d: -d["loss"])[:5]
        state.update(
            status="ready",
            timeline=timeline,
            decisions=decisions,
            mistakes=mistakes,
            accuracy=round(
                1 - sum(d["loss"] for d in decisions) / max(1, len(decisions)), 4
            ) if decisions else None,
            seconds=round(time.time() - t0, 1),
        )
    except Exception as e:  # pragma: no cover
        log.exception("analysis failed")
        state.update(status="error", error=str(e))


def get_analysis(sess: GameSession) -> dict[str, Any]:
    if not sess.game.done:
        raise GameError(409, "analysis is available after the game")
    if sess.mode != "play":
        raise GameError(409, "analysis is for games with a human player")
    if sess.analysis is None:
        sess.analysis = {"status": "running", "progress": 0.0}
        threading.Thread(target=_run_analysis, args=(sess, sess.analysis), daemon=True).start()
    return dict(sess.analysis)


def get_replay(sess: GameSession) -> dict[str, Any]:
    """Every position of a finished game as the human saw it."""
    if not sess.game.done:
        raise GameError(409, "replay is available after the game")
    g = DurakGame(seed=sess.seed, num_players=sess.num_players, config=sess.game.config)
    frames = [{"seq": 0, "step": None, "view": sess.view(compact=True, game=g, reveal=sess.mode == "spectate")}]
    for k, (_, a) in enumerate(sess.game.log):
        g.step(a)
        frames.append({
            "seq": k + 1,
            "step": sess.history[k] if k < len(sess.history) else None,
            "view": sess.view(compact=True, game=g, reveal=sess.mode == "spectate"),
        })
    return {"game_id": sess.id, "frames": frames, "result": sess.result()}
