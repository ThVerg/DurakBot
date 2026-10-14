"""Seamless table materials (1024², tileable): felt, walnut, leather, brushed brass, felt logo.

Every noise field is generated in the frequency domain, so all maps wrap
perfectly. Normal maps use the OpenGL convention (+Y up), as three.js expects.
"""
from __future__ import annotations

import math

import numpy as np
from PIL import Image

from common import (Renderer, band_noise, fbm, font_css, hexrgb, lerp_colors, norm01, normal_from_height,
                    oriented_noise, rgb_img, save, to_img, warp, worley)
from svgkit import gold_defs

N = 1024

FELTS = {
    "emerald": {"hex": "#0f5a3c", "en": "Emerald", "ru": "Изумрудный"},
    "royal": {"hex": "#173f86", "en": "Royal blue", "ru": "Королевский синий"},
    "burgundy": {"hex": "#6a1626", "en": "Burgundy", "ru": "Бордовый"},
    "charcoal": {"hex": "#2a2d31", "en": "Charcoal", "ru": "Графит"},
}


def felt_fields(seed=11):
    # fibres: many short strands in random orientations
    fib = np.zeros((N, N))
    for k, ang in enumerate(np.linspace(0, math.pi, 7, endpoint=False)):
        fib += oriented_noise(N, N, 2.6, 0.45, ang + 0.13, seed + k) ** 2
    fib = (fib - fib.mean()) / fib.std()
    fine = band_noise(N, N, 1.6, seed + 20)
    fuzz = band_noise(N, N, 10, seed + 21)
    mottle = fbm(N, N, 320, 4, seed + 22)
    # broad nap direction variations (where the felt has been brushed)
    nap = fbm(N, N, 500, 2, seed + 23)
    return fib, fine, fuzz, mottle, nap


def build_felt() -> list[dict]:
    fib, fine, fuzz, mottle, nap = felt_fields()
    out = []
    lum = 1 + 0.055 * fib + 0.03 * fine + 0.035 * fuzz + 0.045 * mottle + 0.02 * nap
    for fid, info in FELTS.items():
        base = np.array(hexrgb(info["hex"]), dtype=np.float64) / 255.0
        # fibre tips catch a bit of desaturated light → slight sheen variation
        rgb = base[None, None, :] * lum[..., None]
        tip = np.clip(fib - 1.2, 0, None)[..., None] * 0.035
        rgb = rgb + tip * (np.array([0.8, 0.8, 0.8]) - rgb) * 0.6
        files = save(rgb_img(rgb), f"table/felt_{fid}", webp_q=90)
        out.append({"id": fid, "files": files, "colour": info["hex"], "en": info["en"], "ru": info["ru"]})
    hgt = 0.6 * fib + 0.35 * fine + 0.5 * fuzz + 0.2 * mottle
    save(normal_from_height(hgt / 6.0, 3.0), "table/felt_normal", webp_q=92)
    rough = 0.88 + 0.05 * norm01(-fib) - 0.03 + 0.03 * np.tanh(mottle)
    save(to_img(rough), "table/felt_roughness", webp_q=90)
    return out


def build_walnut(seed=31):
    yy, xx = np.mgrid[0:N, 0:N].astype(np.float64)
    # grain runs along X (rail U direction); integer band count keeps it tileable.
    wx = fbm(N, N, 520, 3, seed) * 9 + oriented_noise(N, N, 90, 4, 0, seed + 1) * 2.5
    v = (yy + wx) / N
    rings = (v * 46 + 0.15 * fbm(N, N, 900, 2, seed + 3)) % 1.0
    ring = np.abs(rings - 0.5) * 2
    ring = ring ** 2.2  # thin dark late-wood lines
    streak = oriented_noise(N, N, 260, 1.1, 0, seed + 4)       # long fine streaks
    streak2 = oriented_noise(N, N, 120, 6, 0, seed + 8)        # wider colour bands
    pores = oriented_noise(N, N, 10, 0.6, 0, seed + 5)
    pores = np.clip(-pores - 1.4, 0, None)
    broad = fbm(N, N, 380, 3, seed + 6)
    t = 0.5 + 0.08 * streak + 0.10 * streak2 + 0.30 * (ring - 0.5) + 0.08 * broad
    col = lerp_colors(np.clip(t, 0, 1), [
        (0.0, (34, 19, 11)), (0.3, (62, 36, 21)), (0.55, (92, 56, 32)), (0.8, (124, 80, 46)), (1.0, (150, 100, 58)),
    ])
    col = col * (1 - 0.3 * pores[..., None])
    rib = 0.05 * np.sin(2 * math.pi * (xx / N * 6 + 0.5 * fbm(N, N, 600, 2, seed + 7)))  # chatoyant figure
    col = col * (1 + rib[..., None])
    save(rgb_img(col), "table/walnut_color", webp_q=88)
    hgt = 0.15 * ring - 1.0 * pores + 0.05 * streak
    save(normal_from_height(hgt, 1.0), "table/walnut_normal", webp_q=90)
    rough = 0.3 + 0.25 * pores + 0.05 * norm01(streak)
    save(to_img(np.clip(rough, 0, 1)), "table/walnut_roughness", webp_q=90)


def build_leather(seed=51):
    f1, f2 = worley(N, N, 120, seed)
    crease = np.clip((f2 - f1) * 3.2, 0, 1)  # 0 along cell borders
    pebble = 1 - np.clip(f1 * 1.15, 0, 1) ** 1.5  # domed pebbles
    f1b, f2b = worley(N, N, 260, seed + 1)
    micro = np.clip((f2b - f1b) * 3, 0, 1)
    wrinkle = oriented_noise(N, N, 40, 6, 0.6, seed + 2) * 0.5 + oriented_noise(N, N, 50, 7, -0.9, seed + 3) * 0.4
    hgt = 0.5 * pebble + 0.35 * np.sqrt(crease) + 0.12 * micro + 0.08 * wrinkle + 0.15 * fbm(N, N, 200, 3, seed + 4)
    t = norm01(hgt)
    mott = fbm(N, N, 300, 4, seed + 5)
    col = lerp_colors(t, [(0.0, (12, 8, 6)), (0.45, (25, 16, 12)), (0.8, (34, 22, 16)), (1.0, (44, 29, 21))])
    col = col * (1 + 0.12 * mott[..., None])
    save(rgb_img(col), "table/leather_color", webp_q=88)
    save(normal_from_height(hgt, 3.0), "table/leather_normal", webp_q=90)
    rough = 0.55 + 0.25 * (1 - norm01(hgt)) + 0.05 * mott
    save(to_img(np.clip(rough, 0, 1)), "table/leather_roughness", webp_q=90)


def build_brass(seed=71):
    streak = oriented_noise(N, N, 300, 0.6, 0, seed) * 0.6 + oriented_noise(N, N, 80, 0.5, 0, seed + 1) * 0.4
    broad = fbm(N, N, 500, 3, seed + 2)
    t = 0.55 + 0.14 * streak + 0.05 * broad
    col = lerp_colors(t, [(0.0, (92, 66, 26)), (0.4, (156, 118, 52)), (0.65, (201, 160, 84)), (1.0, (240, 210, 140))])
    save(rgb_img(col), "table/brass_color", webp_q=88)
    rough = 0.28 + 0.1 * norm01(streak)
    save(to_img(rough), "table/brass_roughness", webp_q=90)
    save(normal_from_height(streak * 0.02, 1.0), "table/brass_normal", webp_q=90)


def logo_svg(word: str, sub: str, w=1024, h=512) -> str:
    cx = w / 2
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">
<defs>{gold_defs("g", w, h)}
<linearGradient id="foil" x1="0" y1="0" x2="1" y2="1">
 <stop offset="0" stop-color="#f6e4a6"/><stop offset="0.3" stop-color="#cfa24c"/><stop offset="0.5" stop-color="#fbeab6"/>
 <stop offset="0.72" stop-color="#b98a37"/><stop offset="1" stop-color="#e9cc84"/></linearGradient>
</defs>
<g fill="none" stroke="url(#foil)">
 <line x1="{cx - 330}" y1="148" x2="{cx - 40}" y2="148" stroke-width="2"/>
 <line x1="{cx + 40}" y1="148" x2="{cx + 330}" y2="148" stroke-width="2"/>
 <line x1="{cx - 330}" y1="372" x2="{cx + 330}" y2="372" stroke-width="2"/>
 <line x1="{cx - 300}" y1="382" x2="{cx + 300}" y2="382" stroke-width="0.8"/>
</g>
<path d="M{cx} 132 l14 16 l-14 16 l-14 -16z" fill="url(#foil)"/>
<circle cx="{cx - 340}" cy="148" r="4" fill="url(#foil)"/><circle cx="{cx + 340}" cy="148" r="4" fill="url(#foil)"/>
<text x="{cx}" y="320" text-anchor="middle" font-family="garamond" font-size="168" letter-spacing="26" fill="url(#foil)">{word}</text>
<text x="{cx}" y="430" text-anchor="middle" font-family="garamond-i" font-size="34" letter-spacing="10" fill="url(#foil)">{sub}</text>
</svg>'''


def build_logos(r: Renderer):
    css = font_css("garamond", "garamond-i")
    files = []
    for name, word, sub in (("logo_en", "DURAK", "· EST. MMXXVI ·"), ("logo_ru", "ДУРАК", "· подкидной ·")):
        im = r.render(logo_svg(word, sub), 1024, 512, ss=2.0, css=css, wait_fonts=True)
        # foil: faint sparkle + slight transparency so felt fibres show through when printed
        a = np.asarray(im, dtype=np.float64)
        spark = band_noise(512, 1024, 1.5, 91)
        a[..., :3] *= (1 + 0.06 * spark)[..., None]
        a[..., 3] *= 0.92
        img = Image.fromarray(np.uint8(np.clip(a, 0, 255)), "RGBA")
        files += save(img, f"table/{name}", webp_q=90, png=True, png_quant=False)
    return files


def build(r: Renderer) -> dict:
    felts = build_felt()
    build_walnut()
    build_leather()
    build_brass()
    logos = build_logos(r)
    return {"felts": felts, "logos": logos}


if __name__ == "__main__":
    r = Renderer()
    build(r)
    r.close()
