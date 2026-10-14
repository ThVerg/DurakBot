"""Tests for the rating ladder (durak/ladder.py)."""

import json
import math
import random

import numpy as np
import pytest

from durak import ladder


def _synthetic(ratings, n, games, seed=0):
    """Records drawn from the durak-choice model with known ratings."""
    rng = random.Random(seed)
    names = list(ratings)
    recs = []
    for i in range(games):
        a, b = rng.sample(names, 2)
        seats = [a] + [b] * (n - 1) if i % 2 else [b] + [a] * (n - 1)
        g = [10 ** (-ratings[s] / 400) for s in seats]
        r, acc, loser = rng.random() * sum(g), 0.0, None
        for k, x in enumerate(g):
            acc += x
            if r <= acc:
                loser = k
                break
        recs.append({"n": n, "unit": f"u{i // 4}", "seats": seats, "loser": loser})
    return recs


@pytest.mark.parametrize("n", [2, 4])
def test_fit_recovers_known_ratings(n):
    truth = {"random": 0.0, "a": 300.0, "b": 550.0, "c": 700.0}
    recs = _synthetic(truth, n, 12000, seed=n)
    out = {e["spec"]: e for e in ladder.fit_n(recs, list(truth), n_boot=30)}
    for k, v in truth.items():
        assert abs(out[k]["elo"] - v) < 60, (k, out[k], v)
        lo, hi = out[k]["ci"]
        assert lo <= out[k]["elo"] <= hi
    assert out["random"]["elo"] == 0


def test_two_player_is_elo():
    # A beats B 3 times out of 4 -> Elo difference 400*log10(3) ~ 191
    recs = []
    for i in range(400):
        recs.append({"n": 2, "unit": f"u{i}", "seats": ["random", "x"], "loser": 0 if i % 4 else 1})
    out = {e["spec"]: e["elo"] for e in ladder.fit_n(recs, ["random", "x"], n_boot=0)}
    assert out["x"] == pytest.approx(400 * math.log10(3), abs=3)


def test_draws_count_as_shared_loss():
    recs = [{"n": 3, "unit": f"u{i}", "seats": ["random", "x", "x"], "loser": None} for i in range(50)]
    recs += [{"n": 3, "unit": f"v{i}", "seats": ["random", "x", "x"], "loser": i % 3} for i in range(300)]
    out = {e["spec"]: e["elo"] for e in ladder.fit_n(recs, ["random", "x"], n_boot=0)}
    assert abs(out["x"]) < 40  # all seats lose equally often


def test_version_filter():
    recs = [{"seats": ["random", "heuristic"], "ver": {"random": "1", "heuristic": "old"}},
            {"seats": ["random", "heuristic"], "ver": {"random": "1", "heuristic": "new"}}]
    kept = ladder.current_records(recs, {"random": "1", "heuristic": "new"})
    assert kept == [recs[1]]


def test_specs():
    assert ladder.display_name("ckpt:runs/main/ckpt/it000300.pt") == "it000300"
    assert ladder._parse_level_spec("level:temperature=1.5,top_p=0.9,use_solver=0") == {
        "temperature": 1.5, "top_p": 0.9, "use_solver": False}
    assert ladder.agent_version("heuristic") == ladder.agent_version("heuristic")


def test_run_ladder_writes_json(tmp_path):
    games, out_file = tmp_path / "g.jsonl", tmp_path / "ladder.json"
    out = ladder.run_ladder(["random", "heuristic"], ns=[2, 3], minutes=0.15, workers=2, seed=1,
                            games_file=str(games), out_file=str(out_file), n_boot=20, verbose=False)
    data = json.loads(out_file.read_text())
    assert data["anchor"] == "random=0" and "updated" in data
    for n in ("2", "3"):
        rs = {e["agent"]: e for e in data["ratings"][n]}
        assert set(rs) == {"random", "heuristic"}
        assert rs["random"]["elo"] == 0
        assert rs["heuristic"]["elo"] > 300
        assert rs["heuristic"]["games"] > 0 and len(rs["heuristic"]["ci"]) == 2
    # incremental: a fit-only run reuses the stored games
    out2 = ladder.run_ladder(["random", "heuristic"], ns=[2, 3], minutes=0, games_file=str(games),
                             out_file=str(out_file), n_boot=0)
    assert out2["games"] == out["games"]
