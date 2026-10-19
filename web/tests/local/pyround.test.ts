import { describe, expect, it } from "vitest";
import { pyRound } from "../../src/local/pyround";

describe("pyRound matches Python round()", () => {
  it("ties to even on exact binary ties", () => {
    expect(pyRound(0.03125, 4)).toBe(0.0312);
    expect(pyRound(0.09375, 4)).toBe(0.0938);
    expect(pyRound(2.5, 0)).toBe(2);
    expect(pyRound(3.5, 0)).toBe(4);
    expect(pyRound(-0.03125, 4)).toBe(-0.0312);
    expect(pyRound(0.125, 2)).toBe(0.12);
    expect(pyRound(0.375, 2)).toBe(0.38);
  });
  it("non-ties use the exact binary value", () => {
    expect(pyRound(2.675, 2)).toBe(2.67); // 2.67499999...
    expect(pyRound(1.005, 2)).toBe(1); // 1.00499999...
    expect(pyRound(0.66666, 4)).toBe(0.6667);
    expect(pyRound(1 / 3, 4)).toBe(0.3333);
    expect(pyRound(0, 4)).toBe(0);
    expect(pyRound(0.99995, 4)).toBe(1); // 0.999950000000000027...
  });
});
