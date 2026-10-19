"""End-to-end browser tests for the static (GitHub Pages) build.

Builds web/ with VITE_BACKEND=local and base /DurakBot/ into web/dist-static,
serves it with `vite preview` (no Python server at all) and plays full games
in Chromium: 2 and 5 players, desktop and phone, EN and RU, with real pointer
clicks and drags, the hint (champion values), win %, replay & analysis,
stats (persisted in IndexedDB across reloads), resuming a game after a reload,
spectating, the debug reveal and the Lab. Checks that nothing calls /api,
nothing 404s, every request stays under /DurakBot/, bots think in a Web Worker
and hidden cards never reach the DOM. Screenshots: server/data/screenshots/static-*.

Run: .venv/bin/python -m pytest tests/test_static_e2e.py -q
(DURAK_STATIC_DIST=<dir> tests an existing build instead of building.)
"""

from __future__ import annotations

import json
import os
import random
import shutil
import signal
import socket
import subprocess
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
SHOTS = ROOT / "server" / "data" / "screenshots"
BASE = "/DurakBot/"

pw = pytest.importorskip("playwright.sync_api")

if not shutil.which("npx") or not (WEB / "node_modules" / "vite").is_dir():
    pytest.skip("node/vite not available (cd web && npm ci)", allow_module_level=True)


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def site():
    env = dict(os.environ, VITE_BACKEND="local", VITE_BASE=BASE)
    given = os.environ.get("DURAK_STATIC_DIST")
    dist = Path(given) if given else WEB / "dist-static"
    if not dist.is_absolute():
        dist = ROOT / dist
    if not given:
        subprocess.run(
            ["npx", "vite", "build", "--outDir", str(dist), "--emptyOutDir", "--logLevel", "warn"],
            cwd=WEB, env=env, check=True, timeout=600,
        )
    if not (dist / "index.html").is_file():
        pytest.skip(f"no static build in {dist}")
    port = _free_port()
    proc = subprocess.Popen(
        ["npx", "vite", "preview", "--outDir", str(dist), "--port", str(port), "--strictPort", "--host", "127.0.0.1"],
        cwd=WEB, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT,
        start_new_session=True,  # npx spawns node: stop the whole group
    )

    def stop():
        try:
            os.killpg(proc.pid, signal.SIGTERM)
            proc.wait(10)
        except (ProcessLookupError, subprocess.TimeoutExpired):  # pragma: no cover
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    url = f"http://127.0.0.1:{port}{BASE}"
    import httpx

    for _ in range(150):
        try:
            if httpx.get(url, timeout=1).status_code == 200:
                break
        except httpx.HTTPError:
            pass
        time.sleep(0.2)
    else:
        stop()
        pytest.fail("vite preview did not start")
    yield url
    stop()


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
TIERS = {"novice", "intermediate", "expert", "grandmaster"}


class Net:
    """Every request/response of a page: nothing may hit /api or fail."""

    def __init__(self, page, origin: str):
        self.origin = origin
        self.api: list[str] = []
        self.failed: list[str] = []
        self.outside: list[str] = []
        page.on("request", self._req)
        page.on("response", self._resp)
        page.on("requestfailed", lambda r: self.failed.append(f"failed {r.url}"))

    def _req(self, r):
        u = r.url
        if u.startswith("data:") or u.startswith("blob:"):
            return
        if "/api/" in u:
            self.api.append(u)
        if not u.startswith(self.origin + BASE):
            self.outside.append(u)

    def _resp(self, r):
        if r.status >= 400:
            self.failed.append(f"{r.status} {r.url}")

    def check(self):
        assert not self.api, f"the static build called the API: {self.api[:5]}"
        assert not self.failed, f"failed requests: {self.failed[:5]}"
        assert not self.outside, f"requests outside {BASE}: {self.outside[:5]}"


def new_page(browser, site, device, **prefs):
    p = {"speed": "fast", "tutorialDone": True, "lang": "en", "theme": "green", "back": "gzhel",
         "fourColor": False, "sound": False, "sort": "suit", "showWinProb": True}
    p.update(prefs)
    ctx = browser.new_context(**device)
    ctx.add_init_script(f"try{{localStorage.setItem('durak.prefs.v2', {json.dumps(json.dumps(p))})}}catch(e){{}}")
    page = ctx.new_page()
    page.set_default_timeout(60000)
    errors: list[str] = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    origin = site.split(BASE)[0]
    return ctx, page, errors, Net(page, origin)


def start_game(page, url, n, seed=None, bot=None, spectate=False, seat=None, debug=False):
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
    if seed is not None:
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


def hand_cards(page) -> list[int]:
    return sorted(page.evaluate(
        "Array.from(document.querySelectorAll('.fc--hand [data-testid^=hand-]')).map(b => +b.dataset.testid.slice(5))"
    ))


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
    pt = page.evaluate(VISIBLE_POINT, card)
    if not pt:
        return False
    page.mouse.click(pt["x"], pt["y"])
    return left_hand(page, card)


def drag_card(page, card: int) -> bool:
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
    leaked = page.evaluate(
        "Array.from(document.querySelectorAll('.fc--opp[data-card]')).filter(e => !e.classList.contains('is-known')).length"
    )
    assert leaked == 0, "an opponent's hidden card reached the DOM"


def play_to_end(page, rng, tag, mid_after=4, hint=False, deadline_s=900, use_keys=False, drags=0, stop_after=None):
    SHOTS.mkdir(parents=True, exist_ok=True)
    moves = clicked = dragged = 0
    hint_seen = None
    mid_done = False
    deadline = time.time() + deadline_s
    while time.time() < deadline and not over(page):
        if stop_after is not None and moves >= stop_after:
            break
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
            page.wait_for_selector(".table-stage.my-turn, [data-testid=game-over], [data-testid=reveal]", timeout=180000)
            if not over(page):
                page.wait_for_timeout(700)
                page.screenshot(path=str(SHOTS / f"{tag}-midgame.png"))
                if hint and page.locator("[data-testid=hint]:not([disabled])").count():
                    page.locator("[data-testid=hint]").click()
                    page.wait_for_selector("[data-testid=hint-play]", timeout=120000)
                    page.wait_for_timeout(400)
                    hint_seen = page.locator("[data-testid=hint-play]").inner_text()
                    page.screenshot(path=str(SHOTS / f"{tag}-hint.png"))
                    page.locator("[data-testid=hint-play]").click()
                    moves += 1
            mid_done = True
    if stop_after is not None and not over(page):
        return moves, clicked, dragged, hint_seen
    if page.locator("[data-testid=reveal]").count():
        page.wait_for_timeout(900)
        page.screenshot(path=str(SHOTS / f"{tag}-reveal.png"))
    page.wait_for_selector("[data-testid=game-over]", timeout=180000)
    page.wait_for_timeout(600)
    page.screenshot(path=str(SHOTS / f"{tag}-gameover.png"))
    return moves, clicked, dragged, hint_seen


LONG_TASKS_JS = """() => { window.__long = []; try { new PerformanceObserver((l) => {
  for (const e of l.getEntries()) window.__long.push(e.duration); }).observe({ type: 'longtask', buffered: true }); } catch (e) {} }"""


@pytest.mark.parametrize(
    "n,device,tag,prefs,keys,drags,tier",
    [
        (2, DESKTOP, "static-desktop-2p-en", {}, False, 2, "grandmaster"),
        (5, MOBILE, "static-mobile-5p-ru", {"lang": "ru"}, False, 0, "expert"),
    ],
)
def test_play_full_game(site, browser, n, device, tag, prefs, keys, drags, tier):
    ctx, page, errors, net = new_page(browser, site, device, **prefs)
    start_game(page, site, n, seed=200 + n, bot=tier)
    page.evaluate(LONG_TASKS_JS)
    if prefs.get("lang") == "ru":
        page.wait_for_function("document.documentElement.lang === 'ru'")
    assert page.locator(".seat").count() == n - 1
    # the bots run in a Web Worker, not on the UI thread
    assert any("worker" in w.url for w in page.workers), [w.url for w in page.workers]
    # card art comes from under the base path
    src = page.locator(".fc--hand img.fc__face").first.get_attribute("src")
    assert src.startswith(BASE + "assets/cards"), src
    if device is MOBILE:
        assert page.evaluate("document.documentElement.scrollWidth") <= device["viewport"]["width"]
    moves, clicked, dragged, hint = play_to_end(page, random.Random(n), tag, hint=True, use_keys=keys, drags=drags)
    assert moves > 0 and clicked > 0
    if drags:
        assert dragged > 0, "no card was played by dragging it"
    if hint is not None:
        assert hint.strip(), "empty hint"
    go = page.locator("[data-testid=game-over]")
    assert go.get_attribute("data-reason") in {"durak", "draw", "stalemate"}
    # The champion's search (~1 s per move) must never block the UI thread.
    longest = max(page.evaluate("window.__long || []") or [0])
    assert longest < 900, f"main thread blocked for {longest:.0f} ms"
    net.check()
    assert not errors, f"console errors: {errors}"
    ctx.close()


def test_replay_analysis_stats_and_persistence(site, browser):
    ctx, page, errors, net = new_page(browser, site, DESKTOP, speed="instant")
    start_game(page, site, 2, seed=21, bot="novice")
    play_to_end(page, random.Random(3), "static-instant", mid_after=10**9)
    page.locator("[data-testid=analyze]").click()
    page.wait_for_selector("[data-testid=replay]")
    page.wait_for_selector(".mistakes, .replay-acc, .replay-side p.muted", timeout=240000)
    page.fill("[data-testid=scrubber]", "0")
    page.wait_for_timeout(300)
    page.keyboard.press("ArrowRight")
    if page.locator("[data-testid=mistake]").count():
        page.locator("[data-testid=mistake]").first.click()
    page.wait_for_timeout(1000)
    page.screenshot(path=str(SHOTS / "static-replay.png"))
    page.locator("[data-testid=replay-close]").click()
    page.wait_for_selector("[data-testid=replay]", state="detached")
    page.wait_for_selector("[data-testid=again]")
    # stats survive a reload (IndexedDB)
    page.reload()
    page.wait_for_selector("[data-testid=title]")
    games = page.evaluate("""() => new Promise((res) => {
      const r = indexedDB.open('durakbot-local');
      r.onsuccess = () => { const t = r.result.transaction('games').objectStore('games').count();
        t.onsuccess = () => res(t.result); t.onerror = () => res(-1); };
      r.onerror = () => res(-2);
    })""")
    assert games >= 1
    page.click("[data-testid=choose]")
    page.wait_for_selector("[data-testid=lobby]")
    page.click("[data-players='3']")
    page.click("[data-testid=start-game]")
    page.wait_for_selector(".table-stage")
    page.keyboard.press("s")
    page.wait_for_selector("[data-testid=stats-sheet] .tiles")
    page.wait_for_timeout(500)
    page.screenshot(path=str(SHOTS / "static-stats.png"))
    net.check()
    assert not errors, f"console errors: {errors}"
    ctx.close()


def test_resume_after_reload(site, browser):
    ctx, page, errors, net = new_page(browser, site, DESKTOP)
    start_game(page, site, 3, seed=5, bot="intermediate")
    play_to_end(page, random.Random(5), "static-resume", mid_after=10**9, stop_after=3)
    page.wait_for_selector(".table-stage.my-turn", timeout=120000)
    page.wait_for_timeout(800)
    before = hand_cards(page)
    gid = page.evaluate("localStorage.getItem('durak.gameId')")
    page.reload()
    page.wait_for_selector("[data-testid=continue]", timeout=60000)
    page.click("[data-testid=continue]")
    page.wait_for_selector(".table-stage.my-turn", timeout=60000)
    page.wait_for_timeout(800)
    assert hand_cards(page) == before
    assert page.evaluate("localStorage.getItem('durak.gameId')") == gid
    play_to_end(page, random.Random(6), "static-resumed", mid_after=10**9)
    net.check()
    assert not errors, f"console errors: {errors}"
    ctx.close()


@pytest.mark.parametrize("lang", ["en", "ru"])
def test_title_lobby_and_lab(site, browser, lang):
    for device, dev in ((DESKTOP, "desktop"), (MOBILE, "mobile")):
        tag = f"static-{dev}-{lang}"
        ctx, page, errors, net = new_page(browser, site, device, lang=lang)
        page.goto(site)
        page.wait_for_selector("[data-testid=title]")
        if dev == "desktop":  # the credential (from static bots.json) is shown on desktop
            page.wait_for_selector(".record__cred", timeout=30000)
        page.wait_for_timeout(600)
        page.screenshot(path=str(SHOTS / f"{tag}-title.png"))
        assert page.evaluate("window.innerWidth") == device["viewport"]["width"]
        assert page.evaluate("document.documentElement.scrollWidth") <= device["viewport"]["width"]
        page.click("[data-testid=choose]")
        page.wait_for_selector("[data-testid=lobby]")
        page.click("[data-players='5']")
        page.click("[data-seat-choice='2']")
        page.click("[data-tier='expert']")
        assert page.locator("[data-tier='expert']").get_attribute("aria-checked") == "true"
        page.click("[data-testid=start-game]")
        page.wait_for_selector(".table-stage")
        page.click("[data-testid=home]")
        page.wait_for_selector("[data-testid=continue]")
        page.goto(site + "#/lab")
        page.wait_for_selector(".lab-head")
        page.wait_for_function("document.querySelectorAll('svg path').length > 5", timeout=30000)
        page.wait_for_timeout(1200)
        page.screenshot(path=str(SHOTS / f"{tag}-lab.png"), full_page=dev == "desktop")
        net.check()
        assert not errors, f"console errors: {errors}"
        ctx.close()


def test_spectate_and_debug_reveal(site, browser):
    for device, dev in ((DESKTOP, "desktop"), (MOBILE, "mobile")):
        ctx, page, errors, net = new_page(browser, site, device)
        start_game(page, site, 4, seed=7, bot="intermediate", spectate=True)
        page.wait_for_timeout(2000)
        assert page.locator(".fc--opp[data-card]").count() > 0  # every hand is shown when watching
        page.locator("[data-testid=to-end]").click()
        page.wait_for_selector("[data-testid=game-over]", timeout=300000)
        page.screenshot(path=str(SHOTS / f"static-{dev}-spectate-over.png"))
        net.check()
        assert not errors, f"console errors: {errors}"
        ctx.close()
    ctx, page, errors, net = new_page(browser, site, DESKTOP)
    start_game(page, site, 3, seed=19, bot="novice")
    page.wait_for_selector(".table-stage.my-turn", timeout=120000)
    assert_hidden_cards_private(page)
    page.keyboard.press("d")
    page.wait_for_function("document.querySelectorAll('.fc--opp[data-card]').length > 0", timeout=30000)
    page.screenshot(path=str(SHOTS / "static-debug-reveal.png"))
    net.check()
    assert not errors, f"console errors: {errors}"
    ctx.close()


def test_hires_card_art_under_base(site, browser):
    """@2x faces are picked on a 2x screen (art-hires.json replaces /api/art/hires)."""
    ctx, page, errors, net = new_page(browser, site, dict(viewport={"width": 1440, "height": 900}, device_scale_factor=2))
    start_game(page, site, 2, seed=33, bot="novice")
    page.wait_for_selector(".table-stage.my-turn", timeout=120000)
    page.wait_for_timeout(1200)
    srcs = page.evaluate("Array.from(document.querySelectorAll('.fc--hand img.fc__face')).map(i => i.currentSrc)")
    assert srcs and all(BASE + "assets/cards" in s for s in srcs), srcs
    hires = json.loads((WEB / "public" / "static-data" / "art-hires.json").read_text())
    if hires["cards"][0]:
        assert all("@2x" in s for s in srcs), srcs
    net.check()
    assert not errors, f"console errors: {errors}"
    ctx.close()
