// Exact endgame solver for perfect-information Durak positions, in the browser.
//
// The search core is durak/_solver.c compiled to WebAssembly
// (scripts/build_solver_wasm.sh -> public/ai/solver.wasm). This module ports the
// Python wrapper (durak/solver.py, NativeEndgameSolver): state packing in the
// attacker's frame, the null-window root search, time/node budgets with the
// None-on-timeout fallback, `applicable` and `actionValues`. Values are for the
// given player: +1 the other player ends up the durak, 0 draw, -1 we lose.
//
// The transposition table lives in wasm memory (2^solverTTLog2 entries of 48
// bytes; 2^19 = 24 MiB by default), keyed by trump card, and carries over
// between moves and games.

import { BIT, NUM_CARDS, beatersMask, hi, intersects, lo, popcount, rankOf, suitOf, type CardSet } from "../cards";
import { ATTACK, DEFEND, PASS, type DurakGame } from "../engine";
import { aiConfig } from "./runtime";

export const WIN = 1;
export const DRAW = 0;
export const LOSS = -1;
const ABORT = -100;

interface SolverExports {
  memory: WebAssembly.Memory;
  dkw_init(log2: number): number;
  dkw_clear(): void;
  dkw_set_trump(c: number): void;
  dkw_set_budget(nodeLimit: number, seconds: number): void;
  dkw_nodes(): number;
  dkw_set_option(which: number, val: number): void;
  dkw_set_horizon(depth: number, hz: number): void;
  dkw_hz_hits(): number;
  dkw_attack(al: number, ah: number, dl: number, dh: number, tl: number, th: number, n: number, limit: number,
    flag: number, alpha: number, beta: number): number;
  dkw_defend(al: number, ah: number, dl: number, dh: number, tl: number, th: number, n: number, c: number,
    limit: number, flag: number, alpha: number, beta: number): number;
  dkw_take(al: number, ah: number, dl: number, dh: number, tl: number, th: number, n: number, limit: number,
    flag: number, alpha: number, beta: number): number;
  dkw_end_bout(al: number, ah: number, dl: number, dh: number, defended: number, flag: number, alpha: number,
    beta: number): number;
}

class Aborted extends Error {}

/** True when the position is perfect information and two-player: the talon is
 * empty and exactly two players are active, or two players play with only the
 * face-up trump card left in the talon. */
export function applicable(game: DurakGame): boolean {
  if (game.done) return false;
  const active = game.activePlayers;
  if (active.length !== 2) return false;
  if (!game.talon.length) return true;
  return game.talon.length === 1 && game.numPlayers === 2;
}

const ORDER_VAL: number[][] = [0, 1, 2, 3].map((trump) =>
  Array.from({ length: NUM_CARDS }, (_, c) => rankOf(c) + (suitOf(c) === trump ? 20 : 0)),
);

export class EndgameSolver {
  readonly ex: SolverExports;
  /** Nodes searched by the last call. */
  nodes = 0;
  private trumpCard = -1;

  constructor(ex: SolverExports) {
    this.ex = ex;
  }

  // ------------------------------------------------------------ raw nodes
  private ok(v: number): number {
    if (v === ABORT) throw new Aborted();
    return v;
  }
  private attack(a: CardSet, d: CardSet, tab: CardSet, n: number, limit: number, flag: number, alpha: number, beta: number) {
    return this.ok(this.ex.dkw_attack(lo(a), hi(a), lo(d), hi(d), lo(tab), hi(tab), n, limit, flag, alpha, beta));
  }
  private defend(a: CardSet, d: CardSet, tab: CardSet, n: number, c: number, limit: number, flag: number, alpha: number,
    beta: number) {
    return this.ok(this.ex.dkw_defend(lo(a), hi(a), lo(d), hi(d), lo(tab), hi(tab), n, c, limit, flag, alpha, beta));
  }
  private take(a: CardSet, d: CardSet, tab: CardSet, n: number, limit: number, flag: number, alpha: number, beta: number) {
    return this.ok(this.ex.dkw_take(lo(a), hi(a), lo(d), hi(d), lo(tab), hi(tab), n, limit, flag, alpha, beta));
  }
  private endBout(a: CardSet, d: CardSet, defended: boolean, flag: number, alpha: number, beta: number) {
    return this.ok(this.ex.dkw_end_bout(lo(a), hi(a), lo(d), hi(d), defended ? 1 : 0, flag, alpha, beta));
  }

  private setBudget(trumpCard: number, timeLimit: number | null, nodeLimit: number | null): void {
    this.nodes = 0;
    this.trumpCard = trumpCard;
    this.ex.dkw_set_horizon(-1, 0);
    this.ex.dkw_set_trump(trumpCard);
    this.ex.dkw_set_budget(nodeLimit === null ? -1 : nodeLimit, timeLimit === null ? -1 : timeLimit);
  }

  // ------------------------------------------------------------ root
  private rootState(game: DurakGame) {
    const att = game.attacker;
    const dfd = game.defender;
    return {
      att,
      a: game.hands[att],
      d: game.hands[dfd],
      tab: game.tableMask,
      n: game.attackCards.length,
      limit: game.boutLimit,
      flag: game.talon.length ? 1 : 0,
    };
  }

  private child(game: DurakGame, act: number, a: CardSet, d: CardSet, tab: CardSet, n: number, limit: number,
    flag: number, alpha: number, beta: number): number {
    if (game.phase === ATTACK) {
      if (act === PASS) return this.endBout(a, d, true, flag, alpha, beta);
      const bit = BIT[act];
      return this.defend(a - bit, d, tab + bit, n + 1, act, limit, flag, alpha, beta);
    }
    if (game.phase === DEFEND) {
      if (act === PASS) return this.take(a, d, tab, n, limit, flag, alpha, beta);
      const bit = BIT[act];
      return this.attack(a, d - bit, tab + bit, n, limit, flag, alpha, beta);
    }
    // THROW_IN: the attacker keeps throwing; PASS = done
    if (act === PASS) return this.endBout(a, d + tab, false, flag, alpha, beta);
    const bit = BIT[act];
    return this.take(a - bit, d, tab + bit, n + 1, limit, flag, alpha, beta);
  }

  /** Root move order: cards by static value (trumps last), unbeatable leads
   * first when attacking, PASS last. */
  private rootMoves(game: DurakGame, d: CardSet): number[] {
    const legal = game.legalActions();
    const ov = ORDER_VAL[game.trump];
    const cards = legal.filter((x) => x !== PASS);
    cards.sort((x, y) => ov[x] - ov[y]);
    if (game.phase === ATTACK) {
      const k = (c: number) => (intersects(d, beatersMask(c, game.trump)) ? 1 : 0);
      cards.sort((x, y) => k(x) - k(y));
    }
    if (legal.includes(PASS)) cards.push(PASS);
    return cards;
  }

  private exists(game: DurakGame, moves: number[], st: ReturnType<EndgameSolver["rootState"]>, maximizing: boolean,
    target: number): number | null {
    const [alpha, beta] = maximizing ? [target - 1, target] : [target, target + 1];
    const bad = maximizing ? LOSS : WIN;
    // Full-depth search (no bout horizon): the first move that reaches the
    // target is a proof.
    this.ex.dkw_set_horizon(-1, bad);
    for (const act of moves) {
      const v = this.child(game, act, st.a, st.d, st.tab, st.n, st.limit, st.flag, alpha, beta);
      if (maximizing ? v >= target : v <= target) return act;
    }
    return null;
  }

  private rootBest(game: DurakGame, player: number): [number, number] {
    const st = this.rootState(game);
    const maximizing = game.currentPlayer === st.att;
    const moves = this.rootMoves(game, st.d);
    const sign = player === st.att ? 1 : -1;
    try {
      for (const target of maximizing ? [WIN, DRAW] : [LOSS, DRAW]) {
        const act = this.exists(game, moves, st, maximizing, target);
        if (act !== null) return [sign * target + 0, act]; // + 0: no -0 for a draw
      }
      return [sign * (maximizing ? LOSS : WIN), moves[0]];
    } finally {
      this.ex.dkw_set_horizon(-1, 0);
    }
  }

  /** (value for `player`, best action for the player to move) or null when
   * out of budget. `timeLimit` in seconds (null = none). */
  solveGame(game: DurakGame, player: number, timeLimit: number | null = 1.0, nodeLimit: number | null = null):
    [number, number] | null {
    this.setBudget(game.trumpCard, timeLimit, nodeLimit);
    try {
      return this.rootBest(game, player);
    } catch (e) {
      if (e instanceof Aborted) return null;
      throw e;
    } finally {
      this.nodes = this.ex.dkw_nodes();
    }
  }

  /** Exact value (for `player`) of every legal action of the player to move,
   * or null when out of budget. */
  actionValues(game: DurakGame, player: number, timeLimit: number | null = 1.0, nodeLimit: number | null = null):
    Map<number, number> | null {
    this.setBudget(game.trumpCard, timeLimit, nodeLimit);
    try {
      const st = this.rootState(game);
      const sign = player === st.att ? 1 : -1;
      const out = new Map<number, number>();
      for (const act of game.legalActions()) {
        out.set(act, sign * this.child(game, act, st.a, st.d, st.tab, st.n, st.limit, st.flag, -1, 1) + 0);
      }
      return out;
    } catch (e) {
      if (e instanceof Aborted) return null;
      throw e;
    } finally {
      this.nodes = this.ex.dkw_nodes();
    }
  }

  /** Exact solve of a perfect-information endgame: `(value, bestAction)` with
   * the value for `player`, or null if not applicable / `player` not active /
   * out of budget. Safe on a determinized copy (exact in these positions). */
  solve(game: DurakGame, player: number, timeLimit: number | null = 1.0, nodeLimit: number | null = null):
    [number, number] | null {
    if (!applicable(game) || !game.activePlayers.includes(player)) return null;
    return this.solveGame(game, player, timeLimit, nodeLimit);
  }

  /** `{action: value for player}` for every legal action, or null. */
  values(game: DurakGame, player: number, timeLimit: number | null = 1.0, nodeLimit: number | null = null):
    Map<number, number> | null {
    if (!applicable(game) || !game.activePlayers.includes(player)) return null;
    return this.actionValues(game, player, timeLimit, nodeLimit);
  }

  /** Port of durak.rl.rollout.solve_small: exact (returns, loser) of a small
   * two-player endgame with an empty talon and at most `maxCards` cards in
   * play, within `nodes` nodes; null otherwise. */
  solveSmall(g: DurakGame, maxCards: number, nodes: number): { returns: number[]; loser: number | null } | null {
    if (g.talon.length || g.numPlayers - g.finished.length !== 2) return null;
    let cards = g.attackCards.length + g.defenseCards.length;
    for (const h of g.hands) cards += popcount(h);
    if (cards > maxCards) return null;
    if (!applicable(g)) return null;
    const act = g.activePlayers;
    const a = act[0];
    const res = this.solve(g, a, null, nodes);
    if (res === null) return null;
    const n = g.numPlayers;
    if (res[0] === 0) return { returns: new Array(n).fill(0), loser: null };
    const loser = res[0] < 0 ? a : act[1];
    const returns: number[] = [];
    for (let q = 0; q < n; q++) returns.push(q === loser ? -1.0 : 1.0 / (n - 1));
    return { returns, loser };
  }

  /** Last trump card searched (for diagnostics). */
  get lastTrumpCard(): number {
    return this.trumpCard;
  }

  /** Clear the transposition table. */
  clear(): void {
    this.ex.dkw_clear();
  }
}

// ----------------------------------------------------------- loading
let loading: Promise<EndgameSolver> | null = null;

/** Instantiate solver.wasm from raw bytes. */
export async function instantiateSolver(bytes: Uint8Array, ttLog2 = 19): Promise<EndgameSolver> {
  const { instance } = await WebAssembly.instantiate(bytes, { env: { now_ms: () => performance.now() } });
  const ex = instance.exports as unknown as SolverExports;
  if (ex.dkw_init(ttLog2) !== 0) throw new Error(`solver: cannot allocate 2^${ttLog2} TT entries`);
  return new EndgameSolver(ex);
}

/** The shared solver instance (loaded once). */
export function loadSolver(): Promise<EndgameSolver> {
  if (!loading) {
    const cfg = aiConfig();
    loading = cfg
      .loadBytes(cfg.solverUrl)
      .then((b) => instantiateSolver(b, cfg.solverTTLog2))
      .catch((e) => {
        loading = null;
        throw e;
      });
  }
  return loading;
}
