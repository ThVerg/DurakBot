"""PIMC search (Perfect-Information Monte Carlo) over determinizations.

For the player to move: take the top policy candidates, sample ``n_det``
determinizations of the hidden cards (``game.determinize``), and play every
(candidate, determinization) pair to the end with the greedy policy for all
seats, batched across rollouts. Rollouts stop early with the exact solver result
once a small 2-player endgame is reached. The same determinizations are used
for every candidate (common random numbers), so the comparison is paired. The
score is the mean return of ``player`` plus a small policy prior bonus.
"""

from __future__ import annotations

import random
import time

import numpy as np
import torch

from ..engine import DurakGame
from .encoding import PublicTracker, build_batch, encode_parts, inverse_perm


def _copy_tracker(t: PublicTracker) -> PublicTracker:
    c = PublicTracker.__new__(PublicTracker)
    for k in PublicTracker.__slots__:
        v = getattr(t, k)
        setattr(c, k, v[:] if isinstance(v, list) else v)
    return c


def _solve_small(g: DurakGame, max_cards: int, nodes: int):
    if g.talon or g.num_players - len(g.finished) != 2:
        return None
    cards = sum(h.bit_count() for h in g.hands) + len(g.attack_cards) + len(g.defense_cards)
    if cards > max_cards:
        return None
    try:
        from .. import solver
    except ImportError:
        return None
    if not solver.applicable(g):
        return None
    a = g.active_players[0]
    res = solver.solve(g, a, time_limit=None, node_limit=nodes)
    if res is None:
        return None
    n = g.num_players
    if res[0] == 0:
        return (0.0,) * n
    loser = a if res[0] < 0 else g.active_players[1]
    return tuple(-1.0 if q == loser else 1.0 / (n - 1) for q in range(n))


def pimc_action(model, game: DurakGame, player: int, tracker: PublicTracker, probs: dict[int, float],
                n_det: int = 16, max_cands: int = 4, min_prob: float = 0.03, prior_w: float = 0.1,
                time_budget: float = 0.7, rng: random.Random | None = None, max_steps: int = 600):
    """Return (best action, {action: mean return}) or None if not worth searching."""
    rng = rng or random.Random()
    cands = sorted((a for a, p in probs.items() if p >= min_prob), key=lambda a: -probs[a])[:max_cands]
    if len(cands) < 2:
        return None
    t0 = time.perf_counter()
    dets = [game.determinize(player, rng) for _ in range(n_det)]
    sims = []  # [game, tracker, cand index, result]
    for d in dets:
        for ci, a in enumerate(cands):
            g = d.clone()
            tr = _copy_tracker(tracker)
            p = g.current_player
            g.step(a)
            tr.event(p, a)
            sims.append([g, tr, ci, None])
    live = list(range(len(sims)))
    steps = 0
    while live:
        if time.perf_counter() - t0 > time_budget:
            break
        pend = []
        nxt = []
        for i in live:
            g, tr, _, _ = sims[i]
            while True:
                if g.done:
                    sims[i][3] = g.returns()
                    break
                r = _solve_small(g, 8, 5000)
                if r is not None:
                    sims[i][3] = r
                    break
                legal = g.legal_mask_int()
                if legal & (legal - 1) == 0:
                    a = legal.bit_length() - 1
                    p = g.current_player
                    g.step(a)
                    tr.event(p, a)
                    continue
                pend.append(i)
                break
        if not pend:
            break
        parts = [encode_parts(sims[i][0], sims[i][0].current_player, sims[i][1]) for i in pend]
        obs, mask = build_batch(parts)
        with torch.inference_mode():
            logits, _, _ = model(torch.from_numpy(obs), torch.from_numpy(mask))
        acts = logits.argmax(-1).numpy()
        for j, i in enumerate(pend):
            g, tr = sims[i][0], sims[i][1]
            ca = int(acts[j])
            a = ca if ca == 36 else inverse_perm(parts[j][3])[ca // 9] * 9 + ca % 9
            p = g.current_player
            g.step(a)
            tr.event(p, a)
            if len(g.log) > max_steps + len(game.log):
                sims[i][3] = (0.0,) * g.num_players
            else:
                nxt.append(i)
        live = nxt
        steps += 1
    # only determinizations whose rollouts all finished, for a paired comparison
    k = len(cands)
    tot = np.zeros(k)
    cnt = 0
    for di in range(n_det):
        block = sims[di * k : (di + 1) * k]
        if all(s[3] is not None for s in block):
            for s in block:
                tot[s[2]] += s[3][player]
            cnt += 1
    if cnt == 0:
        return None
    means = tot / cnt
    score = {a: means[i] + prior_w * probs[a] for i, a in enumerate(cands)}
    best = max(score, key=score.get)
    return best, {a: float(means[i]) for i, a in enumerate(cands)}
