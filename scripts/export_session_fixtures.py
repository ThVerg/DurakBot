"""Dump session/API parity fixtures for the in-browser backend
(web/tests/local/session.parity.test.ts).

Drives server/sessions.py + server/analysis.py exactly like the HTTP endpoints
do (create, advance, act, get, debug, hint, evaluate, replay, analysis, record)
with scripted bots and a fake analyst whose values only depend on public
information (so they don't depend on the determinization RNG). The TS session
replays the same calls on the same deal and must return identical JSON.

    .venv/bin/python scripts/export_session_fixtures.py
"""

from __future__ import annotations

import gzip
import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from durak.cards import NUM_CARDS, popcount  # noqa: E402
from durak.engine import PASS, DurakGame  # noqa: E402
from server import analysis, sessions  # noqa: E402
from server.analysis import compute_hint, get_replay  # noqa: E402
from server.sessions import GameSession  # noqa: E402

OUT = ROOT / "web" / "test-fixtures" / "session"


class Scripted:
    """Plays a fixed action sequence (indexed by the public log length)."""

    def __init__(self, actions: list[int]):
        self.actions = actions

    def reset(self) -> None:
        pass

    def act(self, game: DurakGame, player: int) -> int:
        return self.actions[len(game.log)]


class FakeAnalyst:
    """Deterministic 'champion': values from public information only (hand
    sizes, talon size, table size), so every determinization agrees."""

    def evaluate(self, g: DurakGame, me: int) -> float:
        if g.done:
            return 0.0 if g.loser == me else 1.0
        if me in g.finished:
            return 1.0
        mine = popcount(g.hands[me])
        active = [q for q in range(g.num_players) if q not in g.finished]
        others = 0
        for q in active:
            if q != me:
                others += popcount(g.hands[q])
        x = (others - mine * (len(active) - 1)) / 10.0 + len(g.talon) / 48.0 - len(g.attack_cards) / 20.0
        return 0.5 + 0.5 * x / (1.0 + abs(x))

    def policy(self, g: DurakGame, me: int) -> dict[int, float]:
        legal = g.legal_actions()
        w = {a: float(a % 7 + 1) for a in legal}
        z = 0.0
        for a in legal:
            z += w[a]
        return {a: w[a] / z for a in legal}


def deal_info(seed: int, n: int) -> tuple[list[int], int]:
    """The deck order and fallback attacker DurakGame(seed=seed) uses."""
    rng = random.Random(seed)
    deck = list(range(NUM_CARDS))
    rng.shuffle(deck)
    return deck, rng.randrange(n)


def script(seed: int, n: int, take_bias: float) -> list[int]:
    g = DurakGame(seed=seed, num_players=n)
    rng = random.Random(seed * 3 + 1)
    out = []
    while not g.done:
        legal = g.legal_actions()
        if PASS in legal and g.phase == 1 and rng.random() < take_bias:
            a = PASS
        else:
            a = rng.choice(legal)
        g.step(a)
        out.append(a)
    return out


def run_scenario(name: str, seed: int, n: int, human: int | None, debug_at_start=False,
                 debug_toggles=(), hints=True, take_bias=0.3, modes=("step",)) -> dict:
    actions = script(seed, n, take_bias)
    deck, fallback = deal_info(seed, n)
    s = GameSession(n, human, ["random"] * n, seed=seed, debug_reveal=debug_at_start)
    s.agents = [None if p == human else Scripted(actions) for p in range(n)]
    calls = []

    def rec(call: str, args: list, resp) -> None:
        calls.append({"call": call, "args": args, "response": resp})

    rec("create", [], {"game_id": s.id, "steps": [], "state": s.view()})
    k = 0
    while not s.game.done:
        k += 1
        if len(s.game.log) in debug_toggles:
            s.debug_reveal = not s.debug_reveal
            s.debug_used = s.debug_used or s.debug_reveal
            rec("debug", [s.debug_reveal], {"game_id": s.id, "state": s.view()})
        if k % 9 == 0:
            rec("get", [], {"game_id": s.id, "state": s.view(), "history": s.history[-400:]})
        if k % 4 == 0:
            rec("evaluate", [], s.evaluate())
        if s.needs_human():
            if hints and k % 3 == 0:
                h = compute_hint(s)
                s.hints_used += 1
                rec("hint", [], h)
            a = actions[len(s.game.log)]
            steps = s.human_act(a, auto=False)
            rec("act", [a], {"game_id": s.id, "steps": steps, "state": s.view()})
        else:
            mode = modes[k % len(modes)]
            if mode == "end":
                steps = s.run_bots()
            elif mode == "bout":
                steps = s.run_bots(until_bout_end=True)
            else:
                steps = s.run_bots(max_steps=1)
            rec("advance", [mode], {"game_id": s.id, "steps": steps, "state": s.view()})
    rec("get", [], {"game_id": s.id, "state": s.view(), "history": s.history[-400:]})
    rec("evaluate", [], s.evaluate())
    rec("replay", [], get_replay(s))
    if s.mode == "play":
        state: dict = {"status": "running", "progress": 0.0}
        analysis._run_analysis(s, state)  # noqa: SLF001 - synchronous here
        state.pop("seconds", None)
        rec("analysis", [], state)
    r = s.record_dict()
    r.pop("id")
    rec("record", [], r)
    return {
        "name": name,
        "seed": seed,
        "num_players": n,
        "human_seat": human,
        "debug_at_start": debug_at_start,
        "deck": deck,
        "fallback_attacker": fallback,
        "names": s.names,
        "personas": s.personas,
        "actions": actions,
        "calls": calls,
    }


def stats_fixture() -> dict:
    """Synthetic finished-game records and server/storage.py's stats/timeline."""
    import tempfile

    from server.storage import Storage

    rng = random.Random(5)
    bots = ["random", "novice", "heuristic", "expert", "champion", "grandmaster"]
    records = []
    for i in range(60):
        n = rng.randint(2, 6)
        mode = "play" if rng.random() < 0.75 else "spectate"
        human = rng.randrange(n) if mode == "play" else None
        seats = ["human" if p == human else rng.choice(bots) for p in range(n)]
        draw = rng.random() < 0.08
        order = list(range(n))
        rng.shuffle(order)
        loser = None if draw else order[-1]
        finished = order[:-1] if not draw else order[: n - 2]
        if human is None:
            hres, hplace = None, None
        elif draw:
            hres, hplace = "draw", None
        elif loser == human:
            hres, hplace = "durak", n
        else:
            hres, hplace = "safe", finished.index(human) + 1
        records.append({
            "id": f"g{i:03d}",
            "date": f"2026-10-{1 + i // 4:02d}T{10 + i % 4:02d}:{rng.randrange(60):02d}:00+00:00",
            "mode": mode,
            "num_players": n,
            "human_seat": human,
            "seats": seats,
            "loser": loser,
            "finished": finished,
            "human_result": hres,
            "human_place": hplace,
            "moves": rng.randint(30, 400),
            "seed": rng.randrange(2**31),
            "debug_used": rng.random() < 0.1,
            "end_reason": "draw" if draw else "durak",
            "hints_used": rng.choice([0, 0, 0, 1, 3]),
        })
    with tempfile.TemporaryDirectory() as d:
        st = Storage(Path(d) / "s.db")
        for r in records:
            st.record(r)
        return {"records": records, "stats": st.stats(), "timeline": st.timeline()}


def main() -> None:
    fake = FakeAnalyst()
    sessions.make_analyst = lambda: fake
    analysis.make_analyst = lambda: fake
    OUT.mkdir(parents=True, exist_ok=True)
    scenarios = [
        run_scenario("2p-play", 11, 2, 0, debug_toggles=(10, 25)),
        run_scenario("5p-play", 23, 5, 2, modes=("step", "bout", "step")),
        run_scenario("4p-spectate", 5, 4, None, hints=False, modes=("step", "bout") * 30 + ("end",)),
        run_scenario("6p-play-debug", 31, 6, 5, debug_at_start=True, take_bias=0.5),
        run_scenario("3p-play-seat1", 7, 3, 1, take_bias=0.6),
        run_scenario("2p-play-seat1", 99, 2, 1, take_bias=0.1),
    ]
    raw = json.dumps({"scenarios": scenarios, "storage": stats_fixture()}, separators=(",", ":")).encode()
    path = OUT / "scenarios.json.gz"
    path.write_bytes(gzip.compress(raw, 9, mtime=0))
    for sc in scenarios:
        print(f"{sc['name']}: {len(sc['actions'])} moves, {len(sc['calls'])} calls")
    print(f"{path} {path.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
