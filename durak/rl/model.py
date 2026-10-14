"""Residual-MLP actor-critic with invalid-action masking."""

from __future__ import annotations

import torch
import torch.nn as nn
import torch.nn.functional as F

from .encoding import NUM_ACTIONS, OBS_DIM

NEG = -1e9


class ResBlock(nn.Module):
    def __init__(self, h: int):
        super().__init__()
        self.ln = nn.LayerNorm(h)
        self.fc1 = nn.Linear(h, h)
        self.fc2 = nn.Linear(h, h)

    def forward(self, x):
        return x + self.fc2(F.relu(self.fc1(self.ln(x))))


class ActorCritic(nn.Module):
    """Outputs masked policy logits [B,37], value [B] (expected return of the
    acting seat) and durak logit [B] (log-odds of ending as the durak)."""

    def __init__(self, obs_dim: int = OBS_DIM, hidden: int = 512, blocks: int = 3):
        super().__init__()
        self.cfg = {"obs_dim": obs_dim, "hidden": hidden, "blocks": blocks}
        self.inp = nn.Linear(obs_dim, hidden)
        self.blocks = nn.Sequential(*[ResBlock(hidden) for _ in range(blocks)])
        self.ln = nn.LayerNorm(hidden)
        self.pi = nn.Linear(hidden, NUM_ACTIONS)
        self.v = nn.Linear(hidden, 1)
        self.d = nn.Linear(hidden, 1)
        nn.init.orthogonal_(self.pi.weight, gain=0.01)
        nn.init.zeros_(self.pi.bias)
        nn.init.orthogonal_(self.v.weight, gain=0.1)
        nn.init.zeros_(self.v.bias)

    def forward(self, obs, mask):
        h = self.ln(self.blocks(F.relu(self.inp(obs))))
        logits = self.pi(h).masked_fill(~mask, NEG)
        return logits, self.v(h).squeeze(-1), self.d(h).squeeze(-1)


def save_model(model: ActorCritic, path: str, **meta) -> None:
    import os

    tmp = f"{path}.tmp{os.getpid()}"
    torch.save({"cfg": model.cfg, "state_dict": model.state_dict(), **meta}, tmp)
    os.replace(tmp, path)


def load_model(path: str, map_location="cpu") -> tuple[ActorCritic, dict]:
    ck = torch.load(path, map_location=map_location, weights_only=False)
    model = ActorCritic(**ck["cfg"])
    model.load_state_dict(ck["state_dict"])
    model.eval()
    meta = {k: v for k, v in ck.items() if k not in ("state_dict",)}
    return model, meta
