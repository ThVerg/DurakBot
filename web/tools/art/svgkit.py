"""Tiny procedural-SVG toolkit: curves, tapered brush strokes, guilloche, gold."""
from __future__ import annotations

import math
from typing import Callable, Iterable, Sequence

Pt = tuple[float, float]


def f(v: float) -> str:
    return f"{v:.2f}".rstrip("0").rstrip(".") if abs(v) < 1e6 else str(v)


def pts_str(pts: Iterable[Pt]) -> str:
    return " ".join(f"{f(x)},{f(y)}" for x, y in pts)


def poly(pts: Sequence[Pt], closed=True, **attrs) -> str:
    tag = "polygon" if closed else "polyline"
    a = " ".join(f'{k.replace("_", "-")}="{v}"' for k, v in attrs.items())
    return f'<{tag} points="{pts_str(pts)}" {a}/>'


def path_d(pts: Sequence[Pt], closed=True) -> str:
    d = "M" + " L".join(f"{f(x)} {f(y)}" for x, y in pts)
    return d + ("Z" if closed else "")


def cubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt, n: int = 48) -> list[Pt]:
    out = []
    for i in range(n + 1):
        t = i / n
        a, b, c, d = (1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t * t, t ** 3
        out.append((a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]))
    return out


def spiral(cx: float, cy: float, r0: float, r1: float, a0: float, turns: float, n: int = 80, cw: bool = True) -> list[Pt]:
    """Spiral from radius r0 at angle a0 inward to r1 over `turns` turns."""
    out = []
    s = 1 if cw else -1
    for i in range(n + 1):
        t = i / n
        r = r0 * (r1 / r0) ** t
        a = a0 + s * 2 * math.pi * turns * t
        out.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return out


def tapered(center: Sequence[Pt], width: Callable[[float], float] | float) -> list[Pt]:
    """Brush stroke: polygon around a centre-line with width profile w(t), t∈[0,1]."""
    n = len(center)
    wf = width if callable(width) else (lambda t, w=width: w)
    left, right = [], []
    for i, (x, y) in enumerate(center):
        x0, y0 = center[max(i - 1, 0)]
        x1, y1 = center[min(i + 1, n - 1)]
        dx, dy = x1 - x0, y1 - y0
        l = math.hypot(dx, dy) or 1.0
        nx, ny = -dy / l, dx / l
        w = wf(i / (n - 1)) / 2
        left.append((x + nx * w, y + ny * w))
        right.append((x - nx * w, y - ny * w))
    return left + right[::-1]


def taper_tip(w: float, p: float = 0.8):
    """Thick at the base, pointed at the tip."""
    return lambda t: w * (1 - t) ** p + 0.15


def taper_both(w: float, p: float = 0.7):
    return lambda t: w * max(math.sin(math.pi * t), 0) ** p + 0.1


def mirror_x(pts: Sequence[Pt], cx: float) -> list[Pt]:
    return [(2 * cx - x, y) for x, y in pts]


def rot180(pts: Sequence[Pt], cx: float, cy: float) -> list[Pt]:
    return [(2 * cx - x, 2 * cy - y) for x, y in pts]


def guilloche_ring(cx, cy, r0, r1, n, lobes, stroke, width, phase=0.0, steps=1200, opacity=1.0, mod=0.0, mod_lobes=3):
    out = []
    for i in range(n):
        ph = phase + 2 * math.pi * i / n
        pts = []
        for k in range(steps + 1):
            t = 2 * math.pi * k / steps
            u = 0.5 + 0.5 * math.sin(lobes * t + ph)
            if mod:
                u = u * (1 - mod) + mod * (0.5 + 0.5 * math.sin(mod_lobes * t - ph))
            r = r0 + (r1 - r0) * u
            pts.append((cx + r * math.cos(t), cy + r * math.sin(t)))
        out.append(poly(pts, closed=False, fill="none", stroke=stroke, stroke_width=width, opacity=opacity))
    return "".join(out)


def guilloche_oval(cx, cy, rx0, ry0, rx1, ry1, n, lobes, stroke, width, phase=0.0, steps=1400, opacity=1.0):
    out = []
    for i in range(n):
        ph = phase + 2 * math.pi * i / n
        pts = []
        for k in range(steps + 1):
            t = 2 * math.pi * k / steps
            u = 0.5 + 0.5 * math.sin(lobes * t + ph)
            rx = rx0 + (rx1 - rx0) * u
            ry = ry0 + (ry1 - ry0) * u
            pts.append((cx + rx * math.cos(t), cy + ry * math.sin(t)))
        out.append(poly(pts, closed=False, fill="none", stroke=stroke, stroke_width=width, opacity=opacity))
    return "".join(out)


def hypotrochoid(cx, cy, R, r, d, scale, steps=3000, rot=0.0) -> list[Pt]:
    g = math.gcd(int(R), int(r))
    turns = int(r) // g
    out = []
    for k in range(steps + 1):
        t = 2 * math.pi * turns * k / steps
        x = (R - r) * math.cos(t) + d * math.cos((R - r) / r * t)
        y = (R - r) * math.sin(t) - d * math.sin((R - r) / r * t)
        ca, sa = math.cos(rot), math.sin(rot)
        out.append((cx + scale * (x * ca - y * sa), cy + scale * (x * sa + y * ca)))
    return out


def wave_field(w, h, spacing, amp, wavelength, stroke, width, opacity, angle_family=0, phase_drift=0.35, steps_px=4.0, margin=40):
    """Family of parallel sine lines covering the rectangle; two families crossing = guilloche lattice."""
    out = []
    n = int((h + 2 * margin) / spacing) + 1
    for i in range(n):
        y0 = -margin + i * spacing
        ph = i * phase_drift
        pts = []
        x = -margin
        while x <= w + margin:
            pts.append((x, y0 + amp * math.sin(2 * math.pi * x / wavelength + ph) + 0.35 * amp * math.sin(2 * math.pi * x / (wavelength * 0.37) - 1.3 * ph)))
            x += steps_px
        out.append(poly(pts, closed=False, fill="none", stroke=stroke, stroke_width=width, opacity=opacity))
    return "".join(out)


def gold_defs(gid="gold", w=512, h=716, dark=False) -> str:
    """A metallic gold gradient in user space: banded so strokes catch varying 'light'."""
    stops = [
        (0.00, "#8a6424"), (0.12, "#e8cf86"), (0.24, "#b88a3a"), (0.38, "#f6e3a1"),
        (0.50, "#c2973f"), (0.63, "#8f6626"), (0.76, "#e3c579"), (0.88, "#b1823a"), (1.00, "#f0d995"),
    ]
    if dark:
        stops = [(o, c) for o, c in stops]
    s = "".join(f'<stop offset="{o}" stop-color="{c}"/>' for o, c in stops)
    return (f'<linearGradient id="{gid}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="{w}" y2="{h}">{s}</linearGradient>'
            f'<linearGradient id="{gid}V" gradientUnits="objectBoundingBox" x1="0" y1="0" x2="0" y2="1">'
            '<stop offset="0" stop-color="#f7e7ae"/><stop offset="0.45" stop-color="#d4aa52"/>'
            '<stop offset="0.55" stop-color="#a87b2f"/><stop offset="1" stop-color="#e9cd80"/></linearGradient>')


def rect_frame(x, y, w, h, r, stroke, width, **attrs) -> str:
    a = " ".join(f'{k.replace("_", "-")}="{v}"' for k, v in attrs.items())
    return f'<rect x="{f(x)}" y="{f(y)}" width="{f(w)}" height="{f(h)}" rx="{f(r)}" fill="none" stroke="{stroke}" stroke-width="{width}" {a}/>'
