// Game sessions for the in-browser backend: port of server/sessions.py plus
// the coach features of server/analysis.py (hint, post-game analysis, replay)
// and the evaluate endpoint. Produces exactly the JSON shapes the HTTP API
// returns, with the same no-leak guarantees:
//
// * Bots only ever see game.determinize(seat, rng), never the true state.
// * Views include a bot's hand only in spectate mode or with the debug reveal;
//   draw events carry card ids only for the human (or when spectating); the
//   history (and replay frames of play games) never keeps bots' drawn cards.
// * Hints, analysis and win estimates are computed from determinizations of
//   the human's information set only.

import { BIT, PASS, has, maskToList, popcount, type CardSet } from "./cards";
import { ATTACK, DEFEND, PHASE_NAMES, DurakGame } from "./engine";
import { Rng } from "./rng";
import { RandomAgent, policyMap, type Agent, type Registry } from "./bots";
import { pyRound } from "./pyround";
import type { SavedSession } from "./storage";

export class GameError extends Error {
  constructor(
    public status: number,
    public detail: string,
  ) {
    super(detail);
  }
}

export interface Persona {
  key: string;
  name: string;
}

/** Shared services for sessions (one per backend). */
export interface SessionContext {
  registry: Registry;
  personas: Persona[];
  /** Preferred default opponents, strongest first (BOT_PREFERENCE). */
  preference: string[];
  /** Bots whose getAgent failed recently (name -> time in ms). */
  failed: Map<string, number>;
}

/** Python BOT_PREFERENCE / PERSONAS (used when static metadata is missing). */
export const DEFAULT_PREFERENCE = ["champion", "grandmaster", "solver", "expert", "heuristic", "intermediate", "novice", "random"];
export const DEFAULT_PERSONAS: Persona[] = [
  { key: "zina", name: "Babushka Zina" },
  { key: "misha", name: "Uncle Misha" },
  { key: "sveta", name: "Sveta" },
  { key: "kostya", name: "Kostya" },
  { key: "lev", name: "Professor Lev" },
  { key: "dasha", name: "Dasha" },
  { key: "grisha", name: "Grisha" },
];

const RETRY_FAILED_MS = 30_000;
export const ANALYSIS_TIME_BUDGET_MS = 120_000;

/** Deterministic seed for a sub-stream (Python uses e.g. seed * 7919). */
export function subSeed(seed: number, salt: number, extra = 0): number {
  let h = 0x811c9dc5 ^ salt;
  for (const v of [seed % 4294967296, Math.floor(seed / 4294967296), extra]) {
    h = Math.imul(h ^ (v >>> 0), 0x01000193);
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12;
  }
  return (h >>> 0) + salt * 4294967296;
}

export function newId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  const b = new Uint8Array(6);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(b);
  else for (let i = 0; i < 6; i++) b[i] = Math.floor(Math.random() * 256);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const round4 = (x: number) => pyRound(x, 4);
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
/** Let other queued work (e.g. analysis polls) run. */
export const yieldNow = () => new Promise<void>((r) => setTimeout(r, 0));

// ----------------------------------------------------------- bot helpers
export function usableAgents(ctx: SessionContext): string[] {
  const t = Date.now();
  return ctx.registry.availableAgents().filter((n) => {
    const f = ctx.failed.get(n);
    return f === undefined || t - f >= RETRY_FAILED_MS;
  });
}

export function defaultBot(ctx: SessionContext): string {
  const usable = usableAgents(ctx);
  for (const name of ctx.preference) if (usable.includes(name)) return name;
  return usable.length ? usable[0] : "random";
}

/** getAgent with failure caching; null if it does not load. */
export async function tryAgent(ctx: SessionContext, name: string, opts?: { seed?: number }): Promise<Agent | null> {
  const f = ctx.failed.get(name);
  if (f !== undefined && Date.now() - f < RETRY_FAILED_MS) return null;
  try {
    const a = await ctx.registry.getAgent(name, opts);
    ctx.failed.delete(name);
    return a;
  } catch (e) {
    console.warn(`bot ${name} unavailable:`, e);
    ctx.failed.set(name, Date.now());
    return null;
  }
}

/** The champion (an agent with evaluate) used for hints, analysis and win %. */
export async function makeAnalyst(ctx: SessionContext): Promise<Agent | null> {
  const avail = ctx.registry.availableAgents();
  for (const name of ["champion_fast", "champion"]) {
    if (!avail.includes(name)) continue;
    const a = await tryAgent(ctx, name);
    if (a && typeof a.evaluate === "function") return a;
  }
  return null;
}

export function evaluatorAvailable(ctx: SessionContext): boolean {
  const usable = usableAgents(ctx);
  return usable.includes("champion_fast") || usable.includes("champion");
}

/** durak/solver.py applicable(): perfect-information two-player position. */
export function solverApplicable(g: DurakGame): boolean {
  if (g.done) return false;
  const active = g.activePlayers;
  if (active.length !== 2) return false;
  if (!g.talon.length) return true;
  return g.talon.length === 1 && g.numPlayers === 2;
}

// ------------------------------------------------------------ JSON types
export type Json = Record<string, unknown>;

export interface StepDict extends Json {
  seq: number;
  player: number;
  action: number;
  card: number | null;
  kind: string;
  phase: string;
  events: Json[];
  thrower_slot: number | null;
  num_throwers: number;
  think_ms?: number;
}

export interface AnalysisState extends Json {
  status: "running" | "ready" | "error" | "unavailable";
  progress?: number;
}

// ------------------------------------------------------------------ session
export class LocalSession {
  readonly id: string;
  readonly seed: number;
  game: DurakGame;
  readonly numPlayers: number;
  readonly humanSeat: number | null;
  readonly mode: "play" | "spectate";
  seatBots: (string | null)[];
  agents: (Agent | null)[] = [];
  rng: Rng;
  debugReveal: boolean;
  debugUsed: boolean;
  history: StepDict[] = [];
  recorded = false;
  readonly created = Date.now();
  touched = Date.now();
  analysis: AnalysisState | null = null;
  hintsUsed = 0;
  personas: (string | null)[] = [];
  names: string[] = [];
  /** Deals this session's game from its seed; replaceable to replay a known
   * deal (replay/analysis rebuild the game through it). */
  makeGame: () => DurakGame;

  private constructor(
    readonly ctx: SessionContext,
    numPlayers: number,
    humanSeat: number | null,
    bots: (string | null)[],
    seed: number | null | undefined,
    debugReveal: boolean,
    id?: string,
  ) {
    this.id = id ?? newId();
    this.seed = seed ?? new Rng().randrange(2 ** 31);
    this.makeGame = () => new DurakGame(this.seed, numPlayers);
    this.game = this.makeGame();
    this.numPlayers = numPlayers;
    this.humanSeat = humanSeat;
    this.mode = humanSeat !== null ? "play" : "spectate";
    this.seatBots = Array.from({ length: numPlayers }, (_, p) => (p === humanSeat ? null : bots[p]));
    this.rng = new Rng(subSeed(this.seed, 0x5eed));
    this.debugReveal = !!debugReveal;
    this.debugUsed = this.debugReveal;
    const order = Array.from({ length: ctx.personas.length }, (_, i) => i);
    new Rng(subSeed(this.seed, 0x9e75)).shuffle(order);
    for (let p = 0; p < numPlayers; p++) {
      if (p === humanSeat) {
        this.personas.push(null);
        this.names.push("You");
      } else {
        const per = ctx.personas[order[p % order.length]];
        this.personas.push(per.key);
        this.names.push(per.name);
      }
    }
  }

  /** Mirrors GameSession(num_players, human_seat, bots, seed, debug_reveal). */
  static async create(
    ctx: SessionContext,
    numPlayers: number,
    humanSeat: number | null,
    bots: (string | null)[],
    seed?: number | null,
    debugReveal = false,
    id?: string,
  ): Promise<LocalSession> {
    const s = new LocalSession(ctx, numPlayers, humanSeat, bots, seed, debugReveal, id);
    await s.loadAgents();
    return s;
  }

  private async loadAgents(): Promise<void> {
    this.agents = [];
    for (let p = 0; p < this.numPlayers; p++) {
      const name = this.seatBots[p];
      if (name === null) {
        this.agents.push(null);
        continue;
      }
      const seed = subSeed(this.seed, 7, p);
      let agent = await tryAgent(this.ctx, name, { seed });
      if (!agent) {
        // Fall back to the next weaker working bot (e.g. no WebAssembly).
        const pref = this.ctx.preference;
        const chain = [...pref.slice(Math.max(0, pref.indexOf(name) + 1)), "random"];
        for (const alt of chain) {
          if (!this.ctx.registry.availableAgents().includes(alt)) continue;
          agent = await tryAgent(this.ctx, alt, { seed });
          if (agent) {
            console.warn(`seat ${p}: bot ${name} failed to load; playing ${alt}`);
            this.seatBots[p] = alt;
            break;
          }
        }
      }
      if (!agent) {
        agent = new RandomAgent(seed);
        this.seatBots[p] = "random";
      }
      agent.reset?.();
      this.agents.push(agent);
    }
  }

  // ---------------------------------------------------------- helpers
  needsHuman(g: DurakGame = this.game): boolean {
    return !g.done && this.humanSeat !== null && g.currentPlayer === this.humanSeat;
  }

  static passLabelOf(g: DurakGame): "bita" | "pass" | "take" | "done" | null {
    if (g.done) return null;
    if (g.phase === DEFEND) return "take";
    if (g.phase === ATTACK) {
      if (!g.attackCards.length) return null; // leading: PASS is not legal
      // Only the last thrower in priority order ends the bout with a pass.
      return g.throwerIdx === g.throwers.length - 1 ? "bita" : "pass";
    }
    return "done";
  }

  passLabel() {
    return LocalSession.passLabelOf(this.game);
  }

  revealAll(): boolean {
    return this.mode === "spectate" || this.debugReveal;
  }

  static endReason(g: DurakGame): "durak" | "draw" | "stalemate" | null {
    if (!g.done) return null;
    if (g.loser !== null) return "durak";
    if (g.config.stallBouts && g.stall >= g.config.stallBouts) return "stalemate";
    return "draw";
  }

  // ----------------------------------------------------------- stepping
  private async botAction(p: number): Promise<number> {
    const g = this.game;
    const agent = this.agents[p];
    const legal = g.legalActions();
    let a = -1;
    try {
      if (!agent) throw new Error("no agent");
      const view = g.determinize(p, this.rng);
      a = Math.trunc(Number(await agent.act(view, p)));
    } catch (e) {
      console.error(`bot ${this.seatBots[p]} failed at seat ${p}; playing random`, e);
      a = -1;
    }
    if (!legal.includes(a)) {
      if (a !== -1) console.warn(`bot ${this.seatBots[p]} chose illegal action ${a}; playing random`);
      a = this.rng.choice(legal);
    }
    return a;
  }

  /** Apply `action` for the current player and describe what happened. */
  apply(action: number, thinkMs?: number): StepDict {
    const g = this.game;
    const player = g.currentPlayer;
    const phase = g.phase;
    const throwers = g.throwers.slice();
    const tidx = g.throwerIdx;
    const attacker = g.attacker;
    const defender = g.defender;
    const table = [...g.attackCards, ...g.defenseCards];
    const leading = !g.attackCards.length;
    const handsBefore = g.hands.slice();
    const talonBefore = g.talon.length;
    const finishedBefore = g.finished.slice();
    const boutBefore = g.boutIndex;
    const passLabel = this.passLabel();

    g.step(action); // throws on illegal actions

    let card: number | null;
    let kind: string;
    if (action === PASS) {
      card = null;
      kind = passLabel as string; // bita / pass / take / done
    } else if (phase === ATTACK) {
      card = action;
      kind = leading ? "lead" : "throw";
    } else if (phase === DEFEND) {
      card = action;
      kind = "beat";
    } else {
      card = action;
      kind = "throw_in";
    }

    const events: Json[] = [];
    if (g.boutIndex !== boutBefore) {
      let tableMask: CardSet = 0;
      for (const c of table) tableMask += BIT[c];
      if (card !== null) tableMask += BIT[card];
      const tableCards = maskToList(tableMask);
      if (kind === "bita") events.push({ type: "bita", cards: tableCards });
      else events.push({ type: "pickup", player: defender, cards: tableCards });
      // Draw order: main attacker, others clockwise, defender last.
      const n = this.numPlayers;
      const order = [attacker];
      for (let k = 1; k < n; k++) {
        const q = (attacker + k) % n;
        if (!finishedBefore.includes(q) && q !== defender) order.push(q);
      }
      order.push(defender);
      const drawnAny: Json[] = [];
      for (const q of order) {
        const fresh = maskToList(g.hands[q]).filter((c) => !has(handsBefore[q], c) && !has(tableMask, c));
        if (fresh.length) {
          const ev: Json = { type: "draw", player: q, count: fresh.length };
          // Debug reveal is live-only: history never keeps bots' drawn cards.
          if (q === this.humanSeat || this.mode === "spectate") ev.cards = fresh;
          events.push(ev);
          drawnAny.push(ev);
        }
      }
      if (talonBefore && !g.talon.length && drawnAny.length) {
        drawnAny[drawnAny.length - 1].took_trump_card = true;
        events.push({ type: "talon_empty" });
      }
      for (const q of g.finished) {
        if (!finishedBefore.includes(q)) events.push({ type: "out", player: q, place: g.finished.indexOf(q) + 1 });
      }
      if (g.done) events.push({ type: "game_over", loser: g.loser, reason: LocalSession.endReason(g) });
      else events.push({ type: "new_bout", attacker: g.attacker, defender: g.defender });
    }

    const step: StepDict = {
      seq: this.history.length,
      player,
      action,
      card,
      kind,
      phase: PHASE_NAMES[phase],
      events,
      thrower_slot: phase !== DEFEND ? tidx : null,
      num_throwers: throwers.length,
    };
    if (thinkMs !== undefined) step.think_ms = thinkMs;
    this.history.push(step);
    return step;
  }

  async humanAct(action: number, auto = true): Promise<Json[]> {
    if (this.game.done) throw new GameError(409, "game is over");
    if (!this.needsHuman()) throw new GameError(409, "not your turn");
    if (!this.game.isLegal(action)) throw new GameError(400, `illegal action ${action}`);
    const steps: Json[] = [this.withView(this.apply(action))];
    if (auto) steps.push(...(await this.runBots()));
    return steps;
  }

  /** Play bot moves until it's the human's turn (or the game ends). If the
   * human is out, the rest of the game is played automatically. */
  async runBots(maxSteps?: number | null, untilBoutEnd = false): Promise<Json[]> {
    const out: Json[] = [];
    const g = this.game;
    while (!g.done && !this.needsHuman()) {
      if (maxSteps != null && out.length >= maxSteps) break;
      const p = g.currentPlayer;
      const t0 = now();
      const a = await this.botAction(p);
      const step = this.apply(a, Math.trunc(now() - t0));
      out.push(this.withView(step));
      if (untilBoutEnd && step.events.length) break;
    }
    return out;
  }

  private withView(step: StepDict): Json {
    return { ...step, view: this.view(true) };
  }

  // ------------------------------------------------------------- views
  /** Snapshot of everything the viewer may see. Hidden bot cards are only
   * included in spectate mode or with the debug reveal flag. `game` lets the
   * replay build views of historical positions. */
  view(compact = false, game?: DurakGame, reveal?: boolean): Json {
    const g = game ?? this.game;
    const me = this.humanSeat;
    const rev = reveal ?? this.revealAll();
    const toMove = g.done ? null : g.currentPlayer;
    const throwerSet = new Set(g.throwers);
    const players: Json[] = [];
    for (let p = 0; p < this.numPlayers; p++) {
      const fin = g.finished.indexOf(p);
      const entry: Json = {
        seat: p,
        name: this.names[p],
        persona: this.personas[p],
        bot: this.seatBots[p],
        is_human: p === me,
        hand_size: popcount(g.hands[p]),
        known: p === me ? [] : maskToList(g.known[p]),
        is_attacker: !g.done && p === g.attacker,
        is_defender: !g.done && p === g.defender,
        is_thrower: !g.done && throwerSet.has(p) && p !== g.attacker,
        to_move: p === toMove,
        out: fin >= 0,
        place: fin >= 0 ? fin + 1 : null,
        is_durak: g.done && g.loser === p,
      };
      if (p === me || rev) entry.hand = maskToList(g.hands[p]);
      players.push(entry);
    }
    const table = g.attackCards.map((a, i) => ({
      attack: a,
      defense: i < g.defenseCards.length ? g.defenseCards[i] : null,
    }));
    const yourTurn = this.needsHuman(g);
    const state: Json = {
      game_id: this.id,
      mode: this.mode,
      num_players: this.numPlayers,
      human_seat: me,
      debug_reveal: this.debugReveal && game === undefined,
      players,
      hand: me !== null ? maskToList(g.hands[me]) : [],
      table,
      bout_limit: g.boutLimit,
      first_bout: g.firstBout,
      trump_card: g.trumpCard,
      trump_suit: g.trump,
      talon_size: g.talon.length,
      discard_count: popcount(g.discard),
      attacker: g.attacker,
      defender: g.defender,
      throwers: g.throwers.slice(),
      thrower_idx: g.throwerIdx,
      phase: PHASE_NAMES[g.phase],
      to_move: toMove,
      your_turn: yourTurn,
      legal: yourTurn ? g.legalActions() : [],
      pass_label: yourTurn ? LocalSession.passLabelOf(g) : null,
      bout: g.boutIndex,
      moves: g.log.length,
      stall: g.stall,
      done: g.done,
      loser: g.done ? g.loser : null,
      finished: g.finished.slice(),
      result: this.result(g),
    };
    if (!compact) {
      state.discard = maskToList(g.discard);
      state.seed = (g.done || rev) && game === undefined ? this.seed : null;
    }
    return state;
  }

  result(g: DurakGame = this.game): Json | null {
    if (!g.done) return null;
    const res: Json = {
      loser: g.loser,
      draw: g.loser === null,
      reason: LocalSession.endReason(g),
      finished: g.finished.slice(),
    };
    const me = this.humanSeat;
    if (me !== null) {
      const fin = g.finished.indexOf(me);
      if (g.loser === null) {
        res.human = "draw";
        res.place = fin >= 0 ? fin + 1 : null;
      } else if (g.loser === me) {
        res.human = "durak";
        res.place = this.numPlayers;
      } else {
        res.human = "safe";
        res.place = fin + 1;
      }
    }
    return res;
  }

  recordDict() {
    const g = this.game;
    const res = (this.result() ?? {}) as Json;
    return {
      id: this.id,
      mode: this.mode,
      num_players: this.numPlayers,
      human_seat: this.humanSeat,
      seats: this.seatBots.map((b) => (b !== null ? b : "human")),
      loser: g.loser,
      finished: g.finished.slice(),
      human_result: (res.human as string | undefined) ?? null,
      human_place: res.human !== "draw" ? ((res.place as number | null | undefined) ?? null) : null,
      moves: g.log.length,
      seed: this.seed,
      debug_used: this.debugUsed,
      end_reason: (res.reason as string | undefined) ?? null,
      hints_used: this.hintsUsed,
    };
  }

  /** The real game re-created from the deal (for replay and analysis). */
  freshGame(): DurakGame {
    return this.makeGame();
  }

  replayGame(upto: number): DurakGame {
    const g = this.freshGame();
    for (const [, a] of this.game.log.slice(0, upto)) g.step(a);
    return g;
  }

  /** Champion's estimate of P(not durak). For the human only, computed on
   * determinizations from the human's point of view (no leakage). */
  async evaluate(): Promise<Json> {
    const agent = await makeAnalyst(this.ctx);
    const g = this.game;
    if (!agent || !agent.evaluate) return { available: false, values: {} };
    if (g.done) return { available: true, values: {} };
    const seats = this.humanSeat !== null ? [this.humanSeat] : Array.from({ length: this.numPlayers }, (_, p) => p);
    const values: Record<string, number> = {};
    const rng = new Rng(subSeed(this.seed, 31, g.log.length));
    for (const p of seats) {
      if (!g.isActive(p)) continue;
      try {
        let acc = 0;
        for (let i = 0; i < 2; i++) acc += Number(await agent.evaluate(g.determinize(p, rng), p));
        values[String(p)] = round4(clamp01(acc / 2));
      } catch (e) {
        console.error("evaluate failed", e);
        return { available: false, values: {} };
      }
    }
    return { available: true, values };
  }

  // -------------------------------------------------------- persistence
  toSaved(): SavedSession {
    return {
      id: this.id,
      seed: this.seed,
      num_players: this.numPlayers,
      human_seat: this.humanSeat,
      seat_bots: this.seatBots.slice(),
      debug_reveal: this.debugReveal,
      debug_used: this.debugUsed,
      hints_used: this.hintsUsed,
      recorded: this.recorded,
      actions: this.game.log.map(([, a]) => a),
      history: this.history.map((h) => ({ ...h })),
      touched: Date.now(),
    };
  }

  /** Rebuild a session after a page reload: same deal, same moves. */
  static async restore(ctx: SessionContext, s: SavedSession): Promise<LocalSession> {
    const sess = await LocalSession.create(ctx, s.num_players, s.human_seat, s.seat_bots, s.seed, s.debug_reveal, s.id);
    for (const a of s.actions) sess.game.step(a);
    sess.history = s.history.map((h) => ({ ...h })) as StepDict[];
    sess.debugUsed = s.debug_used;
    sess.hintsUsed = s.hints_used;
    sess.recorded = s.recorded;
    // determinization stream continues from a fresh, move-dependent state
    sess.rng = new Rng(subSeed(s.seed, 0x5eed, s.actions.length));
    return sess;
  }
}

// ===================================================================
// Coach features (server/analysis.py)
// ===================================================================

async function value(agent: Agent, g: DurakGame, me: number): Promise<number> {
  return clamp01(Number(await agent.evaluate!(g, me)));
}

/** P(`me` not durak) after each legal action, averaged over determinizations
 * of `me`'s information set; plus the current value. */
export async function actionValues(
  agent: Agent,
  g: DurakGame,
  me: number,
  rng: Rng,
  dets: number,
): Promise<{ values: Map<number, number>; current: number; exact: boolean }> {
  const exact = solverApplicable(g);
  const samples = Array.from({ length: exact ? 1 : dets }, () => g.determinize(me, rng));
  const legal = g.legalActions();
  const values = new Map<number, number>();
  for (const a of legal) {
    let acc = 0;
    for (const s of samples) {
      const s2 = s.clone();
      s2.step(a);
      acc += await value(agent, s2, me);
    }
    values.set(a, acc / samples.length);
  }
  let cur = 0;
  for (const s of samples) cur += await value(agent, s, me);
  return { values, current: cur / samples.length, exact };
}

/** Python max(seq, key=...) returns the first maximal element. */
function argmax<T>(xs: T[], key: (x: T) => number[]): T {
  let best = xs[0];
  let bk = key(best);
  for (let i = 1; i < xs.length; i++) {
    const k = key(xs[i]);
    for (let j = 0; j < k.length; j++) {
      if (k[j] > bk[j]) {
        best = xs[i];
        bk = k;
        break;
      }
      if (k[j] < bk[j]) break;
    }
  }
  return best;
}

const round3 = (x: number) => pyRound(x, 3);

export async function computeHint(sess: LocalSession): Promise<Json> {
  const g = sess.game;
  const me = sess.humanSeat;
  if (me === null || !sess.needsHuman()) throw new GameError(409, "hints are only available on your turn");
  const legal = g.legalActions();
  const agent = await makeAnalyst(sess.ctx);
  if (agent) {
    try {
      return await championHint(sess, agent, g, me, legal);
    } catch (e) {
      console.error("champion hint failed; falling back to the default bot", e);
    }
  }
  // Fall back to the strongest working bot's choice, without win %.
  const rng = new Rng(subSeed(sess.seed, 1009, g.log.length));
  let a = legal[0];
  for (const name of [defaultBot(sess.ctx), "heuristic", "random"]) {
    try {
      const bot = await tryAgent(sess.ctx, name);
      if (!bot) continue;
      bot.reset?.();
      a = Math.trunc(Number(await bot.act(g.determinize(me, rng), me)));
      if (legal.includes(a)) break;
    } catch {
      continue;
    }
  }
  return {
    available: true,
    has_values: false,
    recommended: legal.includes(a) ? a : legal[0],
    moves: legal.map((x) => ({ action: x, win: null, policy: null })),
  };
}

async function championHint(sess: LocalSession, agent: Agent, g: DurakGame, me: number, legal: number[]): Promise<Json> {
  if (typeof agent.policy !== "function") throw new Error("analyst has no policy()");
  const rng = new Rng(subSeed(sess.seed, 1009, g.log.length));
  const { values, current, exact } = await actionValues(agent, g, me, rng, 8);
  // The policy only depends on public info + our own hand.
  const policy = policyMap(await agent.policy(g.determinize(me, rng), me));
  const pol = (a: number) => Number(policy.get(a) ?? 0);
  const best = argmax(legal, (a) => [round3(values.get(a)!), pol(a)]);
  // The policy's favourite, unless the evaluated win chance clearly prefers
  // another move (search-like refinement over determinizations).
  const top = argmax(legal, (a) => [pol(a)]);
  const recommended = exact || values.get(best)! - values.get(top)! > 0.03 ? best : top;
  const moves = legal
    .map((a) => ({ action: a, win: round4(values.get(a)!), policy: round4(pol(a)) }))
    .sort((x, y) => y.win - x.win || y.policy - x.policy);
  return {
    available: true,
    has_values: true,
    exact,
    current: round4(current),
    recommended,
    best,
    moves,
  };
}

// ------------------------------------------------------------------ analysis
async function runAnalysis(sess: LocalSession, state: AnalysisState, budgetMs: number): Promise<void> {
  try {
    const agent = await makeAnalyst(sess.ctx);
    if (!agent) {
      state.status = "unavailable";
      return;
    }
    const me = sess.humanSeat as number;
    const moves = sess.game.log.slice();
    const g = sess.freshGame();
    const rng = new Rng(subSeed(sess.seed, 7919));
    const t0 = now();
    const timeline: Json[] = [];
    const decisions: Json[] = [];
    for (let k = 0; k <= moves.length; k++) {
      if (now() - t0 > budgetMs) {
        state.partial = true;
        break;
      }
      let v: number;
      let vals: Map<number, number> | null = null;
      if (g.done) {
        v = g.loser === me ? 0 : 1;
      } else if (!g.isActive(me)) {
        v = 1;
      } else if (k < moves.length && moves[k][0] === me && g.legalActions().length > 1) {
        const r = await actionValues(agent, g, me, rng, 3);
        vals = r.values;
        v = r.current;
      } else {
        const exact = solverApplicable(g);
        const n = exact ? 1 : 3;
        let acc = 0;
        for (let i = 0; i < n; i++) acc += await value(agent, g.determinize(me, rng), me);
        v = acc / n;
      }
      timeline.push({ seq: k, win: round4(v) });
      if (k < moves.length) {
        const [p, a] = moves[k];
        if (vals !== null && p === me) {
          const keys = [...vals.keys()];
          const best = argmax(keys, (x) => [vals!.get(x)!]);
          const sorted = [...vals.entries()].sort((x, y) => y[1] - x[1]);
          decisions.push({
            seq: k,
            chosen: a,
            best,
            chosen_win: round4(vals.get(a)!),
            best_win: round4(vals.get(best)!),
            loss: round4(Math.max(0, vals.get(best)! - vals.get(a)!)),
            values: sorted.map(([x, y]) => ({ action: x, win: round4(y) })),
          });
        }
        g.step(a);
      }
      state.progress = pyRound((k + 1) / (moves.length + 1), 3);
      await yieldNow();
    }
    const mistakes = decisions
      .filter((d) => (d.loss as number) >= 0.04)
      .sort((x, y) => (y.loss as number) - (x.loss as number))
      .slice(0, 5);
    Object.assign(state, {
      status: "ready",
      timeline,
      decisions,
      mistakes,
      accuracy: decisions.length
        ? round4(1 - decisions.reduce((s, d) => s + (d.loss as number), 0) / Math.max(1, decisions.length))
        : null,
      seconds: pyRound((now() - t0) / 1000, 1),
    });
  } catch (e) {
    console.error("analysis failed", e);
    Object.assign(state, { status: "error", error: String(e) });
  }
}

export function getAnalysis(sess: LocalSession, budgetMs = ANALYSIS_TIME_BUDGET_MS): Json {
  if (!sess.game.done) throw new GameError(409, "analysis is available after the game");
  if (sess.mode !== "play") throw new GameError(409, "analysis is for games with a human player");
  if (sess.analysis === null) {
    sess.analysis = { status: "running", progress: 0.0 };
    void runAnalysis(sess, sess.analysis, budgetMs);
  }
  return { ...sess.analysis };
}

/** Every position of a finished game as the human saw it. */
export function getReplay(sess: LocalSession): Json {
  if (!sess.game.done) throw new GameError(409, "replay is available after the game");
  const g = sess.freshGame();
  const reveal = sess.mode === "spectate";
  const frames: Json[] = [{ seq: 0, step: null, view: sess.view(false, g, reveal) }];
  sess.game.log.forEach(([, a], k) => {
    g.step(a);
    frames.push({
      seq: k + 1,
      step: k < sess.history.length ? sess.history[k] : null,
      view: sess.view(false, g, reveal),
    });
  });
  return { game_id: sess.id, frames, result: sess.result() };
}
