// Helpers for the AI parity tests (Node only): fixture loading and local assets.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { DurakGame, type GameSnapshot } from "../../../src/local/engine";
import { configureAI } from "../../../src/local/ai/runtime";

export const WEB_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const FIXTURES = `${WEB_ROOT}test-fixtures/ai/`;
export const PUBLIC_AI = `${WEB_ROOT}public/ai/`;

export function readFixture<T>(name: string): T {
  return JSON.parse(gunzipSync(readFileSync(FIXTURES + name)).toString("utf8")) as T;
}

export function fromSnap(s: GameSnapshot): DurakGame {
  return DurakGame.fromSnapshot(s);
}

/** Point the AI runtime at the files on disk. */
export function useLocalAssets(): void {
  configureAI({
    modelUrl: `${PUBLIC_AI}champion.onnx`,
    modelMetaUrl: `${PUBLIC_AI}champion.json`,
    solverUrl: `${PUBLIC_AI}solver.wasm`,
    ortWasmUrl: null,
    ortMjsUrl: null,
    cacheBust: false,
    loadBytes: async (p) => new Uint8Array(readFileSync(p)),
    loadJson: async (p) => JSON.parse(readFileSync(p, "utf8")),
  });
}
