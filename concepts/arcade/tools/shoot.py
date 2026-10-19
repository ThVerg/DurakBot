"""Screenshot the Arcade concept pages. usage: shoot.py [name:page?query:device ...]"""
import sys, asyncio
from playwright.async_api import async_playwright
ROOT = 'http://127.0.0.1:8765/arcade/'
OUT = '/home/theofanis/DurakBot/concepts/arcade/shots/'
DEV = {'d': dict(viewport={'width': 1440, 'height': 900}, device_scale_factor=1),
       'm': dict(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True)}
async def main(jobs):
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for job in jobs:
            name, page, dev = job.split(':')
            ctx = await b.new_context(**DEV[dev])
            pg = await ctx.new_page()
            errs = []
            pg.on('console', lambda m: errs.append(m.text) if m.type in ('error', 'warning') else None)
            pg.on('pageerror', lambda e: errs.append(str(e)))
            await pg.goto(ROOT + page)
            await pg.evaluate('document.fonts.ready')
            await pg.wait_for_timeout(1600)
            await pg.screenshot(path=OUT + name + '.png')
            print(name, 'ok', errs[:5])
            await ctx.close()
        await b.close()
asyncio.run(main(sys.argv[1:]))
