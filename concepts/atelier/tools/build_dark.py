"""Derive table-dark.html from table.html (same markup, dark theme by default)."""
from pathlib import Path
root = Path(__file__).resolve().parent.parent
src = (root / "table.html").read_text()
out = src.replace('<html lang="en" data-theme="light">', '<html lang="en" data-theme="dark">', 1)
out = out.replace("<title>Durak · Table — Atelier</title>", "<title>Durak · Table (Dusk) — Atelier</title>", 1)
(root / "table-dark.html").write_text(out)
print("table-dark.html written")
