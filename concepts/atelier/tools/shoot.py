"""Screenshot helper: python shoot.py <html> <out.png> <w> <h> [dpr] [theme] [full]"""
import sys, asyncio
from pathlib import Path
from playwright.async_api import async_playwright

async def main(pairs):
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for html, out, w, h, dpr, theme, full in pairs:
            ctx = await b.new_context(viewport={"width": w, "height": h}, device_scale_factor=dpr,
                                      is_mobile=dpr > 1, has_touch=dpr > 1)
            page = await ctx.new_page()
            msgs = []
            page.on("console", lambda m: msgs.append(f"{m.type}: {m.text}"))
            page.on("pageerror", lambda e: msgs.append(f"ERR: {e}"))
            url = Path(html).resolve().as_uri() + (f"?theme={theme}" if theme else "")
            await page.goto(url)
            await page.evaluate("document.fonts.ready")
            await page.wait_for_timeout(700)
            await page.screenshot(path=out, full_page=full)
            for m in msgs: print(html, m)
            await ctx.close()
        await b.close()

args = sys.argv[1:]
jobs = []
while args:
    html, out, w, h = args[0], args[1], int(args[2]), int(args[3])
    dpr = float(args[4]) if len(args) > 4 else 1
    theme = args[5] if len(args) > 5 and args[5] != '-' else ''
    full = len(args) > 6 and args[6] == 'full'
    jobs.append((html, out, w, h, dpr, theme, full))
    args = args[7:]
asyncio.run(main(jobs))
