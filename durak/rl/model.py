"""Residual-MLP actor-critic with invalid-action masking and a belief head.

v2 (round 2) adds an auxiliary *belief head*: for each of the 36 (canonical)
cards, logits over 6 locations (opponent rel seat 1..5, talon). It is trained
with cross-entropy on ground truth from self-play (only for cards unseen by
the acting player), masked to feasible locations (those with unknown cards).
Its detached probabilities are projected back into the trunk
(``belief_features``) before the policy/value heads, and are used by PIMC
search to sample belief-weighted determinizations.

Older checkpoints (obs_dim 911, no belief head) still load and run: the
observation prefix is sliced to the model's ``obs_dim``.
"""

from __future__ import annotations

import torch
import torch.nn as nn
import torch.nn.functional as F

from .encoding import NUM_ACTIONS, NUM_CARDS, NUM_LOCS, OBS_DIM, P_UNSEEN, UNKNOWN_COL

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
    """forward(obs, mask) -> (logits [B,37] masked, value [B], durak_logit [B],
    belief_logits [B,36,6] or None)."""

    def __init__(self, obs_dim: int = OBS_DIM, hidden: int = 384, blocks: int = 3,
                 belief: bool = True, belief_features: bool = True):
        super().__init__()
        self.cfg = {"obs_dim": obs_dim, "hidden": hidden, "blocks": blocks,
                    "belief": belief, "belief_features": belief_features and belief}
        self.obs_dim = obs_dim
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
        self.has_belief = belief and obs_dim >= UNKNOWN_COL + NUM_LOCS
        if self.has_belief:
            self.bel = nn.Linear(hidden, NUM_CARDS * NUM_LOCS)
            nn.init.zeros_(self.bel.weight)
            nn.init.zeros_(self.bel.bias)
            if self.cfg["belief_features"]:
                self.bel_proj = nn.Linear(NUM_CARDS * NUM_LOCS, hidden)
                nn.init.zeros_(self.bel_proj.weight)  # starts as an identity change
                nn.init.zeros_(self.bel_proj.bias)

    def belief_masks(self, obs):
        """(card_valid [B,36] bool: unseen cards, loc_ok [B,6] bool: feasible locations)."""
        unseen = obs[:, P_UNSEEN * NUM_CARDS : (P_UNSEEN + 1) * NUM_CARDS] > 0.5
        loc_ok = obs[:, UNKNOWN_COL : UNKNOWN_COL + NUM_LOCS] > 1e-6
        return unseen, loc_ok

    def forward(self, obs, mask):
        if obs.shape[1] > self.obs_dim:
            obs_in = obs[:, : self.obs_dim]
        else:
            obs_in = obs
        h = self.ln(self.blocks(F.relu(self.inp(obs_in))))
        bel = None
        if self.has_belief:
            unseen, loc_ok = self.belief_masks(obs)
            bel = self.bel(h).view(-1, NUM_CARDS, NUM_LOCS).masked_fill(~loc_ok[:, None, :], NEG)
            if self.cfg["belief_features"]:
                p = torch.softmax(bel.detach(), -1) * unseen[..., None]
                h = h + self.bel_proj(p.flatten(1))  # zero-init: exact identity at transfer
        logits = self.pi(h).masked_fill(~mask, NEG)
        return logits, self.v(h).squeeze(-1), self.d(h).squeeze(-1), bel


def save_model(model: ActorCritic, path: str, **meta) -> None:
    import os

    tmp = f"{path}.tmp{os.getpid()}"
    torch.save({"cfg": model.cfg, "state_dict": model.state_dict(), **meta}, tmp)
    os.replace(tmp, path)


def build_model(cfg: dict) -> ActorCritic:
    cfg = dict(cfg)
    cfg.setdefault("belief", False)  # v1 checkpoints have no belief head
    cfg.setdefault("belief_features", False)
    return ActorCritic(**cfg)


def load_model(path: str, map_location="cpu") -> tuple[ActorCritic, dict]:
    ck = torch.load(path, map_location=map_location, weights_only=False)
    model = build_model(ck["cfg"])
    model.load_state_dict(ck["state_dict"])
    model.eval()
    meta = {k: v for k, v in ck.items() if k not in ("state_dict",)}
    return model, meta


def transfer(src_state: dict, dst: ActorCritic) -> list[str]:
    """Copy weights from an older model into ``dst``: equal shapes are copied,
    the input layer is zero-padded for appended observation columns, and new
    modules keep their (identity-preserving) init. Returns the copied keys."""
    dst_sd = dst.state_dict()
    done = []
    for k, v in src_state.items():
        if k not in dst_sd:
            continue
        t = dst_sd[k]
        if t.shape == v.shape:
            dst_sd[k] = v.clone()
            done.append(k)
        elif k == "inp.weight" and t.shape[0] == v.shape[0] and t.shape[1] > v.shape[1]:
            nw = torch.zeros_like(t)
            nw[:, : v.shape[1]] = v
            dst_sd[k] = nw
            done.append(k)
    dst.load_state_dict(dst_sd)
    return done
