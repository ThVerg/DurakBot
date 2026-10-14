"""Periodic evaluation + champion gating (run by the trainer in the background).

1. Evaluates the checkpoint (greedy policy, no search) vs random and, when
   available, the heuristic bot for N = 2..6.
2. Head-to-head vs the current ``checkpoints/champion.pt``: the challenger
   holds one seat, the champion all others. Per N the standardized score
   z = mean(1 - N*D) / sqrt((N-1)/games) is 0 at equal strength; the
   per-N scores are combined with the curriculum weights. If combined z >
   ``--threshold`` (or no champion exists) the checkpoint becomes champion,
   unless it is significantly worse than the champion against the heuristic
   (difference of the combined vs-heuristic z scores < -``--heur-tolerance``).

Results are appended to ``<run-dir>/eval.jsonl`` and TensorBoard (``tb/``).
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import time

from .evaluate import combined_z, fmt_row, run_match

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CHAMPION = os.path.join(ROOT, "checkpoints", "champion.pt")


def install_champion(ckpt: str, info: dict) -> None:
    os.makedirs(os.path.dirname(CHAMPION), exist_ok=True)
    tmp = CHAMPION + ".tmp"
    shutil.copyfile(ckpt, tmp)
    os.replace(tmp, CHAMPION)
    hist = os.path.join(os.path.dirname(CHAMPION), "champion_history.jsonl")
    with open(hist, "a") as f:
        f.write(json.dumps(info) + "\n")
    with open(os.path.join(os.path.dirname(CHAMPION), "champion.json"), "w") as f:
        json.dump(info, f, indent=1)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("ckpt")
    ap.add_argument("--run-dir", required=True)
    ap.add_argument("--games", type=int, default=600)
    ap.add_argument("--random-games", type=int, default=200)
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--threshold", type=float, default=1.28)
    ap.add_argument("--heur-tolerance", type=float, default=1.645,
                    help="reject if significantly worse than the champion vs the heuristic (z units)")
    ap.add_argument("--ns", nargs="+", type=int, default=[2, 3, 4, 5, 6])
    ap.add_argument("--no-gate", action="store_true")
    args = ap.parse_args(argv)
    try:
        os.nice(5)
    except OSError:
        pass
    from ..agents import available_agents
    import torch

    meta = torch.load(args.ckpt, map_location="cpu", weights_only=False)
    it = meta.get("version", 0)
    t0 = time.time()
    rec = {"ckpt": args.ckpt, "iter": it, "steps": meta.get("steps"), "time": time.strftime("%Y-%m-%d %H:%M:%S")}
    opps = [("random", args.random_games)]
    if "heuristic" in available_agents():
        opps.append(("heuristic", args.games))
    for opp, games in opps:
        rows = []
        for n in args.ns:
            r = run_match(args.ckpt, opp, n, games, 1000 + n, args.workers)
            rows.append(r)
            print(f"[it {it}] " + fmt_row(opp, r), flush=True)
            rec[f"{opp}_{n}p_durak"] = r["durak_rate"]
            rec[f"{opp}_{n}p_ci"] = [round(r["ci_lo"], 4), round(r["ci_hi"], 4)]
        rec[f"{opp}_z"] = combined_z(rows)
    gated = False
    if not args.no_gate:
        if not os.path.exists(CHAMPION):
            gated = True
            rec["vs_champion_z"] = None
        else:
            rows = []
            for n in args.ns:
                r = run_match(args.ckpt, "nn:" + CHAMPION, n, args.games, 5000 + n + it, args.workers)
                rows.append(r)
                print(f"[it {it}] " + fmt_row("champion", r), flush=True)
                rec[f"champ_{n}p_durak"] = r["durak_rate"]
            z = combined_z(rows)
            rec["vs_champion_z"] = z
            gated = z > args.threshold
            # robustness: must not be significantly worse than the champion vs the heuristic
            champ_info = {}
            try:
                champ_info = json.load(open(os.path.join(os.path.dirname(CHAMPION), "champion.json")))
            except (OSError, ValueError):
                pass
            if gated and "heuristic_z" in rec and "heuristic_z" in champ_info:
                d = (rec["heuristic_z"] - champ_info["heuristic_z"]) / 2 ** 0.5
                rec["heuristic_z_diff"] = d
                if d < -args.heur_tolerance:
                    gated = False
                    rec["rejected"] = "worse vs heuristic"

        if gated:
            install_champion(args.ckpt, rec)
    rec["promoted"] = gated
    rec["eval_sec"] = round(time.time() - t0, 1)
    print(f"[it {it}] promoted={gated} vs_champion_z={rec.get('vs_champion_z')} ({rec['eval_sec']}s)", flush=True)
    with open(os.path.join(args.run_dir, "eval.jsonl"), "a") as f:
        f.write(json.dumps(rec) + "\n")
    try:
        from torch.utils.tensorboard import SummaryWriter

        w = SummaryWriter(os.path.join(args.run_dir, "tb"))
        for k, v in rec.items():
            if isinstance(v, (int, float)) and not isinstance(v, bool) and k not in ("iter", "steps"):
                w.add_scalar("eval/" + k, v, it)
        w.add_scalar("eval/promoted", int(gated), it)
        w.close()
    except Exception:
        pass


if __name__ == "__main__":
    main()
