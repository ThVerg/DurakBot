// The trained RL champion in the browser (port of durak/agents/champion.py).
//
// * Exact endgame solver whenever it applies (talon empty and two players left):
//   in a proven win/draw it plays the solver's move; in a proven loss or on
//   timeout it keeps the policy's move (best practical chances).
// * Otherwise the policy network (greedy), refined by PIMC search within a
//   per-move time budget scaled for a single-threaded Web Worker: full policy
//   rollouts with 2 active players, value-cutoff rollouts with 3+;
//   determinizations are belief-weighted (belief head). "champion_fast" is
//   policy + solver only.
//
// Uses only the acting player's information: every entry point first takes a
// determinization of the game for `player` (resampling everything that player
// cannot see), then encodes the player's own hand, public state, `known` and
// the public log; the solver only runs in perfect-information positions.

import { PASS } from "../engine";
import type { DurakGame } from "../engine";
import { Rng } from "../rng";
import { BELIEF_STRIDE, type PolicyModel } from "./model";
import { NUM_ACTIONS, PublicTracker, buildBatch, canonCardIndex, encodeParts, toCanonAction } from "./encoding";
import { nowSec } from "./runtime";
import { pimcAction, type PimcResult } from "./search";
import type { EndgameSolver } from "./solver";
import type { Agent } from "./types";

export interface ChampionOptions {
  seed?: number;
  useSolver: boolean;
  /** solver budget per move, seconds */
  solverTime: number;
  temperature: number;
  search: boolean;
  /** determinizations with 2 active players (full rollouts) */
  searchDets: number;
  /** max PIMC time per move, seconds */
  searchTime: number;
  /** total time per move incl. solver, seconds */
  moveBudget: number;
  /** search with 3+ active players too (value-cutoff rollouts) */
  searchMulti: boolean;
  beliefDets: boolean;
  multiDepth: number;
  multiDets: number;
  maxCands: number;
  /** minimum budget left for search to be worth starting, seconds */
  minSearchTime: number;
}

/** Browser defaults (single-threaded wasm): about 0.5 s per move. */
export const CHAMPION_DEFAULTS: ChampionOptions = {
  useSolver: true,
  solverTime: 0.3,
  temperature: 0,
  search: true,
  searchDets: 12,
  searchTime: 0.45,
  moveBudget: 0.5,
  searchMulti: true,
  beliefDets: true,
  multiDepth: 2,
  multiDets: 12,
  maxCands: 4,
  minSearchTime: 0.12,
};

export interface ChampionDecision {
  action: number;
  /** policy_timeout: search ran but no determinization finished in time */
  source: "forced" | "solver" | "search" | "policy" | "policy_timeout";
  ms: number;
  search?: PimcResult | null;
  solverValue?: number;
}

export class ChampionAgent implements Agent {
  name = "champion";
  readonly opts: ChampionOptions;
  readonly model: PolicyModel;
  readonly solver: EndgameSolver | null;
  private rng: Rng;
  private tracker: PublicTracker | null = null;
  private trackerLog: [number, number][] = [];
  private trackerFirst = -1;
  /** Details of the last act() call (diagnostics). */
  last: ChampionDecision | null = null;

  constructor(model: PolicyModel, solver: EndgameSolver | null, opts: Partial<ChampionOptions> = {}) {
    this.opts = { ...CHAMPION_DEFAULTS, ...opts };
    this.model = model;
    this.solver = solver;
    this.rng = new Rng(this.opts.seed);
  }

  reset(): void {
    this.tracker = null;
    this.trackerLog = [];
  }

  /** The game as `player` may see it: hidden cards resampled. */
  private view(game: DurakGame, player: number): DurakGame {
    return game.determinize(player, this.rng);
  }

  // ------------------------------------------------------------ helpers
  /** Public-log tracker, reused incrementally when the log extends the one
   * seen before (the session hands us a fresh copy every move). */
  private trackerFor(game: DurakGame): PublicTracker {
    const log = game.log;
    const t = this.tracker;
    const first = log.length ? log[0][0] : game.attacker;
    if (t !== null && t.n === game.numPlayers && t.trump === game.trump && this.trackerFirst === first &&
      t.nEvents <= log.length) {
      const prev = this.trackerLog;
      let same = prev.length === t.nEvents;
      for (let i = 0; same && i < t.nEvents; i++) same = prev[i][0] === log[i][0] && prev[i][1] === log[i][1];
      if (same) {
        t.sync(game);
        this.trackerLog = log.map((e) => [e[0], e[1]] as [number, number]);
        return t;
      }
    }
    const nt = PublicTracker.fromGame(game);
    this.tracker = nt;
    this.trackerFirst = first;
    this.trackerLog = log.map((e) => [e[0], e[1]] as [number, number]);
    return nt;
  }

  private async forward(game: DurakGame, player: number) {
    const parts = encodeParts(game, player, this.trackerFor(game));
    const { obs, mask } = buildBatch([parts]);
    const out = await this.model.run(obs, mask, 1);
    let belief: Float32Array | null = null;
    if (out.belief) {
      // canonical [36, 6] -> real card order
      const idx = canonCardIndex(parts.canon);
      belief = new Float32Array(BELIEF_STRIDE);
      for (let c = 0; c < 36; c++) for (let l = 0; l < 6; l++) belief[c * 6 + l] = out.belief[idx[c] * 6 + l];
    }
    return {
      logits: out.logits.slice(0, NUM_ACTIONS), value: out.value[0], durak: out.durak[0], canon: parts.canon, belief,
    };
  }

  /** Policy over the legal actions plus the belief for the same position
   * (returned together: concurrent calls on this agent cannot mix them up). */
  private async policyOf(game: DurakGame, player: number): Promise<{ probs: Map<number, number>; belief: Float32Array | null }> {
    const { logits, canon, belief } = await this.forward(game, player);
    const legal = game.legalActions();
    const cl = legal.map((a) => logits[toCanonAction(a, canon)]);
    let m = -Infinity;
    for (const x of cl) m = Math.max(m, x);
    let z = 0;
    for (const x of cl) z += Math.exp(x - m);
    const out = new Map<number, number>();
    legal.forEach((a, i) => out.set(a, Math.exp(cl[i] - m) / z));
    return { probs: out, belief };
  }

  /** Policy distribution over real legal actions of the player to move. */
  async policy(game: DurakGame, player: number): Promise<Map<number, number>> {
    return (await this.policyOf(this.view(game, player), player)).probs;
  }

  /** [36 real cards x 6 locations (opponent rel seat 1..5, talon)] probabilities, or null. */
  async belief(game: DurakGame, player: number): Promise<Float32Array | null> {
    return (await this.forward(this.view(game, player), player)).belief;
  }

  /** Exact (value, action) when the position is perfect information. */
  solve(game: DurakGame, player: number, timeLimit: number): [number, number] | null {
    if (!this.solver) return null;
    try {
      return this.solver.solve(game, player, timeLimit);
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- act
  async act(game: DurakGame, player: number): Promise<number> {
    return (await this.decide(game, player)).action;
  }

  async decide(gameIn: DurakGame, player: number): Promise<ChampionDecision> {
    const t0 = nowSec();
    const game = this.view(gameIn, player);
    const done = (d: Omit<ChampionDecision, "ms">): ChampionDecision => {
      this.last = { ...d, ms: (nowSec() - t0) * 1000 };
      return this.last;
    };
    const legal = game.legalActions();
    if (legal.length === 1) return done({ action: legal[0], source: "forced" });
    const o = this.opts;
    if (o.useSolver) {
      const res = this.solve(game, player, o.solverTime);
      // proven win/draw: the solver's move. Proven loss: every move loses vs
      // perfect play, so keep the policy's (practical) choice.
      if (res !== null && res[0] >= 0 && legal.includes(res[1])) {
        return done({ action: res[1], source: "solver", solverValue: res[0] });
      }
    }
    const { probs, belief } = await this.policyOf(game, player);
    const budget = Math.min(o.searchTime, o.moveBudget - (nowSec() - t0));
    const nActive = game.numPlayers - game.finished.length;
    let timedOut: PimcResult | null = null;
    if (o.search && budget > o.minSearchTime && (nActive === 2 || o.searchMulti)) {
      const bel = o.beliefDets ? belief : null;
      const kw =
        nActive === 2
          ? { nDet: o.searchDets, mode: "rollout" as const }
          : { nDet: o.multiDets, mode: "value" as const, depth: o.multiDepth };
      const r = await pimcAction(this.model, this.solver, game, player, this.trackerFor(game), probs, this.rng, {
        ...kw,
        timeBudget: budget,
        belief: bel,
        maxCands: o.maxCands,
      });
      if (r !== null && r.action >= 0) return done({ action: r.action, source: "search", search: r });
      if (r !== null) timedOut = r;
    }
    if (o.temperature > 0) {
      const acts = [...probs.keys()];
      const w = acts.map((a) => (probs.get(a) as number) ** (1.0 / o.temperature));
      let r = this.rng.random() * w.reduce((x, y) => x + y, 0);
      for (let i = 0; i < acts.length; i++) {
        r -= w[i];
        if (r <= 0) return done({ action: acts[i], source: "policy" });
      }
      return done({ action: acts[acts.length - 1], source: "policy" });
    }
    let best = PASS;
    let bp = -1;
    for (const [a, p] of probs) {
      if (p > bp) {
        bp = p;
        best = a;
      }
    }
    return done({ action: best, source: timedOut ? "policy_timeout" : "policy", search: timedOut });
  }

  // ----------------------------------------------------------- evaluate
  /** Estimated probability that `player` is NOT the durak. */
  async evaluate(gameIn: DurakGame, player: number): Promise<number> {
    if (gameIn.done) return gameIn.loser === player ? 0.0 : 1.0;
    if (!gameIn.activePlayers.includes(player)) return 1.0;
    const game = this.view(gameIn, player);
    if (this.opts.useSolver) {
      const res = this.solve(game, player, Math.min(this.opts.solverTime, 0.3));
      if (res !== null) return res[0] < 0 ? 0.0 : 1.0;
    }
    const { durak } = await this.forward(game, player);
    return 1.0 / (1.0 + Math.exp(durak));
  }
}
