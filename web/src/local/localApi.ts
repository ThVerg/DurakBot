// The `api` object for the static build (VITE_BACKEND=local): same functions,
// signatures and JSON as the HTTP client in ../api.ts, answered by the
// in-browser backend running in a Web Worker (./worker.ts).

import type {
  Analysis,
  BotsResponse,
  CreateGameRequest,
  GameState,
  Hint,
  LabData,
  ReplayFrame,
  StatsResponse,
  Step,
  StepsResponse,
} from "../api";

type MakeError = (status: number, message: string) => Error;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

export function createLocalApi(makeError: MakeError) {
  let worker: Worker | null = null;
  let ready = false;
  let seq = 0;
  const pending = new Map<number, Pending>();

  function failAll(message: string) {
    for (const p of pending.values()) p.reject(makeError(503, message));
    pending.clear();
  }

  function boot(): Worker {
    const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "durak-local" });
    ready = false;
    w.onmessage = (e: MessageEvent) => {
      const m = e.data as { id?: number; ready?: boolean; ok?: boolean; result?: unknown; status?: number; message?: string };
      if (m.ready) {
        ready = true;
        return;
      }
      const p = m.id !== undefined ? pending.get(m.id) : undefined;
      if (!p) return;
      pending.delete(m.id as number);
      if (m.ok) p.resolve(m.result);
      else p.reject(makeError(m.status ?? 500, m.message ?? "error"));
    };
    w.onerror = (e: ErrorEvent) => {
      if (!ready) {
        // The worker could not start (e.g. no module-worker support): fail fast
        // and retry with a fresh worker on the next call.
        e.preventDefault();
        failAll(`the game engine could not start${e.message ? `: ${e.message}` : ""}`);
        w.terminate();
        if (worker === w) worker = null;
      }
    };
    return w;
  }

  function call<T>(method: string, ...args: unknown[]): Promise<T> {
    if (!worker) worker = boot();
    const id = ++seq;
    const w = worker;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      w.postMessage({ id, method, args });
    });
  }

  return {
    bots: () => call<BotsResponse>("bots"),
    create: (req: CreateGameRequest) => call<StepsResponse>("create", req),
    get: (id: string) => call<{ game_id: string; state: GameState; history: Step[] }>("get", id),
    act: (id: string, action: number) => call<StepsResponse>("act", id, action, false),
    advance: (id: string, until: "step" | "bout" | "end", max_steps = 1) =>
      call<StepsResponse>("advance", id, until, max_steps),
    debug: (id: string, reveal: boolean) => call<{ game_id: string; state: GameState }>("debug", id, reveal),
    evaluate: (id: string) => call<{ available: boolean; values: Record<string, number> }>("evaluate", id),
    hint: (id: string) => call<Hint>("hint", id),
    analysis: (id: string) => call<Analysis>("analysis", id),
    replay: (id: string) => call<{ game_id: string; frames: ReplayFrame[] }>("replay", id),
    stats: () => call<StatsResponse>("stats"),
    lab: (run?: string) => call<LabData>("lab", run),
  };
}
