"""Download the CC0 "English pattern" SVG deck by Dmitry Fomin from Wikimedia Commons.

Licence: CC0 1.0 (Public Domain Dedication), verified per file through the
Commons API (extmetadata.LicenseShortName == "CC0").

Downloads are untrusted data: they are written into their own directory,
only ever parsed as SVG text (never executed), and checked against the
SHA-256 hashes pinned in sources.json.

Usage:  python web/tools/art/fetch_cards.py [dest_dir]
        (default dest: $DURAK_ART_SRC or /tmp/durakbot-art-src/fomin)
"""
from __future__ import annotations

import hashlib
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from common import HERE, env_path

UA = "DurakBotArtPipeline/1.0 (asset build script; contact: project maintainer)"
RANKS = {"6": "6", "7": "7", "8": "8", "9": "9", "10": "10", "J": "jack", "Q": "queen", "K": "king", "A": "ace"}
SUITS = {"S": "spades", "C": "clubs", "D": "diamonds", "H": "hearts"}
SOURCES = HERE / "sources.json"


def title(code_rank: str, code_suit: str) -> str:
    return f"English pattern {RANKS[code_rank]} of {SUITS[code_suit]}.svg"


def default_dest() -> Path:
    return env_path("DURAK_ART_SRC", "/tmp/durakbot-art-src/fomin")


def api_lookup(titles: list[str]) -> dict:
    out = {}
    for i in range(0, len(titles), 20):
        q = urllib.parse.urlencode({
            "action": "query", "titles": "|".join("File:" + t for t in titles[i:i + 20]),
            "prop": "imageinfo", "iiprop": "url|extmetadata|sha1", "format": "json",
        })
        req = urllib.request.Request("https://commons.wikimedia.org/w/api.php?" + q, headers={"User-Agent": UA})
        d = json.load(urllib.request.urlopen(req, timeout=30))
        for p in d["query"]["pages"].values():
            ii = p["imageinfo"][0]
            lic = ii["extmetadata"].get("LicenseShortName", {}).get("value")
            out[p["title"][5:]] = {"url": ii["url"].split("?")[0], "license": lic,
                                   "page": "https://commons.wikimedia.org/wiki/" + p["title"].replace(" ", "_")}
    return out


def fetch(dest: Path) -> dict[str, Path]:
    dest.mkdir(parents=True, exist_ok=True)
    pinned = json.loads(SOURCES.read_text()) if SOURCES.exists() else {}
    titles = [title(r, s) for r in RANKS for s in SUITS]
    files = {}
    meta = None
    for t in titles:
        fn = dest / t.replace(" ", "_")
        if not fn.exists() or fn.stat().st_size == 0:
            if meta is None:
                meta = api_lookup(titles)
            info = meta[t]
            if info["license"] != "CC0":
                raise SystemExit(f"Unexpected licence for {t}: {info['license']}")
            for attempt in range(6):
                try:
                    req = urllib.request.Request(info["url"], headers={"User-Agent": UA})
                    fn.write_bytes(urllib.request.urlopen(req, timeout=60).read())
                    break
                except urllib.error.HTTPError as e:  # Commons rate-limits bursts (429 + Retry-After)
                    wait = min(int(e.headers.get("Retry-After") or 0) or 5 * (attempt + 1), 900)
                    print(f"  HTTP {e.code} for {t}, retrying in {wait}s", flush=True)
                    time.sleep(wait)
            else:
                raise SystemExit(f"Could not download {t}; re-run later (Commons rate limit). "
                                 f"Hash-verified copies may also be placed in {dest} by hand.")
            time.sleep(1.5)
        digest = hashlib.sha256(fn.read_bytes()).hexdigest()
        want = pinned.get("files", {}).get(t, {}).get("sha256")
        if want and want != digest:
            raise SystemExit(f"SHA-256 mismatch for {t}: got {digest}, pinned {want}")
        files[t] = fn
    return files


if __name__ == "__main__":
    d = Path(sys.argv[1]) if len(sys.argv) > 1 else default_dest()
    fs = fetch(d)
    print(f"{len(fs)} card SVGs ready in {d}")
