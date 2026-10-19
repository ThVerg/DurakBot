// Bot registry adapter for the in-browser backend.
//
// The real bots (heuristic, levels, champion with ONNX + WASM solver) live in
// ./ai/index.ts. It is loaded lazily through import.meta.glob, so this module
// (and the build) works before or without it; "random" is always available.

import type { DurakGame } from "./engine";
import { Rng } from "./rng";

export interface Agent {
  name: string;
  reset?(): void;
  /** `game` is a determinization for `player` (never the true state). */
  act(game: DurakGame, player: number): Promise<number> | number;
  /** P(`player` is not the durak) in [0, 1]. */
  evaluate?(game: DurakGame, player: number): Promise<number> | number;
  /** Policy over the legal actions. */
  policy?(
    game: DurakGame,
    player: number,
  ): Promise<Map<number, number> | Record<number, number>> | Map<number, number> | Record<number, number>;
}

export interface Registry {
  getAgent(name: string, opts?: { seed?: number; [k: string]: unknown }): Promise<Agent>;
  availableAgents(): string[];
}

/** Plays a uniformly random legal action. */
export class RandomAgent implements Agent {
  name = "random";
  private rng: Rng;
  constructor(seed?: number) {
    this.rng = new Rng(seed);
  }
  reset(): void {}
  act(game: DurakGame): number {
    const legal = game.legalActions();
    return legal[this.rng.randrange(legal.length)];
  }
}

type AIModule = Partial<Registry> & Record<string, unknown>;

const aiModules = import.meta.glob<AIModule>("./ai/index.ts");

/** Wraps the AI registry (if present) and always adds "random". */
export function makeRegistry(ai: AIModule | null): Registry {
  const aiNames = (): string[] => {
    try {
      return ai && typeof ai.availableAgents === "function" ? ai.availableAgents() : [];
    } catch {
      return [];
    }
  };
  return {
    availableAgents() {
      const names = aiNames();
      return names.includes("random") ? names : [...names, "random"];
    },
    async getAgent(name, opts) {
      if (ai && typeof ai.getAgent === "function" && aiNames().includes(name)) {
        return ai.getAgent(name, opts);
      }
      if (name === "random") return new RandomAgent(opts?.seed);
      throw new Error(`unknown bot ${name}`);
    },
  };
}

let registryPromise: Promise<Registry> | null = null;

/** The bot registry (loads ./ai/index.ts once, if it exists). */
export function loadRegistry(): Promise<Registry> {
  if (!registryPromise) {
    const load = aiModules["./ai/index.ts"];
    registryPromise = (load ? load() : Promise.resolve(null))
      .catch((e) => {
        console.error("bot registry failed to load; only the random bot is available", e);
        return null;
      })
      .then((m) => makeRegistry(m));
  }
  return registryPromise;
}

/** For tests: use a specific registry. */
export function setRegistry(r: Registry): void {
  registryPromise = Promise.resolve(r);
}

/** Normalize a policy result to a Map. */
export function policyMap(p: Map<number, number> | Record<number, number>): Map<number, number> {
  if (p instanceof Map) return p;
  const m = new Map<number, number>();
  for (const [k, v] of Object.entries(p)) m.set(Number(k), Number(v));
  return m;
}
