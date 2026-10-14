# DurakBot — Spec & Architecture

Goal: a superhuman bot for **Podkidnoy Durak, 2–6 players (36 cards)** — one model for all player counts, with emphasis on 2 and 4–5 players, trained with
RL on this server (CPU only: i5-12600K, 16 threads, 31 GB RAM, no GPU), plus a
website for a human to play against it.

## Rules (authoritative — implemented in `durak/engine.py`)

- **2–6 players** (`DurakGame(seed, num_players=N)`), 36 cards (ranks 6..A, 4 suits), 6 cards each.
  Seats are 0..N-1; play goes clockwise = increasing seat index.
- The bottom card of the talon is face-up and sets **trump**; it is drawn last. With 6 players
  the talon is empty after dealing: the last dealt card (in seat 5's hand) sets trump and is
  publicly known (`known[5]`).
- First attacker: the holder of the lowest trump; random if nobody holds one.
- Each bout, the attacker attacks the next active player clockwise (the defender).
  **Throwers** = the main attacker plus the defender's *other* neighbour (the next active
  player after the defender), if that's a different player. Only throwers may add cards
  (neighbours-only rule). With 2 active players the only thrower is the attacker.
- **Bout limit**: attack cards per bout ≤ `min(6, defender's hand size at bout start)`.
  In the **first bout of the game only**, 5 replaces 6.
- Sequential play (one card per action):
  - ATTACK phase: on an empty table the main attacker must lead any card. Once the table is
    non-empty and fully covered, throwers are asked in priority order (main attacker first):
    each either adds a card whose rank is on the table (if under the limit) or PASSes.
    Adding a card → DEFEND. If **all** throwers pass in a row → "bita": the table is discarded.
  - DEFEND phase: the defender beats the single uncovered card (higher card of the same suit,
    or a trump vs a non-trump; trump vs trump by rank), or PASSes (= take). After a beat,
    priority restarts from the main attacker.
  - THROW_IN phase (after a take): each thrower in order may add any number of cards matching
    table ranks (under the limit), then PASS (= done). After the last thrower passes, the
    defender picks up all table cards. Picked-up cards become **publicly known** (`game.known`).
- Drawing after a bout: main attacker first, then the other players clockwise, defender last,
  each up to 6, while the talon lasts.
- Next attacker: after a successful defence, the defender. After a take, the next active player
  after the defender (the defender's turn is skipped).
- Once the talon is empty, players with no cards at the end of a bout are **out**
  (`game.finished`, in order). The game ends when ≤1 player has cards. That player is the
  **durak** (`game.loser`). If the last players all run out together, it's a draw
  (`loser is None`).
- **Stall rule**: once the talon is empty and 3+ players remain, 30 consecutive bouts ending in
  a take (no bita) end the game as a draw (`Config.stall_bouts`, `game.stall`). With 2 players
  this can't happen, because every take shrinks the attacker's hand.
- Payoff (`game.returns()`, zero-sum): durak −1, everyone else +1/(N−1); a draw is all zeros.
  With 2 players this is ±1.

## Encoding

- Card `c ∈ [0,36)`: `c = suit*9 + rank_idx`, suits `S C D H`, rank_idx 0..8 = 6..A.
  Helpers live in `durak/cards.py`. Card sets are 36-bit int bitmasks.
- Actions `∈ [0,37)`: 0..35 = play card `c`; **36 = PASS** (bita / take / done
  depending on phase).

## Engine API (`durak/engine.py`, frozen; ask the lead before changing)

```python
g = DurakGame(seed=123, num_players=4)   # deals immediately
g.num_players, g.current_player, g.phase, g.attacker, g.defender, g.throwers, g.thrower_idx
g.legal_actions() -> list[int];  g.legal_mask_int() -> int (37-bit)
g.step(action)                   # raises ValueError on illegal moves
g.done, g.loser (seat or None = draw), g.finished (order out), g.returns() -> tuple of N floats
g.winner                         # 2-player convenience only
g.hands[p] (bitmask), g.known[p] (publicly known cards in p's hand), g.discard,
g.attack_cards / g.defense_cards (lists; defense[i] beats attack[i]),
g.talon (list, drawn from the end, talon[0] == trump_card), g.trump, g.trump_card,
g.bout_limit, g.first_bout, g.log [(player, action)], g.bout_index,
g.active_players, g.is_active(p)
g.clone(); g.determinize(player, rng); g.unseen_mask(player); g.info_state(player)
```

When the talon is empty and exactly 2 players remain, the position is **perfect
information**: `determinize` reproduces the true hands, so exact search applies. This holds
at the end of *every* game, multiplayer included.

Speed: about 300k random steps/s (2p) in one Python process.

## Agents (`durak/agents/`)

`Agent.act(game, player) -> action` and `Agent.reset()`. Registry:
`get_agent(name, **kw)`, `available_agents()`, `register(name, factory)`.
Agents **must not cheat**: the arena passes them `game.determinize(player, rng)`.

Planned agents:
| name | module | owner |
|---|---|---|
| `random` | `durak/agents/__init__.py` | done |
| `heuristic` | `durak/agents/heuristic.py`: strong rule-based baseline | bots agent |
| `solver` | `durak/agents/solver_agent.py`: heuristic + exact endgame solver once the talon is empty and 2 players remain | bots agent |
| `champion` | `durak/agents/champion.py`: trained RL policy (any N) + endgame solver (+ optional search) | RL agent |

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
