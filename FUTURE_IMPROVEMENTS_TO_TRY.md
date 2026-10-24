# Future improvements to try

A working list for picking the project up again. Within each section the ideas are ordered by expected value per hour of work. Each one says why it might help, what to try and how to tell whether it worked.

## Where things stand (2026-10-24)

- **Training is stopped.** The main run stopped cleanly at iteration 380,257: 12.8 billion trained decisions, 293 million self-play games, 244 hours of training over 10 days. `runs/main/state.pt` (weights, optimiser and counters) and `runs/main/league.json` hold everything needed to resume (see [Resuming](#resuming-the-main-run)).
- **The champion is iteration 367,400.** It is deployed on the server and on GitHub Pages. As one seat against a field of heuristic bots (policy plus exact endgame solver, no search), it is the durak in 13.4% of 2-player games and 9.2% / 8.6% / 7.3% / 6.0% at 3–6 players. Against the heuristic with perfect endgames the rates are 21.9% / 13.8% / 12.3% / 10.1% / 8.1%.
- **Progress has nearly stopped.** From iteration 197,800 to 367,400, the 2p durak rate against the heuristic fell from 14.7% to 13.4%, and 3p improved a little. At 4–6 players nothing moved. That is 180k iterations (about 5 days) for about one point. The gate promoted 5 of 864 candidates, and stage-1 z averaged −0.18 against the champion of the day. Most candidates are copies of the champion's strength, not improvements.
- **The bottleneck is the learner.** The bottleneck is the learner, at about 11k decisions/s with 4 PyTorch threads; more threads make it slower on this machine. The network is small: a 1.42M-parameter residual MLP, 384 wide with 3 blocks, over a 918-float hand-crafted observation.
- **The schedules ended long ago.** The learning rate reached its floor of 1e-4 at iteration 20k, and the entropy coefficient reached its floor of 0.003 at iteration 5k. Policy entropy is about 0.1 nats per decision. League members all have hardness about 0.99, meaning the learner beats every snapshot at par, so the league no longer pushes.

Conclusion: more of the same compute won't help. The next gains will come from changing the optimisation, the model, or what the policy learns from.

## 1. Playing strength

### 1.1 Anneal the learning rate (cheapest, try first)

A constant LR of 1e-4 leaves gradient noise that a plateaued PPO run often can't get past. A lower LR with a larger batch usually gives a final step up.

- **Try:** fork from the champion into a new run. `--init` starts a new run from a checkpoint, and `--lr`/`--lr-final`/`--lr-decay-iters` set the schedule. Settings: lr 1e-4 decaying to 1e-5 over 30k iterations, and `--batch-steps 65536` with the same minibatch.
  ```bash
  NAME=anneal scripts/train.sh --init checkpoints/champion.pt --lr 1e-4 --lr-final 1e-5 \
      --lr-decay-iters 30000 --batch-steps 65536 --no-gate
  ```
  `--no-gate` keeps it from touching `checkpoints/champion.pt` while it is an experiment.
- **Measure:** after one to two days, run `durak.rl.tournament` comparing its checkpoints with the champion, then confirm the best on fresh deals with `--seed-offset`. That is the protocol from the 2026-10-19 tournament in `durak/rl/README.md`.
- **Variant:** a slightly higher entropy floor, 0.005, to check whether the near-deterministic policy has stopped exploring. Test it in a separate arm, not combined with the LR change.

### 1.2 A bigger network

The network has stopped improving, which is what a too-small function approximator looks like. 1.42M parameters is tiny for a 918-dimensional imperfect-information game with five player counts.

- **Deeper is free to start:** `transfer()` in `durak/rl/model.py` copies equal shapes and keeps new residual blocks at their identity init. So `--init checkpoints/champion.pt --blocks 6` starts out computing exactly the champion's function. Widening (384 → 768) is **not** supported yet. It needs a Net2WiderNet-style function-preserving copy in `transfer()`, or training from scratch.
- **Cost:** the learner is the bottleneck, so a 4x larger network is roughly 3–4x fewer samples per hour on this CPU. Compare at equal wall-clock time against an equal-time continuation of the champion, as the 1-vs-2-epoch A/B did. A GPU would change this trade-off completely (see 4.4).
- **Measure:** use a tournament, as in 1.1. Watch `ev` (explained variance, currently about 0.5) and `bel_acc` (56%). If those improve, the extra capacity is being used.

### 1.3 Learn from search (expert iteration)

Search adds strength at play time: at iteration 1,500 the full agent avoided being the durak in 70.8% of 2p games against the `solver` bot, against 67.8% for the network alone against the equivalent perfect-endgame heuristic. Doubling the 2p search budget then won 57% of head-to-head games. The policy never learns from that search. The research log dismissed expert iteration as "1000x too slow". That is true for every decision, but it doesn't have to be every decision.

- **Try:** a side process that takes a small sample of positions from self-play (for example 1%, favouring decisions with high policy entropy). It runs the PIMC search on them with the existing `durak/rl/search.py` and writes (observation, search distribution, search value) to a buffer. Add a distillation loss to the learner: cross-entropy towards the search distribution, with a small weight next to PPO. At about 0.5 s per position, 4 spare cores give about 30k labelled positions a day, enough for a distillation term.
- **Watch out:** search targets are only as good as the value and belief heads. Keep the weight small and check that `champion_fast` improves against the current champion's `champion_fast`, not only against the heuristic.

### 1.4 League diversity and exploiters

Every league member sits at hardness about 0.99, so prioritized fictitious self-play has nothing to prioritise. The learner may have holes that none of its own snapshots exploit.

- **Try A, an exploiter:** train a separate run whose only opponent is the frozen champion, and check how fast it pushes the champion's durak rate well above par. If it does so quickly, add exploiter snapshots to the main league. The trainer has no fixed-checkpoint opponent option yet. `--selfplay-frac 0 --w-snap 0 --w-random 0 --bots champion_fast` may work, because `--bots` takes any registered agent, but check first that it loads in the rollout workers and doesn't hot-reload. A proper `--opponent-ckpt` flag is the clean fix.
- **Try B, older opponents:** keep some much older snapshots in the pool, such as the frozen 1,500, 50,000 and 100,000 networks already in `checkpoints/`, at a small weight, so that the learner does not forget how to beat weaker styles.
- **Measure:** use the head-to-head against the exploiter itself. A lower exploitability is the point, even if heuristic numbers don't move.

### 1.5 Multiplayer search and the 4–6 player games

The 4–6p rates have been flat since about iteration 190k, and those games are 55% of training. The multiplayer search is shallow: 12 determinizations, a two-bout rollout, then the value head.

- **Try:** deeper rollouts, more determinizations, or ISMCTS for 3+ active players. Run each as a single-seat A/B against non-searching champions, like the multiplayer PIMC A/B in the research log (which gave z ≈ +5).
- **Try:** a per-N training mix that follows where progress is possible. The current mix is 2p 30%, 3p 15%, 4p 25%, 5p 20%, 6p 10%.
- **Try:** an N-specific final layer, so that 2p and 6p play don't compete for the same weights.

### 1.6 Observation and architecture

The 918-float observation hand-encodes card counting and the public move log. A model that reads the move sequence itself (a small transformer over the bout history, or a recurrent state) could track opponents' likely holdings better than the belief head's 56% card-location accuracy.

This is a large change: a new encoder, the ONNX export, the TS encoding in `web/src/local/ai/encoding.ts`, and the parity fixtures. Try it only after 1.1–1.3.

## 2. Evaluation

### 2.1 Refit the rating ladder

The Elo ratings in the lobby and the README come from `runs/ladder.json`, fitted on 2026-10-14 when the champion was around iteration 2,400. Refit it with the current champion and the four difficulty levels (`durak/ladder.py`; see `docs/EVALUATION.md`). Then re-export the static data with `scripts/export_static_data.py`.

### 2.2 Make the gate stricter against repeated testing

At one gate per 100 iterations, the chance that a candidate no better than the champion gets through is about 1 in 400. Over 864 gates that is about 2 expected false promotions, against the 5 actual ones.

- **Option:** gate less often, for example every 500 iterations.
- **Option:** use a sequential test (SPRT) on the paired differences instead of two fixed stages.
- **Option:** after each promotion, automatically run a larger tournament of the new champion against the previous one, and roll back if it isn't better. The running estimates in `checkpoints/champion_stats.json` already hold what is needed to compare successive champions.

### 2.3 Test against people

"Superhuman" is shown against bots, not strong humans. Ideas:

- an opt-in "send this game" button on the site that posts a finished game (no personal data) to a small collection endpoint;
- a session with experienced Durak players on the local server, which records every game in `server/data/games.db`.

Calibrate the four difficulty levels against real players at the same time.

### 2.4 Repeat the single-seed A/B tests

The research log's A/B tests (belief features, epochs, search budgets) each used a single training seed. The belief-as-features result especially ("no measurable gain") is worth a second seed before building on it.

## 3. Web app and the static build

### 3.1 Multi-threaded search on GitHub Pages

The browser search runs single-threaded because GitHub Pages can't send the cross-origin isolation headers (COOP/COEP) that `SharedArrayBuffer` needs. A service worker that adds them (the `coi-serviceworker` approach) would allow onnxruntime-web threads and parallel determinizations. With that, the browser champion could search as much as the server's 0.8 s budget allows instead of 0.5 s.

Check that the second-load reload it needs doesn't break the first-visit tutorial, and keep the single-thread path as a fallback.

### 3.2 A smaller first download

The first visit downloads about 17 MB: the 5.7 MB fp32 model plus the 11 MB onnxruntime-web wasm runtime.

- Quantise the model to fp16 or int8 (2–3 MB). `tests/local/ai/model.test.ts` already checks argmax agreement against torch, so the cost in move agreement is measurable directly.
- Ship a smaller onnxruntime-web build. The model uses only 16 basic op types (Gemm, LayerNormalization, Relu, Softmax, Where, Slice and a few shape ops), so a custom build with just those kernels would be much smaller.

### 3.3 One command to publish a new champion

Today publishing means `scripts/refresh_browser_model.sh --all`, then `scripts/export_static_data.py`, then a commit of `checkpoints/champion.pt`, `web/public/ai/`, `web/public/static-data/` and `web/test-fixtures/ai/model.json.gz`, then a push. A single `scripts/publish_champion.sh` should run those steps, then the vitest suite, and stop before committing if anything fails. It should also update the champion iteration in `README.md` and `docs/TRAINING.md`, which are written by hand today.

### 3.4 Re-measure the browser champion

`docs/STATIC_BUILD.md` reports the in-browser champion's strength (12.1% in 2-player and 8.5% in 4-player games, against the heuristic bot over 1,000 games). That was measured with iteration 197,800. Re-run it for the current model.

### 3.5 Features

- **Playing with friends:** several humans at one table (needs a server, or WebRTC between browsers).
- **Statistics across devices:** stats are kept per browser in IndexedDB; an export/import file would be the simple version.
- **Rule variants**, each needing engine support, an observation flag and retraining:
  - Perevodnoy (transfer) Durak, the most popular variant;
  - everyone may throw in, not only the neighbours;
  - a 24-card deck.

  One network with a variant flag in the observation is the natural design; the engine `Config` is the place to add them.

## 4. Engineering

### 4.1 The trainer leaves its gate running on shutdown

When the trainer gets SIGTERM it saves its state and stops the rollout workers. The background `durak.rl.gate` process it spawned (`eval_proc` in `durak/rl/train.py`) keeps running, though; it had to be killed by hand on 2026-10-24. Terminate `eval_proc` in the `finally:` block. A half-finished gate never promotes, so killing it is safe.

### 4.2 Prune old checkpoints

`runs/main/ckpt/` holds 3,797 checkpoints (21 GB). Keep every 10,000th iteration, every promoted champion and the last 50, and delete the rest, or have the trainer thin them as it does the league pool.

### 4.3 Python tests in CI

The Pages workflow runs only the web tests (`npm test`). Add a job for the fast Python suites (engine, agents, server API), with the solver's C core built by `gcc`, so that a rule change can't silently break the server.

### 4.4 A GPU

Everything here was sized for a 16-thread CPU. With a GPU the learner stops being the bottleneck. Then the rollout workers set the pace (about 2.5k decisions/s each), and 1.2 (a bigger network) and 1.3 (search targets) become cheap.

## Resuming the main run

The run resumes from `runs/main/state.pt` and `runs/main/league.json` when started under the same name. Pass the gate's anchor arguments again:

```bash
scripts/train.sh --gate-args "--anchors checkpoints/frozen_it200.pt checkpoints/frozen_it667.pt"
scripts/status.sh main          # progress, gates, league and champion estimate
scripts/train.sh --stop         # stop gracefully (saves state)
```

Given the plateau, a fresh experiment from section 1 forked from `checkpoints/champion.pt` is a better use of the machine than resuming as is.
