"""Periodic evaluation suite + champion gating (run by the trainer in the background).

Suite (per N = 2..6, paired deals, deal-clustered 95% CIs; durak rate of the
checkpoint's seat, baseline 1/N):

* ``random``    - greedy policy, played out.
* ``heuristic`` - greedy policy + exact endgame solver for our seat (as deployed).
* ``solver``    - heuristic opponents, and every solvable 2-player endgame
  (<= 16 cards) ends with its exact value: both sides play endgames perfectly,
  emulating the ``solver`` bot cheaply.
* ``champion``  - head-to-head vs ``checkpoints/champion.pt`` (both perfect in endgames).
* anchors       - frozen past checkpoints (``--anchors``), the regression dashboard:
  unlike the bots they never change, so drifts are real.

Promotion: combined head-to-head z (curriculum-weighted over N) > ``--threshold``
AND not significantly worse than the champion vs heuristic and vs solver
(difference of combined z < -``--tolerance``).

Outputs: ``<run>/eval.jsonl`` (one record per evaluation), TensorBoard
``eval/*``, ``checkpoints/champion.pt`` + ``champion.json`` +
``champion_history.jsonl`` on promotion, and ``runs/eval_summary.json``
(latest per-N results of the current champion; see :func:`write_summary`).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import shutil
import time

from .evaluate import combined_z, fmt_row, run_match

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CHAMPION = os.path.join(ROOT, "checkpoints", "champion.pt")
CHAMP_JSON = os.path.join(ROOT, "checkpoints", "champion.json")
SUMMARY = os.path.join(ROOT, "runs", "eval_summary.json")
SUITE_VERSION = 2

# name -> (opponent spec, endgame mode, games key)
SUITE = {
    "random": ("random", "none", "random_games"),
    "heuristic": ("heuristic", "me", "games"),
    "solver": ("heuristic", "solve", "games"),
}


def install_champion(ckpt: str, info: dict) -> None:
    os.makedirs(os.path.dirname(CHAMPION), exist_ok=True)
    tmp = CHAMPION + ".tmp"
    shutil.copyfile(ckpt, tmp)
    os.replace(tmp, CHAMPION)
    with open(os.path.join(os.path.dirname(CHAMPION), "champion_history.jsonl"), "a") as f:
        f.write(json.dumps(info) + "\n")
    with open(CHAMP_JSON + ".tmp", "w") as f:
        json.dump(info, f, indent=1)
    os.replace(CHAMP_JSON + ".tmp", CHAMP_JSON)


def write_summary(rec: dict) -> None:
    """``runs/eval_summary.json``: {"updated", "iteration", "ckpt", "suite_version",
    "results": {opp: {"<N>": {"rate", "ci": [lo, hi], "games"}}}} for the champion."""
    res = {}
    for key, val in rec.items():
        if key.endswith("p_durak") and not key.startswith("champ_"):
            opp, n = key[: -len("p_durak")].rsplit("_", 1)
            res.setdefault(opp, {})[n] = {
                "rate": round(val, 4),
                "ci": rec.get(f"{opp}_{n}p_ci"),
                "games": rec.get(f"{opp}_{n}p_games"),
            }
    out = {
        "updated": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "iteration": rec.get("iter"),
        "ckpt": rec.get("ckpt"),
        "suite_version": SUITE_VERSION,
        "notes": {
            "random": "greedy policy, played out",
            "heuristic": "policy + exact endgame solver for our seat (as deployed, without PIMC)",
            "solver": "vs heuristic with every solvable 2-player endgame scored exactly "
                      "(both sides perfect in endgames = the solver bot)",
        },
        "results": res,
    }
    os.makedirs(os.path.dirname(SUMMARY), exist_ok=True)
    with open(SUMMARY + ".tmp", "w") as f:
        json.dump(out, f, indent=1)
    os.replace(SUMMARY + ".tmp", SUMMARY)


def evaluate_suite(ckpt: str, args, rec: dict, it: int) -> None:
    for name, (opp, endgame, gkey) in SUITE.items():
        games = getattr(args, gkey)
        rows = []
        for n in args.ns:
            r = run_match(ckpt, opp, n, games, 1000 + 17 * n, args.workers, endgame=endgame)
            rows.append(r)
            print(f"[it {it}] {name:<9} " + fmt_row(opp, r), flush=True)
            rec[f"{name}_{n}p_durak"] = r["durak_rate"]
            rec[f"{name}_{n}p_ci"] = [round(r["ci_lo"], 4), round(r["ci_hi"], 4)]
            rec[f"{name}_{n}p_games"] = r["games"]
        rec[f"{name}_z"] = combined_z(rows)
    for a in args.anchors:
        if not os.path.exists(a):
            continue
        an = "anchor:" + os.path.splitext(os.path.basename(a))[0]
        rows = []
        for n in args.ns:
            r = run_match(ckpt, "nn:" + a, n, args.anchor_games, 3000 + n, args.workers, endgame="solve")
            rows.append(r)
            print(f"[it {it}] {an} " + fmt_row("anchor", r), flush=True)
            rec[f"{an}_{n}p_durak"] = r["durak_rate"]
            rec[f"{an}_{n}p_ci"] = [round(r["ci_lo"], 4), round(r["ci_hi"], 4)]
            rec[f"{an}_{n}p_games"] = r["games"]
        rec[f"{an}_z"] = combined_z(rows)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("ckpt")
    ap.add_argument("--run-dir", required=True)
    ap.add_argument("--games", type=int, default=600)
    ap.add_argument("--random-games", type=int, default=200)
    ap.add_argument("--anchor-games", type=int, default=300)
    ap.add_argument("--anchors", nargs="*", default=[os.path.join(ROOT, "checkpoints", f"frozen_it{i}.pt")
                                                     for i in (200, 667)])
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--threshold", type=float, default=1.28)
    ap.add_argument("--tolerance", type=float, default=1.645,
                    help="reject if significantly worse than the champion vs heuristic/solver (z units)")
    ap.add_argument("--ns", nargs="+", type=int, default=[2, 3, 4, 5, 6])
    ap.add_argument("--no-gate", action="store_true")
    ap.add_argument("--summary-only", action="store_true",
                    help="evaluate the given checkpoint as the current champion: refresh "
                         "champion.json / eval_summary.json without a head-to-head")
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
    evaluate_suite(args.ckpt, args, rec, it)

    if args.summary_only:
        info = {}
        try:
            info = json.load(open(CHAMP_JSON))
        except (OSError, ValueError):
            pass
        info.update(rec)
        with open(CHAMP_JSON + ".tmp", "w") as f:
            json.dump(info, f, indent=1)
        os.replace(CHAMP_JSON + ".tmp", CHAMP_JSON)
        write_summary(rec)
        print(json.dumps({k: v for k, v in rec.items() if k.endswith("_z")}), flush=True)
        return

    gated = False
    if not args.no_gate:
        if not os.path.exists(CHAMPION):
            gated = True
            rec["vs_champion_z"] = None
        else:
            rows = []
            for n in args.ns:
                r = run_match(args.ckpt, "nn:" + CHAMPION, n, args.games, 5000 + n + it, args.workers,
                              endgame="solve")
                rows.append(r)
                print(f"[it {it}] " + fmt_row("champion", r), flush=True)
                rec[f"champ_{n}p_durak"] = r["durak_rate"]
                rec[f"champ_{n}p_ci"] = [round(r["ci_lo"], 4), round(r["ci_hi"], 4)]
            z = combined_z(rows)
            rec["vs_champion_z"] = z
            gated = z > args.threshold
            champ = {}
            try:
                champ = json.load(open(CHAMP_JSON))
            except (OSError, ValueError):
                pass
            for name in ("heuristic", "solver"):
                if champ.get("suite_version") == SUITE_VERSION and f"{name}_z" in champ:
                    d = (rec[f"{name}_z"] - champ[f"{name}_z"]) / 2 ** 0.5
                    rec[f"{name}_z_diff"] = d
                    if gated and d < -args.tolerance:
                        gated = False
                        rec["rejected"] = f"worse vs {name}"
        if gated:
            install_champion(args.ckpt, rec)
            write_summary(rec)
    rec["promoted"] = gated
    rec["eval_sec"] = round(time.time() - t0, 1)
    print(f"[it {it}] promoted={gated} vs_champion_z={rec.get('vs_champion_z')} "
          f"{rec.get('rejected', '')} ({rec['eval_sec']}s)", flush=True)
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
