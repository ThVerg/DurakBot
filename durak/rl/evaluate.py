"""Evaluate a checkpoint against bots / other checkpoints for N = 2..6.

Our player occupies one seat (rotated over games), the opponent spec controls
all other seats. Metric: durak rate of our seat vs the 1/N baseline (for 2p:
win rate = 1 - durak rate). 95% Wilson intervals.

Controller specs:
  ``nn:<path>``        greedy policy of a checkpoint (batched, no search)
  ``agent:<name>``     any registered agent, e.g. agent:champion, agent:heuristic
  ``agent:champion@<path>``  champion agent (policy + endgame solver) on a given checkpoint
  ``random`` / ``heuristic`` / ``solver``   shorthand for agent:<name>

Bots are always handed ``game.determinize(player, rng)`` (cheat-safe).

Examples::

    .venv/bin/python -m durak.rl.evaluate checkpoints/champion.pt --opps random heuristic solver --games 1000
    .venv/bin/python -m durak.rl.evaluate agent:champion --opps heuristic --ns 2 4 --games 1000
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import time
from concurrent.futures import ProcessPoolExecutor

import torch

from ..engine import DurakGame
from .encoding import PublicTracker, encode_parts, inverse_perm
from .model import load_model
from .rollout import MAX_GAME_STEPS, nn_policy


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return (0.0, 1.0)
    p = k / n
    den = 1 + z * z / n
    c = (p + z * z / (2 * n)) / den
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return (c - h, c + h)


def _norm_spec(spec: str) -> str:
    if spec.startswith(("nn:", "agent:")):
        return spec
    if spec.endswith(".pt"):
        return "nn:" + spec
    return "agent:" + spec


_MODEL_CACHE: dict[str, torch.nn.Module] = {}


def _get_model(path: str):
    if path not in _MODEL_CACHE:
        _MODEL_CACHE[path] = load_model(path)[0]
    return _MODEL_CACHE[path]


def _make_agent(name: str):
    """``name`` or ``name@path`` (path -> ``path=`` kwarg, e.g. champion@ckpt.pt)."""
    from ..agents import get_agent

    if "@" in name:
        name, path = name.split("@", 1)
        return get_agent(name, path=path)
    return get_agent(name)


def play_games(me: str, opp: str, n_players: int, n_games: int, seed: int, concurrency: int = 64) -> dict:
    """Play ``n_games``; ``me`` controls seat ``(seed_offset + i) % N`` of game i."""
    torch.set_num_threads(1)
    me, opp = _norm_spec(me), _norm_spec(opp)
    rng = random.Random(seed)
    results = {"games": 0, "durak": 0, "draws": 0, "ret": 0.0, "ret2": 0.0}
    next_game = 0
    slots: list = [None] * min(concurrency, n_games)
    agent_cache: dict[str, list] = {}

    def start(i_slot):
        nonlocal next_game
        if next_game >= n_games:
            slots[i_slot] = None
            return
        gi = next_game
        next_game += 1
        g = DurakGame(seed=seed * 1_000_003 + gi, num_players=n_players)
        my_seat = gi % n_players
        ctrl = [me if p == my_seat else opp for p in range(n_players)]
        agents = {}
        for p, c in enumerate(ctrl):
            if c.startswith("agent:"):
                ag = _make_agent(c[6:])
                ag.reset()
                agents[p] = ag
        slots[i_slot] = [g, PublicTracker(n_players, g.trump, g.attacker), ctrl, agents, my_seat]

    def finish(s):
        g, _, _, _, my = s
        r = g.returns()[my]  # all zeros (draw) if truncated
        results["games"] += 1
        results["durak"] += 1 if g.loser == my else 0
        results["draws"] += 1 if g.loser is None else 0
        results["ret"] += r
        results["ret2"] += r * r

    for i in range(len(slots)):
        start(i)
    while any(s is not None for s in slots):
        groups: dict[str, list] = {}
        for i, s in enumerate(slots):
            while s is not None:
                g, tr, ctrl, agents, my = s
                if g.done or len(g.log) > MAX_GAME_STEPS:
                    finish(s)
                    start(i)
                    s = slots[i]
                    continue
                p = g.current_player
                legal = g.legal_mask_int()
                if legal & (legal - 1) == 0:
                    a = legal.bit_length() - 1
                elif ctrl[p].startswith("agent:"):
                    view = g.determinize(p, rng)
                    a = agents[p].act(view, p)
                else:
                    groups.setdefault(ctrl[p][3:], []).append((i, p, encode_parts(g, p, tr)))
                    break
                g.step(a)
                tr.event(p, a)
        for path, items in groups.items():
            acts, _, _, _ = nn_policy(_get_model(path), [it[2] for it in items], greedy=True)
            for (i, p, pr), ca in zip(items, acts):
                ca = int(ca)
                a = ca if ca == 36 else inverse_perm(pr[3])[ca // 9] * 9 + ca % 9
                g, tr = slots[i][0], slots[i][1]
                g.step(a)
                tr.event(p, a)
    return results


def _job(args):
    return play_games(*args)


def run_match(me: str, opp: str, n_players: int, n_games: int, seed: int, workers: int) -> dict:
    per = [n_games // workers + (1 if i < n_games % workers else 0) for i in range(workers)]
    jobs, off = [], 0
    for i, k in enumerate(per):
        if k:
            jobs.append((me, opp, n_players, k, seed + 7919 * i))
    tot = {"games": 0, "durak": 0, "draws": 0, "ret": 0.0, "ret2": 0.0}
    if workers <= 1:
        res = [_job(j) for j in jobs]
    else:
        with ProcessPoolExecutor(max_workers=workers) as ex:
            res = list(ex.map(_job, jobs))
    for r in res:
        for k in tot:
            tot[k] += r[k]
    return summarize(tot, n_players)


def summarize(tot: dict, n_players: int) -> dict:
    n = tot["games"]
    d = tot["durak"]
    lo, hi = wilson(d, n)
    base = 1.0 / n_players
    # standardized score: E[1 - N*D] = 0 when equal strength; var = N-1
    mean_y = (n - n_players * d) / max(n, 1)
    z = mean_y / math.sqrt((n_players - 1) / max(n, 1)) if n else 0.0
    return {
        "N": n_players, "games": n, "durak_rate": d / max(n, 1), "ci_lo": lo, "ci_hi": hi,
        "baseline": base, "draws": tot["draws"], "mean_return": tot["ret"] / max(n, 1), "z": z,
    }


def fmt_row(opp: str, r: dict) -> str:
    s = f"vs {opp:<10} N={r['N']} games={r['games']:5d} durak={r['durak_rate']:.3f} [{r['ci_lo']:.3f},{r['ci_hi']:.3f}] base={r['baseline']:.3f}"
    if r["N"] == 2:
        s += f"  win={1 - r['durak_rate']:.3f} [{1 - r['ci_hi']:.3f},{1 - r['ci_lo']:.3f}]"
    return s + f"  z={r['z']:+.2f}"


DEFAULT_WEIGHTS = {2: 0.30, 3: 0.15, 4: 0.25, 5: 0.20, 6: 0.10}


def combined_z(rows: list[dict], weights=DEFAULT_WEIGHTS) -> float:
    num = sum(weights.get(r["N"], 0) * r["z"] for r in rows)
    den = math.sqrt(sum(weights.get(r["N"], 0) ** 2 for r in rows)) or 1.0
    return num / den


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("me", help="checkpoint path or controller spec")
    ap.add_argument("--opps", nargs="+", default=["random", "heuristic", "solver"])
    ap.add_argument("--ns", nargs="+", type=int, default=[2, 3, 4, 5, 6])
    ap.add_argument("--games", type=int, default=1000)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--seed", type=int, default=12345)
    ap.add_argument("--json", help="append results as JSON lines to this file")
    args = ap.parse_args(argv)
    from ..agents import available_agents

    avail = available_agents()
    rows = []
    for opp in args.opps:
        spec = _norm_spec(opp)
        if spec.startswith("agent:") and spec[6:].split("@")[0] not in avail:
            print(f"skip {opp}: not available ({avail})")
            continue
        for n in args.ns:
            t = time.time()
            r = run_match(args.me, opp, n, args.games, args.seed + n, args.workers)
            r["opp"] = opp
            r["sec"] = round(time.time() - t, 1)
            rows.append(r)
            print(fmt_row(opp, r), f"({r['sec']}s)", flush=True)
            if args.json:
                with open(args.json, "a") as f:
                    f.write(json.dumps({"me": args.me, **r}) + "\n")
    return rows


if __name__ == "__main__":
    main()
