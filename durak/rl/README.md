# DurakBot RL

PPO self-play for Podkidnoy Durak with 2-6 players. One network plays every
player count. CPU only.

## Files

| file | what |
|---|---|
| `encoding.py` | observation encoder, suit canonicalisation, `PublicTracker` (public-log replay and belief features) |
| `model.py` | residual-MLP actor-critic: policy (37 logits, masked), value head, durak-probability head, belief head (v2); `transfer()` for architecture upgrades |
| `rollout.py` | rollout worker process: batched self-play over about 64 concurrent games, PFSP league, solver-ended games, belief targets, GAE |
| `train.py` | asynchronous PPO learner: spawns workers, logs, checkpoints, resumes and upgrades, league stats, starts gating |
| `gate.py` | broad eval suite (random, heuristic, solver, frozen anchors, champion), gating, and `runs/eval_summary.json` |
| `evaluate.py` | CLI eval of any checkpoint/agent against bots/checkpoints/agents, N=2..6; paired deals, deal-clustered 95% CIs, endgame modes |
| `search.py` | PIMC: 2-active full rollouts, 3+-active value-cutoff rollouts, uniform or belief-weighted determinizations |
| `../agents/champion.py` | the `"champion"` agent: policy, exact endgame solver and PIMC search; `evaluate()` for win probability; `belief()` |

## Design

**Observation** (918 floats; v1 networks use the first 911). Everything is computed from the acting player's information.
Seats are relative: slot 0 is self and slots 1..5 are the opponents clockwise, padded with an "absent" flag.

There are 23 card planes of 36 entries each:

- own hand
- my publicly known cards
- known cards of each of the 5 opponent slots
- discard
- uncovered attack cards (one while defending, several during throw-in)
- covered attack cards
- defense cards
- unseen cards
- the face-up trump card while it is still in the talon
- two belief planes per opponent slot:
  - `cant_beat`: beaters of the card they took on
  - `no_throw`: table-rank cards they declined to throw in while the defender was taking

  Both belief planes are cleared when that player draws, and masked to the unseen cards.

There are 90 scalars:

- per seat: present, active, hand size, is attacker, is defender, is co-thrower, number of takes, took last bout, finishing order
- phase one-hot
- my role one-hot (main attacker, co-thrower, defender, bystander)
- talon size, talon==0, first bout, empty table
- bout limit, attack count, remaining capacity, defense count, number of uncovered cards
- N one-hot and number-of-active-players one-hot
- unseen count, finished count, thrower index
- v2 additions, appended so v1 networks still work on the prefix:
  - the stall counter (`game.stall`/30)
  - the number of *unknown* cards per location (5 opponent seats and the talon)

**Suit canonicalisation.** Trump is always canonical suit 0. The three
non-trump suits are sorted by a key built from all card planes restricted to
that suit. So two positions that differ only by a suit relabelling give the
identical observation, and suits that tie are fully interchangeable. The legal
mask is remapped the same way. A canonical action maps back through the
inverse permutation; see `to_real_action`. The tests check that relabelling
invariance holds and that actions stay consistent.

**PublicTracker.** It replays `game.log` using card counts only; it needs N, the
trump suit and the first attacker. A test checks it against the engine at every
step for all N. Training feeds it events incrementally. The champion rebuilds or
extends it from the log of whatever copy it is given, which can be the real game
or a determinized view.

**Model.** `Linear(918→384)` → 3 pre-LayerNorm residual blocks (384) → LayerNorm, with these heads:

- policy logits over 37 actions, with illegal actions masked to −1e9
- value: the expected `returns()` of the acting seat
- durak logit: BCE against "this seat ended as durak", which gives calibrated win probabilities for the website

The model has about 1.26M parameters.

**Belief head (v2).** For each of the 36 canonical cards it gives logits over 6
locations (opponent relative seat 1..5, or the talon). Locations with no unknown
cards are masked out.

- It is trained with cross-entropy against ground truth recorded during
  self-play (free supervision), only for cards unseen by the acting player, with
  weight 0.5.
- `train.csv` logs `bel_loss`, `bel_acc` and `bel_gain`. `bel_gain` is the
  improvement in nats per card over the count-proportional prior, i.e. over
  what a uniform determinization assumes.
- Its detached probabilities are projected back into the trunk before the
  policy and value heads (`bel_proj`, zero-initialised). So a v1 network
  transferred into v2 computes exactly the same function at the start; a test
  checks this.
- It also drives belief-weighted determinizations in search.

**PPO.** Training is asynchronous:

- 7 rollout processes (1 torch thread each) write finished trajectories to a queue.
- The learner (4 threads) takes 32768 decisions per iteration and runs **1 epoch** (8 minibatches of 4096). That was 2 epochs until iteration 1025; see the A/B results below.
- Clip 0.2, Adam with lr 3e-4 decaying to 1e-4, entropy coefficient 0.01 decaying to 0.003, value coefficient 0.5, durak-BCE coefficient 0.25, grad-norm clip 0.5, and KL early stop at 0.045.
- GAE uses γ=1 and λ=0.95 over each seat's own decisions. The reward is the terminal `returns()[seat]`: durak −1, others +1/(N−1).
- A credit semaphore keeps workers at most about one batch ahead, so samples are typically 1–1.5 policy versions stale. The behaviour log-probs are stored for the PPO ratio.
- Forced moves (exactly one legal action) are played without the network and are not trained on; they are about 35% of all moves.
- The engine's stall rule (30 consecutive takes with an empty talon and 3+ players) is a draw, and accounts for about 4% of games. A 2000-move safety cap truncates games and bootstraps from the value estimate.

**Self-play setup and league (PFSP).**

- N is drawn from {2:30%, 3:15%, 4:25%, 5:20%, 6:10%}.
- 50% of games are pure self-play, with every seat on the latest weights.
- In the other games, 1..N−1 random seats go to one opponent type:
  - a league snapshot (weight 0.5)
  - the `heuristic` bot (weight 0.5); bots get `game.determinize()` views
  - random (weight 0.02)
- Only learner seats are trained on.
- **League (prioritized fictitious self-play):**
  - A snapshot is added to `runs/<name>/pool` every 25 iterations. The pool keeps the newest 20 plus every 4th older one.
  - Workers report the learner's durak count against each league member. The learner aggregates these into `league.json`, with a 0.995 per-iteration decay.
  - Hardness = (durak + 2)/(baseline + 2), where baseline = Σ1/N and 1.0 means par.
  - Each worker loads 3 snapshots sampled ∝ hardness², and picks among them ∝ hardness², so opponents we do badly against are played more.
  - `status.sh` shows the hardest members.
  - Exploiter agents were not built; see "Not done".

**Solver-ended games.** In 70% of games (`--solve-frac`), once the talon is
empty, two players are left and at most **12** cards are in play (10 before
round 2), the exact solver (now native C) runs with a 30k-node budget. If it
succeeds, the game ends with the exact result. It is retried only when the card
count changes. About 64% of games end this way. This gives exact terminal
rewards and matches how the champion plays endgames. The other 30% are played
out, so the policy still learns endgame play; the champion needs that in
proven-lost endgames.

**Champion agent** (`get_agent("champion")`):

- It loads `checkpoints/champion.pt` and hot-reloads it when the file changes, checking at most every 30 s.
- When `durak.solver.applicable(game)` is true (talon empty and two players left, i.e. every game's end), it runs `solver.solve` with a 0.6 s limit:
  - In a proven win or draw it plays the solver's move.
  - In a proven loss every move loses against perfect play, so it keeps the policy's move, which gives the best practical chances.
  - On timeout it falls back to the policy.
- Otherwise it plays the greedy policy refined by PIMC search (below), within about 0.95 s per move.
- Older v1 checkpoints still load and run. A failed hot-reload keeps the previous model; processes started before round 2 must be restarted to load v2 checkpoints.
- `evaluate(game, player)` returns P(not durak): exact (0/1) when the position is solvable, otherwise `sigmoid(-durak_logit)`.
- It never reads hidden information:
  - The observation uses only the player's own hand, public fields, `known` and the log.
  - The legal mask is only read when `player` is the one to move.
  - A test checks that the real game and its determinizations give identical actions and evaluations.

**Evaluation and gating (suite v2).** `gate.py` runs every 100 iterations in
the background.

- Every match uses *paired deals*: each deal is played N times with our seat
  rotating. CIs are deal-clustered 95% intervals.
- Suite, per N = 2..6:
  - `random`: greedy policy, played out.
  - `heuristic`: the policy plus our seat's exact solver, as deployed.
  - `solver`: heuristic opponents, with every solvable 2-player endgame (≤16
    cards) scored exactly. Both sides then play perfect endgames, which is a
    cheap emulation of the `solver` bot.
  - frozen **anchors** `checkpoints/frozen_it200.pt` and `frozen_it667.pt`.
  - head-to-head against the champion.
- Promotion requires two things:
  - The combined head-to-head z must be > 1.28. Per N, z = (1/N − D)/SE; the per-N values are combined with the curriculum weights.
  - The checkpoint must not be significantly worse than the champion against the heuristic or the solver (Δz < −1.645).
- `runs/eval_summary.json` holds the champion's latest per-N results
  (`{"updated", "iteration", "results": {opp: {"N": {"rate", "ci", "games"}}}}`).
  `status.sh` prints a per-N **regression dashboard** across evaluations.
- **Lesson from round 1.** The "2p regression vs the heuristic" (iteration 300
  → 500: .303 → .332) was mostly a moving yardstick, not forgetting. The
  heuristic was retuned and the engine changed while training ran. Re-measured
  under identical conditions (3000 paired games, policy plus our-side solver),
  iterations 200/300/400/500 score .262/.266/.262/.251. Policy-only, it200 vs
  it500 is .344 vs .325. Frozen anchors and paired, deployment-like evals are
  now part of every gate for that reason.

**PIMC search** (`durak/rl/search.py`). It is on by default in `"champion"` and off in `"champion_fast"`.

- **Candidates and deals.** It takes the top policy candidates (at most 4, each with probability ≥3%). The determinizations are shared across candidates (paired). They are **belief-weighted**: each unseen card is sampled from the belief head's location probabilities under the exact per-location unknown counts.
- **2 active players:** 32 determinizations, each played out with the greedy policy (batched) and ended by the exact solver at ≤10 cards.
- **3+ active players:** 12 determinizations with *value-cutoff* rollouts. Play continues greedily until 2 more bouts have ended and it is our turn again; then the value head is read.
- **Choice and budget.** It picks the best mean return plus 0.1·prior. The search budget is 0.8 s, inside a total per-move budget of 0.95 s that also covers the solver. Under load 35 the worst observed move took 0.86 s and the mean was 0.09 s.

## Usage

```bash
scripts/train.sh                     # start or resume run "main" (fully detached; PID in runs/main/train.pid)
NAME=main scripts/train.sh --stop    # graceful stop (saves state.pt)
scripts/status.sh [main]             # progress, health stats, latest evals, current champion
tensorboard --logdir runs/main/tb    # curves (train + eval/*)

# resume: just run scripts/train.sh again with the same NAME (reads runs/<name>/state.pt)
# warm start a new run: NAME=exp2 scripts/train.sh --init checkpoints/champion.pt

# evaluation: paired deals, deal-clustered 95% CIs, baseline 1/N (2p also shows win rate)
.venv/bin/python -m durak.rl.evaluate checkpoints/champion.pt --opps heuristic --games 1200 --endgame me     # policy + our solver
.venv/bin/python -m durak.rl.evaluate checkpoints/champion.pt --opps heuristic --games 1200 --endgame solve  # ~ vs solver bot
.venv/bin/python -m durak.rl.evaluate A.pt --opps nn:B.pt --games 1200 --endgame solve                      # network A/B
.venv/bin/python -m durak.rl.evaluate 'agent:champion@ckpt.pt?belief_dets=1' --opps 'agent:champion@ckpt.pt?belief_dets=0' --ns 2 --games 600
.venv/bin/python -m durak.rl.gate checkpoints/champion.pt --run-dir runs/main --summary-only   # refresh eval_summary.json
.venv/bin/python -m durak.arena champion heuristic --players 2 --games 2000 --workers 4    # bots-agent arena
```

Run directory `runs/<name>/`:

| file | contents |
|---|---|
| `train.csv` | per-iteration stats, including training-time durak rates by N and opponent type |
| `eval.jsonl`, `eval.log` | periodic evals |
| `tb/` | TensorBoard |
| `state.pt` | resume state: model, optimizer, counters |
| `weights.pt` | latest weights, read by the workers |
| `ckpt/` | `latest.pt`, plus `itNNNNNN.pt` at every eval |
| `pool/`, `league.json` | league snapshots and PFSP statistics |
| `runs/eval_summary.json` | the champion's latest per-N suite results, for the website |

## Throughput (i5-12600K, shared with other users' jobs at load 30–40)

- Engine with random play: 165–245k steps/s. Encoding: about 45 µs per decision. One rollout worker produces about 2.5k trained decisions/s.
- **The learner was the bottleneck.** I profiled it in the real (loaded) environment at minibatch 4096:

  | learner configuration | samples/s |
  |---|---|
  | 4 threads | 9.2k |
  | 8 threads | 3.6k |
  | 12 threads, minibatch 8192 | 5.1k |
  | minibatch 8192 (4 threads) | 8.5k |
  | `torch.compile` (4 threads) | 7.4k |

  More threads lose to contention, and compile doesn't help.
- The real lever was sample reuse. **1 PPO epoch instead of 2** gives 2–3x the
  trained samples per hour (main run: about 3k → 7–9k decisions/s, roughly 30M
  decisions/hour). It was also *stronger at equal wall-clock* in an A/B (see
  below), so it is now the default.

## Results

All numbers are durak rates of our seat with 95% CIs; the baseline is 1/N (.500 .333 .250 .200 .167). Lower is better.

### Round 1 (iteration 200)

These used the old evaluator: 1000 independent games per N and Wilson CIs. The heuristic has since been retuned and is stronger.

| agent | opponent | 2p | 3p | 4p | 5p | 6p |
|---|---|---|---|---|---|---|
| policy only | heuristic | .241 [.216,.268] | .174 [.152,.199] | .167 [.145,.191] | .154 [.133,.178] | .108 [.090,.129] |
| champion (solver + PIMC) | heuristic | .182 [.159,.207] | .145 [.125,.168] | .131 [.111,.153] | .117 [.099,.138] | .079 [.064,.097] |
| champion (solver + PIMC) | solver bot | .376 [.347,.406] | – | .210 [.186,.236] | – | – |

### Round 2: champion iteration 1500 (about 52M decisions, ~4 h of training)

Suite v2 has 600 paired games per N (`runs/eval_summary.json`). The rows show progress from the round-1 champion (iteration 300) to iteration 1500 on the identical suite.

| eval (network only, our seat uses the exact endgame solver) | 2p | 3p | 4p | 5p | 6p |
|---|---|---|---|---|---|
| vs heuristic, it300 | .288 | .188 | .158 | .132 | .133 |
| **vs heuristic, it1500** | **.222 [.191,.253]** | **.147 [.121,.172]** | **.130 [.104,.156]** | **.092 [.071,.112]** | **.092 [.069,.114]** |
| vs solver (both perfect endgames), it300 | .387 | .235 | .200 | .175 | .158 |
| **vs solver, it1500** | **.322 [.287,.356]** | **.202 [.172,.231]** | **.177 [.147,.206]** | **.128 [.107,.149]** | **.120 [.095,.145]** |
| vs anchor it200, it1500 | .417 | .253 | .203 | .150 | .157 |

Full deployed agent (iteration 1500 + solver + belief-weighted PIMC) vs the **real `solver` bot**, 600 paired games:

- 2p: durak **.292 [.255,.329]**, i.e. a **70.8%** win rate (round 1: 62.4%)
- 4p: durak **.152 [.127,.177]** (round 1: .210)

### A/B tests in round 2

| change | test | result | verdict |
|---|---|---|---|
| belief head **as features** + aux loss (arm A) vs none (arm B), same fork (it667), 333 iterations each | head-to-head, 1200–2400 paired games/N | 2p A wins 51.6%; 3p A worse (z −2.6); 4p z −0.9; 5p/6p A slightly better; combined z ≈ +0.2. Vs heuristic equal except 3p (.192 vs .158). | **no measurable gain** for the policy (single training seed per arm). Kept for search. |
| **belief-weighted vs uniform determinizations** in PIMC (it1000 network) | head-to-head, 600 games | 2p: **56.0% [52.1, 59.9]**, z +3.0. 4p (value-cutoff): .237 vs .250, z +0.8 | **helps in 2p**, neutral in 4p → on |
| **multiplayer PIMC** (value cutoff) vs none (it667) | 1 searching seat vs 3–4 non-searching champions, 800 games | 4p **.196 [.174,.218]** (z +4.8); 5p **.149 [.130,.168]** (z +5.3) | **helps** → on |
| 2p search budget: 8 dets / 0.25 s vs 16 / 0.5 s | head-to-head, 600 games | 47.2% [43.6, 50.8] | slightly worse (n.s.) |
| 2p search budget: 32 dets / 0.8 s vs 16 / 0.5 s | head-to-head, 600 games | **57.3% [53.6, 61.0]**, z +3.9 | **helps** → new default (fits the 1 s limit) |
| **1 vs 2 PPO epochs** at equal wall-clock (~50 min from it1025) | head-to-head, 1200 games/N | 1 epoch: 2p z +2.5, 3p +4.7, 4p +1.7, 5p +3.3, 6p +0.1; vs heuristic equal or better | **helps** (3x throughput) → default |
| solver ending at ≤12 cards (native solver) | — | solved_frac 0.50 → 0.64 | adopted (exact targets, cheaper) |

### Not done

- **Exploiter agents.** The league is PFSP plus the heuristic. Dedicated exploiters would cost a training slot the machine doesn't have.
- **Expert iteration** (distilling search into the policy). PIMC at 0.3–0.8 s per decision is about 1000x too slow for the 30M decisions/hour pipeline.
- **ISMCTS.** PIMC with belief determinizations and a value cutoff was the cheaper win.
