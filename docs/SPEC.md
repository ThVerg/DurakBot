# Specification (moved)

This file used to hold the project's combined specification. Its content now lives in focused guides:

| Topic | Now in |
|---|---|
| Rules of Podkidnoy Durak as implemented (2–6 players, neighbours-only throw-in, bout limits, drawing, the stall rule, scoring) | [RULES.md](RULES.md) |
| Card and action encoding, the `DurakGame` API, determinization | [ENGINE.md](ENGINE.md) |
| The agent interface, the registry and the no-cheating rule | [BOTS.md](BOTS.md) |
| The exact endgame solver | [SOLVER.md](SOLVER.md) |
| Components and project layout | [ARCHITECTURE.md](ARCHITECTURE.md) and the [README](../README.md#project-layout) |
| Environment setup and tests | [DEVELOPMENT.md](DEVELOPMENT.md) |

In brief: cards are integers `suit * 9 + rank_index` (suits S, C, D, H; ranks 6 to A), card sets are 36-bit integer masks, and actions are integers in `[0, 37)`, where 0–35 play that card and 36 is `PASS` (bita, take or done, depending on the phase).
