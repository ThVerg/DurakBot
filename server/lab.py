"""Lab dashboard data: training curves, evaluations, champion promotions,
eval summary and bot ladder, read from runs/ and checkpoints/ with an
mtime-based cache. Every source is optional."""

from __future__ import annotations

import csv
import json
import math
import os
import threading
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parent.parent
RUNS = Path(os.environ.get("DURAK_RUNS", ROOT / "runs"))
CKPT = Path(os.environ.get("DURAK_CHECKPOINTS", ROOT / "checkpoints"))

TRAIN_COLS = [
    "iter", "steps", "games", "hours", "sps", "lr", "entropy", "kl", "clipfrac", "explained_var",
    "pg_loss", "v_loss", "d_loss", "stale", "solved_frac", "bel_loss", "bel_gain", "bel_acc", "draw_frac",
]
MAX_POINTS = 600

_cache: dict[str, tuple[tuple, Any]] = {}
_lock = threading.Lock()


def _cached(path: Path, parse: Callable[[Path], Any]) -> Any:
    """Parse ``path`` once per (mtime, size); None if it doesn't exist."""
    try:
        st = path.stat()
    except OSError:
        return None
    key = (st.st_mtime_ns, st.st_size)
    with _lock:
        hit = _cache.get(str(path))
        if hit and hit[0] == key:
            return hit[1]
    try:
        val = parse(path)
    except Exception as e:  # half-written file etc.
        val = {"error": f"{type(e).__name__}: {e}"}
    with _lock:
        _cache[str(path)] = (key, val)
    return val


def _num(x: Any) -> float | None:
    if x is None or x == "":
        return None
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def _parse_train(path: Path) -> dict:
    with open(path, newline="") as f:
        rows = list(csv.DictReader(f))
    total = len(rows)
    if total > MAX_POINTS:
        stride = math.ceil(total / MAX_POINTS)
        rows = rows[::stride] + ([rows[-1]] if (total - 1) % stride else [])
    cols = rows[0].keys() if rows else []
    durak_cols = sorted(c for c in cols if c.startswith("durak_"))
    keep = [c for c in TRAIN_COLS if c in cols] + durak_cols
    series = {c: [_num(r.get(c)) for r in rows] for c in keep}
    return {"rows": total, "columns": keep, "series": series}


def _parse_jsonl(path: Path) -> list[dict]:
    out = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue  # partially written last line
    return out


def _parse_json(path: Path) -> Any:
    with open(path) as f:
        return json.load(f)


def _slim_eval(e: dict) -> dict:
    """Keep iteration info and the per-opponent, per-N durak rates + CIs."""
    out: dict[str, Any] = {
        k: e.get(k) for k in ("iter", "steps", "time", "promoted", "rejected", "ckpt", "suite_version") if k in e
    }
    rates: dict[str, dict[str, Any]] = {}
    for k, v in e.items():
        # e.g. heuristic_3p_durak / heuristic_3p_ci
        parts = k.split("_")
        if len(parts) >= 3 and parts[-2].endswith("p") and parts[-2][:-1].isdigit() and parts[-1] in ("durak", "ci", "games"):
            opp = "_".join(parts[:-2])
            n = parts[-2][:-1]
            key = {"durak": "rate", "ci": "ci", "games": "games"}[parts[-1]]
            rates.setdefault(opp, {}).setdefault(n, {})[key] = v
    out["rates"] = rates
    if "ckpt" in out and isinstance(out["ckpt"], str):
        out["ckpt"] = os.path.basename(out["ckpt"])
    return out


def _normalize_ladder(raw: Any) -> dict | None:
    """Accept a few plausible shapes and return {updated, by_n: {N: [rows]}}."""
    if raw is None or (isinstance(raw, dict) and "error" in raw and len(raw) == 1):
        return raw
    updated = raw.get("updated") if isinstance(raw, dict) else None

    def row(bot: str, v: Any) -> dict | None:
        if isinstance(v, (int, float)):
            return {"bot": bot, "elo": float(v)}
        if isinstance(v, dict):
            elo = next((v[k] for k in ("elo", "rating", "mu", "score") if isinstance(v.get(k), (int, float))), None)
            if elo is None:
                return None
            r = {"bot": bot, "elo": float(elo)}
            for k in ("games", "ci", "sd", "durak_rate", "rank"):
                if k in v:
                    r[k] = v[k]
            return r
        return None

    def as_n(k: Any) -> str | None:
        s = str(k).lower().rstrip("p")
        return s if s.isdigit() and 2 <= int(s) <= 6 else None

    def from_mapping(m: dict) -> dict:
        by_n = {}
        for k, v in m.items():
            n = as_n(k)
            if n is None:
                continue
            rows = []
            if isinstance(v, dict):
                rows = [r for b, x in v.items() if (r := row(b, x))]
            elif isinstance(v, list):
                rows = [r for x in v if isinstance(x, dict) and (r := row(str(x.get("bot") or x.get("name")), x))]
            if rows:
                by_n[n] = sorted(rows, key=lambda r: -r["elo"])
        return by_n

    by_n: dict = {}
    if isinstance(raw, dict):
        for key in ("ratings", "by_n", "elo", "ladder", "results"):
            if isinstance(raw.get(key), dict):
                by_n = from_mapping(raw[key])
                if by_n:
                    break
        if not by_n:
            by_n = from_mapping(raw)
        if not by_n and isinstance(raw.get("ratings"), list):
            raw = raw["ratings"]
    if not by_n and isinstance(raw, list):
        for x in raw:
            if isinstance(x, dict):
                n = as_n(x.get("n") or x.get("num_players") or x.get("N"))
                r = row(str(x.get("bot") or x.get("name")), x)
                if n and r:
                    by_n.setdefault(n, []).append(r)
        for n in by_n:
            by_n[n].sort(key=lambda r: -r["elo"])
    return {"updated": updated, "by_n": by_n, "raw": raw if not by_n else None}


def list_runs() -> list[str]:
    if not RUNS.is_dir():
        return []
    return sorted(p.name for p in RUNS.iterdir() if (p / "train.csv").is_file())


def lab_data(run: str = "main") -> dict:
    runs = list_runs()
    if run not in runs and runs:
        run = "main" if "main" in runs else runs[0]
    rdir = RUNS / run
    train = _cached(rdir / "train.csv", _parse_train)
    evals = _cached(rdir / "eval.jsonl", _parse_jsonl)
    history = _cached(CKPT / "champion_history.jsonl", _parse_jsonl)
    current = _cached(CKPT / "champion.json", _parse_json)
    summary = _cached(RUNS / "eval_summary.json", _parse_json)
    ladder = _cached(RUNS / "ladder.json", _parse_json)
    pid_running = False
    try:
        pid = int((rdir / "train.pid").read_text().strip())
        os.kill(pid, 0)
        pid_running = True
    except Exception:
        pass
    return {
        "run": run,
        "runs": runs,
        "training_active": pid_running,
        "train": train,
        "evals": [_slim_eval(e) for e in evals] if isinstance(evals, list) else None,
        "promotions": [_slim_eval(e) for e in history] if isinstance(history, list) else None,
        "champion": _slim_eval(current) if isinstance(current, dict) and "error" not in current else None,
        "eval_summary": summary,
        "ladder": _normalize_ladder(ladder) if ladder is not None else None,
    }


def ladder_elo(n: int | None = None) -> dict[str, float]:
    """Best-effort {bot: elo} (for N, else averaged over N) for the bot picker."""
    lad = _cached(RUNS / "ladder.json", _parse_json)
    norm = _normalize_ladder(lad) if lad is not None else None
    if not norm or not norm.get("by_n"):
        return {}
    by_n = norm["by_n"]
    if n is not None and str(n) in by_n:
        return {r["bot"]: r["elo"] for r in by_n[str(n)]}
    acc: dict[str, list[float]] = {}
    for rows in by_n.values():
        for r in rows:
            acc.setdefault(r["bot"], []).append(r["elo"])
    return {b: sum(v) / len(v) for b, v in acc.items()}
