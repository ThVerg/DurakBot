// The WebAssembly endgame solver (durak/_solver.c via scripts/build_solver_wasm.sh)
// plus the TS port of the durak/solver.py wrapper, against the native solver's
// exact results on endgame positions from real games (scripts/dump_ai_fixtures.py).
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { GameSnapshot } from "../../../src/local/engine";
import { Rng } from "../../../src/local/rng";
import { EndgameSolver, applicable, instantiateSolver } from "../../../src/local/ai/solver";
import { PUBLIC_AI, fromSnap, readFixture } from "./testutil";

interface SolverRec {
  snap: GameSnapshot;
  player: number;
  value: number;
  action: number;
  values: Record<string, number>;
  cards: number;
  ms: number;
}

const all = readFixture<{ positions: SolverRec[] }>("solver.json.gz").positions;
// By default the ~2% of endgames that took the native solver over 0.3 s are
// sampled (every 6th); AI_SOLVER_FULL=1 checks all of them.
const FULL = typeof process !== "undefined" && process.env.AI_SOLVER_FULL === "1";
const data = FULL ? all : all.filter((r, i) => r.ms <= 300 || i % 6 === 0);
let solver: EndgameSolver;

beforeAll(async () => {
  solver = await instantiateSolver(new Uint8Array(readFileSync(`${PUBLIC_AI}solver.wasm`)), 19);
});

describe("wasm endgame solver vs native durak/solver.py", () => {
  it("has thousands of endgames for every N", () => {
    expect(all.length).toBeGreaterThanOrEqual(2000);
    expect(data.length).toBeGreaterThanOrEqual(2000);
    expect(new Set(data.map((r) => r.snap.numPlayers)).size).toBe(5);
  });

  it("solve(): identical value and best move", () => {
    let bad = 0;
    const times: number[] = [];
    for (const r of data) {
      const g = fromSnap(r.snap);
      expect(applicable(g)).toBe(true);
      const t0 = performance.now();
      const res = solver.solve(g, r.player, null, null);
      times.push(performance.now() - t0);
      if (res === null || res[0] !== r.value || res[1] !== r.action) {
        bad++;
        if (bad <= 3) expect({ res, cards: r.cards }).toEqual({ res: [r.value, r.action], cards: r.cards });
      }
    }
    times.sort((a, b) => a - b);
    const q = (p: number) => times[Math.min(times.length - 1, Math.floor(p * times.length))].toFixed(2);
    console.info(`wasm solve ms over ${times.length} endgames: p50 ${q(0.5)} p90 ${q(0.9)} p99 ${q(0.99)} max ${q(1)}`);
    expect(bad).toBe(0);
  }, 900_000);

  it("actionValues(): identical exact value for every legal move", () => {
    let bad = 0;
    for (const r of data) {
      const g = fromSnap(r.snap);
      const vals = solver.values(g, r.player, null, null);
      const want = new Map(Object.entries(r.values).map(([a, v]) => [Number(a), v]));
      if (vals === null || vals.size !== want.size || [...want].some(([a, v]) => vals.get(a) !== v)) {
        bad++;
        if (bad <= 3) expect(vals && Object.fromEntries(vals)).toEqual(r.values);
      }
    }
    expect(bad).toBe(0);
  }, 900_000);

  it("is exact on determinized copies and honours budgets", () => {
    const rng = new Rng(3);
    for (const r of data.filter((x) => x.ms < 50).slice(0, 500)) {
      const g = fromSnap(r.snap).determinize(r.player, rng);
      expect(solver.solve(g, r.player, null)).toEqual([r.value, r.action]);
    }
    // a node budget too small for big endgames returns null (fallback), never a wrong answer
    let aborted = 0;
    for (const r of data.filter((x) => x.cards >= 14).slice(0, 100)) {
      const res = solver.solve(fromSnap(r.snap), r.player, null, 50);
      if (res === null) aborted++;
      else expect(res[0]).toBe(r.value);
    }
    expect(aborted).toBeGreaterThan(0);
  });

  it("solveSmall returns exact returns for small endgames", () => {
    for (const r of data.filter((x) => x.cards <= 10 && x.snap.talon.length === 0).slice(0, 300)) {
      const g = fromSnap(r.snap);
      const res = solver.solveSmall(g, 10, 1e9);
      expect(res).not.toBeNull();
      const v = res!.returns[r.player];
      const want = r.value === 0 ? 0 : r.value < 0 ? -1 : 1 / (g.numPlayers - 1);
      expect(v).toBeCloseTo(want, 12);
    }
  });
});
