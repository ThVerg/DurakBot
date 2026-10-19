// Parity of the TS feature encoding, public tracker and heuristic with Python
// (fixtures from scripts/dump_ai_fixtures.py: positions from real games, N=2..6).
import { describe, expect, it } from "vitest";
import { FULL_MASK, NUM_CARDS, PASS, and, has, maskToList } from "../../../src/local/cards";
import type { GameSnapshot } from "../../../src/local/engine";
import {
  NUM_ACTIONS,
  NUM_PLANES,
  NUM_SCALARS,
  OBS_DIM,
  PublicTracker,
  buildBatch,
  encodeParts,
  remapMask,
  toCanonAction,
  toRealAction,
} from "../../../src/local/ai/encoding";
import { HeuristicPlayer } from "../../../src/local/ai/heuristic";
import { fromSnap, readFixture } from "./testutil";

interface EncRec {
  snap: GameSnapshot;
  player: number;
  planes: number[];
  scalars: number[];
  clegal: number;
  canon: number[];
  heuristic?: number;
}

const data = readFixture<{ positions: EncRec[] }>("encoding.json.gz").positions;

describe("encoding parity with durak/rl/encoding.py", () => {
  it("has positions for every N", () => {
    const ns = new Set(data.map((r) => r.snap.numPlayers));
    expect([...ns].sort()).toEqual([2, 3, 4, 5, 6]);
    expect(data.length).toBeGreaterThanOrEqual(2500);
  });

  it("planes, scalars, legal mask and suit map match exactly", () => {
    let bad = 0;
    for (const r of data) {
      const g = fromSnap(r.snap);
      const parts = encodeParts(g, r.player, PublicTracker.fromGame(g));
      const ok =
        parts.planes.length === NUM_PLANES &&
        parts.scalars.length === NUM_SCALARS &&
        parts.planes.every((m, i) => m === r.planes[i]) &&
        parts.scalars.every((x, i) => x === r.scalars[i]) &&
        parts.clegal === r.clegal &&
        parts.canon.every((c, i) => c === r.canon[i]);
      if (!ok) {
        bad++;
        if (bad <= 3) {
          expect({ planes: parts.planes, scalars: parts.scalars, clegal: parts.clegal, canon: parts.canon }).toEqual({
            planes: r.planes, scalars: r.scalars, clegal: r.clegal, canon: r.canon,
          });
        }
      }
    }
    expect(bad).toBe(0);
  });

  it("float32 observation rows equal the Python layout", () => {
    for (const r of data.slice(0, 300)) {
      const g = fromSnap(r.snap);
      const parts = encodeParts(g, r.player, PublicTracker.fromGame(g));
      const { obs, mask } = buildBatch([parts]);
      expect(obs.length).toBe(OBS_DIM);
      const want = new Float32Array(OBS_DIM);
      r.planes.forEach((m, p) => {
        for (let c = 0; c < NUM_CARDS; c++) want[p * NUM_CARDS + c] = has(m, c) ? 1 : 0;
      });
      r.scalars.forEach((x, i) => (want[NUM_PLANES * NUM_CARDS + i] = x));
      expect(Array.from(obs)).toEqual(Array.from(want));
      for (let a = 0; a < NUM_ACTIONS; a++) expect(mask[a]).toBe(has(r.clegal, a) ? 1 : 0);
    }
  });

  it("canonical actions map back to the real legal actions", () => {
    for (const r of data) {
      const g = fromSnap(r.snap);
      if (g.done || g.currentPlayer !== r.player) continue;
      const legal = g.legalActions();
      const canonLegal = new Set(maskToList(r.clegal));
      for (const a of legal) {
        const ca = toCanonAction(a, r.canon);
        expect(canonLegal.has(ca)).toBe(true);
        expect(toRealAction(ca, r.canon)).toBe(a);
      }
      expect(canonLegal.size).toBe(legal.length);
      expect(remapMask(and(g.legalMask(), FULL_MASK), r.canon) + (legal.includes(PASS) ? 2 ** 36 : 0)).toBe(r.clegal);
    }
  });

  it("incremental tracker equals a replay from scratch", () => {
    for (const r of data.slice(0, 200)) {
      const g = fromSnap(r.snap);
      const full = PublicTracker.fromGame(g);
      const first = g.log.length ? g.log[0][0] : g.attacker;
      const inc = new PublicTracker(g.numPlayers, g.trump, first);
      for (const [p, a] of g.log) {
        inc.clone(); // clones must not disturb the original
        inc.event(p, a);
      }
      expect(inc.clone()).toEqual(full);
      expect(inc).toEqual(full);
    }
  });
});

describe("heuristic parity with durak/agents/heuristic.py", () => {
  it("picks the same action in every fixture position", () => {
    const h = new HeuristicPlayer();
    let n = 0;
    let bad = 0;
    for (const r of data) {
      if (r.heuristic === undefined) continue;
      const g = fromSnap(r.snap);
      const a = h.choose(g, r.player);
      n++;
      if (a !== r.heuristic) {
        bad++;
        if (bad <= 3) expect({ n: g.numPlayers, a }).toEqual({ n: g.numPlayers, a: r.heuristic });
      }
    }
    expect(n).toBeGreaterThan(2000);
    expect(bad).toBe(0);
  });

  it("gives the same action on a determinized copy (uses public info only)", async () => {
    const { Rng } = await import("../../../src/local/rng");
    const rng = new Rng(7);
    const h = new HeuristicPlayer();
    for (const r of data.slice(0, 800)) {
      if (r.heuristic === undefined) continue;
      const g = fromSnap(r.snap).determinize(r.player, rng);
      expect(h.choose(g, r.player)).toBe(r.heuristic);
    }
  });
});
