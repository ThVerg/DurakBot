// Observation encoding for the RL policy: exact port of durak/rl/encoding.py.
//
// Everything here uses only information available to the acting player: their
// own hand, public fields of the game, `game.known` and the public action log.
// Hidden opponent hands / talon order are never read (only hand *sizes*).
//
// Layout (float32 vector of length OBS_DIM = 918): 23 card planes of 36 entries
// in canonical suit space, then 90 scalars. Suit canonicalisation: trump is
// canonical suit 0; the three other suits are sorted by a key made from all
// planes restricted to that suit (descending, stable), so suits that look the
// same are interchangeable. Canonical card c' = canon[suit(c)] * 9 + rank(c).
// Seats are relative to the observer: slot 0 is self, slots 1..5 the opponents
// clockwise, padded with "absent".

import {
  BIT,
  FULL_MASK,
  NUM_CARDS,
  NUM_RANKS,
  RANK_MASKS,
  and,
  beatersMask,
  hi,
  lo,
  or,
  popcount,
  rankOf,
  type CardSet,
} from "../cards";
import { ATTACK, DEFEND, PASS, THROW_IN, type DurakGame } from "../engine";

export const MAX_PLAYERS = 6;
export const MAX_OPP = MAX_PLAYERS - 1;

// planes
export const P_HAND = 0;
export const P_OPP_KNOWN = 1; // 5 planes, rel seats 1..5
export const P_DISCARD = 6;
export const P_UNCOVERED = 7;
export const P_COVERED = 8;
export const P_DEFENSE = 9;
export const P_UNSEEN = 10;
export const P_TRUMP_FACEUP = 11;
export const P_MY_KNOWN = 12;
export const P_CANT_BEAT = 13; // 5 planes
export const P_NO_THROW = 18; // 5 planes
export const NUM_PLANES = 23;

// scalars
export const SEAT_FEATS = 9;
export const NUM_SCALARS_V1 = MAX_PLAYERS * SEAT_FEATS + 3 + 4 + 4 + 5 + 5 + 5 + 3; // 83
export const NUM_SCALARS = NUM_SCALARS_V1 + 1 + 5 + 1; // 90
export const OBS_DIM_V1 = NUM_PLANES * NUM_CARDS + NUM_SCALARS_V1; // 911
export const OBS_DIM = NUM_PLANES * NUM_CARDS + NUM_SCALARS; // 918
export const UNKNOWN_COL = OBS_DIM_V1 + 1;
export const NUM_LOCS = 6; // belief classes: opponent rel seat 1..5, talon
export const NUM_ACTIONS = NUM_CARDS + 1;

const SUIT_SCALE = [1, 2 ** 9, 2 ** 18, 2 ** 27];

/** Bits of suit `s` of a mask, as a 9-bit int. */
export function suitChunk(m: CardSet, s: number): number {
  return Math.floor(m / SUIT_SCALE[s]) % 512;
}

// ------------------------------------------------------------------ tracker
/** Replays the public action log with card *counts* only (no hidden info). */
export class PublicTracker {
  n: number;
  trump: number;
  counts: number[];
  talon: number;
  finished: number[] = [];
  attacker: number;
  defender = 0;
  throwers: number[] = [];
  throwerIdx = 0;
  phase = ATTACK;
  attack: number[] = [];
  defense: number[] = [];
  firstBout = true;
  boutLimit = 0;
  done = false;
  cantBeat: CardSet[];
  noThrow: CardSet[];
  takes: number[];
  tookLast: boolean[];
  nEvents = 0;

  constructor(numPlayers: number, trump: number, firstAttacker: number, init = true) {
    const n = numPlayers;
    this.n = n;
    this.trump = trump;
    this.counts = new Array(n).fill(6);
    this.talon = 36 - 6 * n;
    this.attacker = firstAttacker;
    this.cantBeat = new Array(n).fill(0);
    this.noThrow = new Array(n).fill(0);
    this.takes = new Array(n).fill(0);
    this.tookLast = new Array(n).fill(false);
    if (init) this.startBout();
  }

  /** Build a tracker by replaying `game.log` (public information). */
  static fromGame(game: DurakGame): PublicTracker {
    const first = game.log.length ? game.log[0][0] : game.attacker;
    const t = new PublicTracker(game.numPlayers, game.trump, first);
    t.sync(game);
    return t;
  }

  /** Consume any new entries of `game.log`. */
  sync(game: DurakGame): void {
    const log = game.log;
    while (this.nEvents < log.length) {
      const e = log[this.nEvents];
      this.event(e[0], e[1]);
    }
  }

  clone(): PublicTracker {
    const c = new PublicTracker(this.n, this.trump, this.attacker, false);
    c.counts = this.counts.slice();
    c.talon = this.talon;
    c.finished = this.finished.slice();
    c.defender = this.defender;
    c.throwers = this.throwers.slice();
    c.throwerIdx = this.throwerIdx;
    c.phase = this.phase;
    c.attack = this.attack.slice();
    c.defense = this.defense.slice();
    c.firstBout = this.firstBout;
    c.boutLimit = this.boutLimit;
    c.done = this.done;
    c.cantBeat = this.cantBeat.slice();
    c.noThrow = this.noThrow.slice();
    c.takes = this.takes.slice();
    c.tookLast = this.tookLast.slice();
    c.nEvents = this.nEvents;
    return c;
  }

  private nextActive(p: number): number {
    const n = this.n;
    for (let k = 1; k <= n; k++) {
      const q = (p + k) % n;
      if (!this.finished.includes(q)) return q;
    }
    throw new Error("no active players");
  }

  private startBout(): void {
    this.defender = this.nextActive(this.attacker);
    const other = this.nextActive(this.defender);
    this.throwers = other === this.attacker ? [this.attacker] : [this.attacker, other];
    this.throwerIdx = 0;
    const cap = this.firstBout ? 5 : 6;
    this.boutLimit = Math.min(cap, this.counts[this.defender]);
    this.attack = [];
    this.defense = [];
    this.phase = ATTACK;
  }

  event(p: number, a: number): void {
    this.nEvents += 1;
    const ph = this.phase;
    if (ph === ATTACK) {
      if (a === PASS) {
        this.throwerIdx += 1;
        if (this.throwerIdx === this.throwers.length) this.endBout(true);
      } else {
        this.counts[p] -= 1;
        this.attack.push(a);
        this.phase = DEFEND;
      }
    } else if (ph === DEFEND) {
      if (a === PASS) {
        this.cantBeat[p] = or(this.cantBeat[p], beatersMask(this.attack[this.attack.length - 1], this.trump));
        this.phase = THROW_IN;
        this.throwerIdx = 0;
      } else {
        this.counts[p] -= 1;
        this.defense.push(a);
        this.phase = ATTACK;
        this.throwerIdx = 0;
      }
    } else {
      if (a === PASS) {
        if (this.attack.length < this.boutLimit) {
          let m = 0;
          for (const c of this.attack) m = or(m, RANK_MASKS[rankOf(c)]);
          for (const c of this.defense) m = or(m, RANK_MASKS[rankOf(c)]);
          this.noThrow[p] = or(this.noThrow[p], m);
        }
        this.throwerIdx += 1;
        if (this.throwerIdx === this.throwers.length) {
          const d = this.defender;
          this.counts[d] += this.attack.length + this.defense.length;
          this.takes[d] += 1;
          this.endBout(false);
        }
      } else {
        this.counts[p] -= 1;
        this.attack.push(a);
      }
    }
  }

  private endBout(defended: boolean): void {
    const order = [this.attacker];
    let p = this.nextActive(this.attacker);
    while (p !== this.attacker) {
      if (p !== this.defender) order.push(p);
      p = this.nextActive(p);
    }
    order.push(this.defender);
    for (const q of order) {
      const need = 6 - this.counts[q];
      if (need > 0 && this.talon > 0) {
        const k = Math.min(need, this.talon);
        this.counts[q] += k;
        this.talon -= k;
        this.cantBeat[q] = 0;
        this.noThrow[q] = 0;
      }
    }
    for (let q = 0; q < this.n; q++) this.tookLast[q] = false;
    if (!defended) this.tookLast[this.defender] = true;
    this.firstBout = false;
    if (this.talon === 0) {
      for (const q of order) {
        if (this.counts[q] === 0 && !this.finished.includes(q)) this.finished.push(q);
      }
    }
    let active = 0;
    for (let q = 0; q < this.n; q++) if (!this.finished.includes(q)) active++;
    if (active <= 1) {
      this.done = true;
      return;
    }
    if (defended && !this.finished.includes(this.defender)) this.attacker = this.defender;
    else this.attacker = this.nextActive(this.defender);
    this.startBout();
  }
}

// --------------------------------------------------------------- suit canon
/** canon[s] = canonical index of real suit s (trump -> 0). */
export function canonPerm(planes: readonly CardSet[], trump: number): number[] {
  const others = [0, 1, 2, 3].filter((s) => s !== trump);
  const keys = new Map<number, number[]>();
  for (const s of others) keys.set(s, planes.map((m) => suitChunk(m, s)));
  // Descending lexicographic order; Array.prototype.sort is stable, like Python.
  others.sort((x, y) => {
    const kx = keys.get(x) as number[];
    const ky = keys.get(y) as number[];
    for (let i = 0; i < kx.length; i++) if (kx[i] !== ky[i]) return ky[i] - kx[i];
    return 0;
  });
  const canon = [0, 0, 0, 0];
  others.forEach((s, i) => (canon[s] = i + 1));
  return canon;
}

export function remapMask(mask: CardSet, canon: readonly number[]): CardSet {
  if (mask === 0) return 0;
  let out = 0;
  for (let s = 0; s < 4; s++) out += suitChunk(mask, s) * SUIT_SCALE[canon[s]];
  return out;
}

export function inversePerm(canon: readonly number[]): number[] {
  const inv = [0, 0, 0, 0];
  canon.forEach((c, s) => (inv[c] = s));
  return inv;
}

/** Canonical action -> real action. */
export function toRealAction(a: number, canon: readonly number[]): number {
  if (a >= NUM_CARDS) return a;
  const inv = inversePerm(canon);
  return inv[(a / NUM_RANKS) | 0] * NUM_RANKS + (a % NUM_RANKS);
}

/** Real action -> canonical action. */
export function toCanonAction(a: number, canon: readonly number[]): number {
  if (a >= NUM_CARDS) return a;
  return canon[(a / NUM_RANKS) | 0] * NUM_RANKS + (a % NUM_RANKS);
}

// ----------------------------------------------------------------- encoding
export interface EncodedParts {
  /** 23 canonical plane masks. */
  planes: CardSet[];
  /** 90 scalar features (float64, exactly as Python computes them). */
  scalars: number[];
  /** canonical legal mask (37 bits, bit 36 = PASS); 0 unless `player` is to move. */
  clegal: number;
  /** canon[s] = canonical index of real suit s. */
  canon: number[];
}

/** Port of encode_parts. `tracker` must be in sync with `game.log`. */
export function encodeParts(game: DurakGame, player: number, tracker: PublicTracker): EncodedParts {
  const n = game.numPlayers;
  const hand = game.hands[player];
  const known = game.known;
  const atk = game.attackCards;
  const dfn = game.defenseCards;
  const unseen = game.unseenMask(player);

  const planes: CardSet[] = new Array(NUM_PLANES).fill(0);
  planes[P_HAND] = hand;
  for (let k = 1; k < n; k++) {
    const q = (player + k) % n;
    planes[P_OPP_KNOWN + k - 1] = known[q];
    planes[P_CANT_BEAT + k - 1] = and(tracker.cantBeat[q], unseen);
    planes[P_NO_THROW + k - 1] = and(tracker.noThrow[q], unseen);
  }
  planes[P_DISCARD] = game.discard;
  const nd = dfn.length;
  let unc = 0;
  for (let i = nd; i < atk.length; i++) unc += BIT[atk[i]];
  planes[P_UNCOVERED] = unc;
  let cov = 0;
  for (let i = 0; i < nd; i++) cov += BIT[atk[i]];
  planes[P_COVERED] = cov;
  let dm = 0;
  for (const c of dfn) dm += BIT[c];
  planes[P_DEFENSE] = dm;
  planes[P_UNSEEN] = unseen;
  const talonN = game.talon.length;
  if (talonN) planes[P_TRUMP_FACEUP] = BIT[game.trumpCard];
  planes[P_MY_KNOWN] = known[player];

  const canon = canonPerm(planes, game.trump);
  const cplanes = planes.map((m) => (m ? remapMask(m, canon) : 0));

  // ---- scalars
  const sc: number[] = [];
  const finished = game.finished;
  const attacker = game.attacker;
  const defender = game.defender;
  const throwers = game.throwers;
  for (let k = 0; k < MAX_PLAYERS; k++) {
    if (k < n) {
      const q = (player + k) % n;
      const act = !finished.includes(q);
      sc.push(
        1.0,
        act ? 1.0 : 0.0,
        popcount(game.hands[q]) / 6.0,
        q === attacker ? 1.0 : 0.0,
        q === defender ? 1.0 : 0.0,
        throwers.includes(q) && q !== attacker ? 1.0 : 0.0,
        Math.min(tracker.takes[q], 8) / 4.0,
        tracker.tookLast[q] ? 1.0 : 0.0,
        !act ? (finished.indexOf(q) + 1) / 5.0 : 0.0,
      );
    } else {
      for (let i = 0; i < SEAT_FEATS; i++) sc.push(0.0);
    }
  }
  const ph = game.phase;
  sc.push(ph === ATTACK ? 1.0 : 0.0, ph === DEFEND ? 1.0 : 0.0, ph === THROW_IN ? 1.0 : 0.0);
  let role: number;
  if (player === attacker) role = 0;
  else if (player === defender) role = 2;
  else if (throwers.includes(player)) role = 1;
  else role = 3;
  for (let i = 0; i < 4; i++) sc.push(i === role ? 1.0 : 0.0);
  sc.push(talonN / 24.0, talonN === 0 ? 1.0 : 0.0, game.firstBout ? 1.0 : 0.0, atk.length === 0 ? 1.0 : 0.0);
  const na = atk.length;
  sc.push(game.boutLimit / 6.0, na / 6.0, Math.max(game.boutLimit - na, 0) / 6.0, nd / 6.0, (na - nd) / 6.0);
  for (let i = 0; i < 5; i++) sc.push(i === n - 2 ? 1.0 : 0.0);
  const nAct = n - finished.length;
  const a1 = Math.max(Math.min(nAct, 6), 2) - 2;
  for (let i = 0; i < 5; i++) sc.push(i === a1 ? 1.0 : 0.0);
  sc.push(popcount(unseen) / 36.0, finished.length / 5.0, game.throwerIdx / 2.0);
  // v2 scalars: stall counter and unknown-card counts per location
  sc.push((game.stall ?? 0) / 30.0);
  for (let k = 1; k < MAX_PLAYERS; k++) {
    if (k < n) {
      const q = (player + k) % n;
      sc.push((popcount(game.hands[q]) - popcount(known[q])) / 6.0);
    } else {
      sc.push(0.0);
    }
  }
  sc.push(Math.max(talonN - 1, 0) / 24.0);

  // legal moves only for the player to move (never read another hand)
  const legal = !game.done && game.currentPlayer === player ? game.legalMask() : 0;
  const clegal = remapMask(and(legal, FULL_MASK), canon) + (legal >= BIT[PASS] ? BIT[PASS] : 0);
  return { planes: cplanes, scalars: sc, clegal, canon };
}

/** Write one observation row into `obs` at row `row` (OBS_DIM floats) and its
 * legal mask into `mask` (37 floats). */
export function writeRow(parts: EncodedParts, obs: Float32Array, mask: Float32Array, row: number): void {
  const o = row * OBS_DIM;
  for (let p = 0; p < NUM_PLANES; p++) {
    const m = parts.planes[p];
    const base = o + p * NUM_CARDS;
    let l = lo(m);
    let h = hi(m);
    for (let c = 0; c < 32; c++) {
      obs[base + c] = l & 1;
      l >>>= 1;
    }
    for (let c = 32; c < 36; c++) {
      obs[base + c] = h & 1;
      h >>>= 1;
    }
  }
  const so = o + NUM_PLANES * NUM_CARDS;
  for (let i = 0; i < NUM_SCALARS; i++) obs[so + i] = parts.scalars[i];
  const mo = row * NUM_ACTIONS;
  let l = lo(parts.clegal);
  let h = hi(parts.clegal);
  for (let a = 0; a < 32; a++) {
    mask[mo + a] = l & 1;
    l >>>= 1;
  }
  for (let a = 32; a < NUM_ACTIONS; a++) {
    mask[mo + a] = h & 1;
    h >>>= 1;
  }
}

/** Stack encoded parts into (obs float32 [B, OBS_DIM], mask float32 [B, 37]). */
export function buildBatch(parts: readonly EncodedParts[]): { obs: Float32Array; mask: Float32Array } {
  const b = parts.length;
  const obs = new Float32Array(b * OBS_DIM);
  const mask = new Float32Array(b * NUM_ACTIONS);
  for (let i = 0; i < b; i++) writeRow(parts[i], obs, mask, i);
  return { obs, mask };
}

/** Real card c -> canonical card index, for mapping belief rows back. */
export function canonCardIndex(canon: readonly number[]): number[] {
  const idx: number[] = [];
  for (let c = 0; c < NUM_CARDS; c++) idx.push(canon[(c / NUM_RANKS) | 0] * NUM_RANKS + (c % NUM_RANKS));
  return idx;
}
