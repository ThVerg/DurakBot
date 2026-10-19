"""FastAPI app: play Podkidnoy Durak (2-6 players) against the DurakBot bots.

Run:  .venv/bin/python -m uvicorn server.app:app --host 0.0.0.0 --port 8000
API lives under /api; the built frontend (web/dist) is served at /.

Streaming: the UI submits the human move with ``auto=false`` and then pulls
bot moves one at a time from ``/advance`` (each animates as soon as it is
made). With ``auto=true`` (the default) the server plays all bot moves up to
the human's next turn in one response.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Callable, TypeVar

import anyio
from fastapi import FastAPI, HTTPException
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from durak.agents import available_agents
from durak.engine import MAX_PLAYERS, MIN_PLAYERS, NUM_ACTIONS

from . import lab
from .analysis import compute_hint, get_analysis, get_replay
from .bots_meta import BOT_PREFERENCE, bot_meta
from .sessions import GameError, GameSession, bot_status, default_bot, evaluator_available, usable_agents
from .storage import Storage

log = logging.getLogger("durak.server")
ROOT = Path(__file__).resolve().parent.parent
DIST = Path(os.environ.get("DURAK_DIST", ROOT / "web" / "dist"))
MAX_SESSIONS = 500
LOCK_TIMEOUT = 120.0

T = TypeVar("T")


class CreateGame(BaseModel):
    num_players: int = Field(2, ge=MIN_PLAYERS, le=MAX_PLAYERS)
    human_seat: int | None = Field(0, description="Seat of the human; null = bot-vs-bot spectate mode")
    spectate: bool = False
    bot: str | None = Field(None, description="Bot type for every bot seat")
    bots: list[str | None] | None = Field(None, description="Bot type per seat (overrides `bot`)")
    seed: int | None = None
    debug_reveal: bool = False
    auto: bool = Field(True, description="Play bot moves up to the human's first turn immediately")


class ActionIn(BaseModel):
    action: int = Field(..., ge=0, lt=NUM_ACTIONS)
    auto: bool = Field(True, description="Also play all bot replies (false = stream them via /advance)")


class AdvanceIn(BaseModel):
    max_steps: int | None = Field(1, ge=1, le=10000)
    until: str = Field("step", pattern="^(step|bout|end)$")


class DebugIn(BaseModel):
    reveal: bool


def _quiet(fn: Callable[[], object]) -> None:
    try:
        fn()
    except Exception:  # pragma: no cover
        log.exception("background task failed")


def create_app(db_path: str | None = None) -> FastAPI:
    app = FastAPI(title="DurakBot", version="2.0")
    app.add_middleware(GZipMiddleware, minimum_size=1024)
    storage = Storage(db_path)
    sessions: "OrderedDict[str, GameSession]" = OrderedDict()
    sessions_lock = threading.Lock()
    app.state.sessions = sessions
    app.state.storage = storage
    # parse the (large, growing) training log in the background so the
    # first Lab visit is quick; later calls only read the appended tail
    if os.environ.get("DURAK_LAB_WARM", "1") == "1":
        threading.Thread(target=lambda: _quiet(lab.lab_data), daemon=True, name="lab-warm").start()

    def get_session(gid: str) -> GameSession:
        with sessions_lock:
            s = sessions.get(gid)
            if s is None:
                raise HTTPException(404, "game not found")
            sessions.move_to_end(gid)
            s.touched = time.time()
            return s

    def finish_if_done(s: GameSession) -> None:
        if s.game.done and not s.recorded:
            try:
                storage.record(s.record_dict())
                s.recorded = True
            except Exception:  # pragma: no cover
                log.exception("failed to record game %s", s.id)

    async def locked(s: GameSession, fn: Callable[[], T]) -> T:
        """Run ``fn`` (which may call bots) in a worker thread under the session lock."""

        def work():
            if not s.lock.acquire(timeout=LOCK_TIMEOUT):
                raise GameError(409, "game is busy")
            try:
                out = fn()
                finish_if_done(s)
                return out
            finally:
                s.lock.release()

        try:
            return await anyio.to_thread.run_sync(work)
        except GameError as e:
            raise HTTPException(e.status, e.detail)

    # ------------------------------------------------------------ endpoints
    @app.get("/api/health")
    def health():
        return {"ok": True, "sessions": len(sessions)}

    def bots_payload():
        from durak.agents import _REGISTRY  # factory classes, for docstrings of unknown bots

        names = available_agents()
        elo = lab.ladder_elo()
        bots = []
        for n in names:
            ok, err = bot_status(n)
            meta = bot_meta(n, _REGISTRY.get(n))
            bots.append({
                "name": n,
                "label": meta["label"]["en"],
                "labels": meta["label"],
                "desc": meta["desc"],
                "tier": meta["tier"],
                "elo": round(elo[n]) if n in elo else None,
                "available": ok,
                "error": err,
            })

        def order(b):
            pref = BOT_PREFERENCE.index(b["name"]) if b["name"] in BOT_PREFERENCE else len(BOT_PREFERENCE)
            return (-(b["tier"] if b["tier"] is not None else -1), pref, b["name"])

        bots.sort(key=order)
        return {
            "credential": lab.credential(),
            "bots": [b for b in bots if b["available"]],
            "unavailable": [b for b in bots if not b["available"]],
            "default": default_bot(),
            "evaluate_available": evaluator_available(),
            "min_players": MIN_PLAYERS,
            "max_players": MAX_PLAYERS,
        }

    @app.get("/api/bots")
    async def bots_():
        return await anyio.to_thread.run_sync(bots_payload)

    @app.post("/api/games")
    async def create_game(req: CreateGame):
        n = req.num_players
        human = None if req.spectate else req.human_seat
        if human is not None and not 0 <= human < n:
            raise HTTPException(422, f"human_seat must be in [0, {n - 1}]")
        avail = set(await anyio.to_thread.run_sync(usable_agents))
        default = req.bot or await anyio.to_thread.run_sync(default_bot)
        seat_bots = []
        for p in range(n):
            name = None
            if req.bots is not None and p < len(req.bots):
                name = req.bots[p]
            name = name or default
            if p != human and name not in avail:
                raise HTTPException(422, f"unknown bot {name!r}; available: {sorted(avail)}")
            seat_bots.append(name)

        s = await anyio.to_thread.run_sync(
            lambda: GameSession(n, human, seat_bots, seed=req.seed, debug_reveal=req.debug_reveal)
        )
        with sessions_lock:
            sessions[s.id] = s
            while len(sessions) > MAX_SESSIONS:
                sessions.popitem(last=False)

        def start():
            steps = s.run_bots() if (s.mode == "play" and req.auto) else []
            return {"game_id": s.id, "steps": steps, "state": s.view()}

        return await locked(s, start)

    @app.get("/api/games/{gid}")
    async def get_state(gid: str):
        s = get_session(gid)
        return await locked(s, lambda: {"game_id": s.id, "state": s.view(), "history": s.history[-400:]})

    @app.post("/api/games/{gid}/action")
    async def act(gid: str, req: ActionIn):
        s = get_session(gid)
        if s.mode != "play":
            raise HTTPException(409, "spectate games have no human player")

        def run():
            steps = s.human_act(req.action, auto=req.auto)
            return {"game_id": s.id, "steps": steps, "state": s.view()}

        return await locked(s, run)

    @app.post("/api/games/{gid}/advance")
    async def advance(gid: str, req: AdvanceIn):
        """Advance by bot moves: one step (streaming), to the end of the bout,
        or to the end. Never plays for the human."""
        s = get_session(gid)

        def run():
            if s.game.done:
                raise GameError(409, "game is over")
            if s.needs_human():
                raise GameError(409, "waiting for the human player")
            if req.until == "end":
                steps = s.run_bots()
            elif req.until == "bout":
                steps = s.run_bots(until_bout_end=True)
            else:
                steps = s.run_bots(max_steps=req.max_steps or 1)
            return {"game_id": s.id, "steps": steps, "state": s.view()}

        return await locked(s, run)

    @app.post("/api/games/{gid}/debug")
    async def debug(gid: str, req: DebugIn):
        s = get_session(gid)

        def run():
            s.debug_reveal = req.reveal
            s.debug_used = s.debug_used or req.reveal
            return {"game_id": s.id, "state": s.view()}

        return await locked(s, run)

    @app.get("/api/games/{gid}/evaluate")
    async def evaluate(gid: str):
        s = get_session(gid)
        return await locked(s, s.evaluate)

    @app.get("/api/games/{gid}/hint")
    async def hint(gid: str):
        s = get_session(gid)

        def run():
            out = compute_hint(s)
            s.hints_used += 1
            return out

        return await locked(s, run)

    @app.get("/api/games/{gid}/analysis")
    async def analysis(gid: str):
        s = get_session(gid)
        return await locked(s, lambda: get_analysis(s))

    @app.get("/api/games/{gid}/replay")
    async def replay(gid: str):
        s = get_session(gid)
        return await locked(s, lambda: get_replay(s))

    @app.get("/api/stats")
    async def stats():
        return await anyio.to_thread.run_sync(storage.stats)

    @app.get("/api/lab")
    async def lab_endpoint(run: str = "main"):
        def build():
            data = lab.lab_data(run)
            data["human"] = storage.timeline()
            return data

        return await anyio.to_thread.run_sync(build)

    @app.get("/api/art/hires")
    def art_hires():
        """Which hi-res (@2x/@3x) card art exists, so the client only puts
        files that are really there into <img srcset>."""
        roots = [DIST / "assets", ROOT / "web" / "public" / "assets"]
        probes = {"cards": "cards/AS", "cards4": "cards4/AS", "backs": "dacha/backs/gzhel"}

        def has(rel: str) -> bool:
            return any((r / rel).is_file() for r in roots)

        out = {}
        for k, base in probes.items():
            two = has(f"{base}@2x.webp")
            out[k] = [two, two and has(f"{base}@3x.webp")]
        return out

    # ------------------------------------------------------------ frontend
    @app.get("/api/{rest:path}")
    def api_404(rest: str):
        raise HTTPException(404, "unknown API endpoint")

    if (DIST / "assets").is_dir():
        static = StaticFiles(directory=DIST / "assets")
        # art that landed in web/public after the last build (e.g. @2x/@3x
        # card faces) is served too, so srcset picks it up without a rebuild
        public = ROOT / "web" / "public" / "assets"
        if public.is_dir() and public.resolve() != (DIST / "assets").resolve():
            static.all_directories.append(public)
        app.mount("/assets", static, name="assets")

    @app.get("/{rest:path}", include_in_schema=False)
    def spa(rest: str):
        target = (DIST / rest).resolve()
        if rest and target.is_file() and DIST.resolve() in target.parents:
            return FileResponse(target)
        index = DIST / "index.html"
        if index.is_file():
            return FileResponse(index, headers={"Cache-Control": "no-cache"})
        return JSONResponse(
            {"detail": "frontend not built; run `npm run build` in web/ (scripts/serve.sh does this)"},
            status_code=503,
        )

    return app


app = create_app()
