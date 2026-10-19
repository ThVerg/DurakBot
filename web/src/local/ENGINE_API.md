# Local engine API (`web/src/local/`)

TypeScript port of `durak/cards.py` + `durak/engine.py`, replay-tested for exact
parity against Python traces (`web/test-fixtures/engine/`). Same rules, card ids,
actions, phases and state fields; Python `snake_case` becomes `camelCase`.

## Cards and masks: `cards.ts`

- Card `c = suit*9 + rankIdx` (suits `S C D H`, rankIdx 0..8 = 6..A). `PASS = 36`,
  `NUM_ACTIONS = 37`, `NUM_CARDS = 36`.
- **A card set (`CardSet`) is a plain `number` holding the 36-bit integer**, exactly the
  Python int (float64 is exact below 2^53). Masks compare with `===`, go through JSON and
  `postMessage` unchanged. A legal-action mask is the same thing with bit 36 = PASS.
- **Never use JS bitwise operators (`| & ^ ~ << >>`) on a mask directly**: they truncate
  to 32 bits. Use the helpers:

| helper | meaning |
|---|---|
| `BIT[c]` | `2^c` (c in 0..37) |
| `has(m, c)` | bit c set |
| `add(m, c)` / `remove(m, c)` | set/clear one bit (idempotent) |
| `or(a,b)`, `and(a,b)`, `andNot(a,b)` (= `a & ~b`), `xor(a,b)`, `complement(m)` | set ops |
| `intersects(a,b)`, `isSubset(sub, sup)` | tests |
| `popcount(m)`, `lowest(m)`, `highest(m)` | `-1` when empty |
| `maskToList(m)` (= `cardsOf`) | ascending card list |
| `forEachCard(m, fn)` | iterate ascending without allocating |
| `listToMask(cards)` | inverse |
| `lo(m)`, `hi(m)`, `fromWords(lo, hi)` | 32-bit words (cards 0..31 / 32..36) for hot loops |
| `suitOf`, `rankOf`, `makeCard`, `cardStr`, `parseCard`, `actionStr`, `beats(d, a, trump)`, `beatersMask(a, trump)` | as in Python |
| `RANK_MASKS[r]`, `SUIT_MASKS[s]`, `FULL_MASK` | constants |

Fast path for disjoint sets: `a + b` is a valid union and `a - b` a valid difference when
`b` is a subset of `a` (pure integer arithmetic, exact).

## RNG: `rng.ts`

`new Rng(seed?)` (sfc32, seedable, cloneable): `random()`, `randrange(n)`, `randint(a, b)`,
`choice(arr)`, `shuffle(arr)` (Fisher-Yates, in place), `getState()/setState()`, `clone()`.
Not bit-compatible with Python's `random`.

## Game: `engine.ts`

```ts
import { DurakGame, ATTACK, DEFEND, THROW_IN, PHASE_NAMES, PASS, DEFAULT_CONFIG } from "./engine";

const g = new DurakGame(seed /* number | Rng | null */, numPlayers /* 2..6 */);  // deals
const h = DurakGame.fromDeck(deck36, numPlayers, fallbackAttacker = 0);   // injected deal
```

| Python | TypeScript |
|---|---|
| `num_players`, `config` | `numPlayers`, `config` (`{handSize, maxBoutCards, firstBoutLimit, stallBouts}`) |
| `hands[p]`, `known[p]`, `discard` | same names, `CardSet` numbers |
| `talon` (list, drawn from the end, `talon[0] == trump_card`) | `talon: number[]` |
| `trump`, `trump_card` | `trump`, `trumpCard` |
| `attack_cards`, `defense_cards` | `attackCards`, `defenseCards` |
| `attacker`, `defender`, `throwers`, `thrower_idx` | `attacker`, `defender`, `throwers`, `throwerIdx` |
| `phase` (0 attack, 1 defend, 2 throw_in) | `phase` (`ATTACK`/`DEFEND`/`THROW_IN`) |
| `bout_limit`, `first_bout`, `bout_index`, `stall` | `boutLimit`, `firstBout`, `boutIndex`, `stall` |
| `done`, `loser` (None = draw/running), `finished`, `winner` | `done`, `loser` (`null`), `finished`, `winner` |
| `log: [(player, action)]` | `log: [player, action][]` |
| `current_player` (property) | `currentPlayer` (getter) |
| `active_players`, `is_active(p)` | `activePlayers` (getter), `isActive(p)`, `nextActive(p)` |
| `table_mask`, `_table_rank_mask()` | `tableMask` (getter), `tableRankMask()` |
| `legal_mask_int()` (37-bit) | `legalMask()` (37-bit number) |
| `legal_actions()`, `is_legal(a)` | `legalActions()`, `isLegal(a)` |
| `step(a)` (ValueError) | `step(a)` (throws `IllegalActionError`) |
| `returns()` | `returns(): number[]` |
| `clone()` | `clone()` |
| `determinize(player, rng)` | `determinize(player, rng: Rng)` |
| `unseen_mask(player)` | `unseenMask(player)` |
| `info_state(player)` | `infoState(player)` (same snake_case keys as the Python dict) |

Extras: `snapshot()` / `DurakGame.fromSnapshot(s)` (plain data for storage or
`postMessage`), `toString()` (Python `__repr__`).

## Bots registry contract (consumed by `session.ts`)

`bots.ts` loads `web/src/local/ai/index.ts` lazily (via `import.meta.glob`, so the build
works without it; `random` is always available) and `session.ts` expects:

```ts
export interface Agent {
  name: string;
  reset?(): void;
  /** `game` is already determinized for `player` (as in the Python arena). */
  act(game: DurakGame, player: number): Promise<number>;
  /** P(`player` is NOT the durak) in [0, 1], like ChampionAgent.evaluate. */
  evaluate?(game: DurakGame, player: number): Promise<number>;
  /** Policy over the legal actions (action -> probability), like ChampionAgent.policy. */
  policy?(game: DurakGame, player: number): Promise<Map<number, number> | Record<number, number>>;
}
export function getAgent(name: string, opts?: { seed?: number; [k: string]: unknown }): Promise<Agent>;
export function availableAgents(): string[];
```

The session never hands a bot the true state: `act` receives `game.determinize(player, rng)`,
one fresh determinization per move (the agent's `log` is the real public log, so a
public-log tracker can be reused incrementally). Hint/analysis/evaluate use the first
registered agent among `champion_fast`, `champion` that has `evaluate` (and `policy`
for value-annotated hints); "exact" positions use `solverApplicable(g)` semantics from
`durak/solver.py` (talon empty and 2 active, or 2 players with only the trump card left).
