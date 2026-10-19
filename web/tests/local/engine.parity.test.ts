// Exact parity of the TS engine with durak/engine.py: replays Python traces
// (deal injected) and compares the full state after every step.
import { describe, expect, it } from "vitest";
import * as C from "../../src/local/cards";
import { DurakGame } from "../../src/local/engine";
import { loadCards, loadTraces, type StateSnap } from "./fixtures";

function snap(g: DurakGame): StateSnap {
  return {
    legal: g.legalMask(),
    phase: g.phase,
    cur: g.done ? null : g.currentPlayer,
    hands: g.hands.slice(),
    known: g.known.slice(),
    att: g.attackCards.slice(),
    def: g.defenseCards.slice(),
    talon: g.talon.length,
    discard: g.discard,
    attacker: g.attacker,
    defender: g.defender,
    throwers: g.throwers.slice(),
    tidx: g.throwerIdx,
    limit: g.boutLimit,
    first: g.firstBout,
    bout: g.boutIndex,
    finished: g.finished.slice(),
    done: g.done,
    loser: g.loser,
    stall: g.stall,
    unseen: Array.from({ length: g.numPlayers }, (_, p) => g.unseenMask(p)),
  };
}

describe("cards parity", () => {
  const ref = loadCards();
  it("masks and beaters match Python", () => {
    expect(C.FULL_MASK).toBe(ref.full_mask);
    expect([...C.RANK_MASKS]).toEqual(ref.rank_masks);
    expect([...C.SUIT_MASKS]).toEqual(ref.suit_masks);
    for (let t = 0; t < 4; t++) for (let a = 0; a < 36; a++) expect(C.beatersMask(a, t)).toBe(ref.beaters[t][a]);
  });
  it("beats() agrees with beatersMask()", () => {
    for (let t = 0; t < 4; t++)
      for (let a = 0; a < 36; a++)
        for (let d = 0; d < 36; d++) expect(C.beats(d, a, t)).toBe(C.has(C.beatersMask(a, t), d));
  });
  it("card names round-trip", () => {
    for (let c = 0; c < 36; c++) expect(C.parseCard(C.cardStr(c))).toBe(c);
    expect(C.cardStr(C.parseCard("10H"))).toBe("10H");
    expect(C.actionStr(36)).toBe("PASS");
  });
});

for (const n of [2, 3, 4, 5, 6]) {
  describe(`engine parity, ${n} players`, () => {
    const traces = loadTraces(n);
    it(`has traces (${traces.length} games)`, () => {
      expect(traces.length).toBeGreaterThan(10);
      const kinds = new Set(traces.map((t) => t.special).filter(Boolean));
      expect(kinds.has("draw")).toBe(true);
      if (n >= 3) expect(kinds.has("stalemate")).toBe(true);
      if (n <= 4) expect(kinds.has("no_trump_holder")).toBe(true);
    });

    for (const t of traces) {
      it(`seed ${t.seed} (${t.special ?? t.policy}, ${t.actions.length} steps)`, () => {
        const g = DurakGame.fromDeck(t.deck, n, t.fallback_attacker);
        expect(g.trumpCard).toBe(t.trump_card);
        expect(g.trump).toBe(t.trump);
        if (t.special === "no_trump_holder") expect(t.used_fallback).toBe(true);
        expect(snap(g)).toEqual(t.initial);
        for (let i = 0; i < t.actions.length; i++) {
          const a = t.actions[i];
          expect(g.isLegal(a)).toBe(true);
          g.step(a);
          const got = snap(g);
          if (JSON.stringify(got) !== JSON.stringify(t.states[i])) {
            // Detailed diff only on failure.
            expect({ step: i, ...got }).toEqual({ step: i, ...t.states[i] });
          }
        }
        expect(g.returns()).toEqual(t.returns);
        expect(g.log).toEqual(t.log);
        expect(g.legalActions()).toEqual([]);
        expect(() => g.step(36)).toThrow();
      });
    }
  });
}

describe("clone / snapshot during replay", () => {
  it("clones and snapshots continue identically", () => {
    for (const n of [2, 4, 6]) {
      for (const t of loadTraces(n).slice(0, 6)) {
        const g = DurakGame.fromDeck(t.deck, n, t.fallback_attacker);
        const cut = Math.floor(t.actions.length / 2);
        for (let i = 0; i < cut; i++) g.step(t.actions[i]);
        const c = g.clone();
        const s = DurakGame.fromSnapshot(JSON.parse(JSON.stringify(g.snapshot())));
        for (let i = cut; i < t.actions.length; i++) {
          c.step(t.actions[i]);
          s.step(t.actions[i]);
        }
        expect(snap(c)).toEqual(t.states[t.states.length - 1]);
        expect(snap(s)).toEqual(t.states[t.states.length - 1]);
        // the original is untouched by stepping the copies
        expect(g.log.length).toBe(cut);
      }
    }
  });
});
