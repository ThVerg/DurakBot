"""Periodic evaluation + champion gating (run by the trainer as a subprocess
per checkpoint, so edits here take effect at the next gate without restarting
training).

Gate v3 (2026-10-19). Why: v2 compared the candidate against a *stored*
heuristic/solver score of the champion, measured once when it was promoted.
That value was the luckiest of many noisy measurements (winner's curse) and
blocked every later candidate. Also, head-to-head against the immediate
predecessor is biased towards the newer network: it is trained against
near-copies of the champion, so it beat the champion by z ~ 2.7 on average in
1000+ gates while results vs fixed opponents barely moved. So:

1. **Dashboard** (candidate only): ``random`` and the ``--anchors``; plus a
   *symmetric* head-to-head vs the champion (candidate-single vs
   champion-single on the same deals; needs z > ``--h2h-min``). The old
   one-sided h2h (challenger's durak rate vs 1/N) was biased by draws: every
   seat's durak rate is below 1/N when ~5% of games are drawn.
2. **Stage 1 (paired screen)** on a *fresh* deal set (seeded by iteration):
   candidate AND champion both play the same deals vs ``heuristic``
   (policy + our-seat exact solver, as deployed), ``solver`` (both perfect in
   endgames), and each network of the frozen ``--population``. Per family,
   the paired durak-rate difference is combined over N (curriculum weights).
   fixed_z = (z_heuristic + z_solver + z_population) / sqrt(3).
3. **Stage 2 (confirmation)**, only if stage 1 has fixed_z > ``--threshold``
   and h2h z > ``--h2h-min``: the same on a second, independent fresh deal
   set. Promote iff stage-2 fixed_z > ``--confirm`` and no family is
   significantly worse when pooled over both stages (z > -``--tolerance``).
   For an equally strong candidate that is ~0.1 x 0.05 = 0.5% per gate.

The champion is re-measured every gate (never compared to a stored number);
its measurements accumulate in ``checkpoints/champion_stats.json`` (reset on
promotion), and ``runs/eval_summary.json`` is rewritten from that running
estimate after every gate.

Outputs: ``<run>/eval.jsonl`` (one record per gate; v2 keys kept:
``{name}_{N}p_durak/_ci/_games``, ``{name}_z``, ``champ_{N}p_durak/_ci``,
``vs_champion_z``, ``promoted``, ``rejected``), TensorBoard ``eval/*``,
``checkpoints/champion.pt`` + ``champion.json`` + ``champion_history.jsonl``
on promotion, and ``runs/eval_summary.json``. New keys: ``champ_rev_{N}p_durak``,
``stage1``/``stage2`` (family z), ``fixed_z1``/``fixed_z2``, ``decision``, ``champion_iter``.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import os
import shutil
import time

from .evaluate import combined_z, fmt_row, paired_diff, raw_match, summarize, wilson

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CKPT_DIR = os.path.join(ROOT, "checkpoints")
CHAMPION = os.path.join(CKPT_DIR, "champion.pt")
CHAMP_JSON = os.path.join(CKPT_DIR, "champion.json")
CHAMP_STATS = os.path.join(CKPT_DIR, "champion_stats.json")
SUMMARY = os.path.join(ROOT, "runs", "eval_summary.json")
SUITE_VERSION = 3
DEFAULT_POPULATION = [os.path.join(CKPT_DIR, f"frozen_it{i}.pt") for i in (667, 1500, 50000, 100000)]


def install_champion(ckpt: str, info: dict) -> None:
    os.makedirs(os.path.dirname(CHAMPION), exist_ok=True)
    tmp = CHAMPION + ".tmp"
    shutil.copyfile(ckpt, tmp)
    os.replace(tmp, CHAMPION)
    with open(os.path.join(os.path.dirname(CHAMPION), "champion_history.jsonl"), "a") as f:
        f.write(json.dumps(info) + "\n")
    _write_json(CHAMP_JSON, info)


def _write_json(path: str, obj) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=1)
    os.replace(tmp, path)


def _sha(path: str) -> str:
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()[:16]


def anchor_name(path: str) -> str:
    return "anchor:" + os.path.splitext(os.path.basename(path))[0]


# ------------------------------------------------------------ decision logic
def family_zs(diffs: dict[str, list[dict]]) -> dict[str, float]:
    """diffs: family -> list of paired_diff rows (anchors: 'anchor:*' keys).
    Returns {heuristic, solver, population} combined z (positive = candidate better)."""
    out = {}
    for fam in ("heuristic", "solver"):
        if diffs.get(fam):
            out[fam] = combined_z(diffs[fam])
    pops = [combined_z(v) for k, v in diffs.items() if k.startswith("anchor:") and v]
    if pops:
        out["population"] = sum(pops) / math.sqrt(len(pops))
    return out


def fixed_z(fz: dict[str, float]) -> float:
    vals = [v for v in fz.values() if v is not None]
    return sum(vals) / math.sqrt(len(vals)) if vals else 0.0


def decide(h2h_z: float | None, fz1: dict, fz2: dict | None, threshold: float = 1.28,
           confirm: float = 1.645, tolerance: float = 1.645, h2h_min: float = 0.0):
    """Pure gating rule. Returns (stage1_passed, promote, reason)."""
    z1 = fixed_z(fz1)
    if h2h_z is not None and h2h_z <= h2h_min:
        return False, False, f"h2h z {h2h_z:.2f} <= {h2h_min}"
    if z1 <= threshold:
        return False, False, f"stage1 fixed_z {z1:.2f} <= {threshold}"
    if fz2 is None:
        return True, False, "awaiting confirmation"
    z2 = fixed_z(fz2)
    if z2 <= confirm:
        return True, False, f"not confirmed: stage2 fixed_z {z2:.2f} <= {confirm}"
    for fam in fz1:
        if fam in fz2:
            pooled = (fz1[fam] + fz2[fam]) / math.sqrt(2)
            if pooled < -tolerance:
                return True, False, f"worse vs {fam} (pooled z {pooled:.2f})"
    return True, True, "confirmed"


# ------------------------------------------------------------ measurements
def paired_stage(cand: str, champ: str | None, seed_base: int, args, it: int, label: str):
    """Candidate and champion on identical fresh deals. Returns
    (family z dict, {family: per-N diffs}, cand raw, champ raw). ``champ=None``
    measures the candidate only."""
    fams = [("heuristic", "heuristic", "me", args.pair_games), ("solver", "heuristic", "solve", args.pair_games)]
    fams += [(anchor_name(p), "nn:" + p, "solve", args.pop_games) for p in args.population if os.path.exists(p)]
    diffs, raw_c, raw_k = {}, {}, {}
    for fi, (fam, opp, endgame, games) in enumerate(fams):
        diffs[fam] = []
        for n in args.ns:
            seed = seed_base + 1000 * fi + n
            a = raw_match(cand, opp, n, games, seed, args.workers, endgame=endgame)
            raw_c[(fam, n)] = a
            sa = summarize(a, n)
            if champ is None:
                print(f"[it {it}] {label} {fam:<22} N={n} {sa['durak_rate']:.3f}", flush=True)
                continue
            b = raw_match(champ, opp, n, games, seed, args.workers, endgame=endgame)
            d = paired_diff(a, b, n)
            diffs[fam].append(d)
            raw_k[(fam, n)] = b
            sb = summarize(b, n)
            print(f"[it {it}] {label} {fam:<22} N={n} cand {sa['durak_rate']:.3f} champ {sb['durak_rate']:.3f} "
                  f"diff {d['diff']:+.4f}±{d['se']:.4f} z={d['z']:+.2f}", flush=True)
    return family_zs(diffs), diffs, raw_c, raw_k


def run_dashboard(ckpt: str, args, rec: dict, it: int) -> None:
    """Candidate-only results: random and the --anchors (fixed seeds)."""
    jobs = [("random", "random", "none", args.random_games, 1000)]
    pop = {os.path.abspath(p) for p in args.population}
    jobs += [(anchor_name(a), "nn:" + a, "solve", args.anchor_games, 3000) for a in args.anchors
             if os.path.exists(a) and os.path.abspath(a) not in pop]
    for name, opp, endgame, games, seed in jobs:
        rows = []
        for n in args.ns:
            r = summarize(raw_match(ckpt, opp, n, games, seed + n, args.workers, endgame=endgame), n)
            rows.append(r)
            print(f"[it {it}] {name:<9} " + fmt_row(opp, r), flush=True)
            _put(rec, name, n, r)
        rec[f"{name}_z"] = combined_z(rows)


def symmetric_h2h(cand: str, champ: str, args, rec: dict, it: int) -> float:
    """Head-to-head without the 1-vs-field biases: on the same deals, the
    candidate plays 1 seat vs a champion field AND the champion plays 1 seat vs
    a candidate field; per N the paired difference of the two single-seat
    durak rates (draws and odd-one-out effects cancel). z > 0: candidate better.
    Keys: champ_{N}p_durak (candidate single), champ_rev_{N}p_durak (champion single)."""
    diffs = []
    for n in args.ns:
        seed = 5000 + n + it
        a = raw_match(cand, "nn:" + champ, n, args.games, seed, args.workers, endgame="solve")
        b = raw_match(champ, "nn:" + cand, n, args.games, seed, args.workers, endgame="solve")
        d = paired_diff(a, b, n)
        diffs.append(d)
        ra, rb = summarize(a, n), summarize(b, n)
        print(f"[it {it}] h2h N={n} cand-single {ra['durak_rate']:.3f} champ-single {rb['durak_rate']:.3f} "
              f"diff {d['diff']:+.4f}±{d['se']:.4f} z={d['z']:+.2f}", flush=True)
        rec[f"champ_{n}p_durak"] = ra["durak_rate"]
        rec[f"champ_{n}p_ci"] = [round(ra["ci_lo"], 4), round(ra["ci_hi"], 4)]
        rec[f"champ_rev_{n}p_durak"] = rb["durak_rate"]
    return combined_z(diffs)


def _put(rec: dict, name: str, n: int, r: dict) -> None:
    rec[f"{name}_{n}p_durak"] = r["durak_rate"]
    rec[f"{name}_{n}p_ci"] = [round(r["ci_lo"], 4), round(r["ci_hi"], 4)]
    rec[f"{name}_{n}p_games"] = r["games"]


def record_stage(rec: dict, raw: dict, ns) -> None:
    """Fill v2-style keys ({name}_{N}p_durak ...) from a stage's raw results."""
    names = sorted({k[0] for k in raw})
    for name in names:
        rows = []
        for n in ns:
            if (name, n) in raw:
                r = summarize(raw[(name, n)], n)
                rows.append(r)
                _put(rec, name, n, r)
        rec[f"{name}_z"] = combined_z(rows)


# ----------------------------------------------- champion running estimate
def load_stats(champ_path: str) -> dict:
    sha = _sha(champ_path)
    try:
        st = json.load(open(CHAMP_STATS))
        if st.get("sha") == sha:
            return st
    except (OSError, ValueError):
        pass
    info = {}
    try:
        info = json.load(open(CHAMP_JSON))
    except (OSError, ValueError):
        pass
    return {"sha": sha, "iter": info.get("iter"), "ckpt": info.get("ckpt"), "gates": 0, "results": {}}


def add_stats(st: dict, raw: dict) -> None:
    """Accumulate durak/games per (family, N) from raw results."""
    for (name, n), tot in raw.items():
        e = st["results"].setdefault(name, {}).setdefault(str(n), [0, 0])
        e[0] += tot["durak"]
        e[1] += tot["games"]


def write_summary_from_stats(st: dict, champ_info: dict) -> None:
    """``runs/eval_summary.json`` from the champion's accumulated measurements.
    Schema: {"updated", "iteration", "results": {opp: {"N": {"rate", "ci", "games"}}}}."""
    res = {}
    # random (and the dashboard anchors) are only measured for candidates: take them
    # from the champion's promotion record
    for key, val in champ_info.items():
        if key.endswith("p_durak") and not key.startswith("champ_"):
            opp, n = key[: -len("p_durak")].rsplit("_", 1)
            res.setdefault(opp, {})[n] = {"rate": round(val, 4), "ci": champ_info.get(f"{opp}_{n}p_ci"),
                                          "games": champ_info.get(f"{opp}_{n}p_games")}
    for opp, per in st.get("results", {}).items():
        for n, (d, g) in per.items():
            if g:
                lo, hi = wilson(d, g)
                res.setdefault(opp, {})[n] = {"rate": round(d / g, 4), "ci": [round(lo, 4), round(hi, 4)], "games": g}
    out = {
        "updated": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "iteration": st.get("iter") or champ_info.get("iter"),
        "ckpt": champ_info.get("ckpt"),
        "suite_version": SUITE_VERSION,
        "gates_accumulated": st.get("gates", 0),
        "notes": {
            "random": "greedy policy, played out (measured at promotion)",
            "heuristic": "policy + exact endgame solver for our seat (as deployed, without PIMC); "
                         "running estimate over all gates since promotion",
            "solver": "vs heuristic with every solvable 2-player endgame scored exactly "
                      "(both sides perfect in endgames = the solver bot); running estimate",
            "anchor:*": "vs frozen past networks (both perfect in endgames)",
        },
        "results": res,
    }
    os.makedirs(os.path.dirname(SUMMARY), exist_ok=True)
    _write_json(SUMMARY, out)


# --------------------------------------------------------------------- main
def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("ckpt")
    ap.add_argument("--run-dir", required=True)
    ap.add_argument("--games", type=int, default=600, help="head-to-head games per N")
    ap.add_argument("--pair-games", type=int, default=1200, help="paired games per N vs heuristic / solver")
    ap.add_argument("--pop-games", type=int, default=300, help="paired games per N vs each population network")
    ap.add_argument("--random-games", type=int, default=200)
    ap.add_argument("--anchor-games", type=int, default=300)
    ap.add_argument("--anchors", nargs="*", default=[os.path.join(CKPT_DIR, f"frozen_it{i}.pt") for i in (200, 667)],
                    help="dashboard anchors (candidate only)")
    ap.add_argument("--population", nargs="*", default=DEFAULT_POPULATION,
                    help="frozen networks used for paired gating")
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--threshold", type=float, default=1.28, help="stage-1 fixed_z screen")
    ap.add_argument("--confirm", type=float, default=1.645, help="stage-2 fixed_z needed to promote")
    ap.add_argument("--tolerance", type=float, default=1.645, help="no family pooled z below -tolerance")
    ap.add_argument("--h2h-min", type=float, default=0.0, help="head-to-head z must exceed this")
    ap.add_argument("--ns", nargs="+", type=int, default=[2, 3, 4, 5, 6])
    ap.add_argument("--no-gate", action="store_true")
    ap.add_argument("--summary-only", action="store_true",
                    help="re-measure the current champion (stage-1 style) and refresh eval_summary.json")
    args = ap.parse_args(argv)
    try:
        os.nice(5)
    except OSError:
        pass
    import torch

    meta = torch.load(args.ckpt, map_location="cpu", weights_only=False)
    it = meta.get("version", 0)
    t0 = time.time()
    rec = {"ckpt": os.path.abspath(args.ckpt), "iter": it, "steps": meta.get("steps"),
           "time": time.strftime("%Y-%m-%d %H:%M:%S"), "suite_version": SUITE_VERSION}
    # consistent reference for this whole gate, even if champion.pt changes meanwhile
    champ = os.path.join(args.run_dir, ".gate_champion.pt")
    if os.path.exists(CHAMPION):
        shutil.copyfile(CHAMPION, champ)
    champ_info = {}
    try:
        champ_info = json.load(open(CHAMP_JSON))
    except (OSError, ValueError):
        pass
    rec["champion_iter"] = champ_info.get("iter")

    if args.summary_only:
        st = load_stats(champ)
        _, _, raw, _ = paired_stage(champ, None, 900_000 + int(time.time()) % 100_000, args, it, "S")
        add_stats(st, raw)
        st["gates"] += 1
        _write_json(CHAMP_STATS, st)
        write_summary_from_stats(st, champ_info)
        print(json.dumps(st["results"]), flush=True)
        return

    run_dashboard(args.ckpt, args, rec, it)
    gated = False
    if args.no_gate or not os.path.exists(CHAMPION):
        gated = not args.no_gate  # first champion
    else:
        h2h = symmetric_h2h(args.ckpt, champ, args, rec, it)
        rec["vs_champion_z"] = h2h
        fz1, _, raw_c, raw_k = paired_stage(args.ckpt, champ, 10_000_000 + 37 * it, args, it, "S1")
        record_stage(rec, raw_c, args.ns)
        rec["stage1"] = fz1
        rec["fixed_z1"] = fixed_z(fz1)
        st = load_stats(champ)
        add_stats(st, raw_k)
        st["gates"] += 1
        passed, gated, reason = decide(h2h, fz1, None, args.threshold, args.confirm, args.tolerance, args.h2h_min)
        if passed:
            fz2, _, raw_c2, raw_k2 = paired_stage(args.ckpt, champ, 20_000_000 + 37 * it, args, it, "S2")
            rec["stage2"] = fz2
            rec["fixed_z2"] = fixed_z(fz2)
            add_stats(st, raw_k2)
            _, gated, reason = decide(h2h, fz1, fz2, args.threshold, args.confirm, args.tolerance, args.h2h_min)
        rec["decision"] = reason
        if not gated:
            rec["rejected"] = reason
            _write_json(CHAMP_STATS, st)
            write_summary_from_stats(st, champ_info)
        else:
            # new champion: its running estimate starts from the (unselected) confirmation stage
            new = {"sha": _sha(args.ckpt), "iter": it, "ckpt": rec["ckpt"], "gates": 1, "results": {}}
            if passed and "stage2" in rec:
                add_stats(new, raw_c2)
            _write_json(CHAMP_STATS, new)
    if gated:
        install_champion(args.ckpt, rec)
        if not os.path.exists(CHAMP_STATS) or json.load(open(CHAMP_STATS)).get("iter") != it:
            _write_json(CHAMP_STATS, {"sha": _sha(args.ckpt), "iter": it, "ckpt": rec["ckpt"], "gates": 0,
                                      "results": {}})
        write_summary_from_stats(json.load(open(CHAMP_STATS)), rec)
    rec["promoted"] = gated
    rec["eval_sec"] = round(time.time() - t0, 1)
    print(f"[it {it}] promoted={gated} vs_champion_z={rec.get('vs_champion_z')} fixed_z1={rec.get('fixed_z1')} "
          f"fixed_z2={rec.get('fixed_z2')} {rec.get('decision', '')} ({rec['eval_sec']}s)", flush=True)
    with open(os.path.join(args.run_dir, "eval.jsonl"), "a") as f:
        f.write(json.dumps(rec) + "\n")
    try:
        from torch.utils.tensorboard import SummaryWriter

        w = SummaryWriter(os.path.join(args.run_dir, "tb"))
        for k, v in rec.items():
            if isinstance(v, (int, float)) and not isinstance(v, bool) and k not in ("iter", "steps"):
                w.add_scalar("eval/" + k.replace(":", "_"), v, it)
        w.add_scalar("eval/promoted", int(gated), it)
        w.close()
    except Exception:
        pass


if __name__ == "__main__":
    main()
