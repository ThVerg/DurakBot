"""End-to-end browser tests for the 2D "Dacha" table (DOM/SVG/CSS, no WebGL).

Starts uvicorn on a free port with a temporary database, plays full games for
2 and 5 players on desktop and phone (EN + RU) with *real* pointer clicks on
the card elements (hit-tested with elementFromPoint), the keyboard and
drag-and-drop, checks that hidden cards never reach the DOM, and exercises
the hint, replay & analysis, Lab, tutorial, settings, spectating and the debug
reveal. Screenshots go to server/data/screenshots/. Skipped if Playwright /
Chromium or the built frontend are missing.

Run: .venv/bin/python -m pytest tests/test_server_e2e.py -q
(DURAK_E2E_DIST=web/dist-next tests another build directory.)
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
DIST = Path(os.environ.get("DURAK_E2E_DIST", ROOT / "web" / "dist"))
if not DIST.is_absolute():
    DIST = ROOT / DIST

pw = pytest.importorskip("playwright.sync_api")

if not (DIST / "index.html").is_file():
    pytest.skip("frontend not built (cd web && npm run build)", allow_module_level=True)


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def server(tmp_path_factory):
    port = _free_port()
    env = dict(os.environ, DURAK_DB=str(tmp_path_factory.mktemp("db") / "e2e.db"), DURAK_DIST=str(DIST))
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
    p = {"speed": "fast", "tutorialDone": True, "lang": "en", "theme": "green", "back": "gzhel",
         "fourColor": False, "sound": False, "sort": "suit", "showWinProb": True}
    p.update(prefs)
    ctx = browser.new_context(**device)
    ctx.add_init_script(f"try{{localStorage.setItem('durak.prefs.v2', {json.dumps(json.dumps(p))})}}catch(e){{}}")
    page = ctx.new_page()
    page.set_default_timeout(60000)
    errors: list[str] = []

    def on_console(m):
        if m.type == "error" and "404" not in m.text:
            errors.append(m.text)

    page.on("console", on_console)
    page.on("pageerror", lambda e: errors.append(str(e)))
    return ctx, page, errors


TIERS = {"novice", "intermediate", "expert", "grandmaster"}


def start_game(page, url, n, seed, bot=None, spectate=False, seat=None):
    """Title screen -> lobby (players, seat, tier, Advanced) -> deal."""
    page.goto(url)
    page.wait_for_selector("[data-testid=title]")
    page.click("[data-testid=choose]")
    page.wait_for_selector("[data-testid=lobby]")
    page.click(f"[data-players='{n}']")
    if seat is not None:
        page.click(f"[data-seat-choice='{seat}']")
    if bot in TIERS:
        page.click(f"[data-tier='{bot}']")
    page.click("[data-testid=advanced]")
    page.wait_for_selector("#agent")
    if bot and bot not in TIERS:
        page.select_option("#agent", bot)
    page.fill("#seed", str(seed))
    if spectate:
        page.check("[data-testid=spectate]")
    page.click("[data-testid=adv-start]")
    page.wait_for_selector(".table-stage")


def over(page) -> bool:
    return page.locator("[data-testid=game-over], [data-testid=reveal]").count() > 0


def legal_cards(page) -> list[int]:
    return page.evaluate(
        "Array.from(document.querySelectorAll('.fc--hand.is-legal [data-testid^=hand-]')).map(b => +b.dataset.testid.slice(5))"
    )


VISIBLE_POINT = """(card) => {
  const b = document.querySelector(`[data-testid=hand-${card}]`);
  if (!b) return null;
  const r = b.getBoundingClientRect();
  for (const fy of [0.5, 0.3, 0.7, 0.15, 0.85])
    for (const fx of [0.12, 0.06, 0.25, 0.5, 0.75, 0.9]) {
      const x = r.left + r.width * fx, y = r.top + r.height * fy;
      const el = document.elementFromPoint(x, y);
      if (el && b.contains(el)) return { x, y };
    }
  return null;
}"""


def left_hand(page, card: int) -> bool:
    try:
        page.wait_for_function(f"!document.querySelector('[data-testid=hand-{card}]')", timeout=8000)
        return True
    except pw.Error:
        return False


def click_card(page, card: int) -> bool:
    """A real pointer click on the visible part of a hand card."""
    pt = page.evaluate(VISIBLE_POINT, card)
    if not pt:
        return False
    page.mouse.click(pt["x"], pt["y"])
    return left_hand(page, card)


def drag_card(page, card: int) -> bool:
    """Drag a hand card up onto the table and drop it."""
    pt = page.evaluate(VISIBLE_POINT, card)
    if not pt:
        return False
    page.mouse.move(pt["x"], pt["y"])
    page.mouse.down()
    for i in range(1, 13):
        page.mouse.move(pt["x"] - i * 3, pt["y"] - i * 24)
        page.wait_for_timeout(16)
    hot = page.locator(".dropslot.is-hot").count() > 0
    page.mouse.up()
    return left_hand(page, card) and hot


def assert_hidden_cards_private(page):
    """Opponents' unknown cards are anonymous backs: no card id in the DOM."""
    leaked = page.evaluate(
        "Array.from(document.querySelectorAll('.fc--opp[data-card]')).filter(e => !e.classList.contains('is-known')).length"
    )
    assert leaked == 0, "an opponent's hidden card reached the DOM"


def play_to_end(page, rng, tag, mid_after=4, hint_shot=False, deadline_s=900, use_keys=False, drags=0):
    SHOTS.mkdir(parents=True, exist_ok=True)
    moves = clicked = dragged = 0
    mid_done = False
    deadline = time.time() + deadline_s
    while time.time() < deadline and not over(page):
        if not page.locator(".table-stage.my-turn").count():
            page.wait_for_timeout(60)
            continue
        cards = legal_cards(page)
        can_pass = page.locator("[data-testid=pass]:not([disabled])").count() > 0
        options = cards + ([36] if can_pass else [])
        if not options:
            page.wait_for_timeout(60)
            continue
        assert_hidden_cards_private(page)
        a = rng.choice(options)
        if a == 36:
            if use_keys:
                page.keyboard.press(" ")
            else:
                page.locator("[data-testid=pass]").click(timeout=5000)
        elif use_keys and cards.index(a) < 9:
            page.keyboard.press(str(cards.index(a) + 1))
        elif dragged < drags and drag_card(page, a):
            dragged += 1
        elif click_card(page, a):
            clicked += 1
        moves += 1
        page.wait_for_timeout(80)
        if not mid_done and moves >= mid_after:
            page.wait_for_selector(".table-stage.my-turn, [data-testid=game-over], [data-testid=reveal]", timeout=120000)
            if not over(page):
                page.wait_for_timeout(700)
                page.screenshot(path=str(SHOTS / f"{tag}-midgame.png"))
                if hint_shot and page.locator("[data-testid=hint]:not([disabled])").count():
                    page.locator("[data-testid=hint]").click()
                    page.wait_for_selector("[data-testid=hint-play]", timeout=60000)
                    page.wait_for_timeout(400)
                    page.screenshot(path=str(SHOTS / f"{tag}-hint.png"))
                    page.locator("[data-testid=hint-play]").click()
                    moves += 1
            mid_done = True
    if page.locator("[data-testid=reveal]").count():
        page.wait_for_timeout(900)
        page.screenshot(path=str(SHOTS / f"{tag}-reveal.png"))
    page.wait_for_selector("[data-testid=game-over]", timeout=90000)
    page.wait_for_timeout(600)
    page.screenshot(path=str(SHOTS / f"{tag}-gameover.png"))
    return moves, clicked, dragged, page.locator("[data-testid=game-over]")


@pytest.mark.parametrize(
    "n,device,tag,prefs,keys,drags",
    [
        (2, DESKTOP, "desktop-2p-en", {}, False, 3),
        (5, DESKTOP, "desktop-5p-ru-cobalt", {"lang": "ru", "theme": "cobalt", "back": "khokhloma"}, True, 0),
        (2, MOBILE, "mobile-2p-en-vermilion", {"theme": "vermilion", "back": "stitch", "fourColor": True}, False, 2),
        (5, MOBILE, "mobile-5p-ru", {"lang": "ru"}, False, 0),
    ],
)
def test_play_full_game(server, browser, n, device, tag, prefs, keys, drags):
    ctx, page, errors = new_page(browser, device, **prefs)
    bot = "grandmaster" if n == 5 else "random"
    start_game(page, server, n, seed=100 + n, bot=bot)
    if prefs.get("lang") == "ru":
        page.wait_for_function("document.documentElement.lang === 'ru'")
    assert page.locator(".seat").count() == n - 1
    assert page.locator("canvas").count() == 0, "the table must be DOM, not WebGL"
    felt = prefs.get("theme", "green")
    src = page.locator(".tablebake").get_attribute("src")
    assert ("-" + felt in src) if felt != "green" else ("table-" in src and "-cobalt" not in src)
    moves, clicked, dragged, go = play_to_end(page, random.Random(n), tag, hint_shot=True, use_keys=keys, drags=drags)
    assert moves > 0
    if not keys:
        assert clicked > 0, "no card was played by clicking it"
    if drags:
        assert dragged > 0, "no card was played by dragging it"
    assert go.get_attribute("data-reason") in {"durak", "draw", "stalemate"}
    assert not errors, f"console errors: {errors}"
    ctx.close()


@pytest.mark.parametrize("device,tag", [(DESKTOP, "desktop"), (MOBILE, "mobile")])
def test_replay_and_analysis(server, browser, device, tag):
    ctx, page, errors = new_page(browser, device, speed="instant")
    start_game(page, server, 3 if tag == "desktop" else 2, seed=21, bot="random")
    play_to_end(page, random.Random(3), f"{tag}-instant", mid_after=10**9)
    page.locator("[data-testid=analyze]").click()
    page.wait_for_selector("[data-testid=replay]")
    page.wait_for_selector(".mistakes, .replay-acc, .replay-side p.muted", timeout=180000)
    page.fill("[data-testid=scrubber]", "0")
    page.wait_for_timeout(300)
    page.keyboard.press("ArrowRight")
    if page.locator("[data-testid=mistake]").count():
        page.locator("[data-testid=mistake]").first.click()
    page.wait_for_timeout(1200)
    page.screenshot(path=str(SHOTS / f"{tag}-replay.png"))
    page.locator("[data-testid=replay-close]").click()
    page.wait_for_selector("[data-testid=replay]", state="detached")
    page.wait_for_selector("[data-testid=again]")
    assert not errors, f"console errors: {errors}"
    ctx.close()


@pytest.mark.parametrize("lang", ["en", "ru"])
def test_title_lobby_and_lab(server, browser, lang):
    import httpx

    for device, dev in ((DESKTOP, "desktop"), (MOBILE, "mobile")):
        tag = f"{dev}-{lang}"
        ctx, page, errors = new_page(browser, device, lang=lang)
        page.goto(server)
        page.wait_for_selector("[data-testid=title]")
        page.wait_for_timeout(800)
        page.screenshot(path=str(SHOTS / f"{tag}-title.png"))
        # no horizontal overflow on phones
        assert page.evaluate("window.innerWidth") == device["viewport"]["width"]
        page.click("[data-testid=choose]")
        page.wait_for_selector("[data-testid=lobby]")
        page.click("[data-players='5']")
        page.click("[data-seat-choice='2']")
        page.click("[data-tier='expert']")
        page.wait_for_timeout(500)
        page.screenshot(path=str(SHOTS / f"{tag}-lobby.png"))
        assert page.locator("[data-tier='expert']").get_attribute("aria-checked") == "true"
        page.click("[data-testid=start-game]")
        page.wait_for_selector(".table-stage")
        gid = page.evaluate("localStorage.getItem('durak.gameId')")
        st = httpx.get(f"{server}/api/games/{gid}").json()["state"]
        assert st["human_seat"] == 2 and st["num_players"] == 5
        page.click("[data-testid=home]")
        page.wait_for_selector("[data-testid=continue]")
        if lang == "en":
            page.goto(server + "/#/lab")
            page.wait_for_selector(".lab-head")
            page.wait_for_timeout(1500)
            page.screenshot(path=str(SHOTS / f"{dev}-lab.png"))
        assert not errors, f"console errors: {errors}"
        ctx.close()


def test_tutorial_settings_and_toggles(server, browser):
    ctx, page, errors = new_page(browser, DESKTOP, tutorialDone=False)
    start_game(page, server, 3, seed=19)
    page.wait_for_selector("[data-testid=tutorial]", timeout=90000)
    page.wait_for_timeout(400)
    page.screenshot(path=str(SHOTS / "desktop-tutorial.png"))
    for _ in range(5):
        page.locator("[data-testid=tut-next]").click()
        page.wait_for_timeout(300)
    page.wait_for_selector("[data-testid=tutorial]", state="detached")
    assert json.loads(page.evaluate("localStorage.getItem('durak.prefs.v2')"))["tutorialDone"] is True
    page.locator("[data-testid=mute]").click()
    page.wait_for_function("document.querySelector('[data-testid=mute]').getAttribute('aria-pressed') === 'false'")
    page.locator("[data-testid=settings]").click()
    page.locator("[data-lang=ru]").click()
    page.wait_for_function("document.documentElement.lang === 'ru'")
    page.locator("[data-lang=en]").click()
    page.locator("[data-theme-choice=cobalt]").click()
    page.locator("[data-back-choice=khokhloma]").click()
    page.locator("[data-testid=four-color]").check()
    page.wait_for_function("document.documentElement.dataset.theme === 'cobalt' && document.documentElement.dataset.fourColor === 'on'")
    page.screenshot(path=str(SHOTS / "desktop-settings.png"))
    page.keyboard.press("Escape")
    page.wait_for_selector("[data-testid=settings-sheet]", state="detached")
    assert "cobalt" in page.locator(".tablebake").get_attribute("src")
    assert "khokhloma" in page.locator(".talonback").first.get_attribute("src")
    page.wait_for_timeout(600)
    page.screenshot(path=str(SHOTS / "desktop-cobalt-khokhloma.png"))
    page.keyboard.press("s")
    page.wait_for_selector("[data-testid=stats-sheet] .tiles")
    page.screenshot(path=str(SHOTS / "desktop-stats.png"))
    page.keyboard.press("Escape")
    page.keyboard.press("?")
    page.wait_for_selector("[data-testid=rules-sheet]")
    page.screenshot(path=str(SHOTS / "desktop-rules.png"))
    page.keyboard.press("Escape")
    page.keyboard.press("l")
    page.wait_for_selector(".log.is-open .log__list li")
    page.screenshot(path=str(SHOTS / "desktop-log.png"))
    page.keyboard.press("Escape")
    # debug reveal: opponents' hands become visible (and are flagged in stats)
    page.keyboard.press("d")
    page.wait_for_function("document.querySelectorAll('.fc--opp[data-card]').length > 0", timeout=30000)
    page.screenshot(path=str(SHOTS / "desktop-debug-reveal.png"))
    assert not errors, f"console errors: {errors}"
    ctx.close()


def test_dealing_spectate_and_skip(server, browser):
    ctx, page, errors = new_page(browser, DESKTOP, speed="slow")
    start_game(page, server, 4, seed=5)
    page.wait_for_timeout(900)
    page.screenshot(path=str(SHOTS / "desktop-dealing.png"))
    assert page.locator(".fc").count() > 20
    ctx.close()
    for device, dev in ((DESKTOP, "desktop"), (MOBILE, "mobile")):
        ctx, page, errors = new_page(browser, device)
        start_game(page, server, 4, seed=7, bot="intermediate", spectate=True)
        page.wait_for_timeout(2500)
        page.screenshot(path=str(SHOTS / f"{dev}-spectate.png"))
        assert page.locator(".fc--opp[data-card]").count() > 0  # bots' hands are shown when watching
        page.locator("[data-testid=to-end]").click()
        page.wait_for_selector("[data-testid=game-over]", timeout=240000)
        page.wait_for_timeout(500)
        page.screenshot(path=str(SHOTS / f"{dev}-spectate-over.png"))
        assert not errors, f"console errors: {errors}"
        ctx.close()


def test_bundle_is_light():
    """three.js and the WebGL scene are gone: the main bundle stays small."""
    js = list((DIST / "assets").glob("index-*.js"))
    assert js, "no main bundle"
    size = max(p.stat().st_size for p in js)
    assert size < 450_000, f"main bundle is {size} bytes"
    text = "".join(p.read_text(errors="ignore") for p in js)
    assert "WebGLRenderer" not in text


CRISP_JS = """() => {
  const dpr = window.devicePixelRatio;
  // real pixel width of the chosen file (naturalWidth is density-corrected with srcset)
  const intrinsic = (img) => {
    const u = img.currentSrc;
    if (/@3x[.]webp$/.test(u)) return 1536;
    if (/@2x[.]webp$/.test(u)) return 1024;
    return img.getAttribute('srcset') ? 512 : img.naturalWidth;
  };

  const out = { dpr, bad: [], checked: 0, scaled: [], filtered: [], promoted: [] };
  out.hand = Array.from(document.querySelectorAll('.fc--hand img.fc__face'))
    .filter((i) => i.complete && i.currentSrc).map((i) => (i.currentSrc.match(/@[23]x/) || ['1x'])[0]);
  for (const img of document.querySelectorAll('.fc--hand img.fc__face, .fc--table img.fc__face, .talonback')) {
    if (!img.complete || !img.naturalWidth) continue;
    out.checked++;
    const need = img.offsetWidth * dpr;
    const have = intrinsic(img);
    if (have + 1 < need) out.bad.push([img.currentSrc.split('/').pop(), have, Math.round(need)]);
    if (getComputedStyle(img).filter !== 'none') out.filtered.push(img.currentSrc);
  }
  for (const fc of document.querySelectorAll('.fc:not(.is-flying)')) {
    const m = new DOMMatrix(getComputedStyle(fc).transform);
    const s = Math.hypot(m.a, m.b);
    if (Math.abs(s - 1) > 0.001) out.scaled.push(s);
    if (getComputedStyle(fc).willChange !== 'auto') out.promoted.push(fc.dataset.card);
  }
  return out;
}"""


@pytest.mark.parametrize(
    "device,tag",
    [
        (dict(viewport={"width": 1440, "height": 900}, device_scale_factor=1), "desktop-1x"),
        (dict(viewport={"width": 1440, "height": 900}, device_scale_factor=2), "desktop-2x"),
        (dict(viewport={"width": 390, "height": 844}, device_scale_factor=3, is_mobile=True, has_touch=True), "phone-3x"),
    ],
)
def test_cards_are_crisp(server, browser, device, tag):
    """Hand/table faces get enough pixels for size x DPR; at rest there is no
    scale(), no filter and no layer promotion on cards. Saves corner crops."""
    from PIL import Image

    import httpx

    hires = httpx.get(f"{server}/api/art/hires").json()
    ctx, page, errors = new_page(browser, device)
    start_game(page, server, 3, seed=33, bot="random")
    rng = random.Random(7)
    checked = 0
    for _ in range(6):
        page.wait_for_selector(".table-stage.my-turn, [data-testid=game-over], [data-testid=reveal]", timeout=120000)
        if over(page):
            break
        page.wait_for_timeout(900)  # let every flight land
        r = page.evaluate(CRISP_JS)
        assert r["dpr"] == device["device_scale_factor"]
        assert not r["bad"], f"under-resolved card images: {r['bad']}"
        assert not r["filtered"], "a CSS filter is applied to a card bitmap"
        assert not r["scaled"], f"cards resting with a scale(): {r['scaled'][:5]}"
        assert not r["promoted"], "resting cards are still layer-promoted"
        if hires["cards"][0]:  # the hand uses the file matching the device pixel ratio
            want = {1: "1x", 2: "@2x", 3: "@3x" if hires["cards"][1] else "@2x"}[device["device_scale_factor"]]
            assert r["hand"] and set(r["hand"]) == {want}, f"hand art {set(r['hand'])}, expected {want}"
        checked += r["checked"]
        if _ == 0:  # zoomed crop of a hand card's corner index
            box = page.evaluate(
                "(() => { const i = document.querySelector('.fc--hand img.fc__face'); if (!i) return null;"
                " const r = i.getBoundingClientRect(); return {x: r.left, y: r.top, w: r.width, h: r.height}; })()"
            )
            if box:
                clip = {"x": max(0, box["x"] - 4), "y": max(0, box["y"] - 4), "width": min(90, box["w"]), "height": min(110, box["h"])}
                path = SHOTS / f"crisp-{tag}.png"
                page.screenshot(path=str(path), clip=clip)
                im = Image.open(path)
                im.resize((im.width * 3, im.height * 3), Image.NEAREST).save(path)
        cards = legal_cards(page)
        if cards:
            click_card(page, rng.choice(cards))
        elif page.locator("[data-testid=pass]:not([disabled])").count():
            page.locator("[data-testid=pass]").click()
    assert checked > 0
    assert not errors, f"console errors: {errors}"
    ctx.close()
