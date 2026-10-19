"""Dacha production art: wordmarks, frame, card backs, game-over illustrations.

All lettering is converted to outline paths (Playfair Display, OFL) so the SVGs need no fonts.
Usage: python kit_art.py <outdir>
"""
import math
import os
import random
import sys

from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

HERE = os.path.dirname(os.path.abspath(__file__))
FD = os.path.join(HERE, '..', 'fonts') + '/'
INK = '#33200f'
VERM, VERM_HI, VERM_LO = '#c8361f', '#e2563a', '#9b2414'
GOLD, GOLD_HI, GOLD_LO = '#e0a52a', '#f7d673', '#a86d12'
COBALT, COBALT_LO = '#2350b4', '#173a88'
GREEN, CREAM = '#2f6b45', '#fbf3e2'
_fonts = {}


def _font(p):
    if p not in _fonts:
        _fonts[p] = TTFont(p)
    return _fonts[p]


def text_path(text, size, x=0.0, y=0.0, tracking=0.0, weight='900', style='normal'):
    paths = [FD + f'playfair-display-cyrillic-{weight}-{style}.woff2', FD + f'playfair-display-latin-{weight}-{style}.woff2']
    out, cx = [], x
    for ch in text:
        if ch == ' ':
            f = _font(paths[1])
            cx += f['hmtx']['space'][0] * size / f['head'].unitsPerEm + tracking * size
            continue
        for p in paths:
            f = _font(p)
            cmap = f.getBestCmap()
            if ord(ch) in cmap:
                break
        else:
            raise ValueError(ch)
        sc = size / f['head'].unitsPerEm
        g = cmap[ord(ch)]
        gs = f.getGlyphSet()
        pen = SVGPathPen(gs, ntos=lambda v: f'{v:.1f}')
        gs[g].draw(TransformPen(pen, (sc, 0, 0, -sc, cx, y)))
        out.append(pen.getCommands())
        cx += f['hmtx'][g][0] * sc + tracking * size
    return ' '.join(out), cx - x - tracking * size


def centered(text, size, cx, baseline, tracking=0.0, **kw):
    _, w = text_path(text, size, 0, 0, tracking, **kw)
    d, _ = text_path(text, size, cx - w / 2, baseline, tracking, **kw)
    return d, w


def ribbon_text(d, fill='#fff8ea', shadow_col=INK, off=(4, 4)):
    return (f'<path d="{d}" fill="{shadow_col}" opacity=".55" transform="translate({off[0]} {off[1]})"/>'
            f'<path d="{d}" fill="{fill}"/>')


def lettering(d, shadow=(7, 7), outline=12, fill='url(#lgFill)'):
    """Lubok lettering stack: hatched cobalt misprint, cream outline, vermilion fill."""
    return (f'<path d="{d}" fill="url(#lgHatch)" transform="translate({shadow[0]} {shadow[1]})"/>'
            f'<path d="{d}" fill="{CREAM}" stroke="{CREAM}" stroke-width="{outline}" stroke-linejoin="round"/>'
            f'<path d="{d}" fill="{fill}"/>')


LG_DEFS = (f'<linearGradient id="lgFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{VERM_HI}"/>'
           f'<stop offset=".55" stop-color="{VERM}"/><stop offset="1" stop-color="#a5281a"/></linearGradient>'
           f'<pattern id="lgHatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(-35)">'
           f'<rect width="8" height="8" fill="{COBALT}"/><rect width="3" height="8" fill="#1b4299"/></pattern>')


def svg(w, h, body, defs=''):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:g} {h:g}" width="{w:g}" height="{h:g}">'
            + (f'<defs>{defs}</defs>' if defs else '') + body + '</svg>')


# ------------------------------------------------------------------ jester cap (shared)
def cap_group(tx, ty, sc=1.0, rot=0.0):
    return (f'<g transform="translate({tx} {ty}) rotate({rot}) scale({sc})">'
            f'<g stroke="{INK}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round">'
            f'<path d="M60 128 C 46 96 30 70 10 58 C 26 56 48 62 64 76 C 74 88 84 104 92 122 Z" fill="{COBALT}"/>'
            f'<path d="M150 124 C 166 96 186 74 210 66 C 196 60 170 62 152 74 C 140 86 132 102 126 120 Z" fill="{COBALT}"/>'
            f'<path d="M78 126 C 80 90 92 50 120 18 C 126 40 132 60 134 82 C 136 98 140 112 142 126 Z" fill="{VERM}"/>'
            f'<path d="M118 30 C 104 56 96 86 94 120" fill="none" stroke="#e86a4c"/>'
            f'<path d="M24 62 C 44 70 62 86 74 110" fill="none" stroke="#4f78d2"/>'
            f'<path d="M198 70 C 178 78 160 92 146 112" fill="none" stroke="#4f78d2"/>'
            f'<path d="M52 122 C 86 112 128 110 160 118 L 162 146 C 128 138 88 140 54 150 Z" fill="url(#capBand)"/>'
            f'<path d="M60 136 l8 -6 l8 6 l8 -6 l8 6 l8 -6 l8 6 l8 -6 l8 6 l8 -6 l8 6 l8 -6" fill="none" stroke="{VERM}" stroke-width="2.4"/>'
            f'<circle cx="10" cy="58" r="10" fill="url(#capBell)"/><circle cx="120" cy="14" r="10" fill="url(#capBell)"/><circle cx="210" cy="66" r="10" fill="url(#capBell)"/>'
            f'</g><g fill="#fff" opacity=".8"><circle cx="7" cy="54" r="2.4"/><circle cx="117" cy="10" r="2.4"/><circle cx="207" cy="62" r="2.4"/></g></g>')


CAP_DEFS = (f'<radialGradient id="capBell" cx="35%" cy="30%" r="70%"><stop offset="0" stop-color="#fff6c8"/><stop offset=".5" stop-color="#e8b23c"/><stop offset="1" stop-color="#9c6312"/></radialGradient>'
            f'<linearGradient id="capBand" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f6d06a"/><stop offset="1" stop-color="#c88a22"/></linearGradient>')


# ------------------------------------------------------------------ wordmarks
def wordmark_ru(with_cap=True):
    d, w = text_path('ДУРАК', 214, 60, 270)
    W = 60 + w + 40
    body = lettering(d, (12, 10), 14)
    if with_cap:
        body = cap_group(4, 34, 0.74, -16) + body
    return svg(round(W), 320, body, LG_DEFS + CAP_DEFS)


def wordmark_en():
    d, w = text_path('DURAK', 200, 30, 210, tracking=0.04)
    return svg(round(w + 70), 250, lettering(d, (10, 9), 13), LG_DEFS)


def wordmark_lockup():
    """Stacked lockup: cap + ДУРАК, flourish, D U R A K."""
    d, w = text_path('ДУРАК', 214, 60, 270)
    W = round(60 + w + 40)
    de, we = centered('D U R A K', 40, W / 2, 350, tracking=0.12, weight='700')
    fl = (f'<g fill="none" stroke="{GOLD_LO}" stroke-width="2" stroke-linecap="round">'
          f'<path d="M{W/2 - we/2 - 24} 336 C {W/2 - we/2 - 80} 326 {W/2 - we/2 - 120} 346 {W/2 - we/2 - 190} 336"/>'
          f'<path d="M{W/2 + we/2 + 24} 336 C {W/2 + we/2 + 80} 326 {W/2 + we/2 + 120} 346 {W/2 + we/2 + 190} 336"/></g>'
          f'<g fill="{VERM}"><circle cx="{W/2 - we/2 - 60}" cy="331" r="3.4"/><circle cx="{W/2 + we/2 + 60}" cy="331" r="3.4"/></g>'
          f'<g fill="{GOLD_LO}"><circle cx="{W/2 - we/2 - 196}" cy="336" r="2.6"/><circle cx="{W/2 + we/2 + 196}" cy="336" r="2.6"/></g>')
    body = cap_group(4, 34, 0.74, -16) + lettering(d, (12, 10), 14) + fl + f'<path d="{de}" fill="{INK}"/>'
    return svg(W, 372, body, LG_DEFS + CAP_DEFS)


def cap_svg():
    return svg(220, 170, cap_group(0, 0), CAP_DEFS)


# ------------------------------------------------------------------ medallion frame
def frame_svg():
    """Gold medallion ring for 200px portraits (inner hole r=100 at 110,110)."""
    beads = ''.join(f'<circle cx="{110 + 105.5*math.cos(math.radians(a)):.1f}" cy="{110 + 105.5*math.sin(math.radians(a)):.1f}" r="1.5"/>' for a in range(0, 360, 6))
    defs = (f'<linearGradient id="fg1" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff1b5"/><stop offset=".3" stop-color="#e9bd5a"/>'
            f'<stop offset=".55" stop-color="{GOLD_LO}"/><stop offset=".8" stop-color="#e9bd5a"/><stop offset="1" stop-color="#c98f2a"/></linearGradient>'
            f'<radialGradient id="fg2" cx="30%" cy="25%" r="60%"><stop offset="0" stop-color="#fffbe6" stop-opacity=".9"/><stop offset="1" stop-color="#fffbe6" stop-opacity="0"/></radialGradient>')
    ring = 'M110 0a110 110 0 1 0 0.01 0zM110 10a100 100 0 1 1 -0.01 0z'
    body = (f'<path d="{ring}" fill="url(#fg1)" fill-rule="evenodd"/><path d="{ring}" fill="url(#fg2)" fill-rule="evenodd"/>'
            f'<circle cx="110" cy="110" r="109" fill="none" stroke="#7a4812" stroke-opacity=".5" stroke-width="1.5"/>'
            f'<circle cx="110" cy="110" r="100.5" fill="none" stroke="#5a3410" stroke-opacity=".35" stroke-width="1.5"/>'
            f'<g fill="#fff8dc" opacity=".9">{beads}</g>')
    return svg(220, 220, body, defs)


# ------------------------------------------------------------------ card backs (250x350, r=13)
def back_khokhloma():
    def scroll(x, y, s, rot, flip=1):
        # golden "kudrina" curl: a stem rolling into a spiral with leaflets
        return (f'<g transform="translate({x} {y}) rotate({rot}) scale({s*flip} {s})">'
                f'<path d="M0 0 C 18 -6 34 -22 34 -40 C 34 -54 22 -60 14 -54 C 6 -48 10 -36 18 -38" fill="none" stroke="url(#gold)" stroke-width="4.5" stroke-linecap="round"/>'
                f'<path d="M12 -8 C 20 -2 30 0 38 -4 C 30 -10 20 -12 12 -8Z" fill="url(#gold)" stroke="#7a4812" stroke-width=".8"/>'
                f'<path d="M24 -20 C 32 -18 40 -22 44 -30 C 36 -32 28 -28 24 -20Z" fill="url(#gold)" stroke="#7a4812" stroke-width=".8"/>'
                f'</g>')

    def berry(x, y, r=7):
        return (f'<circle cx="{x}" cy="{y}" r="{r+1.6}" fill="url(#gold)"/><circle cx="{x}" cy="{y}" r="{r}" fill="#e2563a"/>'
                f'<circle cx="{x - r*.35:.1f}" cy="{y - r*.35:.1f}" r="{r*.32:.1f}" fill="#ffd9b8"/>'
                f'<circle cx="{x + r*.3:.1f}" cy="{y + r*.35:.1f}" r="{r*.14:.1f}" fill="{INK}"/>')

    def leaf(x, y, s, rot, col='#1f2a17'):
        return (f'<g transform="translate({x} {y}) rotate({rot}) scale({s})"><path d="M0 0 C 10 -10 26 -12 36 -4 C 26 4 10 6 0 0Z" fill="{col}" stroke="url(#gold)" stroke-width="1.4"/>'
                f'<path d="M3 0 C 12 -2 22 -3 32 -3" stroke="url(#gold)" stroke-width="1"/></g>')

    half = ''.join([
        '<path d="M125 175 C 120 140 108 118 92 104 C 76 90 66 72 70 52" fill="none" stroke="url(#gold)" stroke-width="4" stroke-linecap="round"/>',
        scroll(100, 118, 1.05, -150), scroll(78, 76, .8, -120), scroll(88, 150, .9, 160, -1),
        leaf(92, 104, .9, 200), leaf(74, 66, .8, 250), leaf(108, 134, .8, 150),
        scroll(70, 52, .55, -80), berry(62, 44, 6), berry(76, 40, 5),
    ])
    corner = scroll(30, 34, .55, 40) + berry(28, 30, 4.5)
    body = (f'<rect width="250" height="350" rx="13" fill="#fdf8ec"/>'
            f'<rect x="10" y="10" width="230" height="330" rx="8" fill="url(#red)"/>'
            f'<rect x="16" y="16" width="218" height="318" rx="5" fill="none" stroke="url(#gold)" stroke-width="2"/>'
            f'<g>{half}</g><g transform="translate(250 0) scale(-1 1)">{half}</g>'
            f'<g transform="translate(0 350) scale(1 -1)">{half}</g><g transform="translate(250 350) scale(-1 -1)">{half}</g>'
            f'<g>{corner}</g><g transform="translate(250 0) scale(-1 1)">{corner}</g><g transform="translate(0 350) scale(1 -1)">{corner}</g><g transform="translate(250 350) scale(-1 -1)">{corner}</g>'
            + berry(125, 175, 13) + ''.join(berry(125 + 26 * math.cos(math.radians(a)), 175 + 26 * math.sin(math.radians(a)), 7.5) for a in range(0, 360, 60)))
    defs = ('<linearGradient id="gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff0b0"/><stop offset=".45" stop-color="#e8b23c"/><stop offset="1" stop-color="#a86d12"/></linearGradient>'
            '<radialGradient id="red" cx="50%" cy="45%" r="70%"><stop offset="0" stop-color="#c8361f"/><stop offset="1" stop-color="#8e2212"/></radialGradient>')
    return svg(250, 350, body, defs)


STAR = """......r......
.....r.r.....
....r.k.r....
...r.k.k.r...
..r.k.y.k.r..
.r.k.yyy.k.r.
r.k.yy.yy.k.r
.r.k.yyy.k.r.
..r.k.y.k.r..
...r.k.k.r...
....r.k.r....
.....r.r.....
......r......""".split('\n')
COLS = {'r': VERM, 'k': '#7d1d14', 'y': '#d99a1c', 'b': COBALT, 'g': GREEN}


def back_stitch():
    rnd = random.Random(5)
    cell = 7.0  # 34 x 48 grid on a 250x350 card
    st = {}

    def put(cx, cy, c):
        st[(cx, cy)] = c
    # stitched frame
    gx0, gy0, gx1, gy1 = 3, 3, 31, 45
    for x in range(gx0, gx1 + 1):
        put(x, gy0, 'r'); put(x, gy1, 'r')
        if x % 3 == 0:
            put(x, gy0 + 2, 'k'); put(x, gy1 - 2, 'k')
    for y in range(gy0, gy1 + 1):
        put(gx0, y, 'r'); put(gx1, y, 'r')
        if y % 3 == 0:
            put(gx0 + 2, y, 'k'); put(gx1 - 2, y, 'k')
    # central star ×2
    ox, oy = 17 - 6, 24 - 6
    for j, row in enumerate(STAR):
        for i, ch in enumerate(row):
            if ch != '.':
                put(ox + i, oy + j, ch)
    # rushnyk bands: rows of small diamonds near top & bottom
    for by_ in (7, 41):
        for cx_ in range(6, 30, 4):
            for dx, dy in [(0, -1), (-1, 0), (1, 0), (0, 1)]:
                put(cx_ + dx, by_ + dy, 'r')
            put(cx_, by_, 'y')
        for x in range(gx0 + 2, gx1 - 1):
            put(x, by_ - 3 if by_ < 20 else by_ + 3, 'k')
    # small diamonds above/below + corner trees
    for (cx, cy) in [(17, 14), (17, 34)]:
        for dx, dy, c in [(0, -2, 'r'), (-1, -1, 'r'), (1, -1, 'r'), (-2, 0, 'r'), (2, 0, 'r'), (-1, 1, 'r'), (1, 1, 'r'), (0, 2, 'r'), (0, 0, 'g')]:
            put(cx + dx, cy + dy, c)
    for (cx, cy) in [(8, 17), (26, 17), (8, 31), (26, 31)]:
        for dx, dy in [(0, 0), (-1, 1), (1, 1), (0, 1), (0, -1), (-2, 2), (2, 2), (0, 2)]:
            put(cx + dx, cy + dy, 'g' if dy >= 0 else 'r')
    by = {}
    for (x, y), c in st.items():
        px, py = x * cell - 4, y * cell + 6
        j = lambda: rnd.uniform(-0.4, 0.4)
        a, b = 1.2, cell - 1.2
        by.setdefault(c, []).append(f'M{px+a+j():.1f} {py+a+j():.1f}L{px+b+j():.1f} {py+b+j():.1f}M{px+b+j():.1f} {py+a+j():.1f}L{px+a+j():.1f} {py+b+j():.1f}')
    stitches = ''.join(f'<path d="{"".join(v)}" stroke="{COLS[k]}" stroke-width="2.6" stroke-linecap="round" fill="none"/>' for k, v in by.items())
    body = ('<rect width="250" height="350" rx="13" fill="#f6ecd6"/><rect width="250" height="350" rx="13" fill="url(#weave)"/>' + stitches)
    defs = ('<pattern id="weave" width="4" height="4" patternUnits="userSpaceOnUse"><path d="M0 1H4M1 0V4" stroke="#e3d3b2" stroke-width=".7"/></pattern>')
    return svg(250, 350, body, defs)


# ------------------------------------------------------------------ game-over illustrations
def rays(cx, cy, r0, r1, n, c1, c2):
    out = []
    for k in range(n):
        a0 = math.radians(k * 360 / n)
        a1 = math.radians((k + 1) * 360 / n)
        col = c1 if k % 2 == 0 else c2
        out.append(f'<path d="M{cx + r0*math.cos(a0):.1f} {cy + r0*math.sin(a0):.1f} L{cx + r1*math.cos(a0):.1f} {cy + r1*math.sin(a0):.1f} '
                   f'L{cx + r1*math.cos(a1):.1f} {cy + r1*math.sin(a1):.1f} L{cx + r0*math.cos(a1):.1f} {cy + r0*math.sin(a1):.1f}Z" fill="{col}"/>')
    return ''.join(out)


def scallop_badge(cx, cy, r, n, fill, stroke=INK):
    pts = []
    for k in range(n * 2):
        a = math.radians(k * 180 / n)
        rr = r if k % 2 == 0 else r * 0.93
        pts.append(f'{cx + rr*math.cos(a):.1f} {cy + rr*math.sin(a):.1f}')
    return f'<path d="M{" L".join(pts)}Z" fill="{fill}" stroke="{stroke}" stroke-width="3" stroke-linejoin="round"/>'


def ribbon(cx, cy, w, h, fill=VERM, lo=VERM_LO):
    x0, x1 = cx - w / 2, cx + w / 2
    t = h * 0.55
    return (f'<path d="M{x0 - 46} {cy - h/2 + 14} L{x0 + 10} {cy - h/2 + 14} L{x0 + 10} {cy + h/2 + 14} L{x0 - 46} {cy + h/2 + 14} L{x0 - 28} {cy + 14}Z" fill="{lo}" stroke="{INK}" stroke-width="3" stroke-linejoin="round"/>'
            f'<path d="M{x1 + 46} {cy - h/2 + 14} L{x1 - 10} {cy - h/2 + 14} L{x1 - 10} {cy + h/2 + 14} L{x1 + 46} {cy + h/2 + 14} L{x1 + 28} {cy + 14}Z" fill="{lo}" stroke="{INK}" stroke-width="3" stroke-linejoin="round"/>'
            f'<rect x="{x0}" y="{cy - h/2}" width="{w}" height="{h}" rx="4" fill="{fill}" stroke="{INK}" stroke-width="3"/>'
            f'<rect x="{x0 + 7}" y="{cy - h/2 + 7}" width="{w - 14}" height="{h - 14}" rx="2" fill="none" stroke="{GOLD_HI}" stroke-width="1.6" opacity=".8"/>')


def durak_illustration(word):
    """Game over (you are the durak): the jester cap drops onto a woodcut stamp."""
    W, H = 640, 520
    cx, cy = 320, 300
    _, w0 = text_path(word, 112)
    size = min(112, 112 * 400 / w0)
    d, w = centered(word, size, cx, cy + 40 - (112 - size) * 0.35)
    body = (f'<g opacity=".95">{scallop_badge(cx, cy, 205, 28, "#fbf0d6")}</g>'
            f'<g clip-path="url(#badgeClip)">{rays(cx, cy, 0, 230, 36, "#f6dcae", "#fbf0d6")}</g>'
            f'<circle cx="{cx}" cy="{cy}" r="176" fill="none" stroke="{VERM}" stroke-width="2.4" stroke-dasharray="2 8" stroke-linecap="round"/>'
            # motion lines + stars from the falling cap
            f'<g stroke="{INK}" stroke-width="3.4" stroke-linecap="round" fill="none"><path d="M226 92 L210 62"/><path d="M262 78 L254 44"/><path d="M398 78 L408 44"/><path d="M432 96 L452 66"/></g>'
            f'<g fill="{GOLD}" stroke="{INK}" stroke-width="2.2" stroke-linejoin="round">'
            + ''.join(f'<path transform="translate({x} {y}) scale({s})" d="M0 -12 L3.5 -3.5 L12 0 L3.5 3.5 L0 12 L-3.5 3.5 L-12 0 L-3.5 -3.5Z"/>' for x, y, s in [(170, 150, 1.1), (478, 140, 1.3), (520, 260, .8), (126, 280, .9)])
            + '</g>'
            + cap_group(196, 92, 1.12, -10)
            + ribbon(cx, cy + 6, w + 70, 136)
            + ribbon_text(d, shadow_col='#5a1208')
            + f'<g fill="{INK}" opacity=".85"><circle cx="{cx - 150}" cy="{cy + 120}" r="4"/><circle cx="{cx + 150}" cy="{cy + 120}" r="4"/></g>')
    defs = LG_DEFS + CAP_DEFS + f'<clipPath id="badgeClip"><circle cx="{cx}" cy="{cy}" r="190"/></clipPath>'
    return svg(W, H, body, defs)


def safe_illustration(word):
    """You escaped: a rowan & laurel wreath around a sunflower medal, ribbon below."""
    W, H = 640, 520
    cx, cy = 320, 236
    rnd = random.Random(3)
    leaves = []
    for side in (-1, 1):
        for k in range(11):
            t = k / 10
            a = math.radians(90 + side * (30 + t * 150))
            r = 168
            x, y = cx + r * math.cos(a), cy + r * math.sin(a)
            rot = math.degrees(a) + (90 if side > 0 else -90) + side * 30
            col = ['#3f7a4c', '#4c8c5a', '#356c42'][k % 3]
            for off in (-1, 1):
                leaves.append(f'<g transform="translate({x:.1f} {y:.1f}) rotate({rot + off*38:.1f})"><path d="M0 0 C 10 -10 28 -12 38 -3 C 28 5 10 6 0 0Z" fill="{col}" stroke="{INK}" stroke-width="2"/><path d="M3 0 L34 -3" stroke="#9cc58a" stroke-width="1.2"/></g>')
        for k in (2, 5, 8):
            t = k / 10
            a = math.radians(90 + side * (30 + t * 150))
            bx, by = cx + 150 * math.cos(a), cy + 150 * math.sin(a)
            for _ in range(5):
                ox, oy = rnd.uniform(-10, 10), rnd.uniform(-10, 10)
                leaves.append(f'<circle cx="{bx+ox:.1f}" cy="{by+oy:.1f}" r="7" fill="#e2461f" stroke="#7d1d10" stroke-width="1.6"/><circle cx="{bx+ox-2:.1f}" cy="{by+oy-2:.1f}" r="2" fill="#ffd2b8"/>')
    petals = ''.join(f'<path transform="translate({cx} {cy}) rotate({a})" d="M0 -64 C 12 -92 4 -118 0 -124 C -4 -118 -12 -92 0 -64Z" fill="{"#f2b51f" if a % 30 == 0 else "#e8a312"}" stroke="{INK}" stroke-width="2.2" stroke-linejoin="round"/>' for a in range(0, 360, 15))
    seeds = ''.join(f'<circle cx="{cx + r*math.cos(math.radians(a)):.1f}" cy="{cy + r*math.sin(math.radians(a)):.1f}" r="{2.6 - r/60:.1f}" fill="#2e2018"/>'
                    for r in range(8, 58, 7) for a in range(0, 360, max(10, int(360 / (r * 0.9)))))
    _, w0 = text_path(word, 86)
    size = min(86, 86 * 430 / w0)
    d, w = centered(word, size, cx, 452 - (86 - size) * 0.35)
    confetti = ''.join(f'<path transform="translate({rnd.uniform(40, 600):.0f} {rnd.uniform(20, 470):.0f}) rotate({rnd.uniform(0, 360):.0f})" d="M0 0 C 4 -6 10 -6 12 0 C 10 6 4 6 0 0Z" fill="{rnd.choice([VERM, GOLD, COBALT, "#4c8c5a", "#f2b51f"])}" opacity=".9"/>' for _ in range(26))
    body = (f'{confetti}'
            f'<circle cx="{cx}" cy="{cy}" r="196" fill="#fbf0d6" opacity=".55"/>'
            f'<g clip-path="url(#sc)">{rays(cx, cy, 0, 200, 32, "#f8e3b4", "#fbf0d6")}</g>'
            + ''.join(leaves)
            + petals
            + f'<circle cx="{cx}" cy="{cy}" r="64" fill="#5a3418" stroke="{INK}" stroke-width="3"/>'
            + f'<circle cx="{cx}" cy="{cy}" r="56" fill="#6e4220"/>' + seeds
            + ribbon(cx, 424, w + 70, 112, fill=GREEN, lo='#1e4a2f')
            + ribbon_text(d, shadow_col='#0f2a1a'))
    defs = LG_DEFS + f'<clipPath id="sc"><circle cx="{cx}" cy="{cy}" r="190"/></clipPath>'
    return svg(W, H, body, defs)


def main(out):
    files = {
        'brand/wordmark-ru.svg': wordmark_ru(True),
        'brand/wordmark-ru-plain.svg': wordmark_ru(False),
        'brand/wordmark-en.svg': wordmark_en(),
        'brand/lockup.svg': wordmark_lockup(),
        'brand/jester-cap.svg': cap_svg(),
        'portraits/frame.svg': frame_svg(),
        'backs/khokhloma.svg': back_khokhloma(),
        'backs/stitch.svg': back_stitch(),
        'illustrations/durak-ru.svg': durak_illustration('ДУРАК!'),
        'illustrations/durak-en.svg': durak_illustration('DURAK!'),
        'illustrations/safe-ru.svg': safe_illustration('НЕ ДУРАК!'),
        'illustrations/safe-en.svg': safe_illustration('SAFE!'),
    }
    for rel, s in files.items():
        p = os.path.join(out, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        open(p, 'w').write(s)
        print(rel, len(s) // 1024, 'KB')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, '..', 'kit-preview'))
