// Web Worker hosting the in-browser backend: game sessions, all bot thinking
// (ONNX network, WASM solver) and persistence run here, off the UI thread.
// Protocol: {id, method, args} -> {id, ok: true, result} | {id, ok: false, status, message}.

import { LocalBackend } from "./backend";
import { loadRegistry } from "./bots";
import { GameError } from "./session";
import { openStore, type Store } from "./storage";

const BASE = import.meta.env.BASE_URL;

function staticUrl(name: string): string {
  return new URL(`${BASE}static-data/${name}`, self.location.origin).href;
}

async function fetchJson<T>(name: string): Promise<T | null> {
  try {
    const r = await fetch(staticUrl(name), { cache: "no-cache" });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

function once<T>(f: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => (p ??= f());
}

const backend = new LocalBackend({
  registry: loadRegistry,
  store: once<Store>(openStore),
  bots: once(() => fetchJson("bots.json")),
  lab: once(() => fetchJson("lab.json")),
});

const METHODS = new Set([
  "health", "bots", "create", "get", "act", "advance", "debug", "evaluate", "hint", "analysis", "replay", "stats", "lab",
]);

interface Request {
  id: number;
  method: string;
  args: unknown[];
}

type Callable = (...args: unknown[]) => Promise<unknown>;

self.onmessage = async (e: MessageEvent<Request>) => {
  const { id, method, args } = e.data;
  try {
    if (!METHODS.has(method)) throw new GameError(404, "unknown API endpoint");
    const fn = (backend as unknown as Record<string, Callable>)[method];
    const result = await fn.apply(backend, args ?? []);
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    const status = err instanceof GameError ? err.status : 500;
    const message = err instanceof GameError ? err.detail : err instanceof Error ? err.message : String(err);
    if (status >= 500) console.error(`local ${method} failed`, err);
    self.postMessage({ id, ok: false, status, message });
  }
};

self.postMessage({ ready: true });
// Fetch and compile the default bot (network + solver) while the title shows.
setTimeout(() => void backend.warm(), 50);
