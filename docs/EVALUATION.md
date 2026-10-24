# Evaluation

Measuring playing strength in Durak is harder than it looks. The game has a lot of luck, more than two players, draws, and an asymmetric payoff in which only the loser is singled out. This page describes the tools the project uses, the statistics behind them and how to read their output.

| Tool | Question it answers |
|---|---|
| [`durak.arena`](#the-arena) | How often is agent A the durak against a field of agent B? |
| [`durak.rl.evaluate`](#durakrlevaluate) | The same for networks and agents, with paired deals and endgame modes |
| [`durak.rl.gate`](#the-gate) | Is a new checkpoint significantly stronger than the champion? |
| [`durak.rl.tournament`](#the-tournament) | How do several checkpoints rank on identical deals? |
| [`durak.ladder`](#the-rating-ladder) | What is every agent's rating, per player count? |

## The metric: durak rate

The payoff of a game depends only on who is the durak: −1 for that player and the same positive amount for everyone else. The natural measure of strength is therefore the **durak rate**, the fraction of games in which a seat ends up as the durak, compared with the **fair share 1/N** that an equally strong player would get.

- Lower is better: .250 is par with four players, and .085 means being the durak about three times less often than par.
- Draws (the last players going out together, about 6% of two-player games, and the stall rule with three or more) make every seat's durak rate slightly lower than 1/N even between equal players. The significance tests below correct for this; the displayed baseline stays 1/N.
- With two players, "not the durak" is the closest thing to a win rate; the evaluation tools print it as `win = 1 − durak rate`.

## Paired deals and seat rotation

All tools use the same **"one against the field"** design. Agent A sits in one seat and copies of agent B fill the others. Every deal is played **N times**, with A rotated through every seat, so each deal's luck affects A equally in every position. With two players this is the classic pair of games with seats swapped.

Because games of the same deal are correlated, confidence intervals are **deal-clustered**: the variance is computed over deals, not over games. And whenever two agents are compared, they play the **same deals** (same seed, same number of games and, for `durak.rl.evaluate`, the same number of workers), and the comparison uses the per-deal differences. Pairing removes most of the variance due to the cards and makes small differences detectable with far fewer games.

## The arena

[`durak/arena.py`](../durak/arena.py) plays any two registered agents (or agent factories) against each other. Agents only ever receive `game.determinize(player, rng)`, never the real game.

```bash
.venv/bin/python -m durak.arena heuristic random --players 2 --games 1000
.venv/bin/python -m durak.arena solver heuristic -n 4 -g 400 -w 2 -s 0
```

```text
solver vs field of heuristic  (N=4, 400 games / 100 deals)
  A durak rate: 0.1950 ± 0.0204   (fair baseline 1/N = 0.2500)
  B durak rate: 0.2542 per B player
  draw rate:    0.0425   (of which stall-rule draws: 0.0000, step-cap timeouts: 0.0000)
  A score:      +0.0592 ± 0.0238
  A durak by seat: 0.210 0.180 0.210 0.180
  9.7 games/s, 88 steps/game
```

| Field | Meaning |
|---|---|
| `A durak rate ± x` | A's durak rate with a deal-clustered 95% half-width |
| `B durak rate` | durak rate per B seat |
| `draw rate` | draws, of which stall-rule draws and step-cap timeouts (the latter should be 0) |
| `A score` | A's mean zero-sum return (−1 as durak, +1/(N−1) otherwise) |
| `A durak by seat` | A's durak rate in each seat; seat effects are real in Durak |

`--games` is rounded up to whole deals. `--workers` runs deals in forked processes and gives the same results as a serial run, because every agent that keeps a `random.Random` as `.rng` is reseeded per game and seat. As a library:

```python
from durak.arena import play_match, format_result
r = play_match("heuristic", "random", num_players=4, n_games=2000, seed=0, workers=4)
r["a_durak_rate"], r["a_durak_ci95"], r["baseline"], r["a_durak_rate_by_seat"]
```

## `durak.rl.evaluate`

[`durak/rl/evaluate.py`](../durak/rl/evaluate.py) evaluates networks as well as agents, runs games in large batches for fast network inference, and supports endgame modes. It plays N = 2..6 by default.

```bash
.venv/bin/python -m durak.rl.evaluate ME [--opps OPP ...] [--ns 2 3 4 5 6] [--games 1000] \
    [--workers 4] [--seed 12345] [--endgame none|me|solve] [--json results.jsonl]
```

**Controller specifications** for `ME` and each `OPP`:

| Spec | Plays |
|---|---|
| `path/to/model.pt` or `nn:path` | the network's greedy policy, no search |
| `agent:NAME` | any registered agent, for example `agent:champion` |
| `agent:champion@path.pt?search=1&belief_dets=0` | the champion agent on another checkpoint with constructor arguments |
| `random`, `heuristic`, `solver` | shorthand for `agent:random` and so on |

**Endgame modes**:

| Mode | Behaviour |
|---|---|
| `none` (default) | every game is played to the end by the controllers |
| `me` | our network seat uses the exact solver whenever it applies (proven win or draw: solver move), as the deployed champion does |
| `solve` | once a two-player perfect-information endgame with at most 16 cards is reached, the game ends with its exact value: both sides play the endgame perfectly |

`--opps heuristic --endgame solve` therefore approximates a game against the `solver` bot, much faster than running the bot itself. Each output line reads, for example:

```text
vs heuristic  N=2 games=   20 durak=0.300 [0.083,0.517] base=0.500  win=0.700 [0.483,0.917]  z=+1.81 (2.7s)
```

This example is a deliberately tiny run of 20 games, hence the wide interval.

`z` is a standardised score against an equally strong seat (positive means better), computed from per-deal values and corrected for draws: the null hypothesis is a durak rate of P(game decided)/N rather than 1/N. Across player counts, results are combined with the curriculum weights {2: 0.30, 3: 0.15, 4: 0.25, 5: 0.20, 6: 0.10} as Σ wₙzₙ / √(Σ wₙ²).

## The gate

[`durak/rl/gate.py`](../durak/rl/gate.py) decides whether a training checkpoint replaces `checkpoints/champion.pt`. The trainer runs it as a subprocess every 100 iterations ([TRAINING.md](TRAINING.md#champion-promotion)).

### Measurements

All of the following use one seat for the candidate and the field for the opponent:

| Family | Opponent | Endgames | Games per N |
|---|---|---|---|
| `random` (dashboard) | random | played out | 200 |
| anchors (dashboard) | frozen early networks (`--anchors`, default iterations 200 and 667) | both perfect | 300 |
| head-to-head | the champion | both perfect | 600 each way |
| `heuristic` | heuristic bots | our seat uses the solver | 1,200 |
| `solver` | heuristic bots | both perfect | 1,200 |
| population | each frozen past network (`--population`, default iterations 667, 1,500, 50,000 and 100,000) | both perfect | 300 |

The **head-to-head** is symmetric: on the same deals the candidate plays alone against a field of champions *and* the champion plays alone against a field of candidates, and the two single-seat durak rates are compared. This cancels the advantages and disadvantages of being the odd one out at the table.

### Decision

1. **Stage 1 (screen).** On a fresh deal set seeded by the iteration number, the candidate **and the current champion** play the same deals against the heuristic, solver and population families. For each family the paired durak-rate differences are combined over N into a z-score, and the three are combined as

   `fixed_z = (z_heuristic + z_solver + z_population) / √3`

   (the population z is itself the combination of the per-network z-scores). Stage 1 passes if `fixed_z > 1.28` and the head-to-head z is positive.
2. **Stage 2 (confirmation).** The same comparison on a second, independent fresh deal set. The candidate is **promoted** only if stage-2 `fixed_z > 1.645` and no family is significantly worse when both stages are pooled (pooled z > −1.645).

For a candidate exactly as strong as the champion, the chance of a false promotion is about 0.1 × 0.05 = 0.5% per gate. Thresholds are configurable (`--threshold`, `--confirm`, `--tolerance`, `--h2h-min`).

### Why it is designed this way

Two earlier designs failed in instructive ways:

- **Comparing with a stored number.** The previous gate compared each candidate with the champion's score measured once, at its promotion. That score was the luckiest of many noisy measurements (the winner's curse) and blocked every later candidate. Now the champion is re-measured on the same deals as the candidate in every gate.
- **Trusting a one-sided head-to-head.** The old head-to-head compared the challenger's durak rate, as a lone seat among copies of the champion, with 1/N. Draws (about 5% of games) pull every seat's durak rate below 1/N, so the test favoured the challenger: over 1,010 gates (iterations 100,000 to 200,000) challengers averaged a two-player durak rate of .469 against the champion (z ≈ 2.7) and 62% of gates promoted, while results against fixed opponents barely moved. A later tournament found that even the much older iteration-150,000 network "beat" the champion this way (z +2.5); with the draw correction, all recent candidates fall between −1.6 and +0.3. The head-to-head is now symmetric and draw-corrected, it serves only as a sanity check, and promotion rests on fixed opponents.

### Outputs

- `runs/<name>/eval.jsonl`: one record per gate with every measurement (`{family}_{N}p_durak`, `_ci`, `_games`, `{family}_z`, `champ_{N}p_durak`, `vs_champion_z`, `stage1`, `fixed_z1`, `stage2`, `fixed_z2`, `decision`, `promoted`, `eval_sec`), and the same in TensorBoard under `eval/*`.
- On promotion: `checkpoints/champion.pt` (replaced atomically), `checkpoints/champion.json` (the promotion record) and a line in `checkpoints/champion_history.jsonl`.
- `checkpoints/champion_stats.json`: the champion's measurements accumulated over every gate since its promotion, starting with its own unselected stage-2 results.
- `runs/eval_summary.json`: rewritten after every gate from that running estimate, and read by the web app (Lab page and the title screen's strength line):

```json
{
  "updated": "2026-10-24T14:19:38+02:00",
  "iteration": 367400,
  "suite_version": 3,
  "gates_accumulated": 61,
  "results": {
    "heuristic": {"2": {"rate": 0.1339, "ci": [0.1315, 0.1363], "games": 75600}, "...": {}},
    "solver": {"...": {}},
    "anchor:frozen_it1500": {"...": {}},
    "random": {"...": {}}
  }
}
```

`python -m durak.rl.gate checkpoints/champion.pt --run-dir runs/main --summary-only` re-measures the champion alone and refreshes these files without gating.

## The tournament

[`durak/rl/tournament.py`](../durak/rl/tournament.py) ranks any set of checkpoints against a reference in the same paired way as the gate, with larger samples:

```bash
.venv/bin/python -m durak.rl.tournament --ref checkpoints/champion.pt \
    --cands runs/main/ckpt/it200000.pt runs/main/ckpt/it201000.pt \
    --pop checkpoints/frozen_it1500.pt --out runs/tournament/t1.json --workers 4
```

Each candidate plays the heuristic (4,800 games per N by default), the solver family (4,800), each population network (1,200) and the reference head-to-head (2,400). The ranking criterion is `fixed_z` against the reference (positive means better); the head-to-head is reported but not used. Raw per-deal results are stored in `--out`, and the run resumes where it stopped. `--round-robin` adds a symmetric round-robin among chosen checkpoints, and `--seed-offset` draws fresh deals for a confirmation run.

The tournament of 2026-10-19 compared the champion (iteration 197,800) with seven other networks from iterations 150,000 to 201,100. None of the newer networks was significantly better; the best candidate's apparent edge vanished on fresh deals, while iteration 150,000 was significantly worse (fixed_z −2.29). The results are recorded in [`durak/rl/README.md`](../durak/rl/README.md#champion-tournament-2026-10-19-runstournament). Gate v3 has since promoted five later networks; the current champion is iteration 367,400 ([docs/TRAINING.md](TRAINING.md#current-results)).

## The rating ladder

[`durak/ladder.py`](../durak/ladder.py) maintains Elo-like ratings for every agent, separately for each player count.

### Model

Since the payoff depends only on who is the durak, the ladder models exactly that event. Each agent *i* has a rating rᵢ and a "losing strength" gᵢ = 10^(−rᵢ/400). At a table with seats *s*:

```text
P(seat s is the durak) = g(agent in s) / Σₜ g(agent in t)
```

- With two players this is exactly Elo (Bradley–Terry): P(A beats B) = 1 / (1 + 10^((r_B − r_A)/400)).
- With more players it is the multinomial-logit (Luce choice) model for the loser, the first stage of a Plackett–Luce model. Only that stage is used on purpose: the order in which the safe players go out does not affect the payoff, and rating it would reward finishing early rather than not losing.
- A draw counts as 1/N of a durak for every seat.
- Ratings are fitted per N by Newton's method on the penalised likelihood (a very weak Gaussian prior with a standard deviation of 1,500 Elo keeps ratings finite for an agent that never loses) and anchored at `random` = 0. 95% intervals come from a bootstrap over deals, refitting each replicate.

### Reading ratings

With two players, 100 points means winning about 64% of decided games and 200 points about 76%. With more players, the rating gap Δ between a lone agent A and a field of B gives

```text
P(A is the durak) = q / (q + N − 1),   q = 10^(−Δ/400)
```

| Δ | 2p | 3p | 4p | 5p | 6p |
|---|---|---|---|---|---|
| 0 | .500 | .333 | .250 | .200 | .167 |
| +100 | .360 | .220 | .158 | .123 | .101 |
| +200 | .240 | .136 | .095 | .073 | .059 |
| +400 | .091 | .048 | .032 | .024 | .020 |

Ratings for different player counts are separate scales and are not comparable: with more players there is more luck and the scale compresses.

### Schedule and bookkeeping

- With two players, each *deal unit* is a pair of games with seats swapped. With N ≥ 3, a unit for the pair (A, B) is 2N games on one deal: A alone against a field of B in every seat, and B alone against a field of A in every seat.
- Pairs of agents adjacent (or one apart) in the current rating order are scheduled, since that is where games are most informative. Pairs with fewer games come first, weighted by how expensive their agents are to run, within a wall-clock budget.
- Raw results are appended to `runs/ladder_games.jsonl`, so repeated runs keep refining the ladder. Each record stores the **version** of every agent: a hash of its source code, or the modification time and size of its weights file. A fit uses only records whose versions match the current agents, so a retuned bot or a newly promoted champion starts afresh.
- `grandmaster` is identical to `champion`; it is rated once and reported under both names. The levels' ratings are also collected under `levels_elo` in the output for the web app.

```bash
.venv/bin/python -m durak.ladder --minutes 15 --workers 3            # play for 15 minutes, then fit
.venv/bin/python -m durak.ladder --fit-only                           # refit stored results only
.venv/bin/python -m durak.ladder --ns 2 4 --agents random heuristic solver --minutes 5
```

Agent specifications are registry names, `ckpt:<path>` for a historical checkpoint (played as policy plus solver), or `level:temperature=1.5,top_p=0.9,use_solver=0,search=0` for an ad-hoc level. By default the ladder rates the core agents plus three evenly spaced checkpoints of `runs/main`. `--fit-only` rewrites `runs/ladder.json` (use `--out` to write elsewhere); because of the version filter, refitting after the champion has changed drops the champion's old games.

The current ladder is shown in the [README](../README.md#rating-ladder-and-difficulty-levels); it was fitted on 2026-10-14 against the champion of that day.

## How to read the numbers

- **Compare with 1/N, not with zero.** A durak rate of .085 with four players is excellent; .20 with two players is also excellent.
- **Look at the interval.** With 1,000 two-player games the 95% interval is about ±3 points. Differences between similar agents need paired comparisons or many thousands of games.
- **Know which agent was measured.** The gate's figures are for the network plus the exact solver, *without* search. The deployed `champion` and `grandmaster` add search and are stronger; `champion_fast` matches the measured configuration.
- **"Solver" in the gate is an emulation**: heuristic opponents with every small endgame scored exactly. It is very close to the real `solver` bot, and much cheaper.
- **One against the field is asymmetric.** A lone agent among copies of another is not the same as a mixed table. The ladder's Luce model and the symmetric head-to-head account for this; single arena numbers do not.
- **Training-time durak rates** in `train.csv` and `status.sh` come from self-play games with the policy alone and a mixture of opponents. They are useful for spotting trends but are not evaluations.
- **Results files are snapshots.** `runs/ladder.json` and `runs/eval_summary.json` describe the agents at the time they were written; check their `updated` fields.
- **Human results** shown in the web app (`/api/stats`) are a record of games played, not a controlled measurement.
