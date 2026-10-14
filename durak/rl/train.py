"""Asynchronous PPO self-play trainer.

Process layout: ``--workers`` rollout processes (1 torch thread each) produce
chunks of finished learner trajectories into a queue; the learner process
(``--learner-threads``) consumes ``--batch-steps`` decisions per iteration,
runs PPO and publishes new weights (``runs/<name>/weights.pt``). A credit
semaphore keeps workers at most ~one batch ahead, so data is at most one or
two policy versions stale (PPO uses the behaviour log-probs, so that's fine).

Every ``--eval-every`` iterations a checkpoint is evaluated in a background
process (``durak.rl.gate``) which also gates ``checkpoints/champion.pt``.

Resumable: rerunning with the same ``--name`` continues from ``state.pt``.
"""

from __future__ import annotations

import argparse
import csv
import glob
import json
import multiprocessing as mp
import os
import shutil
import signal
import subprocess
import sys
import time

import numpy as np
import torch
import torch.nn.functional as F

from .encoding import NUM_ACTIONS, NUM_CARDS, NUM_LOCS, NUM_PLANES, OBS_DIM, UNKNOWN_COL, masks_to_bits
from .model import ActorCritic, build_model, load_model, save_model, transfer
from .rollout import DEFAULT_N_MIX, worker_main

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def parse_args(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="main")
    ap.add_argument("--workers", type=int, default=7)
    ap.add_argument("--learner-threads", type=int, default=4)
    ap.add_argument("--games-per-worker", type=int, default=64)
    ap.add_argument("--chunk-steps", type=int, default=2048)
    ap.add_argument("--batch-steps", type=int, default=32768)
    ap.add_argument("--minibatch", type=int, default=4096)
    ap.add_argument("--epochs", type=int, default=1)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--lr-final", type=float, default=1e-4)
    ap.add_argument("--lr-decay-iters", type=int, default=20000)
    ap.add_argument("--clip", type=float, default=0.2)
    ap.add_argument("--vf-coef", type=float, default=0.5)
    ap.add_argument("--durak-coef", type=float, default=0.25)
    ap.add_argument("--ent", type=float, default=0.01)
    ap.add_argument("--ent-final", type=float, default=0.003)
    ap.add_argument("--ent-decay-iters", type=int, default=5000)
    ap.add_argument("--target-kl", type=float, default=0.03)
    ap.add_argument("--max-grad-norm", type=float, default=0.5)
    ap.add_argument("--gae-lambda", type=float, default=0.95)
    ap.add_argument("--hidden", type=int, default=384)
    ap.add_argument("--blocks", type=int, default=3)
    ap.add_argument("--selfplay-frac", type=float, default=0.5)
    ap.add_argument("--w-snap", type=float, default=0.5)
    ap.add_argument("--w-bot", type=float, default=0.5)
    ap.add_argument("--w-random", type=float, default=0.02)
    ap.add_argument("--pfsp-power", type=float, default=2.0, help="league: weight = hardness**power")
    ap.add_argument("--snapshots-per-worker", type=int, default=3)
    ap.add_argument("--league-decay", type=float, default=0.995, help="per-iteration decay of league stats")
    ap.add_argument("--belief-coef", type=float, default=0.5)
    ap.add_argument("--no-belief", action="store_true", help="no belief head (A/B baseline)")
    ap.add_argument("--no-belief-features", action="store_true", help="belief head as aux loss only")
    ap.add_argument("--gate-args", default="", help="extra args for durak.rl.gate")
    ap.add_argument("--solve-frac", type=float, default=0.7, help="fraction of games ended by the exact endgame solver")
    ap.add_argument("--solve-max-cards", type=int, default=12)
    ap.add_argument("--bots", nargs="*", default=["heuristic"], help="scripted opponents used in training if registered")
    ap.add_argument("--snapshot-every", type=int, default=25)
    ap.add_argument("--pool-size", type=int, default=40)
    ap.add_argument("--ckpt-every", type=int, default=25)
    ap.add_argument("--eval-every", type=int, default=100)
    ap.add_argument("--eval-games", type=int, default=600)
    ap.add_argument("--eval-workers", type=int, default=2)
    ap.add_argument("--max-iters", type=int, default=10**9)
    ap.add_argument("--max-hours", type=float, default=1e9)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--init", help="initialise weights from this checkpoint (new runs only; older "
                    "architectures are transferred: input layer zero-padded, new heads fresh)")
    ap.add_argument("--no-gate", action="store_true", help="evaluate only; never touch champion.pt")
    return ap.parse_args(argv)


class Logger:
    def __init__(self, run_dir: str):
        self.path = os.path.join(run_dir, "train.csv")
        self.fields = None
        try:
            from torch.utils.tensorboard import SummaryWriter

            self.tb = SummaryWriter(os.path.join(run_dir, "tb"))
        except Exception:
            self.tb = None

    def log(self, row: dict, step: int):
        if self.fields is None:
            extra = [f"durak_{n}p_vs_{o}" for o in ("heuristic", "solver", "snap", "random") for n in range(2, 7)]
            extra += [f"frac_{n}p" for n in range(2, 7)]
            fields = list(row) + [k for k in extra if k not in row]
            if os.path.exists(self.path):
                with open(self.path) as f:
                    header = f.readline().strip().split(",")
                self.fields = header if header and header[0] else fields
            else:
                self.fields = fields
                with open(self.path, "w") as f:
                    f.write(",".join(self.fields) + "\n")
        new_keys = [k for k in row if k not in self.fields]
        if new_keys:  # schema grew (e.g. resumed with newer code): rewrite with the wider header
            with open(self.path) as f:
                old_rows = list(csv.DictReader(f))
            self.fields = self.fields + new_keys
            with open(self.path, "w", newline="") as f:
                w = csv.DictWriter(f, self.fields, extrasaction="ignore")
                w.writeheader()
                w.writerows(old_rows)
        with open(self.path, "a", newline="") as f:
            csv.DictWriter(f, self.fields, extrasaction="ignore").writerow(row)
        if self.tb is not None:
            for k, v in row.items():
                if isinstance(v, (int, float)) and k not in ("iter",):
                    self.tb.add_scalar(k, v, step)
            self.tb.flush()


def to_tensors(chunks: list[dict]):
    data = {k: np.concatenate([c[k] for c in chunks]) for k in chunks[0]}
    b = len(data["act"])
    obs = np.empty((b, OBS_DIM), dtype=np.float32)
    obs[:, : NUM_PLANES * NUM_CARDS] = masks_to_bits(data["planes"], NUM_CARDS).reshape(b, -1)
    obs[:, NUM_PLANES * NUM_CARDS :] = data["scal"]
    mask = masks_to_bits(data["legal"], NUM_ACTIONS).astype(bool)
    t = {
        "obs": torch.from_numpy(obs),
        "mask": torch.from_numpy(mask),
        "act": torch.from_numpy(data["act"]),
        "logp": torch.from_numpy(data["logp"]),
        "val": torch.from_numpy(data["val"]),
        "adv": torch.from_numpy(data["adv"]),
        "ret": torch.from_numpy(data["ret"]),
        "durak": torch.from_numpy(data["durak"]),
    }
    if "bel" in data:
        t["bel"] = torch.from_numpy(data["bel"].astype(np.int64))  # [B,6] masks (fit in 36 bits)
    return t, data["n"]


_BIT = torch.arange(NUM_CARDS, dtype=torch.int64)
_LOC_SCALE = torch.tensor([6.0, 6, 6, 6, 6, 24])


def belief_loss(bel_logits, bel_masks, obs):
    """Cross-entropy of the belief head over unseen cards, and the CE of the
    count-proportional prior (= what a uniform determinization assumes)."""
    onehot = ((bel_masks[:, :, None] >> _BIT) & 1).transpose(1, 2).float()  # [B,36,6]
    valid = onehot.sum(-1) > 0
    logp = torch.log_softmax(bel_logits, -1)
    ce = -(logp * onehot).sum(-1)[valid].mean()
    with torch.no_grad():
        cnt = obs[:, UNKNOWN_COL : UNKNOWN_COL + NUM_LOCS] * _LOC_SCALE
        prior = (cnt / cnt.sum(-1, keepdim=True).clamp(min=1e-6)).clamp(min=1e-6)
        ce0 = -(torch.log(prior)[:, None, :] * onehot).sum(-1)[valid].mean()
        acc = ((logp.argmax(-1) == onehot.argmax(-1)) & valid).sum() / valid.sum()
    return ce, ce0.item(), acc.item()


def ppo_update(model, opt, t: dict, args, ent_coef: float, lr: float):
    for g in opt.param_groups:
        g["lr"] = lr
    b = len(t["act"])
    stats = {"pg_loss": 0.0, "v_loss": 0.0, "d_loss": 0.0, "entropy": 0.0, "kl": 0.0, "clipfrac": 0.0,
             "bel_loss": 0.0, "bel_prior_loss": 0.0, "bel_acc": 0.0}
    use_bel = model.has_belief and "bel" in t and args.belief_coef > 0
    nmb = 0
    stop = False
    for ep in range(args.epochs):
        perm = torch.randperm(b)
        ep_kl = []
        for s in range(0, b, args.minibatch):
            idx = perm[s : s + args.minibatch]
            if len(idx) < args.minibatch // 4:
                continue
            obs, mask, act = t["obs"][idx], t["mask"][idx], t["act"][idx]
            old_lp, adv, ret, dur = t["logp"][idx], t["adv"][idx], t["ret"][idx], t["durak"][idx]
            adv = (adv - adv.mean()) / (adv.std() + 1e-8)
            logits, v, d, bel = model(obs, mask)
            logp_all = torch.log_softmax(logits, -1)
            lp = logp_all.gather(1, act[:, None]).squeeze(1)
            p_all = logp_all.exp()
            ent = -(p_all * logp_all.masked_fill(~mask, 0.0)).sum(-1).mean()
            ratio = (lp - old_lp).exp()
            pg = -torch.min(ratio * adv, ratio.clamp(1 - args.clip, 1 + args.clip) * adv).mean()
            vl = F.mse_loss(v, ret)
            dl = F.binary_cross_entropy_with_logits(d, dur)
            loss = pg + args.vf_coef * vl + args.durak_coef * dl - ent_coef * ent
            if use_bel:
                bl, bl0, bacc = belief_loss(bel, t["bel"][idx], obs)
                loss = loss + args.belief_coef * bl
                stats["bel_loss"] += bl.item()
                stats["bel_prior_loss"] += bl0
                stats["bel_acc"] += bacc
            opt.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), args.max_grad_norm)
            opt.step()
            with torch.no_grad():
                kl = ((ratio - 1) - (lp - old_lp)).mean().item()
                cf = ((ratio - 1).abs() > args.clip).float().mean().item()
            ep_kl.append(kl)
            for k, val in (("pg_loss", pg.item()), ("v_loss", vl.item()), ("d_loss", dl.item()),
                           ("entropy", ent.item()), ("kl", kl), ("clipfrac", cf)):
                stats[k] += val
            nmb += 1
            if kl > 1.5 * args.target_kl:
                stop = True
                break
        if stop:
            break
    for k in stats:
        stats[k] /= max(nmb, 1)
    stats["bel_gain"] = stats["bel_prior_loss"] - stats["bel_loss"] if use_bel else 0.0
    stats["epochs_done"] = ep + 1
    stats["kl_stop"] = int(stop)
    with torch.no_grad():
        y, v = t["ret"], t["val"]
        stats["explained_var"] = float(1 - (y - v).var() / (y.var() + 1e-8))
    return stats


def main(argv=None):
    args = parse_args(argv)
    run_dir = os.path.join(ROOT, "runs", args.name)
    pool_dir = os.path.join(run_dir, "pool")
    ckpt_dir = os.path.join(run_dir, "ckpt")
    for d in (run_dir, pool_dir, ckpt_dir):
        os.makedirs(d, exist_ok=True)
    torch.set_num_threads(args.learner_threads)
    torch.manual_seed(args.seed)
    state_path = os.path.join(run_dir, "state.pt")
    weights_path = os.path.join(run_dir, "weights.pt")

    def fresh():
        return ActorCritic(hidden=args.hidden, blocks=args.blocks, belief=not args.no_belief,
                           belief_features=not args.no_belief_features)

    model = fresh()
    opt = torch.optim.Adam(model.parameters(), lr=args.lr, eps=1e-5)
    it, total_steps, total_games, elapsed0 = 0, 0, 0, 0.0
    if os.path.exists(state_path):
        st = torch.load(state_path, map_location="cpu", weights_only=False)
        it, total_steps, total_games = st["iter"], st["total_steps"], st["total_games"]
        elapsed0 = st.get("elapsed", 0.0)
        if st["cfg"] == model.cfg:
            model.load_state_dict(st["state_dict"])
            opt = torch.optim.Adam(model.parameters(), lr=args.lr, eps=1e-5)
            opt.load_state_dict(st["opt"])
            print(f"resumed {run_dir} at iter {it}, {total_steps} steps", flush=True)
        else:  # architecture upgrade: transfer weights, fresh optimizer
            keys = transfer(st["state_dict"], model)
            opt = torch.optim.Adam(model.parameters(), lr=args.lr, eps=1e-5)
            print(f"resumed {run_dir} at iter {it} with UPGRADE {st['cfg']} -> {model.cfg} "
                  f"({len(keys)} tensors transferred)", flush=True)
    elif args.init:
        m0, _ = load_model(args.init)
        if m0.cfg == model.cfg:
            model = m0
        else:
            keys = transfer(m0.state_dict(), model)
            print(f"transferred {len(keys)} tensors {m0.cfg} -> {model.cfg}", flush=True)
        opt = torch.optim.Adam(model.parameters(), lr=args.lr, eps=1e-5)
        print(f"initialised from {args.init}", flush=True)
    with open(os.path.join(run_dir, "config.json"), "w") as f:
        json.dump(vars(args), f, indent=1)
    model.train()

    def publish():
        save_model(model, weights_path, version=it)
        with open(weights_path + ".version.tmp", "w") as f:
            f.write(str(it))
        os.replace(weights_path + ".version.tmp", weights_path + ".version")

    def save_state():
        tmp = state_path + ".tmp"
        torch.save({"cfg": model.cfg, "state_dict": model.state_dict(), "opt": opt.state_dict(), "iter": it,
                    "total_steps": total_steps, "total_games": total_games,
                    "elapsed": elapsed0 + time.time() - t_start}, tmp)
        os.replace(tmp, state_path)

    league_path = os.path.join(run_dir, "league.json")
    league = {}
    try:
        league = json.load(open(league_path)).get("snapshots", {})
    except (OSError, ValueError):
        pass

    def write_league():
        tmp = league_path + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"iter": it, "snapshots": league}, f)
        os.replace(tmp, league_path)

    publish()
    if not glob.glob(os.path.join(pool_dir, "*.pt")):
        save_model(model, os.path.join(pool_dir, f"it{it:06d}.pt"), version=it)

    cfg = {
        "seed": args.seed * 7 + it, "weights_path": weights_path, "pool_dir": pool_dir,
        "games_per_worker": args.games_per_worker, "chunk_steps": args.chunk_steps,
        "selfplay_frac": args.selfplay_frac, "w_snap": args.w_snap, "w_bot": args.w_bot,
        "w_random": args.w_random, "gae_lambda": args.gae_lambda, "n_mix": DEFAULT_N_MIX,
        "solve_frac": args.solve_frac, "solve_max_cards": args.solve_max_cards, "bot_names": args.bots,
        "league_path": league_path, "pfsp_power": args.pfsp_power,
        "snapshots_per_worker": args.snapshots_per_worker,
    }
    ctx = mp.get_context("spawn")
    queue = ctx.Queue(maxsize=4 * args.workers)
    chunks_per_batch = max(1, args.batch_steps // args.chunk_steps)
    credits = ctx.Semaphore(2 * chunks_per_batch)
    stop = ctx.Event()
    procs = [ctx.Process(target=worker_main, args=(cfg, i, queue, credits, stop), daemon=True)
             for i in range(args.workers)]
    for p in procs:
        p.start()

    def handle_sig(signum, frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, handle_sig)
    logger = Logger(run_dir)
    eval_proc = None
    t_start = time.time()
    last_t = time.time()
    try:
        while it < args.max_iters and (elapsed0 + time.time() - t_start) / 3600 < args.max_hours:
            chunks, stats_list, n_steps, stale, dropped = [], [], 0, [], 0
            t_wait = time.time()
            while n_steps < args.batch_steps:
                msg = queue.get()
                credits.release()
                if msg["version"] < it - 2:
                    dropped += 1
                    continue
                chunks.append(msg["data"])
                stats_list.append(msg["stats"])
                stale.append(it - msg["version"])
                n_steps += len(msg["data"]["act"])
            for p in procs:
                if not p.is_alive():
                    raise RuntimeError(f"worker {p.pid} died (exit {p.exitcode})")
            t_wait = time.time() - t_wait
            t_upd = time.time()
            t, ns = to_tensors(chunks)
            frac = min(1.0, it / max(1, args.ent_decay_iters))
            ent_coef = args.ent + (args.ent_final - args.ent) * frac
            lfrac = min(1.0, it / max(1, args.lr_decay_iters))
            lr = args.lr + (args.lr_final - args.lr) * lfrac
            st = ppo_update(model, opt, t, args, ent_coef, lr)
            t_upd = time.time() - t_upd
            it += 1
            publish()
            total_steps += n_steps
            games = sum(s["games"] for s in stats_list)
            total_games += games
            now = time.time()
            row = {
                "iter": it, "steps": total_steps, "games": total_games,
                "hours": round((elapsed0 + now - t_start) / 3600, 4),
                "sps": n_steps / (now - last_t), "wait_s": t_wait, "update_s": t_upd,
                "stale": float(np.mean(stale)), "dropped": dropped, "lr": lr, "ent_coef": ent_coef,
                "solved_frac": sum(s.get("solved", 0) for s in stats_list) / max(1, games),
                "truncated": sum(s.get("truncated", 0) for s in stats_list),
                "draw_frac": sum(s.get("draws", 0) for s in stats_list) / max(1, games),
                "forced_frac": sum(s["forced"] for s in stats_list) / max(1, sum(s["total_steps"] for s in stats_list)),
                **st,
            }
            last_t = now
            # returns by (N, opponent type) for learner seats
            agg = {}
            for s in stats_list:
                for (n, opp), (c, r, d) in s["ret_vs"].items():
                    a = agg.setdefault((n, opp), [0, 0.0, 0])
                    a[0] += c; a[1] += r; a[2] += d
            for (n, opp), (c, r, d) in sorted(agg.items()):
                if opp != "self" and c >= 20:
                    row[f"durak_{n}p_vs_{opp.replace('bot:', '')}"] = d / c
            for n in range(2, 7):
                m = ns == n
                if m.any():
                    row[f"frac_{n}p"] = float(m.mean())
            # league (PFSP) stats with exponential decay
            for k in list(league):
                for f in ("games", "durak", "base"):
                    league[k][f] *= args.league_decay
            for s in stats_list:
                for name, (c, d, b) in s.get("league", {}).items():
                    e = league.setdefault(name, {"games": 0.0, "durak": 0.0, "base": 0.0})
                    e["games"] += c; e["durak"] += d; e["base"] += b
            pool_names = {os.path.basename(f) for f in glob.glob(os.path.join(pool_dir, "*.pt"))}
            for k in list(league):
                if not k.startswith("bot:") and k not in pool_names:
                    del league[k]
            write_league()
            hard = [(e["durak"] + 2) / (e["base"] + 2) for k, e in league.items() if not k.startswith("bot:")]
            row["league_size"] = len(hard)
            row["league_max_hardness"] = max(hard) if hard else 0.0
            if "bot:heuristic" in league:
                e = league["bot:heuristic"]
                row["league_heuristic_hardness"] = (e["durak"] + 2) / (e["base"] + 2)
            logger.log(row, it)
            print(
                f"it {it} steps {total_steps} sps {row['sps']:.0f} upd {t_upd:.1f}s wait {t_wait:.1f}s "
                f"ent {st['entropy']:.3f} kl {st['kl']:.4f} cf {st['clipfrac']:.3f} ev {st['explained_var']:.3f} "
                f"vl {st['v_loss']:.3f} bel {st['bel_loss']:.3f} (gain {st['bel_gain']:.3f}) stale {row['stale']:.2f}",
                flush=True,
            )
            if it % args.snapshot_every == 0:
                save_model(model, os.path.join(pool_dir, f"it{it:06d}.pt"), version=it)
                pool = sorted(glob.glob(os.path.join(pool_dir, "*.pt")))
                # keep the newest pool_size, but thin out old ones (keep every 4th)
                if len(pool) > args.pool_size:
                    old = pool[: -args.pool_size // 2]
                    for i, f in enumerate(old):
                        if i % 4 != 0:
                            os.remove(f)
            if it % args.ckpt_every == 0:
                save_state()
                save_model(model, os.path.join(ckpt_dir, "latest.pt"), version=it, steps=total_steps)
            if it % args.eval_every == 0:
                ck = os.path.join(ckpt_dir, f"it{it:06d}.pt")
                save_model(model, ck, version=it, steps=total_steps)
                if eval_proc is None or eval_proc.poll() is not None:
                    cmd = [sys.executable, "-m", "durak.rl.gate", ck, "--run-dir", run_dir,
                           "--games", str(args.eval_games), "--workers", str(args.eval_workers)]
                    if args.no_gate:
                        cmd.append("--no-gate")
                    cmd += args.gate_args.split()
                    eval_proc = subprocess.Popen(cmd, cwd=ROOT, stdout=open(os.path.join(run_dir, "eval.log"), "a"),
                                                 stderr=subprocess.STDOUT)
    except KeyboardInterrupt:
        print("interrupted; saving", flush=True)
    finally:
        save_state()
        save_model(model, os.path.join(ckpt_dir, "latest.pt"), version=it, steps=total_steps)
        stop.set()
        for p in procs:
            p.join(timeout=5)
            if p.is_alive():
                p.terminate()
        print(f"saved at iter {it}", flush=True)


if __name__ == "__main__":
    main()
