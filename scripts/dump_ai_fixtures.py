"""Dump Python reference data for the TypeScript AI parity tests (web/src/local/ai/*.test.ts).

    .venv/bin/python scripts/dump_ai_fixtures.py [--out web/test-fixtures/ai] [--positions 600] [--endgames 3000]

Writes gzipped JSON files:

* ``encoding.json.gz``: positions from real games for every N = 2..6 (seats played
  by the heuristic, random and the greedy champion policy). Each record holds the
  full game snapshot (``DurakGame.fromSnapshot`` format), the observing player, the
  23 canonical plane masks, the scalar features, the canonical legal mask, the
  canonical suit map and, when the player is to move, the heuristic's action.
* ``model.json.gz``: a subset of those positions with the torch outputs of the
  current champion (legal logits, value, durak logit, belief probabilities,
  policy over real legal actions). Re-dumped by scripts/refresh_browser_model.sh.
* ``solver.json.gz``: perfect-information endgame positions (talon empty and two
  players left, or 2 players with only the trump card in the talon) with the
  exact ``solver.solve`` result and ``solver.action_values`` for every legal move.
"""

from __future__ import annotations

import argparse
import gzip
import json
import math
import os
import random
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import numpy as np  # noqa: E402
import torch  # noqa: E402

from durak import solver  # noqa: E402
from durak.agents.heuristic import HeuristicAgent  # noqa: E402
from durak.engine import PASS, DurakGame  # noqa: E402
from durak.rl.encoding import PublicTracker, build_batch, encode_parts, inverse_perm  # noqa: E402
from durak.rl.model import load_model  # noqa: E402


def snapshot(g: DurakGame) -> dict:
    c = g.config
    return {
        "config": {"handSize": c.hand_size, "maxBoutCards": c.max_bout_cards,
                   "firstBoutLimit": c.first_bout_limit, "stallBouts": c.stall_bouts},
        "numPlayers": g.num_players,
        "hands": list(g.hands),
        "known": list(g.known),
        "talon": list(g.talon),
        "trumpCard": g.trump_card,
        "trump": g.trump,
        "discard": g.discard,
        "attackCards": list(g.attack_cards),
        "defenseCards": list(g.defense_cards),
        "attacker": g.attacker,
        "defender": g.defender,
        "throwers": list(g.throwers),
        "throwerIdx": g.thrower_idx,
        "phase": g.phase,
        "boutLimit": g.bout_limit,
        "firstBout": g.first_bout,
        "done": g.done,
        "loser": g.loser,
        "finished": list(g.finished),
        "log": [[p, a] for p, a in g.log],
        "boutIndex": g.bout_index,
        "stall": g.stall,
    }


class Players:
    def __init__(self, model, rng: random.Random):
        self.model = model
        self.rng = rng
        self.heur = HeuristicAgent()

    def act(self, kind: str, game: DurakGame, p: int, parts) -> int:
        legal = game.legal_actions()
        if len(legal) == 1:
            return legal[0]
        if kind == "random":
            return self.rng.choice(legal)
        if kind == "heuristic":
            return self.heur.act(game.determinize(p, self.rng), p)
        if kind == "solver" and solver.applicable(game):
            r = solver.solve(game, p, time_limit=0.5)
            if r is not None and r[0] > solver.LOSS:
                return r[1]
            return self.heur.act(game.determinize(p, self.rng), p)
        if kind == "solver":
            return self.heur.act(game.determinize(p, self.rng), p)
        obs, mask = build_batch([parts])
        with torch.inference_mode():
            logits = self.model(torch.from_numpy(obs), torch.from_numpy(mask))[0][0].numpy()
        ca = int(np.argmax(logits))
        return ca if ca == PASS else inverse_perm(parts[3])[ca // 9] * 9 + ca % 9


KINDS = ["heuristic", "policy", "random", "solver"]


def play(players: Players, n: int, rng: random.Random, on_state) -> DurakGame:
    game = DurakGame(seed=rng.randrange(1 << 30), num_players=n)
    kinds = [rng.choice(KINDS) for _ in range(n)]
    tracker = PublicTracker.from_game(game)
    steps = 0
    while not game.done and steps < 4000:
        p = game.current_player
        parts = encode_parts(game, p, tracker)
        on_state(game, tracker, p, parts)
        game.step(players.act(kinds[p], game, p, parts))
        tracker.sync(game)
        steps += 1
    return game


def dump_encoding(players: Players, model, per_n: int, n_model: int, rng: random.Random):
    heur = HeuristicAgent()
    recs = []
    for n in range(2, 7):
        got = []

        def on_state(game, tracker, p, parts):
            # the acting player most of the time, sometimes another active seat
            if rng.random() < 0.3:
                obs_p = p
            elif rng.random() < 0.05:
                obs_p = rng.choice(game.active_players)
            else:
                return
            prt = parts if obs_p == p else encode_parts(game, obs_p, tracker)
            planes, sc, clegal, canon = prt
            rec = {
                "snap": snapshot(game),
                "player": obs_p,
                "planes": [int(x) for x in planes],
                "scalars": [float(x) for x in sc],
                "clegal": int(clegal),
                "canon": list(canon),
            }
            if obs_p == p:
                rec["heuristic"] = heur.act(game, p)
            got.append(rec)

        while len(got) < per_n:
            play(players, n, rng, on_state)
        recs += got[:per_n]
    rng.shuffle(recs)

    # model outputs on a subset
    sub = [r for r in recs if r["clegal"]][:n_model]
    out = []
    for r in sub:
        parts = (r["planes"], r["scalars"], r["clegal"], r["canon"])
        obs, mask = build_batch([parts])
        with torch.inference_mode():
            logits, v, d, bel = model(torch.from_numpy(obs), torch.from_numpy(mask))
        lg = logits[0].numpy()
        legal_c = [a for a in range(37) if (r["clegal"] >> a) & 1]
        belp = torch.softmax(bel[0], -1).numpy() if bel is not None else None
        # policy over real legal actions, as ChampionAgent.policy
        inv = inverse_perm(r["canon"])
        real = {}
        for ca in legal_c:
            a = ca if ca == PASS else inv[ca // 9] * 9 + ca % 9
            real[a] = float(lg[ca])
        m = max(real.values())
        z = sum(math.exp(x - m) for x in real.values())
        policy = {str(a): math.exp(x - m) / z for a, x in real.items()}
        out.append({
            "snap": r["snap"], "player": r["player"],
            "logits": {str(ca): float(lg[ca]) for ca in legal_c},
            "value": float(v[0]), "durak": float(d[0]),
            "belief": [round(float(x), 7) for x in belp.reshape(-1)] if belp is not None else None,
            "policy": policy,
        })
    return recs, out


def dump_solver(players: Players, n_target: int, rng: random.Random, time_limit: float):
    recs = []
    seen = set()
    stats = {"timeout": 0, "solved": 0}

    def on_state(game, tracker, p, parts):
        if len(recs) >= n_target or not solver.applicable(game):
            return
        if rng.random() < 0.5:
            return
        key = (tuple(game.hands), tuple(game.attack_cards), tuple(game.defense_cards), game.phase,
               game.thrower_idx, game.attacker, len(game.talon))
        if key in seen:
            return
        seen.add(key)
        me = rng.choice(game.active_players)
        t0 = time.perf_counter()
        r = solver.solve(game, me, time_limit=time_limit)
        if r is None:
            stats["timeout"] += 1
            return
        av = solver.action_values(game, me, time_limit=time_limit)
        if av is None:
            stats["timeout"] += 1
            return
        stats["solved"] += 1
        cards = sum(h.bit_count() for h in game.hands) + len(game.attack_cards) + len(game.defense_cards)
        recs.append({
            "snap": snapshot(game), "player": me, "value": r[0], "action": r[1],
            "values": {str(a): v for a, v in av.items()}, "cards": cards,
            "ms": round(1000 * (time.perf_counter() - t0), 2),
        })

    i = 0
    while len(recs) < n_target:
        play(players, 2 + i % 5, rng, on_state)
        i += 1
    return recs, stats


def write(path: str, obj) -> None:
    with gzip.open(path, "wt", encoding="utf-8", compresslevel=9) as f:
        json.dump(obj, f, separators=(",", ":"))
    print(f"wrote {path} ({os.path.getsize(path) / 1e6:.2f} MB)")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "web", "test-fixtures", "ai"))
    ap.add_argument("--ckpt", default=os.path.join(ROOT, "checkpoints", "champion.pt"))
    ap.add_argument("--positions", type=int, default=600, help="encoding positions per N")
    ap.add_argument("--model-positions", type=int, default=400)
    ap.add_argument("--endgames", type=int, default=3000)
    ap.add_argument("--solver-time", type=float, default=3.0)
    ap.add_argument("--seed", type=int, default=12345)
    ap.add_argument("--only", choices=["encoding", "model", "solver"], action="append")
    args = ap.parse_args()
    torch.set_num_threads(2)
    os.makedirs(args.out, exist_ok=True)
    model, meta = load_model(args.ckpt)
    rng = random.Random(args.seed)
    players = Players(model, rng)
    only = set(args.only or ["encoding", "model", "solver"])

    if only & {"encoding", "model"}:
        t0 = time.time()
        recs, mout = dump_encoding(players, model, args.positions, args.model_positions, rng)
        if "encoding" in only:
            write(os.path.join(args.out, "encoding.json.gz"), {"positions": recs})
        if "model" in only:
            write(os.path.join(args.out, "model.json.gz"),
                  {"version": int(meta.get("version", 0)), "positions": mout})
        print(f"encoding: {len(recs)} positions, model: {len(mout)} ({time.time() - t0:.1f}s)")
    if "solver" in only:
        t0 = time.time()
        recs, stats = dump_solver(players, args.endgames, rng, args.solver_time)
        write(os.path.join(args.out, "solver.json.gz"), {"positions": recs})
        print(f"solver: {len(recs)} endgames {stats} ({time.time() - t0:.1f}s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
