"""Build the 36-card face deck (cards/, cards4/, cards_sm/) from the CC0 Fomin SVGs.

Pipeline per card
  1. parse + sanitise the downloaded SVG (no scripts / external refs allowed),
  2. recolour the source's flat CGA-like palette to a refined print palette,
  3. in Chromium: drop the source's white base rect and its corner indices,
     enlarge the ace pip (ace of spades gets a bespoke ornamental design),
  4. lay the art onto a 512×716 (2.5:3.5) face with new serif indices,
  5. composite onto a procedurally generated ivory card stock (PIL).
"""
from __future__ import annotations

import math
import re
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

from common import Renderer, band_noise, fbm, font_css, gauss_blur, save
from fetch_cards import RANKS, SUITS, default_dest, fetch, title

W, H = 512, 716
RADIUS = 26  # ≈3.2 mm on a 63.5 mm card
SVGNS = "http://www.w3.org/2000/svg"
ET.register_namespace("", SVGNS)
ET.register_namespace("xlink", "http://www.w3.org/1999/xlink")

RANK_ORDER = ["6", "7", "8", "9", "10", "J", "Q", "K", "A"]
SUIT_ORDER = ["S", "C", "D", "H"]

# Source palette → refined print palette ------------------------------------
SRC = {"red": "#ff5555", "yellow": "#ffff55", "blue": "#5555aa", "black": "#000000", "white": "#ffffff"}
CLASSIC = {"red": "#b3162c", "yellow": "#dcaa45", "blue": "#233f7a", "black": "#17171b", "white": "#fdfaf2"}
FOUR_GREEN = "#0e6a3c"   # clubs
FOUR_BLUE = "#1b4fa6"    # diamonds
INK = {"S": CLASSIC["black"], "C": CLASSIC["black"], "D": CLASSIC["red"], "H": CLASSIC["red"]}
INK4 = {"S": CLASSIC["black"], "C": FOUR_GREEN, "D": FOUR_BLUE, "H": CLASSIC["red"]}


def _rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def recolour(text: str, mapping: dict[str, str]) -> str:
    keys = {k: _rgb(v) for k, v in SRC.items()}

    def sub(m):
        c = _rgb(m.group(0))
        best, d = None, 1e9
        for k, v in keys.items():
            dd = sum((a - b) ** 2 for a, b in zip(c, v))
            if dd < d:
                best, d = k, dd
        return mapping[best] if d < 24 ** 2 else m.group(0)

    return re.sub(r"#[0-9a-fA-F]{6}\b", sub, text)


# Sanitising -----------------------------------------------------------------
BAD_TAGS = {"script", "foreignObject", "image", "iframe", "object", "embed", "audio", "video", "style"}


def sanitise(raw: str) -> str:
    if "<!DOCTYPE" in raw or "<!ENTITY" in raw:
        raise ValueError("DOCTYPE/ENTITY not allowed in source SVG")
    root = ET.fromstring(raw.encode())
    for parent in list(root.iter()):
        for child in list(parent):
            tag = child.tag.split("}")[-1]
            ns = child.tag[1:].split("}")[0] if child.tag.startswith("{") else ""
            if tag in BAD_TAGS:
                raise ValueError(f"forbidden element <{tag}> in source SVG")
            if tag == "metadata" or (ns and ns != SVGNS):
                parent.remove(child)
    for el in root.iter():
        for a in list(el.attrib):
            v = el.attrib[a]
            local = a.split("}")[-1]
            if local.lower().startswith("on"):
                raise ValueError("event handler attribute in source SVG")
            if local == "href" and not v.startswith("#"):
                raise ValueError("external reference in source SVG")
            if "url(" in v and not re.fullmatch(r"[^()]*url\(#[^)]+\)[^()]*", v):
                raise ValueError("external url() in source SVG")
            if a.startswith("{") and not a.startswith("{http://www.w3.org/1999/xlink}"):
                del el.attrib[a]  # inkscape:/sodipodi: attributes
    return ET.tostring(root, encoding="unicode")


# Browser-side editing --------------------------------------------------------
EDIT_JS = r"""
(args) => {
  const [isAce, aceScale, dropCenter, bigPipFill] = args;
  const svg = document.querySelector('svg');
  const R = svg.getScreenCTM().inverse();
  function box(el) {
    const b = el.getBBox(); const m = R.multiply(el.getScreenCTM());
    const pts = [[b.x,b.y],[b.x+b.width,b.y],[b.x,b.y+b.height],[b.x+b.width,b.y+b.height]]
      .map(([x,y]) => { const p = new DOMPoint(x,y).matrixTransform(m); return [p.x,p.y]; });
    const xs = pts.map(p=>p[0]), ys = pts.map(p=>p[1]);
    return {x0:Math.min(...xs), y0:Math.min(...ys), x1:Math.max(...xs), y1:Math.max(...ys), b, m};
  }
  const leaves = [...svg.querySelectorAll('path,rect,circle,ellipse,polygon,polyline')];
  let pip = null;
  for (const el of leaves) {
    const q = box(el); const w = q.x1-q.x0, h = q.y1-q.y0;
    if (w > 300 && h > 450) { el.remove(); continue; }               // white base rect
    const tl = q.x1 < 48 && q.y1 < 140, br = q.x0 > 312 && q.y0 > 400;
    if ((tl || br) && w < 60 && h < 70) { el.remove(); continue; }   // corner index
    if (isAce && !pip) pip = {el, q};
    // court cards: the large suit pip inside the frame always sits at these two boxes
    const near = (a, b) => Math.abs(a - b) < 4;
    if (bigPipFill && ((near(q.x0,60) && near(q.y0,45) && near(q.x1,120) && near(q.y1,135)) ||
                       (near(q.x0,240) && near(q.y0,405) && near(q.x1,300) && near(q.y1,495)))) {
      el.style.fill = bigPipFill;
    }
  }
  let shape = null;
  if (isAce && pip) {
    const {el, q} = pip; const b = q.b;
    const m = q.m;
    shape = {d: el.getAttribute('d'),
             ctm: [m.a,m.b,m.c,m.d,m.e,m.f], x0:q.x0, y0:q.y0, x1:q.x1, y1:q.y1};
    if (dropCenter) el.remove();
    else {
      const cx = b.x + b.width/2, cy = b.y + b.height/2;
      const own = el.getAttribute('transform') || '';
      el.setAttribute('transform', `${own} translate(${cx} ${cy}) scale(${aceScale}) translate(${-cx} ${-cy})`);
    }
  }
  svg.setAttribute('viewBox', '0 0 360 540');
  svg.removeAttribute('id');
  return {svg: svg.outerHTML, shape};
}
"""

# Art placement inside the 512×716 face
ART_K = 1.30
ART_W, ART_H = 360 * ART_K, 540 * ART_K
ART_X, ART_Y = (W - ART_W) / 2, (H - ART_H) / 2


def suit_symbol(shape: dict, cx: float, cy: float, height: float, fill: str, extra: str = "") -> str:
    """Re-place an extracted suit path so its bbox is centred at (cx,cy) with given height."""
    s = height / (shape["y1"] - shape["y0"])
    bx = (shape["x0"] + shape["x1"]) / 2
    by = (shape["y0"] + shape["y1"]) / 2
    a, b, c, d, e, f = shape["ctm"]
    return (f'<g transform="translate({cx:.3f} {cy:.3f}) scale({s:.5f}) translate({-bx:.3f} {-by:.3f})">'
            f'<path transform="matrix({a} {b} {c} {d} {e} {f})" d="{shape["d"]}" fill="{fill}" {extra}/></g>')


def index_svg(rank: str, shape: dict, ink: str) -> str:
    fs = 66
    tx = 'transform="translate(43 0) scale(0.80 1) translate(-43 0)"' if rank == "10" else ""
    ls = 'letter-spacing="-4"' if rank == "10" else ""
    one = (f'<g><text x="43" y="80" text-anchor="middle" font-family="idx" font-size="{fs}" fill="{ink}" {ls} {tx}>{rank}</text>'
           + suit_symbol(shape, 43, 113, 38, ink) + "</g>")
    return one + f'<g transform="rotate(180 {W/2} {H/2})">{one}</g>'


def guilloche_ring(cx, cy, r0, r1, n_curves, lobes, colour, width, phase=0.0, steps=1400):
    """Concentric rosette: n_curves sinusoidal closed curves between radii r0..r1."""
    paths = []
    for i in range(n_curves):
        ph = phase + 2 * math.pi * i / n_curves
        pts = []
        for k in range(steps + 1):
            t = 2 * math.pi * k / steps
            r = r0 + (r1 - r0) * (0.5 + 0.5 * math.sin(lobes * t + ph))
            pts.append(f"{cx + r * math.cos(t):.2f},{cy + r * math.sin(t):.2f}")
        paths.append(f'<polyline points="{" ".join(pts)}" fill="none" stroke="{colour}" stroke-width="{width}"/>')
    return "".join(paths)


def ace_of_spades_svg(shape: dict) -> str:
    cx, cy = W / 2, H / 2 - 8
    gold, gold_d, ink = "#b8892f", "#8a6420", CLASSIC["black"]
    parts = ['<defs><radialGradient id="asg" cx="50%" cy="40%" r="60%">'
             '<stop offset="0" stop-color="#e9cf86"/><stop offset="0.6" stop-color="#c39a45"/>'
             '<stop offset="1" stop-color="#8a6420"/></radialGradient></defs>']
    # engraved rosette behind the spade
    parts.append(f'<circle cx="{cx}" cy="{cy}" r="171" fill="none" stroke="{gold_d}" stroke-width="1.8"/>')
    parts.append(f'<circle cx="{cx}" cy="{cy}" r="166.5" fill="none" stroke="{gold}" stroke-width="0.6"/>')
    # dense overlapping sine bands = engraved guilloche
    parts.append(guilloche_ring(cx, cy, 134, 162, 14, 16, gold, 0.5))
    parts.append(f'<circle cx="{cx}" cy="{cy}" r="131" fill="none" stroke="{gold_d}" stroke-width="0.9"/>')
    parts.append(guilloche_ring(cx, cy, 121, 129, 8, 60, gold_d, 0.45, phase=0.2))
    parts.append(f'<circle cx="{cx}" cy="{cy}" r="118" fill="none" stroke="{gold_d}" stroke-width="1.4"/>')
    # pearl beads on the outer ring
    for i in range(48):
        a = 2 * math.pi * i / 48
        px, py = cx + 177 * math.cos(a), cy + 177 * math.sin(a)
        rr = 2.4 if i % 4 == 0 else 1.3
        parts.append(f'<circle cx="{px:.2f}" cy="{py:.2f}" r="{rr}" fill="{gold if i % 4 else gold_d}"/>')
    # the spade: gold halo, ink body, ivory inline, gold inner spade
    parts.append(suit_symbol(shape, cx, cy, 236, "none", f'stroke="{gold_d}" stroke-width="5" stroke-linejoin="round"'))
    parts.append(suit_symbol(shape, cx, cy, 236, ink))
    parts.append(suit_symbol(shape, cx, cy - 4, 200, "none",
                             'stroke="#fdfaf2" stroke-width="1.4" stroke-linejoin="round" vector-effect="non-scaling-stroke"'))
    parts.append(suit_symbol(shape, cx, cy - 10, 96, "url(#asg)"))
    parts.append(suit_symbol(shape, cx, cy - 10, 96, "none",
                             f'stroke="{gold_d}" stroke-width="0.8" vector-effect="non-scaling-stroke"'))
    # maker's line
    parts.append(f'<text x="{cx}" y="{cy + 214}" text-anchor="middle" font-family="garamond" font-size="21" '
                 f'letter-spacing="7" fill="{ink}">DURAK</text>')
    parts.append(f'<text x="{cx}" y="{cy + 236}" text-anchor="middle" font-family="garamond-i" font-size="12.5" '
                 f'letter-spacing="2.5" fill="{gold_d}">ДУРАК · MMXXVI</text>')
    return "".join(parts)


def card_svg(art_svg: str, rank: str, suit: str, shape: dict, ink: str, extra: str = "") -> str:
    art = art_svg.replace("<svg", f'<svg x="{ART_X:.2f}" y="{ART_Y:.2f}" width="{ART_W:.2f}" height="{ART_H:.2f}" overflow="visible"', 1)
    art = re.sub(r'(<svg[^>]*?)\swidth="360"', r"\1", art, count=1)
    art = re.sub(r'(<svg[^>]*?)\sheight="540"', r"\1", art, count=1)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">'
            f"{art}{extra}{index_svg(rank, shape, ink)}</svg>")


# Card stock -------------------------------------------------------------------
def rounded_mask(w: int, h: int, r: int, ss: int = 4) -> Image.Image:
    m = Image.new("L", (w * ss, h * ss), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, w * ss - 1, h * ss - 1], r * ss, fill=255)
    return m.resize((w, h), Image.LANCZOS)


def stock(seed: int = 7) -> tuple[np.ndarray, Image.Image]:
    """Ivory card stock RGB (float) with paper grain, faint linen and gloss."""
    base = np.array([250, 246, 236], dtype=np.float64) / 255.0
    grain = band_noise(H, W, 2.2, seed) * 0.006 + fbm(H, W, 90, 4, seed + 5) * 0.008
    linen = (band_noise(H, W, 3, seed + 9, (6, 0.25)) + band_noise(H, W, 3, seed + 11, (0.25, 6))) * 0.0035
    yy, xx = np.mgrid[0:H, 0:W]
    u, v = xx / (W - 1), yy / (H - 1)
    sheen = 0.018 * np.exp(-(((u - 0.25) * 1.4 + (v - 0.15)) ** 2) / 0.08)  # soft diagonal gloss
    vign = -0.025 * (((u - 0.5) * 2) ** 4 + ((v - 0.5) * 2) ** 4)
    lum = 1 + grain + linen + sheen + vign
    rgb = base[None, None, :] * lum[..., None]
    mask = rounded_mask(W, H, RADIUS)
    # edge: thin darker rim + faint inner bevel so the card reads on felt
    m = np.asarray(mask, dtype=np.float64) / 255.0
    inner = np.asarray(mask.filter(ImageFilter.GaussianBlur(2.2)), dtype=np.float64) / 255.0
    rim = np.clip((m - inner) * 3.0, 0, 1)
    rgb = rgb * (1 - 0.16 * rim[..., None]) + np.array([0.78, 0.74, 0.66]) * 0.0
    return rgb, mask


def composite(art: Image.Image, stock_rgb: np.ndarray, mask: Image.Image) -> Image.Image:
    a = np.asarray(art, dtype=np.float64) / 255.0
    alpha = a[..., 3:4]
    rgb = stock_rgb * (1 - alpha) + a[..., :3] * alpha
    # ink sits *in* the paper: let a trace of the grain show through
    rgb = rgb * (0.985 + 0.015 * stock_rgb / stock_rgb.mean())
    out = np.dstack([np.clip(rgb, 0, 1) * 255, np.asarray(mask, dtype=np.float64)])
    return Image.fromarray(np.uint8(out + 0.5), "RGBA")


# Main -------------------------------------------------------------------------
def build(r: Renderer | None = None, src_dir: Path | None = None) -> dict:
    own = r is None
    r = r or Renderer()
    files = fetch(src_dir or default_dest())
    css = font_css("idx", "garamond", "garamond-i")
    st_rgb, mask = stock()
    cards = []

    # pass 1: sanitise + extract suit shapes from the aces (classic colours)
    shapes = {}
    edited = {}
    for variant, mapping_fn in (("cards", lambda s: CLASSIC), ("cards4", None)):
        for s in SUIT_ORDER:
            for rk in RANK_ORDER:
                raw = files[title(rk, s)].read_text(encoding="utf-8")
                svg = sanitise(raw[raw.index("<svg"):])
                if variant == "cards":
                    mp = CLASSIC
                else:
                    mp = dict(CLASSIC)
                    if rk not in ("J", "Q", "K"):
                        if s == "C":
                            mp["black"] = FOUR_GREEN
                        if s == "D":
                            mp["red"] = FOUR_BLUE
                svg = recolour(svg, mp)
                html = f"<html><body style='margin:0'>{svg}</body></html>"
                big = "null"
                if variant == "cards4" and rk in ("J", "Q", "K") and s in ("C", "D"):
                    big = f"'{INK4[s]}'"
                res = r.evaluate(html, f"() => ({EDIT_JS})([{str(rk == 'A').lower()}, 2.3, {str(rk == 'A' and s == 'S').lower()}, {big}])")
                edited[(variant, rk, s)] = res["svg"]
                if rk == "A" and variant == "cards":
                    shapes[s] = res["shape"]

    for variant in ("cards", "cards4"):
        inks = INK if variant == "cards" else INK4
        for s in SUIT_ORDER:
            for rk in RANK_ORDER:
                code = f"{rk}{s}"
                extra = ace_of_spades_svg(shapes["S"]) if code == "AS" else ""
                svg = card_svg(edited[(variant, rk, s)], rk, s, shapes[s], inks[s], extra)
                art = r.render(svg, W, H, ss=2.0, css=css, wait_fonts=True)
                im = composite(art, st_rgb, mask)
                save(im, f"{variant}/{code}", png=(variant == "cards"))
                if variant == "cards":
                    sm = im.resize((256, 358), Image.LANCZOS)
                    save(sm, f"cards_sm/{code}", webp_q=88)
                    cards.append(code)
    if own:
        r.close()
    return {"codes": cards, "shapes": shapes}


if __name__ == "__main__":
    out = build()
    print("built", len(out["codes"]), "cards")


def suit_shapes(r: Renderer, src_dir: Path | None = None) -> dict:
    """Extract the four suit outlines (path + transform + bbox) from the ace SVGs."""
    files = fetch(src_dir or default_dest())
    shapes = {}
    for s in SUIT_ORDER:
        raw = files[title("A", s)].read_text(encoding="utf-8")
        svg = sanitise(raw[raw.index("<svg"):])
        res = r.evaluate(f"<html><body style='margin:0'>{svg}</body></html>", f"() => ({EDIT_JS})([true, 1, false, null])")
        shapes[s] = res["shape"]
    return shapes
