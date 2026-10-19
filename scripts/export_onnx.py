"""Export the champion network to ONNX for in-browser inference.

    .venv/bin/python scripts/export_onnx.py                 # export + parity check
    .venv/bin/python scripts/export_onnx.py --check 8000    # more check positions
    .venv/bin/python scripts/export_onnx.py --check-only    # re-check an existing export

Graph inputs / outputs (batch dimension ``B`` is dynamic):

* ``obs``   float32 [B, OBS_DIM]  observation from ``durak.rl.encoding``
* ``mask``  float32 [B, 37]       legal actions (canonical), 1 = legal
* ``logits`` float32 [B, 37]      policy logits, illegal actions = -1e9
* ``value``  float32 [B]          expected ``returns()`` of the acting seat
* ``durak``  float32 [B]          durak logit (P(durak) = sigmoid)
* ``belief`` float32 [B, 36, 6]   belief-head probabilities per canonical card over
                                  (opponent rel seat 1..5, talon); only on v2 networks

The parity check plays games with the heuristic, random and the policy itself
for every N, encodes thousands of real positions and compares onnxruntime with
torch. It fails (exit code 1) if any output differs by more than ``--tol``.
Next to the model it writes ``champion.json`` with the version metadata.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import random
import shutil
import sys
import tempfile
import time

import numpy as np
import torch
import torch.nn as nn

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from durak.agents.heuristic import HeuristicAgent  # noqa: E402
from durak.engine import DurakGame  # noqa: E402
from durak.rl.encoding import OBS_DIM, PublicTracker, build_batch, encode_parts, inverse_perm  # noqa: E402
from durak.rl.model import load_model  # noqa: E402

OPSET = 17


class ExportWrapper(nn.Module):
    """ActorCritic with a float mask input and belief probabilities as output."""

    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, obs, mask):
        logits, v, d, bel = self.model(obs, mask > 0.5)
        if bel is None:
            return logits, v, d
        return logits, v, d, torch.softmax(bel, -1)


def export(model, out_path: str) -> list[str]:
    wrapper = ExportWrapper(model).eval()
    has_belief = model.has_belief
    outputs = ["logits", "value", "durak"] + (["belief"] if has_belief else [])
    obs = torch.zeros(4, OBS_DIM, dtype=torch.float32)
    mask = torch.ones(4, 37, dtype=torch.float32)
    dyn = {"obs": {0: "B"}, "mask": {0: "B"}}
    for name in outputs:
        dyn[name] = {0: "B"}
    tmp = out_path + ".tmp"
    torch.onnx.export(wrapper, (obs, mask), tmp, input_names=["obs", "mask"], output_names=outputs,
                      dynamic_axes=dyn, opset_version=OPSET, do_constant_folding=True, dynamo=False)
    import onnx

    m = onnx.load(tmp)
    onnx.checker.check_model(m)
    m.producer_name = "durakbot"
    onnx.save(m, tmp)
    os.replace(tmp, out_path)
    return outputs


# ------------------------------------------------------------- positions
def sample_positions(model, n_target: int, seed: int = 0):
    """Encoded positions (parts) from real games: every seat is played by the
    heuristic, random or the greedy policy; N cycles over 2..6."""
    rng = random.Random(seed)
    heur = HeuristicAgent()
    parts_all = []
    game_i = 0
    while len(parts_all) < n_target:
        n = 2 + game_i % 5
        game = DurakGame(seed=rng.randrange(1 << 30), num_players=n)
        kinds = [rng.choice(["heuristic", "policy", "policy", "random"]) for _ in range(n)]
        tracker = PublicTracker.from_game(game)
        steps = 0
        while not game.done and steps < 3000:
            p = game.current_player
            parts = encode_parts(game, p, tracker)
            legal = game.legal_actions()
            if len(legal) > 1 and rng.random() < 0.35:
                parts_all.append(parts)
            # an observation for a non-acting seat too (legal mask empty)
            if rng.random() < 0.05:
                q = rng.randrange(n)
                if q != p and game.is_active(q):
                    parts_all.append(encode_parts(game, q, tracker))
            kind = kinds[p]
            if len(legal) == 1:
                a = legal[0]
            elif kind == "random":
                a = rng.choice(legal)
            elif kind == "heuristic":
                a = heur.act(game.determinize(p, rng), p)
            else:
                obs, mask = build_batch([parts])
                with torch.inference_mode():
                    logits = model(torch.from_numpy(obs), torch.from_numpy(mask))[0][0].numpy()
                ca = int(np.argmax(logits))
                a = ca if ca == 36 else inverse_perm(parts[3])[ca // 9] * 9 + ca % 9
            game.step(a)
            tracker.sync(game)
            steps += 1
        game_i += 1
    return parts_all[:n_target]


def check(model, onnx_path: str, n_pos: int, tol: float, seed: int = 0, batch: int = 256) -> dict:
    import onnxruntime as ort

    so = ort.SessionOptions()
    so.intra_op_num_threads = 2
    so.inter_op_num_threads = 1
    sess = ort.InferenceSession(onnx_path, so, providers=["CPUExecutionProvider"])
    t0 = time.time()
    parts = sample_positions(model, n_pos, seed)
    gen_s = time.time() - t0
    worst = {}
    argmax_agree = 0
    total = 0
    for i in range(0, len(parts), batch):
        obs, mask = build_batch(parts[i : i + batch])
        with torch.inference_mode():
            t_out = model(torch.from_numpy(obs), torch.from_numpy(mask))
        t_logits, t_v, t_d, t_bel = (x.numpy() if x is not None else None for x in t_out)
        if t_bel is not None:
            t_bel = torch.softmax(torch.from_numpy(t_bel), -1).numpy()
        o = sess.run(None, {"obs": obs, "mask": mask.astype(np.float32)})
        pairs = {"logits": (t_logits, o[0]), "value": (t_v, o[1]), "durak": (t_d, o[2])}
        if t_bel is not None:
            pairs["belief"] = (t_bel, o[3])
        legal = mask
        for k, (a, b) in pairs.items():
            if k == "logits":
                diff = np.abs(np.where(legal, a - b, 0.0)).max()
                assert np.all(np.where(legal, True, (a == b))), "masked logits differ"
            else:
                diff = float(np.abs(a - b).max())
            worst[k] = max(worst.get(k, 0.0), float(diff))
        has_legal = legal.any(1)
        argmax_agree += int((t_logits.argmax(1) == o[0].argmax(1))[has_legal].sum())
        total += int(has_legal.sum())
    ok = all(v <= tol for v in worst.values())
    return {"positions": len(parts), "max_abs_diff": worst, "argmax_agreement": argmax_agree / max(total, 1),
            "positions_with_legal_moves": total, "tol": tol, "ok": ok, "gen_seconds": round(gen_s, 1)}


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ckpt", default=os.path.join(ROOT, "checkpoints", "champion.pt"))
    ap.add_argument("--out", default=os.path.join(ROOT, "web", "public", "ai", "champion.onnx"))
    ap.add_argument("--check", type=int, default=4000, help="parity-check positions (0 = skip)")
    ap.add_argument("--tol", type=float, default=1e-4)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--check-only", action="store_true")
    args = ap.parse_args()
    torch.set_num_threads(2)

    out = os.path.abspath(args.out)
    meta_path = os.path.splitext(out)[0] + ".json"
    os.makedirs(os.path.dirname(out), exist_ok=True)

    # Snapshot the checkpoint first: a trainer may replace it at any moment.
    with tempfile.TemporaryDirectory() as td:
        snap = os.path.join(td, "ckpt.pt")
        shutil.copyfile(args.ckpt, snap)
        model, meta = load_model(snap)
        ck_sha = sha256(snap)

    if not args.check_only:
        outputs = export(model, out)
        print(f"exported {out} ({os.path.getsize(out) / 1e6:.2f} MB), outputs {outputs}")
    res = None
    if args.check > 0:
        res = check(model, out, args.check, args.tol, args.seed)
        print(json.dumps(res, indent=1))
    if not args.check_only:
        cfg = model.cfg
        info = {
            "format": 1,
            "version": int(meta.get("version", 0)),
            "steps": int(meta.get("steps", 0)),
            "obs_dim": int(cfg["obs_dim"]),
            "hidden": int(cfg["hidden"]),
            "blocks": int(cfg["blocks"]),
            "belief": bool(model.has_belief),
            "inputs": ["obs", "mask"],
            "outputs": ["logits", "value", "durak"] + (["belief"] if model.has_belief else []),
            "opset": OPSET,
            "bytes": os.path.getsize(out),
            "sha256": sha256(out),
            "checkpoint_sha256": ck_sha,
            "exported": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        }
        summ = os.path.join(ROOT, "checkpoints", "champion.json")
        if os.path.exists(summ):
            try:
                info["iteration"] = int(json.load(open(summ)).get("iter", info["version"]))
            except Exception:
                pass
        info.setdefault("iteration", info["version"])
        if res is not None:
            info["parity"] = {k: res[k] for k in ("positions", "max_abs_diff", "argmax_agreement", "ok")}
        with open(meta_path, "w") as f:
            json.dump(info, f, indent=1)
            f.write("\n")
        print(f"wrote {meta_path}")
    return 0 if (res is None or res["ok"]) else 1


if __name__ == "__main__":
    sys.exit(main())
