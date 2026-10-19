"""Bake the top-down 'Tabletop' card table art for Concept D.

Renders a racetrack-shaped card table seen straight from above with:
  * worsted baize felt (fine fibre + nap streaks + mottling), lit by a soft
    overhead area light with a gentle centre hotspot,
  * a polished bent-wood racetrack whose grain follows the curve,
  * a thin brass bead between wood and felt,
  * a padded cognac-leather armrest (cushion profile -> normals, pebble grain
    from the shared leather normal map, saddle stitching),
  * contact / ambient occlusion where the rail meets the felt, and a soft drop
    shadow onto whatever is underneath (kept in the alpha channel).

Usage:  python bake.py            (writes ../img/table-*.webp)
Only numpy + Pillow are required.
"""
from __future__ import annotations

import math
import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "img")
ASSETS = os.path.join(HERE, "..", "..", "assets")

rng = np.random.default_rng(7)
LEATHER = tuple(os.environ.get("LEATHER", "#7a3a12,#2e1406").split(","))


# ----------------------------------------------------------------- helpers
def srgb_to_lin(c):
    c = np.asarray(c, dtype=np.float32)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def hexc(h):
    h = h.lstrip("#")
    return srgb_to_lin([int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)])


def box_blur(a, r, axis):
    if r < 1:
        return a
    r = int(r)
    pad = [(0, 0)] * a.ndim
    pad[axis] = (r + 1, r)
    p = np.pad(a, pad, mode="edge")
    c = np.cumsum(p, axis=axis, dtype=np.float64)
    n = a.shape[axis]
    hi = np.take(c, np.arange(2 * r + 1, 2 * r + 1 + n), axis=axis)
    lo = np.take(c, np.arange(0, n), axis=axis)
    return ((hi - lo) / (2 * r + 1)).astype(np.float32)


def blur(a, sigma, axes=(0, 1)):
    """Approximate gaussian with 3 box passes."""
    if sigma <= 0.3:
        return a
    r = max(1, int(round(math.sqrt(12 * sigma * sigma / 3 + 1) - 1) // 2))
    for _ in range(3):
        for ax in axes:
            a = box_blur(a, r, ax)
    return a


def value_noise(h, w, cell_y, cell_x, seed):
    """Smooth value noise with (possibly anisotropic) cell size, range ~[-1,1]."""
    g = np.random.default_rng(seed)
    gh = max(2, int(math.ceil(h / cell_y)) + 3)
    gw = max(2, int(math.ceil(w / cell_x)) + 3)
    grid = g.standard_normal((gh, gw)).astype(np.float32)
    im = Image.fromarray(grid, "F").resize((int(gw * cell_x), int(gh * cell_y)), Image.BICUBIC)
    a = np.asarray(im)[:h, :w]
    s = a.std() + 1e-6
    return (a - a.mean()) / s


def fbm(h, w, base, octaves, seed, gain=0.55, aniso=1.0):
    out = np.zeros((h, w), np.float32)
    amp, tot = 1.0, 0.0
    cell = base
    for o in range(octaves):
        out += amp * value_noise(h, w, max(1.0, cell), max(1.0, cell * aniso), seed + o * 31)
        tot += amp
        amp *= gain
        cell /= 2.0
    return out / tot


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def sample_bilinear(tex, u, v):
    """tex[h,w,(c)] sampled at float pixel coords (u=x, v=y), wrapping."""
    h, w = tex.shape[:2]
    u = np.mod(u, w)
    v = np.mod(v, h)
    x0 = np.floor(u).astype(np.int64)
    y0 = np.floor(v).astype(np.int64)
    fx = (u - x0).astype(np.float32)
    fy = (v - y0).astype(np.float32)
    x1 = (x0 + 1) % w
    y1 = (y0 + 1) % h
    x0 %= w
    y0 %= h
    if tex.ndim == 3:
        fx = fx[..., None]
        fy = fy[..., None]
    a = tex[y0, x0] * (1 - fx) + tex[y0, x1] * fx
    b = tex[y1, x0] * (1 - fx) + tex[y1, x1] * fx
    return a * (1 - fy) + b * fy


def normalize(v):
    n = np.sqrt(np.sum(v * v, axis=-1, keepdims=True)) + 1e-8
    return v / n


# ----------------------------------------------------------------- table
def bake_table(name, w_design, h_design, scale, *, vertical=False,
               leather=34, wood=17, brass=2.4, pad=70,
               felt_hex=("#2a9561", "#1b7546", "#14603a"), felt_name="emerald",
               line_inset=30):
    S = scale
    W = int(round((w_design + 2 * pad) * S))
    H = int(round((h_design + 2 * pad) * S))
    print(f"[{name}] {W}x{H}", flush=True)

    ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
    # design-space coordinates relative to the table centre
    X = (xs + 0.5) / S - (w_design / 2 + pad)
    Y = (ys + 0.5) / S - (h_design / 2 + pad)

    # stadium along the long axis
    if vertical:
        PX, PY = Y, X          # long axis is screen-y
        LW, LH = h_design, w_design
    else:
        PX, PY = X, Y
        LW, LH = w_design, h_design
    r = LH / 2.0
    a = LW / 2.0 - r
    qx = np.maximum(np.abs(PX) - a, 0)
    qy = np.abs(PY)
    dist = np.sqrt(qx * qx + qy * qy)
    sdf = dist - r                     # <0 inside (design px)
    # outward unit normal in stadium space
    gx = np.where(dist > 1e-4, qx / np.maximum(dist, 1e-4), 0) * np.sign(PX)
    gy = np.where(dist > 1e-4, qy / np.maximum(dist, 1e-4), 1) * np.where(PY >= 0, 1, -1)
    if vertical:
        NX, NY = gy, gx
    else:
        NX, NY = gx, gy
    t = -sdf                            # inward distance from outer edge

    # arc-length parameter along the rail (for grain + stitches)
    rm = r - leather - wood / 2
    ang = np.arctan2(PY, PX - np.sign(PX) * a)
    u_top = PX + a
    u = np.where(np.abs(PX) <= a,
                 np.where(PY < 0, u_top, 2 * a + math.pi * rm + (a - PX)),
                 0.0)
    right = PX > a
    left = PX < -a
    th_r = np.arctan2(PY, PX - a)               # -pi/2..pi/2
    u = np.where(right, 2 * a + rm * (th_r + math.pi / 2), u)
    th_l = np.arctan2(PY, PX + a)               # pi/2..pi or -pi..-pi/2
    th_l = np.where(th_l < 0, th_l + 2 * math.pi, th_l)  # pi/2..3pi/2
    u = np.where(left, 4 * a + math.pi * rm + rm * (th_l - math.pi / 2), u)
    perim = 4 * a + 2 * math.pi * rm
    # put the grain seam at bottom-centre (always hidden under the player's hand)
    u = np.mod(u - (3 * a + math.pi * rm), perim)

    # ------------------------------------------------ light set-up
    Ld = normalize(np.array([-0.28, -0.42, 1.0], np.float32))
    Vd = np.array([0, 0, 1.0], np.float32)
    Hd = normalize(Ld + Vd)
    # soft overhead area light: broad hot spot slightly above centre
    cx_off, cy_off = 0.0, -0.06 * h_design
    rx = 0.62 * w_design
    ry = 0.62 * h_design if not vertical else 0.55 * h_design
    hot = np.exp(-(((X - cx_off) / rx) ** 2 + ((Y - cy_off) / ry) ** 2) * 1.35)
    E = 0.69 + 0.42 * hot              # irradiance field

    img = np.zeros((H, W, 3), np.float32)

    # ------------------------------------------------ felt
    t_felt = leather + wood + brass
    fc, fm, fe = (hexc(h) for h in felt_hex)
    def motion(a, dx, dy, n):
        acc = np.zeros_like(a)
        for i in range(-n, n + 1):
            acc += np.roll(np.roll(a, i * dy, 0), i * dx, 1)
        return acc / (2 * n + 1)
    L = max(2, int(2.2 * S))
    fib = np.zeros((H, W), np.float32)
    for k_, (dx, dy) in enumerate([(1, 0), (0, 1), (1, 1), (1, -1), (2, 1), (1, 2), (2, -1), (1, -2)]):
        wn = rng.standard_normal((H, W)).astype(np.float32)
        mb = motion(wn, dx, dy, L)
        fib += np.abs(mb)
    fib = blur(fib, 0.35 * S)
    fib = (fib - fib.mean()) / (fib.std() + 1e-6)
    fine = blur(rng.standard_normal((H, W)).astype(np.float32), 0.45 * S)
    fine /= fine.std() + 1e-6
    nap = blur(rng.standard_normal((H, W)).astype(np.float32), 5.0 * S, axes=(1,))
    nap = blur(nap, 0.6 * S, axes=(0,))
    nap /= nap.std() + 1e-6
    mott = fbm(H, W, 70 * S, 3, 11)
    big = fbm(H, W, 320 * S, 2, 19)
    lint = (rng.random((H, W)) > 0.9993).astype(np.float32)
    lint = motion(lint, 1, 0, max(1, int(1.5 * S)))
    lint = np.clip(blur(lint, 0.4 * S) * 6, 0, 1)

    albedo_var = 1 + 0.055 * fib + 0.025 * fine + 0.022 * nap + 0.018 * mott + 0.02 * big + 0.12 * lint
    # colour blends from centre colour to edge colour across the field
    k = np.clip(1 - hot, 0, 1)[..., None]
    felt_col = (fc * (1 - k) + fm * k)
    felt = felt_col * albedo_var[..., None]

    # felt AO from the raised rail + directional shadow
    tf = t - t_felt
    inward = np.stack([-NX, -NY], -1)
    travel = -Ld[:2] / (np.linalg.norm(Ld[:2]) + 1e-6)
    kdir = np.clip(np.sum(inward * travel, -1), 0, 1)
    ao = 1 - 0.30 * np.exp(-np.maximum(tf, 0) / 6.0) - 0.22 * kdir * np.exp(-np.maximum(tf, 0) / (5 + 9 * kdir))
    ao *= 1 - 0.18 * np.exp(-np.maximum(tf, 0) / 40.0)
    # printed line on the felt (very subtle, like a betting line)
    lw = 0.9
    line = np.exp(-((tf - line_inset) / lw) ** 2)
    felt_lit = felt * (E * ao)[..., None]
    line_col = hexc("#e9d9a8")
    felt_lit = felt_lit * (1 - 0.30 * line[..., None]) + line_col * 0.30 * line[..., None] * E[..., None]

    # ------------------------------------------------ brass bead
    tb0 = leather + wood
    ub = np.clip((t - tb0) / brass, 0, 1)
    bead_h = np.sqrt(np.clip(1 - (2 * ub - 1) ** 2, 0, 1))
    slope_b = -(2 * ub - 1) / np.maximum(bead_h, 0.15)  # dh/du ~
    nb = normalize(np.stack([-slope_b * (-NX) * 0.9, -slope_b * (-NY) * 0.9, np.ones_like(t)], -1))
    diff_b = np.clip(np.sum(nb * Ld, -1), 0, 1)
    spec_b = np.clip(np.sum(nb * Hd, -1), 0, 1) ** 40
    brass_col = hexc("#c9a45c")
    brass_lit = brass_col * (0.35 + 0.75 * diff_b)[..., None] * E[..., None] + hexc("#fff3d6") * (1.2 * spec_b)[..., None]

    # ------------------------------------------------ wood racetrack
    tw0 = leather
    v_w = np.clip((t - tw0) / wood, 0, 1)
    # wood texture in strip space
    WU = int(perim * S) + 8
    WV = int(wood * S) + 8
    g1 = fbm(WV, WU, 0.9 * S, 2, 101, aniso=70)      # pores along u
    g2 = fbm(WV, WU, 4 * S, 3, 131, aniso=50)
    warp = fbm(WV, WU, 10 * S, 3, 151, aniso=30)
    tone = fbm(WV, WU, 18 * S, 2, 171, aniso=25)
    vv = np.linspace(0, 1, WV, dtype=np.float32)[:, None]
    ph = vv * 5.5 + warp * 0.9 + g2 * 0.06
    d = np.abs(np.mod(ph + 0.5, 1.0) - 0.5)
    late = np.exp(-(d / 0.10) ** 2) * 0.75 + np.exp(-(d / 0.035) ** 2) * 0.5
    ph2 = vv * 13 + warp * 1.7 + 0.37
    d2 = np.abs(np.mod(ph2 + 0.5, 1.0) - 0.5)
    late += np.exp(-(d2 / 0.05) ** 2) * 0.25
    wood_tex = 0.78 + 0.07 * tone - 0.30 * late + 0.05 * g1
    w_light, w_dark = hexc("#d29a5e"), hexc("#5e3016")
    wt = np.clip(wood_tex, 0, 1)[..., None]
    wood_strip = w_dark * (1 - wt) + w_light * wt
    wood_alb = sample_bilinear(wood_strip, u * S, (t - tw0) * S)
    # slight crown + bevels at both edges
    bevel = smoothstep(0, 0.16, v_w) * smoothstep(1.0, 0.84, v_w)
    slope_w = (np.where(v_w < 0.16, 1.0, 0) - np.where(v_w > 0.84, 1.0, 0)) * 0.9 + (0.5 - v_w) * 0.25
    nw = normalize(np.stack([-slope_w * (-NX), -slope_w * (-NY), np.ones_like(t)], -1))
    diff_w = np.clip(np.sum(nw * Ld, -1), 0, 1)
    spec_w = np.clip(np.sum(nw * Hd, -1), 0, 1) ** 140
    # broad clear-coat sheen that varies around the table (window-ish)
    sheen = 0.10 * (0.5 + 0.5 * np.cos(u / perim * 2 * math.pi * 3 + 1.0)) * hot
    wood_lit = wood_alb * (0.30 + 0.80 * diff_w)[..., None] * (0.8 + 0.3 * hot)[..., None]
    wood_lit += hexc("#fff5e6") * (0.75 * spec_w + sheen)[..., None]
    wood_lit *= (0.80 + 0.20 * bevel)[..., None]
    # shadow cast by the leather cushion onto the wood
    sh_w = 1 - 0.40 * np.exp(-np.maximum(t - tw0, 0) / 2.2) - 0.20 * kdir * np.exp(-np.maximum(t - tw0, 0) / 5.0)
    wood_lit *= sh_w[..., None]

    # ------------------------------------------------ leather armrest
    ul = np.clip(t / leather, 0, 1)
    p = 2.6
    s_ = np.abs(2 * ul - 1)
    base_h = np.clip(1 - s_ ** p, 1e-4, 1) ** (1 / p)
    # derivative of height wrt u
    dh = -(1 / p) * np.clip(1 - s_ ** p, 1e-4, 1) ** (1 / p - 1) * p * s_ ** (p - 1) * np.sign(2 * ul - 1) * 2
    cushion = 0.42 * leather                  # cushion height in px
    slope = dh * cushion / leather            # dh/dt
    slope = np.clip(slope, -6, 6)
    # moving inward (+t) means moving along -N
    nlx = -slope * (-NX)
    nly = -slope * (-NY)
    # pebble grain from the shared normal map
    try:
        lnm = np.asarray(Image.open(os.path.join(ASSETS, "table", "leather_normal.webp")).convert("RGB"),
                         np.float32) / 255.0
        lnm = lnm * 2 - 1
        gsc = 4.0 / S                    # texels per screen px
        gn = sample_bilinear(lnm, xs * gsc * 1.0, ys * gsc * 1.0)
        nlx = nlx + gn[..., 0] * 0.11
        nly = nly - gn[..., 1] * 0.11
    except Exception as e:  # pragma: no cover
        print("leather normal missing", e)
    nl = normalize(np.stack([nlx, nly, np.ones_like(t)], -1))
    diff_l = np.clip(np.sum(nl * Ld, -1), 0, 1)
    spec_l = np.clip(np.sum(nl * Hd, -1), 0, 1)
    l_mott = fbm(H, W, 30 * S, 4, 211)
    l_base = hexc(LEATHER[0])
    l_dark = hexc(LEATHER[1])
    l_alb = l_base * (1 + 0.09 * l_mott)[..., None]
    # darker in creases near the edges of the cushion (worn patina inverse)
    crease = smoothstep(0.75, 1.0, s_)
    l_alb = l_alb * (1 - crease[..., None] * 0.45) + l_dark * crease[..., None] * 0.15
    ao_l = 0.50 + 0.50 * base_h ** 0.8
    leather_lit = l_alb * (0.12 + 0.98 * diff_l * ao_l)[..., None] * (0.82 + 0.28 * hot)[..., None]
    leather_lit += hexc("#ffe2c0") * (0.38 * spec_l ** 40 + 0.07 * spec_l ** 8)[..., None] * ao_l[..., None]
    # stitching: a seam groove + thread dashes on the inner shoulder
    t_st = leather * 0.80
    seam = np.exp(-((t - t_st) / 0.55) ** 2)
    stitch_len = 4.2
    phase = np.mod(u / stitch_len, 1.0)
    dash = smoothstep(0.08, 0.2, phase) * smoothstep(0.78, 0.66, phase)
    t_th = t_st - 1.1
    thread = np.exp(-((t - t_th) / 0.55) ** 2) * dash
    leather_lit *= (1 - 0.35 * seam)[..., None]
    thread_col = hexc("#f1dfbf") * (0.55 + 0.6 * diff_l)[..., None]
    leather_lit = leather_lit * (1 - 0.85 * thread[..., None]) + thread_col * 0.85 * thread[..., None]
    # same seam on the outer shoulder
    t_st2 = leather * 0.16
    seam2 = np.exp(-((t - t_st2) / 0.5) ** 2)
    leather_lit *= (1 - 0.30 * seam2)[..., None]

    # ------------------------------------------------ compose
    aa = 0.6 / S + 0.35
    m_felt = smoothstep(t_felt - aa, t_felt + aa, t)
    m_brass = smoothstep(tb0 - aa, tb0 + aa, t) * (1 - m_felt)
    m_wood = smoothstep(tw0 - aa, tw0 + aa, t) * (1 - m_felt - m_brass)
    m_wood = np.clip(m_wood, 0, 1)
    m_leather = np.clip(smoothstep(-aa, aa, t) - m_wood - m_brass - m_felt, 0, 1)
    img = (felt_lit * m_felt[..., None] + brass_lit * m_brass[..., None]
           + wood_lit * m_wood[..., None] + leather_lit * m_leather[..., None])
    alpha_table = smoothstep(-aa, aa, t)

    # camera-ish finishing: faint sensor grain + warm white balance
    grain = rng.standard_normal((H, W)).astype(np.float32) * 0.006
    img = img * np.array([1.015, 1.0, 0.975], np.float32) + grain[..., None]

    # drop shadow (kept in alpha): shifted, blurred table silhouette
    sil = alpha_table.copy()
    shift = int(round(10 * S))
    sil_s = np.zeros_like(sil)
    sil_s[shift:, :] = sil[:-shift, :]
    soft = blur(sil_s, 22 * S)
    tight = blur(sil, 3.0 * S)
    sh_alpha = np.clip(0.42 * soft + 0.45 * tight, 0, 0.75)

    out_rgb = lin_to_srgb(img)
    # composite table over shadow (shadow is black)
    A = alpha_table + sh_alpha * (1 - alpha_table)
    rgb = np.where(A[..., None] > 1e-4, out_rgb * alpha_table[..., None] / np.maximum(A[..., None], 1e-4), 0)
    rgba = np.dstack([rgb, A])
    im = Image.fromarray((np.clip(rgba, 0, 1) * 255 + 0.5).astype(np.uint8), "RGBA")
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, f"{name}.webp")
    im.save(path, "WEBP", quality=90, method=6, alpha_quality=90)
    print("  ->", path, os.path.getsize(path) // 1024, "KB", flush=True)
    return im


def bake_backdrop(name="backdrop", size=1024, seed=3):
    """Tileable, soft warm-stone/linen backdrop texture (neutral, very low contrast)."""
    g = np.random.default_rng(seed)
    n = g.standard_normal((size, size)).astype(np.float32)
    # make it tileable by blurring with wrap
    def wblur(a, s):
        p = size // 4
        a2 = np.pad(a, p, mode="wrap")
        a2 = blur(a2, s)
        return a2[p:-p, p:-p]
    f1 = wblur(n, 0.7)
    f1 /= f1.std()
    f2 = wblur(g.standard_normal((size, size)).astype(np.float32), 6)
    f2 /= f2.std()
    f3 = wblur(g.standard_normal((size, size)).astype(np.float32), 40)
    f3 /= f3.std()
    weave_h = wblur(g.standard_normal((size, size)).astype(np.float32), 0.6)
    weave_h = box_blur(np.pad(weave_h, ((0, 0), (8, 8)), mode="wrap"), 6, 1)[:, 8:-8]
    weave_h /= weave_h.std()
    v = 0.5 + 0.035 * f1 + 0.02 * f2 + 0.02 * f3 + 0.02 * weave_h
    im = Image.fromarray((np.clip(v, 0, 1) * 255).astype(np.uint8), "L")
    path = os.path.join(OUT, f"{name}.png")
    im.save(path)
    print("  ->", path, os.path.getsize(path) // 1024, "KB")


if __name__ == "__main__":
    which = sys.argv[1:] or ["desktop", "mobile", "backdrop"]
    FELTS = {
        "": ("#2a9561", "#1b7546", "#14603a"),            # emerald (default)
        "-royal": ("#2f72c4", "#1d55a0", "#163f7c"),      # ocean blue baize
    }
    for suffix, felt in FELTS.items():
        if "desktop" in which:
            bake_table("table-desktop" + suffix, 1240, 620, 2.0, felt_hex=felt)
        if "mobile" in which:
            bake_table("table-mobile" + suffix, 350, 530, 3.0, vertical=True, leather=24, wood=12,
                       brass=1.8, pad=40, line_inset=20, felt_hex=felt)
    if "backdrop" in which:
        bake_backdrop()
