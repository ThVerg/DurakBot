"""SQLite persistence for finished games and aggregate statistics."""

from __future__ import annotations

import json
import os
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_DB = Path(__file__).resolve().parent / "data" / "games.db"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS games (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    mode TEXT NOT NULL,             -- 'play' (human vs bots) or 'spectate'
    num_players INTEGER NOT NULL,
    human_seat INTEGER,             -- NULL in spectate mode
    seats TEXT NOT NULL,            -- JSON list: bot name per seat ('human' for the human)
    loser INTEGER,                  -- durak seat, NULL on a draw
    finished TEXT NOT NULL,         -- JSON list: order players went out
    human_result TEXT,              -- 'durak' | 'safe' | 'draw' | NULL (spectate)
    human_place INTEGER,            -- 1..N (N = durak), NULL in spectate / draw
    moves INTEGER NOT NULL,
    seed INTEGER,
    debug_used INTEGER NOT NULL DEFAULT 0,
    end_reason TEXT,                -- 'durak' | 'draw' | 'stalemate'
    hints_used INTEGER NOT NULL DEFAULT 0
);
"""
_MIGRATIONS = {
    "end_reason": "ALTER TABLE games ADD COLUMN end_reason TEXT",
    "hints_used": "ALTER TABLE games ADD COLUMN hints_used INTEGER NOT NULL DEFAULT 0",
}


class Storage:
    def __init__(self, path: str | os.PathLike | None = None):
        self.path = Path(path or os.environ.get("DURAK_DB", DEFAULT_DB))
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        with self._connect() as con:
            con.executescript(_SCHEMA)
            have = {r[1] for r in con.execute("PRAGMA table_info(games)")}
            for col, sql in _MIGRATIONS.items():
                if col not in have:
                    con.execute(sql)

    def _connect(self) -> sqlite3.Connection:
        con = sqlite3.connect(self.path, timeout=10)
        con.row_factory = sqlite3.Row
        return con

    def record(self, rec: dict) -> None:
        row = dict(rec)
        row.setdefault("date", datetime.now(timezone.utc).isoformat(timespec="seconds"))
        row["seats"] = json.dumps(row["seats"])
        row["finished"] = json.dumps(row["finished"])
        row["debug_used"] = int(bool(row.get("debug_used")))
        row["hints_used"] = int(row.get("hints_used") or 0)
        cols = [
            "id", "date", "mode", "num_players", "human_seat", "seats", "loser", "finished",
            "human_result", "human_place", "moves", "seed", "debug_used", "end_reason", "hints_used",
        ]
        with self._lock, self._connect() as con:
            con.execute(
                f"INSERT OR REPLACE INTO games ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})",
                [row.get(c) for c in cols],
            )

    def rows(self) -> list[dict]:
        with self._lock, self._connect() as con:
            out = []
            for r in con.execute("SELECT * FROM games ORDER BY date DESC"):
                d = dict(r)
                d["seats"] = json.loads(d["seats"])
                d["finished"] = json.loads(d["finished"])
                d["debug_used"] = bool(d["debug_used"])
                out.append(d)
            return out

    def stats(self) -> dict:
        rows = self.rows()
        play = [r for r in rows if r["mode"] == "play"]

        def rate(a, b):
            return round(a / b, 4) if b else None

        # Human results per number of players.
        by_n = []
        for n in range(2, 7):
            rs = [r for r in play if r["num_players"] == n]
            if not rs:
                continue
            durak = sum(r["human_result"] == "durak" for r in rs)
            draws = sum(r["human_result"] == "draw" for r in rs)
            places = [r["human_place"] for r in rs if r["human_place"]]
            by_n.append({
                "num_players": n,
                "games": len(rs),
                "human_durak": durak,
                "human_durak_rate": rate(durak, len(rs)),
                "expected_durak_rate": round(1 / n, 4),
                "draws": draws,
                "avg_place": round(sum(places) / len(places), 2) if places else None,
            })

        # Per bot: how often its seats ended up durak (all modes), and how the
        # human fared in games against it.
        bots: dict[str, dict] = {}
        for r in rows:
            for seat, name in enumerate(r["seats"]):
                if name == "human":
                    continue
                b = bots.setdefault(name, {
                    "bot": name, "seats": 0, "durak": 0, "expected": 0.0,
                    "human_games": 0, "human_durak": 0, "_games": set(),
                })
                b["seats"] += 1
                b["expected"] += 1 / r["num_players"]
                if r["loser"] == seat:
                    b["durak"] += 1
            if r["mode"] == "play":
                for name in set(s for s in r["seats"] if s != "human"):
                    b = bots[name]
                    b["human_games"] += 1
                    b["human_durak"] += r["human_result"] == "durak"
        by_bot = []
        for b in sorted(bots.values(), key=lambda x: x["bot"]):
            b.pop("_games")
            by_bot.append({
                "bot": b["bot"],
                "seats": b["seats"],
                "durak": b["durak"],
                "durak_rate": rate(b["durak"], b["seats"]),
                "expected_durak_rate": rate(b["expected"], b["seats"]),
                "human_games": b["human_games"],
                "human_durak": b["human_durak"],
                "human_durak_rate": rate(b["human_durak"], b["human_games"]),
            })

        human_durak = sum(r["human_result"] == "durak" for r in play)
        human_safe = sum(r["human_result"] == "safe" for r in play)
        best = cur = 0
        for r in reversed(play):  # oldest first
            if r["human_result"] == "safe":
                cur += 1
                best = max(best, cur)
            elif r["human_result"] == "durak":
                cur = 0
        return {
            "total_games": len(rows),
            "human_games": len(play),
            "spectated_games": len(rows) - len(play),
            "human_durak": human_durak,
            "human_safe": human_safe,
            "streak_best": best,
            "streak_current": cur,
            "human_durak_rate": rate(human_durak, len(play)),
            "by_players": by_n,
            "by_bot": by_bot,
            "recent": [
                {k: r.get(k) for k in ("id", "date", "mode", "num_players", "human_seat", "seats", "loser",
                                       "human_result", "human_place", "moves", "debug_used", "end_reason",
                                       "hints_used")}
                for r in rows[:20]
            ],
        }

    def timeline(self) -> list[dict]:
        """Human games in chronological order (for the Lab page)."""
        out = []
        for r in reversed(self.rows()):
            if r["mode"] != "play":
                continue
            out.append({
                "date": r["date"],
                "num_players": r["num_players"],
                "bots": sorted(set(s for s in r["seats"] if s != "human")),
                "result": r["human_result"],
                "place": r["human_place"],
                "moves": r["moves"],
                "assisted": bool(r["debug_used"]) or bool(r.get("hints_used")),
            })
        return out
