"""Self-play rollout worker (runs in its own process).

Each worker keeps many games in flight and batches NN inference across them.
Every seat of a game is controlled by either the learner (latest weights), a
past snapshot from the opponent pool, or a scripted bot (heuristic / solver /
random). Only decisions of learner seats with more than one legal action are
recorded. Per-seat terminal rewards come from ``game.returns()``; advantages
use GAE (gamma = 1) over that seat's own decisions.
"""

from __future__ import annotations

import glob
import os
import random
import time
import traceback

import numpy as np
import torch

from ..engine import DurakGame
from .encoding import NUM_PLANES, PublicTracker, build_batch, encode_parts, inverse_perm
from .model import load_model

LEARNER = "L"
MAX_GAME_STEPS = 2000  # games can cycle; truncate (value bootstrap)
DEFAULT_N_MIX = {2: 0.30, 3: 0.15, 4: 0.25, 5: 0.20, 6: 0.10}


_SOLVER = False


def _solver():
    global _SOLVER
    if _SOLVER is False:
        try:
            from .. import solver as sv

            _SOLVER = sv
        except ImportError:
            _SOLVER = None
    return _SOLVER


def sample_n(rng: random.Random, mix: dict[int, float]) -> int:
    r = rng.random() * sum(mix.values())
    for n, w in mix.items():
        r -= w
        if r <= 0:
            return n
    return n


def bot_factory(name: str):
    """Return an Agent factory for a scripted bot, or None if unavailable."""
    try:
        from ..agents import get_agent

        get_agent(name)  # probe
        return lambda: get_agent(name)
    except Exception:
        return None


def nn_policy(model, parts, greedy: bool, gen: torch.Generator | None = None):
    """Run the model on encoded parts. Returns (canon actions, logp, value, durak_logit) numpy."""
    obs, mask = build_batch(parts)
    with torch.inference_mode():
        logits, v, d = model(torch.from_numpy(obs), torch.from_numpy(mask))
        logp_all = torch.log_softmax(logits, -1)
        if greedy:
            a = logits.argmax(-1)
        else:
            a = torch.multinomial(logp_all.exp(), 1, generator=gen).squeeze(-1)
        lp = logp_all.gather(1, a[:, None]).squeeze(1)
    return a.numpy(), lp.numpy(), v.numpy(), d.numpy()


class Slot:
    __slots__ = ("game", "tracker", "ctrl", "agents", "traj", "n", "solved", "solve_cards", "solve_ok")

    def __init__(self):
        self.game = None


def gae(values: list[float], reward: float, lam: float) -> tuple[np.ndarray, np.ndarray]:
    T = len(values)
    v = np.asarray(values, dtype=np.float32)
    nxt = np.append(v[1:], np.float32(reward))
    delta = nxt - v
    adv = np.empty(T, dtype=np.float32)
    acc = 0.0
    for t in range(T - 1, -1, -1):
        acc = delta[t] + lam * acc
        adv[t] = acc
    return adv, adv + v


class RolloutWorker:
    def __init__(self, cfg: dict, worker_id: int):
        self.cfg = cfg
        self.wid = worker_id
        self.rng = random.Random(cfg["seed"] * 1000 + worker_id)
        self.gen = torch.Generator().manual_seed(cfg["seed"] * 1000 + worker_id)
        self.n_mix = {int(k): v for k, v in cfg.get("n_mix", DEFAULT_N_MIX).items()}
        self.model = None
        self.version = -1
        self.snapshots: dict[str, torch.nn.Module] = {}
        self.bots: dict[str, object] = {}
        self.last_bot_probe = 0.0
        self.out: list[dict] = []
        self.out_steps = 0
        self.stats = {"games": 0, "learner_steps": 0, "forced": 0, "total_steps": 0, "ret_vs": {}}

    # ----------------------------------------------------------- weights
    def maybe_reload(self) -> None:
        path = self.cfg["weights_path"]
        try:
            ver = int(open(path + ".version").read().strip())
        except (OSError, ValueError):
            return
        if ver != self.version:
            for _ in range(5):
                try:
                    self.model, meta = load_model(path)
                    self.version = meta.get("version", ver)
                    break
                except Exception:
                    time.sleep(0.2)

    def refresh_pool(self) -> None:
        files = sorted(glob.glob(os.path.join(self.cfg["pool_dir"], "*.pt")))
        k = self.cfg.get("snapshots_per_worker", 2)
        if not files:
            self.snapshots = {}
            return
        # bias towards recent snapshots: half from the last 5, half uniform
        chosen = set()
        for _ in range(k):
            if self.rng.random() < 0.5:
                chosen.add(self.rng.choice(files[-5:]))
            else:
                chosen.add(self.rng.choice(files))
        new = {}
        for f in chosen:
            if f in self.snapshots:
                new[f] = self.snapshots[f]
            else:
                try:
                    new[f], _ = load_model(f)
                except Exception:
                    pass
        self.snapshots = new

    def probe_bots(self) -> None:
        if time.time() - self.last_bot_probe < 300:
            return
        self.last_bot_probe = time.time()
        for name in self.cfg.get("bot_names", ["heuristic", "solver"]):
            if name not in self.bots:
                f = bot_factory(name)
                if f is not None:
                    self.bots[name] = f

    # ------------------------------------------------------------- games
    def new_game(self, slot: Slot) -> None:
        rng = self.rng
        n = sample_n(rng, self.n_mix)
        g = DurakGame(seed=rng.getrandbits(62), num_players=n)
        slot.game = g
        slot.n = n
        slot.tracker = PublicTracker(n, g.trump, g.attacker)
        ctrl = [LEARNER] * n
        slot.agents = {}
        if rng.random() >= self.cfg.get("selfplay_frac", 0.6):
            choices, weights = [], []
            if self.snapshots:
                choices.append("snap"); weights.append(self.cfg.get("w_snap", 0.6))
            heur = [b for b in self.bots]
            if heur:
                choices.append("bot"); weights.append(self.cfg.get("w_bot", 0.3))
            choices.append("random"); weights.append(self.cfg.get("w_random", 0.05))
            kind = rng.choices(choices, weights)[0]
            k = 1 if n == 2 else rng.randint(1, n - 1)
            seats = rng.sample(range(n), k)
            if kind == "snap":
                key = rng.choice(list(self.snapshots))
            elif kind == "bot":
                key = "bot:" + rng.choice(heur)
            else:
                key = "bot:random"
            for s in seats:
                ctrl[s] = key
                if key.startswith("bot:"):
                    name = key[4:]
                    if name == "random":
                        from ..agents import RandomAgent

                        ag = RandomAgent(rng.getrandbits(32))
                    else:
                        ag = self.bots[name]()
                    ag.reset()
                    slot.agents[s] = ag
        slot.ctrl = ctrl
        slot.traj = {p: ([], [], [], [], []) for p in range(n) if ctrl[p] == LEARNER}
        slot.solved = None
        slot.solve_cards = -1
        slot.solve_ok = rng.random() < self.cfg.get("solve_frac", 0.7)

    def finish_game(self, slot: Slot) -> None:
        g = slot.game
        if slot.solved is not None:  # exact endgame result
            rets, loser, truncated = slot.solved
        else:
            truncated = not g.done  # step cap hit: bootstrap from the value estimate
            rets, loser = g.returns(), g.loser
        lam = self.cfg.get("gae_lambda", 0.95)
        opp = next((c for c in slot.ctrl if c != LEARNER), "self")
        opp = "snap" if opp not in ("self",) and not opp.startswith("bot:") else opp
        for p, (planes, scal, legal, acts, extra) in slot.traj.items():
            if not acts:
                continue
            logp = [e[0] for e in extra]
            vals = [e[1] for e in extra]
            adv, ret = gae(vals, vals[-1] if truncated else rets[p], lam)
            T = len(acts)
            self.out.append(
                {
                    "planes": np.array(planes, dtype=np.uint64),
                    "scal": np.array(scal, dtype=np.float32),
                    "legal": np.array(legal, dtype=np.uint64),
                    "act": np.array(acts, dtype=np.int64),
                    "logp": np.array(logp, dtype=np.float32),
                    "val": np.array(vals, dtype=np.float32),
                    "adv": adv,
                    "ret": ret,
                    "durak": np.full(T, 1.0 if loser == p else 0.0, dtype=np.float32),
                    "n": np.full(T, slot.n, dtype=np.int8),
                }
            )
            self.out_steps += T
            if truncated:
                continue
            key = (slot.n, opp)
            s = self.stats["ret_vs"].setdefault(key, [0, 0.0, 0])
            s[0] += 1
            s[1] += rets[p]
            s[2] += 1 if loser == p else 0
        self.stats["games"] += 1
        self.stats["solved"] = self.stats.get("solved", 0) + int(slot.solved is not None)
        self.stats["truncated"] = self.stats.get("truncated", 0) + int(truncated)

    def try_solve(self, slot: Slot) -> None:
        """End the game early with the exact solver result once a small
        2-player perfect-information endgame is reached (as the champion
        plays it with the solver anyway). Retried only when the card count
        changes."""
        g = slot.game
        if g.talon or g.num_players - len(g.finished) != 2:
            return
        cards = sum(h.bit_count() for h in g.hands) + len(g.attack_cards) + len(g.defense_cards)
        if cards > self.cfg.get("solve_max_cards", 10) or cards == slot.solve_cards:
            return
        slot.solve_cards = cards
        sv = _solver()
        if sv is None or not sv.applicable(g):
            return
        a = g.active_players[0]
        res = sv.solve(g, a, time_limit=None, node_limit=self.cfg.get("solve_nodes", 30000))
        if res is None:
            return
        v = res[0]
        n = g.num_players
        if v == 0:
            slot.solved = ((0.0,) * n, None, False)
        else:
            loser = a if v < 0 else g.active_players[1]
            slot.solved = (tuple(-1.0 if q == loser else 1.0 / (n - 1) for q in range(n)), loser, False)

    def advance(self, slot: Slot):
        """Play forced / scripted moves until a NN decision is needed.
        Returns (ctrl_key, player, parts)."""
        while True:
            g = slot.game
            if g is not None and not g.done and slot.solve_ok:
                self.try_solve(slot)
            if g is None or g.done or len(g.log) > MAX_GAME_STEPS or slot.solved is not None:
                if g is not None:
                    self.finish_game(slot)
                self.new_game(slot)
                g = slot.game
            p = g.current_player
            legal = g.legal_mask_int()
            c = slot.ctrl[p]
            if legal & (legal - 1) == 0:  # exactly one legal action
                a = legal.bit_length() - 1
                self.stats["forced"] += 1
            elif c.startswith("bot:"):
                ag = slot.agents[p]
                view = g if c == "bot:random" else g.determinize(p, self.rng)
                a = ag.act(view, p)
            else:
                return c, p, encode_parts(g, p, slot.tracker)
            g.step(a)
            slot.tracker.event(p, a)
            self.stats["total_steps"] += 1

    def collect(self, min_steps: int) -> dict:
        """Run until at least ``min_steps`` learner decisions have finished games."""
        if not hasattr(self, "slots"):
            self.slots = [Slot() for _ in range(self.cfg.get("games_per_worker", 64))]
            self.pending = [None] * len(self.slots)
        while self.out_steps < min_steps:
            groups: dict[str, list[int]] = {}
            for i, slot in enumerate(self.slots):
                if self.pending[i] is None:
                    self.pending[i] = self.advance(slot)
                groups.setdefault(self.pending[i][0], []).append(i)
            for key, idxs in groups.items():
                model = self.model if key == LEARNER else self.snapshots.get(key)
                if model is None:  # snapshot evicted: let the learner play it
                    model = self.model
                parts = [self.pending[i][2] for i in idxs]
                acts, lps, vals, _ = nn_policy(model, parts, greedy=False, gen=self.gen)
                for j, i in enumerate(idxs):
                    slot = self.slots[i]
                    _, p, pr = self.pending[i]
                    ca = int(acts[j])
                    canon = pr[3]
                    a = ca if ca == 36 else inverse_perm(canon)[ca // 9] * 9 + ca % 9
                    if key == LEARNER and slot.ctrl[p] == LEARNER:
                        tr = slot.traj[p]
                        tr[0].append(pr[0])
                        tr[1].append(pr[1])
                        tr[2].append(pr[2])
                        tr[3].append(ca)
                        tr[4].append((float(lps[j]), float(vals[j])))
                        self.stats["learner_steps"] += 1
                    slot.game.step(a)
                    slot.tracker.event(p, a)
                    self.stats["total_steps"] += 1
                    self.pending[i] = None
        out = {k: np.concatenate([o[k] for o in self.out]) for k in self.out[0]}
        self.out, self.out_steps = [], 0
        return out


def worker_main(cfg: dict, worker_id: int, queue, credits, stop_event) -> None:
    torch.set_num_threads(1)
    try:
        os.nice(cfg.get("worker_nice", 0))
    except OSError:
        pass
    w = RolloutWorker(cfg, worker_id)
    chunk = cfg.get("chunk_steps", 2048)
    n_chunks = 0
    while not stop_event.is_set():
        if not credits.acquire(timeout=1.0):
            continue
        w.maybe_reload()
        while w.model is None and not stop_event.is_set():
            time.sleep(0.5)
            w.maybe_reload()
        if n_chunks % cfg.get("pool_refresh_chunks", 8) == 0:
            w.refresh_pool()
            w.probe_bots()
        t0 = time.time()
        try:
            data = w.collect(chunk)
        except Exception:
            traceback.print_exc()
            raise
        stats = w.stats
        w.stats = {"games": 0, "learner_steps": 0, "forced": 0, "total_steps": 0, "ret_vs": {}}
        queue.put({"data": data, "version": w.version, "stats": stats, "time": time.time() - t0, "wid": worker_id})
        n_chunks += 1
