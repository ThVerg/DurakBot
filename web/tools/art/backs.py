"""Four procedurally generated card backs (512×716, rounded, transparent corners).

  red        – deep red guilloche lattice + tone-on-tone damask, gold frame & medallion
  navy       – midnight navy with gold filigree (hypotrochoid rosettes, lattice)
  khokhloma  – black lacquer with red berries and gold "travka" curls (folk floral)
  gzhel      – cobalt brush-stroke roses on white porcelain

All designs have 180° rotational symmetry like real card backs.
"""
from __future__ import annotations

import math
import random

import numpy as np
from PIL import Image, ImageFilter

from cards import RADIUS, rounded_mask, suit_symbol
from common import Renderer, band_noise, fbm, font_css, save
from svgkit import (cubic, f, gold_defs, guilloche_oval, guilloche_ring, hypotrochoid, mirror_x,
                    path_d, poly, rect_frame, rot180, spiral, taper_both, taper_tip, tapered, wave_field)

W, H = 512, 716
CX, CY = W / 2, H / 2

BACKS = {
    "red": {"en": "Crimson Guilloche", "ru": "Багровая гильоширь"},
    "navy": {"en": "Midnight Filigree", "ru": "Полночная филигрань"},
    "khokhloma": {"en": "Khokhloma", "ru": "Хохлома"},
    "gzhel": {"en": "Gzhel", "ru": "Гжель"},
}


def svg_doc(defs: str, body: str) -> str:
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">'
            f"<defs>{gold_defs()}{defs}</defs>{body}</svg>")


def sym4(make) -> str:
    """Draw a motif for the top-left quadrant reference and replicate with mirror + 180° rotation."""
    a = make()
    return (a + f'<g transform="translate({W} 0) scale(-1 1)">{a}</g>'
            + f'<g transform="rotate(180 {CX} {CY})">{a}<g transform="translate({W} 0) scale(-1 1)">{a}</g></g>')


def gold_frame(inset=17, inner=24, rad=12, colour="url(#gold)", corner=True) -> str:
    s = rect_frame(inset, inset, W - 2 * inset, H - 2 * inset, rad, colour, 2.4)
    s += rect_frame(inner, inner, W - 2 * inner, H - 2 * inner, rad - 4, colour, 0.8)
    if corner:
        def c():
            x, y = inner + 16, inner + 16
            out = poly(hypotrochoid(x, y, 8, 3, 5, 1.55, steps=600), closed=False, fill="none", stroke=colour, stroke_width=0.7)
            out += f'<circle cx="{x}" cy="{y}" r="2.2" fill="{colour}"/>'
            # little diamond bead + scroll lines along the frame
            for dx, dy in ((1, 0), (0, 1)):
                x0, y0 = x + dx * 16, y + dy * 16
                out += f'<path d="M{x0} {y0} l{3 * dx + 2 * dy} {3 * dy + 2 * dx} l{3 * dx - 2 * dy} {3 * dy - 2 * dx} l{-3 * dx - 2 * dy} {-3 * dy - 2 * dx}z" fill="{colour}" transform="translate({-3 * dx} {-3 * dy})"/>'
                out += f'<line x1="{x0 + 6 * dx}" y1="{y0 + 6 * dy}" x2="{x0 + 46 * dx}" y2="{y0 + 46 * dy}" stroke="{colour}" stroke-width="0.6"/>'
            return out
        s += sym4(c)
    return s


# ------------------------------------------------------------------------- red
def damask_motif(cx, cy, s, fill) -> str:
    """Tone-on-tone damask ornament, vertically symmetric."""
    parts = []
    # central leaf
    leaf = cubic((cx, cy - 26 * s), (cx + 12 * s, cy - 8 * s), (cx + 9 * s, cy + 12 * s), (cx, cy + 22 * s), 24)
    parts.append(leaf + mirror_x(leaf, cx)[::-1])
    for side in (1, -1):
        # big outward scroll curling down
        c = cubic((cx + side * 3 * s, cy - 6 * s), (cx + side * 30 * s, cy - 30 * s), (cx + side * 48 * s, cy + 2 * s), (cx + side * 30 * s, cy + 14 * s), 30)
        sp = spiral(cx + side * 24 * s, cy + 6 * s, 9 * s, 2.5 * s, math.atan2(14 - 6, side * 6) , 1.1, 30, cw=side < 0)
        parts.append(tapered(c + sp[1:], taper_both(6 * s)))
        # small upper tendril
        c2 = cubic((cx + side * 2 * s, cy - 20 * s), (cx + side * 14 * s, cy - 40 * s), (cx + side * 26 * s, cy - 34 * s), (cx + side * 22 * s, cy - 26 * s), 24)
        parts.append(tapered(c2, taper_tip(3.5 * s)))
        # lower petals
        c3 = cubic((cx, cy + 18 * s), (cx + side * 18 * s, cy + 22 * s), (cx + side * 22 * s, cy + 36 * s), (cx + side * 10 * s, cy + 42 * s), 24)
        parts.append(tapered(c3, taper_both(5 * s)))
    out = "".join(f'<path d="{path_d(p)}" fill="{fill}"/>' for p in parts)
    out += f'<circle cx="{f(cx)}" cy="{f(cy - 34 * s)}" r="{f(3.2 * s)}" fill="{fill}"/>'
    out += f'<circle cx="{f(cx)}" cy="{f(cy + 30 * s)}" r="{f(2.4 * s)}" fill="{fill}"/>'
    return out


def back_red(shapes) -> str:
    defs = ('<radialGradient id="rf" cx="50%" cy="50%" r="75%"><stop offset="0" stop-color="#9e1a2b"/>'
            '<stop offset="0.55" stop-color="#6e0e1b"/><stop offset="1" stop-color="#3c0610"/></radialGradient>'
            '<radialGradient id="rm" cx="50%" cy="45%" r="60%"><stop offset="0" stop-color="#8a1424"/>'
            '<stop offset="1" stop-color="#4a0812"/></radialGradient>'
            f'<clipPath id="rclip"><rect x="24" y="24" width="{W - 48}" height="{H - 48}" rx="8"/></clipPath>')
    body = [f'<rect width="{W}" height="{H}" fill="url(#rf)"/>']
    field = []
    # damask lattice (half-drop repeat)
    for j in range(-1, 9):
        for i in range(-1, 6):
            x = i * 104 + (52 if j % 2 else 0) + 4
            y = j * 92 + 4
            field.append(damask_motif(x, y, 0.95, "#c23347"))
    body.append(f'<g clip-path="url(#rclip)"><g opacity="0.3">{"".join(field)}</g>')
    # crossing guilloche lattice
    for ang in (28, -28):
        body.append(f'<g transform="rotate({ang} {CX} {CY})" opacity="1">'
                    + wave_field(W, H, 6.5, 3.2, 46, "#e46b7c", 0.45, 0.20, margin=260) + "</g>")
    body.append("</g>")
    # frame
    body.append(f'<rect x="0" y="0" width="{W}" height="{H}" fill="none" stroke="#2a030a" stroke-width="10" opacity="0.55"/>')
    body.append(gold_frame())
    # central medallion
    body.append(f'<ellipse cx="{CX}" cy="{CY}" rx="150" ry="186" fill="#3a0510" opacity="0.35"/>')
    body.append(guilloche_oval(CX, CY, 118, 152, 146, 182, 16, 22, "url(#gold)", 0.55))
    body.append(f'<ellipse cx="{CX}" cy="{CY}" rx="149" ry="185" fill="none" stroke="url(#gold)" stroke-width="2"/>')
    body.append(f'<ellipse cx="{CX}" cy="{CY}" rx="115" ry="149" fill="url(#rm)" stroke="url(#gold)" stroke-width="1.6"/>')
    body.append(guilloche_oval(CX, CY, 92, 122, 108, 142, 10, 40, "#d9a85a", 0.35, opacity=0.6))
    body.append(f'<ellipse cx="{CX}" cy="{CY}" rx="90" ry="120" fill="none" stroke="url(#gold)" stroke-width="0.9"/>')
    # rosette + four suits
    body.append(poly(hypotrochoid(CX, CY, 12, 7, 6, 3.0, steps=1600), closed=False, fill="none", stroke="url(#gold)", stroke_width=0.7))
    body.append(f'<circle cx="{CX}" cy="{CY}" r="6" fill="url(#gold)"/>')
    for s, (dx, dy) in zip("SHDC", ((0, -78), (58, 0), (0, 78), (-58, 0))):
        body.append(suit_symbol(shapes[s], CX + dx, CY + dy, 40, "url(#goldV)",
                                'stroke="#5a3a10" stroke-width="0.6" vector-effect="non-scaling-stroke"'))
    return svg_doc(defs, "".join(body))


# ------------------------------------------------------------------------ navy
def back_navy(shapes) -> str:
    defs = ('<radialGradient id="nf" cx="50%" cy="50%" r="75%"><stop offset="0" stop-color="#1b3a70"/>'
            '<stop offset="0.6" stop-color="#0c1d44"/><stop offset="1" stop-color="#060e26"/></radialGradient>'
            f'<clipPath id="nclip"><rect x="24" y="24" width="{W - 48}" height="{H - 48}" rx="8"/></clipPath>'
            '<radialGradient id="nm" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#132c5c"/>'
            '<stop offset="1" stop-color="#081537"/></radialGradient>')
    body = [f'<rect width="{W}" height="{H}" fill="url(#nf)"/>']
    lat = []
    step = 32
    for k in range(-30, 40):
        x0 = k * step
        lat.append(f'<line x1="{x0}" y1="0" x2="{x0 + H * 0.62}" y2="{H}" />')
        lat.append(f'<line x1="{x0}" y1="0" x2="{x0 - H * 0.62}" y2="{H}" />')
    body.append(f'<g clip-path="url(#nclip)"><g stroke="#c9a352" stroke-width="0.5" opacity="0.32">{"".join(lat)}</g>')
    # small four-point stars at lattice cells
    stars = []
    dx = step / 2
    dy = dx / 0.62
    for j in range(-2, int(H / dy) + 3):
        for i in range(-2, int(W / step) + 3):
            x = i * step + (dx if j % 2 else 0) + (0 if True else 0)
            y = j * dy
            r = 3.0
            stars.append(f'<path d="M{f(x)} {f(y - r)} Q{f(x)} {f(y)} {f(x + r)} {f(y)} Q{f(x)} {f(y)} {f(x)} {f(y + r)} Q{f(x)} {f(y)} {f(x - r)} {f(y)} Q{f(x)} {f(y)} {f(x)} {f(y - r)}Z"/>')
    body.append(f'<g fill="#e2c06f" opacity="0.55" transform="translate({f(dx / 2)} 0)">{"".join(stars)}</g></g>')
    body.append(f'<rect x="0" y="0" width="{W}" height="{H}" fill="none" stroke="#02060f" stroke-width="10" opacity="0.6"/>')
    body.append(gold_frame())
    # corner quarter rosettes
    def corner():
        x, y = 24, 24
        return (f'<g clip-path="url(#nclip)">' + poly(hypotrochoid(x, y, 10, 3, 6, 6.2, steps=1400), closed=False, fill="none", stroke="url(#gold)", stroke_width=0.55)
                + f'<circle cx="{x}" cy="{y}" r="58" fill="none" stroke="url(#gold)" stroke-width="1"/></g>')
    body.append(sym4(corner))
    # medallion: filigree rosettes
    body.append(f'<circle cx="{CX}" cy="{CY}" r="168" fill="#050c22" opacity="0.45"/>')
    body.append(f'<circle cx="{CX}" cy="{CY}" r="160" fill="url(#nm)" stroke="url(#gold)" stroke-width="2.2"/>')
    body.append(f'<circle cx="{CX}" cy="{CY}" r="154" fill="none" stroke="url(#gold)" stroke-width="0.7"/>')
    body.append(poly(hypotrochoid(CX, CY, 21, 8, 10, 6.8, steps=4000), closed=False, fill="none", stroke="url(#gold)", stroke_width=0.6))
    body.append(poly(hypotrochoid(CX, CY, 15, 4, 7, 6.6, steps=3000, rot=math.pi / 15), closed=False, fill="none", stroke="#e8cd85", stroke_width=0.45, opacity=0.8))
    body.append(guilloche_ring(CX, CY, 132, 150, 6, 36, "url(#gold)", 0.5))
    body.append(f'<circle cx="{CX}" cy="{CY}" r="54" fill="#08163a" stroke="url(#gold)" stroke-width="1.8"/>')
    body.append(f'<circle cx="{CX}" cy="{CY}" r="48" fill="none" stroke="url(#gold)" stroke-width="0.6"/>')
    body.append(f'<text x="{CX}" y="{CY + 25}" text-anchor="middle" font-family="garamond" font-size="72" fill="url(#goldV)">Д</text>')
    for i in range(24):
        a = 2 * math.pi * i / 24
        body.append(f'<circle cx="{f(CX + 164 * math.cos(a))}" cy="{f(CY + 164 * math.sin(a))}" r="{1.8 if i % 2 else 2.6}" fill="url(#gold)"/>')
    return svg_doc(defs, "".join(body))


# ------------------------------------------------------------------- khokhloma
def berry(x, y, r, uid) -> str:
    return (f'<circle cx="{f(x)}" cy="{f(y)}" r="{f(r)}" fill="url(#kberry)" stroke="#2b0503" stroke-width="0.8"/>'
            f'<circle cx="{f(x - r * 0.35)}" cy="{f(y - r * 0.35)}" r="{f(r * 0.26)}" fill="#f6d27a" opacity="0.95"/>'
            f'<circle cx="{f(x + r * 0.2)}" cy="{f(y + r * 0.25)}" r="{f(r * 0.12)}" fill="#1a0302" opacity="0.6"/>')


def kh_leaf(x, y, ang, length, width, fill, vein="#7a1d0c") -> str:
    ca, sa = math.cos(ang), math.sin(ang)
    def tr(p):
        return (x + p[0] * ca - p[1] * sa, y + p[0] * sa + p[1] * ca)
    c1 = cubic((0, 0), (length * 0.3, -width), (length * 0.75, -width * 0.8), (length, 0), 20)
    c2 = cubic((length, 0), (length * 0.75, width * 0.8), (length * 0.3, width), (0, 0), 20)
    shape = [tr(p) for p in c1 + c2[1:]]
    v = [tr(p) for p in cubic((length * 0.05, 0), (length * 0.4, width * 0.15), (length * 0.7, 0.1), (length * 0.9, 0), 12)]
    return (f'<path d="{path_d(shape)}" fill="{fill}" stroke="#3a1a05" stroke-width="0.5"/>'
            + f'<path d="{path_d(v, False)}" fill="none" stroke="{vein}" stroke-width="0.9" stroke-linecap="round"/>')


def travka(x, y, ang, size, cw, fill) -> str:
    """Khokhloma 'grass' curl: a tapered stroke ending in a tight spiral."""
    ca, sa = math.cos(ang), math.sin(ang)
    s = 1 if cw else -1
    stem = cubic((0, 0), (size * 0.4, -s * size * 0.15), (size * 0.75, -s * size * 0.35), (size * 0.85, -s * size * 0.55), 20)
    ex, ey = stem[-1]
    sp = spiral(ex - size * 0.16, ey, size * 0.16, size * 0.03, 0.0, 1.3, 40, cw=not cw)
    pts = [(x + px * ca - py * sa, y + px * sa + py * ca) for px, py in stem + sp[1:]]
    return f'<path d="{path_d(tapered(pts, lambda t: size * 0.11 * (1 - t) ** 0.9 + 0.3))}" fill="{fill}"/>'


def back_khokhloma(shapes) -> str:
    rnd = random.Random(1337)
    defs = ('<radialGradient id="kf" cx="50%" cy="50%" r="72%"><stop offset="0" stop-color="#22140c"/>'
            '<stop offset="0.6" stop-color="#0e0806"/><stop offset="1" stop-color="#040202"/></radialGradient>'
            '<radialGradient id="kberry" cx="35%" cy="35%" r="70%"><stop offset="0" stop-color="#ff5a3c"/>'
            '<stop offset="0.45" stop-color="#d0201a"/><stop offset="1" stop-color="#6e0805"/></radialGradient>'
            '<radialGradient id="kpetal" cx="50%" cy="90%" r="90%"><stop offset="0" stop-color="#7a0a08"/>'
            '<stop offset="0.6" stop-color="#c8231b"/><stop offset="1" stop-color="#e8452c"/></radialGradient>'
            '<linearGradient id="kgold" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="512" y2="716">'
            '<stop offset="0" stop-color="#c88a1e"/><stop offset="0.3" stop-color="#f5cf5a"/><stop offset="0.5" stop-color="#d79a26"/>'
            '<stop offset="0.7" stop-color="#f7d769"/><stop offset="1" stop-color="#b8771a"/></linearGradient>'
            f'<clipPath id="kclip"><rect x="30" y="30" width="{W - 60}" height="{H - 60}" rx="8"/></clipPath>')
    G = "url(#kgold)"
    body = [f'<rect width="{W}" height="{H}" fill="url(#kf)"/>']

    def along(stem, t):
        i = min(int(t * (len(stem) - 1)), len(stem) - 2)
        (x0, y0), (x1, y1) = stem[i], stem[i + 1]
        return x0, y0, math.atan2(y1 - y0, x1 - x0)

    def grow(stem, w0, n_curl, n_leaf, berries, curl0, side_bias=0) -> list[str]:
        out = [f'<path d="{path_d(tapered(stem, lambda t: w0 * (1 - t) ** 0.8 + 1.0))}" fill="{G}"/>']
        for k in range(n_curl):
            t = 0.06 + 0.9 * k / max(n_curl - 1, 1)
            x0, y0, a = along(stem, t)
            side = (k + side_bias) % 2
            sz = curl0 * (1 - 0.45 * t) * rnd.uniform(0.85, 1.15)
            out.append(travka(x0, y0, a + (1.0 if side else -1.0), sz, bool(side), G))
            # a tiny echo curl
            out.append(travka(x0, y0, a + (1.6 if side else -1.6), sz * 0.55, not side, G))
        for k in range(n_leaf):
            t = 0.1 + 0.8 * k / max(n_leaf - 1, 1)
            x0, y0, a = along(stem, t)
            side = 1 if k % 2 else -1
            ln = (46 - 18 * t) * rnd.uniform(0.9, 1.1)
            red = k % 3 == 1
            out.append(kh_leaf(x0, y0, a + side * 0.8, ln, ln * 0.34, "url(#kpetal)" if red else G,
                               vein="#4a0b05" if red else "#8a5410"))
        for t, n, off in berries:
            x0, y0, a = along(stem, t)
            bx, by = x0 + off * math.cos(a + 1.3), y0 + off * math.sin(a + 1.3)
            for k in range(n):
                aa = 2 * math.pi * k / n + 0.3
                out.append(f'<line x1="{f(bx)}" y1="{f(by)}" x2="{f(bx + 14 * math.cos(aa))}" y2="{f(by + 14 * math.sin(aa))}" stroke="{G}" stroke-width="1.1"/>')
            for k in range(n):
                aa = 2 * math.pi * k / n + 0.3
                out.append(berry(bx + 14 * math.cos(aa), by + 14 * math.sin(aa), 9.5 + rnd.random() * 2.5, k))
            if n >= 4:
                out.append(berry(bx, by, 9, 0))
        for _ in range(30):
            x0, y0, a = along(stem, rnd.random() * 0.95)
            out.append(f'<circle cx="{f(x0 + rnd.uniform(-44, 44))}" cy="{f(y0 + rnd.uniform(-44, 44))}" r="{f(rnd.uniform(1.1, 2.6))}" fill="{G}" opacity="0.9"/>')
        return out

    def branch() -> str:
        main = cubic((CX - 40, CY - 64), (CX - 170, CY - 110), (40, 280), (118, 64), 80)
        side = cubic(main[34], (40, CY - 60), (38, CY - 10), (70, CY + 6), 50)
        top = cubic(main[60], (150, 140), (205, 100), (CX - 8, 70), 50)
        out = []
        out += grow(side, 5, 6, 3, [(0.7, 4, 22)], 34, 1)
        out += grow(top, 4.5, 6, 3, [(0.75, 3, 18)], 30, 0)
        out += grow(main, 9, 12, 6, [(0.3, 5, 30), (0.58, 4, 26), (0.9, 3, 20)], 44)
        return "".join(out)

    body.append(f'<g clip-path="url(#kclip)">{sym4(branch)}</g>')
    # centre flower: layered red petals with gold rims
    fl = []
    for k in range(16):
        a = 2 * math.pi * k / 16
        fl.append(travka(CX + 60 * math.cos(a), CY + 60 * math.sin(a), a, 40, bool(k % 2), G))
    for ring, (n, rlen, rw, off) in enumerate(((12, 84, 36, 0.0), (9, 62, 32, 0.3), (6, 40, 26, 0.1))):
        for k in range(n):
            a = 2 * math.pi * k / n + off
            fl.append(kh_leaf(CX, CY, a, rlen, rw, "url(#kpetal)" if ring != 1 else G, vein="#3a0503" if ring != 1 else "#8a5410"))
    fl.append(f'<circle cx="{CX}" cy="{CY}" r="16" fill="{G}" stroke="#3a1a05" stroke-width="0.8"/>')
    for k in range(12):
        a = 2 * math.pi * k / 12
        fl.append(f'<circle cx="{f(CX + 11 * math.cos(a))}" cy="{f(CY + 11 * math.sin(a))}" r="2" fill="#a0180f"/>')
    fl.append(f'<circle cx="{CX}" cy="{CY}" r="5" fill="#a0180f"/>')
    body.append("".join(fl))
    # border: gold band with red bead line
    body.append(f'<rect x="0" y="0" width="{W}" height="{H}" fill="none" stroke="#000" stroke-width="10" opacity="0.5"/>')
    body.append(rect_frame(16, 16, W - 32, H - 32, 12, G, 3.2))
    body.append(rect_frame(23, 23, W - 46, H - 46, 9, "#c8231b", 1.6))
    body.append(rect_frame(28, 28, W - 56, H - 56, 7, G, 0.8))
    beads = []
    per = 2 * (W - 46 + H - 46)
    n = 120
    for k in range(n):
        d = per * k / n
        x, y = 23, 23
        L1, L2 = W - 46, H - 46
        if d < L1: x += d
        elif d < L1 + L2: x += L1; y += d - L1
        elif d < 2 * L1 + L2: x += L1 - (d - L1 - L2); y += L2
        else: y += L2 - (d - 2 * L1 - L2)
        beads.append(f'<circle cx="{f(x)}" cy="{f(y)}" r="1.2" fill="{G}"/>')
    body.append("".join(beads))
    return svg_doc(defs, "".join(body))


# ----------------------------------------------------------------------- gzhel
COBALT = "#0d2f9c"


def gz_stroke(x, y, ang, length, width, uid, curve=0.35, flip=False) -> str:
    """Gzhel 'мазок с тенями': one loaded-brush stroke, dense cobalt on one side fading to white."""
    ca, sa = math.cos(ang), math.sin(ang)
    s = -1 if flip else 1
    c1 = cubic((0, 0), (length * 0.25, -s * width * 1.1), (length * 0.8, -s * width * (0.9 + curve)), (length, -s * width * curve * 0.8), 24)
    c2 = cubic((length, -s * width * curve * 0.8), (length * 0.7, -s * width * curve * 0.2), (length * 0.3, s * width * 0.15), (0, 0), 24)
    pts = [(x + px * ca - py * sa, y + px * sa + py * ca) for px, py in c1 + c2[1:]]
    # gradient across the stroke (perpendicular to its axis)
    nx, ny = sa * s, -ca * s
    gx1, gy1 = x + nx * width * 1.0, y + ny * width * 1.0
    gx2, gy2 = x - nx * width * 0.2, y - ny * width * 0.2
    gid = f"gz{uid}"
    grad = (f'<linearGradient id="{gid}" gradientUnits="userSpaceOnUse" x1="{f(gx1)}" y1="{f(gy1)}" x2="{f(gx2)}" y2="{f(gy2)}">'
            f'<stop offset="0" stop-color="#0a2280"/><stop offset="0.45" stop-color="#1d48c4"/>'
            f'<stop offset="0.85" stop-color="#7f9be0"/><stop offset="1" stop-color="#e9eefa"/></linearGradient>')
    return grad, f'<path d="{path_d(pts)}" fill="url(#{gid})"/>'


class Ctr:
    n = 0

    @classmethod
    def next(cls):
        cls.n += 1
        return cls.n


def gz_crescent(cx, cy, r0, r1, a0, a1, gid, tilt=0.0) -> str:
    """One loaded-brush petal on a ring: round 'press' at a0, long taper to a point at a1."""
    n = 48
    outer, inner = [], []
    T = r1 - r0
    for i in range(n + 1):
        u = i / n
        th = T * (math.sqrt(u / 0.14) if u < 0.14 else ((1 - u) / 0.86) ** 0.85)
        a = a0 + (a1 - a0) * u
        ro = r1 * (1 - tilt * u)
        outer.append((cx + ro * math.cos(a), cy + ro * math.sin(a)))
        inner.append((cx + (ro - th) * math.cos(a), cy + (ro - th) * math.sin(a)))
    rc = T * 0.5
    px, py = cx + (r1 - rc) * math.cos(a0 + (a1 - a0) * 0.12), cy + (r1 - rc) * math.sin(a0 + (a1 - a0) * 0.12)
    return (f'<path d="{path_d(outer + inner[::-1])}" fill="url(#{gid})"/>'
            f'<circle cx="{f(px)}" cy="{f(py)}" r="{f(rc * 0.98)}" fill="url(#{gid})"/>')


def gz_rose(cx, cy, R, rot=0.0) -> tuple[str, str]:
    """Gzhel rose: stacked crescent strokes, cobalt on the outer edge fading to white inside."""
    uid = Ctr.next()
    gid = f"gzr{uid}"
    defs = (f'<radialGradient id="{gid}" gradientUnits="userSpaceOnUse" cx="{f(cx)}" cy="{f(cy)}" r="{f(R)}">'
            f'<stop offset="0" stop-color="#ffffff"/><stop offset="0.25" stop-color="#e9eefa"/>'
            f'<stop offset="0.55" stop-color="#6d8ddc"/><stop offset="0.8" stop-color="#1c46bf"/>'
            f'<stop offset="1" stop-color="#0a2280"/></radialGradient>')
    body = []
    rings = ((3, 0.68, 1.0, 1.0), (3, 0.46, 0.76, 1.0), (2, 0.26, 0.52, 1.0))
    for ri, (n, a, b, span) in enumerate(rings):
        ccx, ccy = cx, cy - R * 0.07 * ri
        g2 = f"{gid}_{ri}"
        defs += (f'<radialGradient id="{g2}" gradientUnits="userSpaceOnUse" cx="{f(ccx)}" cy="{f(ccy)}" r="{f(R * b * 1.06)}">'
                 f'<stop offset="0" stop-color="#ffffff"/><stop offset="{a / b * 0.95:.3f}" stop-color="#f4f6fc"/>'
                 f'<stop offset="{(a + (b - a) * 0.3) / b:.3f}" stop-color="#6d8ddc"/>'
                 f'<stop offset="{(a + (b - a) * 0.62) / b:.3f}" stop-color="#1a42b8"/>'
                 f'<stop offset="1" stop-color="#081c70"/></radialGradient>')
        # petals mirror about the vertical axis: right half sweeps clockwise from the
        # bottom, left half counter-clockwise, like a painter working both sides.
        half_n = n
        for k in range(half_n):
            st = math.pi / 2 + 0.16 + (k + 0.35 * ri) * (math.pi / half_n) * 0.98
            ln = span * math.pi / half_n * 1.25
            for sgn in (1, -1):
                s0 = math.pi / 2 + sgn * (st - math.pi / 2)
                body.append(gz_crescent(ccx, ccy, R * a, R * b * (1 - 0.04 * k), s0, s0 - sgn * ln, g2, tilt=0.1))
    body.append(f'<circle cx="{f(cx)}" cy="{f(cy)}" r="{f(R * 0.2)}" fill="#0a2280"/>')
    body.append(f'<circle cx="{f(cx)}" cy="{f(cy)}" r="{f(R * 0.2)}" fill="url(#{gid})" opacity="0.35"/>')
    sp = spiral(cx, cy, R * 0.15, R * 0.025, rot, 1.4, 40)
    body.append(f'<path d="{path_d(tapered(sp, lambda t: R * 0.045 * (1 - t) + 0.4))}" fill="#f4f6fc"/>')
    for k in range(9):
        a2 = rot - math.pi / 2 + (k - 4) * 0.32
        body.append(f'<circle cx="{f(cx + R * 1.16 * math.cos(a2))}" cy="{f(cy + R * 1.16 * math.sin(a2))}" r="{f(max(R * 0.028, 1.0))}" fill="{COBALT}"/>')
    return defs, "".join(body)


def back_gzhel(shapes) -> str:
    Ctr.n = 0
    rnd = random.Random(7)
    defs = [('<radialGradient id="gf" cx="50%" cy="45%" r="75%"><stop offset="0" stop-color="#ffffff"/>'
             '<stop offset="0.7" stop-color="#f4f6fc"/><stop offset="1" stop-color="#e2e8f6"/></radialGradient>'
             f'<clipPath id="gclip"><rect x="34" y="34" width="{W - 68}" height="{H - 68}" rx="6"/></clipPath>')]
    body = [f'<rect width="{W}" height="{H}" fill="url(#gf)"/>']

    def branch_parts():
        d, b = [], []
        stem = cubic((CX - 40, CY - 80), (CX - 150, CY - 150), (70, 250), (110, 84), 60)
        b.append(f'<path d="{path_d(tapered(stem, lambda t: 3.2 * (1 - t) + 0.8))}" fill="{COBALT}"/>')
        # leaves: paired shaded strokes along the stem
        for t in (0.15, 0.3, 0.45, 0.6, 0.75):
            i = int(t * (len(stem) - 1))
            (x0, y0), (x1, y1) = stem[i], stem[i + 1]
            a = math.atan2(y1 - y0, x1 - x0)
            for side in (1, -1):
                g, s = gz_stroke(x0, y0, a + side * 1.05, 34 - t * 12, 12 - t * 3, Ctr.next(), flip=side < 0)
                d.append(g); b.append(s)
        # tendrils with drops
        for t in (0.22, 0.52, 0.82):
            i = int(t * (len(stem) - 1))
            x0, y0 = stem[i]
            sp = spiral(x0 + 18, y0 - 6, 16, 3, math.pi, 1.2, 40)
            b.append(f'<path d="{path_d(tapered(sp, lambda t: 1.8 * (1 - t) + 0.4))}" fill="{COBALT}"/>')
        for _ in range(14):
            t = rnd.random()
            i = int(t * (len(stem) - 1))
            x, y = stem[i]
            b.append(f'<circle cx="{f(x + rnd.uniform(-30, 30))}" cy="{f(y + rnd.uniform(-30, 30))}" r="{f(rnd.uniform(1.4, 2.8))}" fill="{COBALT}"/>')
        # a bud at the tip
        x, y = stem[-1]
        dr, br = gz_rose(x, y, 34, rot=0.4)
        d.append(dr); b.append(br)
        return "".join(d), "".join(b)

    d1, b1 = branch_parts()
    defs.append(d1)
    body.append(f'<g clip-path="url(#gclip)">{sym4(lambda: b1)}</g>')
    dr, br = gz_rose(CX, CY + 6, 104)
    defs.append(dr)
    for sgn in (1, -1):
        for (dx, dy, ang, ln, wd) in ((118, 40, 0.35, 74, 24), (112, -44, -0.5, 60, 20), (40, 128, 1.25, 56, 18)):
            g, b = gz_stroke(CX + sgn * dx * 0.86, CY + dy, ang if sgn > 0 else math.pi - ang, ln, wd, Ctr.next(), flip=sgn < 0)
            defs.append(g); body.append(b)
    # soft halo + rose
    body.append(br)
    # border: cobalt band with white scallops and a fine inner line
    body.append(f'<rect x="0" y="0" width="{W}" height="{H}" fill="none" stroke="{COBALT}" stroke-width="44"/>')
    sc = []
    step = 12.6
    for x in np.arange(22, W - 21, step):
        for y in (22, H - 22):
            sc.append(f'<circle cx="{f(x)}" cy="{f(y)}" r="4.2" fill="#f4f6fc"/>')
    for y in np.arange(22 + step, H - 22 - step + 1, step):
        for x in (22, W - 22):
            sc.append(f'<circle cx="{f(x)}" cy="{f(y)}" r="4.2" fill="#f4f6fc"/>')
    body.append("".join(sc))
    body.append(rect_frame(9, 9, W - 18, H - 18, 14, "#f4f6fc", 1.2))
    body.append(rect_frame(34, 34, W - 68, H - 68, 6, COBALT, 2))
    body.append(rect_frame(40, 40, W - 80, H - 80, 4, COBALT, 0.7))
    return svg_doc("".join(defs), "".join(body))


# ----------------------------------------------------------------- post-process
def finish(im: Image.Image, seed: int, gloss: float = 0.05) -> Image.Image:
    a = np.asarray(im, dtype=np.float64) / 255.0
    rgb = a[..., :3]
    yy, xx = np.mgrid[0:H, 0:W]
    u, v = xx / (W - 1), yy / (H - 1)
    grain = band_noise(H, W, 2.0, seed) * 0.010 + fbm(H, W, 120, 3, seed + 3) * 0.012
    rgb = rgb * (1 + grain[..., None])
    # broad soft specular sheen (lacquered stock)
    sheen = gloss * np.exp(-(((u - 0.3) * 1.2 + (v - 0.2) * 0.9) ** 2) / 0.05)
    rgb = rgb + sheen[..., None] * (1 - rgb) * 0.9
    mask = rounded_mask(W, H, RADIUS)
    m = np.asarray(mask, dtype=np.float64) / 255.0
    inner = np.asarray(mask.filter(ImageFilter.GaussianBlur(2.0)), dtype=np.float64) / 255.0
    rim = np.clip((m - inner) * 3.0, 0, 1)
    rgb = rgb * (1 - 0.25 * rim[..., None])
    out = np.dstack([np.clip(rgb, 0, 1) * 255, m * 255])
    return Image.fromarray(np.uint8(out + 0.5), "RGBA")


def build(r: Renderer, shapes: dict) -> list[dict]:
    makers = {"red": back_red, "navy": back_navy, "khokhloma": back_khokhloma, "gzhel": back_gzhel}
    css = font_css("garamond")
    out = []
    for i, (bid, fn) in enumerate(makers.items()):
        svg = fn(shapes)
        im = r.render(svg, W, H, ss=2.0, css=css, wait_fonts=True)
        im = finish(im, 100 + i, gloss=0.06 if bid != "gzhel" else 0.03)
        files = save(im, f"backs/{bid}", webp_q=88, png=True)
        save(im.resize((256, 358), Image.LANCZOS), f"backs_sm/{bid}", webp_q=88)
        out.append({"id": bid, "files": files, **BACKS[bid]})
    return out
