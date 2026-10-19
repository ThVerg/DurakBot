#!/usr/bin/env bash
# Refresh the in-browser champion after a new champion has been promoted:
#   1. snapshot checkpoints/champion.pt (the trainer may replace it at any time),
#   2. export it to web/public/ai/champion.onnx (+ champion.json) and check
#      onnxruntime against torch on thousands of real positions,
#   3. re-dump the model fixture (torch outputs) from the same snapshot,
#   4. run the browser-side parity test (TS encoding -> onnxruntime-web wasm).
# The endgame solver wasm is rebuilt too when durak/_solver.c is newer.
#
#   scripts/refresh_browser_model.sh          # model + model parity
#   scripts/refresh_browser_model.sh --all    # also every other AI parity test
set -euo pipefail
cd "$(dirname "$0")/.."
PY=.venv/bin/python
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cp checkpoints/champion.pt "$TMP/champion.pt"
echo "== export ONNX"
"$PY" scripts/export_onnx.py --ckpt "$TMP/champion.pt" --check "${CHECK:-4000}"
echo "== model fixture"
"$PY" scripts/dump_ai_fixtures.py --ckpt "$TMP/champion.pt" --only model

if [[ ! -f web/public/ai/solver.wasm || durak/_solver.c -nt web/public/ai/solver.wasm ]]; then
  echo "== solver wasm (durak/_solver.c changed)"
  scripts/build_solver_wasm.sh
  "$PY" scripts/dump_ai_fixtures.py --only solver --endgames "${ENDGAMES:-3000}"
fi

echo "== browser parity tests"
cd web
if [[ "${1:-}" == "--all" ]]; then
  npx vitest run tests/local/ai/
else
  npx vitest run tests/local/ai/model.test.ts
fi
echo "OK: web/public/ai/champion.onnx is version $(python3 -c 'import json;print(json.load(open("public/ai/champion.json"))["version"])')"
