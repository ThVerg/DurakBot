# DurakBot RL

PPO self-play for Podkidnoy Durak with 2-6 players. One network plays every
player count. CPU only.

## Files

| file | what |
|---|---|
| `encoding.py` | observation encoder, suit canonicalisation, `PublicTracker` (public-log replay and belief features) |
| `model.py` | residual-MLP actor-critic: policy (37 logits, masked), value head, durak-probability head |
| `rollout.py` | rollout worker process: batched self-play over about 64 concurrent games, opponent pool, GAE |
| `train.py` | asynchronous PPO learner: spawns workers, logs, checkpoints, resumes, starts eval and gating |
| `gate.py` | periodic eval against random and heuristic, then a head-to-head against `checkpoints/champion.pt` that decides promotion |
| `evaluate.py` | CLI eval against random, heuristic, solver or any checkpoint/agent, for N=2..6, with Wilson 95% CIs |
| `../agents/champion.py` | the `"champion"` agent: policy plus the exact endgame solver, and `evaluate()` for win probability |

## Design

**Observation** (911 floats). Everything is computed from the acting player's information.
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

There are 83 scalars:

- per seat: present, active, hand size, is attacker, is defender, is co-thrower, number of takes, took last bout, finishing order
- phase one-hot
- my role one-hot (main attacker, co-thrower, defender, bystander)
- talon size, talon==0, first bout, empty table
- bout limit, attack count, remaining capacity, defense count, number of uncovered cards
- N one-hot and number-of-active-players one-hot
- unseen count, finished count, thrower index

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

**Model.** `Linear(911→384)` → 3 pre-LayerNorm residual blocks (384) → LayerNorm, with three heads:

- policy logits over 37 actions, with illegal actions masked to −1e9
- value: the expected `returns()` of the acting seat
- durak logit: BCE against "this seat ended as durak", which gives calibrated win probabilities for the website

The model has about 1.26M parameters.

**PPO.** Training is asynchronous:

- 7 rollout processes (1 torch thread each) write finished trajectories to a queue.
- The learner (4 threads) takes 32768 decisions per iteration and runs 2 epochs with minibatch 4096.
- Clip 0.2, Adam with lr 3e-4 decaying to 1e-4, entropy coefficient 0.01 decaying to 0.003, value coefficient 0.5, durak-BCE coefficient 0.25, grad-norm clip 0.5, and KL early stop at 0.045.
- GAE uses γ=1 and λ=0.95 over each seat's own decisions. The reward is the terminal `returns()[seat]`: durak −1, others +1/(N−1).
- A credit semaphore keeps workers at most about one batch ahead, so samples are typically 1–1.5 policy versions stale. The behaviour log-probs are stored for the PPO ratio.
- Forced moves (exactly one legal action) are played without the network and are not trained on; they are about 35% of all moves.
- Games longer than 2000 moves (rare cycles) are truncated and bootstrapped from the value estimate.

**Self-play setup.**

- N is drawn from {2:30%, 3:15%, 4:25%, 5:20%, 6:10%}.
- 50% of games are pure self-play, with every seat on the latest weights.
- In the other games, 1..N−1 random seats go to one opponent type:
  - a past snapshot from `runs/<name>/pool`, saved every 25 iterations and biased towards recent ones (weight 0.5)
  - the `heuristic` bot (0.5; `--bots` adds others such as `solver`); bots get `game.determinize()` views
  - random (0.05)
- Only learner seats are trained on.

**Solver-terminated rollouts.** In 70% of games (`--solve-frac`), once the talon
is empty, two players are left and at most 10 cards are in play, the exact
solver runs with a 30k-node budget. If it succeeds, the game ends with the exact
result. It is retried only when the card count changes. About half of all games
end this way. This gives exact terminal rewards and matches how the champion
plays endgames. The other 30% are played out, so the policy still learns
endgame play; the champion needs that in proven-lost endgames.

**Champion agent** (`get_agent("champion")`):

- It loads `checkpoints/champion.pt` and hot-reloads it when the file changes, checking at most every 30 s.
- When `durak.solver.applicable(game)` is true (talon empty and two players left, i.e. every game's end), it runs `solver.solve` with a 0.6 s limit:
  - In a proven win or draw it plays the solver's move.
  - In a proven loss every move loses against perfect play, so it keeps the policy's move, which gives the best practical chances.
  - On timeout it falls back to the policy.
- Otherwise it plays the greedy policy. Moves take a few ms; endgame solves take up to about 0.5 s.
- `evaluate(game, player)` returns P(not durak): exact (0/1) when the position is solvable, otherwise `sigmoid(-durak_logit)`.
- It never reads hidden information:
  - The observation uses only the player's own hand, public fields, `known` and the log.
  - The legal mask is only read when `player` is the one to move.
  - A test checks that the real game and its determinizations give identical actions and evaluations.

**Gating.**

- Every `--eval-every` iterations, `gate.py` first measures the checkpoint against random and the heuristic.
- It then plays it in one seat against the current champion in the others, for each N.
- Per N, the score is z = mean(1 − N·D)/sqrt((N−1)/games), which is 0 at equal strength. The per-N scores are combined with the curriculum weights.
- A combined z > 1.28 promotes the checkpoint to `checkpoints/champion.pt`, unless it is significantly worse than the champion against the heuristic (Δz < −1.645). That guards against self-play non-transitivity: at iteration 400 the checkpoint beat the champion head-to-head but had drifted against the heuristic, so it was rejected. Because of that drift, the heuristic's share of training games was raised from 12% to 25% at iteration 477.
- History is in `checkpoints/champion_history.jsonl`.

**PIMC search** (`durak/rl/search.py`; on by default in `"champion"`, off in `"champion_fast"`):

- Applies when two players are active.
- Takes the top policy candidates (at most 4, each with probability ≥3%) and 16 determinizations that are shared across candidates.
- Plays each pair out with the greedy policy, batched, ending with the exact solver at ≤8 cards.
- Picks the best mean return plus 0.1·prior. The time budget is 0.5 s, within a total per-move budget of 0.85 s that also covers the solver.

## Usage

```bash
scripts/train.sh                     # start or resume run "main" (fully detached; PID in runs/main/train.pid)
NAME=main scripts/train.sh --stop    # graceful stop (saves state.pt)
scripts/status.sh [main]             # progress, health stats, latest evals, current champion
tensorboard --logdir runs/main/tb    # curves (train + eval/*)

# resume: just run scripts/train.sh again with the same NAME (reads runs/<name>/state.pt)
# warm start a new run: NAME=exp2 scripts/train.sh --init checkpoints/champion.pt

# evaluation (>=1000 games per N; 95% Wilson CIs; baseline 1/N; 2p also shows win rate)
.venv/bin/python -m durak.rl.evaluate checkpoints/champion.pt --opps random heuristic solver --games 1000 --workers 4
.venv/bin/python -m durak.rl.evaluate agent:champion --opps heuristic solver --games 1000   # with endgame solver
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
| `pool/` | opponent snapshots |

## Throughput (i5-12600K, shared with other jobs)

- Engine with random play: 165–245k steps/s single-threaded.
- Encoding: about 45 µs per decision. The 384×3 network costs 30–50 µs per row at batch 64 (single thread).
- One rollout worker produces about 2.5k trained decisions/s (about 5k total moves/s including forced and opponent moves).
- The learner (4 threads, 2 epochs) is the bottleneck: end to end it runs at **4–7k trained decisions/s** with 6–7 workers, depending on how loaded the machine is (other users' jobs ran at load 30+ during development). That is roughly 15–25M decisions/hour, about 200k games/hour.

## Results so far (2026-10-14, first ~1 h of training)

The proving run reached 2p 56.8% win vs the heuristic after 30 iterations (about 1M decisions) and 68.0% after 60 iterations.
The main run was warm-started from it and has been promoted at iterations 100, 200 and 300.

Every row below has 1000 games per N. The value is the durak rate of our seat with its 95% Wilson CI; the baseline is 1/N.

| agent (network) | opponent | 2p | 3p | 4p | 5p | 6p |
|---|---|---|---|---|---|---|
| policy only (it200) | random | .003 [.001,.009] | .000 [.000,.004] | .000 [.000,.004] | .001 [.000,.006] | .001 [.000,.006] |
| policy only (it200) | heuristic | .241 [.216,.268] | .174 [.152,.199] | .167 [.145,.191] | .154 [.133,.178] | .108 [.090,.129] |
| **champion: policy + solver + PIMC (it200)** | heuristic | **.182 [.159,.207]** | **.145 [.125,.168]** | **.131 [.111,.153]** | **.117 [.099,.138]** | **.079 [.064,.097]** |
| policy only (it200) | solver bot | .496 [.465,.527] | .357 [.328,.387] | .266 [.240,.294] | .191 [.168,.217] | .190 [.167,.215] |
| **champion (it200)** | solver bot | **.376 [.347,.406]** | – | **.210 [.186,.236]** | – | – |
| baseline 1/N | | .500 | .333 | .250 | .200 | .167 |

Ablations on the it100 network:

- Adding the endgame solver to the policy vs the heuristic: 2p durak .250 → .210, 4p .193 → .154.
- PIMC on top of the solver, head-to-head in 2p: 56.0% win [52.0, 59.9] over 600 games.
