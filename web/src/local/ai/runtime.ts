// Where the AI assets live and how they are fetched.
//
// In the browser (page or Web Worker) everything is served by the static site:
//   <BASE_URL>ai/champion.onnx   network (scripts/export_onnx.py)
//   <BASE_URL>ai/champion.json   its version metadata (used as a cache buster)
//   <BASE_URL>ai/solver.wasm     endgame solver (scripts/build_solver_wasm.sh)
// and the onnxruntime-web wasm binary is emitted by Vite as a hashed asset (no
// CDN). Tests and Node scripts call configureAI() with file paths and a reader.

export interface AIConfig {
  /** URL of the ONNX network. */
  modelUrl: string;
  /** URL of the model metadata JSON (version, sha256); null to skip. */
  modelMetaUrl: string | null;
  /** URL of solver.wasm. */
  solverUrl: string;
  /** URLs of onnxruntime-web's ort-wasm-simd-threaded.wasm and its .mjs loader;
   * null = the library's default location (next to its own module). */
  ortWasmUrl: string | null;
  ortMjsUrl: string | null;
  /** Append ?v=<model sha> to the model URL (HTTP caches keep the old file otherwise). */
  cacheBust: boolean;
  /** log2 of the solver transposition-table entries (48 bytes each): 19 = 24 MiB. */
  solverTTLog2: number;
  /** Fetches a binary asset. */
  loadBytes: (url: string) => Promise<Uint8Array>;
  /** Fetches a JSON asset. */
  loadJson: (url: string) => Promise<unknown>;
}

function baseUrl(): string {
  try {
    const env = (import.meta as unknown as { env?: { BASE_URL?: string } }).env;
    if (env && typeof env.BASE_URL === "string") return env.BASE_URL;
  } catch {
    /* not bundled by Vite */
  }
  return "/";
}

const inBrowser = typeof (globalThis as { location?: unknown }).location !== "undefined";

// Vite turns these into hashed assets of the build (served under the base, no
// CDN). In Node, onnxruntime-web finds its own files.
function defaultOrtWasmUrl(): string | null {
  if (!inBrowser) return null;
  return new URL("../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm", import.meta.url).href;
}
function defaultOrtMjsUrl(): string | null {
  if (!inBrowser) return null;
  return new URL("../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs", import.meta.url).href;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

async function fetchJson(url: string): Promise<unknown> {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`fetch ${url}: HTTP ${r.status}`);
  return r.json();
}

const base = baseUrl();
const config: AIConfig = {
  modelUrl: `${base}ai/champion.onnx`,
  modelMetaUrl: `${base}ai/champion.json`,
  solverUrl: `${base}ai/solver.wasm`,
  ortWasmUrl: defaultOrtWasmUrl(),
  ortMjsUrl: defaultOrtMjsUrl(),
  cacheBust: inBrowser,
  solverTTLog2: 19,
  loadBytes: fetchBytes,
  loadJson: fetchJson,
};

/** Override asset locations or loaders (call before the first getAgent). */
export function configureAI(partial: Partial<AIConfig>): void {
  Object.assign(config, partial);
}

export function aiConfig(): Readonly<AIConfig> {
  return config;
}

/** Monotonic clock in seconds. */
export function nowSec(): number {
  return performance.now() / 1000;
}
