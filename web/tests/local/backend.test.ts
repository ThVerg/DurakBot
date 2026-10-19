// LocalBackend: endpoint semantics, errors, persistence across reloads,
// no hidden-information leaks, stats parity with server/storage.py, Lab.
import { describe, expect, it } from "vitest";
import { LocalBackend, type StaticBots } from "../../src/local/backend";
import { makeRegistry, type Registry } from "../../src/local/bots";
import { GameError } from "../../src/local/session";
import { MemoryStore, stats, timeline, type GameRecord } from "../../src/local/storage";
import { loadStaticData, loadStorageFixture } from "./fixtures";

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function backendWith(store = new MemoryStore(), registry: Registry = makeRegistry(null)) {
  return new LocalBackend({
    registry: async () => registry,
    store: async () => store,
    bots: async () => loadStaticData("bots.json") as StaticBots,
    lab: async () => loadStaticData("lab.json") as J,
    analysisBudgetMs: 5_000,
  });
}

async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 200;
  } catch (e) {
    expect(e).toBeInstanceOf(GameError);
    return (e as GameError).status;
  }
}

/** Hidden cards of bots never appear in a play-mode response without debug reveal. */
function assertNoLeak(resp: J, human: number) {
  const views: J[] = [];
  if (resp.state) views.push(resp.state);
  for (const st of resp.steps ?? []) {
    if (st.view) views.push(st.view);
    for (const ev of st.events) if (ev.type === "draw" && ev.player !== human) expect(ev.cards).toBeUndefined();
  }
  for (const st of resp.history ?? [])
    for (const ev of st.events) if (ev.type === "draw" && ev.player !== human) expect(ev.cards).toBeUndefined();
  for (const v of views) {
    expect(v.debug_reveal).toBe(false);
    for (const p of v.players) if (p.seat !== human) expect(p.hand).toBeUndefined();
    if (!v.done) expect(v.seed ?? null).toBeNull();
  }
}

async function playToEnd(b: LocalBackend, id: string, rng: () => number, maxCalls = 5000): Promise<J> {
  let st = ((await b.get(id)) as J).state;
  for (let k = 0; k < maxCalls && !st.done; k++) {
    let r: J;
    if (st.your_turn) {
      const a = st.legal[Math.floor(rng() * st.legal.length)];
      r = (await b.act(id, a, false)) as J;
    } else {
      r = (await b.advance(id, "step", 1)) as J;
    }
    if (st.human_seat !== null) assertNoLeak(r, st.human_seat);
    st = r.state;
  }
  return st;
}

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

describe("storage stats parity with server/storage.py", () => {
  it("stats() and timeline() match", async () => {
    const fx = loadStorageFixture();
    const store = new MemoryStore();
    for (const r of fx.records) await store.record(r as unknown as GameRecord);
    const rows = await store.rows();
    expect(stats(rows)).toEqual(fx.stats);
    expect(timeline(rows)).toEqual(fx.timeline);
  });
});

describe("LocalBackend endpoints", () => {
  it("bots payload: static metadata, availability, order, credential", async () => {
    const b = backendWith();
    const r = (await b.bots()) as J;
    expect(Object.keys(r).sort()).toEqual(
      ["bots", "credential", "default", "evaluate_available", "max_players", "min_players", "unavailable"].sort(),
    );
    expect(r.bots.map((x: J) => x.name)).toEqual(["random"]);
    expect(r.bots[0].labels.ru).toBe("Случайный");
    expect(r.default).toBe("random");
    expect(r.evaluate_available).toBe(false);
    expect([r.min_players, r.max_players]).toEqual([2, 6]);
    const meta = loadStaticData("bots.json") as StaticBots;
    expect(r.credential).toEqual(meta.credential ?? null);

    // With the full registry: sorted by tier (desc), then preference.
    const names = ["random", "heuristic", "solver", "champion", "champion_fast", "novice", "intermediate", "expert", "grandmaster"];
    const reg: Registry = { availableAgents: () => names.slice().sort(), getAgent: async () => ({ name: "x", act: async () => 36 }) };
    const r2 = (await backendWith(new MemoryStore(), reg).bots()) as J;
    const tiers = r2.bots.map((x: J) => x.tier ?? -1);
    expect(tiers).toEqual([...tiers].sort((a: number, c: number) => c - a));
    expect(r2.bots[0].name).toBe("champion");
    expect(r2.default).toBe("champion");
    expect(r2.evaluate_available).toBe(true);
    for (const x of r2.bots) expect(Object.keys(x).sort()).toEqual(["available", "desc", "elo", "error", "label", "labels", "name", "tier"]);
  });

  it("validation and error statuses", async () => {
    const b = backendWith();
    expect(await status(b.create({ num_players: 7, human_seat: 0, spectate: false }))).toBe(422);
    expect(await status(b.create({ num_players: 3, human_seat: 3, spectate: false }))).toBe(422);
    expect(await status(b.create({ num_players: 2, human_seat: 0, spectate: false, bot: "nope" }))).toBe(422);
    expect(await status(b.get("missing"))).toBe(404);
    const g = (await b.create({ num_players: 2, human_seat: 0, spectate: false, seed: 4, auto: false })) as J;
    const id = g.game_id;
    expect(g.steps).toEqual([]);
    expect(g.state.seed).toBeNull();
    let st = g.state;
    if (!st.your_turn) {
      expect(await status(b.act(id, st.legal[0] ?? 0, false))).toBe(409); // not your turn
      st = ((await b.advance(id, "bout")) as J).state;
      while (!st.your_turn && !st.done) st = ((await b.advance(id, "step")) as J).state;
    }
    expect(await status(b.advance(id, "step"))).toBe(409); // waiting for the human
    const illegal = [...Array(37).keys()].find((a) => !st.legal.includes(a))!;
    expect(await status(b.act(id, illegal, false))).toBe(400);
    expect(await status(b.act(id, 99, false))).toBe(422);
    expect(await status(b.replay(id))).toBe(409);
    expect(await status(b.analysis(id))).toBe(409);
    const h = (await b.hint(id)) as J; // no analyst: default bot's move, no values
    expect(h.available).toBe(true);
    expect(h.has_values).toBe(false);
    expect(st.legal).toContain(h.recommended);
    expect(await b.evaluate(id)).toEqual({ available: false, values: {} });
    const sp = (await b.create({ num_players: 3, human_seat: null, spectate: true })) as J;
    expect(sp.state.mode).toBe("spectate");
    expect(await status(b.act(sp.game_id, 36, false))).toBe(409);
    expect(await status(b.hint(sp.game_id))).toBe(409);
  });

  it("concurrent (pipelined) advance requests are serialized like the server lock", async () => {
    const b = backendWith();
    const g = (await b.create({ num_players: 4, human_seat: null, spectate: true, seed: 8 })) as J;
    const rs = (await Promise.all(Array.from({ length: 20 }, () => b.advance(g.game_id, "step")))) as J[];
    const seqs = rs.flatMap((r) => r.steps.map((s: J) => s.seq));
    expect(seqs).toEqual([...Array(20).keys()]);
  });

  it("full games: no leaks, recorded once, stats and Lab timeline", async () => {
    const store = new MemoryStore();
    const b = backendWith(store);
    for (const [n, seat, seed] of [
      [2, 0, 1],
      [5, 3, 2],
      [6, 5, 3],
    ] as const) {
      const g = (await b.create({ num_players: n, human_seat: seat, spectate: false, seed, auto: false })) as J;
      assertNoLeak(g, seat);
      const end = await playToEnd(b, g.game_id, lcg(seed));
      expect(end.done).toBe(true);
      expect(end.result.human).toMatch(/durak|safe|draw/);
      expect(end.seed).toBe(seed); // revealed after the game
      const rep = (await b.replay(g.game_id)) as J;
      expect(rep.frames.length).toBe(end.moves + 1);
      for (const f of rep.frames) for (const p of f.view.players) if (p.seat !== seat) expect(p.hand).toBeUndefined();
      const got = (await b.get(g.game_id)) as J;
      assertNoLeak({ history: got.history }, seat);
      // analysis without an analyst
      expect(((await b.analysis(g.game_id)) as J).status).toMatch(/running|unavailable/);
    }
    const s = (await b.stats()) as J;
    expect(s.total_games).toBe(3);
    expect(s.human_games).toBe(3);
    expect(s.recent.length).toBe(3);
    const lab = (await b.lab()) as J;
    expect(lab.human.length).toBe(3);
    expect(lab.training_active).toBe(false);
    expect(lab.train.series.iter.length).toBeGreaterThan(100);
    expect(Object.keys(lab).sort()).toEqual(
      ["champion", "eval_summary", "evals", "exported", "human", "ladder", "promotions", "run", "runs", "train", "training_active"].sort(),
    );
  });

  it("spectate shows every hand and runs to the end", async () => {
    const b = backendWith();
    const g = (await b.create({ num_players: 5, human_seat: null, spectate: true, seed: 12 })) as J;
    for (const p of g.state.players) expect(p.hand).toBeDefined();
    const r = (await b.advance(g.game_id, "end")) as J;
    expect(r.state.done).toBe(true);
    expect(r.steps.length).toBe(r.state.moves);
    const draws = r.steps.flatMap((s: J) => s.events).filter((e: J) => e.type === "draw");
    for (const d of draws) expect(d.cards.length).toBe(d.count);
    const ev = (await b.evaluate(g.game_id)) as J;
    expect(ev.available).toBe(false);
  });

  it("debug reveal is live-only and flagged", async () => {
    const store = new MemoryStore();
    const b = backendWith(store);
    const g = (await b.create({ num_players: 3, human_seat: 0, spectate: false, seed: 9, auto: false })) as J;
    const on = (await b.debug(g.game_id, true)) as J;
    expect(on.state.debug_reveal).toBe(true);
    for (const p of on.state.players) expect(p.hand).toBeDefined();
    expect(on.state.seed).toBe(9);
    const off = (await b.debug(g.game_id, false)) as J;
    assertNoLeak(off, 0);
    await playToEnd(b, g.game_id, lcg(9));
    expect((await store.rows())[0].debug_used).toBe(true);
  });

  it("sessions survive a reload (restored from storage)", async () => {
    const store = new MemoryStore();
    const a = backendWith(store);
    const g = (await a.create({ num_players: 4, human_seat: 1, spectate: false, seed: 77, auto: false })) as J;
    const id = g.game_id;
    const rng = lcg(77);
    let st = g.state;
    for (let k = 0; k < 40 && !st.done; k++) {
      st = st.your_turn
        ? ((await a.act(id, st.legal[Math.floor(rng() * st.legal.length)], false)) as J).state
        : ((await a.advance(id, "step")) as J).state;
    }
    await a.hint(id).catch(() => undefined);
    const before = (await a.get(id)) as J;
    const b = backendWith(store); // a new worker after a page reload
    const after = (await b.get(id)) as J;
    expect(after).toEqual(before);
    const end = await playToEnd(b, id, rng);
    expect(end.done).toBe(true);
    expect((await store.rows()).length).toBe(1);
  });
});

describe("real bots (src/local/ai) in the backend", () => {
  it("level bots + champion hints/analysis/evaluate through the backend", async () => {
    const { readFileSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const ai = (await import("../../src/local/ai/index")) as J;
    const pub = join(__dirname, "..", "..", "public", "ai");
    if (!existsSync(join(pub, "champion.onnx"))) return;
    ai.configureAI({
      modelUrl: join(pub, "champion.onnx"),
      modelMetaUrl: join(pub, "champion.json"),
      solverUrl: join(pub, "solver.wasm"),
      ortWasmUrl: null,
      loadBytes: async (p: string) => new Uint8Array(readFileSync(p)),
      loadJson: async (p: string) => JSON.parse(readFileSync(p, "utf8")),
    });
    const reg = makeRegistry(ai);
    const store = new MemoryStore();
    const b = backendWith(store, reg);
    const bots = (await b.bots()) as J;
    expect(bots.default).toBe("champion");
    expect(bots.evaluate_available).toBe(true);
    // spectate: three tiers play to the end
    const sp = (await b.create({ num_players: 4, human_seat: null, spectate: true, seed: 3, bots: ["heuristic", "intermediate", "novice", "expert"] })) as J;
    expect(sp.state.players.map((p: J) => p.bot)).toEqual(["heuristic", "intermediate", "novice", "expert"]);
    expect(((await b.advance(sp.game_id, "end")) as J).state.done).toBe(true);
    // play vs champion_fast with hints and win estimates
    const g = (await b.create({ num_players: 2, human_seat: 0, spectate: false, seed: 5, bot: "champion_fast", auto: false })) as J;
    const id = g.game_id;
    let st = g.state;
    let hints = 0;
    for (let k = 0; k < 400 && !st.done; k++) {
      if (st.your_turn) {
        if (hints < 3) {
          const h = (await b.hint(id)) as J;
          expect(h.has_values).toBe(true);
          expect(st.legal).toContain(h.recommended);
          expect(h.moves.length).toBe(st.legal.length);
          for (const m of h.moves) expect(m.win).toBeGreaterThanOrEqual(0);
          const ev = (await b.evaluate(id)) as J;
          expect(ev.available).toBe(true);
          expect(Object.keys(ev.values)).toEqual(["0"]);
          hints++;
        }
        st = ((await b.act(id, st.legal[0], false)) as J).state;
      } else st = ((await b.advance(id, "step")) as J).state;
    }
    expect(st.done).toBe(true);
    let a = (await b.analysis(id)) as J;
    for (let k = 0; k < 600 && a.status === "running"; k++) {
      await new Promise((r) => setTimeout(r, 50));
      a = (await b.analysis(id)) as J;
    }
    expect(a.status).toBe("ready");
    expect(a.timeline.length).toBeGreaterThan(1);
    expect((await store.rows())[0].hints_used).toBe(3);
  }, 300_000);
});
