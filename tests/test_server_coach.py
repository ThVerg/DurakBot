"""Tests for streaming play, hints, post-game analysis, replay, the Lab API
and bot metadata — with emphasis on the no-hidden-information invariant."""

from __future__ import annotations

import json
import random
import types

import pytest
from fastapi.testclient import TestClient

from durak.cards import mask_to_list
from durak.engine import DurakGame
from server import analysis as analysis_mod
from server import lab as lab_mod
from server.app import create_app
from server.sessions import GameSession, make_analyst

from test_server import assert_no_leak, hidden_cards, session_of  # noqa: E402

def _champion_works() -> bool:
    try:
        a = make_analyst()
        return a is not None and 0.0 <= a.evaluate(DurakGame(seed=1, num_players=3), 0) <= 1.0
    except Exception:
        return False


needs_champion = pytest.mark.skipif(not _champion_works(), reason="champion not available / not loadable")


@pytest.fixture()
def client(tmp_path):
    app = create_app(str(tmp_path / "games.db"))
    with TestClient(app) as c:
        c.app_ref = app
        yield c


# ------------------------------------------------------------------ streaming
@pytest.mark.parametrize("n", [2, 3, 4, 5, 6])
def test_streaming_single_steps(client, n):
    for seed in range(3):
        rng = random.Random(seed)
        r = client.post("/api/games", json={"num_players": n, "human_seat": seed % n, "seed": seed, "bot": "random", "auto": False})
        data = r.json()
        assert data["steps"] == []
        gid = data["game_id"]
        sess = session_of(client, gid)
        state = data["state"]
        while not state["done"]:
            if state["your_turn"]:
                data = client.post(f"/api/games/{gid}/action", json={"action": rng.choice(state["legal"]), "auto": False}).json()
                assert len(data["steps"]) == 1 and data["steps"][0]["player"] == seed % n
            else:
                # The human can't act now; a single bot step comes back.
                assert client.post(f"/api/games/{gid}/action", json={"action": 36, "auto": False}).status_code == 409
                data = client.post(f"/api/games/{gid}/advance", json={"until": "step"}).json()
                assert len(data["steps"]) == 1
                assert data["steps"][0]["player"] != seed % n
                assert "think_ms" in data["steps"][0]
            assert_no_leak(sess, data)
            state = data["state"]
        assert state["result"]["reason"] in {"durak", "draw", "stalemate"}
        # advancing a finished game is refused
        assert client.post(f"/api/games/{gid}/advance", json={}).status_code == 409


def test_stalemate_reason():
    s = GameSession(3, 0, ["random"] * 3, seed=1)
    g = s.game
    g.done, g.loser = True, None
    g.stall = g.config.stall_bouts
    assert s.result()["reason"] == "stalemate" and s.result()["human"] == "draw"
    g.stall = 0
    assert s.result()["reason"] == "draw"


# ----------------------------------------------------------------------- hint
def _play_until_human_turn_with_choice(client, n, seed, min_moves=6):
    rng = random.Random(seed)
    r = client.post("/api/games", json={"num_players": n, "human_seat": 0, "seed": seed, "bot": "random"})
    gid = r.json()["game_id"]
    state = r.json()["state"]
    moves = 0
    while not state["done"]:
        if moves >= min_moves and len(state["legal"]) >= 2:
            return gid, state
        state = client.post(f"/api/games/{gid}/action", json={"action": rng.choice(state["legal"])}).json()["state"]
        moves += 1
    return gid, None


@needs_champion
def test_hint_shape_and_turn_check(client):
    gid, state = _play_until_human_turn_with_choice(client, 3, 2)
    assert state is not None
    h = client.get(f"/api/games/{gid}/hint").json()
    assert h["available"] and h["has_values"]
    assert sorted(m["action"] for m in h["moves"]) == sorted(state["legal"])
    assert h["recommended"] in state["legal"] and h["best"] in state["legal"]
    assert all(0 <= m["win"] <= 1 for m in h["moves"])
    assert session_of(client, gid).hints_used == 1
    assert_no_leak(session_of(client, gid), h)


def test_hint_refused_when_not_your_turn(client):
    r = client.post("/api/games", json={"num_players": 2, "human_seat": 0, "seed": 1, "bot": "random", "auto": False})
    data = r.json()
    gid = data["game_id"]
    if data["state"]["your_turn"]:
        st = client.post(f"/api/games/{gid}/action", json={"action": data["state"]["legal"][0], "auto": False}).json()["state"]
        assert not st["your_turn"] or st["done"]
    assert client.get(f"/api/games/{gid}/hint").status_code == 409


@needs_champion
@pytest.mark.parametrize("n,seed", [(2, 3), (3, 5), (4, 7), (5, 11)])
def test_hint_independent_of_hidden_cards(client, n, seed):
    """Re-deal every hidden card (consistently with the human's knowledge):
    the hint must not change at all."""
    gid, state = _play_until_human_turn_with_choice(client, n, seed)
    if state is None:
        pytest.skip("game ended early")
    sess = session_of(client, gid)
    g = sess.game
    real = analysis_mod.compute_hint(sess)
    changed = 0
    for k in range(3):
        g2 = g.determinize(0, random.Random(1000 + k))  # same info set, other hidden cards
        changed += g2.hands != g.hands or g2.talon != g.talon
        shim = types.SimpleNamespace(game=g2, human_seat=0, seed=sess.seed, needs_human=lambda: True)
        assert analysis_mod.compute_hint(shim) == real
    assert changed, "test is vacuous: no hidden information to re-deal"


# ------------------------------------------------------- analysis info-set spy
class _InfoSetSpy:
    """Wraps the analyst and checks every game it sees is a determinization
    (or a clone stepped from one) built for the human."""

    def __init__(self, real, me):
        self.real, self.me = real, me
        self.allowed: set[int] = set()
        self.keep: list = []
        self.calls = 0

    def install(self, monkeypatch):
        orig_det, orig_clone = DurakGame.determinize, DurakGame.clone
        spy = self

        def det(self_g, player, rng):
            assert player == spy.me, "determinized for a bot's info set"
            g = orig_det(self_g, player, rng)
            spy.allowed.add(id(g))
            spy.keep.append(g)
            return g

        def clone(self_g):
            g = orig_clone(self_g)
            if id(self_g) in spy.allowed:
                spy.allowed.add(id(g))
                spy.keep.append(g)
            return g

        monkeypatch.setattr(DurakGame, "determinize", det)
        monkeypatch.setattr(DurakGame, "clone", clone)
        monkeypatch.setattr(analysis_mod, "make_analyst", lambda: spy)

    def _check(self, game, player):
        assert player == self.me
        assert id(game) in self.allowed, "analyst was handed the real game"
        self.calls += 1

    def evaluate(self, game, player):
        self._check(game, player)
        return self.real.evaluate(game, player)

    def policy(self, game, player):
        self._check(game, player)
        return self.real.policy(game, player)


@needs_champion
def test_analysis_and_hint_only_see_human_info_set(client, monkeypatch):
    rng = random.Random(4)
    r = client.post("/api/games", json={"num_players": 3, "human_seat": 1, "seed": 21, "bot": "random"})
    gid = r.json()["game_id"]
    sess = session_of(client, gid)
    spy = _InfoSetSpy(make_analyst(), 1)
    spy.install(monkeypatch)
    state = r.json()["state"]
    hinted = False
    while not state["done"]:
        if not hinted and len(state["legal"]) > 1:
            analysis_mod.compute_hint(sess)
            hinted = True
        state = client.post(f"/api/games/{gid}/action", json={"action": rng.choice(state["legal"])}).json()["state"]
    out: dict = {"status": "running"}
    analysis_mod._run_analysis(sess, out)
    assert out["status"] == "ready", out
    assert spy.calls > 10
    assert len(out["timeline"]) == len(sess.game.log) + 1
    assert all(0 <= t["win"] <= 1 for t in out["timeline"])
    for d in out["decisions"]:
        assert sess.game.log[d["seq"]] == (1, d["chosen"])
        assert d["loss"] >= 0


@needs_champion
def test_analysis_endpoint(client):
    rng = random.Random(1)
    r = client.post("/api/games", json={"num_players": 2, "human_seat": 0, "seed": 8, "bot": "random"})
    gid = r.json()["game_id"]
    assert client.get(f"/api/games/{gid}/analysis").status_code == 409  # not finished yet
    state = r.json()["state"]
    while not state["done"]:
        state = client.post(f"/api/games/{gid}/action", json={"action": rng.choice(state["legal"])}).json()["state"]
    import time

    for _ in range(600):
        a = client.get(f"/api/games/{gid}/analysis").json()
        if a["status"] != "running":
            break
        time.sleep(0.1)
    assert a["status"] == "ready"
    assert a["timeline"][-1]["win"] in (0.0, 1.0)
    assert_no_leak(session_of(client, gid), a)


# --------------------------------------------------------------------- replay
@pytest.mark.parametrize("n", [2, 4, 6])
def test_replay_frames_leak_free(client, n):
    rng = random.Random(n)
    r = client.post("/api/games", json={"num_players": n, "human_seat": 1, "seed": 40 + n, "bot": "random"})
    gid = r.json()["game_id"]
    state = r.json()["state"]
    assert client.get(f"/api/games/{gid}/replay").status_code == 409
    while not state["done"]:
        state = client.post(f"/api/games/{gid}/action", json={"action": rng.choice(state["legal"])}).json()["state"]
    sess = session_of(client, gid)
    rep = client.get(f"/api/games/{gid}/replay").json()
    frames = rep["frames"]
    assert len(frames) == len(sess.game.log) + 1
    g = DurakGame(seed=sess.seed, num_players=n)
    for k, fr in enumerate(frames):
        if k:
            g.step(sess.game.log[k - 1][1])
        # Hidden cards at *that* moment must not appear in that frame.
        shim = types.SimpleNamespace(game=g, human_seat=1)
        assert_no_leak(shim, fr)
        assert fr["view"]["players"][1]["hand"] == mask_to_list(g.hands[1])
        assert fr["view"]["legal"] == (g.legal_actions() if not g.done and g.current_player == 1 else [])
    assert frames[-1]["view"]["done"]
    assert_no_leak(sess, rep)


def test_replay_hides_hands_even_after_debug(client):
    rng = random.Random(0)
    r = client.post("/api/games", json={"num_players": 3, "human_seat": 0, "seed": 3, "bot": "random", "debug_reveal": True})
    gid = r.json()["game_id"]
    state = r.json()["state"]
    while not state["done"]:
        state = client.post(f"/api/games/{gid}/action", json={"action": rng.choice(state["legal"])}).json()["state"]
    rep = client.get(f"/api/games/{gid}/replay").json()
    for fr in rep["frames"]:
        assert all("hand" not in p for p in fr["view"]["players"] if not p["is_human"])


# ------------------------------------------------------------------- bots/lab
def test_bots_metadata(client):
    data = client.get("/api/bots").json()
    for b in data["bots"]:
        assert set(b["labels"]) == {"en", "ru"} and set(b["desc"]) == {"en", "ru"}
        assert b["available"]
    tiers = [b["tier"] if b["tier"] is not None else -1 for b in data["bots"]]
    assert tiers == sorted(tiers, reverse=True)


def test_personas_assigned(client):
    st = client.post("/api/games", json={"num_players": 6, "human_seat": 2, "seed": 1, "bot": "random"}).json()["state"]
    personas = [p["persona"] for p in st["players"]]
    assert personas[2] is None
    bots = [x for i, x in enumerate(personas) if i != 2]
    assert len(set(bots)) == 5 and all(bots)


def test_lab_handles_missing_and_present_files(client, tmp_path, monkeypatch):
    runs, ck = tmp_path / "runs", tmp_path / "ckpt"
    monkeypatch.setattr(lab_mod, "RUNS", runs)
    monkeypatch.setattr(lab_mod, "CKPT", ck)
    lab_mod._cache.clear()
    empty = client.get("/api/lab").json()
    assert empty["runs"] == [] and empty["train"] is None and empty["ladder"] is None and empty["eval_summary"] is None

    (runs / "main").mkdir(parents=True)
    ck.mkdir()
    rows = ["iter,steps,hours,entropy,kl,explained_var,durak_2p_vs_heuristic"]
    rows += [f"{i},{i * 1000},{i / 10},{1 - i / 2000},0.01,{i / 1000},{0.5 - i / 4000}" for i in range(1, 1501)]
    (runs / "main" / "train.csv").write_text("\n".join(rows) + "\n")
    ev = {"iter": 100, "steps": 5, "heuristic_2p_durak": 0.3, "heuristic_2p_ci": [0.25, 0.35], "promoted": True}
    (runs / "main" / "eval.jsonl").write_text(json.dumps(ev) + "\n{partial")
    (ck / "champion_history.jsonl").write_text(json.dumps(ev) + "\n")
    (runs / "eval_summary.json").write_text(json.dumps(
        {"updated": "x", "iteration": 100, "results": {"heuristic": {"2": {"rate": 0.3, "ci": [0.2, 0.4], "games": 100}}}}))
    (runs / "ladder.json").write_text(json.dumps({"updated": "y", "ratings": {"2": {"champion": 1700, "random": {"elo": 900}}}}))
    lab_mod._cache.clear()
    d = client.get("/api/lab").json()
    assert d["runs"] == ["main"]
    assert d["train"]["rows"] == 1500 and len(d["train"]["series"]["iter"]) <= lab_mod.MAX_POINTS + 1
    assert d["train"]["series"]["iter"][-1] == 1500
    assert d["evals"][0]["rates"]["heuristic"]["2"] == {"rate": 0.3, "ci": [0.25, 0.35]}
    assert d["promotions"][0]["promoted"] is True
    assert d["eval_summary"]["results"]["heuristic"]["2"]["rate"] == 0.3
    assert [r["bot"] for r in d["ladder"]["by_n"]["2"]] == ["champion", "random"]
    assert isinstance(d["human"], list)
    # other ladder shapes
    for shape in ({"2p": {"a": 1}}, [{"bot": "a", "n": 3, "elo": 1}], {"ratings": [{"bot": "a", "num_players": 4, "rating": 2}]}):
        assert lab_mod._normalize_ladder(shape)["by_n"]


def test_lab_human_timeline(client):
    rng = random.Random(0)
    for seed in range(2):
        r = client.post("/api/games", json={"num_players": 2, "human_seat": 0, "seed": seed, "bot": "random"})
        gid, state = r.json()["game_id"], r.json()["state"]
        while not state["done"]:
            state = client.post(f"/api/games/{gid}/action", json={"action": rng.choice(state["legal"])}).json()["state"]
    d = client.get("/api/lab").json()
    assert len(d["human"]) == 2 and d["human"][0]["bots"] == ["random"]


def test_hidden_cards_helper_sanity():
    s = GameSession(4, 0, ["random"] * 4, seed=5)
    assert hidden_cards(s)
