"""ONNX export of the champion network (scripts/export_onnx.py): onnxruntime
matches torch on real positions, also for a small v1-style network without a
belief head, and the browser assets are consistent."""

import importlib.util
import json
import os

import pytest

pytest.importorskip("onnx")
pytest.importorskip("onnxruntime")
torch = pytest.importorskip("torch")

from durak.rl.model import ActorCritic, save_model  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHAMP = os.path.join(ROOT, "checkpoints", "champion.pt")
WEB_AI = os.path.join(ROOT, "web", "public", "ai")


def _exporter():
    spec = importlib.util.spec_from_file_location("export_onnx", os.path.join(ROOT, "scripts", "export_onnx.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.mark.parametrize("kind", ["champion", "v1"])
def test_export_matches_torch(tmp_path, kind):
    ex = _exporter()
    from durak.rl.model import load_model

    if kind == "champion" and os.path.exists(CHAMP):
        model, _ = load_model(CHAMP)
    else:  # small network without belief head (obs prefix of 911)
        p = tmp_path / "v1.pt"
        torch.manual_seed(0)
        save_model(ActorCritic(obs_dim=911, hidden=64, blocks=1, belief=False), str(p), version=1)
        model, _ = load_model(str(p))
    out = str(tmp_path / "m.onnx")
    names = ex.export(model, out)
    assert names[:3] == ["logits", "value", "durak"]
    assert ("belief" in names) == model.has_belief
    res = ex.check(model, out, n_pos=400, tol=1e-4, seed=3)
    assert res["ok"], res
    assert res["argmax_agreement"] == 1.0


def test_browser_assets_consistent():
    meta_path = os.path.join(WEB_AI, "champion.json")
    if not os.path.exists(meta_path):
        pytest.skip("browser model not exported")
    meta = json.load(open(meta_path))
    onnx_path = os.path.join(WEB_AI, "champion.onnx")
    assert os.path.getsize(onnx_path) == meta["bytes"]
    assert _exporter().sha256(onnx_path) == meta["sha256"]
    assert meta["parity"]["ok"]
    assert os.path.exists(os.path.join(WEB_AI, "solver.wasm"))
