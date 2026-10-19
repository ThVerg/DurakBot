// Build the bench page, serve it statically under /DurakBot/ WITHOUT COOP/COEP
// headers (like GitHub Pages) and run it in headless Chromium.
//
//   node tools/ai/bench/run.mjs [--agent champion] [--players 2] [--games 4] [--opts '{...}'] [--no-build]
//   node tools/ai/bench/run.mjs --dev      # against the Vite dev server instead of a build
//   CHROMIUM=/path/to/chrome node tools/ai/bench/run.mjs
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = fileURLToPath(new URL(".", import.meta.url));
const webRoot = fileURLToPath(new URL("../../../", import.meta.url));
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const out = process.env.BENCH_OUT ?? join(tmpdir(), "durak-ai-bench");
const dev = process.argv.includes("--dev");
let devServer = null;
if (dev) {
  const { createServer: createVite } = await import("vite");
  devServer = await createVite({ configFile: join(here, "vite.config.ts"), server: { port: 0, host: "127.0.0.1" }, logLevel: "warn" });
  await devServer.listen();
} else if (!process.argv.includes("--no-build")) {
  const r = spawnSync("npx", ["vite", "build", "--config", join(here, "vite.config.ts"), "--logLevel", "warn"], {
    cwd: webRoot, stdio: "inherit", env: { ...process.env, BENCH_OUT: out },
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm",
  ".json": "application/json", ".onnx": "application/octet-stream", ".css": "text/css" };
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (!url.pathname.startsWith("/DurakBot/")) { res.writeHead(404); return res.end(); }
  const p = normalize(join(out, decodeURIComponent(url.pathname.slice("/DurakBot/".length)) || "index.html"));
  if (!p.startsWith(out) || !existsSync(p) || statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": MIME[extname(p)] ?? "application/octet-stream" });
  createReadStream(p).pipe(res);
});
let port;
if (dev) {
  port = devServer.httpServer.address().port;
} else {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
}

function findChromium() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const cache = join(homedir(), ".cache", "ms-playwright");
  const dirs = existsSync(cache) ? readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort() : [];
  for (const d of dirs.reverse()) {
    const p = join(cache, d, "chrome-headless-shell-linux64", "chrome-headless-shell");
    if (existsSync(p)) return p;
  }
  return undefined;
}
const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
const page = await browser.newPage();
const logs = [];
page.on("console", (m) => logs.push(m.text()));
const q = new URLSearchParams({
  agent: arg("agent", "champion"), opp: arg("opp", "heuristic"), players: arg("players", "2"),
  games: arg("games", "4"), seed: arg("seed", "1"), opts: arg("opts", "{}"),
});
const t0 = Date.now();
await page.goto(`http://127.0.0.1:${port}/DurakBot/?${q}`);
const timeoutMs = Number(arg("timeout", "1800")) * 1000;
await page.waitForFunction(() => window.__bench || window.__benchError, null, { timeout: timeoutMs, polling: 500 });
const res = await page.evaluate(() => window.__bench ?? { ok: false, error: window.__benchError });
await browser.close();
if (dev) await devServer.close();
else server.close();
const { latencies, ...summary } = res;
summary.wallSeconds = (Date.now() - t0) / 1000;
if (logs.length) summary.console = logs.slice(0, 20);
console.log(JSON.stringify(summary));
const file = arg("out", "");
if (file) (await import("node:fs")).writeFileSync(file, JSON.stringify(res));
process.exit(res.ok ? 0 : 1);
