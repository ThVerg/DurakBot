// Strength check of the in-browser bots in Node (same wasm backends as the browser).
//
//   npx vite-node tools/ai/match.ts -- --agent champion --opp heuristic --players 2 --deals 100 --start 0 --out r.json
//
// "1 vs field" like durak/arena.py: for each deal the agent sits in every seat
// once (N games per deal) against N-1 copies of the opponent. Every bot gets a
// fresh determinization of the real game for its seat at each decision. Prints
// a JSON summary: durak rate (deal-clustered 95% CI), draws and the per-move
// latency of the agent (decisions with more than one legal move).
import { writeFileSync } from "node:fs";
import { DurakGame } from "../../src/local/engine";
import { Rng } from "../../src/local/rng";
import { getAgent } from "../../src/local/ai/registry";
import type { Agent } from "../../src/local/ai/types";
import { ChampionAgent } from "../../src/local/ai/champion";
import { useLocalAssets } from "../../tests/local/ai/testutil";

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const agentName = arg("agent", "champion");
const oppName = arg("opp", "heuristic");
const n = Number(arg("players", "2"));
const deals = Number(arg("deals", "50"));
const start = Number(arg("start", "0"));
const seed = Number(arg("seed", "2026"));
const out = arg("out", "");
const agentOpts = JSON.parse(arg("opts", "{}")) as Record<string, unknown>;

async function main() {
  useLocalAssets();
  const me: Agent = await getAgent(agentName, { seed: seed + start, ...agentOpts });
  const opps: Agent[] = [];
  for (let i = 0; i < n - 1; i++) opps.push(await getAgent(oppName, { seed: seed * 7 + start * 13 + i }));
  const rng = new Rng(seed * 31 + start);
  const latencies: number[] = [];
  const sources: Record<string, number> = {};
  const searches: { ms: number; completed: number; rounds: number; rows: number; src: string }[] = [];
  const perDeal: { deal: number; durak: number; games: number; draws: number }[] = [];
  let illegal = 0;
  const t0 = performance.now();
  for (let deal = start; deal < start + deals; deal++) {
    let durak = 0;
    let draws = 0;
    for (let seat = 0; seat < n; seat++) {
      const game = new DurakGame(seed * 1_000_003 + deal, n);
      const agents: Agent[] = [];
      let k = 0;
      for (let p = 0; p < n; p++) agents.push(p === seat ? me : opps[k++]);
      for (const a of agents) a.reset?.();
      let steps = 0;
      while (!game.done) {
        const p = game.currentPlayer;
        const view = game.determinize(p, rng);
        const multi = game.legalActions().length > 1;
        const ts = performance.now();
        const a = await agents[p].act(view, p);
        const dt = performance.now() - ts;
        if (p === seat && multi) {
          latencies.push(dt);
          if (me instanceof ChampionAgent && me.last) {
            sources[me.last.source] = (sources[me.last.source] ?? 0) + 1;
            const sr = me.last.search;
            if (sr) searches.push({ ms: Math.round(dt), completed: sr.completed, rounds: sr.rounds, rows: sr.rows, src: me.last.source });
          }
        }
        if (!game.isLegal(a)) {
          illegal++;
          throw new Error(`illegal action ${a} by ${agents[p].name}`);
        }
        game.step(a);
        if (++steps > 20000) throw new Error("game did not terminate");
      }
      if (game.loser === seat) durak++;
      if (game.loser === null) draws++;
    }
    perDeal.push({ deal, durak, games: n, draws });
  }
  latencies.sort((a, b) => a - b);
  const q = (p: number) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))] : 0);
  const games = perDeal.reduce((s, d) => s + d.games, 0);
  const dur = perDeal.reduce((s, d) => s + d.durak, 0);
  const res = {
    agent: agentName, opts: agentOpts, opp: oppName, players: n, start, deals, games,
    durak: dur, draws: perDeal.reduce((s, d) => s + d.draws, 0), durak_rate: dur / games, illegal,
    perDeal, latency_ms: { n: latencies.length, mean: latencies.reduce((s, x) => s + x, 0) / Math.max(1, latencies.length),
      p50: q(0.5), p90: q(0.9), p99: q(0.99), max: q(1) },
    sources, search_completed_mean: searches.reduce((s, x) => s + x.completed, 0) / Math.max(1, searches.length),
    search_rounds_mean: searches.reduce((s, x) => s + x.rounds, 0) / Math.max(1, searches.length),
    searches, latencies, seconds: (performance.now() - t0) / 1000,
  };
  if (out) writeFileSync(out, JSON.stringify(res));
  const { perDeal: _pd, latencies: _l, searches: _s, ...summary } = res;
  void _pd;
  void _l;
  void _s;
  console.log(JSON.stringify(summary));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
