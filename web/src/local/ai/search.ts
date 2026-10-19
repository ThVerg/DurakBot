// PIMC search (Perfect-Information Monte Carlo) over determinizations: port of
// durak/rl/search.py, with batched network calls for the browser.
//
// For the player to move: take the top policy candidates, sample `nDet`
// determinizations of the hidden cards (uniform, or belief-weighted from the
// network's belief head under the exact per-location card counts) and evaluate
// every (candidate, determinization) pair on the same determinizations (paired
// comparison). Score = mean return of `player` + priorW * policy prior.
//
// * mode "rollout": play to the end with the greedy policy for every seat,
//   ending early with the exact solver once a small 2-player endgame is reached.
// * mode "value": play greedily until `depth` more bouts have ended and it is
//   `player`'s turn again (or the game ends / is solved), then use the value head.
//
// All live simulations advance in lock-step, one batched network call per step.
// Only determinizations whose evaluations all finished within the time budget
// are counted.

import { BIT, maskToList, popcount } from "../cards";
import type { DurakGame } from "../engine";
import type { Rng } from "../rng";
import { NUM_ACTIONS, OBS_DIM, PublicTracker, encodeParts, inversePerm, writeRow } from "./encoding";
import type { PolicyModel } from "./model";
import { nowSec } from "./runtime";
import type { EndgameSolver } from "./solver";

/** Sample hidden cards from belief `probs` [36 real cards x 6 locations:
 * opponent rel seat 1..5, talon] subject to the exact unknown-card counts. */
export function beliefDeterminize(game: DurakGame, player: number, probs: Float32Array | number[], rng: Rng): DurakGame {
  const n = game.numPlayers;
  const g = game.clone();
  const pool = maskToList(game.unseenMask(player));
  rng.shuffle(pool);
  const cap = [0, 0, 0, 0, 0, 0];
  for (let k = 1; k < n; k++) {
    const q = (player + k) % n;
    cap[k - 1] = popcount(game.hands[q]) - popcount(game.known[q]);
  }
  cap[5] = game.talon.length ? game.talon.length - 1 : 0;
  const assign = [0, 0, 0, 0, 0, 0];
  const talonCards: number[] = [];
  const w = [0, 0, 0, 0, 0, 0];
  for (const c of pool) {
    let tot = 0;
    for (let l = 0; l < 6; l++) {
      w[l] = cap[l] > 0 ? probs[c * 6 + l] : 0.0;
      tot += w[l];
    }
    if (tot <= 1e-12) {
      tot = 0;
      for (let l = 0; l < 6; l++) {
        w[l] = cap[l] > 0 ? 1 : 0;
        tot += w[l];
      }
    }
    let r = rng.random() * tot;
    let loc = 5;
    for (let l = 0; l < 6; l++) {
      r -= w[l];
      if (r <= 0 && w[l] > 0) {
        loc = l;
        break;
      }
    }
    if (cap[loc] <= 0) loc = cap.findIndex((x) => x > 0); // numerical edge
    cap[loc] -= 1;
    if (loc === 5) talonCards.push(c);
    else assign[loc] += BIT[c];
  }
  for (let k = 1; k < n; k++) {
    const q = (player + k) % n;
    g.hands[q] = game.known[q] + assign[k - 1];
  }
  if (game.talon.length) {
    rng.shuffle(talonCards);
    g.talon = [game.trumpCard, ...talonCards];
  }
  return g;
}

export interface PimcOptions {
  nDet: number;
  maxCands: number;
  minProb: number;
  priorW: number;
  /** seconds */
  timeBudget: number;
  maxSteps: number;
  /** belief probabilities in real card order [36 * 6], or null for uniform determinizations */
  belief: Float32Array | null;
  mode: "rollout" | "value";
  depth: number;
  /** solve_small limits used inside rollouts */
  smallCards: number;
  smallNodes: number;
}

export const DEFAULT_PIMC: PimcOptions = {
  nDet: 16,
  maxCands: 4,
  minProb: 0.03,
  priorW: 0.1,
  timeBudget: 0.7,
  maxSteps: 600,
  belief: null,
  mode: "rollout",
  depth: 2,
  smallCards: 10,
  smallNodes: 5000,
};

export interface PimcResult {
  /** best action, or -1 when no determinization finished within the budget */
  action: number;
  /** mean return of `player` per candidate */
  means: Map<number, number>;
  /** determinizations that finished */
  completed: number;
  /** network rows evaluated */
  rows: number;
  rounds: number;
}

interface Sim {
  g: DurakGame;
  tr: PublicTracker;
  ci: number;
  res: number | null;
}

/** Best action by PIMC (action -1 if nothing finished in time), or null if
 * not worth searching (fewer than two candidates). */
export async function pimcAction(
  model: PolicyModel,
  solver: EndgameSolver | null,
  game: DurakGame,
  player: number,
  tracker: PublicTracker,
  probs: Map<number, number>,
  rng: Rng,
  options: Partial<PimcOptions> = {},
): Promise<PimcResult | null> {
  const o: PimcOptions = { ...DEFAULT_PIMC, ...options };
  // candidates: probability >= minProb, most likely first (stable on ties)
  const cands = [...probs.entries()]
    .filter(([, p]) => p >= o.minProb)
    .sort((x, y) => y[1] - x[1])
    .slice(0, o.maxCands)
    .map(([a]) => a);
  if (cands.length < 2) return null;
  const t0 = nowSec();
  const dets: DurakGame[] = [];
  for (let i = 0; i < o.nDet; i++) {
    dets.push(o.belief ? beliefDeterminize(game, player, o.belief, rng) : game.determinize(player, rng));
  }
  const baseBouts = game.boutIndex;
  const logCap = o.maxSteps + game.log.length;
  const nPl = game.numPlayers;
  const sims: Sim[] = [];
  for (const d of dets) {
    cands.forEach((a, ci) => {
      const g = d.clone();
      const tr = tracker.clone();
      const p = g.currentPlayer;
      g.step(a);
      tr.event(p, a);
      sims.push({ g, tr, ci, res: null });
    });
  }
  let live = sims.map((_, i) => i);
  const obs = new Float32Array(sims.length * OBS_DIM);
  const mask = new Float32Array(sims.length * NUM_ACTIONS);
  let rows = 0;
  let rounds = 0;
  while (live.length) {
    if (nowSec() - t0 > o.timeBudget) break;
    const pend: number[] = [];
    const leaf: number[] = [];
    for (const i of live) {
      const s = sims[i];
      const g = s.g;
      for (;;) {
        if (g.done) {
          s.res = g.returns()[player];
          break;
        }
        if (solver) {
          const r = solver.solveSmall(g, o.smallCards, o.smallNodes);
          if (r !== null) {
            s.res = r.returns[player];
            break;
          }
        }
        if (!g.isActive(player)) {
          s.res = 1.0 / (nPl - 1); // out of the game (not durak): exact payoff
          break;
        }
        const legal = g.legalMask();
        if (popcount(legal) === 1) {
          const a = legal >= BIT[36] ? 36 : maskToList(legal)[0];
          const p = g.currentPlayer;
          g.step(a);
          s.tr.event(p, a);
          continue;
        }
        if (o.mode === "value" && g.currentPlayer === player && g.boutIndex - baseBouts >= o.depth) leaf.push(i);
        else pend.push(i);
        break;
      }
    }
    const batch = [...leaf, ...pend];
    if (!batch.length) break;
    const canons: number[][] = [];
    batch.forEach((i, j) => {
      const s = sims[i];
      const who = j < leaf.length ? player : s.g.currentPlayer;
      const parts = encodeParts(s.g, who, s.tr);
      canons.push(parts.canon);
      writeRow(parts, obs, mask, j);
    });
    const out = await model.run(obs, mask, batch.length);
    rows += batch.length;
    rounds += 1;
    const nxt: number[] = [];
    for (let j = 0; j < leaf.length; j++) sims[leaf[j]].res = out.value[j];
    for (let j = leaf.length; j < batch.length; j++) {
      const i = batch[j];
      const s = sims[i];
      const base = j * NUM_ACTIONS;
      let ca = 0;
      let bv = out.logits[base];
      for (let a = 1; a < NUM_ACTIONS; a++) {
        if (out.logits[base + a] > bv) {
          bv = out.logits[base + a];
          ca = a;
        }
      }
      const inv = inversePerm(canons[j]);
      const a = ca === 36 ? 36 : inv[(ca / 9) | 0] * 9 + (ca % 9);
      const p = s.g.currentPlayer;
      s.g.step(a);
      s.tr.event(p, a);
      if (s.g.log.length > logCap) s.res = 0.0;
      else nxt.push(i);
    }
    live = nxt;
  }
  // paired comparison over determinizations whose evaluations all finished
  const k = cands.length;
  const tot = new Array(k).fill(0);
  let cnt = 0;
  for (let di = 0; di < o.nDet; di++) {
    const block = sims.slice(di * k, (di + 1) * k);
    if (block.every((s) => s.res !== null)) {
      for (const s of block) tot[s.ci] += s.res as number;
      cnt += 1;
    }
  }
  if (cnt === 0) return { action: -1, means: new Map(), completed: 0, rows, rounds };
  const means = new Map<number, number>();
  let best = cands[0];
  let bestScore = -Infinity;
  cands.forEach((a, i) => {
    const m = tot[i] / cnt;
    means.set(a, m);
    const sc = m + o.priorW * (probs.get(a) as number);
    if (sc > bestScore) {
      bestScore = sc;
      best = a;
    }
  });
  return { action: best, means, completed: cnt, rows, rounds };
}
