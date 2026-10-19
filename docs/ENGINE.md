# The rules engine

The engine is the small, dependency-free core of the `durak` package: it implements the rules in [RULES.md](RULES.md) for 2–6 players, using only the Python standard library. Everything else in the project (bots, solver, arena, training, server) is built on it.

| Module | Contents |
|---|---|
| [`durak/cards.py`](../durak/cards.py) | Card numbering, bitmask helpers, the beating relation |
| [`durak/engine.py`](../durak/engine.py) | `DurakGame`, `Config`, phase and action constants |
| [`durak/testing.py`](../durak/testing.py) | `make_position` to build arbitrary positions, `check_invariants` |

The public API of `durak/engine.py` is deliberately stable: the solver's C core, the RL encoder and the TypeScript port in `web/src/local/` all mirror it, so changes to the rules or to the meaning of a field must be made everywhere at once.

## Cards

A card is an integer in `[0, 36)`:

```text
card = suit * 9 + rank_index
suit:       0 = ♠ spades (S), 1 = ♣ clubs (C), 2 = ♦ diamonds (D), 3 = ♥ hearts (H)
rank_index: 0..8 = 6, 7, 8, 9, 10, J, Q, K, A
```

| Card | 6♠ | A♠ | 6♣ | 7♦ | 10♥ | A♥ |
|---|---|---|---|---|---|---|
| Integer | 0 | 8 | 9 | 19 | 31 | 35 |
| Text (`card_str`) | `6S` | `AS` | `6C` | `7D` | `10H` | `AH` |

**Card sets are 36-bit integer bitmasks**: bit `c` is set when card `c` is in the set. Hands, the discard and the "known" sets are all masks, so set operations are single integer operations, and copying a hand costs nothing.

Helpers in `durak.cards`:

| Name | Meaning |
|---|---|
| `NUM_CARDS = 36`, `NUM_RANKS = 9`, `NUM_SUITS = 4`, `FULL_MASK` | constants |
| `SUITS = "SCDH"`, `SUIT_SYMBOLS = "♠♣♦♥"`, `RANKS = ["6", ..., "A"]` | names |
| `suit_of(c)`, `rank_of(c)`, `make_card(suit, rank_idx)` | decompose and compose |
| `card_str(c)`, `parse_card("10H")` | text form, case-insensitive parsing |
| `mask_to_list(m)`, `list_to_mask(cards)`, `popcount(m)` | conversions (lists are ascending) |
| `RANK_MASKS[r]`, `SUIT_MASKS[s]` | all cards of one rank or one suit |
| `beats(defence, attack, trump)` | does `defence` beat `attack`? |
| `beaters_mask(attack, trump)` | mask of every card that beats `attack` |

```python
>>> from durak.cards import beaters_mask, mask_to_list, card_str, parse_card, SUITS
>>> [card_str(c) for c in mask_to_list(beaters_mask(parse_card("QD"), SUITS.index("H")))]
['KD', 'AD', '6H', '7H', '8H', '9H', '10H', 'JH', 'QH', 'KH', 'AH']
```

## Actions and phases

An action is an integer in `[0, 37)`: `0..35` plays that card and **`36 = PASS`** (`durak.PASS`). `NUM_ACTIONS = 37`. What a card or a pass means depends on the phase:

| Phase | Constant | Player to move | Card action | `PASS` means |
|---|---|---|---|---|
| attack | `ATTACK = 0` | a thrower, in priority order | lead (empty table) or add a card of a rank on the table | nothing to add; once every thrower has passed in a row, bita. Not legal on an empty table |
| defend | `DEFEND = 1` | the defender | beat the single uncovered card | take |
| throw-in | `THROW_IN = 2` | a thrower, in priority order | throw in a card of a rank on the table | done; after the last thrower, the defender picks up |

`durak.engine.PHASE_NAMES = ["attack", "defend", "throw_in"]` gives the names, and `action_str(a)` gives `"PASS"` or the card text.

## Configuration

```python
@dataclass(frozen=True)
class Config:
    hand_size: int = 6          # cards dealt and refilled to
    max_bout_cards: int = 6     # attack cards per bout
    first_bout_limit: int = 5   # ... in the first bout of the game only
    stall_bouts: int = 30       # consecutive takes (talon empty, 3+ players) before a draw
```

`DEFAULT_CONFIG = Config()` is used everywhere in the project; the bots, the solver and the trained networks assume these values.

## `DurakGame`

```python
DurakGame(seed: int | None = None, num_players: int = 2, config: Config = DEFAULT_CONFIG, deal: bool = True)
```

The constructor shuffles with `random.Random(seed)`, deals and sets up the first bout. The same seed and player count always give the same deal. `deal=False` creates an empty shell; [`durak.testing.make_position`](#building-positions-for-tests) uses it.

### State

| Field | Type | Meaning |
|---|---|---|
| `num_players`, `config` | `int`, `Config` | |
| `hands[p]` | mask | cards held by seat `p` (hidden information for other seats) |
| `known[p]` | mask | cards in `p`'s hand that every player knows about ([public information](RULES.md#public-information)) |
| `talon` | `list[int]` | the stock, drawn from the **end**; `talon[0]` is the face-up trump card while the talon is not empty |
| `trump_card`, `trump` | `int` | the trump card and the trump suit |
| `discard` | mask | cards removed by bita |
| `attack_cards`, `defense_cards` | `list[int]` | the table; `defense_cards[i]` beats `attack_cards[i]` |
| `attacker`, `defender` | `int` | the main attacker and the defender of the current bout |
| `throwers`, `thrower_idx` | `list[int]`, `int` | players allowed to add cards, in priority order, and whose turn it is among them |
| `phase` | `int` | `ATTACK`, `DEFEND` or `THROW_IN` |
| `bout_limit` | `int` | maximum attack cards in this bout |
| `first_bout` | `bool` | true until the first bout ends |
| `bout_index` | `int` | number of finished bouts |
| `stall` | `int` | consecutive takes counted by the stall rule |
| `done`, `loser` | `bool`, `int \| None` | game over; the durak's seat, or `None` while running and on a draw |
| `finished` | `list[int]` | seats in the order they went out |
| `log` | `list[tuple[int, int]]` | every `(player, action)` so far |

Derived properties: `current_player`, `active_players` (seats still in the game), `table_mask`, and `winner`, which is the non-durak seat in a finished two-player game and `None` otherwise.

### Methods

| Method | Description |
|---|---|
| `legal_actions() -> list[int]` | legal actions of `current_player`, ascending (`PASS` last) |
| `legal_mask_int() -> int` | the same as a 37-bit mask (bit 36 = `PASS`) |
| `is_legal(action) -> bool` | |
| `step(action)` | apply an action of `current_player`; raises `ValueError` if it is illegal |
| `returns() -> tuple[float, ...]` | zero-sum result per seat: −1 for the durak, +1/(N−1) for the others, all zeros on a draw or while running |
| `clone() -> DurakGame` | independent copy; cheap, for search |
| `unseen_mask(player) -> int` | cards whose location `player` cannot know: opponents' unknown cards plus the hidden part of the talon |
| `determinize(player, rng) -> DurakGame` | a copy in which every card hidden from `player` is redealt uniformly at random, consistently with what `player` knows |
| `info_state(player) -> dict` | everything `player` may see, as plain data |
| `is_active(p) -> bool` | `p` has not gone out |

### Determinization

`determinize(player, rng)` returns a clone of the game in which `player`'s own hand, the table, the discard, every publicly known card and all hand sizes are unchanged, while the remaining unseen cards are shuffled and dealt back into the opponents' unknown slots and the talon below the face-up trump card. The result is a complete, playable game that is indistinguishable from the real one from `player`'s point of view.

This is the backbone of the project's fairness guarantee. The arena and the server never give a bot the real game: they give it `game.determinize(player, rng)`. Whatever a bot reads from that object, it cannot learn more than its seat is entitled to (see [BOTS.md](BOTS.md#no-cheating-guarantees)).

When the talon is empty and two players remain, or with two players and only the face-up trump card left, nothing is hidden and the determinization equals the real game. The solver relies on this.

### `info_state`

`info_state(player)` returns a dictionary with the keys `player`, `num_players`, `hand`, `hand_sizes`, `known` (per seat; empty for `player` itself), `attack_cards`, `defense_cards`, `discard`, `trump_card`, `trump`, `talon_size`, `attacker`, `defender`, `throwers`, `phase`, `bout_limit`, `first_bout`, `finished`, `to_move`, `legal` (only when `player` is to move), `done` and `loser`. Card collections are lists of card integers.

## Example

```python
import random
from durak import DurakGame, PASS, action_str, parse_card

g = DurakGame(seed=123, num_players=3)
print(g)
# <Durak n=3 trump=10S talon=18 att=P2 def=P0 phase=attack limit=5
#   P0: AS QC KC 6D 7D 9H
#   P1: 6C 8C 10C JC 8D KD
#   P2: 6S 8S QS KS 9D JD
#   table:   done=False loser=None>

g.current_player, g.throwers, g.bout_limit      # (2, [2, 1], 5): seat 2 has the lowest trump, 6♠
[action_str(a) for a in g.legal_actions()]       # ['6S', '8S', 'QS', 'KS', '9D', 'JD']

g.step(parse_card("6S"))                        # seat 2 leads 6♠ against seat 0
g.phase, g.current_player                        # (1, 0): DEFEND, seat 0 to move
[action_str(a) for a in g.legal_actions()]       # ['AS', 'PASS']: only the trump ace beats 6♠

try:
    g.step(parse_card("7D"))
except ValueError as e:
    print(e)                                     # illegal action 19 in phase defend

view = g.determinize(0, random.Random(0))        # what seat 0 might believe
view.hands[0] == g.hands[0]                      # True: own hand unchanged
view.hands[1] == g.hands[1]                      # False (in general): hidden cards resampled

rng = random.Random(1)
while not g.done:                                # play the rest at random
    g.step(rng.choice(g.legal_actions()))
g.loser, g.finished, g.returns()                 # e.g. (0, [1, 2], (-1.0, 0.5, 0.5))
```

Run Python from the repository root (or put the repository on `PYTHONPATH`); the project is used in place and is not installed as a package.

## Building positions for tests

`durak.testing.make_position` builds a game at the start of a bout from a compact description, which is how the engine, solver and bot tests construct specific situations:

```python
from durak import parse_card as c
from durak.testing import make_position, check_invariants

# Three players, talon empty, hearts are trump; seat 0 attacks seat 1.
g = make_position(3, hands=["7S 7C", "9S", "AD KD"], trump="H", attacker=0)
g.bout_limit                      # 1: the defender holds one card
g.step(c("7S")); g.step(c("9S"))
g.legal_actions()                 # [36]: 7♣ matches, but the limit is reached
check_invariants(g)               # no card lost or duplicated, phases consistent
```

Arguments: `hands` (one card string, list or mask per seat), `talon` (listed in engine order, `talon[0]` being the face-up trump card), `trump` or `trump_card`, `attacker`, `finished`, `first_bout`, `discard` (by default every unused card), `known`, `bout_index` and `config`. `check_invariants(g)` asserts that the 36 cards are each in exactly one place, that known cards are in their owner's hand, that the phase matches the table, and more; the fuzz tests call it after every step.

## Performance

A game between random players takes about 110 actions with two players and about 200 with three to six; games between good players are shorter. On one core the engine plays random games at roughly 2 × 10⁵ actions per second, and cloning is a handful of list copies. The hot paths of the project (the solver and the RL encoder) work directly on masks rather than on `DurakGame` objects.

## Other implementations of the rules

- The exact solver re-implements the two-player endgame rules on raw masks, in Python (`durak/solver.py`) and in C (`durak/_solver.c`). Its tests compare it against brute-force search through the real engine. See [SOLVER.md](SOLVER.md).
- The RL encoder's `PublicTracker` replays the public action log with card counts only; a test checks it against the engine at every step. See [TRAINING.md](TRAINING.md).
- A TypeScript port for the in-browser build lives in `web/src/local/` and is replay-tested against traces exported from this engine. See [STATIC_BUILD.md](STATIC_BUILD.md).
