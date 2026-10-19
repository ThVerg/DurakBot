# Bots

DurakBot has five kinds of computer player, all behind one small interface: a random player, a rule-based heuristic, the heuristic with a perfect endgame, the reinforcement-learning champion, and four difficulty levels built from the champion for human opponents.

| Name | Module | What it is | Ladder, 2p / 4p ¹ |
|---|---|---|---|
| `random` | [`durak/agents/__init__.py`](../durak/agents/__init__.py) | uniformly random legal move | 0 / 0 |
| `heuristic` | [`durak/agents/heuristic.py`](../durak/agents/heuristic.py) | rule-based play with card counting | 759 / 668 |
| `solver` | [`durak/agents/solver_agent.py`](../durak/agents/solver_agent.py) | `heuristic`, plus the exact solver in every solvable endgame | 834 / 731 |
| `champion` | [`durak/agents/champion.py`](../durak/agents/champion.py) | policy network + exact endgame solver + PIMC search | 984 / 863 |
| `champion_fast` | same | policy network + exact endgame solver, no search | 950 / 804 |
| `novice`, `intermediate`, `expert`, `grandmaster` | [`durak/agents/levels.py`](../durak/agents/levels.py) | difficulty levels on top of the champion's policy | see [below](#difficulty-levels) |

¹ Elo-like ratings from `runs/ladder.json` (2026-10-14), anchored at `random` = 0. The champion rated there is the network of that day, not the current one. See [EVALUATION.md](EVALUATION.md#the-rating-ladder).

## The agent interface

```python
# durak/agents/__init__.py
class Agent:
    name = "agent"

    def act(self, game: DurakGame, player: int) -> int:
        """Return a legal action (0..35 = card, 36 = PASS) for `player`, who is to move."""

    def reset(self) -> None:
        """Called at the start of every game."""
```

Agents are created through a registry:

```python
from durak.agents import get_agent, available_agents, register

available_agents()        # ['champion', 'champion_fast', 'expert', 'grandmaster', 'heuristic',
                          #  'intermediate', 'novice', 'random', 'solver']
bot = get_agent("heuristic", seed=1)    # keyword arguments go to the agent's constructor
register("mybot", MyBot)                # any callable that returns an Agent
```

The built-in modules are imported lazily the first time the registry is used. An agent whose dependencies are missing (for example the champion without PyTorch or without `checkpoints/champion.pt`) fails when it is created; the web server checks every agent and lists the ones that fail as unavailable instead of crashing.

The game object an agent receives is a **determinized copy** of the real game from its own seat's point of view (see [No-cheating guarantees](#no-cheating-guarantees)). An agent may call any method on it, including `clone()` and `step()`, to look ahead.

## `random`

Picks a uniformly random legal action. It is the anchor of the rating ladder and a sanity baseline: every other bot is almost never the durak against it.

## `heuristic`

A hand-written strategy for any number of players, tuned in the arena against random play and against its own earlier versions. It uses only what its seat may know: its own hand, the table, the discard, the talon size, hand sizes and publicly known cards.

- **Card value.** Non-trumps are valued by rank; trumps are worth `trump_bonus` more, which puts them above every non-trump.
- **Card counting.** For a hidden card, the probability that a given opponent holds a card able to beat it is computed from the unseen pool and the number of unknown cards in that opponent's hand (a hypergeometric model). When the talon is empty and two players remain, the opponent's hand is exactly the unseen cards, and the bot uses it.
- **Leading.** Lead low non-trumps, preferring ranks held several times (so more can be added later). As the talon runs out, prefer cards the defender probably cannot beat. With an empty talon, try to lead a whole hand of one rank to go out.
- **Adding and throwing in.** Add the cheapest matching card if its value is below a threshold. The threshold rises as the talon shrinks, when the defender has few cards left, and for the co-thrower in multiplayer games (if the defender takes, the co-thrower attacks next). Throw-ins after a take use a lower threshold. With an empty talon, dump everything if that empties the hand, and prefer cards the defender cannot beat.
- **Defending.** Beat with the cheapest card, adding a penalty for beating with a new rank that the throwers are likely to follow. Take instead of spending a high trump when the talon is still large and the table is cheap.

The parameters (`DEFAULT_PARAMS` in the module) can be overridden through keyword arguments, for example `get_agent("heuristic", trump_bonus=12.0)`. Games with three or more players use `MULTI_PARAMS` overrides (`trump_bonus=14`, `lead_pair_bonus=0.5`): conserving trumps matters more there. The heuristic plays a move in well under a millisecond.

## `solver`

The `heuristic` bot plus the exact [endgame solver](SOLVER.md). Whenever the position is perfect information (talon empty and two players left, or two players with only the face-up trump card in the talon), it asks the solver for the best move within `time_limit` (default 1.0 s) and an optional `node_limit`:

- in a **proven win or draw** it plays the solver's move;
- in a **proven loss**, where every move loses against perfect play, it plays the heuristic's move instead. A human or imperfect opponent may still go wrong, and the heuristic's move usually leaves the most chances;
- if the solver **runs out of budget** it also falls back to the heuristic.

`SolverAgent.stats` counts the moves in each category.

## `champion` and `champion_fast`

The trained reinforcement-learning player (see [TRAINING.md](TRAINING.md) for how it is trained). One network plays every player count from 2 to 6. Each move goes through up to three stages:

1. **Endgame solver.** If the position is solvable, run the solver with a 0.6 s limit (`solver_time`). A proven win or draw plays the solver's move; a proven loss or a timeout falls through to the network, for the same practical reasons as the `solver` bot.
2. **Policy network.** Encode the position from the acting seat's information and the public move log, and evaluate the network on CPU (a few milliseconds).
3. **PIMC search** (`champion` only). Take the network's top candidates (at most 4, each with probability at least 3%), sample determinizations of the hidden cards from the network's *belief head*, and evaluate every candidate on the same samples: with two active players by playing each sample out with the policy (32 samples, finished by the solver once 10 or fewer cards remain), with three or more by rolling forward two bouts and reading the value head (12 samples). The move with the best mean result plus 0.1 × its prior probability is played.

The search budget is 0.8 s inside a total budget of about 0.95 s per move that also covers the solver. `champion_fast` skips stage 3 and moves in a few milliseconds. Both are greedy by default; `temperature > 0` samples from the policy instead.

Other details:

- The network is loaded from `checkpoints/champion.pt` and **hot-reloaded** when the file changes (checked at most every 30 s), so a running server picks up a newly promoted champion without a restart. A failed reload keeps the previous network.
- Constructor arguments include `path` (another checkpoint), `use_solver`, `solver_time`, `search`, `search_dets`, `search_time`, `move_budget`, `search_multi`, `belief_dets`, `multi_depth`, `multi_dets`, `temperature`, `seed` and `threads` (PyTorch threads, default 1).
- `policy(game, player)` returns the network's distribution over legal moves, `belief(game, player)` the belief head's location probabilities for each card, and `evaluate(game, player)` the estimated probability that `player` will **not** be the durak (exact when the solver applies). The web app uses these for win chances, hints and post-game analysis.

## Difficulty levels

Human players need opponents of graded strength. Rather than making a strong bot play random moves now and then, every level plays from the **champion's policy network**, so its moves look like moves the network itself finds plausible, and weakens it in controlled ways:

- `temperature` and `top_p`: sample from a softened policy, but only among the moves that make up the top `top_p` of the probability mass, so absurd moves never happen;
- `blunder`: the probability, per decision, of a *beginner move* instead of the policy move. A beginner move is legal and natural-looking but unskilled: lead a lowish non-trump, beat with any card that beats (trumps included), sometimes add or throw in, take when unable to beat, and occasionally take for no good reason. It mimics a player who neither counts cards nor plans ahead. The rate depends on the number of players;
- `use_solver` and `search`: perfect endgames and the champion's search.

| Level | Policy | Blunder rate by players (2 / 3 / 4 / 5 / 6) | Solver | Search |
|---|---|---|---|---|
| `novice` | sampled, temperature 1, top-p 0.9 | 0.90 / 0.95 / 1.00 / 1.00 / 1.00 | no | no |
| `intermediate` | sampled, temperature 1, top-p 0.9 | 0.50 / 0.50 / 0.55 / 0.50 / 0.55 | no | no |
| `expert` | greedy | 0.30 / 0.22 / 0.18 / 0.17 / 0.20 | yes | no |
| `grandmaster` | greedy | 0 | yes | yes |

`grandmaster` is identical to `champion`, and the ladder rates it once under both names. The blunder rates were tuned on the rating ladder, aiming for gaps of about 200 Elo between levels (about 150 with six players). Each level carries a `description` for the web app.

In the web app's lobby the four tiers map to the first available agent in these lists: Novice → `novice`, `random`; Intermediate → `intermediate`, `heuristic`; Expert → `expert`, `solver`; Grandmaster → `grandmaster`, `champion`, `champion_fast` ([`web/src/dacha/tiers.ts`](../web/src/dacha/tiers.ts)). The advanced lobby options let you put any available bot in any seat.

## No-cheating guarantees

Durak is a game of hidden information, and a bot that peeks at hidden cards would be both unfair and misleadingly strong. The project enforces honesty in three ways.

**Structurally.** Neither the arena nor the server ever hands an agent the real game. Before every decision they call `game.determinize(player, rng)` and pass that copy, in which every card hidden from the acting player has been redealt at random. Reading another player's hand from the copy yields a random guess consistent with public information, nothing more. The same holds for the coach features: hints, win chances and the post-game analysis are computed on determinizations of the human's information set.

**By construction.** The bots are also written to use only legitimate information, so they behave the same when given the real game:

- the heuristic reads only its own hand, public state, `game.known` and `unseen_mask`;
- the champion's observation is built from its own hand, the public fields, the known cards and the public move log; it reads the legal-move mask only when it is the player to move;
- the solver only runs in positions where nothing is hidden.

**Tested.** The test suite checks these properties:

| Test | Checks |
|---|---|
| `tests/test_arena.py::test_agents_never_get_the_real_game` | agents only ever receive copies |
| `tests/test_arena.py::test_cheating_agent_gains_nothing` | a heuristic that reads opponents' hands from what it is given does no better than its honest twin |
| `tests/test_arena.py::test_peeking_at_the_view_is_no_better_than_chance` | guessing hidden cards from the view is at chance level; a deliberately leaky arena is detected (`test_peek_test_has_power_with_a_leaky_arena`) |
| `tests/test_agents.py`, `tests/test_levels.py` `::test_uses_only_legal_information` | moves do not depend on how the hidden cards are dealt |
| `tests/test_rl_champion.py::test_champion_on_real_game_and_views_agree` | the champion's actions and evaluations are identical on the real game and on its determinizations |
| `tests/test_rl_encoding.py::test_non_acting_player_does_not_read_hidden_hand` | the encoder ignores hidden cards |
| `tests/test_server_coach.py` (`test_hint_independent_of_hidden_cards`, `test_analysis_and_hint_only_see_human_info_set`, `test_replay_frames_leak_free`) | coach features and replays leak nothing |
| `tests/test_server.py::test_get_state_and_history_no_leak`, `tests/test_server_e2e.py` | bot cards never appear in API responses or in the browser's DOM unless spectating or the debug reveal is on |

## Writing your own bot

```python
from durak import PASS
from durak.agents import Agent, register
from durak.arena import play_match, format_result

class LowestCard(Agent):
    """Plays its lowest legal card (trumps last); passes only when it must."""
    name = "lowest"

    def act(self, game, player):
        cards = [a for a in game.legal_actions() if a != PASS]
        if not cards:
            return PASS
        return min(cards, key=lambda c: (c // 9 == game.trump, c % 9))

register("lowest", LowestCard)
r = play_match("lowest", "random", num_players=2, n_games=200, seed=0)
print(format_result("lowest", "random", r))
# lowest vs field of random  (N=2, 200 games / 100 deals)
#   A durak rate: 0.0300 ± 0.0234   (fair baseline 1/N = 0.5000)
#   ...
```

This simple bot already beats `random` easily but is clearly weaker than `heuristic`. To make a bot available everywhere, including the command-line arena (`python -m durak.arena lowest heuristic`) and the web server, put it in a module that calls `register()` and add that module to the list in `_load_builtin()` in [`durak/agents/__init__.py`](../durak/agents/__init__.py). Labels, descriptions and the star tier shown in the web app come from [`server/bots_meta.py`](../server/bots_meta.py); unknown bots fall back to their name and docstring.
