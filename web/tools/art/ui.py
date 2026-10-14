"""UI marks: gold suit emblems (SVG), logo monogram (SVG + PNG), casino chips (WebP)."""
from __future__ import annotations

import math

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

from common import FONTS, OUT, Renderer, save
from svgkit import f, hypotrochoid, poly

GOLD_STOPS = ('<stop offset="0" stop-color="#f7e7ae"/><stop offset="0.35" stop-color="#d9b25e"/>'
              '<stop offset="0.6" stop-color="#a87b2f"/><stop offset="1" stop-color="#ebcf86"/>')

SUIT_NAMES = {"S": ("Spades", "Пики"), "C": ("Clubs", "Трефы"), "D": ("Diamonds", "Бубны"), "H": ("Hearts", "Червы")}


def glyph_path(char: str, font_key: str, size: float, cx: float, baseline: float) -> str:
    """Outline of one glyph as SVG path data, horizontally centred at cx."""
    font = TTFont(FONTS[font_key])
    gs = font.getGlyphSet()
    name = font.getBestCmap()[ord(char)]
    upm = font["head"].unitsPerEm
    s = size / upm
    adv = gs[name].width * s
    pen = SVGPathPen(gs)
    tp = TransformPen(pen, (s, 0, 0, -s, cx - adv / 2, baseline))
    gs[name].draw(tp)
    return pen.getCommands()


def suit_svg(shape: dict, size: int = 128) -> str:
    """Standalone gold suit emblem; the path is re-placed into a square viewBox."""
    h = size * 0.82
    sc = h / (shape["y1"] - shape["y0"])
    bx = (shape["x0"] + shape["x1"]) / 2
    by = (shape["y0"] + shape["y1"]) / 2
    a, b, c, d, e, ff = shape["ctm"]
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="{size}" height="{size}">'
            f'<defs><linearGradient id="g" x1="0" y1="0" x2="0.6" y2="1">{GOLD_STOPS}</linearGradient></defs>'
            f'<g transform="translate({size / 2} {size / 2}) scale({sc:.5f}) translate({-bx:.3f} {-by:.3f})">'
            f'<path transform="matrix({a} {b} {c} {d} {e} {ff})" d="{shape["d"]}" fill="url(#g)" stroke="#6b4c1a" '
            f'stroke-width="0.6" vector-effect="non-scaling-stroke"/></g></svg>\n')


def logo_svg() -> str:
    D = glyph_path("Д", "garamond", 200, 256, 316)
    ring = poly(hypotrochoid(256, 256, 24, 7, 6, 7.4, steps=3000), closed=False, fill="none", stroke="url(#g)",
                stroke_width=1.1, opacity=0.55)
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
<defs>
<linearGradient id="g" x1="0" y1="0" x2="1" y2="1">{GOLD_STOPS}</linearGradient>
<radialGradient id="bg" cx="50%" cy="38%" r="70%"><stop offset="0" stop-color="#1d2230"/><stop offset="1" stop-color="#07080c"/></radialGradient>
</defs>
<rect x="8" y="8" width="496" height="496" rx="112" fill="url(#bg)"/>
<rect x="8" y="8" width="496" height="496" rx="112" fill="none" stroke="url(#g)" stroke-width="5"/>
<circle cx="256" cy="256" r="196" fill="none" stroke="url(#g)" stroke-width="3"/>
<circle cx="256" cy="256" r="184" fill="none" stroke="url(#g)" stroke-width="1.2"/>
{ring}
<circle cx="256" cy="256" r="128" fill="#0b0d13"/>
<circle cx="256" cy="256" r="128" fill="none" stroke="url(#g)" stroke-width="2"/>
<path d="{D}" fill="url(#g)"/>
<path d="M256 50 l9 12 -9 12 -9 -12z M256 438 l9 12 -9 12 -9 -12z M50 256 l12 -9 12 9 -12 9z M438 256 l12 -9 12 9 -12 9z" fill="url(#g)"/>
</svg>
'''


def favicon_svg() -> str:
    D = glyph_path("Д", "garamond", 46, 32, 46)
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">{GOLD_STOPS}</linearGradient></defs>
<rect x="1" y="1" width="62" height="62" rx="14" fill="#0b0d13" stroke="url(#g)" stroke-width="2"/>
<path d="{D}" fill="url(#g)"/>
</svg>
'''


CHIPS = {
    "red": ("#b3162c", "#6e0b19", "Red", "Красная"),
    "blue": ("#1f4f9e", "#0d2a5c", "Blue", "Синяя"),
    "green": ("#137a49", "#0a4a2b", "Green", "Зелёная"),
    "black": ("#25262b", "#0b0b0e", "Black", "Чёрная"),
    "purple": ("#5b2a86", "#2e1248", "Purple", "Фиолетовая"),
}


def chip_svg(c1: str, c2: str, shape: dict) -> str:
    cx = cy = 128
    parts = [f'<defs><radialGradient id="b" cx="45%" cy="40%" r="65%"><stop offset="0" stop-color="{c1}"/><stop offset="1" stop-color="{c2}"/></radialGradient>'
             f'<linearGradient id="g" x1="0" y1="0" x2="1" y2="1">{GOLD_STOPS}</linearGradient>'
             '<radialGradient id="sh" cx="35%" cy="30%" r="70%"><stop offset="0" stop-color="#fff" stop-opacity="0.28"/>'
             '<stop offset="0.5" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>']
    parts.append(f'<circle cx="{cx}" cy="{cy}" r="124" fill="url(#b)"/>')
    # edge spots (6 ivory rectangles around the rim)
    for k in range(6):
        a = 360 * k / 6
        parts.append(f'<g transform="rotate({a} {cx} {cy})"><path d="M{cx - 15} {cy - 124} L{cx + 15} {cy - 124} L{cx + 12} {cy - 98} L{cx - 12} {cy - 98}Z" fill="#f3eee2"/>'
                     f'<path d="M{cx - 7} {cy - 120} L{cx + 7} {cy - 120} L{cx + 5} {cy - 102} L{cx - 5} {cy - 102}Z" fill="{c1}"/></g>')
    parts.append(f'<circle cx="{cx}" cy="{cy}" r="96" fill="none" stroke="url(#g)" stroke-width="3"/>')
    parts.append(f'<circle cx="{cx}" cy="{cy}" r="88" fill="none" stroke="#f3eee2" stroke-width="2" stroke-dasharray="6 5" opacity="0.8"/>')
    parts.append(f'<circle cx="{cx}" cy="{cy}" r="80" fill="{c2}" stroke="url(#g)" stroke-width="1.5"/>')
    parts.append(poly(hypotrochoid(cx, cy, 12, 5, 4, 5.4, steps=1600), closed=False, fill="none", stroke="url(#g)", stroke_width=0.8, opacity=0.6))
    h = 64
    sc = h / (shape["y1"] - shape["y0"])
    bx = (shape["x0"] + shape["x1"]) / 2
    by = (shape["y0"] + shape["y1"]) / 2
    a, b, c, d, e, ff = shape["ctm"]
    parts.append(f'<g transform="translate({cx} {cy}) scale({sc:.5f}) translate({-bx:.3f} {-by:.3f})">'
                 f'<path transform="matrix({a} {b} {c} {d} {e} {ff})" d="{shape["d"]}" fill="url(#g)"/></g>')
    parts.append(f'<circle cx="{cx}" cy="{cy}" r="124" fill="url(#sh)"/>')
    parts.append(f'<circle cx="{cx}" cy="{cy}" r="123" fill="none" stroke="#000" stroke-opacity="0.35" stroke-width="2"/>')
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">{"".join(parts)}</svg>'


def build(r: Renderer, shapes: dict) -> dict:
    ui = OUT / "ui"
    ui.mkdir(parents=True, exist_ok=True)
    suits = []
    for s, (en, ru) in SUIT_NAMES.items():
        (ui / f"suit_{s}.svg").write_text(suit_svg(shapes[s]))
        suits.append({"id": s, "file": f"ui/suit_{s}.svg", "en": en, "ru": ru})
    (ui / "logo.svg").write_text(logo_svg())
    (ui / "favicon.svg").write_text(favicon_svg())
    logo = r.render(logo_svg().replace('width="512" height="512"', 'width="512" height="512" style="display:block"'), 512, 512, ss=2)
    logo_files = save(logo, "ui/logo_512", webp_q=92, png=True, png_quant=False)
    logo.resize((180, 180)).save(ui / "apple-touch-icon.png")
    chips = []
    suit_cycle = ["H", "S", "C", "S", "D"]
    for (cid, (c1, c2, en, ru)), s in zip(CHIPS.items(), suit_cycle):
        im = r.render(chip_svg(c1, c2, shapes[s]), 256, 256, ss=2)
        files = save(im, f"ui/chip_{cid}", webp_q=90)
        chips.append({"id": cid, "files": files, "en": f"{en} chip", "ru": f"{ru} фишка"})
    return {"suits": suits, "logo": ["ui/logo.svg", "ui/favicon.svg", "ui/apple-touch-icon.png"] + logo_files, "chips": chips}
