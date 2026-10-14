"""Illustrated bot portraits (256², round-crop ready) + gold-ring framed variants.

One shared rig (head, features, lighting) with per-persona hair, clothes and
props, so the set reads as one cohesive family. Ids match web/src/components/Avatar.tsx.
"""
from __future__ import annotations

import math

import numpy as np
from PIL import Image, ImageDraw

from common import Renderer, save

S = 256

PERSONAS = {
    "zina": {"en": "Babushka Zina", "ru": "Бабушка Зина"},
    "misha": {"en": "Uncle Misha", "ru": "Дядя Миша"},
    "sveta": {"en": "Sveta", "ru": "Света"},
    "kostya": {"en": "Kostya", "ru": "Костя"},
    "lev": {"en": "Professor Lev", "ru": "Профессор Лев"},
    "dasha": {"en": "Dasha", "ru": "Даша"},
    "grisha": {"en": "Grisha", "ru": "Гриша"},
    "you": {"en": "You", "ru": "Вы"},
}

INK = "#2a1a14"


def defs_common(p) -> str:
    return f'''
<radialGradient id="bg" cx="50%" cy="35%" r="75%"><stop offset="0" stop-color="{p['bg'][0]}"/><stop offset="1" stop-color="{p['bg'][1]}"/></radialGradient>
<radialGradient id="skin" cx="40%" cy="35%" r="70%"><stop offset="0" stop-color="{p['skin'][0]}"/><stop offset="0.7" stop-color="{p['skin'][1]}"/><stop offset="1" stop-color="{p['skin'][2]}"/></radialGradient>
<linearGradient id="cloth" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{p['cloth'][0]}"/><stop offset="1" stop-color="{p['cloth'][1]}"/></linearGradient>
<linearGradient id="hair" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{p['hair'][0]}"/><stop offset="1" stop-color="{p['hair'][1]}"/></linearGradient>
<radialGradient id="blush" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#e8737a" stop-opacity="0.55"/><stop offset="1" stop-color="#e8737a" stop-opacity="0"/></radialGradient>
<radialGradient id="iris" cx="40%" cy="35%" r="70%"><stop offset="0" stop-color="{p['eye'][0]}"/><stop offset="1" stop-color="{p['eye'][1]}"/></radialGradient>
<radialGradient id="vign" cx="50%" cy="45%" r="70%"><stop offset="0.6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.45"/></radialGradient>
<filter id="soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="6"/></filter>
<filter id="soft2" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="2.5"/></filter>
<filter id="drop" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="5"/></filter>
<clipPath id="faceclip"><path d="{face_path(p)}"/></clipPath>
'''


def face_path(p) -> str:
    w = p.get("face_w", 50)
    jaw = p.get("jaw", 0)
    cx = 128
    return (f"M{cx - w} 112 C{cx - w} 72 {cx - w * 0.55} 54 {cx} 54 C{cx + w * 0.55} 54 {cx + w} 72 {cx + w} 112 "
            f"C{cx + w} 146 {cx + w * 0.62 + jaw} 176 {cx} 182 C{cx - w * 0.62 - jaw} 176 {cx - w} 146 {cx - w} 112Z")


def shoulders(p) -> str:
    return ('<path d="M18 256 C24 210 70 190 128 190 C186 190 232 210 238 256Z" fill="url(#cloth)"/>'
            '<path d="M18 256 C24 210 70 190 128 190 C150 190 170 193 186 198 C150 200 110 215 92 256Z" fill="#fff" opacity="0.07"/>')


def neck(p) -> str:
    return (f'<path d="M106 160 L106 196 C116 206 140 206 150 196 L150 160Z" fill="{p["skin"][1]}"/>'
            f'<path d="M106 168 C116 186 140 186 150 168 L150 186 C140 194 116 194 106 186Z" fill="{p["skin"][2]}" opacity="0.7"/>')


def ears(p) -> str:
    w = p.get("face_w", 50)
    return "".join(
        f'<ellipse cx="{128 + s * (w - 1)}" cy="120" rx="9" ry="14" fill="{p["skin"][1]}"/>'
        f'<ellipse cx="{128 + s * (w - 0)}" cy="121" rx="4" ry="8" fill="{p["skin"][2]}" opacity="0.6"/>' for s in (-1, 1))


def head(p) -> str:
    out = [f'<path d="{face_path(p)}" fill="url(#skin)"/>']
    # form shading (light from upper-left): soft shadow on the right cheek and under the brow
    out.append(f'<g clip-path="url(#faceclip)"><ellipse cx="186" cy="130" rx="40" ry="70" fill="{p["skin"][2]}" opacity="0.55" filter="url(#soft)"/>'
               f'<ellipse cx="128" cy="190" rx="60" ry="22" fill="{p["skin"][2]}" opacity="0.45" filter="url(#soft)"/></g>')
    return "".join(out)


def eyes(p) -> str:
    out = []
    y = p.get("eye_y", 118)
    sq = p.get("squint", 0)
    for cx in (108, 148):
        out.append(f'<path d="M{cx - 11} {y} Q{cx} {y - 9 + sq} {cx + 11} {y} Q{cx} {y + 6 - sq * 0.3} {cx - 11} {y}Z" fill="#fbf6f0"/>')
        out.append(f'<clipPath id="ec{cx}"><path d="M{cx - 11} {y} Q{cx} {y - 9 + sq} {cx + 11} {y} Q{cx} {y + 6 - sq * 0.3} {cx - 11} {y}Z"/></clipPath>')
        out.append(f'<g clip-path="url(#ec{cx})"><circle cx="{cx + 1}" cy="{y - 0.5}" r="6.4" fill="url(#iris)"/>'
                   f'<circle cx="{cx + 1}" cy="{y - 0.5}" r="3" fill="#120a08"/>'
                   f'<rect x="{cx - 12}" y="{y - 10}" width="24" height="5" fill="{p["skin"][2]}" opacity="0.35"/></g>')
        out.append(f'<circle cx="{cx - 1.2}" cy="{y - 2.6}" r="1.7" fill="#fff"/>')
        lash = 2.6 if p.get("lashes") else 1.8
        out.append(f'<path d="M{cx - 12} {y + 0.5} Q{cx} {y - 10 + sq} {cx + 12} {y - 0.5}" fill="none" stroke="{INK}" stroke-width="{lash}" stroke-linecap="round"/>')
        if p.get("lashes"):
            out.append(f'<path d="M{cx + 11} {y - 1} l4 -3" stroke="{INK}" stroke-width="1.6" stroke-linecap="round"/>' if cx > 128 else
                       f'<path d="M{cx - 11} {y - 1} l-4 -3" stroke="{INK}" stroke-width="1.6" stroke-linecap="round"/>')
        if p.get("age", 0) > 0:
            out.append(f'<path d="M{cx - 8} {y + 7} Q{cx} {y + 11} {cx + 8} {y + 7}" fill="none" stroke="{p["skin"][2]}" stroke-width="1.3" opacity="0.9"/>')
    return "".join(out)


def brows(p) -> str:
    c = p.get("brow", INK)
    y = p.get("eye_y", 118) - 15
    lift = p.get("brow_lift", 0)
    th = p.get("brow_w", 4.5)
    out = []
    for s in (-1, 1):
        x0, x1 = 128 + s * 8, 128 + s * 32
        out.append(f'<path d="M{x0} {y + 2} Q{(x0 + x1) / 2} {y - 6 - lift} {x1} {y + 1} Q{(x0 + x1) / 2} {y - 6 - lift + th} {x0} {y + 2 + th * 0.6}Z" fill="{c}"/>')
    return "".join(out)


def nose(p) -> str:
    sk = p["skin"][2]
    return (f'<path d="M126 122 C122 134 118 142 121 146 C124 149 132 149 136 146" fill="none" stroke="{sk}" stroke-width="2.4" stroke-linecap="round" opacity="0.9"/>'
            f'<ellipse cx="129" cy="141" rx="5" ry="3.2" fill="#fff" opacity="0.18"/>')


def mouth(p) -> str:
    lip = p.get("lip", "#b85a55")
    smile = p.get("smile", 4)
    y = p.get("mouth_y", 160)
    return (f'<path d="M113 {y} Q128 {y + smile + 6} 143 {y} Q128 {y + smile + 1} 113 {y}Z" fill="{lip}"/>'
            f'<path d="M113 {y} Q120 {y - 4} 128 {y - 1.5} Q136 {y - 4} 143 {y}" fill="{lip}" opacity="0.85"/>'
            f'<path d="M112 {y} Q128 {y + smile} 144 {y}" fill="none" stroke="#5a2420" stroke-width="1.6" stroke-linecap="round"/>'
            f'<ellipse cx="130" cy="{y + smile * 0.5 + 4.5}" rx="5" ry="1.5" fill="#fff" opacity="0.25"/>')


def blush(p) -> str:
    o = p.get("blush", 0.8)
    return f'<g opacity="{o}"><ellipse cx="100" cy="142" rx="14" ry="9" fill="url(#blush)"/><ellipse cx="156" cy="142" rx="14" ry="9" fill="url(#blush)"/></g>'


def glasses(round_=True, colour="#2b2b2b", gold=False) -> str:
    c = "#c9a24f" if gold else colour
    out = []
    for cx in (108, 148):
        if round_:
            out.append(f'<circle cx="{cx}" cy="119" r="15" fill="#dfefff" fill-opacity="0.12" stroke="{c}" stroke-width="2.6"/>')
        else:
            out.append(f'<rect x="{cx - 16}" y="107" width="32" height="24" rx="7" fill="#dfefff" fill-opacity="0.12" stroke="{c}" stroke-width="2.6"/>')
        out.append(f'<path d="M{cx - 9} {112} l6 -2" stroke="#fff" stroke-width="2" opacity="0.5" stroke-linecap="round"/>')
    out.append(f'<path d="M123 117 Q128 113 133 117" fill="none" stroke="{c}" stroke-width="2.4"/>')
    out.append(f'<path d="M93 117 L80 114 M163 117 L176 114" stroke="{c}" stroke-width="2.4"/>')
    return "".join(out)


def rim_light() -> str:
    return (f'<g clip-path="url(#faceclip)"><path d="{face_path({"face_w": 50})}" fill="none" stroke="#ffe9c9" stroke-width="5" '
            'opacity="0.25" filter="url(#soft2)" transform="translate(-4 -2)"/></g>')


# --------------------------------------------------------------------- personas
def zina():
    p = dict(bg=("#7b2232", "#2a0910"), skin=("#f7dccb", "#e9bea4", "#c98f78"), cloth=("#4d2a5c", "#26142e"),
             hair=("#d9d4cf", "#a9a29b"), eye=("#7aa0c4", "#3c5f86"), age=1, smile=6, lip="#b0645e", face_w=52, jaw=4)
    back = ''
    # platok (headscarf) with floral print, tied under the chin
    scarf = ('<path d="M66 128 C58 60 96 34 128 34 C160 34 198 60 190 128 C184 100 176 78 128 74 C80 78 72 100 66 128Z" fill="url(#scarf)"/>'
             '<path d="M66 128 C64 150 74 178 92 196 L104 186 C86 166 80 146 82 124Z" fill="url(#scarf)"/>'
             '<path d="M190 128 C192 150 182 178 164 196 L152 186 C170 166 176 146 174 124Z" fill="url(#scarf)"/>'
             '<path d="M112 190 L128 206 L144 190 L138 218 L128 212 L118 218Z" fill="#9e1b2b"/>')
    flowers = []
    import random
    rnd = random.Random(3)
    for (x, y) in ((96, 52), (128, 42), (160, 52), (80, 78), (176, 78), (74, 108), (182, 108), (110, 62), (146, 62)):
        r = 6 + rnd.random() * 2
        for k in range(5):
            a = 2 * math.pi * k / 5 + rnd.random()
            flowers.append(f'<circle cx="{x + r * 0.7 * math.cos(a):.1f}" cy="{y + r * 0.7 * math.sin(a):.1f}" r="{r * 0.5:.1f}" fill="#f6d36b" opacity="0.95"/>')
        flowers.append(f'<circle cx="{x}" cy="{y}" r="{r * 0.35:.1f}" fill="#1f5a3a"/>')
    hair_front = '<path d="M84 98 C96 80 116 78 128 82 C140 78 160 80 172 98 C160 90 140 88 128 92 C116 88 96 90 84 98Z" fill="url(#hair)"/>'
    extra_defs = ('<linearGradient id="scarf" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#d2283a"/>'
                  '<stop offset="1" stop-color="#7c0f1c"/></linearGradient>'
                  '<clipPath id="scarfclip"><path d="M66 128 C58 60 96 34 128 34 C160 34 198 60 190 128 C184 100 176 78 128 74 C80 78 72 100 66 128Z"/></clipPath>')
    front = (hair_front + scarf + f'<g clip-path="url(#scarfclip)">{"".join(flowers)}</g>'
             + '<path d="M70 110 C80 84 100 76 128 74 C156 76 176 84 186 110" fill="none" stroke="#f6d36b" stroke-width="1.5" stroke-dasharray="2 4" opacity="0.8"/>'
             + glasses(True, gold=True))
    # shawl/cardigan collar
    cloth_extra = '<path d="M70 210 C96 222 160 222 186 210 L196 256 L60 256Z" fill="#3a1f46" opacity="0.6"/>'
    return p, extra_defs, back, front, cloth_extra


def misha():
    p = dict(bg=("#2f5a46", "#0d1f17"), skin=("#f3cfb3", "#dda887", "#b97a5c"), cloth=("#5b3a24", "#2c1a0f"),
             hair=("#5b3a26", "#2d1a10"), eye=("#6b4a2c", "#3a2414"), smile=5, lip="#a55a4c", face_w=54, jaw=8, brow_w=6, brow="#3a2618")
    extra = ('<linearGradient id="fur" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9a7a5a"/>'
             '<stop offset="1" stop-color="#5e452f"/></linearGradient>'
             '<linearGradient id="hat" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4a3a2c"/><stop offset="1" stop-color="#211810"/></linearGradient>'
             '<filter id="furf"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="3"/>'
             '<feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -1.4 1.1"/><feComposite in2="SourceGraphic" operator="in"/></filter>')
    # ushanka: crown, fur brim, ear flaps
    flaps = ('<path d="M70 104 C60 120 60 160 74 176 C84 170 90 150 88 112Z" fill="url(#fur)"/>'
             '<path d="M186 104 C196 120 196 160 182 176 C172 170 166 150 168 112Z" fill="url(#fur)"/>')
    crown = '<path d="M74 92 C72 46 104 28 128 28 C152 28 184 46 182 92Z" fill="url(#hat)"/>'
    brim = ('<path d="M66 96 C70 72 100 64 128 64 C156 64 186 72 190 96 C186 106 170 104 128 104 C86 104 70 106 66 96Z" fill="url(#fur)"/>'
            '<path d="M66 96 C70 72 100 64 128 64 C156 64 186 72 190 96 C186 106 170 104 128 104 C86 104 70 106 66 96Z" fill="#000" filter="url(#furf)" opacity="0.35"/>')
    star = '<path d="M128 40 l4 9 10 1 -8 6 3 10 -9 -6 -9 6 3 -10 -8 -6 10 -1z" fill="#d9a441" stroke="#7a5216" stroke-width="0.8"/>'
    moustache = ('<path d="M100 154 C110 142 122 146 128 150 C134 146 146 142 156 154 C150 152 144 158 136 156 C132 155 130 153 128 152 '
                 'C126 153 124 155 120 156 C112 158 106 152 100 154Z" fill="#4a2e1c"/>')
    collar = ('<path d="M84 196 L112 230 L128 206 L144 230 L172 196 C160 190 96 190 84 196Z" fill="#e8e0d0"/>'
              '<path d="M120 206 L128 256 L136 206Z" fill="#24324f"/>')
    stubble = '<g clip-path="url(#faceclip)"><ellipse cx="128" cy="170" rx="44" ry="20" fill="#3a2a20" opacity="0.18" filter="url(#soft2)"/></g>'
    return p, extra, flaps, crown + brim + star + stubble + moustache, collar


def sveta():
    p = dict(bg=("#5b2a86", "#1d0b33"), skin=("#fbe2d2", "#f0c3a8", "#d39b82"), cloth=("#1e1b3a", "#0b0a1a"),
             hair=("#f2d58a", "#c99a3e"), eye=("#4f9a8a", "#235e55"), lashes=True, smile=5, lip="#c9475e", face_w=47, brow="#8a6532",
             brow_w=3.5, brow_lift=2, blush=1.0)
    back = ('<path d="M64 120 C56 60 92 36 128 36 C168 36 202 62 194 124 C200 170 206 214 192 236 C176 222 172 196 170 170 '
            'L86 170 C84 196 80 222 64 236 C50 214 56 170 64 120Z" fill="url(#hair)"/>')
    front = ('<path d="M80 118 C76 70 104 48 132 50 C166 52 184 78 178 120 C170 96 158 80 140 74 C128 92 104 104 80 118Z" fill="url(#hair)"/>'
             '<path d="M140 74 C150 86 164 100 176 112" fill="none" stroke="#fff3c4" stroke-width="2" opacity="0.6"/>'
             '<path d="M120 60 C104 70 92 88 86 108" fill="none" stroke="#fff3c4" stroke-width="2" opacity="0.5"/>'
             '<path d="M196 150 C200 180 196 208 186 228" fill="none" stroke="#a87a2a" stroke-width="2" opacity="0.6"/>'
             '<path d="M62 150 C58 180 62 208 72 228" fill="none" stroke="#a87a2a" stroke-width="2" opacity="0.6"/>')
    earrings = ''.join(f'<circle cx="{x}" cy="140" r="4" fill="#f4e7c6" stroke="#c9a24f" stroke-width="1.2"/>'
                       f'<path d="M{x} 144 l0 8" stroke="#c9a24f" stroke-width="1.4"/><circle cx="{x}" cy="155" r="3.4" fill="#5fd0c0"/>' for x in (79, 177))
    cloth = ('<path d="M96 192 C108 216 148 216 160 192" fill="none" stroke="#c9a24f" stroke-width="2.2"/>'
             '<circle cx="128" cy="213" r="5" fill="#c9a24f"/><circle cx="128" cy="213" r="2.5" fill="#5fd0c0"/>')
    return p, "", back, front + earrings, cloth


def kostya():
    p = dict(bg=("#1f5d6b", "#081d24"), skin=("#f4cfb2", "#e0a988", "#bf8163"), cloth=("#2d3b4f", "#141b26"),
             hair=("#3a2a1f", "#1d140e"), eye=("#5a7a3a", "#2e451c"), smile=7, lip="#a65a4d", face_w=48, brow_w=5, squint=1)
    extra = ('<linearGradient id="cap" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e8613f"/><stop offset="1" stop-color="#9a2d18"/></linearGradient>')
    back = '<path d="M76 108 C74 78 92 62 112 60 L120 100Z" fill="url(#hair)"/>'
    cap = ('<path d="M76 98 C72 52 104 36 130 36 C158 36 184 54 180 98 C170 92 150 88 128 88 C106 88 86 92 76 98Z" fill="url(#cap)"/>'
           '<path d="M128 36 L128 88" stroke="#7a2412" stroke-width="1.4" opacity="0.6"/>'
           '<path d="M98 42 C104 60 106 76 104 90 M158 42 C152 60 150 76 152 90" stroke="#7a2412" stroke-width="1.2" fill="none" opacity="0.5"/>'
           '<circle cx="128" cy="38" r="4" fill="#9a2d18"/>'
           # backwards: strap + visor showing at the back-right
           '<path d="M174 86 C190 84 206 92 214 104 C200 104 186 100 172 98Z" fill="#7a2412"/>'
           '<path d="M80 92 C100 86 156 86 178 92" fill="none" stroke="#f3e2d6" stroke-width="3" opacity="0.6" stroke-dasharray="3 3"/>')
    fringe = '<path d="M84 104 C92 90 104 88 112 92 C118 86 132 86 138 92 C146 88 162 90 172 104 C160 98 148 98 140 100 C130 94 118 96 110 100 C100 98 92 100 84 104Z" fill="url(#hair)"/>'
    stubble = '<g clip-path="url(#faceclip)"><path d="M80 150 C96 190 160 190 176 150 C170 176 150 186 128 186 C106 186 86 176 80 150Z" fill="#2a1d16" opacity="0.22" filter="url(#soft2)"/></g>'
    hoodie = ('<path d="M70 200 C84 186 108 182 128 196 C148 182 172 186 186 200 C170 214 150 214 128 206 C106 214 86 214 70 200Z" fill="#3c4d66"/>'
              '<path d="M116 208 L114 236 M140 208 L142 236" stroke="#e8e0d0" stroke-width="2.4" stroke-linecap="round"/>')
    return p, extra, back, fringe + cap + stubble, hoodie


def lev():
    p = dict(bg=("#3d4a5c", "#121821"), skin=("#f5d9c4", "#e2b598", "#c48d73"), cloth=("#3a3a3e", "#18181b"),
             hair=("#eceae6", "#b9b5ae"), eye=("#5b6f86", "#2f3e52"), age=1, smile=3, lip="#a8655c", face_w=51, brow="#cfcac2", brow_w=5.5)
    back = ('<path d="M74 132 C64 104 70 84 82 76 C76 96 80 112 84 122Z" fill="url(#hair)"/>'
            '<path d="M182 132 C192 104 186 84 174 76 C180 96 176 112 172 122Z" fill="url(#hair)"/>')
    # balding crown with side tufts and a neat goatee
    tufts = ('<path d="M78 112 C70 88 80 70 96 66 C90 80 90 96 92 108Z" fill="url(#hair)"/>'
             '<path d="M178 112 C186 88 176 70 160 66 C166 80 166 96 164 108Z" fill="url(#hair)"/>'
             '<path d="M98 60 C112 52 144 52 158 60" fill="none" stroke="#d8d4ce" stroke-width="2" opacity="0.6"/>')
    goatee = ('<path d="M112 168 C116 186 140 186 144 168 C138 174 118 174 112 168Z" fill="url(#hair)"/>'
              '<path d="M106 155 C116 148 124 150 128 152 C132 150 140 148 150 155 C140 156 134 158 128 157 C122 158 116 156 106 155Z" fill="#dcd8d2"/>')
    bow = ('<path d="M128 204 L106 192 L106 216Z M128 204 L150 192 L150 216Z" fill="#8e1a2b"/><circle cx="128" cy="204" r="5" fill="#6d1220"/>'
           '<path d="M88 194 L120 200 L128 256 L136 200 L168 194 C150 190 106 190 88 194Z" fill="#f2efe8"/>'
           '<path d="M128 204 L106 192 L106 216Z M128 204 L150 192 L150 216Z" fill="#8e1a2b"/><circle cx="128" cy="204" r="5" fill="#6d1220"/>')
    return p, "", back, tufts + goatee + glasses(True, colour="#3b2a1c"), bow


def dasha():
    p = dict(bg=("#a33a5c", "#3a0d1e"), skin=("#fbe0cf", "#f1c0a3", "#d4977a"), cloth=("#f2efe8", "#c9c2b6"),
             hair=("#8a4a26", "#4a2410"), eye=("#6a8f3a", "#36521a"), lashes=True, smile=8, lip="#d0566a", face_w=46, brow="#5a2e16",
             brow_w=3.8, blush=1.1)
    braid = []
    for side in (-1, 1):
        x = 128 + side * 58
        for k in range(6):
            y = 140 + k * 17
            braid.append(f'<ellipse cx="{x + side * (k % 2) * 2}" cy="{y}" rx="{11 - k * 0.6}" ry="10" fill="url(#hair)" stroke="#3a1a0a" stroke-width="1"/>')
        braid.append(f'<path d="M{x - 8} 244 l16 0 l-3 8 l-10 0z" fill="#e8b33a"/>')
        braid.append(f'<circle cx="{x}" cy="240" r="5" fill="#e04a6a"/>')
    back = '<path d="M74 124 C68 62 100 40 128 40 C158 40 190 62 182 124Z" fill="url(#hair)"/>' + "".join(braid)
    front = ('<path d="M80 112 C78 70 104 50 128 50 C152 50 178 70 176 112 C168 92 150 82 128 82 C116 92 98 100 80 112Z" fill="url(#hair)"/>'
             '<path d="M84 104 C92 86 108 72 128 68" fill="none" stroke="#c07a46" stroke-width="2" opacity="0.6"/>'
             # flower hair clip
             + "".join(f'<circle cx="{168 + 6 * math.cos(a):.1f}" cy="{80 + 6 * math.sin(a):.1f}" r="4.5" fill="#f6d36b"/>' for a in np.linspace(0, 2 * math.pi, 6)[:-1])
             + '<circle cx="168" cy="80" r="3.5" fill="#e04a6a"/>')
    freckles = "".join(f'<circle cx="{x}" cy="{y}" r="1.1" fill="#b77356" opacity="0.6"/>' for x, y in
                       ((98, 136), (104, 140), (110, 136), (146, 136), (152, 140), (158, 136), (101, 131), (155, 131)))
    cloth = ('<path d="M92 194 C104 214 152 214 164 194" fill="none" stroke="#c03d55" stroke-width="5"/>'
             '<path d="M60 220 C70 214 82 214 92 222 M164 222 C174 214 186 214 196 220" stroke="#c03d55" stroke-width="3" fill="none"/>'
             + "".join(f'<circle cx="{x}" cy="{y}" r="2.2" fill="#c03d55"/>' for x, y in ((70, 236), (84, 240), (172, 240), (186, 236))))
    return p, "", back, front + freckles, cloth


def grisha():
    p = dict(bg=("#8a6a24", "#2a1d06"), skin=("#efc6a6", "#d79c78", "#b07254"), cloth=("#3b5a3c", "#1a2a1b"),
             hair=("#7a4a26", "#3e220f"), eye=("#4a6f8c", "#24384a"), smile=6, lip="#9a5244", face_w=53, jaw=6, brow="#4a2a14", brow_w=6)
    extra = ('<linearGradient id="beanie" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2f8f84"/><stop offset="1" stop-color="#14514a"/></linearGradient>'
             '<pattern id="knit" width="6" height="8" patternUnits="userSpaceOnUse"><path d="M0 0 L3 6 L6 0" fill="none" stroke="#0d3a35" stroke-width="1" opacity="0.5"/></pattern>')
    beard = ('<path d="M76 128 C76 196 108 216 128 216 C148 216 180 196 180 128 C176 150 166 160 152 164 C144 156 112 156 104 164 '
             'C90 160 80 150 76 128Z" fill="url(#hair)"/>'
             '<path d="M112 162 C120 170 136 170 144 162" fill="none" stroke="#9a5244" stroke-width="3" stroke-linecap="round"/>'
             '<path d="M100 150 C112 142 124 146 128 148 C132 146 144 142 156 150 C146 154 136 154 128 152 C120 154 110 154 100 150Z" fill="#5a3418"/>'
             + "".join(f'<path d="M{x} {y} q2 8 0 14" stroke="#a8703e" stroke-width="1.4" fill="none" opacity="0.6"/>' for x, y in
                       ((96, 172), (110, 184), (124, 190), (138, 188), (152, 180), (164, 168))))
    beanie = ('<path d="M74 100 C70 48 102 26 128 26 C154 26 186 48 182 100Z" fill="url(#beanie)"/>'
              '<path d="M74 100 C70 48 102 26 128 26 C154 26 186 48 182 100Z" fill="url(#knit)"/>'
              '<rect x="70" y="86" width="116" height="22" rx="10" fill="#1f6f66"/>'
              '<rect x="70" y="86" width="116" height="22" rx="10" fill="url(#knit)"/>'
              '<circle cx="128" cy="24" r="11" fill="#e9c46a"/><circle cx="124" cy="20" r="4" fill="#fff3c4" opacity="0.6"/>')
    sweater = '<path d="M84 200 C100 190 156 190 172 200 L172 214 C156 206 100 206 84 214Z" fill="#2c4a2e"/>'
    return p, extra, "", beard + beanie, sweater


def you():
    p = dict(bg=("#1c2f55", "#070d1c"), skin=("#e8c98a", "#c9a24f", "#8a6424"), cloth=("#c9a24f", "#7a5a20"),
             hair=("#c9a24f", "#8a6424"), eye=("#000", "#000"))
    return p


def render_persona(pid: str) -> str:
    if pid == "you":
        p = you()
        gold = ('<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f6e4a6"/>'
                '<stop offset="0.5" stop-color="#c9a24f"/><stop offset="1" stop-color="#7a5a20"/></linearGradient>')
        body = (f'<rect width="{S}" height="{S}" fill="url(#bg)"/>'
                '<circle cx="128" cy="98" r="42" fill="url(#g)"/>'
                '<path d="M44 236 C48 182 88 156 128 156 C168 156 208 182 212 236Z" fill="url(#g)"/>'
                '<circle cx="114" cy="84" r="14" fill="#fff" opacity="0.18"/>'
                '<path d="M128 182 l6 12 13 2 -10 9 3 13 -12 -7 -12 7 3 -13 -10 -9 13 -2z" fill="#1c2f55"/>'
                f'<rect width="{S}" height="{S}" fill="url(#vign)"/>')
        return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{S}" height="{S}" viewBox="0 0 {S} {S}">'
                f'<defs>{defs_common(p)}{gold}</defs>{body}</svg>')
    p, extra, back, front, cloth_extra = globals()[pid]()
    body = [f'<rect width="{S}" height="{S}" fill="url(#bg)"/>',
            '<circle cx="128" cy="40" r="120" fill="#fff" opacity="0.06"/>',
            '<g transform="translate(128 142) scale(1.2) translate(-128 -128)">', back, shoulders(p), cloth_extra, neck(p),
            '<ellipse cx="128" cy="196" rx="70" ry="14" fill="#000" opacity="0.25" filter="url(#drop)"/>',
            ears(p), head(p), blush(p), eyes(p), brows(p), nose(p), mouth(p), front, rim_light(), '</g>',
            f'<rect width="{S}" height="{S}" fill="url(#vign)"/>']
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{S}" height="{S}" viewBox="0 0 {S} {S}">'
            f'<defs>{defs_common(p)}{extra}</defs>{"".join(body)}</svg>')


def ring_variant(im: Image.Image) -> Image.Image:
    """Round crop with a bevelled gold ring, transparent outside."""
    ss = 4
    n = S * ss
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float64)
    c = (n - 1) / 2
    d = np.sqrt((xx - c) ** 2 + (yy - c) ** 2) / ss
    r_out, r_in = 127.5, 116.0
    ang = np.arctan2(yy - c, xx - c)
    # metallic ring: light from top-left, with bevel across the ring width
    u = np.clip((d - r_in) / (r_out - r_in), 0, 1)
    bevel = np.sin(u * math.pi)
    light = 0.55 + 0.45 * np.cos(ang + math.pi * 0.75)
    t = np.clip(0.25 + 0.5 * light * (0.4 + 0.6 * bevel) + 0.15 * np.cos(ang * 6) * bevel, 0, 1)
    stops = np.array([[90, 62, 22], [170, 128, 58], [236, 205, 130], [255, 244, 200]], dtype=np.float64)
    pos = np.array([0, 0.45, 0.8, 1.0])
    ring = np.stack([np.interp(t, pos, stops[:, k]) for k in range(3)], -1)
    big = np.asarray(im.convert("RGBA").resize((n, n), Image.LANCZOS), dtype=np.float64)
    out = big.copy()
    inner_shadow = np.clip(1 - (r_in - d) / 6, 0, 1) * (d < r_in)
    out[..., :3] *= (1 - 0.45 * inner_shadow)[..., None]
    in_ring = (d >= r_in - 0.5) & (d <= r_out)
    a_ring = np.clip(np.minimum(d - (r_in - 0.5), r_out - d) * ss, 0, 1)
    out[..., :3] = out[..., :3] * (1 - a_ring[..., None]) + ring * a_ring[..., None]
    alpha = np.clip((r_out - d) * ss, 0, 1) * 255
    out[..., 3] = alpha
    # thin dark separators at both ring edges
    for rr in (r_in, r_out - 0.6):
        e = np.clip(1 - np.abs(d - rr) * 1.5, 0, 1)
        out[..., :3] *= (1 - 0.5 * e)[..., None]
    img = Image.fromarray(np.uint8(np.clip(out, 0, 255)), "RGBA")
    return img.resize((S, S), Image.LANCZOS)


def build(r: Renderer) -> list[dict]:
    out = []
    for pid, names in PERSONAS.items():
        im = r.render(render_persona(pid), S, S, ss=3.0)
        files = save(im.convert("RGB"), f"avatars/{pid}", webp_q=90)
        files += save(ring_variant(im), f"avatars/{pid}_ring", webp_q=90)
        out.append({"id": pid, "files": files, **names})
    return out


if __name__ == "__main__":
    r = Renderer()
    build(r)
    r.close()
