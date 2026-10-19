// Difficulty levels for human opponents (port of durak/agents/levels.py):
// novice, intermediate, expert, grandmaster.
//
// Every level plays from the champion's policy network, so its mistakes are
// moves the network itself considers plausible. Strength is controlled by:
// * temperature: softens the policy before sampling (1 = as trained);
// * topP: nucleus cut-off, only moves covering topP of the mass are played;
// * useSolver: perfect endgame play when the position is solvable;
// * search: the champion's PIMC search;
// * blunder: probability (per player count) of a "beginner move" instead of the
//   policy move: legal, natural-looking but unskilled (lead any non-trump, beat
//   with any beater, sometimes add or throw in, take when unable to beat).
// "grandmaster" is the full champion (policy + endgame solver + search).

import { rankOf, suitOf } from "../cards";
import { DEFEND, PASS, type DurakGame } from "../engine";
import { Rng } from "../rng";
import { ChampionAgent, type ChampionOptions } from "./champion";
import type { PolicyModel } from "./model";
import type { EndgameSolver } from "./solver";
import type { Agent } from "./types";

export interface LevelConfig {
  temperature: number;
  topP: number;
  useSolver: boolean;
  search: boolean;
  blunder: number | Record<number, number>;
  description: string;
}

export const LEVELS: Record<string, LevelConfig> = {
  novice: {
    temperature: 1.0,
    topP: 0.9,
    useSolver: false,
    search: false,
    blunder: { 2: 0.9, 3: 0.95, 4: 1.0, 5: 1.0, 6: 1.0 },
    description:
      "A beginner: knows the rules and plays natural-looking cards, but doesn't count " +
      "cards, spends trumps freely and throws in more or less at random.",
  },
  intermediate: {
    temperature: 1.0,
    topP: 0.9,
    useSolver: false,
    search: false,
    blunder: { 2: 0.5, 3: 0.5, 4: 0.55, 5: 0.5, 6: 0.55 },
    description:
      "A casual player: often finds the good move but about every other decision " +
      "is made on instinct, without counting cards or thinking about the endgame.",
  },
  expert: {
    temperature: 0.0,
    topP: 1.0,
    useSolver: true,
    search: false,
    blunder: { 2: 0.3, 3: 0.22, 4: 0.18, 5: 0.17, 6: 0.2 },
    description:
      "A strong club player: usually plays the champion network's best move and " +
      "endgames perfectly, but has occasional lapses in concentration.",
  },
  grandmaster: {
    temperature: 0.0,
    topP: 1.0,
    useSolver: true,
    search: true,
    blunder: 0.0,
    description:
      "The full champion: network policy, look-ahead search when two players remain " +
      "and a perfect endgame solver. Our strongest bot.",
  },
};

export class LevelAgent implements Agent {
  name: string;
  readonly cfg: LevelConfig;
  readonly champion: ChampionAgent;
  private rng: Rng;

  constructor(level: string, model: PolicyModel, solver: EndgameSolver | null,
    overrides: Partial<LevelConfig> & Partial<ChampionOptions> & { seed?: number } = {}) {
    const base = LEVELS[level];
    if (!base) throw new Error(`unknown level ${level}`);
    this.cfg = { ...base };
    for (const k of Object.keys(this.cfg) as (keyof LevelConfig)[]) {
      if (k in overrides) (this.cfg as unknown as Record<string, unknown>)[k] = (overrides as Record<string, unknown>)[k];
    }
    this.name = level;
    this.rng = new Rng(overrides.seed);
    const champOpts: Partial<ChampionOptions> = { ...overrides, useSolver: this.cfg.useSolver, search: this.cfg.search };
    delete (champOpts as Record<string, unknown>).temperature;
    this.champion = new ChampionAgent(model, solver, champOpts);
    this.champion.name = level;
  }

  get description(): string {
    return this.cfg.description;
  }

  reset(): void {
    this.champion.reset();
  }

  private blunderRate(n: number): number {
    const b = this.cfg.blunder;
    return typeof b === "number" ? b : b[n] ?? 0.0;
  }

  async act(gameIn: DurakGame, player: number): Promise<number> {
    const game = gameIn.determinize(player, this.rng);
    const legal = game.legalActions();
    if (legal.length === 1) return legal[0];
    const b = this.blunderRate(game.numPlayers);
    if (b > 0 && this.rng.random() < b) return this.beginnerMove(game, legal);
    if (this.cfg.temperature <= 0) return this.champion.act(game, player);
    if (this.champion.opts.useSolver) {
      const res = this.champion.solve(game, player, this.champion.opts.solverTime);
      if (res !== null && res[0] >= 0 && legal.includes(res[1])) return res[1];
    }
    const probs = await this.champion.policy(game, player);
    return this.sample(probs);
  }

  evaluate(game: DurakGame, player: number): Promise<number> {
    return this.champion.evaluate(game, player);
  }

  policy(game: DurakGame, player: number): Promise<Map<number, number>> {
    return this.champion.policy(game, player);
  }

  /** Legal, natural-looking but unskilled move (no counting, no planning). */
  private beginnerMove(game: DurakGame, legal: number[]): number {
    const trump = game.trump;
    const cards = legal.filter((a) => a !== PASS);
    const nonTrump = cards.filter((c) => suitOf(c) !== trump);
    if (game.phase === DEFEND) {
      if (!cards.length) return PASS;
      if (this.rng.random() < 0.1) return PASS; // takes too readily now and then
      return this.rng.choice(cards); // any beater, trumps included
    }
    if (!game.attackCards.length) {
      const pool = nonTrump.length ? nonTrump : cards;
      pool.sort((x, y) => rankOf(x) - rankOf(y));
      // tends to lead lowish cards, but not reliably the lowest
      return pool[Math.min(pool.length - 1, Math.floor(this.rng.random() ** 2 * pool.length))];
    }
    if (!cards.length) return PASS;
    // add / throw in: sometimes, mostly non-trumps
    const pool = nonTrump.length && this.rng.random() < 0.85 ? nonTrump : cards;
    if (this.rng.random() < 0.5) return this.rng.choice(pool);
    return PASS;
  }

  private sample(probs: Map<number, number>): number {
    const items = [...probs.entries()].sort((x, y) => y[1] - x[1]);
    // nucleus on the original policy: never play moves outside topP
    const kept: [number, number][] = [];
    let cum = 0.0;
    for (const [a, p] of items) {
      kept.push([a, p]);
      cum += p;
      if (cum >= this.cfg.topP) break;
    }
    const w = kept.map(([, p]) => p ** (1.0 / this.cfg.temperature));
    let r = this.rng.random() * w.reduce((x, y) => x + y, 0);
    for (let i = 0; i < kept.length; i++) {
      r -= w[i];
      if (r <= 0) return kept[i][0];
    }
    return kept[kept.length - 1][0];
  }
}
