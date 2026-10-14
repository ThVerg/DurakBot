"""End-to-end browser tests: drive real games in headless Chromium by clicking.

Starts uvicorn on a free port with a temporary database, plays full games for
2 and 5 players (desktop + mobile, several themes, English + Russian), uses
the hint, opens the replay/analysis and the Lab page, and saves screenshots to
server/data/screenshots/. Skipped if Playwright / Chromium or the built
frontend (web/dist) are missing.

Run: .venv/bin/python -m pytest tests/test_server_e2e.py -q
"""

from __future__ import annotations

import json
import os
import random
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / "server" / "data" / "screenshots"

pw = pytest.importorskip("playwright.sync_api")

if not (ROOT / "web" / "dist" / "index.html").is_file():
    pytest.skip("frontend not built (cd web && npm run build)", allow_module_level=True)


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def server(tmp_path_factory):
    port = _free_port()
    env = dict(os.environ, DURAK_DB=str(tmp_path_factory.mktemp("db") / "e2e.db"))
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "server.app:app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=ROOT,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.STDOUT,
    )
    url = f"http://127.0.0.1:{port}"
    import httpx

    for _ in range(100):
        try:
            if httpx.get(url + "/api/health", timeout=1).status_code == 200:
                break
        except httpx.HTTPError:
            time.sleep(0.2)
    else:
        proc.kill()
        pytest.fail("server did not start")
    yield url
    proc.terminate()
    proc.wait(10)


@pytest.fixture(scope="module")
def browser():
    with pw.sync_playwright() as p:
        try:
            b = p.chromium.launch()
        except Exception as e:  # pragma: no cover
            pytest.skip(f"chromium unavailable: {e}")
        yield b
        b.close()


DESKTOP = dict(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
MOBILE = dict(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)


def new_page(browser, device, **prefs):
    p = {"speed": "fast", "tutorialDone": True, "lang": "en", "theme": "felt", "back": "classic",
         "fourColor": False, "sound": False, "sort": "suit", "showWinProb": True}
    p.update(prefs)
    ctx = browser.new_context(**device)
    ctx.add_init_script(f"try{{localStorage.setItem('durak.prefs.v2', {json.dumps(json.dumps(p))})}}catch(e){{}}")
    page = ctx.new_page()
    errors: list[str] = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    return ctx, page, errors


def start_game(page, url, n, seed, bot=None, spectate=False):
    page.goto(url)
    page.wait_for_selector("[data-testid=start-game]")
    if spectate:
        page.click(".newgame .seg button >> nth=1")
    page.click(f"[data-players='{n}']")
    if bot:
        page.click(f"[data-bot='{bot}']")
    page.fill("#seed", str(seed))
    page.click("[data-testid=start-game]")
    page.wait_for_selector(".human-panel")


def click_move(page, rng, use_keys=False) -> bool:
    """Make one random legal move (mouse or keyboard). False if none available yet."""
    cards = page.locator(".hand-card.legal")
    btn = page.locator("[data-testid=pass]:not([disabled])")
    nc, nb = cards.count(), btn.count()
    if nc + nb == 0:
        return False
    k = rng.randrange(nc + nb)
    try:
        if use_keys and k < min(nc, 9):
            page.keyboard.press(str(k + 1))
        elif use_keys and k >= nc:
            page.keyboard.press(" ")
        elif k < nc:
            cards.nth(k).click(position={"x": 6, "y": 30}, timeout=3000)
        else:
            btn.first.click(timeout=3000)
        return True
    except pw.Error:
        return False


def over(page) -> bool:
    return page.locator("[data-testid=game-over], [data-testid=reveal]").count() > 0


def play_to_end(page, rng, tag, mid_after=5, use_keys=False, hint_shot=False, deadline_s=900):
    SHOTS.mkdir(parents=True, exist_ok=True)
    clicks = 0
    mid_done = False
    deadline = time.time() + deadline_s
    while time.time() < deadline and not over(page):
        if not click_move(page, rng, use_keys=use_keys and rng.random() < 0.5):
            page.wait_for_timeout(60)
            continue
        clicks += 1
        if not mid_done and clicks >= mid_after:
            page.wait_for_selector(".human-panel.my-turn, [data-testid=game-over], [data-testid=reveal]", timeout=120000)
            if not over(page):
                page.wait_for_timeout(500)
                page.screenshot(path=str(SHOTS / f"{tag}-midgame.png"))
                if hint_shot and page.locator("[data-testid=hint]:not([disabled])").count():
                    page.click("[data-testid=hint]")
                    page.wait_for_selector(".hint-rec", timeout=60000)
                    page.wait_for_timeout(300)
                    page.screenshot(path=str(SHOTS / f"{tag}-hint.png"))
                    # play the coach's recommendation
                    page.click("[data-testid=hint-play]")
                    clicks += 1
            mid_done = True
    if page.locator("[data-testid=reveal]").count():
        page.wait_for_timeout(1000)
        page.screenshot(path=str(SHOTS / f"{tag}-reveal.png"))
    page.wait_for_selector("[data-testid=game-over]", timeout=60000)
    page.wait_for_timeout(400)
    page.screenshot(path=str(SHOTS / f"{tag}-gameover.png"))
    return clicks, page.locator("[data-testid=game-over]")


@pytest.mark.parametrize(
    "n,device,tag,prefs,keys",
    [
        (2, DESKTOP, "desktop-2p-felt", {}, True),
        (5, DESKTOP, "desktop-5p-kitchen", {"theme": "kitchen", "back": "khokhloma"}, True),
        (2, MOBILE, "mobile-2p-modern", {"theme": "modern", "back": "navy", "fourColor": True}, False),
        (5, MOBILE, "mobile-5p-casino-ru", {"theme": "casino", "back": "gzhel", "lang": "ru"}, False),
    ],
)
def test_play_full_game_by_clicking(server, browser, n, device, tag, prefs, keys):
    ctx, page, errors = new_page(browser, device, **prefs)
    bot = "champion_fast" if n == 5 else None  # keep the 5-player games quick
    start_game(page, server, n, seed=100 + n, bot=bot)
    if prefs.get("lang") == "ru":
        assert "Ходы" in page.content() or "Новая" in page.content()
    clicks, go = play_to_end(page, random.Random(n), tag, use_keys=keys, hint_shot=True)
    assert clicks > 0
    assert go.get_attribute("data-reason") in {"durak", "draw", "stalemate"}
    assert not errors, f"console errors: {errors}"
    ctx.close()


def test_replay_and_analysis(server, browser):
    ctx, page, errors = new_page(browser, DESKTOP, speed="instant")
    start_game(page, server, 3, seed=21, bot="random")
    play_to_end(page, random.Random(3), "desktop-3p-instant", mid_after=10**9)
    page.click("[data-testid=analyze]")
    page.wait_for_selector("[data-testid=replay]")
    page.wait_for_selector(".mistakes, .replay-acc, .replay-side p.muted", timeout=180000)
    # scrub to the start and back
    page.fill("[data-testid=scrubber]", "0")
    page.wait_for_timeout(200)
    page.keyboard.press("ArrowRight")
    if page.locator("[data-testid=mistake]").count():
        page.locator("[data-testid=mistake]").first.click()
    page.wait_for_timeout(500)
    page.screenshot(path=str(SHOTS / "desktop-replay.png"))
    page.click("[data-testid=replay-close]")
    page.wait_for_selector("[data-testid=replay]", state="detached")
    assert not errors, f"console errors: {errors}"
    ctx.close()


def test_mobile_replay(server, browser):
    ctx, page, errors = new_page(browser, MOBILE, speed="instant")
    start_game(page, server, 2, seed=5, bot="random")
    play_to_end(page, random.Random(9), "mobile-2p-instant", mid_after=10**9)
    page.click("[data-testid=analyze]")
    page.wait_for_selector("[data-testid=replay]")
    page.wait_for_selector(".mistakes, .replay-acc, .replay-side p.muted", timeout=180000)
    page.wait_for_timeout(400)
    page.screenshot(path=str(SHOTS / "mobile-replay.png"))
    assert not errors
    ctx.close()


def test_lab_page(server, browser):
    for device, tag in ((DESKTOP, "desktop"), (MOBILE, "mobile")):
        ctx, page, errors = new_page(browser, device)
        page.goto(server + "/#/lab")
        page.wait_for_selector(".lab-head")
        page.wait_for_timeout(1200)
        page.screenshot(path=str(SHOTS / f"{tag}-lab.png"))
        # no new-game dialog over the Lab
        assert page.locator("[data-testid=start-game]").count() == 0
        assert not errors, f"console errors: {errors}"
        ctx.close()


def test_tutorial_settings_and_toggles(server, browser):
    ctx, page, errors = new_page(browser, DESKTOP, tutorialDone=False)
    start_game(page, server, 3, seed=19)
    page.wait_for_selector("[data-testid=tutorial]", timeout=90000)
    page.screenshot(path=str(SHOTS / "desktop-tutorial.png"))
    for _ in range(5):
        page.click("[data-testid=tut-next]")
    page.wait_for_selector("[data-testid=tutorial]", state="detached")
    # mute + language toggles
    page.click("[data-testid=mute]")
    assert page.get_attribute("[data-testid=mute]", "aria-pressed") == "false"
    page.click("[data-testid=lang]")
    page.wait_for_function("document.documentElement.lang === 'ru'")
    page.wait_for_selector("button:has-text('Статистика')", timeout=10000)
    page.click("[data-testid=lang]")
    # settings: theme + four-colour deck
    page.click("[data-testid=settings]")
    page.click("[data-theme-choice=modern]")
    page.click("[data-back-choice=gzhel]")
    page.check("[data-testid=four-color]")
    assert page.evaluate("document.documentElement.dataset.theme") == "modern"
    assert page.evaluate("document.documentElement.dataset.fourColor") == "on"
    page.screenshot(path=str(SHOTS / "desktop-settings.png"))
    page.keyboard.press("Escape")
    page.click("text=Stats")
    page.wait_for_selector(".stats .stat-tiles")
    page.screenshot(path=str(SHOTS / "desktop-stats.png"))
    page.keyboard.press("Escape")
    page.click("text=Rules")
    page.wait_for_selector(".rules")
    page.screenshot(path=str(SHOTS / "desktop-rules.png"))
    assert not errors, f"console errors: {errors}"
    ctx.close()


def test_dealing_and_spectate(server, browser):
    ctx, page, errors = new_page(browser, DESKTOP, speed="slow")
    start_game(page, server, 4, seed=5)
    page.wait_for_timeout(1700)
    page.screenshot(path=str(SHOTS / "desktop-dealing.png"))
    ctx.close()
    ctx, page, errors = new_page(browser, DESKTOP)
    start_game(page, server, 4, seed=7, bot="heuristic", spectate=True)
    page.wait_for_timeout(3000)
    page.screenshot(path=str(SHOTS / "desktop-spectate.png"))
    page.click("text=To end")
    page.wait_for_selector("[data-testid=game-over]", timeout=240000)
    assert not errors, f"console errors: {errors}"
    ctx.close()
