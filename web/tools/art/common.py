"""Shared helpers for the DurakBot art pipeline.

Everything here is deterministic: noise is seeded, and all noise fields are
generated in the frequency domain (FFT), so they are seamlessly tileable.
"""
from __future__ import annotations

import base64
import json
import os
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
WEB = HERE.parent.parent
OUT = WEB / "public" / "assets"

# Fonts are embedded as data: URIs so Chromium never needs file:// access and
# rendering does not depend on fontconfig fallback.
FONTS = {
    "idx": "/usr/share/fonts/opentype/urw-base35/P052-Bold.otf",  # Palatino-style (URW base35)
    "garamond": "/usr/share/fonts/truetype/ebgaramond/EBGaramond12-Regular.ttf",  # (the Bold cut lacks Cyrillic)
    "garamond-r": "/usr/share/fonts/truetype/ebgaramond/EBGaramond12-Regular.ttf",
    "garamond-i": "/usr/share/fonts/truetype/ebgaramond/EBGaramond12-Italic.ttf",
}


def font_css(*names: str) -> str:
    css = []
    for n in names:
        p = FONTS[n]
        b64 = base64.b64encode(Path(p).read_bytes()).decode()
        mime = "font/otf" if p.endswith(".otf") else "font/ttf"
        css.append(f"@font-face{{font-family:'{n}';src:url(data:{mime};base64,{b64})}}")
    return "".join(css)


# --------------------------------------------------------------------------
# Headless Chromium SVG renderer
# --------------------------------------------------------------------------
class Renderer:
    """Render SVG/HTML snippets to RGBA PIL images with Playwright Chromium."""

    def __init__(self):
        from playwright.sync_api import sync_playwright

        self._pw = sync_playwright().start()
        self._browser = self._pw.chromium.launch()
        self._pages: dict = {}

    def page(self, w: int, h: int, scale: float):
        key = (w, h, scale)
        if key not in self._pages:
            ctx = self._browser.new_context(
                viewport={"width": w, "height": h}, device_scale_factor=scale,
                java_script_enabled=True,
            )
            # Block every network request: inputs must be fully self-contained.
            ctx.route("**/*", lambda route: route.abort())
            self._pages[key] = ctx.new_page()
        return self._pages[key]

    def render(self, svg: str, w: int, h: int, ss: float = 2.0, css: str = "",
               wait_fonts: bool = False, down: str = "lanczos", wait_img: bool = False) -> Image.Image:
        """Render at ss× supersampling, then downsample.

        down="lanczos": the original 1× pipeline (kept so 512 px outputs stay identical).
        down="box": premultiplied-alpha area average over integer ss×ss blocks:
                    exact coverage antialiasing with no ringing (used for @2x/@3x).
        """
        pg = self.page(w, h, ss)
        html = (
            "<!doctype html><html><head><style>html,body{margin:0;padding:0;"
            f"background:transparent;overflow:hidden}}svg{{display:block}}{css}</style></head>"
            f"<body>{svg}</body></html>"
        )
        pg.set_content(html)
        if wait_fonts:
            pg.evaluate("document.fonts.ready.then(()=>1)")
        if wait_img:
            pg.evaluate("Promise.all([...document.images].map(i => i.decode())).then(()=>1)")
        png = pg.screenshot(omit_background=True, type="png",
                            clip={"x": 0, "y": 0, "width": w, "height": h})
        import io

        im = Image.open(io.BytesIO(png)).convert("RGBA")
        if im.size != (w, h):
            if down == "box" and float(ss).is_integer():
                im = box_reduce(im, int(ss))
            else:
                im = im.resize((w, h), Image.LANCZOS)
        return im

    def evaluate(self, html: str, js: str, w: int = 360, h: int = 540):
        pg = self.page(w, h, 1)
        pg.set_content(html)
        return pg.evaluate(js)

    def close(self):
        self._browser.close()
        self._pw.stop()


def scale_hairlines(svg: str, k: float) -> str:
    """vector-effect="non-scaling-stroke" widths are in CSS px, not user units, so they would
    stay thin when the same SVG is rasterised k× larger. Multiply them by k to keep the look."""
    if k == 1:
        return svg
    import re as _re

    def fix(m):
        tag = m.group(0)
        if "non-scaling-stroke" not in tag:
            return tag
        return _re.sub(r'stroke-width="([0-9.]+)"', lambda w: f'stroke-width="{float(w.group(1)) * k:g}"', tag)

    return _re.sub(r"<[a-zA-Z][^<>]*>", fix, svg)


def box_reduce(im: Image.Image, k: int) -> Image.Image:
    """Downsample RGBA by an integer factor, averaging in premultiplied alpha (no dark fringes)."""
    a = np.asarray(im, dtype=np.float64) / 255.0
    h, w = a.shape[0] // k, a.shape[1] // k
    a = a[: h * k, : w * k]
    alpha = a[..., 3:4]
    pre = np.concatenate([a[..., :3] * alpha, alpha], -1)
    pre = pre.reshape(h, k, w, k, 4).mean(axis=(1, 3))
    al = pre[..., 3:4]
    rgb = np.where(al > 1e-6, pre[..., :3] / np.maximum(al, 1e-6), 0)
    out = np.concatenate([rgb, al], -1)
    return Image.fromarray(np.uint8(np.clip(out * 255 + 0.5, 0, 255)), "RGBA")


# --------------------------------------------------------------------------
# Saving
# --------------------------------------------------------------------------
def save(im: Image.Image, rel: str, webp_q: int = 85, png: bool = False,
         lossless: bool = False, png_quant: bool = True) -> list[str]:
    """Save `rel` (without extension) as .webp (and optionally .png)."""
    base = OUT / rel
    base.parent.mkdir(parents=True, exist_ok=True)
    written = []
    p = base.with_suffix(".webp")
    if lossless:
        im.save(p, "WEBP", lossless=True, quality=100, method=6)
    else:
        im.save(p, "WEBP", quality=webp_q, method=6, alpha_quality=100)
    written.append(str(p.relative_to(OUT)))
    if png:
        p2 = base.with_suffix(".png")
        if png_quant:  # 256-colour palette + Floyd–Steinberg: ~7× smaller, visually identical
            q = im.quantize(256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.FLOYDSTEINBERG)
            q.save(p2, "PNG", optimize=True)
        else:
            im.save(p2, "PNG", optimize=True)
        written.append(str(p2.relative_to(OUT)))
    return written


# --------------------------------------------------------------------------
# Tileable noise (numpy, FFT based)
# --------------------------------------------------------------------------
def rng(seed: int) -> np.random.Generator:
    return np.random.default_rng(seed)


def _freq(h: int, w: int):
    fy = np.fft.fftfreq(h)[:, None]
    fx = np.fft.fftfreq(w)[None, :]
    return fy, fx


def gauss_blur(a: np.ndarray, sigma_x: float, sigma_y: float | None = None) -> np.ndarray:
    """Periodic (wrap-around) gaussian blur of a 2D array via FFT."""
    if sigma_y is None:
        sigma_y = sigma_x
    h, w = a.shape
    fy, fx = _freq(h, w)
    g = np.exp(-2 * (np.pi ** 2) * ((fx * sigma_x) ** 2 + (fy * sigma_y) ** 2))
    return np.real(np.fft.ifft2(np.fft.fft2(a) * g))


def norm01(a: np.ndarray) -> np.ndarray:
    lo, hi = np.percentile(a, 0.5), np.percentile(a, 99.5)
    return np.clip((a - lo) / (hi - lo + 1e-9), 0, 1)


def band_noise(h: int, w: int, period: float, seed: int, aniso=(1.0, 1.0)) -> np.ndarray:
    """Tileable noise with feature size ~period px (unit variance)."""
    r = rng(seed)
    n = r.standard_normal((h, w))
    s = period / 4.0
    out = gauss_blur(n, s * aniso[0], s * aniso[1])
    return (out - out.mean()) / (out.std() + 1e-9)


def fbm(h: int, w: int, base_period: float, octaves: int, seed: int,
        gain: float = 0.5, aniso=(1.0, 1.0)) -> np.ndarray:
    total = np.zeros((h, w))
    amp, per, norm = 1.0, base_period, 0.0
    for o in range(octaves):
        total += amp * band_noise(h, w, max(per, 1.0), seed + o * 101, aniso)
        norm += amp
        amp *= gain
        per /= 2.0
    return total / norm


def warp(a: np.ndarray, dx: np.ndarray, dy: np.ndarray) -> np.ndarray:
    """Sample a (periodic) at (x+dx, y+dy) with bilinear interpolation."""
    h, w = a.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float64)
    x = (xx + dx) % w
    y = (yy + dy) % h
    x0 = np.floor(x).astype(int)
    y0 = np.floor(y).astype(int)
    fx = x - x0
    fy = y - y0
    x1 = (x0 + 1) % w
    y1 = (y0 + 1) % h
    return (a[y0, x0] * (1 - fx) * (1 - fy) + a[y0, x1] * fx * (1 - fy)
            + a[y1, x0] * (1 - fx) * fy + a[y1, x1] * fx * fy)


def normal_from_height(hgt: np.ndarray, strength: float) -> Image.Image:
    """OpenGL-convention (+Y up) tangent-space normal map from a periodic height map."""
    dx = (np.roll(hgt, -1, 1) - np.roll(hgt, 1, 1)) * 0.5
    dy = (np.roll(hgt, -1, 0) - np.roll(hgt, 1, 0)) * 0.5
    nx = -dx * strength
    ny = dy * strength  # image y goes down; OpenGL green = up
    nz = np.ones_like(hgt)
    l = np.sqrt(nx * nx + ny * ny + nz * nz)
    n = np.stack([nx / l, ny / l, nz / l], -1)
    return Image.fromarray(np.uint8(np.clip((n * 0.5 + 0.5) * 255 + 0.5, 0, 255)), "RGB")


def to_img(a: np.ndarray, mode: str = "L") -> Image.Image:
    return Image.fromarray(np.uint8(np.clip(a * 255 + 0.5, 0, 255)), mode)


def lerp_colors(t: np.ndarray, stops: list[tuple[float, tuple[int, int, int]]]) -> np.ndarray:
    """Map t∈[0,1] through a list of (pos, rgb) stops → float RGB in 0..1."""
    t = np.clip(t, 0, 1)
    pos = np.array([s[0] for s in stops])
    cols = np.array([s[1] for s in stops], dtype=np.float64) / 255.0
    out = np.empty(t.shape + (3,))
    for c in range(3):
        out[..., c] = np.interp(t, pos, cols[:, c])
    return out


def rgb_img(a: np.ndarray) -> Image.Image:
    return Image.fromarray(np.uint8(np.clip(a * 255 + 0.5, 0, 255)), "RGB")


def hexrgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")


def env_path(name: str, default: str) -> Path:
    return Path(os.environ.get(name, default))


def oriented_noise(h: int, w: int, along: float, across: float, angle: float, seed: int) -> np.ndarray:
    """Tileable noise stretched along `angle` (radians): fibres / streaks / brushed metal."""
    r = rng(seed)
    n = r.standard_normal((h, w))
    fy, fx = _freq(h, w)
    ca, sa = np.cos(angle), np.sin(angle)
    fu = fx * ca + fy * sa
    fv = -fx * sa + fy * ca
    g = np.exp(-2 * (np.pi ** 2) * ((fu * along) ** 2 + (fv * across) ** 2))
    out = np.real(np.fft.ifft2(np.fft.fft2(n) * g))
    return (out - out.mean()) / (out.std() + 1e-9)


def worley(h: int, w: int, cells: int, seed: int, jitter: float = 0.9):
    """Tileable Worley noise; returns (F1, F2) distances in cell units."""
    r = rng(seed)
    cy = cells
    cx = max(1, int(round(cells * w / h)))
    pts = (r.random((cy, cx, 2)) - 0.5) * jitter + 0.5  # within-cell offsets
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float64)
    gy = yy / h * cy
    gx = xx / w * cx
    iy = np.floor(gy).astype(int)
    ix = np.floor(gx).astype(int)
    f1 = np.full((h, w), 9.0)
    f2 = np.full((h, w), 9.0)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            ny = iy + dy
            nx = ix + dx
            p = pts[ny % cy, nx % cx]
            px = nx + p[..., 1]
            py = ny + p[..., 0]
            d = np.sqrt((gx - px) ** 2 + (gy - py) ** 2)
            f2 = np.where(d < f1, f1, np.minimum(f2, d))
            f1 = np.minimum(f1, d)
    return f1, f2
