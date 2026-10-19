// The in-browser backend returns exactly the JSON of the FastAPI server:
// replays scenarios recorded from server/sessions.py + server/analysis.py
// (scripts/export_session_fixtures.py) through LocalBackend on the same deal,
// with scripted bots and a public-information "analyst", and compares every
// response (create/advance/act/get/debug/hint/evaluate/replay/analysis/record).
import { describe, expect, it } from "vitest";
import { popcount } from "../../src/local/cards";
import { DurakGame } from "../../src/local/engine";
import { LocalBackend } from "../../src/local/backend";
import { RandomAgent, type Agent, type Registry } from "../../src/local/bots";
import { LocalSession } from "../../src/local/session";
import { MemoryStore } from "../../src/local/storage";
import { loadScenarios } from "./fixtures";

class ScriptAgent implements Agent {
  name = "random";
  constructor(private actions: number[]) {}
  async act(game: DurakGame): Promise<number> {
    return this.actions[game.log.length];
  }
}

/** Same arithmetic as FakeAnalyst in scripts/export_session_fixtures.py. */
class FakeAnalyst implements Agent {
  name = "champion_fast";
  async act(game: DurakGame): Promise<number> {
    return game.legalActions()[0];
  }
  async evaluate(g: DurakGame, me: number): Promise<number> {
    if (g.done) return g.loser === me ? 0.0 : 1.0;
    if (g.finished.includes(me)) return 1.0;
    const mine = popcount(g.hands[me]);
    const active = g.activePlayers;
    let others = 0;
    for (const q of active) if (q !== me) others += popcount(g.hands[q]);
    const x = (others - mine * (active.length - 1)) / 10.0 + g.talon.length / 48.0 - g.attackCards.length / 20.0;
    return 0.5 + (0.5 * x) / (1.0 + Math.abs(x));
  }
  async policy(g: DurakGame): Promise<Map<number, number>> {
    const legal = g.legalActions();
    let z = 0.0;
    for (const a of legal) z += (a % 7) + 1;
    return new Map(legal.map((a) => [a, ((a % 7) + 1) / z]));
  }
}

const registry: Registry = {
  availableAgents: () => ["champion_fast", "random"],
  async getAgent(name, opts) {
    if (name === "champion_fast") return new FakeAnalyst();
    if (name === "random") return new RandomAgent(opts?.seed);
    throw new Error("unknown");
  },
};

/** game ids differ; bot think time is wall-clock. */
function normalize(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(normalize);
  if (x && typeof x === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x)) {
      if (k === "game_id") out[k] = "G";
      else if (k === "think_ms") out[k] = 0;
      else if (k === "seconds") continue;
      else out[k] = normalize(v);
    }
    return out;
  }
  return x;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("session/API parity with server/sessions.py", () => {
  for (const sc of loadScenarios()) {
    it(`${sc.name}: ${sc.calls.length} calls`, async () => {
      const store = new MemoryStore();
      const backend = new LocalBackend({
        registry: async () => registry,
        store: async () => store,
        bots: async () => null,
        lab: async () => null,
      });
      const ctx = await backend.context();
      const n = sc.num_players;
      const s = await LocalSession.create(ctx, n, sc.human_seat, Array(n).fill("random"), sc.seed, sc.debug_at_start);
      s.makeGame = () => DurakGame.fromDeck(sc.deck, n, sc.fallback_attacker);
      s.game = s.makeGame();
      s.names = sc.names.slice();
      s.personas = sc.personas.slice();
      s.agents = Array.from({ length: n }, (_, p) => (p === sc.human_seat ? null : new ScriptAgent(sc.actions)));
      backend.adopt(s);
      const id = s.id;

      for (const [i, c] of sc.calls.entries()) {
        let got: unknown;
        switch (c.call) {
          case "create":
            got = { game_id: id, steps: [], state: s.view() };
            break;
          case "get":
            got = await backend.get(id);
            break;
          case "debug":
            got = await backend.debug(id, c.args[0] as boolean);
            break;
          case "evaluate":
            got = await backend.evaluate(id);
            break;
          case "hint":
            got = await backend.hint(id);
            break;
          case "act":
            got = await backend.act(id, c.args[0] as number, false);
            break;
          case "advance":
            got = await backend.advance(id, c.args[0] as "step" | "bout" | "end", 1);
            break;
          case "replay":
            got = await backend.replay(id);
            break;
          case "analysis": {
            let a = (await backend.analysis(id)) as { status: string };
            expect(["running", "ready"]).toContain(a.status);
            for (let k = 0; k < 2000 && a.status === "running"; k++) {
              await sleep(5);
              a = (await backend.analysis(id)) as { status: string };
            }
            got = a;
            break;
          }
          case "record": {
            const rows = await store.rows();
            expect(rows.length).toBe(1);
            const { id: rid, date, seq, ...rest } = rows[0];
            expect(rid).toBe(id);
            expect(date).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00$/);
            void seq;
            got = rest;
            break;
          }
          default:
            throw new Error(`unknown call ${c.call}`);
        }
        const want = normalize(c.response);
        const have = normalize(JSON.parse(JSON.stringify(got)));
        if (JSON.stringify(have) !== JSON.stringify(want)) {
          expect({ call: i, name: c.call, ...(have as object) }).toEqual({ call: i, name: c.call, ...(want as object) });
        }
      }
      expect(s.game.done).toBe(true);
      expect(s.game.log.map(([, a]) => a)).toEqual(sc.actions);
    });
  }
});
