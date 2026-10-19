"""Gate v3: paired comparisons, decision rule, running champion estimate."""

import json
import math
import os

import pytest

import durak.rl.gate as G
from durak.rl.evaluate import paired_diff, raw_match
from durak.rl.model import ActorCritic, save_model


def _tot(deals: dict) -> dict:
    games = sum(e[1] for e in deals.values())
    decided = sum(e[2] if len(e) > 2 else e[1] for e in deals.values())
    return {"games": games, "durak": sum(e[0] for e in deals.values()),
            "draws": games - decided, "ret": 0.0, "ret2": 0.0, "deals": deals}


def test_paired_diff_identical_and_shifted():
    a = _tot({f"s:{i}": [i % 2, 2] for i in range(100)})
    r = paired_diff(a, a, 2)
    assert r["diff"] == 0 and r["z"] == 0
    b = _tot({f"s:{i}": [1, 2] for i in range(100)})  # b loses every other game more
    r = paired_diff(a, b, 2)
    assert r["diff"] < 0 and r["z"] > 3  # a better
    with pytest.raises(ValueError):
        paired_diff(a, _tot({"x:1": [0, 2]}), 2)


def test_draw_corrected_z():
    from durak.rl.evaluate import summarize

    # 2p, 10% draws, our seat loses exactly half of the decided games: equal strength
    deals = {f"s:{i}": [9 if i % 2 else 9, 20, 18] for i in range(100)}
    r = summarize(_tot(deals), 2)
    assert r["durak_rate"] == pytest.approx(0.45) and abs(r["z"]) < 1e-6
    assert r["fair_baseline"] == pytest.approx(0.45) and r["baseline"] == 0.5
    # the old 1/N baseline would have called this z >> 0; legacy 2-element deals still work
    legacy = summarize(_tot({f"s:{i}": [1, 2] for i in range(50)}), 2)
    assert legacy["durak_rate"] == 0.5


def test_same_seed_same_deals():
    m = ActorCritic(hidden=16, blocks=1)
    a = raw_match("random", "random", 3, 30, 5, 1)
    b = raw_match("random", "random", 3, 30, 5, 1)
    assert set(a["deals"]) == set(b["deals"]) and a["games"] == 30


def test_family_and_fixed_z():
    rows = lambda z: [{"N": n, "z": z} for n in (2, 3, 4, 5, 6)]
    fz = G.family_zs({"heuristic": rows(1.0), "solver": rows(1.0), "anchor:a": rows(2.0), "anchor:b": rows(0.0)})
    assert set(fz) == {"heuristic", "solver", "population"}
    assert fz["population"] == pytest.approx(G.combined_z(rows(2.0)) / math.sqrt(2))
    assert G.fixed_z(fz) == pytest.approx(sum(fz.values()) / math.sqrt(3))


def test_decide_rule():
    good = {"heuristic": 2.0, "solver": 2.0, "population": 2.0}
    meh = {"heuristic": 0.5, "solver": 0.3, "population": 0.1}
    bad_h = {"heuristic": -3.0, "solver": 4.0, "population": 4.0}
    # h2h must be positive, stage 1 must pass the screen
    assert G.decide(-0.5, good, None) == (False, False, "h2h z -0.50 <= 0.0")
    assert G.decide(2.0, meh, None)[:2] == (False, False)
    assert G.decide(2.0, good, None)[:2] == (True, False)  # needs confirmation
    assert G.decide(2.0, good, meh)[:2] == (True, False)  # not confirmed
    assert G.decide(2.0, good, good) == (True, True, "confirmed")
    # a family significantly worse (pooled over both stages) blocks promotion
    p, ok, why = G.decide(2.0, bad_h, bad_h)
    assert p and not ok and "worse vs heuristic" in why
    # no stored champion value is used anywhere: the rule only sees this gate's measurements
    assert G.decide(5.0, good, good, threshold=10)[1] is False


def test_gate_end_to_end(tmp_path, monkeypatch):
    ck = tmp_path / "ck"
    run = tmp_path / "run"
    ck.mkdir()
    run.mkdir()
    for name, seed in (("champ", 0), ("cand", 1), ("pop", 2)):
        import torch

        torch.manual_seed(seed)
        save_model(ActorCritic(hidden=16, blocks=1), str(ck / f"{name}.pt"), version=seed * 100)
    import shutil

    shutil.copy(ck / "champ.pt", ck / "champion.pt")
    (ck / "champion.json").write_text(json.dumps({"iter": 0, "ckpt": "x", "random_2p_durak": 0.0}))
    monkeypatch.setattr(G, "CHAMPION", str(ck / "champion.pt"))
    monkeypatch.setattr(G, "CHAMP_JSON", str(ck / "champion.json"))
    monkeypatch.setattr(G, "CHAMP_STATS", str(ck / "champion_stats.json"))
    monkeypatch.setattr(G, "SUMMARY", str(tmp_path / "eval_summary.json"))
    common = ["--run-dir", str(run), "--games", "12", "--pair-games", "12", "--pop-games", "6", "--random-games", "6",
              "--anchor-games", "6", "--workers", "1", "--ns", "2", "3", "--anchors",
              "--population", str(ck / "pop.pt")]
    # strict rule: tiny random nets will not be promoted; champion stats accumulate
    G.main([str(ck / "cand.pt"), *common])
    G.main([str(ck / "cand.pt"), *common])
    st = json.load(open(ck / "champion_stats.json"))
    assert st["gates"] == 2 and st["results"]["heuristic"]["2"][1] == 24
    summ = json.load(open(tmp_path / "eval_summary.json"))
    assert summ["results"]["heuristic"]["2"]["games"] == 24 and "random" in summ["results"]
    recs = [json.loads(l) for l in open(run / "eval.jsonl")]
    assert all(not r["promoted"] for r in recs)
    for k in ("heuristic_2p_durak", "solver_3p_ci", "champ_2p_durak", "champ_rev_3p_durak", "vs_champion_z",
              "fixed_z1", "decision"):
        assert k in recs[0]
    # permissive rule: promotion installs the candidate and resets the running estimate
    G.main([str(ck / "cand.pt"), *common, "--threshold", "-99", "--confirm", "-99", "--tolerance", "99",
            "--h2h-min", "-99"])
    assert open(ck / "champion.pt", "rb").read() == open(ck / "cand.pt", "rb").read()
    st = json.load(open(ck / "champion_stats.json"))
    assert st["iter"] == 100 and st["gates"] == 1 and st["results"]["heuristic"]["2"][1] == 12
    hist = (ck / "champion_history.jsonl").read_text().strip().splitlines()
    assert json.loads(hist[-1])["iter"] == 100
