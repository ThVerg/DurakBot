"""Assemble the Dacha production art kit into web/public/assets/dacha/.

Run after: bake.py (table/*.webp, floor) and kit_art.py (brand, frame, backs, illustrations).
Needs the concepts static server on 127.0.0.1:8765 for the raster renders (Playwright).
"""
import asyncio
import json
import os
import re
import shutil

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
DACHA = os.path.normpath(os.path.join(HERE, '..'))
KIT = os.path.normpath(os.path.join(DACHA, '..', '..', 'web', 'public', 'assets', 'dacha'))
ART = os.path.join(DACHA, 'art')

PERSONAS = {
    'kostya': {'en': 'Kostya', 'ru': 'Костя', 'look': 'cocky lad: tweed flat cap, freckles, seed husk, vermilion kosovorotka', 'bg': '#e9a92e'},
    'dasha': {'en': 'Dasha', 'ru': 'Даша', 'look': 'cheeky student: chestnut braids with red bows, cobalt hairband, sarafan', 'bg': '#e07a6e'},
    'misha': {'en': 'Uncle Misha', 'ru': 'Дядя Миша', 'look': 'bald, big beard, round red nose, telnyashka + ochre shirt', 'bg': '#2f6b45'},
    'lev': {'en': 'Professor Lev', 'ru': 'Профессор Лев', 'look': 'white goatee, gold spectacles, pencil behind ear, tweed + bow tie', 'bg': '#eedbb2'},
    'zina': {'en': 'Babushka Zina', 'ru': 'Баба Зина', 'look': 'red Pavlovo-Posad headscarf, round glasses, green cardigan', 'bg': '#2a56b2'},
    'sveta': {'en': 'Sveta', 'ru': 'Света', 'look': 'flower crown (daisy, cornflower, poppy), blond braid, embroidered blouse', 'bg': '#d2452a'},
    'grisha': {'en': 'Grisha', 'ru': 'Гриша', 'look': 'dark beard, mustard knit beanie with folk band + pompom, Nordic sweater', 'bg': '#2f8a86'},
    'you': {'en': 'You', 'ru': 'Вы', 'look': 'monogram «Я» medallion for the human seat', 'bg': '#fbf2df'},
}
TIERS = [  # same ids/personas as web/src/hud/Title.tsx TIERS
    {'id': 'novice', 'persona': 'kostya', 'strength': 1, 'en': 'Novice', 'ru': 'Новичок', 'suit': 'C'},
    {'id': 'intermediate', 'persona': 'dasha', 'strength': 2, 'en': 'Intermediate', 'ru': 'Любитель', 'suit': 'D'},
    {'id': 'expert', 'persona': 'misha', 'strength': 3, 'en': 'Expert', 'ru': 'Знаток', 'suit': 'S'},
    {'id': 'grandmaster', 'persona': 'lev', 'strength': 4, 'en': 'Grandmaster', 'ru': 'Гроссмейстер', 'suit': 'H'},
]

ICONS = {
    'log': '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h11a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6z"/><path d="M6 3v18"/><path d="M4 7h3M4 12h3M4 17h3"/><path d="M10 8h6M10 12h6M10 16h4"/></g>',
    'sound': '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" fill-opacity=".12"/><path d="M15.5 9a4 4 0 0 1 0 6"/><path d="M18 6.5a7.5 7.5 0 0 1 0 11"/></g>',
    'sound-off': '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" fill-opacity=".12"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></g>',
    'settings': '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/><circle cx="12" cy="12" r="6.6"/></g>',
    'menu': '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h10"/></g>',
    'back': '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 5.5 8 12l6.5 6.5"/></g>',
    'close': '<g fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></g>',
    'hint': '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17.5h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.4 1.1 2.2v1.5h5V16c0-.8.4-1.6 1.1-2.2A6 6 0 0 0 12 3z" fill="currentColor" fill-opacity=".15"/><path d="M12 7v3l1.6 1.2"/></g>',
    'take': '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="M7 11l5 5 5-5"/><path d="M5 20h19" transform="translate(-2.5 0)"/></g>',
    'done': '<g fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5l5 5 10-11"/></g>',
    'attack': '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4.5H19.5V9.5L10 19l-5-5z"/><path d="M4 15l5 5M3 21l2.5-2.5"/></g>',
    'defend': '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M12 3l7.5 3v5.5c0 4.5-3.2 8-7.5 9.5-4.3-1.5-7.5-5-7.5-9.5V6z" fill="currentColor" fill-opacity=".14"/></g>',
    'throw-in': '<g fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></g>',
    'known': '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3" fill="currentColor"/></g>',
    'cards': '<g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><rect x="4" y="5" width="11" height="15" rx="2" transform="rotate(-10 9.5 12.5)"/><rect x="9" y="4" width="11" height="15" rx="2" fill="currentColor" fill-opacity=".15"/></g>',
    'laurel': '<g fill="currentColor"><path d="M12 19.5c-4.4-.4-7.6-3.8-7.9-8.4l1.5-.1c.3 3.8 3 6.7 6.6 7z"/><path d="M12 19.5c4.4-.4 7.6-3.8 7.9-8.4l-1.5-.1c-.3 3.8-3 6.7-6.6 7z"/><ellipse cx="5" cy="8.6" rx="1.3" ry="2.4" transform="rotate(-20 5 8.6)"/><ellipse cx="5.6" cy="13" rx="1.3" ry="2.4" transform="rotate(-50 5.6 13)"/><ellipse cx="8" cy="16.4" rx="1.3" ry="2.4" transform="rotate(-70 8 16.4)"/><ellipse cx="19" cy="8.6" rx="1.3" ry="2.4" transform="rotate(20 19 8.6)"/><ellipse cx="18.4" cy="13" rx="1.3" ry="2.4" transform="rotate(50 18.4 13)"/><ellipse cx="16" cy="16.4" rx="1.3" ry="2.4" transform="rotate(70 16 16.4)"/><path d="M12 6.2l1.2 2.5 2.7.3-2 1.8.6 2.7L12 12.1l-2.5 1.4.6-2.7-2-1.8 2.7-.3z"/></g>',
    'play': '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/>',
    'opponents': '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8.5" r="3.3"/><path d="M3 19.5c.6-3.4 3-5.2 6-5.2s5.4 1.8 6 5.2"/><circle cx="16.8" cy="9.2" r="2.6"/><path d="M16.5 14.3c2.4.1 4 1.6 4.5 4.2"/></g>',
    'watch': '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8M12 17v4"/><path d="M10 8.5v5l4.2-2.5z" fill="currentColor"/></g>',
    'stats': '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16"/><rect x="5.5" y="11" width="3" height="7" rx=".8"/><rect x="10.5" y="6" width="3" height="12" rx=".8" fill="currentColor" fill-opacity=".2"/><rect x="15.5" y="9" width="3" height="9" rx=".8"/></g>',
    'rules': '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5C6.5 4 9.5 4 12 5.5v14C9.5 18 6.5 18 4 19.5z"/><path d="M20 5.5C17.5 4 14.5 4 12 5.5v14c2.5-1.5 5.5-1.5 8 0z" fill="currentColor" fill-opacity=".12"/></g>',
    'language': '<g fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.6 3.6 5.3 3.6 8.5s-1 5.9-3.6 8.5c-2.6-2.6-3.6-5.3-3.6-8.5s1-5.9 3.6-8.5z"/></g>',
    'continue': '<path d="M12 2.5c1 3.4 5.5 5.6 5.5 10.6A5.5 5.5 0 0 1 12 18.6a5.5 5.5 0 0 1-5.5-5.5c0-2.4 1.2-3.9 2.3-5 .2 1.6.9 2.6 1.9 3.1C10.4 8 11 5.2 12 2.5z" fill="currentColor"/>',
    'undo': '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></g>',
    'suit-hearts': '<path d="M12 21C5.5 15.6 2 12.3 2 8.2 2 5.2 4.3 3 7.2 3c2 0 3.7 1.1 4.8 2.9C13.1 4.1 14.8 3 16.8 3 19.7 3 22 5.2 22 8.2c0 4.1-3.5 7.4-10 12.8z" fill="currentColor"/>',
    'suit-diamonds': '<path d="M12 1.5 20.5 12 12 22.5 3.5 12z" fill="currentColor"/>',
    'suit-spades': '<path d="M12 1.5c5.2 5 9.6 8 9.6 12.2 0 2.7-2.1 4.7-4.6 4.7-1.6 0-3-.8-3.9-2.1.3 2.2 1.3 3.8 2.8 5.3H8.1c1.5-1.5 2.5-3.1 2.8-5.3-.9 1.3-2.3 2.1-3.9 2.1-2.5 0-4.6-2-4.6-4.7C2.4 9.5 6.8 6.5 12 1.5z" fill="currentColor"/>',
    'suit-clubs': '<g fill="currentColor"><circle cx="12" cy="6.5" r="4.6"/><circle cx="6.4" cy="12.8" r="4.6"/><circle cx="17.6" cy="12.8" r="4.6"/><path d="M10.9 11.5h2.2c0 4 .9 6.7 3.1 9.6H7.8c2.2-2.9 3.1-5.6 3.1-9.6z"/></g>',
}


def minify(s):
    s = re.sub(r'<!--.*?-->', '', s, flags=re.S)
    s = re.sub(r'>\s+<', '><', s)
    s = re.sub(r'\s{2,}', ' ', s)
    s = re.sub(r'(\d+\.\d{2})\d+', r'\1', s)
    return s.strip()


def put_svg(rel, text):
    p = os.path.join(KIT, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, 'w') as f:
        f.write(minify(text))
    return rel


def copy_svg(src, rel):
    return put_svg(rel, open(src).read())


async def render(jobs):
    """jobs: list of (svg_rel_in_kit, out_rel_webp, w, h); served via concepts/assets -> web/public/assets."""
    from playwright.async_api import async_playwright
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page()
        for src, out, w, h in jobs:
            await pg.set_viewport_size({'width': w, 'height': h})
            await pg.goto('http://127.0.0.1:8765/')
            await pg.evaluate("""([src, w, h]) => new Promise(r => { document.body.innerHTML = ''; document.body.style.margin = 0; document.body.style.background = 'transparent';
                const i = new Image(); i.onload = r; i.src = src; i.style.cssText = `display:block;width:${w}px;height:${h}px`; document.body.appendChild(i); })""",
                              [f'/assets/dacha/{src}', w, h])
            tmp = os.path.join(KIT, out + '.png')
            await pg.screenshot(path=tmp, omit_background=True)
            Image.open(tmp).convert('RGBA').save(os.path.join(KIT, out), 'WEBP', quality=90, method=6)
            os.remove(tmp)
        await b.close()


def main():
    m = {'name': 'DurakBot · Dacha art kit', 'version': 1, 'generated': '2026-10-19', 'base': '/assets/dacha/',
         'style': 'Warm illustrated Russian folk-art world (Concept C "Dacha") with Concept D\'s oval card table.',
         'licence': 'Original artwork for DurakBot (same terms as the project). Fonts: SIL OFL 1.1 (see fonts/).'}

    # ---------- palette / type tokens
    m['palette'] = {
        'linen': '#e9d3a8', 'paper': '#fffaf0', 'paper2': '#fbf2df', 'cream': '#fbf3e2',
        'vermilion': '#c8361f', 'vermilionHi': '#e2563a', 'vermilionLo': '#9b2414',
        'gold': '#e0a52a', 'goldHi': '#f7d673', 'goldLo': '#a86d12',
        'cobalt': '#2350b4', 'cobaltHi': '#4f78d2', 'cobaltLo': '#173a88',
        'green': '#2f6b45', 'greenHi': '#4c8c5f', 'ink': '#33200f', 'ink2': '#5d4229', 'ink3': '#8a6d4e',
        'shadowRGB': '92, 52, 20',
    }
    m['typography'] = {'display': 'Playfair Display 600/700/900 + italic 400/700 (Cyrillic + Latin)', 'text': 'Lato 400/600/700/900 + italic (Cyrillic + Latin)',
                       'css': 'fonts/fonts.css', 'note': 'Lettering in brand/ and illustrations/ is outlined: no font needed.'}
    tok = ':root{' + ''.join(f'--dacha-{re.sub(r"([A-Z])", r"-\1", k).lower()}:{v};' for k, v in m['palette'].items()) + \
          '--dacha-display:"Playfair Display","PT Serif",Georgia,serif;--dacha-text:"Lato","Segoe UI",system-ui,sans-serif;' \
          '--dacha-sh-1:2px 3px 0 rgba(92,52,20,.18),4px 8px 14px rgba(92,52,20,.22);' \
          '--dacha-sh-2:3px 5px 0 rgba(92,52,20,.16),10px 18px 30px rgba(92,52,20,.28);' \
          '--dacha-sh-card:1px 2px 1px rgba(92,52,20,.25),6px 10px 18px rgba(92,52,20,.28);}'
    with open(os.path.join(KIT, 'tokens.css'), 'w') as f:
        f.write('/* Dacha design tokens: light comes from the upper-left, shadows fall down-right in warm brown. */\n' + tok + '\n')
    m['tokens'] = 'tokens.css'

    # ---------- portraits
    m['portraits'] = {'size': [200, 200], 'shape': 'square artwork, designed to be clipped to a circle', 'frame': 'portraits/frame.svg',
                      'frameNote': 'frame.svg is 220x220; place the 200px circular portrait at (10,10) underneath it.', 'items': {}}
    jobs = []
    for pid, info in PERSONAS.items():
        rel = copy_svg(os.path.join(ART, f'p-{pid}.svg'), f'portraits/{pid}.svg')
        jobs.append((rel, f'portraits/{pid}.webp', 512, 512))
        m['portraits']['items'][pid] = dict(info, svg=rel, webp=f'portraits/{pid}.webp')
    m['tiers'] = [dict(t, portrait=f'portraits/{t["persona"]}.svg') for t in TIERS]

    # ---------- brand
    m['brand'] = {k: f'brand/{k}.svg' for k in ['wordmark-ru', 'wordmark-ru-plain', 'wordmark-en', 'lockup', 'jester-cap']}
    for k in ['wordmark-ru', 'wordmark-ru-plain', 'wordmark-en', 'lockup', 'jester-cap']:
        put_svg(f'brand/{k}.svg', open(os.path.join(KIT, f'brand/{k}.svg')).read())
    jobs.append(('brand/lockup.svg', 'brand/lockup.webp', 1080, 532))

    # ---------- card backs
    copy_svg(os.path.join(ART, 'back.svg'), 'backs/gzhel.svg')
    for k in ['khokhloma', 'stitch']:
        put_svg(f'backs/{k}.svg', open(os.path.join(KIT, f'backs/{k}.svg')).read())
    m['backs'] = {'size': [250, 350], 'cornerRadius': 13, 'rasterSize': [512, 716], 'default': 'gzhel', 'items': {}}
    for k, en, ru in [('gzhel', 'Gzhel', 'Гжель'), ('khokhloma', 'Khokhloma', 'Хохлома'), ('stitch', 'Rushnyk cross-stitch', 'Рушник')]:
        jobs.append((f'backs/{k}.svg', f'backs/{k}.webp', 512, 716))
        m['backs']['items'][k] = {'en': en, 'ru': ru, 'svg': f'backs/{k}.svg', 'webp': f'backs/{k}.webp'}

    # ---------- illustrations
    m['illustrations'] = {}
    for k in ['durak-ru', 'durak-en', 'safe-ru', 'safe-en']:
        put_svg(f'illustrations/{k}.svg', open(os.path.join(KIT, f'illustrations/{k}.svg')).read())
        jobs.append((f'illustrations/{k}.svg', f'illustrations/{k}.webp', 640, 520))
        m['illustrations'][k] = {'svg': f'illustrations/{k}.svg', 'webp': f'illustrations/{k}.webp', 'size': [640, 520]}
    m['illustrations']['_note'] = ('durak-*: game over, you are the durak (jester cap drops onto a woodcut stamp). '
                                   'safe-*: you escaped (sunflower medal in a rowan wreath). Suggested entrance: scale 0.4→1 with overshoot, cap drops from -120px.')

    # ---------- props
    props = {
        'samovar': ('samovar.svg', 'top-down brass samovar with Gzhel teapot; cast shadow baked in (sun upper-left)'),
        'tea': ('tea.svg', 'tea glass with lemon in a silver podstakannik + spoon'),
        'seeds': ('seeds.svg', 'Gzhel saucer of sunflower seeds + husks'),
        'rowan': ('rowan.svg', 'rowan (ryabina) sprig with berries'),
        'stool': ('stool.svg', 'wooden stool with crocheted doily (samovar stand)'),
        'leaves': ('leaves.svg', 'soft leaf shadow; use mix-blend-mode:multiply, opacity ~.1'),
        'sunlight': ('sunlight.svg', 'window light pools (2x2 panes); dark-on-transparent, use mix-blend-mode:screen, opacity ~.6'),
        'linen': ('linen.svg', 'tileable linen weave texture (320px), lay over --dacha-linen'),
        'embroidery-h': ('stitch-h.svg', 'horizontal cross-stitch border, repeat-x, 57px tall'),
        'embroidery-v': ('stitch-v.svg', 'vertical cross-stitch border, repeat-y, 57px wide'),
        'medallion': ('medallion.svg', 'round cross-stitch rosette for the cloth/table centre; use at ~.3 opacity'),
    }
    m['props'] = {}
    for k, (src, note) in props.items():
        rel = copy_svg(os.path.join(ART, src), f'props/{k}.svg')
        m['props'][k] = {'svg': rel, 'note': note}

    # ---------- table (baked)
    tdir = os.path.join(KIT, 'table')
    for fn in sorted(os.listdir(tdir)):
        if fn.startswith('table-desktop') and fn.endswith('.webp') and '@1x' not in fn:
            im = Image.open(os.path.join(tdir, fn))
            im.save(os.path.join(tdir, fn), 'WEBP', quality=84, method=6, alpha_quality=88)
            im.resize((im.width // 2, im.height // 2), Image.LANCZOS).save(os.path.join(tdir, fn.replace('.webp', '@1x.webp')), 'WEBP', quality=86, method=6)
        elif fn.startswith('table-mobile') and fn.endswith('.webp'):
            im = Image.open(os.path.join(tdir, fn))
            im.save(os.path.join(tdir, fn), 'WEBP', quality=84, method=6, alpha_quality=88)
    m['table'] = {
        'desktop': {'designSize': [1380, 780], 'scale': 2, 'tableSize': [1200, 600], 'rugWidth': 74, 'pad': 90,
                    'note': 'Top-down oval card table (leather armrest, oak band, brass bead, baize) on a braided rag rug; RGBA with the soft drop shadow in alpha. '
                            'Felt inner edge is 1200x600 minus rail (leather 34 + wood 17 + brass 2.4). Artboard placement used in the mockup: left 30, top 50 on 1440x900.',
                    'felts': {}},
        'mobile': {'designSize': [438, 628], 'scale': 3, 'tableSize': [350, 540], 'rugWidth': 26, 'pad': 44, 'note': 'Vertical table for phones (rail: leather 22, wood 11, brass 1.8).', 'felts': {}},
        'floor': {'webp': 'table/floor.webp', 'tile': 1024, 'displayTile': 512, 'note': 'tileable honey-pine floorboards; show at 512px (2x).'},
        'baker': 'concepts/dacha/tools/bake.py (numpy + Pillow); FELT env picks a variant, OUT env sets the folder.',
    }
    for suf, name, hexes in [('', 'green', '#3b8d5e'), ('-cobalt', 'cobalt', '#3f6fc4'), ('-vermilion', 'vermilion', '#c9553a')]:
        m['table']['desktop']['felts'][name] = {'webp': f'table/table-desktop{suf}.webp', 'webp1x': f'table/table-desktop{suf}@1x.webp', 'hex': hexes}
        m['table']['mobile']['felts'][name] = {'webp': f'table/table-mobile{suf}.webp', 'hex': hexes}

    # ---------- icons
    sprite = ['<svg xmlns="http://www.w3.org/2000/svg" style="display:none">']
    m['icons'] = {'viewBox': '0 0 24 24', 'colour': 'currentColor', 'sprite': 'icons/sprite.svg', 'usage': '<svg><use href="/assets/dacha/icons/sprite.svg#i-take"/></svg>', 'items': {}}
    for k, body in ICONS.items():
        put_svg(f'icons/{k}.svg', f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">{body}</svg>')
        sprite.append(f'<symbol id="i-{k}" viewBox="0 0 24 24">{body}</symbol>')
        m['icons']['items'][k] = f'icons/{k}.svg'
    sprite.append('</svg>')
    put_svg('icons/sprite.svg', ''.join(sprite))

    # ---------- fonts
    fdir = os.path.join(KIT, 'fonts')
    os.makedirs(fdir, exist_ok=True)
    for fn in os.listdir(os.path.join(DACHA, 'fonts')):
        shutil.copy(os.path.join(DACHA, 'fonts', fn), fdir)
    css = open(os.path.join(DACHA, 'css', 'dacha.css')).read()
    faces = re.findall(r'@font-face \{.*?\}', css, flags=re.S)
    with open(os.path.join(fdir, 'fonts.css'), 'w') as f:
        f.write('/* Dacha fonts (SIL OFL 1.1). Paths are relative to this file. */\n' + '\n'.join(x.replace('url(../fonts/', 'url(') for x in faces) + '\n')
    m['fonts'] = {'css': 'fonts/fonts.css', 'files': sorted(x for x in os.listdir(fdir) if x.endswith('.woff2')),
                  'licences': ['fonts/OFL-PlayfairDisplay.txt', 'fonts/OFL-Lato.txt']}

    asyncio.run(render(jobs))
    with open(os.path.join(KIT, 'manifest.json'), 'w') as f:
        json.dump(m, f, ensure_ascii=False, indent=1)
    tot = 0
    for root, _, files in os.walk(KIT):
        for fn in files:
            tot += os.path.getsize(os.path.join(root, fn))
    print('kit ok', KIT, f'{tot/1e6:.1f} MB')


if __name__ == '__main__':
    main()
