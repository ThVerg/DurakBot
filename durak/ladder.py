"""Elo rating ladder for all agents, per player count N = 2..6.

Model ("durak choice" / Luce model)
-----------------------------------
In Durak the payoff depends only on *who is the durak* (everyone else gets the
same reward), so the ladder models exactly that event. Every agent ``i`` has a
rating ``r_i`` and a "losing strength" ``g_i = 10 ** (-r_i / 400)``. At a table
with seats ``s`` (several seats may hold copies of the same agent):

    P(seat s is the durak) = g_agent(s) / sum_t g_agent(t)

With N = 2 this is exactly Elo/Bradley-Terry: P(A beats B) = 1 / (1 + 10 **
((r_B - r_A) / 400)). For N >= 3 it is the multinomial-logit (Luce choice)
model for the loser, the first stage of a Plackett-Luce model on placements.
We use only that stage on purpose: the order in which the other players went
out does not affect the payoff, and rating it would reward finishing early
rather than not losing. A draw (nobody is the durak) counts as 1/N of a
"durak" for every seat. Ratings are fitted per N by Newton's method
(penalised maximum likelihood: a very weak Gaussian prior, sd = 1500 Elo,
keeps ratings finite when an agent never loses). They are anchored at
random = 0. 95% CIs come from a bootstrap over deal units (all games of one
deal), refitting each replicate.

Schedule
--------
2 players: paired deals with seats swapped. N >= 3: for a pair (A, B), one deal
is played with A alone vs a field of B in every seat, and with B alone vs a
field of A in every seat (2N games). These are the arena's "1 vs field"
tables. Pairs are agents adjacent (or one apart) in the current rating order,
which is where games are most informative. Pairs that have played fewer games
come first, weighted by how expensive their agents are.

Raw results are appended to ``runs/ladder_games.jsonl``, so repeated runs keep
refining the ladder. Each record stores the agents' versions (a hash of the
code, or the mtime/size of the weights file). A fit only uses records whose
versions match the current agents, so a new champion starts afresh.

CLI::

    python -m durak.ladder --minutes 15 --workers 3           # play a while, then fit
    python -m durak.ladder --fit-only                          # refit and rewrite runs/ladder.json
    python -m durak.ladder --ns 2 4 --agents random heuristic solver --minutes 5
"""

from __future__ import annotations

import argparse
import datetime as _dt
import glob
import hashlib
import json
import math
import multiprocessing as mp
import os
import random
import time
from collections import defaultdict

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNS = os.path.join(ROOT, "runs")
GAMES_FILE = os.path.join(RUNS, "ladder_games.jsonl")
OUT_FILE = os.path.join(RUNS, "ladder.json")
ANCHOR = "random"
ALIASES = {"grandmaster": "champion"}  # identical agents: rated once, reported under both names
CORE_AGENTS = ["random", "heuristic", "solver", "novice", "intermediate", "expert", "champion_fast", "champion"]
ELO = 400.0 / math.log(10.0)  # theta = -r / ELO, g = exp(theta)

# Rough relative cost per game (used only to spread the budget).
COST = defaultdict(lambda: 5.0, {"champion": 60.0, "grandmaster": 60.0, "solver": 2.0, "random": 0.05,
                                 "heuristic": 0.1, "novice": 1.0, "intermediate": 2.0})


# ------------------------------------------------------------------ agents
def default_checkpoints(max_n: int = 3) -> list[str]:
    """Up to ``max_n`` evenly spaced historical checkpoints of runs/main."""
    paths = sorted(glob.glob(os.path.join(RUNS, "main", "ckpt", "it*.pt")))
    if len(paths) > max_n:
        idx = [round(i * (len(paths) - 1) / (max_n - 1)) for i in range(max_n)]
        paths = [paths[i] for i in sorted(set(idx))]
    return ["ckpt:" + os.path.relpath(p, ROOT) for p in paths]


def display_name(spec: str) -> str:
    if spec.startswith("ckpt:"):
        return os.path.splitext(os.path.basename(spec[5:]))[0]  # e.g. it000300
    return spec


def _file_tag(path: str) -> str:
    try:
        st = os.stat(path)
        return f"{int(st.st_mtime)}-{st.st_size}"
    except OSError:
        return "missing"


def _src_hash(*rel: str) -> str:
    h = hashlib.sha1()
    for r in rel:
        try:
            h.update(open(os.path.join(ROOT, r), "rb").read())
        except OSError:
            h.update(r.encode())
    return h.hexdigest()[:10]


def agent_version(spec: str) -> str:
    champ = _file_tag(os.path.join(ROOT, "checkpoints", "champion.pt"))
    if spec == "random":
        return "1"
    if spec == "heuristic":
        return _src_hash("durak/agents/heuristic.py")
    if spec == "solver":
        return _src_hash("durak/agents/heuristic.py", "durak/agents/solver_agent.py")
    if spec in ("champion", "champion_fast"):
        return champ + "-" + _src_hash("durak/agents/champion.py")
    if spec in ("novice", "intermediate", "expert", "grandmaster"):
        # per-level: the level's own parameters + the LevelAgent code, so tuning
        # one level does not invalidate the others' games
        import inspect

        from .agents import levels

        h = hashlib.sha1(json.dumps(levels.LEVELS[spec], sort_keys=True, default=str).encode())
        h.update(inspect.getsource(levels.LevelAgent).encode())
        return champ + "-" + _src_hash("durak/agents/champion.py") + "-" + h.hexdigest()[:10]
    if spec.startswith("ckpt:"):
        return _file_tag(os.path.join(ROOT, spec[5:])) + "-" + _src_hash("durak/agents/champion.py")
    if spec.startswith("level:"):
        return champ + "-" + _src_hash("durak/agents/champion.py", "durak/agents/levels.py")
    return _src_hash("durak/agents/__init__.py")


def _parse_level_spec(spec: str) -> dict:
    """``level:temperature=1.5,top_p=0.9,use_solver=0,search=0`` -> kwargs."""
    kw = {}
    for part in spec[6:].split(","):
        if not part:
            continue
        k, v = part.split("=")
        kw[k] = bool(int(float(v))) if k in ("use_solver", "search") else float(v)
    return kw


def make_agent(spec: str, seed: int | None = None):
    from .agents import get_agent

    if spec.startswith("ckpt:"):
        # historical checkpoint: policy + endgame solver (like champion_fast)
        return get_agent("champion", path=os.path.join(ROOT, spec[5:]), search=False)
    if spec.startswith("level:"):
        from .agents.levels import LevelAgent

        return LevelAgent(seed=seed, **_parse_level_spec(spec))
    try:
        return get_agent(spec, seed=seed)
    except TypeError:
        return get_agent(spec)


# ------------------------------------------------------------------ playing
_CACHE: dict = {}


def _agent(spec: str, slot: int):
    key = (spec, slot)
    if key not in _CACHE:
        _CACHE[key] = make_agent(spec)
    return _CACHE[key]


def play_unit(job: dict) -> list[dict]:
    """Play one deal unit. ``job``: {n, a, b, deal, unit}. Returns records."""
    from .arena import GameTimeout, play_game

    n, a, b, deal = job["n"], job["a"], job["b"], job["deal"]
    tables = []
    for lone, field in ([(a, b)] if n == 2 else [(a, b), (b, a)]):
        for seat in range(n):
            tables.append([lone if p == seat else field for p in range(n)])
    out = []
    for ti, specs in enumerate(tables):
        slots = defaultdict(int)
        agents = []
        for s in specs:
            agents.append(_agent(s, slots[s]))
            slots[s] += 1
        for p, ag in enumerate(agents):
            if isinstance(getattr(ag, "rng", None), random.Random):
                ag.rng.seed(deal * 131 + ti * 17 + p)
        t0 = time.perf_counter()
        try:
            g = play_game(agents, deal, n, random.Random(deal * 7 + ti))
            loser, stall = g.loser, bool(g.loser is None and g.stall >= g.config.stall_bouts)
        except GameTimeout:
            loser, stall = None, True
        out.append({"n": n, "unit": job["unit"], "deal": deal, "seats": specs, "loser": loser, "stall": stall,
                    "secs": round(time.perf_counter() - t0, 3), "ver": job["ver"]})
    return out


def _worker_init():
    try:
        import torch

        torch.set_num_threads(1)
    except Exception:
        pass


# ---------------------------------------------------------------- records
def load_records(path: str = GAMES_FILE) -> list[dict]:
    if not os.path.exists(path):
        return []
    out = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return out


def current_records(records: list[dict], versions: dict[str, str]) -> list[dict]:
    """Records whose every agent is in ``versions`` with the same version."""
    out = []
    for r in records:
        if all(versions.get(s) == r["ver"].get(s) for s in set(r["seats"])):
            out.append(r)
    return out


# -------------------------------------------------------------------- fit
class _Data:
    """Records of one N aggregated into deal units x table groups."""

    def __init__(self, records: list[dict], agents: list[str]):
        self.agents = agents
        idx = {a: i for i, a in enumerate(agents)}
        K = len(agents)
        groups: dict[tuple, int] = {}
        units: dict[str, int] = {}
        rows = []  # (unit, group, w-vector)
        self.games = np.zeros(K)
        for r in records:
            if any(s not in idx for s in r["seats"]):
                continue
            n = len(r["seats"])
            cnt = [0] * K
            for s in r["seats"]:
                cnt[idx[s]] += 1
            key = tuple(cnt)
            gi = groups.setdefault(key, len(groups))
            ui = units.setdefault(r["unit"], len(units))
            w = np.zeros(K)
            if r["loser"] is None:
                for s in r["seats"]:
                    w[idx[s]] += 1.0 / n
            else:
                w[idx[r["seats"][r["loser"]]]] += 1.0
            rows.append((ui, gi, w))
            for a in set(r["seats"]):
                self.games[idx[a]] += 1
        self.G, self.U = len(groups), len(units)
        self.ncount = np.zeros((self.G, K))
        for key, gi in groups.items():
            self.ncount[gi] = key
        self.Wug = np.zeros((self.U, self.G))
        self.wug = np.zeros((self.U, self.G, K))
        for ui, gi, w in rows:
            self.Wug[ui, gi] += 1
            self.wug[ui, gi] += w

    def stats(self, unit_weights=None):
        if unit_weights is None:
            return self.Wug.sum(0), self.wug.sum(0)
        return unit_weights @ self.Wug, np.einsum("u,ugk->gk", unit_weights, self.wug)


def fit_luce(W: np.ndarray, w: np.ndarray, ncount: np.ndarray, anchor: int | None,
             prior_sd_elo: float = 1500.0, iters: int = 100) -> np.ndarray:
    """Penalised ML for the durak-choice model. Returns Elo ratings (K,)."""
    K = ncount.shape[1]
    tau2 = (prior_sd_elo / ELO) ** 2
    theta = np.zeros(K)
    free = np.ones(K, bool)
    if anchor is not None:
        free[anchor] = False
    wk = w.sum(0)

    def objective(th):
        z = ncount @ np.exp(th)
        return float(wk @ th - W @ np.log(np.maximum(z, 1e-300)) - (th[free] ** 2).sum() / (2 * tau2))

    f = objective(theta)
    for _ in range(iters):
        e = np.exp(theta)
        z = ncount @ e  # (G,)
        p = ncount * e / z[:, None]  # (G, K)
        grad = wk - W @ p - np.where(free, theta / tau2, 0.0)
        H = -(np.diag(W @ p) - np.einsum("g,gi,gj->ij", W, p, p)) - np.diag(np.where(free, 1.0 / tau2, 0.0))
        gf = grad[free]
        if np.max(np.abs(gf)) < 1e-9:
            break
        Hf = H[np.ix_(free, free)]
        step = np.zeros(K)
        try:
            step[free] = np.linalg.solve(Hf, -gf)
        except np.linalg.LinAlgError:
            step[free] = gf * 0.1
        t = 1.0
        while t > 1e-6:
            cand = theta + t * step
            fc = objective(cand)
            if fc >= f - 1e-12:
                theta, f = cand, fc
                break
            t *= 0.5
        else:
            break
    return -theta * ELO


def fit_n(records: list[dict], agents: list[str], n_boot: int = 200, seed: int = 0) -> list[dict]:
    """Ratings with bootstrap CIs for one player count."""
    present = sorted({s for r in records for s in r["seats"]} & set(agents), key=agents.index)
    if len(present) < 2:
        return []
    data = _Data(records, present)
    anchor = present.index(ANCHOR) if ANCHOR in present else None
    W, w = data.stats()
    elo = fit_luce(W, w, data.ncount, anchor)
    if anchor is None:
        elo = elo - elo.min()
    rng = np.random.default_rng(seed)
    boots = []
    for _ in range(n_boot):
        cw = rng.multinomial(data.U, np.full(data.U, 1.0 / data.U)).astype(float)
        Wb, wb = data.stats(cw)
        e = fit_luce(Wb, wb, data.ncount, anchor, iters=40)
        boots.append(e if anchor is not None else e - e.min())
    boots = np.array(boots)
    out = []
    for i, a in enumerate(present):
        lo, hi = (np.percentile(boots[:, i], [2.5, 97.5]) if n_boot else (elo[i], elo[i]))
        out.append({"agent": display_name(a), "spec": a, "elo": round(float(elo[i]), 1),
                    "ci": [round(float(lo), 1), round(float(hi), 1)], "games": int(data.games[i])})
    out.sort(key=lambda x: -x["elo"])
    return out


def fit_all(records: list[dict], agents: list[str], ns, n_boot: int = 200) -> dict:
    ratings = {}
    for n in ns:
        rs = fit_n([r for r in records if r["n"] == n], agents, n_boot=n_boot, seed=n)
        for alias, target in ALIASES.items():
            for e in list(rs):
                if e["spec"] == target and not any(x["agent"] == alias for x in rs):
                    rs.append({**e, "agent": alias, "spec": alias, "alias_of": target})
        rs.sort(key=lambda x: -x["elo"])
        ratings[str(n)] = rs
    return ratings


# --------------------------------------------------------------- schedule
def _pairs(order: list[str], skip: int = 2) -> list[tuple[str, str]]:
    out = []
    for i in range(len(order)):
        for j in range(i + 1, min(len(order), i + 1 + skip)):
            out.append((order[i], order[j]))
    return out


PRIOR = {"random": -400, "novice": 100, "heuristic": 300, "intermediate": 400, "solver": 450, "expert": 600,
         "champion_fast": 600, "champion": 700}


def _order(records, agents, n):
    rs = fit_n([r for r in records if r["n"] == n], agents, n_boot=0) if records else []
    elo = {e["spec"]: e["elo"] for e in rs}
    def key(a):
        if a in elo:
            return elo[a]
        if a.startswith("ckpt:"):
            return 500
        return PRIOR.get(a, 300)
    return sorted(agents, key=key)


def run_ladder(agents: list[str], ns=(2, 3, 4, 5, 6), minutes: float = 15.0, workers: int = 3,
               seed: int | None = None, games_file: str = GAMES_FILE, out_file: str = OUT_FILE,
               n_boot: int = 200, max_units_per_pair: int | None = None, verbose: bool = True) -> dict:
    os.makedirs(os.path.dirname(games_file), exist_ok=True)
    versions = {a: agent_version(a) for a in agents}
    allrec = current_records(load_records(games_file), versions)
    rng = random.Random(seed if seed is not None else time.time_ns())
    deadline = time.time() + minutes * 60
    # games already played and seconds spent per (n, pair)
    played = defaultdict(int)
    spent = defaultdict(float)
    timed = defaultdict(int)

    def account(r):
        key = (r["n"], tuple(sorted(set(r["seats"]))))
        if "secs" in r:
            spent[key] += r["secs"]
            timed[key] += 1

    for r in allrec:
        played[(r["n"], tuple(sorted(set(r["seats"]))))] += 1
        account(r)

    def cost_of(n, a, b):
        key = (n, tuple(sorted((a, b))))
        prior = math.sqrt(COST[a] * COST[b]) * 0.05 * n
        # measured mean seconds per game, shrunk towards the prior
        return (spent[key] + 4 * prior) / (timed[key] + 4)
    plans = {n: _pairs(_order(allrec, agents, n)) for n in ns}

    def next_job():
        best, best_score = None, None
        for n in ns:
            for a, b in plans[n]:
                key = (n, tuple(sorted((a, b))))
                # games per pair ~ 1/sqrt(cost) minimises rating variance per second
                score = (played[key] + 1) * math.sqrt(cost_of(n, a, b) + 1e-3)
                if max_units_per_pair is not None and played[key] >= max_units_per_pair * (2 if n == 2 else 2 * n):
                    continue
                if best_score is None or score < best_score:
                    best, best_score = (n, a, b), score
        if best is None:
            return None
        n, a, b = best
        played[(n, tuple(sorted((a, b))))] += 2 if n == 2 else 2 * n  # reserve
        deal = rng.randrange(1 << 40)
        unit = f"{n}-{a}-{b}-{deal}"
        return {"n": n, "a": a, "b": b, "deal": deal, "unit": unit, "ver": {a: versions[a], b: versions[b]}}

    n_new = 0
    t0 = last_print = time.time()
    if minutes > 0:
        ctx = mp.get_context("fork")
        with ctx.Pool(workers, initializer=_worker_init) as pool, open(games_file, "a") as f:
            pending = []
            while True:
                while time.time() < deadline and len(pending) < workers * 2:
                    job = next_job()
                    if job is None:
                        break
                    pending.append(pool.apply_async(play_unit, (job,)))
                if not pending:
                    break
                done = [p for p in pending if p.ready()]
                if not done:
                    time.sleep(0.05)
                    continue
                for p in done:
                    pending.remove(p)
                    for rec in p.get():
                        f.write(json.dumps(rec) + "\n")
                        allrec.append(rec)
                        account(rec)
                        n_new += 1
                    f.flush()
                if verbose and time.time() - last_print > 60:
                    last_print = time.time()
                    print(f"  {n_new} games, {time.time() - t0:.0f}s", flush=True)
    ratings = fit_all(allrec, agents, ns, n_boot=n_boot)
    out = {
        "updated": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
        "anchor": f"{ANCHOR}=0",
        "model": "durak-choice (Luce) model: P(seat is durak) proportional to 10^(-elo/400); "
                 "2p = Elo/Bradley-Terry; 95% CI = bootstrap over deals",
        "ratings": ratings,
        "aliases": ALIASES,
        "games": {str(n): sum(1 for r in allrec if r["n"] == n) for n in ns},
        "new_games": n_new,
    }
    levels = {}
    for lv in ("novice", "intermediate", "expert", "grandmaster"):
        levels[lv] = {n: next((e["elo"] for e in ratings[n] if e["agent"] == lv), None) for n in ratings}
    out["levels_elo"] = levels
    if out_file:
        tmp = out_file + ".tmp"
        with open(tmp, "w") as f:
            json.dump(out, f, indent=1)
        os.replace(tmp, out_file)
    return out


def format_ratings(out: dict) -> str:
    lines = []
    for n, rs in out["ratings"].items():
        lines.append(f"N={n} ({out['games'].get(n, 0)} games)")
        for e in rs:
            alias = f"  (= {e['alias_of']})" if "alias_of" in e else ""
            lines.append(f"  {e['agent']:<16} {e['elo']:7.0f}  [{e['ci'][0]:6.0f}, {e['ci'][1]:6.0f}]  {e['games']:6d} games{alias}")
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Elo ladder for Durak agents (per player count)")
    ap.add_argument("--agents", nargs="*", default=None,
                    help="agent names or ckpt:<path> (default: core agents + 3 historical checkpoints)")
    ap.add_argument("--ns", nargs="*", type=int, default=[2, 3, 4, 5, 6])
    ap.add_argument("--minutes", type=float, default=15.0, help="wall-clock budget for playing (default 15)")
    ap.add_argument("--workers", type=int, default=3, help="processes (shared machine: keep <= 4)")
    ap.add_argument("--fit-only", action="store_true", help="no new games; refit stored results")
    ap.add_argument("--boot", type=int, default=200)
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--games-file", default=GAMES_FILE)
    ap.add_argument("--out", default=OUT_FILE)
    args = ap.parse_args(argv)
    agents = args.agents or (CORE_AGENTS + default_checkpoints())
    out = run_ladder(agents, args.ns, 0 if args.fit_only else args.minutes, min(args.workers, 8), args.seed,
                     args.games_file, args.out, args.boot)
    print(format_ratings(out))
    print(f"wrote {args.out}")
    return out


if __name__ == "__main__":
    main()
