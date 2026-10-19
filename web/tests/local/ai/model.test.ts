// The exported network in onnxruntime-web (wasm, the browser backend) against
// torch outputs dumped by scripts/dump_ai_fixtures.py, with the observation
// encoded in TypeScript: end-to-end parity of encoding + model + policy.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { GameSnapshot } from "../../../src/local/engine";
import { ChampionAgent } from "../../../src/local/ai/champion";
import { PublicTracker, buildBatch, encodeParts } from "../../../src/local/ai/encoding";
import { createModel, type PolicyModel } from "../../../src/local/ai/model";
import { PUBLIC_AI, fromSnap, readFixture, useLocalAssets } from "./testutil";

interface ModelRec {
  snap: GameSnapshot;
  player: number;
  logits: Record<string, number>;
  value: number;
  durak: number;
  belief: number[] | null;
  policy: Record<string, number>;
}

const fx = readFixture<{ version: number; positions: ModelRec[] }>("model.json.gz");
const meta = JSON.parse(readFileSync(`${PUBLIC_AI}champion.json`, "utf8")) as { version: number };
let model: PolicyModel;

beforeAll(async () => {
  useLocalAssets();
  model = await createModel(new Uint8Array(readFileSync(`${PUBLIC_AI}champion.onnx`)), meta);
});

describe("champion.onnx in onnxruntime-web", () => {
  it("fixtures were dumped from the exported checkpoint", () => {
    expect(fx.version).toBe(meta.version);
  });

  it("batched outputs match torch (TS encoding -> ORT wasm)", async () => {
    const recs = fx.positions;
    const parts = recs.map((r) => {
      const g = fromSnap(r.snap);
      return encodeParts(g, r.player, PublicTracker.fromGame(g));
    });
    const worst = { logits: 0, value: 0, durak: 0, belief: 0 };
    for (let i = 0; i < recs.length; i += 64) {
      const chunk = parts.slice(i, i + 64);
      const { obs, mask } = buildBatch(chunk);
      const out = await model.run(obs, mask, chunk.length);
      chunk.forEach((_p, j) => {
        const r = recs[i + j];
        for (let a = 0; a < 37; a++) {
          const want = r.logits[String(a)];
          const got = out.logits[j * 37 + a];
          if (want === undefined) expect(got).toBeLessThan(-1e8);
          else worst.logits = Math.max(worst.logits, Math.abs(got - want));
        }
        worst.value = Math.max(worst.value, Math.abs(out.value[j] - r.value));
        worst.durak = Math.max(worst.durak, Math.abs(out.durak[j] - r.durak));
        if (r.belief && out.belief) {
          for (let k = 0; k < 216; k++) worst.belief = Math.max(worst.belief, Math.abs(out.belief[j * 216 + k] - r.belief[k]));
        }
      });
    }
    console.info("onnxruntime-web vs torch, max abs diff:", JSON.stringify(worst));
    expect(worst.logits).toBeLessThan(2e-4);
    expect(worst.value).toBeLessThan(2e-5);
    expect(worst.durak).toBeLessThan(5e-5);
    expect(worst.belief).toBeLessThan(2e-5);
  });

  it("ChampionAgent.policy matches the Python policy over real legal actions", async () => {
    const agent = new ChampionAgent(model, null, { seed: 1 });
    let worst = 0;
    let argmaxSame = 0;
    for (const r of fx.positions.slice(0, 150)) {
      const g = fromSnap(r.snap);
      const pol = await agent.policy(g, r.player);
      const keys = Object.keys(r.policy).map(Number).sort((a, b) => a - b);
      expect([...pol.keys()]).toEqual(keys);
      for (const a of keys) worst = Math.max(worst, Math.abs((pol.get(a) as number) - r.policy[String(a)]));
      const best = (m: Map<number, number>) => [...m.entries()].reduce((x, y) => (y[1] > x[1] ? y : x))[0];
      const pyBest = keys.reduce((x, y) => (r.policy[String(y)] > r.policy[String(x)] ? y : x));
      if (best(pol) === pyBest) argmaxSame++;
    }
    console.info("policy max abs diff:", worst, "argmax agreement:", argmaxSame, "/ 150");
    expect(worst).toBeLessThan(2e-5);
    expect(argmaxSame).toBe(150);
  });
});
