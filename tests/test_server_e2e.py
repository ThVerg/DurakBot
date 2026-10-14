"""End-to-end browser tests: drive real games in headless Chromium by clicking.

Starts uvicorn on a free port with a temporary database, plays full games for
2 and 5 players (desktop + mobile viewports) and saves screenshots to
server/data/screenshots/. Skipped if Playwright / Chromium or the built
frontend (web/dist) are missing.

Run: .venv/bin/python -m pytest tests/test_server_e2e.py -q
"""

from __future__ import annotations

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


def play_game(browser, url, n, ctx_kwargs, tag, seed, bot=None, debug_shot=False):
    SHOTS.mkdir(parents=True, exist_ok=True)
    ctx = browser.new_context(**ctx_kwargs)
    page = ctx.new_page()
    errors: list[str] = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(url)
    page.wait_for_selector("[data-testid=start-game]")
    page.click(f"[data-players='{n}']")
    if bot:
        page.select_option("#bot", bot)
    page.fill("#seed", str(seed))
    page.click("[data-testid=start-game]")
    page.wait_for_selector(".human-panel")
    page.select_option(".speed select", "fast")

    rng = random.Random(seed)
    clicks = 0
    mid_done = False
    deadline = time.time() + 600
    while time.time() < deadline:
        if page.locator("[data-testid=game-over]").count():
            break
        cards = page.locator(".hand-card.legal")
        btns = page.locator(".action-btn:not([disabled])")
        nc, nb = cards.count(), btns.count()
        if nc + nb == 0:
            page.wait_for_timeout(60)
            continue
        k = rng.randrange(nc + nb)
        use_keys = not ctx_kwargs.get("is_mobile") and rng.random() < 0.5
        try:
            if use_keys and k < min(nc, 9):
                page.keyboard.press(str(k + 1))  # numbered legal card
            elif use_keys and k >= nc and nb == 1:
                page.keyboard.press(" ")  # Bita / Pass / Take / Done
            elif k < nc:
                # Hand cards overlap: click the visible left strip of the card.
                cards.nth(k).click(position={"x": 4, "y": 30}, timeout=3000)
            else:
                btns.nth(k - nc).click(timeout=3000)
            clicks += 1
        except pw.Error:
            continue  # re-rendered while clicking; just look again
        if not mid_done and clicks >= 5:
            # Wait until it's our turn again so the screenshot shows a live table.
            page.wait_for_selector(".human-panel.my-turn, [data-testid=game-over]", timeout=60000)
            if not page.locator("[data-testid=game-over]").count():
                page.wait_for_timeout(300)
                page.screenshot(path=str(SHOTS / f"{tag}-midgame.png"))
                if debug_shot:
                    page.click("[data-testid=debug-toggle]")
                    page.wait_for_selector(".opp-hand.revealed")
                    page.screenshot(path=str(SHOTS / f"{tag}-debug-reveal.png"))
                    page.click("[data-testid=debug-toggle]")
                    page.wait_for_selector(".opp-hand.revealed", state="detached")
                mid_done = True
    page.wait_for_selector("[data-testid=game-over]", timeout=60000)
    page.wait_for_timeout(500)
    headline = page.locator("[data-testid=game-over]").inner_text()
    page.screenshot(path=str(SHOTS / f"{tag}-gameover.png"))
    assert "durak" in headline.lower() or "escaped" in headline.lower() or "first" in headline.lower() or "draw" in headline.lower()
    # Close the dialog: the final table and full log are visible.
    page.keyboard.press("Escape")
    assert not errors, f"console errors: {errors}"
    ctx.close()
    return clicks, headline


@pytest.mark.parametrize(
    "n,device,tag,debug",
    [
        (2, DESKTOP, "desktop-2p", False),
        (5, DESKTOP, "desktop-5p", True),
        (2, MOBILE, "mobile-2p", False),
        (5, MOBILE, "mobile-5p", False),
    ],
)
def test_play_full_game_by_clicking(server, browser, n, device, tag, debug):
    clicks, headline = play_game(browser, server, n, device, tag, seed=100 + n, debug_shot=debug)
    assert clicks > 0
    assert (SHOTS / f"{tag}-gameover.png").is_file()


def test_stats_and_rules_dialogs(server, browser):
    ctx = browser.new_context(**DESKTOP)
    page = ctx.new_page()
    page.goto(server)
    page.wait_for_selector("[data-testid=start-game]")
    page.keyboard.press("Escape")
    page.click("text=Stats")
    page.wait_for_selector(".stats table")
    page.screenshot(path=str(SHOTS / "desktop-stats.png"))
    page.keyboard.press("Escape")
    page.click("text=Rules")
    page.wait_for_selector(".rules")
    page.screenshot(path=str(SHOTS / "desktop-rules.png"))
    ctx.close()


def test_spectate_mode(server, browser):
    ctx = browser.new_context(**DESKTOP)
    page = ctx.new_page()
    page.goto(server)
    page.wait_for_selector("[data-testid=start-game]")
    page.click("text=Watch bots")
    page.click("[data-players='4']")
    page.fill("#seed", "7")
    page.click("[data-testid=start-game]")
    page.wait_for_selector(".human-panel")
    page.select_option(".speed select", "fast")
    page.wait_for_timeout(2500)
    page.screenshot(path=str(SHOTS / "desktop-spectate.png"))
    page.click("text=To end")
    page.wait_for_selector("[data-testid=game-over]", timeout=120000)
    ctx.close()
