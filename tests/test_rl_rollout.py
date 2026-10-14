"""Rollout worker data consistency and GAE."""

import numpy as np
import torch

from durak.rl.model import ActorCritic, save_model
from durak.rl.rollout import RolloutWorker, gae


def test_gae_terminal_only():
    adv, ret = gae([0.0, 0.0, 0.0], 1.0, lam=1.0)
    assert np.allclose(adv, [1, 1, 1]) and np.allclose(ret, [1, 1, 1])
    adv, ret = gae([0.5, 0.2], -1.0, lam=0.0)
    assert np.allclose(adv, [-0.3, -1.2]) and np.allclose(ret, [0.2, -1.0])


def test_worker_collect(tmp_path):
    torch.set_num_threads(1)
    w_path = str(tmp_path / "w.pt")
    save_model(ActorCritic(hidden=64, blocks=1), w_path, version=3)
    (tmp_path / "w.pt.version").write_text("3")
    w = RolloutWorker({"seed": 0, "weights_path": w_path, "pool_dir": str(tmp_path / "pool"),
                       "games_per_worker": 8, "selfplay_frac": 0.5, "bot_names": []}, 0)
    w.maybe_reload()
    out = w.collect(600)
    T = len(out["act"])
    assert T >= 600
    for k, v in out.items():
        assert len(v) == T, k
    legal = out["legal"]
    act = out["act"]
    assert all((int(legal[i]) >> int(act[i])) & 1 for i in range(T))
    # recorded decisions are never forced moves
    assert all(bin(int(x)).count("1") >= 2 for x in legal)
    assert np.all(out["logp"] <= 0)
    assert set(np.unique(out["n"])) <= {2, 3, 4, 5, 6}
    assert np.all((out["durak"] == 0) | (out["durak"] == 1))
