# The exact endgame solver

Durak is a game of hidden information until the very end. Once the talon is empty and only two players are left, nothing is hidden any more: each player knows their own hand, and the opponent's hand is every card that is neither in their own hand, on the table nor in the discard. From that point the game is a finite two-player game with perfect information, and it can be solved exactly.

This matters a lot in practice. **Every game ends this way**, whatever the number of players, because players drop out one by one until two remain, and the last few bouts decide who is the durak. The solver is used by the `solver` bot, by the champion and the `expert`/`grandmaster` levels, inside the champion's search, to end self-play games with exact results during training, and to score endgames exactly in evaluation.

| File | Contents |
|---|---|
| [`durak/solver.py`](../durak/solver.py) | public API, the pure-Python reference search (`EndgameSolver`) and the native binding (`NativeEndgameSolver`) |
| [`durak/_solver.c`](../durak/_solver.c) | the native core: the same search in C |
| [`durak/agents/solver_agent.py`](../durak/agents/solver_agent.py) | the `solver` bot ([BOTS.md](BOTS.md#solver)) |
| [`tests/test_solver.py`](../tests/test_solver.py) | correctness tests against brute force |

## When it applies

`solver.applicable(game)` is true when the game is not over and either:

- the talon is empty and exactly two players are still active, or
- two players play and the talon holds only the face-up trump card. Its owner after the next draw is determined by the drawing order (attacker first), so the position is still perfect information.

## API

```python
from durak import solver

solver.applicable(game)                                    # bool
solver.solve(game, player, time_limit=1.0, node_limit=None) # (value, best_action) or None
solver.action_values(game, player, time_limit=1.0)          # {action: value} or None
solver.native_available()                                   # is the C core in use?
solver.brute_force(game, player)                            # reference minimax (tests only)
```

- `value` is from `player`'s point of view: **+1** means the other player will be the durak with best play, **0** a draw, **−1** that `player` will be the durak.
- `best_action` is the best move for the player to move (`game.current_player`), who need not be `player`.
- `None` means the position is not perfect information, `player` is not active, or the time or node budget ran out.
- It is safe to call on a determinized copy, because determinization is exact in these positions.

`get_solver(trump_card)` caches one solver per trump card (up to four), so consecutive calls during a game reuse the transposition table.

## The search

### State

Internally a position is always seen from the current bout's **attacker** against the **defender**. Seats drop out entirely: with two players the roles swap after a successful defence and stay the same after a take. A state is

```text
(a, d, table, n, uncovered card, limit, flag)
```

where `a` and `d` are the attacker's and defender's hands as 36-bit masks, `table` is the mask of cards on the table, `n` the number of attack cards played, `limit` the bout limit, and `flag` says whether the face-up trump card is still in the talon. Values are in the attacker's frame and lie in {−1, 0, +1}.

### Node types

The search follows the real move sequence one card at a time, so each bout is part of a single game tree:

| Node | Mover | Choices |
|---|---|---|
| attack | attacker (max) | lead any card (empty table), add a card of a table rank if `n < limit`, or pass (bita) |
| defend | defender (min) | beat the uncovered card, or take |
| take | attacker (max) | throw in any subset of matching cards that fits under the limit, then the defender picks up |
| end of bout | none | the trump card is drawn if still in the talon (attacker first), terminal positions are scored, roles swap after a defence |

A quick exact rule shortcuts many attack nodes: if nothing is left to draw and the attacker's whole hand is a single rank that fits under the limit, the attacker can lead everything and go out. That wins outright if the defender holds more cards. If both players hold a single card, it is a draw when the defender's card beats the attacker's (both go out together) and a win otherwise.

### Alpha-beta with a transposition table

The search is fail-soft alpha-beta over the three values. The transposition table stores proven bounds `(lo, hi)` and the best move for each state, and it is shared across bouts and across successive moves of the same game. With only three possible values the root uses a **null-window** test (in the style of MTD): first "is there a winning move?", then "is there a drawing move?". At most two cheap null-window passes over the root moves are needed.

### Move ordering

Good ordering is what makes alpha-beta fast. In order of priority (items 2 and 5 exist only in the C core; ordering never changes the values):

1. the move stored in the transposition table;
2. **killer moves**: the last two moves that caused a cutoff at the same node type and table size;
3. for the attacker, cards the defender cannot beat at all come first;
4. cheap cards before expensive ones, trumps last;
5. two tuned tie-breakers: the defender prefers beaters that do not open a rank the attacker still holds, and the attacker's ordering takes into account how many cards of the same rank it holds.

In take nodes, larger throw-in sets are tried first.

### Dominance pruning

Many cards are interchangeable in an endgame, and searching both is wasted work. The solver drops a card when another card provably does at least as well. The rule is exact:

> Let x < y be two cards of the same suit, both in the mover's hand, such that no other *live* card of that suit lies between them and neither rank is shared by any other live card. Then playing x (to lead or to beat) is at least as good as playing y, and y need not be searched.

*Live* cards are those in the two hands, on the table, and the trump card if it is still in the talon; discarded cards play no further role. Swapping x and y preserves every rule relation except the one between x and y themselves, so by a strategy-stealing argument holding the higher card is never worse, and spending the lower one first dominates. For example, with 7♠ and 8♠ in hand, no other live spade between them and no other live 7 or 8, leading 8♠ is never better than leading 7♠.

The tests check the pruning against unpruned search on positions built specifically to exercise it.

### Iterative deepening (available, off by default)

The C core can cut the search at a bout horizon and score horizon leaves pessimistically or optimistically for the mover, which turns each pass into a one-sided proof. `NativeEndgameSolver.ID_SCHEDULE` controls this; the default `(None,)` searches to the end in a single pass.

## The native core

`durak/_solver.c` implements the attack, defend, take and end-of-bout nodes in C and computes exactly the same values as the Python code; the root logic stays in Python. It is typically 50–100 times faster than the pure-Python search.

- **Build.** On first use, `solver.py` compiles the file with `gcc -O2 -shared -fPIC` into `~/.cache/durakbot/_solver_<hash>.so`, keyed by a hash of the source, and loads it with `ctypes`. The library is written with an atomic rename, so parallel workers can start at the same time. If compilation or loading fails, the solver silently falls back to pure Python.
- **Transposition table.** A global table of 2^21 entries of 48 bytes each (about 96 MiB of address space per process, touched lazily), organised in 4-way buckets. On a collision the entry with the least search work behind it is replaced. The trump card is part of every key, so solvers for different games can share the table.
- **Budgets.** A node limit and a wall-clock deadline (checked every 4,096 nodes); when either runs out the search aborts and `solve` returns `None`.

| Environment variable | Effect |
|---|---|
| `DURAK_SOLVER_NATIVE=0` | never compile or load the C core; use pure Python |
| `DURAK_CACHE=<dir>` | where the compiled library is cached (default `~/.cache/durakbot`) |
| `DURAK_SOLVER_TT_LOG2=<k>` | transposition table size of 2^k entries (default 21) |

The pure-Python `EndgameSolver` uses a dictionary as its transposition table, capped at 3 million entries and cleared when full.

## Budgets in use

| Caller | Budget |
|---|---|
| `solver` bot | 1.0 s per move (`time_limit`) |
| `champion`, `expert`, `grandmaster` | 0.6 s per move (`solver_time`); `ChampionAgent.evaluate` uses at most 0.3 s |
| Champion search (PIMC rollouts) | positions with at most 10 cards, 5,000 nodes |
| Training rollouts | in 70% of games (`--solve-frac`), positions with at most 12 cards (`--solve-max-cards`), 30,000 nodes; retried only when the number of cards changes |
| Evaluation with `--endgame solve` | positions with at most 16 cards, 100,000 nodes |

When the budget runs out, every caller falls back to its normal move choice, so a hard position costs time but never produces an illegal or random move.

## Performance

Measured with the C core on two-player endgames reached by heuristic play (single thread, on a shared 16-thread desktop CPU under load):

| Cards in play at the first solvable position | Median time | Worst observed |
|---|---|---|
| up to 11 | well under 1 ms | 0.01 s |
| 12–15 | about 2 ms | 0.3 s |
| 16–19 | several seconds | over 10 s (not solved) |

Most positions are therefore solved almost instantly. The budgets above exist for the minority of large endgames (5 of the 60 sampled positions had 16 or more cards), which typically follow a series of takes.

## Correctness

[`tests/test_solver.py`](../tests/test_solver.py) checks the solver against `brute_force`, a plain memoised minimax that steps the real engine and shares no code with the solver:

- values and best moves on random small positions covering every phase, including the talon-of-one case (`test_matches_brute_force`, `test_action_values_match_brute_force`, `test_positions_cover_all_phases_and_talon_one`);
- the native core against the Python search on larger positions (`test_native_matches_python_on_larger_positions`);
- exactness of dominance pruning (`test_dominance_pruning_exact_on_dominance_positions`);
- that a determinized copy gives the same answer, that seat numbers do not matter in multiplayer endgames, that budgets return `None`, and a regression test on a large real endgame;
- that the `solver` bot actually realises solved values when playing full games.

## In the browser

For the static build the same C file is compiled to WebAssembly without modification (`scripts/build_solver_wasm.sh`). That work is in progress; see [STATIC_BUILD.md](STATIC_BUILD.md).
