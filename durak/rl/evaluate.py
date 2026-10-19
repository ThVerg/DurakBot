"""Evaluate a checkpoint against bots / other checkpoints for N = 2..6.

Our player occupies one seat (rotated over games), the opponent spec controls
all other seats. Metric: durak rate of our seat vs the 1/N baseline (for 2p:
win rate = 1 - durak rate). 95% deal-clustered intervals (Wilson for degenerate cases).

Controller specs:
  ``nn:<path>``        greedy policy of a checkpoint (batched, no search)
  ``agent:<name>``     any registered agent, e.g. agent:champion, agent:heuristic
  ``agent:champion@<path>?search=1&belief_dets=0``  champion agent on a checkpoint, with kwargs
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
from .rollout import MAX_GAME_STEPS, _solver, nn_policy, solve_small


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

    kw = {}
    if "?" in name:
        name, q = name.split("?", 1)
        for item in q.split("&"):
            k, v = item.split("=", 1)
            kw[k] = float(v) if "." in v else int(v) if v.lstrip("-").isdigit() else v
            if k in ("search", "search_multi", "belief_dets", "use_solver"):
                kw[k] = bool(int(v))
    if "@" in name:
        name, path = name.split("@", 1)
        kw["path"] = path
    return get_agent(name, **kw)


def play_games(me: str, opp: str, n_players: int, n_games: int, seed: int, concurrency: int = 64,
               endgame: str = "none", solve_cards: int = 16, solve_nodes: int = 100_000) -> dict:
    """Play ``n_games`` as paired deals: deal k is played N times with ``me`` in
    seat 0..N-1 (variance reduction). ``endgame``:

    * ``none``  - everyone plays everything out.
    * ``me``    - our seat uses the exact solver whenever it applies (as the
      champion does): proven win/draw -> solver move, otherwise the policy.
    * ``solve`` - once a 2-player perfect-information endgame with at most
      ``solve_cards`` cards is solvable, the game ends with its exact value
      (both sides play the endgame perfectly; emulates the ``solver`` bot).
    """
    torch.set_num_threads(1)
    me, opp = _norm_spec(me), _norm_spec(opp)
    rng = random.Random(seed)
    results = {"games": 0, "durak": 0, "draws": 0, "ret": 0.0, "ret2": 0.0, "deals": {}}
    next_game = 0
    slots: list = [None] * min(concurrency, n_games)
    sv = _solver() if endgame != "none" else None

    def start(i_slot):
        nonlocal next_game
        if next_game >= n_games:
            slots[i_slot] = None
            return
        gi = next_game
        next_game += 1
        deal = gi // n_players
        g = DurakGame(seed=seed * 1_000_003 + deal, num_players=n_players)
        my_seat = gi % n_players
        ctrl = [me if p == my_seat else opp for p in range(n_players)]
        agents = {}
        for p, c in enumerate(ctrl):
            if c.startswith("agent:"):
                ag = _make_agent(c[6:])
                ag.reset()
                agents[p] = ag
        slots[i_slot] = [g, PublicTracker(n_players, g.trump, g.attacker), ctrl, agents, my_seat, deal, None, -1]

    def finish(s):
        g, _, _, _, my, deal, solved, _ = s
        if solved is not None:
            rets, loser = solved
        else:
            rets, loser = g.returns(), g.loser  # all zeros (draw) if truncated
        r = rets[my]
        d = 1 if loser == my else 0
        results["games"] += 1
        results["durak"] += d
        results["draws"] += 1 if loser is None else 0
        results["ret"] += r
        results["ret2"] += r * r
        # per deal: [our durak count, games, games with a durak (not drawn)]
        e = results["deals"].setdefault(f"{seed}:{deal}", [0, 0, 0])
        e[0] += d
        e[1] += 1
        e[2] += 1 if loser is not None else 0

    for i in range(len(slots)):
        start(i)
    while any(s is not None for s in slots):
        groups: dict[str, list] = {}
        for i, s in enumerate(slots):
            while s is not None:
                g, tr, ctrl, agents, my = s[:5]
                if endgame == "solve" and not g.done and not g.talon and s[6] is None:
                    cards = sum(h.bit_count() for h in g.hands) + len(g.attack_cards) + len(g.defense_cards)
                    if cards != s[7]:
                        s[7] = cards
                        s[6] = solve_small(g, solve_cards, solve_nodes)
                if g.done or len(g.log) > MAX_GAME_STEPS or s[6] is not None:
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
                    a = None
                    if endgame == "me" and p == my and sv is not None and sv.applicable(g):
                        res = sv.solve(g, p, time_limit=None, node_limit=solve_nodes)
                        if res is not None and res[0] >= 0:
                            a = res[1]
                    if a is None:
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
    me, opp, n, k, seed, kw = args
    return play_games(me, opp, n, k, seed, **kw)


def run_match(me: str, opp: str, n_players: int, n_games: int, seed: int, workers: int, **kw) -> dict:
    """Split ``n_games`` (rounded up to whole deals) over ``workers`` processes."""
    return summarize(raw_match(me, opp, n_players, n_games, seed, workers, **kw), n_players)


def raw_match(me: str, opp: str, n_players: int, n_games: int, seed: int, workers: int, **kw) -> dict:
    """Like :func:`run_match` but returns the raw totals including per-deal
    results (``deals``: {key: [durak count, games]}). Two calls with the same
    ``seed``, ``n_games``, ``n_players`` and ``workers`` play the *same deals*,
    so their results can be compared pairwise (:func:`paired_diff`)."""
    deals = -(-n_games // n_players)
    per = [deals // workers + (1 if i < deals % workers else 0) for i in range(workers)]
    jobs = [(me, opp, n_players, k * n_players, seed + 7919 * i, kw) for i, k in enumerate(per) if k]
    tot = {"games": 0, "durak": 0, "draws": 0, "ret": 0.0, "ret2": 0.0, "deals": {}}
    if workers <= 1:
        res = [_job(j) for j in jobs]
    else:
        with ProcessPoolExecutor(max_workers=workers) as ex:
            res = list(ex.map(_job, jobs))
    for r in res:
        for k in tot:
            if k == "deals":
                tot[k].update(r[k])
            else:
                tot[k] += r[k]
    return tot


def paired_diff(a: dict, b: dict, n_players: int) -> dict:
    """Durak-rate difference ``a - b`` of two raw results on the same deals,
    with a deal-clustered standard error. ``z`` > 0 means ``a`` is better
    (lower durak rate)."""
    keys = [k for k in a["deals"] if k in b["deals"]]
    if not keys:
        raise ValueError("no common deals: use the same seed / games / workers")
    xs, cs = [], []
    for k in keys:
        da, ga = a["deals"][k][:2]
        db, gb = b["deals"][k][:2]
        if ga != gb:
            continue
        xs.append(da - db)
        cs.append(ga)
    n = sum(cs)
    m = len(xs)
    diff = sum(xs) / n
    var = m / max(m - 1, 1) * sum((x - diff * c) ** 2 for x, c in zip(xs, cs)) / (n * n)
    se = max(math.sqrt(var), 0.25 / n)
    return {"N": n_players, "diff": diff, "se": se, "z": -diff / se, "games": n, "deals": m}


def summarize(tot: dict, n_players: int) -> dict:
    """Durak rate with a deal-clustered 95% CI (normal approx.; Wilson if no
    deal info) and a standardized score ``z`` (> 0 = better than an equal-strength
    seat).

    The null is *draw-corrected*: with draws (2p simultaneous finish ~6%, 3+p
    stall rule ~4-5%) every seat's durak rate is below 1/N, so the fair baseline
    is P(game decided) / N. (Before 2026-10-19 z used 1/N, which made any
    challenger look significantly better than its opponents.) ``baseline``
    stays 1/N for display; ``fair_baseline`` is the corrected one."""
    n = tot["games"]
    d = tot["durak"]
    base = 1.0 / n_players
    rate = d / max(n, 1)
    deals = list(tot.get("deals", {}).values())
    has_dec = bool(deals) and all(len(e) > 2 for e in deals)
    decided = sum(e[2] for e in deals) if has_dec else n - tot.get("draws", 0)
    fair = decided / max(n, 1) / n_players
    if len(deals) >= 10:
        # cluster-robust variance of the mean over deals
        m = len(deals)
        dev = [(e[0] - rate * e[1]) for e in deals]
        var = m / (m - 1) * sum(x * x for x in dev) / (n * n)
        pf = max(rate, 1.0 / n)
        se = max(math.sqrt(max(var, 0.0)), 0.5 * math.sqrt(pf * (1 - pf) / n))  # floor for rate ~ 0
        lo, hi = max(0.0, rate - 1.96 * se), min(1.0, rate + 1.96 * se)
        if d == 0 or d == n:  # degenerate: use the Wilson interval
            lo, hi = wilson(d, n)
        if has_dec:  # paired with the deal's own draw count: y = d - decided/N
            ys = [e[0] - e[2] / n_players for e in deals]
            ybar = sum(ys) / n
            vy = m / (m - 1) * sum((y - ybar * e[1]) ** 2 for y, e in zip(ys, deals)) / (n * n)
            sz = max(math.sqrt(max(vy, 0.0)), 0.5 * math.sqrt(pf * (1 - pf) / n))
            z = -ybar / sz
        else:
            z = (fair - rate) / se if se > 0 else 0.0
    else:
        lo, hi = wilson(d, n)
        z = (fair - rate) / math.sqrt(max(fair * (1 - fair), 1e-9) / max(n, 1)) if n else 0.0
    return {
        "N": n_players, "games": n, "durak_rate": rate, "ci_lo": lo, "ci_hi": hi,
        "baseline": base, "fair_baseline": fair, "draws": tot["draws"], "mean_return": tot["ret"] / max(n, 1),
        "z": z,
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
    ap.add_argument("--endgame", choices=["none", "me", "solve"], default="none",
                    help="none: play out; me: our nn seat uses the exact solver; solve: exact termination")
    args = ap.parse_args(argv)
    from ..agents import available_agents

    avail = available_agents()
    rows = []
    for opp in args.opps:
        spec = _norm_spec(opp)
        if spec.startswith("agent:") and spec[6:].split("@")[0].split("?")[0] not in avail:
            print(f"skip {opp}: not available ({avail})")
            continue
        for n in args.ns:
            t = time.time()
            r = run_match(args.me, opp, n, args.games, args.seed + n, args.workers, endgame=args.endgame)
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
