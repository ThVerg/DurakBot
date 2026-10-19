"""Screenshot the concept pages with Playwright (file://)."""
import sys, os, asyncio
from playwright.async_api import async_playwright
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
SHOTS = os.path.join(ROOT, "shots")

JOBS = {
    "desktop-table": ("table.html", 1440, 900, 1),
    "mobile-table": ("table.html", 390, 844, 2),
    "desktop-title": ("index.html", 1440, 900, 1),
    "mobile-title": ("index.html", 390, 844, 2),
    "desktop-lobby": ("lobby.html", 1440, 900, 1),
    "mobile-lobby": ("lobby.html", 390, 844, 2),
}

async def main(names, out_dir, query):
    os.makedirs(out_dir, exist_ok=True)
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--allow-file-access-from-files"])
        for n in names:
            page_, w, h, dpr = JOBS[n.split(":")[0]] if n.split(":")[0] in JOBS else (None,)*4
            extra = n.split(":")[1] if ":" in n else query
            ctx = await b.new_context(viewport={"width": w, "height": h}, device_scale_factor=dpr)
            pg = await ctx.new_page()
            msgs = []
            pg.on("console", lambda m: msgs.append(m.text))
            pg.on("pageerror", lambda e: msgs.append("ERR " + str(e)))
            url = "file://" + os.path.join(ROOT, page_) + (("?" + extra) if extra else "")
            await pg.goto(url)
            await pg.wait_for_timeout(1300)
            fn = n.replace(":", "_").replace("=", "-").replace("&", "_") + ".png"
            await pg.screenshot(path=os.path.join(out_dir, fn))
            print(fn, msgs)
            await ctx.close()
        await b.close()

if __name__ == "__main__":
    args = sys.argv[1:]
    out = SHOTS
    if args and args[0].startswith("--out="):
        out = args[0][6:]; args = args[1:]
    asyncio.run(main(args, out, ""))
