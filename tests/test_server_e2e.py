"""End-to-end browser tests for the 3D casino table (WebGL via SwiftShader).

Starts uvicorn on a free port with a temporary database, plays full games for
2 and 5 players on desktop and mobile by clicking cards *through the 3D scene*
(raycasting, using window.__durakTest to find each card's screen position),
checks the WebGL canvas actually renders, exercises the hint, replay, Lab,
tutorial, settings and the 2D fallback, and saves screenshots to
server/data/screenshots/. Skipped if Playwright / Chromium or the built
frontend (web/dist) are missing.

Run: .venv/bin/python -m pytest tests/test_server_e2e.py -q
"""

from __future__ import annotations

import io
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

GL_ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]


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
            b = p.chromium.launch(args=GL_ARGS)
        except Exception as e:  # pragma: no cover
            pytest.skip(f"chromium unavailable: {e}")
        yield b
        b.close()


DESKTOP = dict(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
MOBILE = dict(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)


def new_page(browser, device, **prefs):
    p = {"speed": "fast", "tutorialDone": True, "lang": "en", "theme": "felt", "back": "classic",
         "fourColor": False, "sound": False, "sort": "suit", "showWinProb": True, "quality": "low"}
    p.update(prefs)
    ctx = browser.new_context(**device)
    ctx.add_init_script(f"try{{localStorage.setItem('durak.prefs.v2', {json.dumps(json.dumps(p))})}}catch(e){{}}")
    page = ctx.new_page()
    page.set_default_timeout(90000)  # SwiftShader renders WebGL on the CPU
    errors: list[str] = []

    def on_console(m):
        # asset probes may 404 harmlessly; everything else is an error
        if m.type == "error" and "404" not in m.text:
            errors.append(m.text)

    page.on("console", on_console)
    page.on("pageerror", lambda e: errors.append(str(e)))
    return ctx, page, errors


TIER_AGENTS = {"novice", "intermediate", "expert", "grandmaster"}


def tap(page, sel):
    """Click via a DOM event (no pointer hit-testing): robust while the
    CPU-rendered WebGL page is busy and on mobile with fixed overlays."""
    page.wait_for_selector(sel, state="attached")
    page.locator(sel).first.dispatch_event("click")


def start_game(page, url, n, seed, bot=None, spectate=False, three_d=True):
    """Title screen -> lobby -> deal."""
    page.goto(url)
    page.wait_for_selector("[data-testid=title]")
    tap(page, "[data-testid=choose]")
    page.wait_for_selector("[data-testid=lobby]")
    tap(page, f"[data-players='{n}']")
    if bot in TIER_AGENTS:
        tap(page, f".tier-card[data-bot='{bot}']")
    tap(page, "[data-testid=advanced]")
    page.wait_for_selector("#agent", state="attached")
    if bot and bot not in TIER_AGENTS:
        page.select_option("#agent", bot, force=True)
    page.fill("#seed", str(seed), force=True)
    if spectate:
        tap(page, "[data-testid=spectate]")
    tap(page, "[data-testid=start-game]")
    if three_d:
        page.wait_for_selector(".scene-layer canvas", timeout=60000)
        page.wait_for_function("window.__durakTest && window.__durakTest.ready", timeout=60000)
        page.wait_for_selector("[data-testid=play-area]", timeout=60000)
    else:
        page.wait_for_selector(".human-panel")


def canvas_not_blank(page) -> bool:
    from PIL import Image

    png = page.locator("canvas").first.screenshot(timeout=180000)
    img = Image.open(io.BytesIO(png)).convert("RGB").resize((96, 60))
    px = list(img.getdata())
    lum = [0.299 * r + 0.587 * g + 0.114 * b for r, g, b in px]
    mean = sum(lum) / len(lum)
    var = sum((x - mean) ** 2 for x in lum) / len(lum)
    return mean > 8 and var > 60


def legal_cards(page) -> list[int]:
    return page.evaluate(
        "Array.from(document.querySelectorAll('[data-testid^=hand-card-]')).map(b => +b.dataset.testid.slice(10))"
    )


def over(page) -> bool:
    return page.locator("[data-testid=game-over], [data-testid=reveal]").count() > 0


def click_card_3d(page, card: int) -> bool:
    """Click a hand card through the WebGL canvas (raycast) and confirm it left the hand."""
    pt = page.evaluate(f"window.__durakTest.cardScreen({card})")
    if not pt:
        return False
    page.mouse.move(pt["x"], pt["y"])
    page.wait_for_timeout(60)
    page.mouse.down()
    page.mouse.up()
    try:
        page.wait_for_function(f"window.__durakTest.zone({card}) !== 'hand'", timeout=8000)
        return True
    except pw.Error:
        return False


def play_to_end(page, rng, tag, mid_after=4, hint_shot=False, deadline_s=1200, use_keys=False):
    SHOTS.mkdir(parents=True, exist_ok=True)
    moves = raycast_ok = 0
    mid_done = False
    deadline = time.time() + deadline_s
    while time.time() < deadline and not over(page):
        if not page.locator(".stage.my-turn").count():
            page.wait_for_timeout(80)
            continue
        cards = legal_cards(page)
        can_pass = page.locator("[data-testid=pass]:not([disabled])").count() > 0
        options = cards + ([36] if can_pass else [])
        if not options:
            page.wait_for_timeout(80)
            continue
        a = rng.choice(options)
        if a == 36:
            if use_keys:
                page.keyboard.press(" ")
            else:
                page.locator("[data-testid=pass]").click(force=True, timeout=5000)
        elif use_keys and cards.index(a) < 9:
            page.keyboard.press(str(cards.index(a) + 1))
        else:
            if click_card_3d(page, a):
                raycast_ok += 1
            else:  # fall back to the accessible button (keeps the game going)
                if page.locator(f"[data-testid=hand-card-{a}]").count():
                    page.locator(f"[data-testid=hand-card-{a}]").click(force=True)
        moves += 1
        page.wait_for_timeout(120)
        if not mid_done and moves >= mid_after:
            page.wait_for_selector(".stage.my-turn, [data-testid=game-over], [data-testid=reveal]", timeout=120000)
            if not over(page):
                page.wait_for_timeout(900)
                page.screenshot(path=str(SHOTS / f"{tag}-midgame.png"), timeout=180000)
                assert canvas_not_blank(page), "WebGL canvas looks blank"
                if hint_shot and page.locator("[data-testid=hint]:not([disabled])").count():
                    page.locator("[data-testid=hint]").click(force=True)
                    page.wait_for_selector(".hint-rec", timeout=60000)
                    page.wait_for_timeout(500)
                    page.screenshot(path=str(SHOTS / f"{tag}-hint.png"), timeout=180000)
                    page.locator("[data-testid=hint-play]").click(force=True)
                    moves += 1
            mid_done = True
    if page.locator("[data-testid=reveal]").count():
        page.wait_for_timeout(1100)
        page.screenshot(path=str(SHOTS / f"{tag}-reveal.png"), timeout=180000)
    page.wait_for_selector("[data-testid=game-over]", timeout=90000)
    page.wait_for_timeout(500)
    page.screenshot(path=str(SHOTS / f"{tag}-gameover.png"), timeout=180000)
    return moves, raycast_ok, page.locator("[data-testid=game-over]")


@pytest.mark.parametrize(
    "n,device,tag,prefs,keys",
    [
        (2, DESKTOP, "desktop-2p", {"quality": "medium"}, False),
        (5, DESKTOP, "desktop-5p-burgundy", {"theme": "kitchen", "back": "khokhloma", "quality": "medium"}, True),
        (2, MOBILE, "mobile-2p-royal", {"theme": "modern", "back": "navy", "fourColor": True}, False),
        (5, MOBILE, "mobile-5p-charcoal-ru", {"theme": "casino", "back": "gzhel", "lang": "ru"}, False),
    ],
)
def test_play_full_game_3d(server, browser, n, device, tag, prefs, keys):
    ctx, page, errors = new_page(browser, device, **prefs)
    bot = "champion_fast" if n == 5 else "random"
    start_game(page, server, n, seed=100 + n, bot=bot)
    if prefs.get("lang") == "ru":
        page.wait_for_function("document.documentElement.lang === 'ru'")
    moves, raycast_ok, go = play_to_end(page, random.Random(n), tag, hint_shot=True, use_keys=keys)
    assert moves > 0
    if not keys:
        assert raycast_ok > 0, "no card was played by clicking the 3D scene"
    assert go.get_attribute("data-reason") in {"durak", "draw", "stalemate"}
    assert not errors, f"console errors: {errors}"
    ctx.close()


def test_replay_3d(server, browser):
    ctx, page, errors = new_page(browser, DESKTOP, speed="instant")
    start_game(page, server, 3, seed=21, bot="random")
    play_to_end(page, random.Random(3), "desktop-3p-instant", mid_after=10**9)
    page.locator("[data-testid=analyze]").click(force=True)
    page.wait_for_selector("[data-testid=replay]")
    page.wait_for_selector(".mistakes, .replay-acc, .replay-side p.muted", timeout=180000)
    page.fill("[data-testid=scrubber]", "0")
    page.wait_for_timeout(300)
    page.keyboard.press("ArrowRight")
    if page.locator("[data-testid=mistake]").count():
        page.locator("[data-testid=mistake]").first.click()
    page.wait_for_timeout(1200)
    page.screenshot(path=str(SHOTS / "desktop-replay.png"), timeout=180000)
    page.locator("[data-testid=replay-close]").click(force=True)
    page.wait_for_selector("[data-testid=replay]", state="detached")
    assert not errors, f"console errors: {errors}"
    ctx.close()


def test_mobile_replay(server, browser):
    ctx, page, errors = new_page(browser, MOBILE, speed="instant")
    start_game(page, server, 2, seed=5, bot="random")
    play_to_end(page, random.Random(9), "mobile-2p-instant", mid_after=10**9)
    page.locator("[data-testid=analyze]").click(force=True)
    page.wait_for_selector("[data-testid=replay]")
    page.wait_for_selector(".mistakes, .replay-acc, .replay-side p.muted", timeout=180000)
    page.wait_for_timeout(1200)
    page.screenshot(path=str(SHOTS / "mobile-replay.png"), timeout=180000)
    assert not errors
    ctx.close()


@pytest.mark.parametrize("lang", ["en", "ru"])
def test_title_lobby_and_lab(server, browser, lang):
    for device, dev in ((DESKTOP, "desktop"), (MOBILE, "mobile")):
        tag = f"{dev}-{lang}"
        ctx, page, errors = new_page(browser, device, quality="medium", lang=lang)
        page.goto(server)
        page.wait_for_selector("[data-testid=title]")
        page.wait_for_timeout(3000)
        page.screenshot(path=str(SHOTS / f"{tag}-title.png"), timeout=180000)
        assert canvas_not_blank(page)
        tap(page, "[data-testid=choose]")
        page.wait_for_selector("[data-testid=lobby]")
        page.wait_for_timeout(1200)
        tap(page, "[data-players='5']")
        tap(page, "[data-seat-choice='2']")
        page.wait_for_timeout(1500)
        page.screenshot(path=str(SHOTS / f"{tag}-lobby.png"), timeout=180000)
        page.keyboard.press("Escape")
        page.wait_for_selector("[data-testid=title]")
        if lang == "en":
            page.goto(server + "/#/lab")
            page.wait_for_selector(".lab-head")
            page.wait_for_timeout(1200)
            page.screenshot(path=str(SHOTS / f"{dev}-lab.png"), timeout=180000)
        assert page.locator("[data-testid=lobby]").count() == 0
        assert not errors, f"console errors: {errors}"
        ctx.close()


def test_tutorial_settings_and_toggles(server, browser):
    ctx, page, errors = new_page(browser, DESKTOP, tutorialDone=False)
    start_game(page, server, 3, seed=19)
    page.wait_for_selector("[data-testid=tutorial]", timeout=90000)
    page.wait_for_timeout(400)
    page.screenshot(path=str(SHOTS / "desktop-tutorial.png"), timeout=180000)
    for _ in range(5):
        page.locator("[data-testid=tut-next]").click(force=True)
        page.wait_for_timeout(400)
    page.wait_for_selector("[data-testid=tutorial]", state="detached")
    page.locator("[data-testid=mute]").click(force=True)
    page.wait_for_function("document.querySelector('[data-testid=mute]').getAttribute('aria-pressed') === 'false'")
    page.locator("[data-testid=lang]").click(force=True)
    page.wait_for_function("document.documentElement.lang === 'ru'")
    page.locator("[data-testid=lang]").click(force=True)
    page.locator("[data-testid=settings]").click(force=True)
    page.locator("[data-theme-choice=modern]").click(force=True)
    page.locator("[data-back-choice=gzhel]").click(force=True)
    page.locator("[data-testid=four-color]").check(force=True)
    page.wait_for_function("document.documentElement.dataset.theme === 'modern' && document.documentElement.dataset.fourColor === 'on'")
    page.screenshot(path=str(SHOTS / "desktop-settings.png"), timeout=180000)
    page.keyboard.press("Escape")
    page.wait_for_timeout(1200)
    page.screenshot(path=str(SHOTS / "desktop-theme-royal-gzhel.png"), timeout=180000)
    page.locator("text=Stats").click(force=True)
    page.wait_for_selector(".stats .stat-tiles")
    page.screenshot(path=str(SHOTS / "desktop-stats.png"), timeout=180000)
    page.keyboard.press("Escape")
    page.locator("text=Rules").click(force=True)
    page.wait_for_selector(".rules")
    page.keyboard.press("Escape")
    assert not errors, f"console errors: {errors}"
    ctx.close()


def test_dealing_spectate_and_2d_fallback(server, browser):
    ctx, page, errors = new_page(browser, DESKTOP, speed="slow")
    start_game(page, server, 4, seed=5)
    page.wait_for_timeout(1300)
    page.screenshot(path=str(SHOTS / "desktop-dealing.png"), timeout=180000)
    assert canvas_not_blank(page)
    ctx.close()
    ctx, page, errors = new_page(browser, DESKTOP)
    start_game(page, server, 4, seed=7, bot="heuristic", spectate=True)
    page.wait_for_timeout(3000)
    page.screenshot(path=str(SHOTS / "desktop-spectate.png"), timeout=180000)
    page.locator("text=To end").click(force=True)
    page.wait_for_selector("[data-testid=game-over]", timeout=240000)
    assert not errors, f"console errors: {errors}"
    ctx.close()
    # classic 2D layout (also what browsers without WebGL get)
    ctx, page, errors = new_page(browser, DESKTOP, quality="2d")
    start_game(page, server, 2, seed=3, bot="random", three_d=False)
    rng = random.Random(1)
    for _ in range(6):
        page.wait_for_selector(".human-panel.my-turn, [data-testid=game-over], [data-testid=reveal]", timeout=60000)
        if over(page):
            break
        n_legal = page.locator(".hand-card.legal").count()
        if n_legal:
            page.locator(".hand-card.legal").nth(rng.randrange(n_legal)).dispatch_event("click")
        elif page.locator("[data-testid=pass]:not([disabled])").count():
            page.locator("[data-testid=pass]").dispatch_event("click")
        page.wait_for_timeout(400)
    page.screenshot(path=str(SHOTS / "desktop-2d-fallback.png"), timeout=180000)
    assert not errors, f"console errors: {errors}"
    ctx.close()
