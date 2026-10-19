"""Tournament: rank checkpoints on identical deals (paired comparisons).

Every candidate plays the same deals (same seeds / games / workers) against:

* ``heuristic`` - our seat uses the exact endgame solver (as deployed)
* ``solver``    - heuristic opponents, every solvable endgame scored exactly
  (both sides perfect in endgames = the solver bot)
* ``pop:<name>`` - a population of frozen past networks (both perfect in endgames)
* ``h2h``       - one-sided head-to-head vs the reference (1 seat vs a field of it),
  z against the draw-corrected baseline. Reported only; use ``--round-robin``
  for a fair symmetric head-to-head (A-single vs B-single on the same deals).

Ranking: paired durak-rate differences vs the reference on the same deals,
combined over N (curriculum weights) and over the fixed opponent families
(heuristic, solver, population): ``fixed_z`` > 0 means better than the reference.

Raw per-deal results are stored in ``--out`` (resumable: finished entries are skipped).

    .venv/bin/python -m durak.rl.tournament --ref checkpoints/champion.pt \
        --cands runs/main/ckpt/it200000.pt ... --out runs/tournament/t1.json
"""

from __future__ import annotations

import argparse
import json
import math
import os
import time

from .evaluate import DEFAULT_WEIGHTS, combined_z, paired_diff, raw_match, summarize

NS = [2, 3, 4, 5, 6]


def opponent_specs(ref: str, pop: list[str], g_fixed: int, g_pop: int, g_h2h: int, seed_offset: int = 0):
    """name -> (opponent spec, endgame mode, games, seed base)."""
    o = seed_offset
    specs = {
        "heuristic": ("heuristic", "me", g_fixed, 71000 + o),
        "solver": ("heuristic", "solve", g_fixed, 72000 + o),
    }
    for i, p in enumerate(pop):
        specs["pop:" + os.path.splitext(os.path.basename(p))[0]] = ("nn:" + p, "solve", g_pop, 73000 + 100 * i + o)
    specs["h2h"] = ("nn:" + ref, "solve", g_h2h, 74000 + o)
    return specs


def combine(zs: list[float]) -> float:
    return sum(zs) / math.sqrt(len(zs)) if zs else 0.0


def analyze(results: dict, cands: list[str], ref: str, specs: dict) -> list[dict]:
    """Per candidate: rates per opponent/N and paired z vs the reference."""
    out = []
    for c in cands:
        row = {"cand": c, "opp": {}}
        fam_z = {}
        for name in specs:
            per_n, diffs = {}, []
            for n in NS:
                key = f"{c}|{name}|{n}"
                if key not in results:
                    continue
                s = summarize(results[key], n)
                per_n[n] = s
                rkey = f"{ref}|{name}|{n}"
                if c != ref and name != "h2h" and rkey in results:
                    diffs.append(paired_diff(results[key], results[rkey], n))
            if not per_n:
                continue
            row["opp"][name] = {
                "rates": {n: (s["durak_rate"], s["ci_lo"], s["ci_hi"], s["games"]) for n, s in per_n.items()},
                "z_vs_base": combined_z(list(per_n.values())),
            }
            if diffs:
                row["opp"][name]["diff"] = {d["N"]: (d["diff"], d["se"], d["z"]) for d in diffs}
                row["opp"][name]["z_vs_ref"] = combined_z(diffs)
        if c != ref:
            zh = row["opp"].get("heuristic", {}).get("z_vs_ref")
            zs = row["opp"].get("solver", {}).get("z_vs_ref")
            pz = [v["z_vs_ref"] for k, v in row["opp"].items() if k.startswith("pop:") and "z_vs_ref" in v]
            fam_z = {"heuristic": zh, "solver": zs, "population": combine(pz) if pz else None}
            row["family_z"] = fam_z
            row["fixed_z"] = combine([z for z in fam_z.values() if z is not None])
            if "h2h" in row["opp"]:
                row["h2h_z"] = row["opp"]["h2h"]["z_vs_base"]
        out.append(row)
    return out


def round_robin(players: list[str], games: int, workers: int, out: dict, save=None, seed_offset: int = 0) -> dict:
    """Symmetric head-to-head: for each pair (A, B) and N, A plays 1 seat vs a
    field of B and B plays 1 seat vs a field of A *on the same deals*. The
    paired difference of the two single-seat durak rates cancels the bias of
    being the odd one out. Returns {(A, B): {"z": combined, "per_n": {N: (dA, dB, z)}}}
    with z > 0 meaning A is stronger."""
    res = {}
    for i, a in enumerate(players):
        for b in players[i + 1:]:
            diffs, per_n = [], {}
            for n in NS:
                ka, kb = f"rr|{a}|{b}|{n}", f"rr|{b}|{a}|{n}"
                seed = 75000 + n + seed_offset
                for k, me, opp in ((ka, a, b), (kb, b, a)):
                    if k not in out:
                        out[k] = raw_match(me, "nn:" + opp, n, games, seed, workers, endgame="solve")
                        if save:
                            save()
                d = paired_diff(out[ka], out[kb], n)  # durak(A single) - durak(B single)
                diffs.append(d)
                per_n[n] = (out[ka]["durak"] / out[ka]["games"], out[kb]["durak"] / out[kb]["games"], d["z"])
            res[(a, b)] = {"z": combined_z(diffs), "per_n": per_n}
            print(f"RR {os.path.basename(a):<18} vs {os.path.basename(b):<18} z={res[(a, b)]['z']:+.2f}  " +
                  "  ".join(f"{n}p {x[0]:.3f}/{x[1]:.3f}" for n, x in per_n.items()), flush=True)
    return res


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ref", required=True, help="reference checkpoint (current champion)")
    ap.add_argument("--cands", nargs="+", required=True)
    ap.add_argument("--pop", nargs="*", default=[])
    ap.add_argument("--games-fixed", type=int, default=4800)
    ap.add_argument("--games-pop", type=int, default=1200)
    ap.add_argument("--games-h2h", type=int, default=2400)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--nice", type=int, default=10)
    ap.add_argument("--out", required=True)
    ap.add_argument("--only", nargs="*", help="restrict to these opponent names")
    ap.add_argument("--round-robin", nargs="*", help="also run a symmetric round-robin among these checkpoints")
    ap.add_argument("--games-rr", type=int, default=2400)
    ap.add_argument("--seed-offset", type=int, default=0, help="fresh deals (e.g. for a confirmation run)")
    args = ap.parse_args(argv)
    try:
        os.nice(args.nice)
    except OSError:
        pass
    specs = opponent_specs(args.ref, args.pop, args.games_fixed, args.games_pop, args.games_h2h, args.seed_offset)
    if args.only:
        specs = {k: v for k, v in specs.items() if k in args.only}
    results = {}
    if os.path.exists(args.out):
        results = json.load(open(args.out))
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    cands = [args.ref] + [c for c in args.cands if c != args.ref]
    for name, (opp, endgame, games, seed) in specs.items():
        for c in cands:
            if name == "h2h" and c == args.ref:
                continue
            for n in NS:
                key = f"{c}|{name}|{n}"
                if key in results:
                    continue
                t = time.time()
                results[key] = raw_match(c, opp, n, games, seed + n, args.workers, endgame=endgame)
                s = summarize(results[key], n)
                print(f"{os.path.basename(c):<16} {name:<22} N={n} durak={s['durak_rate']:.4f} "
                      f"[{s['ci_lo']:.4f},{s['ci_hi']:.4f}] games={s['games']} ({time.time() - t:.0f}s)", flush=True)
                with open(args.out + ".tmp", "w") as f:
                    json.dump(results, f)
                os.replace(args.out + ".tmp", args.out)
    rows = analyze(results, cands, args.ref, specs)
    print_table(rows, args.ref)
    if args.round_robin:
        def save():
            with open(args.out + ".tmp", "w") as f:
                json.dump(results, f)
            os.replace(args.out + ".tmp", args.out)

        rr = round_robin(args.round_robin, args.games_rr, args.workers, results, save, args.seed_offset)
        score = {p: 0.0 for p in args.round_robin}
        for (a, b), v in rr.items():
            score[a] += v["z"]
            score[b] -= v["z"]
        print("\nround-robin mean z per player:")
        for p, sc in sorted(score.items(), key=lambda x: -x[1]):
            print(f"  {os.path.basename(p):<20} {sc / (len(args.round_robin) - 1):+.2f}")


def print_table(rows: list[dict], ref: str) -> None:
    print("\nreference:", ref)
    for r in sorted(rows, key=lambda r: -(r.get("fixed_z") or -99)):
        name = os.path.basename(r["cand"])
        print(f"\n{name}: fixed_z vs ref = {r.get('fixed_z', float('nan')):+.2f} "
              f"(families {', '.join(f'{k} {v:+.2f}' for k, v in (r.get('family_z') or {}).items() if v is not None)})"
              f"  h2h_z vs ref = {r.get('h2h_z', float('nan')):+.2f}")
        for opp, v in r["opp"].items():
            cells = "  ".join(f"{n}p {x[0]:.3f}[{x[1]:.3f},{x[2]:.3f}]" for n, x in v["rates"].items())
            print(f"   {opp:<22} {cells}")


if __name__ == "__main__":
    main()
