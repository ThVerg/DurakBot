"""Re-dress the DurakBot portrait rig for the light 'Atelier' concept.

Reuses the shared avatar rig from web/tools/art/avatars.py (read-only import) and
swaps the dark jewel-tone backdrops for soft pastel paper tones, drops the dark
vignette and lightens the contact shadow. Outputs vector SVGs into img/avatars/.
Run with:  .venv/bin/python -B concepts/atelier/tools/build_avatars.py
"""
from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / "web" / "tools" / "art"))

import avatars as av  # noqa: E402

OUT = HERE.parent / "img" / "avatars"
OUT.mkdir(parents=True, exist_ok=True)

PASTEL = {
    "kostya": ("#E3EEF1", "#C3DCE3"),
    "zina": ("#F7E6E3", "#EBC9C6"),
    "misha": ("#E6EEE2", "#C9DAC5"),
    "sveta": ("#ECE6F6", "#D3C9EC"),
    "lev": ("#E8EAEF", "#CDD3DE"),
    "dasha": ("#F8E8DD", "#EECDB8"),
    "grisha": ("#F4EEDB", "#E4D6AE"),
}

for pid, bg in PASTEL.items():
    fn = getattr(av, pid)
    orig = fn

    def patched(orig=orig, bg=bg):
        res = orig()
        p = res[0] if isinstance(res, tuple) else res
        p["bg"] = bg
        return res

    setattr(av, pid, patched)
    svg = av.render_persona(pid)
    # no dark vignette on a light canvas; softer light bloom + contact shadow
    svg = svg.replace('<rect width="256" height="256" fill="url(#vign)"/>', "")
    svg = svg.replace('<circle cx="128" cy="40" r="120" fill="#fff" opacity="0.06"/>',
                      '<circle cx="128" cy="34" r="128" fill="#fff" opacity="0.45"/>')
    svg = svg.replace('fill="#000" opacity="0.25" filter="url(#drop)"', 'fill="#3a2a20" opacity="0.10" filter="url(#drop)"')
    (OUT / f"{pid}.svg").write_text(svg)
    setattr(av, pid, orig)
    print("wrote", pid, len(svg))
