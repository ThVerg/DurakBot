"""Dim, warm casino-room panorama (equirectangular 1024×512, LDR) for reflections / blurred background.

Layout (v = 0 at zenith): warm ceiling glow and a pendant lamp at the zenith,
a band of chandelier/bokeh lights around the horizon, dark panelled walls,
dark carpeted floor. Wraps seamlessly in X.
"""
from __future__ import annotations

import math

import numpy as np

from common import fbm, gauss_blur, lerp_colors, rgb_img, rng, save

W, H = 1024, 512


def blur_wrap_x(a: np.ndarray, sigma: float) -> np.ndarray:
    """Blur that wraps horizontally but not vertically (pad rows by reflection)."""
    pad = int(sigma * 3) + 2
    b = np.concatenate([a[pad:0:-1], a, a[-2:-pad - 2:-1]], 0)
    # make the padded height FFT friendly is unnecessary; periodic in y only within the pad
    out = gauss_blur(b, sigma)
    return out[pad:pad + a.shape[0]]


def build() -> list[str]:
    r = rng(2026)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float64)
    v = yy / (H - 1)  # 0 top … 1 bottom
    u = xx / W
    # base vertical gradient
    col = lerp_colors(v, [
        (0.0, (70, 46, 28)), (0.12, (42, 26, 18)), (0.32, (30, 17, 13)), (0.46, (44, 24, 18)),
        (0.5, (34, 19, 15)), (0.56, (18, 11, 9)), (0.8, (12, 8, 7)), (1.0, (8, 6, 5)),
    ])
    # wall panels / wainscot (periodic in x → integer counts)
    panel = 0.5 + 0.5 * np.cos(2 * math.pi * u * 24)
    walls = (v > 0.28) & (v < 0.6)
    col *= (1 - 0.18 * (panel ** 8) * walls)[..., None]
    col *= (1 + 0.12 * fbm(H, W, 200, 3, 4) * walls)[..., None]
    # dark red velvet drapes in 6 places
    drape = np.clip(np.cos(2 * math.pi * u * 6) * 1.4 - 0.6, 0, 1) * ((v > 0.22) & (v < 0.62))
    drape = blur_wrap_x(drape.astype(np.float64), 3.0)
    folds = 0.6 + 0.4 * np.cos(2 * math.pi * u * 6 * 14)
    col = col * (1 - drape[..., None] * 0.6) + drape[..., None] * folds[..., None] * np.array([0.22, 0.03, 0.05])

    light = np.zeros((H, W, 3))
    # zenith: big soft warm key light above the table
    zen = np.exp(-(v / 0.09) ** 2)
    light += zen[..., None] * np.array([1.2, 0.9, 0.6]) * 0.75
    # wall sconces: pairs of warm glows on the wall band
    for k in range(12):
        cx = (k + 0.5) / 12
        dx = np.minimum(np.abs(u - cx), 1 - np.abs(u - cx)) * W
        g = np.exp(-(dx ** 2) / (2 * 6 ** 2) - ((yy - 0.36 * H) ** 2) / (2 * 6 ** 2))
        halo = np.exp(-(dx ** 2) / (2 * 26 ** 2) - ((yy - 0.37 * H) ** 2) / (2 * 34 ** 2))
        light += g[..., None] * np.array([1.0, 0.75, 0.45]) * 1.6 + halo[..., None] * np.array([0.5, 0.28, 0.12]) * 0.55
    # bokeh: many small out-of-focus lights in a band around the horizon
    bok = np.zeros((H, W, 3))
    palette = [np.array(c) for c in ([1.0, 0.75, 0.4], [1.0, 0.6, 0.3], [1.0, 0.85, 0.6], [0.9, 0.3, 0.25], [0.35, 0.6, 0.9], [0.8, 0.4, 0.9])]
    weights = [0.32, 0.25, 0.2, 0.1, 0.07, 0.06]
    for _ in range(120):
        cx = r.random() * W
        cy = H * (0.4 + 0.05 * r.standard_normal())
        rad = r.uniform(3, 11)
        c = palette[r.choice(len(palette), p=weights)] * r.uniform(0.25, 0.8)
        dx = np.minimum(np.abs(xx - cx), W - np.abs(xx - cx))
        d = np.sqrt(dx ** 2 + (yy - cy) ** 2)
        disc = np.clip(rad - d + 0.5, 0, 1)
        ringb = np.clip(1 - np.abs(d - rad + 1) / 1.2, 0, 1) * 0.35  # bokeh rim
        bok += (disc * 0.65 + ringb)[..., None] * c
    for ch in range(3):
        bok[..., ch] = blur_wrap_x(bok[..., ch], 1.2)
    light += bok
    # bounce: warm floor reflection under the lights
    light += (np.exp(-((v - 0.62) / 0.05) ** 2) * 0.08)[..., None] * np.array([1.0, 0.6, 0.3])
    col = col + light * 0.45
    # filmic-ish tone curve
    col = 1 - np.exp(-col * 1.6)
    col = col ** 1.05
    files = save(rgb_img(col), "env/room", webp_q=90)
    # a pre-blurred version for backgrounds
    soft = np.stack([blur_wrap_x(col[..., c], 10) for c in range(3)], -1)
    files += save(rgb_img(soft), "env/room_blur", webp_q=88)
    return files


if __name__ == "__main__":
    build()
