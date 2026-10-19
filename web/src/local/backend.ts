// The in-browser backend: port of the FastAPI endpoints in server/app.py.
// Every method returns the same JSON as the matching /api route. It runs in a
// Web Worker (worker.ts) in the static build, and directly in unit tests.

import { MAX_PLAYERS, MIN_PLAYERS, NUM_ACTIONS } from "./engine";
import type { Registry } from "./bots";
import {
  DEFAULT_PERSONAS,
  DEFAULT_PREFERENCE,
  GameError,
  LocalSession,
  computeHint,
  defaultBot,
  evaluatorAvailable,
  getAnalysis,
  getReplay,
  usableAgents,
  type Json,
  type Persona,
  type SessionContext,
} from "./session";
import { stats, timeline, type Store } from "./storage";

/** web/public/static-data/bots.json (scripts/export_static_data.py). */
export interface StaticBots {
  bots: {
    name: string;
    label: string;
    labels: { en: string; ru: string };
    desc: { en: string; ru: string };
    tier: number | null;
    elo: number | null;
  }[];
  preference?: string[];
  personas?: Persona[];
  credential?: Json | null;
  min_players?: number;
  max_players?: number;
}

export interface BackendDeps {
  registry: () => Promise<Registry>;
  store: () => Promise<Store>;
  /** Static bot metadata; null if missing. */
  bots: () => Promise<StaticBots | null>;
  /** Static Lab payload (lab.json); null if missing. */
  lab: () => Promise<Json | null>;
  /** Analysis time budget (ms). */
  analysisBudgetMs?: number;
}

export interface CreateGameIn {
  num_players?: number;
  human_seat?: number | null;
  spectate?: boolean;
  bot?: string | null;
  bots?: (string | null)[] | null;
  seed?: number | null;
  debug_reveal?: boolean;
  auto?: boolean;
}

const MAX_SESSIONS = 30; // in memory; older ones are restored from storage on demand
const KEEP_SAVED = 30;
const LOCK_TIMEOUT_MS = 120_000;

function prettyName(name: string): string {
  return name
    .replace(/_/g, " ")
    .replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

/** Simple per-key async mutex with a timeout (Python: session lock). */
class Locks {
  private tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>, timeoutMs = LOCK_TIMEOUT_MS): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => mine);
    this.tails.set(key, tail);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const acquired = await Promise.race([
      prev.then(() => true),
      new Promise<boolean>((r) => (timer = setTimeout(() => r(false), timeoutMs))),
    ]);
    clearTimeout(timer);
    if (!acquired) {
      // give up our place in the queue once the current holder is done
      void prev.then(release);
      throw new GameError(409, "game is busy");
    }
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

export class LocalBackend {
  private sessions = new Map<string, LocalSession>();
  private locks = new Locks();
  private ctxPromise: Promise<SessionContext> | null = null;

  constructor(private deps: BackendDeps) {}

  /** Shared session services (bot registry, personas, preference). */
  context(): Promise<SessionContext> {
    if (!this.ctxPromise) {
      this.ctxPromise = (async () => {
        const [registry, meta] = await Promise.all([this.deps.registry(), this.deps.bots().catch(() => null)]);
        return {
          registry,
          personas: meta?.personas?.length ? meta.personas : DEFAULT_PERSONAS,
          preference: meta?.preference?.length ? meta.preference : DEFAULT_PREFERENCE,
          failed: new Map(),
        };
      })();
      this.ctxPromise.catch(() => (this.ctxPromise = null));
    }
    return this.ctxPromise;
  }

  /** Load the default bot ahead of the first game (downloads the network). */
  async warm(): Promise<void> {
    try {
      const ctx = await this.context();
      const name = defaultBot(ctx);
      await ctx.registry.getAgent(name);
    } catch {
      /* best effort */
    }
  }

  // ------------------------------------------------------------ sessions
  /** Register an externally built session (tests, tools). */
  adopt(s: LocalSession): void {
    this.remember(s);
  }

  private remember(s: LocalSession): void {
    this.sessions.delete(s.id);
    this.sessions.set(s.id, s);
    while (this.sessions.size > MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value as string;
      this.sessions.delete(oldest);
    }
  }

  private async getSession(gid: string): Promise<LocalSession> {
    let s = this.sessions.get(gid);
    if (!s) {
      const saved = await (await this.deps.store()).loadSession(gid).catch(() => null);
      if (!saved) throw new GameError(404, "game not found");
      s = await LocalSession.restore(await this.context(), saved);
    }
    this.remember(s);
    s.touched = Date.now();
    return s;
  }

  private async finishIfDone(s: LocalSession): Promise<void> {
    if (s.game.done && !s.recorded) {
      try {
        await (await this.deps.store()).record(s.recordDict());
        s.recorded = true;
      } catch (e) {
        console.error(`failed to record game ${s.id}`, e);
      }
    }
  }

  private async save(s: LocalSession): Promise<void> {
    try {
      const store = await this.deps.store();
      await store.saveSession(s.toSaved());
      await store.pruneSessions(KEEP_SAVED);
    } catch (e) {
      console.warn("could not save the game", e);
    }
  }

  /** Run `fn` under the session lock; record finished games; persist. */
  private locked<T>(s: LocalSession, fn: () => Promise<T> | T, persist = false): Promise<T> {
    return this.locks.run(s.id, async () => {
      const out = await fn();
      await this.finishIfDone(s);
      if (persist) await this.save(s);
      return out;
    });
  }

  // ------------------------------------------------------------ endpoints
  async health() {
    return { ok: true, sessions: this.sessions.size };
  }

  async bots(): Promise<Json> {
    const ctx = await this.context();
    const meta = await this.deps.bots().catch(() => null);
    const byName = new Map((meta?.bots ?? []).map((b) => [b.name, b]));
    const pref = ctx.preference;
    const bots = usableAgents(ctx).map((n) => {
      const m = byName.get(n);
      return {
        name: n,
        label: m?.label ?? prettyName(n),
        labels: m?.labels ?? { en: prettyName(n), ru: prettyName(n) },
        desc: m?.desc ?? { en: "", ru: "" },
        tier: m?.tier ?? null,
        elo: m?.elo ?? null,
        available: true,
        error: null,
      };
    });
    const order = (b: { name: string; tier: number | null }): [number, number, string] => [
      -(b.tier ?? -1),
      pref.includes(b.name) ? pref.indexOf(b.name) : pref.length,
      b.name,
    ];
    bots.sort((a, b) => {
      const x = order(a);
      const y = order(b);
      return x[0] - y[0] || x[1] - y[1] || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0);
    });
    return {
      credential: meta?.credential ?? null,
      bots,
      unavailable: [],
      default: defaultBot(ctx),
      evaluate_available: evaluatorAvailable(ctx),
      min_players: MIN_PLAYERS,
      max_players: MAX_PLAYERS,
    };
  }

  async create(req: CreateGameIn): Promise<Json> {
    const ctx = await this.context();
    const n = req.num_players ?? 2;
    if (!Number.isInteger(n) || n < MIN_PLAYERS || n > MAX_PLAYERS)
      throw new GameError(422, `num_players must be in [${MIN_PLAYERS}, ${MAX_PLAYERS}]`);
    const human = req.spectate ? null : req.human_seat === undefined ? 0 : req.human_seat;
    if (human !== null && !(Number.isInteger(human) && human >= 0 && human < n))
      throw new GameError(422, `human_seat must be in [0, ${n - 1}]`);
    if (req.seed !== undefined && req.seed !== null && !(Number.isSafeInteger(req.seed) && req.seed >= 0))
      throw new GameError(422, "seed must be a non-negative integer");
    const avail = new Set(usableAgents(ctx));
    const def = req.bot || defaultBot(ctx);
    const seatBots: (string | null)[] = [];
    for (let p = 0; p < n; p++) {
      let name: string | null = null;
      if (req.bots && p < req.bots.length) name = req.bots[p] ?? null;
      name = name || def;
      if (p !== human && !avail.has(name))
        throw new GameError(422, `unknown bot '${name}'; available: [${[...avail].sort().map((x) => `'${x}'`).join(", ")}]`);
      seatBots.push(name);
    }
    const s = await LocalSession.create(ctx, n, human, seatBots, req.seed ?? null, !!req.debug_reveal);
    this.remember(s);
    const auto = req.auto ?? true;
    return this.locked(
      s,
      async () => {
        const steps = s.mode === "play" && auto ? await s.runBots() : [];
        return { game_id: s.id, steps, state: s.view() };
      },
      true,
    );
  }

  async get(gid: string): Promise<Json> {
    const s = await this.getSession(gid);
    return this.locked(s, () => ({ game_id: s.id, state: s.view(), history: s.history.slice(-400) }));
  }

  async act(gid: string, action: number, auto = true): Promise<Json> {
    const s = await this.getSession(gid);
    if (s.mode !== "play") throw new GameError(409, "spectate games have no human player");
    if (!Number.isInteger(action) || action < 0 || action >= NUM_ACTIONS)
      throw new GameError(422, `action must be in [0, ${NUM_ACTIONS - 1}]`);
    return this.locked(
      s,
      async () => {
        const steps = await s.humanAct(action, auto);
        return { game_id: s.id, steps, state: s.view() };
      },
      true,
    );
  }

  /** Advance by bot moves: one step (streaming), to the end of the bout, or to
   * the end. Never plays for the human. */
  async advance(gid: string, until: "step" | "bout" | "end" = "step", maxSteps: number | null = 1): Promise<Json> {
    const s = await this.getSession(gid);
    if (!["step", "bout", "end"].includes(until)) throw new GameError(422, "until must be step, bout or end");
    return this.locked(
      s,
      async () => {
        if (s.game.done) throw new GameError(409, "game is over");
        if (s.needsHuman()) throw new GameError(409, "waiting for the human player");
        let steps: Json[];
        if (until === "end") steps = await s.runBots();
        else if (until === "bout") steps = await s.runBots(null, true);
        else steps = await s.runBots(maxSteps || 1);
        return { game_id: s.id, steps, state: s.view() };
      },
      true,
    );
  }

  async debug(gid: string, reveal: boolean): Promise<Json> {
    const s = await this.getSession(gid);
    return this.locked(
      s,
      () => {
        s.debugReveal = !!reveal;
        s.debugUsed = s.debugUsed || !!reveal;
        return { game_id: s.id, state: s.view() };
      },
      true,
    );
  }

  async evaluate(gid: string): Promise<Json> {
    const s = await this.getSession(gid);
    return this.locked(s, () => s.evaluate());
  }

  async hint(gid: string): Promise<Json> {
    const s = await this.getSession(gid);
    return this.locked(
      s,
      async () => {
        const out = await computeHint(s);
        s.hintsUsed += 1;
        return out;
      },
      true,
    );
  }

  async analysis(gid: string): Promise<Json> {
    const s = await this.getSession(gid);
    return this.locked(s, () => getAnalysis(s, this.deps.analysisBudgetMs));
  }

  async replay(gid: string): Promise<Json> {
    const s = await this.getSession(gid);
    return this.locked(s, () => getReplay(s));
  }

  async stats(): Promise<Json> {
    const rows = await (await this.deps.store()).rows();
    return stats(rows);
  }

  async lab(run?: string): Promise<Json> {
    void run; // the static build carries a single run
    const [data, rows] = await Promise.all([
      this.deps.lab().catch(() => null),
      this.deps.store().then((s) => s.rows()),
    ]);
    const base: Json = data
      ? { ...data }
      : {
          run: "main",
          runs: [],
          training_active: false,
          train: null,
          evals: null,
          promotions: null,
          champion: null,
          eval_summary: null,
          ladder: null,
        };
    base.training_active = false;
    base.human = timeline(rows);
    return base;
  }
}

export { GameError };
