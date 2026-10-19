// Agent registry for the browser (port of durak/agents/__init__.py + the
// registered bots). The local session codes against exactly this:
//
//   getAgent(name, opts?): Promise<Agent>
//   availableAgents(): string[]
//
// Names: random, heuristic, solver, champion, champion_fast, novice,
// intermediate, expert, grandmaster. The network and the solver are loaded
// lazily, once, on first use (see runtime.ts for asset locations).

import type { DurakGame } from "../engine";
import { Rng } from "../rng";
import { CHAMPION_DEFAULTS, ChampionAgent, type ChampionOptions } from "./champion";
import { DEFAULT_PARAMS, HeuristicPlayer, type HeuristicParams } from "./heuristic";
import { LEVELS, LevelAgent } from "./levels";
import { loadModel } from "./model";
import { LOSS, applicable, loadSolver, type EndgameSolver } from "./solver";
import type { Agent, AgentOptions } from "./types";

export class RandomAgent implements Agent {
  name = "random";
  private rng: Rng;
  constructor(seed?: number) {
    this.rng = new Rng(seed);
  }
  async act(game: DurakGame): Promise<number> {
    return this.rng.choice(game.legalActions());
  }
}

/** Heuristic parameter overrides among `opts` (other keys are ignored). */
function heuristicParams(opts: Record<string, unknown>): Partial<HeuristicParams> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(DEFAULT_PARAMS)) if (k in opts) out[k] = opts[k];
  return out as Partial<HeuristicParams>;
}

export class HeuristicAgent implements Agent {
  name = "heuristic";
  readonly player: HeuristicPlayer;
  private rng: Rng;
  constructor(params: Partial<HeuristicParams> = {}, seed?: number) {
    this.player = new HeuristicPlayer(heuristicParams(params));
    this.rng = new Rng(seed);
  }
  /** Synchronous decision (used by the solver bot and in tests). */
  choose(game: DurakGame, player: number): number {
    return this.player.choose(game.determinize(player, this.rng), player);
  }
  async act(game: DurakGame, player: number): Promise<number> {
    return this.choose(game, player);
  }
}

/** Heuristic plus the exact endgame solver (port of durak/agents/solver_agent.py). */
export class SolverAgent implements Agent {
  name = "solver";
  readonly heuristic: HeuristicAgent;
  readonly solver: EndgameSolver;
  timeLimit: number;
  nodeLimit: number | null;
  stats = { solved: 0, fallback: 0, lost: 0 };
  private rng: Rng;

  constructor(solver: EndgameSolver, opts: { seed?: number; timeLimit?: number; nodeLimit?: number | null } & Partial<HeuristicParams> = {}) {
    const { seed, timeLimit, nodeLimit, ...params } = opts;
    this.heuristic = new HeuristicAgent(params, seed);
    this.solver = solver;
    this.timeLimit = timeLimit ?? 1.0;
    this.nodeLimit = nodeLimit ?? null;
    this.rng = new Rng(seed === undefined ? undefined : seed + 1);
  }

  async act(gameIn: DurakGame, player: number): Promise<number> {
    const game = gameIn.determinize(player, this.rng);
    const legal = game.legalActions();
    if (legal.length === 1) return legal[0];
    if (applicable(game)) {
      const r = this.solver.solve(game, player, this.timeLimit, this.nodeLimit);
      if (r === null) {
        this.stats.fallback += 1;
      } else if (r[0] > LOSS) {
        this.stats.solved += 1;
        return r[1];
      } else {
        this.stats.lost += 1;
      }
    }
    return this.heuristic.choose(game, player);
  }
}

const NAMES = ["random", "heuristic", "solver", "champion", "champion_fast", "novice", "intermediate", "expert", "grandmaster"];

export function availableAgents(): string[] {
  return NAMES.slice().sort();
}

function pick<T extends object>(opts: AgentOptions, keys: readonly (keyof T)[]): Partial<T> {
  const out: Partial<T> = {};
  for (const k of keys) if (k in opts) (out as Record<string, unknown>)[k as string] = opts[k as string];
  return out;
}

const CHAMPION_KEYS = [...Object.keys(CHAMPION_DEFAULTS), "seed"] as (keyof ChampionOptions)[];

export async function getAgent(name: string, opts: AgentOptions = {}): Promise<Agent> {
  const seed = typeof opts.seed === "number" ? opts.seed : undefined;
  switch (name) {
    case "random":
      return new RandomAgent(seed);
    case "heuristic": {
      const { seed: _s, ...params } = opts;
      void _s;
      return new HeuristicAgent(params as Partial<HeuristicParams>, seed);
    }
    case "solver": {
      const solver = await loadSolver();
      return new SolverAgent(solver, opts as ConstructorParameters<typeof SolverAgent>[1]);
    }
    case "champion":
    case "champion_fast": {
      const [model, solver] = await Promise.all([loadModel(), loadSolver()]);
      const co = pick<ChampionOptions>(opts, CHAMPION_KEYS);
      const agent = new ChampionAgent(model, solver, name === "champion_fast" ? { search: false, ...co } : co);
      agent.name = name;
      return agent;
    }
    default:
      if (name in LEVELS) {
        const [model, solver] = await Promise.all([loadModel(), loadSolver()]);
        return new LevelAgent(name, model, solver, opts as ConstructorParameters<typeof LevelAgent>[3]);
      }
      throw new Error(`unknown agent ${JSON.stringify(name)}; available: ${availableAgents().join(", ")}`);
  }
}

/** Load the network and the solver ahead of the first move (optional). */
export async function preloadAI(): Promise<void> {
  await Promise.all([loadModel(), loadSolver()]);
}
