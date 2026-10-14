# DurakBot — Spec & Architecture

Goal: a superhuman bot for **2-player Podkidnoy Durak (36 cards)**, trained with
RL on this server (CPU only: i5-12600K, 16 threads, 31 GB RAM, no GPU), plus a
website for a human to play against it.

## Rules (authoritative — implemented in `durak/engine.py`)

- 36 cards: ranks 6..A in 4 suits. 2 players, 6 cards each.
- After dealing, the bottom card of the talon is face-up; its suit is **trump**.
  It is drawn last.
- First attacker: the player holding the lowest trump; random if neither holds a trump.
- **Bout limit**: the number of attack cards in a bout is at most
  `min(6, defender's hand size at bout start)`. The **first bout of the game
  only** uses 5 instead of 6.
- Play is **sequential** (one card at a time):
  - ATTACK phase (attacker to move): on an empty table, the attacker must lead
    any card. Otherwise they may add a card whose rank is already on the table
    (if under the limit), or PASS (= "bita", all cards are beaten → discard).
  - DEFEND phase (defender to move): beat the single uncovered card (higher
    card of the same suit, or any trump vs a non-trump; a trump only beats a lower
    trump), or PASS (= "take").
  - THROW_IN phase (after "take"): the attacker may add more cards matching
    table ranks (still under the limit), then PASS (= "done"). The defender
    picks up every table card. Those cards become **publicly known** (`game.known`).
- After a bout, the attacker draws up to 6 first, then the defender.
- After a successful defence, the defender attacks next. After a take, the same
  attacker attacks again.
- The game ends after a bout when the talon is empty and at least one player has
  no cards. The player with no cards wins; if both are empty, it's a draw. The
  player left holding cards is the *durak* (loser).

## Encoding

- Card `c ∈ [0,36)`: `c = suit*9 + rank_idx`, suits `S C D H`, rank_idx 0..8 = 6..A.
  Helpers live in `durak/cards.py`. Card sets are 36-bit int bitmasks.
- Actions `∈ [0,37)`: 0..35 = play card `c`; **36 = PASS** (bita / take / done
  depending on phase).

## Engine API (`durak/engine.py`, frozen; ask before changing)

```python
g = DurakGame(seed=123)          # deals immediately
g.current_player, g.phase, g.attacker, g.defender
g.legal_actions() -> list[int];  g.legal_mask_int() -> int (37-bit)
g.step(action)                   # raises ValueError on illegal moves
g.done, g.winner (0/1, or None for draw), g.returns() -> (r0, r1)
g.hands[p] (bitmask), g.known[p] (publicly known cards in p's hand), g.discard,
g.attack_cards / g.defense_cards (lists; defense[i] beats attack[i]),
g.talon (list, drawn from the end, talon[0] == trump_card), g.trump, g.trump_card,
g.bout_limit, g.first_bout, g.log [(player, action)], g.bout_index
g.clone(); g.determinize(player, rng); g.unseen_mask(player); g.info_state(player)
```

Speed: about 300k random steps/s in a single Python process.

## Agents (`durak/agents/`)

`Agent.act(game, player) -> action` and `Agent.reset()`. Registry:
`get_agent(name, **kw)`, `available_agents()`, `register(name, factory)`.
Agents **must not cheat**: the arena passes them `game.determinize(player, rng)`.

Planned agents:
| name | module | owner |
|---|---|---|
| `random` | `durak/agents/__init__.py` | done |
| `heuristic` | `durak/agents/heuristic.py`: strong rule-based baseline | bots agent |
| `solver` | `durak/agents/solver_agent.py`: heuristic + exact endgame solver once the talon is empty | bots agent |
| `champion` | `durak/agents/champion.py`: trained RL policy + endgame solver (+ optional search) | RL agent |

## Layout / ownership

- `durak/cards.py`, `durak/engine.py`: core (lead).
- `durak/agents/heuristic.py`, `durak/solver.py`, `durak/agents/solver_agent.py`,
  `durak/arena.py`, `tests/`: bots + QA agent.
- `durak/rl/`, `durak/agents/champion.py`, `checkpoints/`, `runs/`: RL agent.
- `server/` (FastAPI), `web/` (Vite + React + TS, built to `web/dist`, served
  by FastAPI): web agent.

Python env: `.venv` (use `.venv/bin/python`, install with
`uv pip install --python .venv/bin/python ...`). Torch is installed CPU-only.
Run tests with `.venv/bin/python -m pytest`.
