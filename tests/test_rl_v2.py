"""Round-2 RL pieces: belief targets/head, belief determinization, v1->v2 transfer,
backward-compatible loading, league weighting, evaluation statistics."""

import random

import numpy as np
import torch

from durak.cards import FULL_MASK, mask_to_list
from durak.engine import DurakGame
from durak.rl.encoding import (
    NUM_LOCS,
    OBS_DIM,
    OBS_DIM_V1,
    UNKNOWN_COL,
    PublicTracker,
    belief_targets,
    build_batch,
    encode,
    encode_parts,
    inverse_perm,
    remap_mask,
)
from durak.rl.evaluate import summarize
from durak.rl.model import ActorCritic, build_model, load_model, save_model, transfer
from durak.rl.rollout import pfsp_weight
from durak.rl.search import belief_determinize


def states(n, games=6, seed=0):
    rng = random.Random(seed * 10 + n)
    for _ in range(games):
        g = DurakGame(seed=rng.getrandbits(40), num_players=n)
        t = PublicTracker(n, g.trump, g.attacker)
        while not g.done:
            yield g, t, rng
            p = g.current_player
            a = rng.choice(g.legal_actions())
            g.step(a)
            t.event(p, a)


def test_belief_targets_partition_unseen():
    for n in (2, 3, 5, 6):
        for i, (g, t, _) in enumerate(states(n)):
            if i % 7:
                continue
            p = g.current_player
            _, _, _, canon = encode_parts(g, p, t)
            tg = belief_targets(g, p, canon)
            inv = inverse_perm(canon)
            real = [remap_mask(m, inv) for m in tg]
            union = 0
            for k, m in enumerate(real):
                assert union & m == 0
                union |= m
                if k < 5 and m:
                    assert m & ~g.hands[(p + k + 1) % n] == 0
            assert union == g.unseen_mask(p)
            if real[5]:
                assert set(mask_to_list(real[5])) <= set(g.talon)


def test_unknown_count_scalars():
    for g, t, _ in states(4, games=3):
        p = g.current_player
        obs, _, _ = encode(g, p, t)
        cnt = np.round(obs[UNKNOWN_COL : UNKNOWN_COL + NUM_LOCS] * [6, 6, 6, 6, 6, 24]).astype(int)
        for k in range(1, 4):
            q = (p + k) % 4
            assert cnt[k - 1] == g.hands[q].bit_count() - g.known[q].bit_count()
        assert cnt[5] == max(len(g.talon) - 1, 0)
        assert cnt.sum() == g.unseen_mask(p).bit_count()


def test_belief_determinize_consistent():
    probs = np.random.default_rng(0).random((36, 6))
    for n in (2, 4, 6):
        for i, (g, t, rng) in enumerate(states(n, games=4, seed=1)):
            if i % 9:
                continue
            p = g.current_player
            h = belief_determinize(g, p, probs, rng)
            assert h.hands[p] == g.hands[p]
            assert [x.bit_count() for x in h.hands] == [x.bit_count() for x in g.hands]
            assert len(h.talon) == len(g.talon)
            for q in range(n):
                assert h.known[q] & ~h.hands[q] == 0
            allc = h.discard | h.table_mask | (sum(1 << c for c in h.talon))
            for x in h.hands:
                allc |= x
            assert allc == FULL_MASK
            if g.talon:
                assert h.talon[0] == g.trump_card
            o1, _, _ = encode(g, p, PublicTracker.from_game(g))
            o2, _, _ = encode(h, p, PublicTracker.from_game(h))
            assert np.array_equal(o1, o2)


def test_transfer_v1_to_v2_preserves_function():
    torch.manual_seed(0)
    v1 = ActorCritic(obs_dim=OBS_DIM_V1, hidden=32, blocks=1, belief=False)
    with torch.no_grad():
        for prm in v1.parameters():
            prm.add_(torch.randn_like(prm) * 0.1)
    v2 = ActorCritic(obs_dim=OBS_DIM, hidden=32, blocks=1, belief=True)
    transfer(v1.state_dict(), v2)
    g = DurakGame(seed=3, num_players=3)
    parts = [encode_parts(g, g.current_player, PublicTracker.from_game(g))]
    obs, mask = build_batch(parts)
    o, m = torch.from_numpy(obs), torch.from_numpy(mask)
    l1, va1, d1, b1 = v1(o, m)
    l2, va2, d2, b2 = v2(o, m)
    assert b1 is None and b2.shape == (1, 36, 6)
    assert torch.allclose(l1, l2, atol=1e-4) and torch.allclose(va1, va2, atol=1e-4)


def test_v1_checkpoint_loads(tmp_path):
    v1 = ActorCritic(obs_dim=OBS_DIM_V1, hidden=16, blocks=1, belief=False)
    cfg = {"obs_dim": OBS_DIM_V1, "hidden": 16, "blocks": 1}  # v1 cfg had no belief keys
    torch.save({"cfg": cfg, "state_dict": {k: v for k, v in v1.state_dict().items()}}, tmp_path / "v1.pt")
    m, _ = load_model(str(tmp_path / "v1.pt"))
    obs = torch.zeros(2, OBS_DIM)
    out = m(obs, torch.ones(2, 37, dtype=torch.bool))
    assert out[0].shape == (2, 37) and out[3] is None


def test_belief_head_masks_infeasible():
    m = ActorCritic(hidden=16, blocks=1)
    with torch.no_grad():
        m.bel.bias.normal_()
    g = DurakGame(seed=4, num_players=2)
    obs, mask = build_batch([encode_parts(g, g.current_player, PublicTracker.from_game(g))])
    _, _, _, bel = m(torch.from_numpy(obs), torch.from_numpy(mask))
    p = torch.softmax(bel[0], -1)
    # 2 players: only rel seat 1 and the talon can hold unseen cards
    assert torch.all(p[:, 1:5] < 1e-6)


def test_pfsp_weight_orders_by_hardness():
    easy = {"games": 100, "durak": 5, "base": 50}
    hard = {"games": 100, "durak": 80, "base": 50}
    assert pfsp_weight(hard, 2) > pfsp_weight(None, 2) > pfsp_weight(easy, 2)


def test_summarize_clustered_ci():
    deals = {f"s:{i}": [i % 2, 2] for i in range(200)}  # 2p: 1 durak per odd deal
    tot = {"games": 400, "durak": 100, "draws": 0, "ret": 0.0, "ret2": 0.0, "deals": deals}
    r = summarize(tot, 2)
    assert abs(r["durak_rate"] - 0.25) < 1e-9 and r["ci_lo"] < 0.25 < r["ci_hi"] and r["z"] > 0
