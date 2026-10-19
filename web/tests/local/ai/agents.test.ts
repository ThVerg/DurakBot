// The browser bot registry: every agent plays legal moves for every N, never
// uses hidden information, and the champion's evaluate() behaves.
import { beforeAll, describe, expect, it } from "vitest";
import { DurakGame } from "../../../src/local/engine";
import { Rng } from "../../../src/local/rng";
import { availableAgents, getAgent } from "../../../src/local/ai";
import { ChampionAgent } from "../../../src/local/ai/champion";
import { applicable } from "../../../src/local/ai/solver";
import type { Agent } from "../../../src/local/ai/types";
import { useLocalAssets } from "./testutil";

const FAST = { moveBudget: 0.12, searchTime: 0.1, minSearchTime: 0.02, solverTime: 0.2 };

beforeAll(() => useLocalAssets());

async function playOut(me: Agent, n: number, seed: number, seat = 0): Promise<DurakGame> {
  const game = new DurakGame(seed, n);
  const rng = new Rng(seed);
  const opp = await getAgent("heuristic", { seed });
  me.reset?.();
  let steps = 0;
  while (!game.done) {
    const p = game.currentPlayer;
    const view = game.determinize(p, rng);
    const a = await (p === seat ? me : opp).act(view, p);
    expect(game.isLegal(a)).toBe(true);
    game.step(a);
    expect(++steps).toBeLessThan(5000);
  }
  return game;
}

describe("registry", () => {
  it("lists the agreed names", () => {
    expect(availableAgents()).toEqual(
      ["champion", "champion_fast", "expert", "grandmaster", "heuristic", "intermediate", "novice", "random", "solver"],
    );
  });

  it("rejects unknown names", async () => {
    await expect(getAgent("nope")).rejects.toThrow(/unknown agent/);
  });

  for (const name of ["random", "heuristic", "solver", "champion_fast", "champion", "novice", "intermediate", "expert", "grandmaster"]) {
    it(`${name} plays legal moves for N = 2..6`, async () => {
      const agent = await getAgent(name, { seed: 5, ...FAST });
      expect(agent.name).toBe(name);
      for (let n = 2; n <= 6; n++) {
        const g = await playOut(agent, n, 100 + n, n % 2);
        expect(g.done).toBe(true);
      }
    });
  }
});

describe("champion", () => {
  it("uses only the acting player's information (real game vs determinizations)", async () => {
    const agent = (await getAgent("champion_fast", { seed: 1 })) as ChampionAgent;
    const rng = new Rng(11);
    for (let s = 0; s < 6; s++) {
      const game = new DurakGame(500 + s, 2 + (s % 5));
      for (let k = 0; k < 40 && !game.done; k++) {
        const p = game.currentPlayer;
        const real = await agent.act(game, p);
        const det = await agent.act(game.determinize(p, rng), p);
        expect(det).toBe(real);
        const er = await agent.evaluate(game, p);
        const ed = await agent.evaluate(game.determinize(p, rng), p);
        expect(ed).toBeCloseTo(er, 6);
        const pol = await agent.policy(game, p);
        expect([...pol.keys()]).toEqual(game.legalActions());
        game.step(game.legalActions()[k % game.legalActions().length]);
      }
    }
  });

  it("does not reuse a public tracker across games (no reset between them)", async () => {
    const used = (await getAgent("champion_fast", { seed: 1 })) as ChampionAgent;
    const rng = new Rng(5);
    for (let s = 0; s < 10; s++) {
      const n = 2 + (s % 5);
      // look at the opening of another deal first: same N, empty log
      const other = new DurakGame(9000 + s, n);
      await used.policy(other, other.currentPlayer);
      const game = new DurakGame(4000 + s, n);
      for (let k = 0; k < 30 && !game.done; k++) {
        const p = game.currentPlayer;
        const fresh = (await getAgent("champion_fast", { seed: 1 })) as ChampionAgent;
        expect([...(await used.policy(game, p))]).toEqual([...(await fresh.policy(game, p))]);
        game.step(rng.choice(game.legalActions()));
      }
    }
  });

  it("evaluate() is a probability, exact (0/1) in solvable endgames unless the solver times out", async () => {
    const agent = (await getAgent("champion_fast", { seed: 2 })) as ChampionAgent;
    const rng = new Rng(3);
    let exact = 0;
    for (let s = 0; s < 4; s++) {
      const game = new DurakGame(900 + s, 2);
      while (!game.done) {
        const p = game.currentPlayer;
        const v = await agent.evaluate(game, p);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
        if (applicable(game) && (v === 0 || v === 1)) exact++;
        game.step(rng.choice(game.legalActions()));
      }
      expect(await agent.evaluate(game, game.loser ?? 0)).toBe(game.loser === null ? 1 : 0);
    }
    expect(exact).toBeGreaterThan(0);
  });

  it("the search runs within its budget and returns a legal move", async () => {
    const agent = (await getAgent("champion", { seed: 4, moveBudget: 0.3, searchTime: 0.25 })) as ChampionAgent;
    const rng = new Rng(9);
    let searched = 0;
    for (let s = 0; s < 4; s++) {
      const game = new DurakGame(700 + s, s % 2 ? 4 : 2);
      while (!game.done) {
        const p = game.currentPlayer;
        const d = await agent.decide(game.determinize(p, rng), p);
        expect(game.isLegal(d.action)).toBe(true);
        expect(d.ms).toBeLessThan(2000);
        if (d.source === "search") searched++;
        game.step(d.action);
      }
    }
    expect(searched).toBeGreaterThan(0);
  });
});
