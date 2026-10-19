# Development

This guide covers setting up a development environment, running the tests, the scripts and command-line tools, and the conventions the code follows. For contributions, see also [CONTRIBUTING.md](../CONTRIBUTING.md).

## Environment

The project is developed on Ubuntu 24.04 with Python 3.12, `gcc` and Node.js 18 or newer. It does not use a GPU.

### Python

The code runs in place from the repository root; it is not installed as a package. A virtual environment in `.venv/` is assumed by the scripts.

```bash
uv venv .venv --python 3.12
uv pip install --python .venv/bin/python -r requirements.txt \
    --extra-index-url https://download.pytorch.org/whl/cpu --index-strategy unsafe-best-match
# optional: browser e2e tests, ONNX export, art pipeline
uv pip install --python .venv/bin/python -r requirements-dev.txt \
    --extra-index-url https://download.pytorch.org/whl/cpu --index-strategy unsafe-best-match
```

Without uv, `python3.12 -m venv .venv` followed by `.venv/bin/pip install ...` with the same packages works too. The CPU-only PyTorch wheel is much smaller than the default one and is all the project needs.

| Packages | Needed for |
|---|---|
| none (standard library) | the engine, the heuristic and the solver |
| `numpy`, `torch` | the champion and the levels, training, evaluation, the ladder fit |
| `fastapi`, `uvicorn[standard]` | the web server |
| `pytest`, `httpx` | the tests (`httpx` is used by FastAPI's test client) |
| `tensorboard` | optional: training curves in TensorBoard |
| `playwright` (+ `python -m playwright install chromium`) | optional: browser tests, art pipeline |
| `pillow`, `fonttools` | optional: art pipeline |
| `onnx`, `onnxruntime` | optional: exporting the champion for the static build |

`gcc` is used to compile the solver's C core on first use ([SOLVER.md](SOLVER.md#the-native-core)); without it the solver falls back to a much slower pure-Python search.

Run Python modules from the repository root (`.venv/bin/python -m durak.arena ...`). Scripts elsewhere need the root on the path: `PYTHONPATH=$PWD .venv/bin/python my_script.py`.

### Front end

```bash
cd web
npm install          # or: npm ci
npm run dev          # Vite dev server on :5173, proxies /api to :8000
npm run build        # type-check and build into web/dist
npm run typecheck    # type-check only
npm run preview      # serve the built files
npm test             # Vitest suite of the in-browser backend
```

Run the API next to the dev server with `.venv/bin/python -m uvicorn server.app:app --reload --port 8000`. See [WEBAPP.md](WEBAPP.md#running).

## Tests

```bash
.venv/bin/python -m pytest -q                         # everything
.venv/bin/python -m pytest -q --ignore=tests/test_server_e2e.py   # without the browser tests
.venv/bin/python -m pytest -q tests/test_engine.py    # one file
.venv/bin/python -m pytest -q -k determinize          # by name
```

The suite has about 230 tests besides the browser tests and takes a few minutes; a handful of tests (full games with the champion, the gate end to end, brute-force solver comparisons) account for most of the time. Use `--durations=10` to see them. The tests are written to stay light on CPU so that they can run next to a training run.

| File | Covers |
|---|---|
| `tests/test_engine.py` | every rule: dealing, first attacker, throwers, bout limits, priority, bita, takes and throw-ins, drawing order, rotation, going out, draws, the stall rule, known cards, determinization; plus fuzzing with invariant checks |
| `tests/test_agents.py`, `tests/test_levels.py` | legal play over full games for every N, legal-information use, the registry, level descriptions and nucleus sampling |
| `tests/test_solver.py` | the solver against brute force, native against Python, dominance pruning, budgets, the `solver` bot |
| `tests/test_arena.py` | arena accounting, reproducibility, workers, the CLI, and the no-cheating tests |
| `tests/test_ladder.py` | the Luce/Elo fit recovers known ratings, two-player equals Elo, draws, the version filter, writing `ladder.json` |
| `tests/test_rl_encoding.py`, `tests/test_rl_rollout.py`, `tests/test_rl_v2.py` | observation planes, suit invariance, the public tracker, GAE, the rollout worker, the belief head, checkpoint compatibility, PFSP weighting, clustered CIs |
| `tests/test_rl_champion.py`, `tests/test_rl_gate.py` | the champion agent (legality, move time, information use) and the gate's paired statistics and decision rule |
| `tests/test_server.py`, `tests/test_server_coach.py` | the HTTP API and the coach features ([WEBAPP.md](WEBAPP.md#testing)) |
| `tests/test_server_e2e.py` | Playwright browser tests; skipped without Playwright, Chromium or a built front end |

The in-browser backend has its own Vitest suite under `web/tests/` ([STATIC_BUILD.md](STATIC_BUILD.md#testing)).

## Scripts

| Script | Purpose | Options |
|---|---|---|
| [`scripts/serve.sh`](../scripts/serve.sh) | build the front end if it is out of date, then serve the app with Uvicorn | `HOST` (default `0.0.0.0`), `PORT` (8000), `SKIP_BUILD=1`, `UVICORN_ARGS` |
| [`scripts/train.sh`](../scripts/train.sh) | start or resume a detached training run; `--stop` stops it gracefully | `NAME` (`main`), `WORKERS` (7), `LTHREADS` (4); other arguments go to `durak.rl.train` |
| [`scripts/status.sh`](../scripts/status.sh) `[name]` | progress, health metrics, recent evaluations, league and champion of a run | run name (default `main` or `$NAME`) |

The scripts for the static build (`export_static_data.py`, `export_onnx.py`, `build_solver_wasm.sh`, `refresh_browser_model.sh` and the fixture exporters) are described in [STATIC_BUILD.md](STATIC_BUILD.md#building-it).

## Command-line tools

| Command | Purpose | Guide |
|---|---|---|
| `python -m durak.arena A B [-n N] [-g GAMES] [-w WORKERS] [-s SEED]` | agent A against a field of agent B | [EVALUATION.md](EVALUATION.md#the-arena) |
| `python -m durak.ladder [--minutes M] [--ns ...] [--agents ...] [--fit-only]` | rating ladder | [EVALUATION.md](EVALUATION.md#the-rating-ladder) |
| `python -m durak.rl.train [--name NAME] ...` | the trainer (normally started by `train.sh`) | [TRAINING.md](TRAINING.md#running-training) |
| `python -m durak.rl.evaluate ME [--opps ...] [--endgame none\|me\|solve]` | evaluate checkpoints and agents | [EVALUATION.md](EVALUATION.md#durakrlevaluate) |
| `python -m durak.rl.gate CKPT --run-dir DIR [--summary-only]` | gate a checkpoint, or refresh the champion's summary | [EVALUATION.md](EVALUATION.md#the-gate) |
| `python -m durak.rl.tournament --ref REF --cands ... --out FILE` | rank checkpoints on identical deals | [EVALUATION.md](EVALUATION.md#the-tournament) |
| `python web/tools/art/build_all.py [--scales ...] [--manifest-only]` | rebuild the base art set | [ART.md](ART.md#rebuilding-the-base-set) |

Every command accepts `--help`.

## Environment variables

| Variable | Used by | Effect |
|---|---|---|
| `DURAK_SOLVER_NATIVE=0` | solver | disable the C core |
| `DURAK_CACHE` | solver | cache directory for the compiled core (default `~/.cache/durakbot`) |
| `DURAK_SOLVER_TT_LOG2` | solver | transposition table size, 2^k entries (default 21) |
| `DURAK_DB` | server | SQLite database (default `server/data/games.db`) |
| `DURAK_DIST` | server | built front end (default `web/dist`) |
| `DURAK_RUNS`, `DURAK_CHECKPOINTS` | server (Lab) | where to read training and champion files |
| `DURAK_LAB_WARM` | server | `0` disables parsing the training log at start-up |
| `DURAK_E2E_DIST` | browser tests | test another build directory |
| `DURAK_ART_SRC` | art pipeline | download directory for the source card SVGs |
| `VITE_BACKEND=local`, `VITE_BASE` | front-end build | the static build and its public path ([STATIC_BUILD.md](STATIC_BUILD.md)) |

## Conventions

**Python**

- Python 3.12, `from __future__ import annotations`, type hints on public functions, and a module docstring that explains what the module is for and how to use it. Lines stay within about 120 characters.
- Cards are integers and card sets are integer bitmasks ([ENGINE.md](ENGINE.md#cards)); use the helpers in `durak.cards`.
- `durak/engine.py` is the only place that decides rules. Code that re-implements part of the rules for speed (the solver, the RL tracker, the TypeScript port) must have a test that compares it with the engine.
- Agents must use only the information their seat is entitled to, and must be tested for it ([BOTS.md](BOTS.md#no-cheating-guarantees)).
- Everything random takes a seed, so results can be reproduced and compared on identical deals.
- Files that other processes read while they are being written (checkpoints, JSON summaries) are written to a temporary file and moved into place atomically.
- Command-line tools use `argparse`, print plain text and write machine-readable results as JSON or JSON Lines.

**TypeScript and CSS**

- TypeScript in strict mode with no unused locals or parameters; React function components and hooks.
- Colours, shadows and fonts come from the design tokens in `web/src/dacha/ds.css`; see [WEBAPP.md](WEBAPP.md#design-system).
- Every user-visible string goes through `t()` with an entry in both the English and the Russian dictionary in `web/src/i18n.tsx`.
- Interactive elements need an accessible name, and animations must respect `prefers-reduced-motion`.

**Shared machines**

Training uses most of a CPU for days. Keep tests, evaluations and ladder runs light while it runs: use few `--workers`, prefer `nice`, and remember that every evaluation process loads its own copy of the network.

## Repository hygiene

`.venv/`, `runs/`, `server/data/`, `web/node_modules/`, `web/dist/` and everything in `checkpoints/` except `champion.pt` are ignored by Git. Commit a new `checkpoints/champion.pt` only when it should become the default opponent for everyone who clones the repository.
