"""API tests for the DurakBot web server (server/app.py)."""

from __future__ import annotations

import random
import warnings

import pytest

warnings.filterwarnings("ignore", category=DeprecationWarning)

from fastapi.testclient import TestClient  # noqa: E402

from durak.cards import mask_to_list  # noqa: E402
from durak.engine import PASS  # noqa: E402
from server.app import create_app  # noqa: E402

CARD_KEYS = {"hand", "known", "cards", "card", "attack", "defense", "discard", "trump_card", "legal", "action"}


@pytest.fixture()
def client(tmp_path):
    app = create_app(str(tmp_path / "games.db"))
    with TestClient(app) as c:
        c.app_ref = app
        yield c


def session_of(client, gid):
    return client.app_ref.state.sessions[gid]


def hidden_cards(sess) -> set[int]:
    """Cards in bots' hands that the human cannot know (excluding the face-up
    trump card, which everyone saw before it was drawn)."""
    g = sess.game
    out = set()
    for p in range(g.num_players):
        if p != sess.human_seat:
            out |= set(mask_to_list(g.hands[p] & ~g.known[p]))
    out.discard(g.trump_card)
    return out


def card_values(obj, key=None):
    """Yield every int stored under a card-bearing key anywhere in ``obj``."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield from card_values(v, k)
    elif isinstance(obj, list):
        for v in obj:
            yield from card_values(v, key)
    elif isinstance(obj, int) and not isinstance(obj, bool) and key in CARD_KEYS:
        yield obj


def assert_no_leak(sess, payload):
    hidden = hidden_cards(sess)
    leaked = hidden & set(card_values(payload))
    assert not leaked, f"hidden cards leaked: {leaked}"

    # Structural checks: bots never expose their hand; draws by bots have no cards.
    def walk(o):
        if isinstance(o, dict):
            if "seat" in o and "is_human" in o and not o["is_human"]:
                assert "hand" not in o, "bot hand exposed"
            if o.get("type") == "draw" and o.get("player") != sess.human_seat:
                assert "cards" not in o, "bot draw exposed"
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)

    walk(payload)


def play_random_game(client, n, seat, seed, check_leaks=True):
    rng = random.Random(seed * 31 + n)
    r = client.post("/api/games", json={"num_players": n, "human_seat": seat, "seed": seed, "bot": "random"})
    assert r.status_code == 200, r.text
    data = r.json()
    gid = data["game_id"]
    sess = session_of(client, gid)
    if check_leaks:
        assert_no_leak(sess, data)
    state = data["state"]
    turns = 0
    while not state["done"]:
        assert state["your_turn"], "server returned control while it's not the human's turn"
        assert state["to_move"] == seat
        assert state["legal"] == sess.game.legal_actions()
        if PASS in state["legal"]:
            assert state["pass_label"] in {"bita", "pass", "take", "done"}
        a = rng.choice(state["legal"])
        r = client.post(f"/api/games/{gid}/action", json={"action": a})
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["steps"][0]["player"] == seat and data["steps"][0]["action"] == a
        if check_leaks:
            assert_no_leak(sess, data)
        state = data["state"]
        turns += 1
        assert turns < 2000
    assert state["result"] is not None
    g = sess.game
    assert state["loser"] == g.loser and state["finished"] == g.finished
    if g.loser is not None:
        assert data["steps"] == [] or any(
            e["type"] == "game_over" for st in data["steps"] for e in st["events"]
        )
    return gid, state


@pytest.mark.parametrize("n", [2, 3, 4, 5, 6])
def test_full_games_random_human(client, n):
    for seed in range(12):
        seat = seed % n
        _, state = play_random_game(client, n, seat, seed)
        res = state["result"]
        assert res["human"] in {"durak", "safe", "draw"}
        if res["human"] == "durak":
            assert res["place"] == n
    stats = client.get("/api/stats").json()
    row = next(x for x in stats["by_players"] if x["num_players"] == n)
    assert row["games"] == 12


def test_bots_endpoint(client):
    data = client.get("/api/bots").json()
    names = [b["name"] for b in data["bots"]]
    assert "random" in names and data["default"] in names


def test_illegal_actions_rejected(client):
    r = client.post("/api/games", json={"num_players": 3, "human_seat": 0, "seed": 5, "bot": "random"})
    data = r.json()
    gid = data["game_id"]
    sess = session_of(client, gid)
    state = data["state"]
    illegal = [a for a in range(37) if a not in state["legal"]]
    assert illegal
    before = len(sess.game.log)
    for a in illegal[:10]:
        r = client.post(f"/api/games/{gid}/action", json={"action": a})
        assert r.status_code == 400
    assert len(sess.game.log) == before
    for bad in (-1, 37, 100):
        assert client.post(f"/api/games/{gid}/action", json={"action": bad}).status_code == 422
    assert client.post("/api/games/nope/action", json={"action": 0}).status_code == 404


def test_not_your_turn_and_finished(client):
    gid, _ = play_random_game(client, 2, 0, 1)
    r = client.post(f"/api/games/{gid}/action", json={"action": 36})
    assert r.status_code == 409


def test_bad_create_requests(client):
    assert client.post("/api/games", json={"num_players": 7}).status_code == 422
    assert client.post("/api/games", json={"num_players": 1}).status_code == 422
    assert client.post("/api/games", json={"num_players": 3, "human_seat": 3}).status_code == 422
    assert client.post("/api/games", json={"num_players": 3, "bot": "nonexistent"}).status_code == 422


def test_per_seat_bots_and_seat_choice(client):
    r = client.post(
        "/api/games",
        json={"num_players": 4, "human_seat": 2, "seed": 9, "bots": ["random", "random", None, "random"]},
    )
    assert r.status_code == 200
    st = r.json()["state"]
    assert st["human_seat"] == 2
    assert [p["bot"] for p in st["players"]] == ["random", "random", None, "random"]
    assert st["players"][2]["is_human"] and "hand" in st["players"][2]


def test_get_state_and_history_no_leak(client):
    for seed in range(6):
        r = client.post("/api/games", json={"num_players": 5, "human_seat": 3, "seed": seed, "bot": "random"})
        gid = r.json()["game_id"]
        sess = session_of(client, gid)
        rng = random.Random(seed)
        state = r.json()["state"]
        while not state["done"]:
            got = client.get(f"/api/games/{gid}").json()
            assert_no_leak(sess, got)
            state = client.post(f"/api/games/{gid}/action", json={"action": rng.choice(state["legal"])}).json()["state"]


def test_debug_reveal_is_opt_in(client):
    r = client.post("/api/games", json={"num_players": 3, "human_seat": 0, "seed": 2, "bot": "random"})
    gid = r.json()["game_id"]
    st = r.json()["state"]
    assert st["debug_reveal"] is False
    assert all("hand" not in p for p in st["players"] if not p["is_human"])
    st = client.post(f"/api/games/{gid}/debug", json={"reveal": True}).json()["state"]
    sess = session_of(client, gid)
    for p in st["players"]:
        assert p["hand"] == mask_to_list(sess.game.hands[p["seat"]])
    # Play a few moves while revealed, then hide again: nothing may linger.
    rng = random.Random(0)
    for _ in range(15):
        if st["done"]:
            break
        st = client.post(f"/api/games/{gid}/action", json={"action": rng.choice(st["legal"])}).json()["state"]
    st = client.post(f"/api/games/{gid}/debug", json={"reveal": False}).json()["state"]
    assert all("hand" not in p for p in st["players"] if not p["is_human"])
    assert_no_leak(sess, client.get(f"/api/games/{gid}").json())
    assert sess.debug_used


def test_spectate_mode(client):
    r = client.post("/api/games", json={"num_players": 4, "spectate": True, "seed": 4, "bot": "random"})
    assert r.status_code == 200
    data = r.json()
    gid = data["game_id"]
    assert data["state"]["mode"] == "spectate" and data["steps"] == []
    one = client.post(f"/api/games/{gid}/advance", json={"max_steps": 1}).json()
    assert len(one["steps"]) == 1
    bout = client.post(f"/api/games/{gid}/advance", json={"until": "bout"}).json()
    assert bout["steps"][-1]["events"] or bout["state"]["done"]
    end = client.post(f"/api/games/{gid}/advance", json={"until": "end"}).json()
    assert end["state"]["done"]
    assert client.post(f"/api/games/{gid}/action", json={"action": 36}).status_code == 409
    stats = client.get("/api/stats").json()
    assert stats["spectated_games"] == 1


def test_human_out_autoplays_rest(client):
    # Find a game where the human goes out before the end: the response that
    # carries the human out must also carry the remaining bot moves to the end.
    found = False
    for seed in range(60):
        gid, state = play_random_game(client, 4, seed % 4, seed, check_leaks=False)
        res = state["result"]
        if res["human"] == "safe" and res["place"] < 3:
            found = True
            assert state["done"]
            break
    assert found


def test_stats_recorded(client):
    for seed in range(4):
        play_random_game(client, 3, 1, seed, check_leaks=False)
    s = client.get("/api/stats").json()
    assert s["human_games"] == 4 and s["total_games"] == 4
    bot = next(b for b in s["by_bot"] if b["bot"] == "random")
    assert bot["seats"] == 8 and bot["human_games"] == 4
    assert len(s["recent"]) == 4
    row = s["recent"][0]
    assert row["num_players"] == 3 and row["moves"] > 0 and row["human_result"] in {"durak", "safe", "draw"}


def test_events_describe_bouts(client):
    r = client.post("/api/games", json={"num_players": 2, "human_seat": 0, "seed": 11, "bot": "random"})
    gid = r.json()["game_id"]
    state = r.json()["state"]
    rng = random.Random(3)
    kinds, types = set(), set()
    while not state["done"]:
        data = client.post(f"/api/games/{gid}/action", json={"action": rng.choice(state["legal"])}).json()
        for st in data["steps"]:
            kinds.add(st["kind"])
            types |= {e["type"] for e in st["events"]}
            assert "view" in st
        state = data["state"]
    assert {"lead", "beat"} <= kinds
    assert "game_over" in types and "draw" in types


def test_frontend_or_placeholder_served(client):
    r = client.get("/")
    assert r.status_code in (200, 503)
    assert client.get("/api/does-not-exist").status_code == 404


def test_evaluate_endpoint(client):
    r = client.post("/api/games", json={"num_players": 3, "human_seat": 0, "seed": 1, "bot": "random"})
    gid = r.json()["game_id"]
    ev = client.get(f"/api/games/{gid}/evaluate").json()
    assert set(ev) == {"available", "values"}
    if ev["available"]:
        assert set(ev["values"]) <= {"0"}
        assert all(0.0 <= v <= 1.0 for v in ev["values"].values())


def test_default_bot_preference(client):
    from server.sessions import BOT_PREFERENCE, usable_agents

    data = client.get("/api/bots").json()
    usable = usable_agents()
    expected = next(b for b in BOT_PREFERENCE if b in usable)
    assert data["default"] == expected
    r = client.post("/api/games", json={"num_players": 2, "human_seat": 1, "seed": 3})
    assert r.status_code == 200
    assert r.json()["state"]["players"][0]["bot"] == expected


@pytest.mark.parametrize("n", [2, 4, 6])
def test_default_bot_games_complete(client, n):
    """A couple of full games against the strongest available bot (no leaks)."""
    for seed in range(2):
        rng = random.Random(seed)
        r = client.post("/api/games", json={"num_players": n, "human_seat": seed % n, "seed": seed})
        data = r.json()
        gid = data["game_id"]
        sess = session_of(client, gid)
        assert_no_leak(sess, data)
        state = data["state"]
        while not state["done"]:
            data = client.post(f"/api/games/{gid}/action", json={"action": rng.choice(state["legal"])}).json()
            assert_no_leak(sess, data)
            state = data["state"]
        assert state["result"]["human"] in {"durak", "safe", "draw"}
