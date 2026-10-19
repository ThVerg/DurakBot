"""Export what the static (GitHub Pages) build needs into web/public/static-data/.

The in-browser backend (web/src/local/) serves these files instead of the
FastAPI endpoints:

    lab.json            /api/lab payload (down-sampled training curves, evals,
                        champion promotions, eval summary, ladder; "human" is
                        filled in the browser from local game history)
    bots.json           /api/bots metadata: labels, descriptions, tiers, Elo,
                        preference order, personas and the title credential
    eval_summary.json   runs/eval_summary.json
    ladder.json         runs/ladder.json
    art-hires.json      /api/art/hires: which @2x/@3x card art exists

Reuses server/lab.py and server/bots_meta.py so the shapes match the API.
Local filesystem paths are reduced to basenames (the files are published).

    .venv/bin/python scripts/export_static_data.py [--points 1000] [--evals 120] [--promotions 150]
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from durak.engine import MAX_PLAYERS, MIN_PLAYERS  # noqa: E402
from server import lab  # noqa: E402
from server.bots_meta import BOT_META, BOT_PREFERENCE, PERSONAS, bot_meta  # noqa: E402

OUT = ROOT / "web" / "public" / "static-data"
PUBLIC_ASSETS = ROOT / "web" / "public" / "assets"


# Filesystem paths, whole or inside text; group 1 is the basename.
_DIRS = r"(?:[^\s\"'/\\,;:]+[/\\])"
_SEG = _DIRS + r"*([^\s\"'/\\,;:]+)"
_PATHS = [
    # absolute with at least one directory, not part of a URL
    re.compile(r"(?<![\w.\-/:\\])(?:[A-Za-z]:\\|/)" + _DIRS + r"+([^\s\"'/\\,;:]+)"),
    re.compile(r"(?<![\w.\-/\\])(?:runs|checkpoints)/" + _SEG),  # repo-relative run files
]


def _scrub(x):
    """Public data must not reveal local paths: every path (whole value or
    embedded in text) is reduced to its basename, recursively."""
    if isinstance(x, str):
        for rx in _PATHS:
            x = rx.sub(lambda m: m.group(1), x)
        return x
    if isinstance(x, list):
        return [_scrub(v) for v in x]
    if isinstance(x, dict):
        return {k: _scrub(v) for k, v in x.items()}
    return x


def _round(x, sig: int = 4):
    """Round non-integral floats to `sig` significant digits (recursively) to
    keep the JSON small; integral values (iterations, steps) stay exact."""
    if isinstance(x, float):
        if not math.isfinite(x):
            return None
        if x == int(x):
            return int(x)
        digits = sig - int(math.floor(math.log10(abs(x)))) - 1
        return round(x, max(0, digits))
    if isinstance(x, list):
        return [_round(v, sig) for v in x]
    if isinstance(x, dict):
        return {k: _round(v, sig) for k, v in x.items()}
    return x


def _thin(rows: list | None, keep: int) -> list | None:
    """Evenly down-sample a list to about `keep` entries, always keeping the last one."""
    if rows is None or len(rows) <= keep:
        return rows
    stride = math.ceil(len(rows) / keep)
    return [r for i, r in enumerate(rows) if i % stride == 0 or i == len(rows) - 1]


def _slim_rates(entry: dict, opps: set[str] | None = None, keys=("rate", "ci")) -> dict:
    """Keep only what the Lab page draws: rate and CI per opponent and N."""
    e = dict(entry)
    rates = {}
    for opp, by_n in (entry.get("rates") or {}).items():
        if opps is not None and opp not in opps:
            continue
        rates[opp] = {n: {k: v[k] for k in keys if k in v} for n, v in by_n.items()}
    e["rates"] = rates
    return e


def _dump(path: Path, data) -> int:
    text = json.dumps(_scrub(data), separators=(",", ":"), ensure_ascii=False)
    home = os.path.expanduser("~")
    for leak in {str(ROOT), home} - {"/", ""}:
        assert leak not in text, f"{path.name} would leak a local path ({leak})"
    path.write_text(text)
    return path.stat().st_size


def art_hires() -> dict:
    """Same answer as /api/art/hires, from web/public/assets."""
    probes = {"cards": "cards/AS", "cards4": "cards4/AS", "backs": "dacha/backs/gzhel"}

    def has(rel: str) -> bool:
        return (PUBLIC_ASSETS / rel).is_file()

    out = {}
    for k, base in probes.items():
        two = has(f"{base}@2x.webp")
        out[k] = [two, two and has(f"{base}@3x.webp")]
    return out


def bots_meta(names: list[str]) -> dict:
    elo = lab.ladder_elo()
    by_n = {}
    for n in range(MIN_PLAYERS, MAX_PLAYERS + 1):
        e = lab.ladder_elo(n)
        if e:
            by_n[str(n)] = {b: round(v) for b, v in e.items()}
    bots = []
    for name in names:
        meta = bot_meta(name)
        bots.append({
            "name": name,
            "label": meta["label"]["en"],
            "labels": meta["label"],
            "desc": meta["desc"],
            "tier": meta["tier"],
            "elo": round(elo[name]) if name in elo else None,
        })
    return {
        "bots": bots,
        "elo_by_n": by_n,
        "preference": list(BOT_PREFERENCE),
        "personas": PERSONAS,
        "credential": lab.credential(),
        "min_players": MIN_PLAYERS,
        "max_players": MAX_PLAYERS,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(OUT))
    ap.add_argument("--run", default="main")
    ap.add_argument("--points", type=int, default=1000, help="training-curve points")
    ap.add_argument("--evals", type=int, default=120, help="evaluation entries")
    ap.add_argument("--promotions", type=int, default=150, help="champion-history entries")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")

    lab.MAX_POINTS = args.points
    data = lab.lab_data(args.run)
    data["training_active"] = False  # a static snapshot
    data["runs"] = [data["run"]]
    evals = _thin(data.get("evals"), args.evals)
    data["evals"] = [_slim_rates(e) for e in evals] if evals is not None else None
    promos = _thin(data.get("promotions"), args.promotions)
    data["promotions"] = (
        [_slim_rates(e, {"random", "heuristic", "solver"}) for e in promos] if promos is not None else None
    )
    data["human"] = []  # filled in the browser from the local game history
    data["exported"] = stamp
    data = _round(data)
    sizes = {"lab.json": _dump(out / "lab.json", data)}

    names = list(BOT_META)
    meta = bots_meta(names)
    meta["exported"] = stamp
    sizes["bots.json"] = _dump(out / "bots.json", meta)

    for name in ("eval_summary.json", "ladder.json"):
        src = lab.RUNS / name
        if src.is_file():
            sizes[name] = _dump(out / name, json.loads(src.read_text()))
    sizes["art-hires.json"] = _dump(out / "art-hires.json", art_hires())

    train = data.get("train") or {}
    print(f"lab: run={data['run']} train rows={train.get('rows')} points={len(next(iter((train.get('series') or {'': []}).values())))}"
          f" evals={len(data.get('evals') or [])} promotions={len(data.get('promotions') or [])}")
    for k, v in sizes.items():
        print(f"  {k:18s} {v / 1024:8.1f} KB")


if __name__ == "__main__":
    main()
