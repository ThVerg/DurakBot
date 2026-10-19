// Browser bench page: runs the bots inside a module Web Worker (as the app does)
// and exposes the result as window.__bench for the headless driver (run.mjs).
const params = new URLSearchParams(location.search);
const cfg = {
  agent: params.get("agent") ?? "champion",
  opp: params.get("opp") ?? "heuristic",
  players: Number(params.get("players") ?? "2"),
  games: Number(params.get("games") ?? "4"),
  seed: Number(params.get("seed") ?? "1"),
  opts: JSON.parse(params.get("opts") ?? "{}"),
};
const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
const out = document.getElementById("out") as HTMLElement;
const w = window as unknown as { __bench?: unknown; __benchError?: string };
worker.onmessage = (e) => {
  w.__bench = { ...e.data, pageCrossOriginIsolated: self.crossOriginIsolated, userAgent: navigator.userAgent };
  out.textContent = JSON.stringify(w.__bench, null, 1);
};
worker.onerror = (e) => {
  w.__benchError = String(e.message);
  out.textContent = "error: " + e.message;
};
worker.postMessage(cfg);
