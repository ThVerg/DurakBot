// Plays games bot-vs-field inside a Web Worker and measures per-move latency.
import { DurakGame } from "../../../src/local/engine";
import { Rng } from "../../../src/local/rng";
import { getAgent } from "../../../src/local/ai";
import { ChampionAgent } from "../../../src/local/ai/champion";
import type { Agent } from "../../../src/local/ai/types";

self.onmessage = async (e: MessageEvent) => {
  const { agent, opp, players: n, games, seed, opts } = e.data as {
    agent: string; opp: string; players: number; games: number; seed: number; opts: Record<string, unknown>;
  };
  try {
    const t0 = performance.now();
    const me: Agent = await getAgent(agent, { seed, ...opts });
    const loadMs = performance.now() - t0;
    const opps: Agent[] = [];
    for (let i = 0; i < n - 1; i++) opps.push(await getAgent(opp, { seed: seed * 7 + i }));
    const rng = new Rng(seed);
    const lat: number[] = [];
    const sources: Record<string, number> = {};
    let durak = 0;
    let played = 0;
    // warm-up move (first inference compiles kernels)
    const tw = performance.now();
    await me.act(new DurakGame(seed, n), new DurakGame(seed, n).currentPlayer);
    const warmMs = performance.now() - tw;
    me.reset?.();
    for (let gi = 0; gi < games; gi++) {
      const game = new DurakGame(seed * 1000 + gi, n);
      const seat = gi % n;
      const agents: Agent[] = [];
      let k = 0;
      for (let p = 0; p < n; p++) agents.push(p === seat ? me : opps[k++]);
      for (const a of agents) a.reset?.();
      while (!game.done) {
        const p = game.currentPlayer;
        const view = game.determinize(p, rng);
        const multi = game.legalActions().length > 1;
        const ts = performance.now();
        const a = await agents[p].act(view, p);
        const dt = performance.now() - ts;
        if (p === seat && multi) {
          lat.push(dt);
          if (me instanceof ChampionAgent && me.last) sources[me.last.source] = (sources[me.last.source] ?? 0) + 1;
        }
        game.step(a);
      }
      played++;
      if (game.loser === seat) durak++;
    }
    lat.sort((a, b) => a - b);
    const q = (p: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] : 0);
    let evalMs = -1;
    if (me.evaluate) {
      const g = new DurakGame(seed + 99, n);
      const te = performance.now();
      await me.evaluate(g, 0);
      evalMs = performance.now() - te;
    }
    (self as unknown as Worker).postMessage({
      ok: true, agent, opp, players: n, games: played, durak, loadMs, warmMs, evalMs,
      workerCrossOriginIsolated: (self as unknown as { crossOriginIsolated: boolean }).crossOriginIsolated,
      sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
      latency_ms: { n: lat.length, mean: lat.reduce((s, x) => s + x, 0) / Math.max(1, lat.length),
        p50: q(0.5), p90: q(0.9), p99: q(0.99), max: q(1) },
      sources, latencies: lat,
    });
  } catch (err) {
    (self as unknown as Worker).postMessage({ ok: false, error: String((err as Error)?.stack ?? err) });
  }
};
