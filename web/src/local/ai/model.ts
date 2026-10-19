// The champion network in the browser: onnxruntime-web, wasm backend, one
// thread (GitHub Pages cannot send COOP/COEP headers, so no SharedArrayBuffer).
//
// Graph (scripts/export_onnx.py): inputs obs [B, 918] and mask [B, 37] (float32,
// 1 = legal); outputs logits [B, 37] (illegal = -1e9), value [B], durak [B]
// (durak logit) and belief [B, 36, 6] (probabilities, canonical cards).
// Calls are serialized: one onnxruntime session runs one batch at a time.

import { NUM_ACTIONS, NUM_LOCS, OBS_DIM } from "./encoding";
import { aiConfig } from "./runtime";

type Ort = typeof import("onnxruntime-web/wasm");
type Session = import("onnxruntime-web/wasm").InferenceSession;

export interface ModelOutputs {
  batch: number;
  /** [B, 37] canonical action logits. */
  logits: Float32Array;
  /** [B] expected return of the acting seat. */
  value: Float32Array;
  /** [B] durak logit. */
  durak: Float32Array;
  /** [B, 36, 6] belief probabilities (canonical cards), or null. */
  belief: Float32Array | null;
}

export interface ModelInfo {
  version?: number;
  iteration?: number;
  sha256?: string;
  [k: string]: unknown;
}

export class PolicyModel {
  readonly info: ModelInfo;
  private ort: Ort;
  private session: Session;
  private queue: Promise<unknown> = Promise.resolve();
  /** Number of forward calls and rows evaluated (diagnostics). */
  calls = 0;
  rows = 0;

  constructor(ort: Ort, session: Session, info: ModelInfo) {
    this.ort = ort;
    this.session = session;
    this.info = info;
  }

  get hasBelief(): boolean {
    return this.session.outputNames.includes("belief");
  }

  /** Evaluate `batch` rows. `obs` holds batch*OBS_DIM floats, `mask` batch*37. */
  run(obs: Float32Array, mask: Float32Array, batch: number): Promise<ModelOutputs> {
    const job = this.queue.then(() => this.runNow(obs, mask, batch));
    this.queue = job.catch(() => undefined);
    return job;
  }

  private async runNow(obs: Float32Array, mask: Float32Array, batch: number): Promise<ModelOutputs> {
    const T = this.ort.Tensor;
    const o = obs.length === batch * OBS_DIM ? obs : obs.subarray(0, batch * OBS_DIM);
    const m = mask.length === batch * NUM_ACTIONS ? mask : mask.subarray(0, batch * NUM_ACTIONS);
    const out = await this.session.run({
      obs: new T("float32", o, [batch, OBS_DIM]),
      mask: new T("float32", m, [batch, NUM_ACTIONS]),
    });
    this.calls += 1;
    this.rows += batch;
    // wasm-backend outputs live in JS memory, so the arrays stay valid
    return {
      batch,
      logits: out.logits.data as Float32Array,
      value: out.value.data as Float32Array,
      durak: out.durak.data as Float32Array,
      belief: out.belief ? (out.belief.data as Float32Array) : null,
    };
  }
}

export const BELIEF_STRIDE = 36 * NUM_LOCS;

let loading: Promise<PolicyModel> | null = null;

/** Create a model from raw .onnx bytes. */
export async function createModel(bytes: Uint8Array, info: ModelInfo = {}): Promise<PolicyModel> {
  const ort: Ort = await import("onnxruntime-web/wasm");
  const cfg = aiConfig();
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  if (cfg.ortWasmUrl || cfg.ortMjsUrl) {
    const paths: { wasm?: string; mjs?: string } = {};
    if (cfg.ortWasmUrl) paths.wasm = cfg.ortWasmUrl;
    if (cfg.ortMjsUrl) paths.mjs = cfg.ortMjsUrl;
    ort.env.wasm.wasmPaths = paths;
  }
  ort.env.logLevel = "error";
  const session = await ort.InferenceSession.create(bytes, {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
    intraOpNumThreads: 1,
    interOpNumThreads: 1,
  });
  return new PolicyModel(ort, session, info);
}

/** The shared champion network (loaded once). */
export function loadModel(): Promise<PolicyModel> {
  if (!loading) {
    loading = (async () => {
      const cfg = aiConfig();
      let info: ModelInfo = {};
      let url = cfg.modelUrl;
      if (cfg.modelMetaUrl) {
        try {
          info = (await cfg.loadJson(cfg.modelMetaUrl)) as ModelInfo;
          if (info.sha256 && cfg.cacheBust) url += `?v=${String(info.sha256).slice(0, 12)}`;
        } catch {
          info = {};
        }
      }
      return createModel(await cfg.loadBytes(url), info);
    })().catch((e) => {
      loading = null;
      throw e;
    });
  }
  return loading;
}
