// Invariant fuzzing of the TS engine and the 36-bit mask helpers.
import { describe, expect, it } from "vitest";
import * as C from "../../src/local/cards";
import { ATTACK, DEFEND, DurakGame, PASS, THROW_IN } from "../../src/local/engine";
import { Rng } from "../../src/local/rng";

const big = (m: number) => BigInt(m);
const num = (b: bigint) => Number(b);

describe("mask helpers vs BigInt", () => {
  it("set ops, popcount, iteration", () => {
    const rng = new Rng(7);
    const rand = () => {
      let m = 0;
      for (let c = 0; c < 37; c++) if (rng.random() < 0.4) m += C.BIT[c];
      return m;
    };
    const FULL37 = (1n << 37n) - 1n;
    for (let i = 0; i < 5000; i++) {
      const a = rand();
      const b = rand();
      expect(C.or(a, b)).toBe(num(big(a) | big(b)));
      expect(C.and(a, b)).toBe(num(big(a) & big(b)));
      expect(C.andNot(a, b)).toBe(num(big(a) & ~big(b) & FULL37));
      expect(C.xor(a, b)).toBe(num(big(a) ^ big(b)));
      expect(C.intersects(a, b)).toBe((big(a) & big(b)) !== 0n);
      expect(C.isSubset(C.and(a, b), a)).toBe(true);
      const am = C.and(a, C.FULL_MASK);
      expect(C.complement(am)).toBe(num(~big(am) & ((1n << 36n) - 1n)));
      const list: number[] = [];
      for (let c = 0; c < 37; c++) if ((big(a) >> BigInt(c)) & 1n) list.push(c);
      expect(C.maskToList(a)).toEqual(list);
      expect(C.popcount(a)).toBe(list.length);
      expect(C.lowest(a)).toBe(list.length ? list[0] : -1);
      expect(C.highest(a)).toBe(list.length ? list[list.length - 1] : -1);
      expect(C.listToMask(list)).toBe(a);
      const it2: number[] = [];
      C.forEachCard(a, (c) => it2.push(c));
      expect(it2).toEqual(list);
      expect(C.fromWords(C.lo(a), C.hi(a))).toBe(a);
      const c = rng.randrange(37);
      expect(C.has(a, c)).toBe(list.includes(c));
      expect(C.add(a, c)).toBe(num(big(a) | (1n << BigInt(c))));
      expect(C.remove(a, c)).toBe(num(big(a) & ~(1n << BigInt(c))));
    }
  });
});

describe("rng", () => {
  it("is reproducible and roughly uniform", () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 100; i++) expect(a.nextU32()).toBe(b.nextU32());
    const c = a.clone();
    expect(c.random()).toBe(a.random());
    const counts = new Array(6).fill(0);
    for (let i = 0; i < 60000; i++) counts[a.randrange(6)]++;
    for (const k of counts) expect(Math.abs(k - 10000)).toBeLessThan(500);
    const d = [1, 2, 3, 4, 5];
    a.shuffle(d);
    expect(d.slice().sort()).toEqual([1, 2, 3, 4, 5]);
    expect(new Rng(1).random()).not.toBe(new Rng(2).random());
  });
});

function checkInvariants(g: DurakGame): void {
  const n = g.numPlayers;
  // Every card is in exactly one place.
  let all = 0;
  let count = 0;
  const parts = [...g.hands, C.listToMask(g.talon), g.discard, g.tableMask];
  for (const m of parts) {
    expect(C.intersects(all, m)).toBe(false);
    all = C.or(all, m);
    count += C.popcount(m);
  }
  expect(all).toBe(C.FULL_MASK);
  expect(count).toBe(36);
  expect(g.talon.length).toBe(new Set(g.talon).size);
  if (g.talon.length) expect(g.talon[0]).toBe(g.trumpCard);
  for (let p = 0; p < n; p++) expect(C.isSubset(g.known[p], g.hands[p])).toBe(true);
  // Table structure.
  const na = g.attackCards.length;
  const nd = g.defenseCards.length;
  for (let i = 0; i < nd; i++) expect(C.beats(g.defenseCards[i], g.attackCards[i], g.trump)).toBe(true);
  if (g.done) return;
  expect(na).toBeLessThanOrEqual(g.boutLimit);
  if (g.phase === ATTACK) expect(nd).toBe(na);
  if (g.phase === DEFEND) expect(nd).toBe(na - 1);
  if (g.phase === THROW_IN) expect(nd).toBeLessThan(na);
  expect(g.throwers[0]).toBe(g.attacker);
  expect(g.throwers).not.toContain(g.defender);
  expect(g.finished).not.toContain(g.attacker);
  expect(g.finished).not.toContain(g.defender);
  expect(g.stall).toBeLessThan(g.config.stallBouts);
  // Legal actions.
  const legal = g.legalActions();
  expect(legal.length).toBeGreaterThan(0);
  const hand = g.hands[g.currentPlayer];
  for (const a of legal) if (a !== PASS) expect(C.has(hand, a)).toBe(true);
  if (g.phase === ATTACK && na === 0) expect(legal).not.toContain(PASS);
  else expect(legal).toContain(PASS);
  // Unseen mask = complement of what the player can see.
  for (let p = 0; p < n; p++) {
    const u = g.unseenMask(p);
    expect(C.intersects(u, g.hands[p])).toBe(false);
    expect(C.intersects(u, g.discard)).toBe(false);
    let hidden = 0;
    for (let q = 0; q < n; q++) if (q !== p) hidden += C.popcount(g.hands[q]) - C.popcount(g.known[q]);
    expect(C.popcount(u)).toBe(hidden + Math.max(0, g.talon.length - 1));
  }
}

function checkDeterminize(g: DurakGame, rng: Rng): void {
  for (let p = 0; p < g.numPlayers; p++) {
    const d = g.determinize(p, rng);
    expect(d.hands[p]).toBe(g.hands[p]);
    expect(d.talon.length).toBe(g.talon.length);
    if (g.talon.length) expect(d.talon[0]).toBe(g.trumpCard);
    expect(d.discard).toBe(g.discard);
    expect(d.attackCards).toEqual(g.attackCards);
    expect(d.legalMask()).toBe(g.legalMask() === 0 ? 0 : d.legalMask());
    for (let q = 0; q < g.numPlayers; q++) {
      expect(C.popcount(d.hands[q])).toBe(C.popcount(g.hands[q]));
      expect(C.isSubset(g.known[q], d.hands[q])).toBe(true);
    }
    if (g.currentPlayer === p && !g.done) expect(d.legalMask()).toBe(g.legalMask());
    checkInvariants(d);
    // Perfect information at the end: exact.
    if (!g.talon.length && g.activePlayers.length === 2 && g.isActive(p)) expect(d.hands).toEqual(g.hands);
  }
}

describe("fuzz invariants", () => {
  for (const n of [2, 3, 4, 5, 6]) {
    it(`${n} players: 80 random games`, () => {
      const rng = new Rng(1000 + n);
      let draws = 0;
      for (let k = 0; k < 80; k++) {
        const g = new DurakGame(rng.nextU32(), n);
        checkInvariants(g);
        let steps = 0;
        while (!g.done) {
          const legal = g.legalActions();
          // Illegal actions are rejected without changing anything.
          const bad = steps % 5 === 0 ? [...Array(37).keys()].find((a) => !legal.includes(a)) : undefined;
          if (bad !== undefined) {
            const before = JSON.stringify(g.snapshot());
            expect(() => g.step(bad)).toThrow();
            expect(JSON.stringify(g.snapshot())).toBe(before);
          }
          // Mildly take-heavy policy so stalls happen too.
          const a =
            g.phase === DEFEND && rng.random() < 0.4 ? PASS : legal[rng.randrange(legal.length)];
          g.step(a);
          steps++;
          if (steps % 7 === 0) checkInvariants(g);
          if (steps % 23 === 0) checkDeterminize(g, rng);
          expect(steps).toBeLessThan(5000);
        }
        checkInvariants(g);
        const r = g.returns();
        expect(Math.abs(r.reduce((s, x) => s + x, 0))).toBeLessThan(1e-9);
        if (g.loser === null) {
          draws++;
          expect(r.every((x) => x === 0)).toBe(true);
        } else {
          expect(r[g.loser]).toBe(-1);
          expect(g.finished).not.toContain(g.loser);
          expect(g.finished.length).toBe(n - 1);
        }
        if (n === 2 && g.loser !== null) expect(g.winner).toBe(1 - g.loser);
      }
      expect(draws).toBeLessThan(80);
    });
  }

  it("same seed, same game", () => {
    const a = new DurakGame(123, 4);
    const b = new DurakGame(123, 4);
    expect(a.snapshot()).toEqual(b.snapshot());
    expect(new DurakGame(124, 4).snapshot()).not.toEqual(a.snapshot());
  });

  it("6 players: the trump card is shown in seat 5's hand", () => {
    for (let s = 0; s < 50; s++) {
      const g = new DurakGame(s, 6);
      expect(g.talon.length).toBe(0);
      expect(C.has(g.known[5], g.trumpCard)).toBe(true);
      expect(C.has(g.hands[5], g.trumpCard)).toBe(true);
    }
  });

  it("infoState only reveals the player's own hand", () => {
    const g = new DurakGame(5, 3);
    const s = g.infoState(1);
    expect(s.hand).toEqual(C.maskToList(g.hands[1]));
    expect(s.known[1]).toEqual([]);
    expect(JSON.stringify(s)).not.toContain('"hands"');
    expect(s.legal).toEqual(g.currentPlayer === 1 ? g.legalActions() : []);
  });

  it("is fast enough for search (random playouts)", () => {
    const rng = new Rng(9);
    const t0 = performance.now();
    let steps = 0;
    for (let k = 0; k < 2000; k++) {
      const g = new DurakGame(rng, 2);
      while (!g.done) {
        const m = g.legalMask();
        const legal = C.maskToList(m);
        g.step(legal[rng.randrange(legal.length)]);
        steps++;
      }
    }
    const sps = steps / ((performance.now() - t0) / 1000);
    expect(sps).toBeGreaterThan(50_000);
  });
});
