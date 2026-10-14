"""PIMC search (Perfect-Information Monte Carlo) over determinizations.

For the player to move: take the top policy candidates, sample ``n_det``
determinizations of the hidden cards and evaluate every (candidate,
determinization) pair; the same determinizations are used for every candidate
(common random numbers), so the comparison is paired. Score = mean return of
``player`` + ``prior_w`` * policy prior.

Determinizations are uniform (``game.determinize``) or *belief-weighted*:
sampled card by card from the belief head's location probabilities under the
exact per-location card counts.

Evaluation of a pair:

* ``mode="rollout"``: play to the end with the greedy policy for every seat
  (batched across rollouts), ending early with the exact solver once a small
  2-player endgame is reached.
* ``mode="value"``: play greedily until ``depth`` more bouts have ended and it
  is ``player``'s turn again (or the game ends / is solved), then use the value
  head at that decision of ``player`` (cheap enough for 3-6 players).
"""

from __future__ import annotations

import random
import time

import numpy as np
import torch

from ..cards import mask_to_list
from ..engine import DurakGame
from .encoding import PublicTracker, build_batch, encode_parts, inverse_perm
from .rollout import solve_small


def _copy_tracker(t: PublicTracker) -> PublicTracker:
    c = PublicTracker.__new__(PublicTracker)
    for k in PublicTracker.__slots__:
        v = getattr(t, k)
        setattr(c, k, v[:] if isinstance(v, list) else v)
    return c


def belief_determinize(game: DurakGame, player: int, probs: np.ndarray, rng: random.Random) -> DurakGame:
    """Sample hidden cards from belief ``probs`` [36 real cards, 6 locations:
    opponent rel seat 1..5, talon] subject to the exact unknown-card counts."""
    n = game.num_players
    g = game.clone()
    pool = mask_to_list(game.unseen_mask(player))
    rng.shuffle(pool)
    cap = [0] * 6
    for k in range(1, n):
        q = (player + k) % n
        cap[k - 1] = game.hands[q].bit_count() - game.known[q].bit_count()
    cap[5] = len(game.talon) - 1 if game.talon else 0
    assign = [0] * 6
    talon_cards = []
    for c in pool:
        w = [probs[c, l] if cap[l] > 0 else 0.0 for l in range(6)]
        tot = sum(w)
        if tot <= 1e-12:
            w = [float(cap[l] > 0) for l in range(6)]
            tot = sum(w)
        r = rng.random() * tot
        loc = 5
        for l in range(6):
            r -= w[l]
            if r <= 0 and w[l] > 0:
                loc = l
                break
        if cap[loc] <= 0:  # numerical edge: first location with room
            loc = next(l for l in range(6) if cap[l] > 0)
        cap[loc] -= 1
        if loc == 5:
            talon_cards.append(c)
        else:
            assign[loc] |= 1 << c
    for k in range(1, n):
        q = (player + k) % n
        g.hands[q] = game.known[q] | assign[k - 1]
    if game.talon:
        rng.shuffle(talon_cards)
        g.talon = [game.trump_card] + talon_cards
    return g


def pimc_action(model, game: DurakGame, player: int, tracker: PublicTracker, probs: dict[int, float],
                n_det: int = 16, max_cands: int = 4, min_prob: float = 0.03, prior_w: float = 0.1,
                time_budget: float = 0.7, rng: random.Random | None = None, max_steps: int = 600,
                belief: np.ndarray | None = None, mode: str = "rollout", depth: int = 2):
    """Return (best action, {action: mean return}) or None if not worth searching."""
    rng = rng or random.Random()
    cands = sorted((a for a, p in probs.items() if p >= min_prob), key=lambda a: -probs[a])[:max_cands]
    if len(cands) < 2:
        return None
    t0 = time.perf_counter()
    if belief is not None:
        dets = [belief_determinize(game, player, belief, rng) for _ in range(n_det)]
    else:
        dets = [game.determinize(player, rng) for _ in range(n_det)]
    base_bouts = game.bout_index
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
    while live:
        if time.perf_counter() - t0 > time_budget:
            break
        pend, leaf = [], []
        for i in live:
            g, tr, _, _ = sims[i]
            while True:
                if g.done:
                    sims[i][3] = g.returns()[player]
                    break
                r = solve_small(g, 10, 5000)
                if r is not None:
                    sims[i][3] = r[0][player]
                    break
                if g.is_active(player) is False:
                    # out of the game (not durak): exact payoff known
                    sims[i][3] = 1.0 / (g.num_players - 1)
                    break
                legal = g.legal_mask_int()
                if legal & (legal - 1) == 0:
                    a = legal.bit_length() - 1
                    p = g.current_player
                    g.step(a)
                    tr.event(p, a)
                    continue
                if mode == "value" and g.current_player == player and g.bout_index - base_bouts >= depth:
                    leaf.append(i)
                else:
                    pend.append(i)
                break
        nxt = []
        if leaf:
            parts = [encode_parts(sims[i][0], player, sims[i][1]) for i in leaf]
            obs, mask = build_batch(parts)
            with torch.inference_mode():
                _, v, _, _ = model(torch.from_numpy(obs), torch.from_numpy(mask))
            for j, i in enumerate(leaf):
                sims[i][3] = float(v[j])
        if pend:
            parts = [encode_parts(sims[i][0], sims[i][0].current_player, sims[i][1]) for i in pend]
            obs, mask = build_batch(parts)
            with torch.inference_mode():
                logits, _, _, _ = model(torch.from_numpy(obs), torch.from_numpy(mask))
            acts = logits.argmax(-1).numpy()
            for j, i in enumerate(pend):
                g, tr = sims[i][0], sims[i][1]
                ca = int(acts[j])
                a = ca if ca == 36 else inverse_perm(parts[j][3])[ca // 9] * 9 + ca % 9
                p = g.current_player
                g.step(a)
                tr.event(p, a)
                if len(g.log) > max_steps + len(game.log):
                    sims[i][3] = 0.0
                else:
                    nxt.append(i)
        live = nxt
    # paired comparison over determinizations whose evaluations all finished
    k = len(cands)
    tot = np.zeros(k)
    cnt = 0
    for di in range(n_det):
        block = sims[di * k : (di + 1) * k]
        if all(s[3] is not None for s in block):
            for s in block:
                tot[s[2]] += s[3]
            cnt += 1
    if cnt == 0:
        return None
    means = tot / cnt
    score = {a: means[i] + prior_w * probs[a] for i, a in enumerate(cands)}
    best = max(score, key=score.get)
    return best, {a: float(means[i]) for i, a in enumerate(cands)}
