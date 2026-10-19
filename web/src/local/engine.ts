// Rules engine for Podkidnoy Durak, 2-6 players, 36 cards.
// Exact port of durak/engine.py (see docs/SPEC.md and ENGINE_API.md).
//
// * Actions are ints in [0, 37): 0..35 play that card, 36 = PASS.
// * Play is strictly sequential, one card at a time. The main attacker leads;
//   only the main attacker and the defender's other neighbour ("throwers")
//   may add cards. Each time the table is fully covered, throwers are asked in
//   priority order (main attacker first) to add a card or PASS; when all of
//   them pass in a row the bout ends with "bita". The defender beats the
//   single uncovered card or PASSes (= take). After a take, each thrower in
//   order may add cards and then PASSes ("done"); then the defender picks
//   everything up.

import {
  BIT,
  FULL_MASK,
  NUM_ACTIONS,
  NUM_CARDS,
  PASS,
  RANK_MASKS,
  SUIT_MASKS,
  and,
  andNot,
  beatersMask,
  cardStr,
  has,
  lowest,
  maskToList,
  or,
  popcount,
  rankOf,
  remove,
  suitOf,
  type CardSet,
} from "./cards";
import { Rng } from "./rng";

export { PASS, NUM_ACTIONS };
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;

// Phases
export const ATTACK = 0; // a thrower to move: lead/add a card, or PASS (only once the table is non-empty)
export const DEFEND = 1; // defender to move: beat the single uncovered card, or PASS = take
export const THROW_IN = 2; // defender has taken; throwers in order may add cards, PASS = done
export const PHASE_NAMES = ["attack", "defend", "throw_in"] as const;
export type PhaseId = 0 | 1 | 2;

export interface Config {
  readonly handSize: number;
  readonly maxBoutCards: number;
  /** Limit on attack cards in the very first bout of the game only. */
  readonly firstBoutLimit: number;
  /** Once the talon is empty and 3+ players remain, the game is a draw after
   * this many consecutive bouts that end in a take (no bita). */
  readonly stallBouts: number;
}

export const DEFAULT_CONFIG: Config = Object.freeze({
  handSize: 6,
  maxBoutCards: 6,
  firstBoutLimit: 5,
  stallBouts: 30,
});

/** Plain-data snapshot of a game (JSON/structured-clone friendly). */
export interface GameSnapshot {
  config: Config;
  numPlayers: number;
  hands: CardSet[];
  known: CardSet[];
  talon: number[];
  trumpCard: number;
  trump: number;
  discard: CardSet;
  attackCards: number[];
  defenseCards: number[];
  attacker: number;
  defender: number;
  throwers: number[];
  throwerIdx: number;
  phase: PhaseId;
  boutLimit: number;
  firstBout: boolean;
  done: boolean;
  loser: number | null;
  finished: number[];
  log: [number, number][];
  boutIndex: number;
  stall: number;
}

export interface InfoState {
  player: number;
  num_players: number;
  hand: number[];
  hand_sizes: number[];
  known: number[][];
  attack_cards: number[];
  defense_cards: number[];
  discard: number[];
  trump_card: number;
  trump: number;
  talon_size: number;
  attacker: number;
  defender: number;
  throwers: number[];
  phase: number;
  bout_limit: number;
  first_bout: boolean;
  finished: number[];
  to_move: number | null;
  legal: number[];
  done: boolean;
  loser: number | null;
}

export class IllegalActionError extends Error {}

/** Mutable game state. Use clone() for search. */
export class DurakGame {
  config: Config = DEFAULT_CONFIG;
  numPlayers = 2;
  /** hands[p]: 36-bit card mask. */
  hands: CardSet[] = [];
  /** known[p]: publicly known cards in p's hand. */
  known: CardSet[] = [];
  /** Drawn from the END; talon[0] is the face-up trump card. */
  talon: number[] = [];
  trumpCard = 0;
  trump = 0;
  discard: CardSet = 0;
  attackCards: number[] = [];
  /** defenseCards[i] beats attackCards[i]. */
  defenseCards: number[] = [];
  attacker = 0;
  defender = 0;
  throwers: number[] = [];
  throwerIdx = 0;
  phase: PhaseId = ATTACK;
  boutLimit = 0;
  firstBout = true;
  done = false;
  /** The durak; null while running or on a draw. */
  loser: number | null = null;
  /** Players in the order they went out. */
  finished: number[] = [];
  /** (player, action) pairs. */
  log: [number, number][] = [];
  boutIndex = 0;
  /** Consecutive takes since the talon ran out (3+ players). */
  stall = 0;

  /**
   * Mirrors DurakGame(seed, num_players, config, deal). `seed` may be a number,
   * an Rng (consumed for the deal), or null/undefined for a random deal.
   */
  constructor(seed?: number | Rng | null, numPlayers = 2, config: Config = DEFAULT_CONFIG, deal = true) {
    if (!(numPlayers >= MIN_PLAYERS && numPlayers <= MAX_PLAYERS)) {
      throw new RangeError(`num_players must be in [${MIN_PLAYERS}, ${MAX_PLAYERS}]`);
    }
    this.config = config;
    this.numPlayers = numPlayers;
    if (deal) {
      const rng = seed instanceof Rng ? seed : new Rng(seed ?? undefined);
      const deck = Array.from({ length: NUM_CARDS }, (_, i) => i);
      rng.shuffle(deck);
      this.dealDeck(deck, () => rng.randrange(numPlayers));
    }
  }

  /**
   * Deal from an explicit deck order (deck[0..] = seat 0's six cards, then
   * seat 1's, ...; the rest is the talon, drawn from the end, deck[N*6] = trump
   * card). `fallbackAttacker` picks the first attacker when nobody holds a
   * trump (Python uses rng.randrange there).
   */
  static fromDeck(
    deck: readonly number[],
    numPlayers: number,
    fallbackAttacker: number | (() => number) = 0,
    config: Config = DEFAULT_CONFIG,
  ): DurakGame {
    const g = new DurakGame(null, numPlayers, config, false);
    g.dealDeck(deck.slice(), typeof fallbackAttacker === "function" ? fallbackAttacker : () => fallbackAttacker);
    return g;
  }

  // ---------------------------------------------------------------- setup
  private dealDeck(deck: number[], pickAttacker: () => number): void {
    if (deck.length !== NUM_CARDS || new Set(deck).size !== NUM_CARDS) throw new Error("bad deck");
    const nP = this.numPlayers;
    const hs = this.config.handSize;
    this.hands = [];
    for (let p = 0; p < nP; p++) {
      let m = 0;
      for (const c of deck.slice(p * hs, (p + 1) * hs)) m += BIT[c];
      this.hands.push(m);
    }
    this.known = new Array(nP).fill(0);
    this.talon = deck.slice(nP * hs);
    if (this.talon.length) {
      this.trumpCard = this.talon[0];
    } else {
      // 6 players: the last dealt card is shown to everyone and sets trump.
      this.trumpCard = deck[deck.length - 1];
      this.known[nP - 1] = or(this.known[nP - 1], BIT[this.trumpCard]);
    }
    this.trump = suitOf(this.trumpCard);
    this.discard = 0;
    this.attackCards = [];
    this.defenseCards = [];
    this.done = false;
    this.loser = null;
    this.finished = [];
    this.log = [];
    this.boutIndex = 0;
    this.stall = 0;
    this.firstBout = true;

    // First attacker: holder of the lowest trump; random if nobody has one.
    const tmask = SUIT_MASKS[this.trump];
    let best = -1;
    let bestBit = 99;
    for (let p = 0; p < nP; p++) {
      const low = lowest(and(this.hands[p], tmask));
      if (low >= 0 && low < bestBit) {
        best = p;
        bestBit = low;
      }
    }
    this.attacker = best >= 0 ? best : pickAttacker();
    this.startBout();
  }

  private startBout(): void {
    this.defender = this.nextActive(this.attacker);
    const other = this.nextActive(this.defender);
    this.throwers = other === this.attacker ? [this.attacker] : [this.attacker, other];
    this.throwerIdx = 0;
    const cap = this.firstBout ? this.config.firstBoutLimit : this.config.maxBoutCards;
    this.boutLimit = Math.min(cap, popcount(this.hands[this.defender]));
    this.attackCards = [];
    this.defenseCards = [];
    this.phase = ATTACK;
  }

  // ------------------------------------------------------------ properties
  /** Still in the game (has cards, or could still draw from the talon). */
  isActive(p: number): boolean {
    return !this.finished.includes(p);
  }

  get activePlayers(): number[] {
    const out: number[] = [];
    for (let p = 0; p < this.numPlayers; p++) if (!this.finished.includes(p)) out.push(p);
    return out;
  }

  nextActive(p: number): number {
    const n = this.numPlayers;
    for (let k = 1; k <= n; k++) {
      const q = (p + k) % n;
      if (!this.finished.includes(q)) return q;
    }
    throw new Error("no active players");
  }

  get currentPlayer(): number {
    return this.phase === DEFEND ? this.defender : this.throwers[this.throwerIdx];
  }

  get tableMask(): CardSet {
    let m = 0;
    for (const c of this.attackCards) m += BIT[c];
    for (const c of this.defenseCards) m += BIT[c];
    return m;
  }

  /** Bitmask of all cards whose rank appears on the table. */
  tableRankMask(): CardSet {
    let ranks = 0;
    for (const c of this.attackCards) ranks |= 1 << rankOf(c);
    for (const c of this.defenseCards) ranks |= 1 << rankOf(c);
    let m = 0;
    for (let r = 0; ranks !== 0; r++, ranks >>>= 1) if (ranks & 1) m += RANK_MASKS[r];
    return m;
  }

  // ---------------------------------------------------------- legal moves
  /** Legal actions as a 37-bit mask (bit 36 = PASS). Python: legal_mask_int. */
  legalMask(): number {
    if (this.done) return 0;
    if (this.phase === DEFEND) {
      const uncovered = this.attackCards[this.attackCards.length - 1];
      return and(this.hands[this.defender], beatersMask(uncovered, this.trump)) + BIT[PASS];
    }
    const hand = this.hands[this.currentPlayer];
    if (this.attackCards.length === 0) return hand; // main attacker must lead a card
    let m = BIT[PASS];
    if (this.attackCards.length < this.boutLimit) m += and(hand, this.tableRankMask());
    return m;
  }

  legalActions(): number[] {
    return maskToList(this.legalMask());
  }

  isLegal(action: number): boolean {
    return Number.isInteger(action) && action >= 0 && action < NUM_ACTIONS && has(this.legalMask(), action);
  }

  // ------------------------------------------------------------------ step
  step(action: number): void {
    if (!this.isLegal(action)) {
      throw new IllegalActionError(`illegal action ${action} in phase ${PHASE_NAMES[this.phase]}`);
    }
    const player = this.currentPlayer;
    this.log.push([player, action]);
    if (this.phase === ATTACK) {
      if (action === PASS) {
        this.throwerIdx += 1;
        if (this.throwerIdx === this.throwers.length) {
          // everyone passed: bita
          this.discard = or(this.discard, this.tableMask);
          this.endBout(true);
        }
      } else {
        this.removeCard(player, action);
        this.attackCards.push(action);
        this.phase = DEFEND;
      }
    } else if (this.phase === DEFEND) {
      if (action === PASS) {
        // take; throwers may now add cards
        this.phase = THROW_IN;
        this.throwerIdx = 0;
      } else {
        this.removeCard(player, action);
        this.defenseCards.push(action);
        this.phase = ATTACK;
        this.throwerIdx = 0; // priority restarts with the main attacker
      }
    } else {
      // THROW_IN
      if (action === PASS) {
        this.throwerIdx += 1;
        if (this.throwerIdx === this.throwers.length) {
          const d = this.defender;
          const picked = this.tableMask;
          this.hands[d] = or(this.hands[d], picked);
          this.known[d] = or(this.known[d], picked);
          this.endBout(false);
        }
      } else {
        this.removeCard(player, action);
        this.attackCards.push(action);
      }
    }
  }

  private removeCard(player: number, card: number): void {
    this.hands[player] = remove(this.hands[player], card);
    this.known[player] = remove(this.known[player], card);
  }

  private endBout(defended: boolean): void {
    this.attackCards = [];
    this.defenseCards = [];
    // Draw: main attacker, then the other players clockwise, defender last.
    const hs = this.config.handSize;
    const order = [this.attacker];
    let p = this.nextActive(this.attacker);
    while (p !== this.attacker) {
      if (p !== this.defender) order.push(p);
      p = this.nextActive(p);
    }
    order.push(this.defender);
    for (const q of order) {
      let need = hs - popcount(this.hands[q]);
      while (need > 0 && this.talon.length) {
        const c = this.talon.pop() as number;
        this.hands[q] += BIT[c];
        if (!this.talon.length) {
          // The face-up trump card is drawn last; everyone sees who takes it.
          this.known[q] = or(this.known[q], BIT[c]);
        }
        need -= 1;
      }
    }
    this.boutIndex += 1;
    this.firstBout = false;

    // Players with no cards and nothing left to draw are out.
    if (!this.talon.length) {
      for (const q of order) {
        if (this.hands[q] === 0 && !this.finished.includes(q)) this.finished.push(q);
      }
    }
    const active = this.activePlayers;
    if (active.length <= 1) {
      this.done = true;
      this.loser = active.length ? active[0] : null;
      return;
    }
    // Only 3+ players can cycle; with 2 left every take shrinks the
    // attacker's hand, so the game always terminates (and stays solvable).
    this.stall = defended || this.talon.length > 0 || active.length < 3 ? 0 : this.stall + 1;
    if (this.stall >= this.config.stallBouts) {
      this.done = true; // draw by stalemate
      this.loser = null;
      return;
    }

    // Next attacker: the defender after a successful defence, otherwise the
    // player after the defender (skipping players who went out).
    if (defended && !this.finished.includes(this.defender)) this.attacker = this.defender;
    else this.attacker = this.nextActive(this.defender);
    this.startBout();
  }

  // ------------------------------------------------------------ utilities
  /** 2-player convenience: the non-loser (null while running / draw). */
  get winner(): number | null {
    if (!this.done || this.loser === null || this.numPlayers !== 2) return null;
    return 1 - this.loser;
  }

  /** Terminal payoff (zero-sum): the durak gets -1, everyone else +1/(n-1).
   * All zeros on a draw or while running. */
  returns(): number[] {
    const n = this.numPlayers;
    if (!this.done || this.loser === null) return new Array(n).fill(0);
    const win = 1 / (n - 1);
    const out: number[] = [];
    for (let p = 0; p < n; p++) out.push(p === this.loser ? -1 : win);
    return out;
  }

  clone(): DurakGame {
    const g = new DurakGame(null, this.numPlayers, this.config, false);
    g.hands = this.hands.slice();
    g.known = this.known.slice();
    g.talon = this.talon.slice();
    g.trumpCard = this.trumpCard;
    g.trump = this.trump;
    g.discard = this.discard;
    g.attackCards = this.attackCards.slice();
    g.defenseCards = this.defenseCards.slice();
    g.attacker = this.attacker;
    g.defender = this.defender;
    g.throwers = this.throwers.slice();
    g.throwerIdx = this.throwerIdx;
    g.phase = this.phase;
    g.boutLimit = this.boutLimit;
    g.firstBout = this.firstBout;
    g.done = this.done;
    g.loser = this.loser;
    g.finished = this.finished.slice();
    g.log = this.log.slice();
    g.boutIndex = this.boutIndex;
    g.stall = this.stall;
    return g;
  }

  /** Cards whose location is unknown to `player`: hidden in an opponent's
   * hand or in the talon (excluding the face-up trump card). */
  unseenMask(player: number): CardSet {
    let seen = or(or(this.hands[player], this.discard), this.tableMask);
    for (let q = 0; q < this.numPlayers; q++) if (q !== player) seen = or(seen, this.known[q]);
    if (this.talon.length) seen = or(seen, BIT[this.trumpCard]);
    return andNot(FULL_MASK, seen);
  }

  /** A clone where all hidden information (from `player`'s point of view) is
   * resampled uniformly, consistent with what `player` knows. With the talon
   * empty and only two players left this is exact. */
  determinize(player: number, rng: Rng): DurakGame {
    const g = this.clone();
    const pool = maskToList(this.unseenMask(player));
    rng.shuffle(pool);
    let i = 0;
    for (let q = 0; q < this.numPlayers; q++) {
      if (q === player) continue;
      const k = popcount(this.hands[q]) - popcount(this.known[q]);
      let m = this.known[q];
      for (let j = i; j < i + k; j++) m += BIT[pool[j]];
      g.hands[q] = m;
      i += k;
    }
    const rest = pool.slice(i);
    g.talon = this.talon.length ? [this.trumpCard, ...rest] : [];
    if (g.talon.length !== this.talon.length) throw new Error("determinize: inconsistent state");
    return g;
  }

  /** Everything `player` is allowed to know. Basis for observations. */
  infoState(player: number): InfoState {
    return {
      player,
      num_players: this.numPlayers,
      hand: maskToList(this.hands[player]),
      hand_sizes: this.hands.map(popcount),
      known: this.known.map((k, q) => (q !== player ? maskToList(k) : [])),
      attack_cards: this.attackCards.slice(),
      defense_cards: this.defenseCards.slice(),
      discard: maskToList(this.discard),
      trump_card: this.trumpCard,
      trump: this.trump,
      talon_size: this.talon.length,
      attacker: this.attacker,
      defender: this.defender,
      throwers: this.throwers.slice(),
      phase: this.phase,
      bout_limit: this.boutLimit,
      first_bout: this.firstBout,
      finished: this.finished.slice(),
      to_move: !this.done ? this.currentPlayer : null,
      legal: !this.done && this.currentPlayer === player ? this.legalActions() : [],
      done: this.done,
      loser: this.loser,
    };
  }

  /** Plain-data copy of the full state (for postMessage / storage). */
  snapshot(): GameSnapshot {
    const g = this.clone();
    return {
      config: { ...g.config },
      numPlayers: g.numPlayers,
      hands: g.hands,
      known: g.known,
      talon: g.talon,
      trumpCard: g.trumpCard,
      trump: g.trump,
      discard: g.discard,
      attackCards: g.attackCards,
      defenseCards: g.defenseCards,
      attacker: g.attacker,
      defender: g.defender,
      throwers: g.throwers,
      throwerIdx: g.throwerIdx,
      phase: g.phase,
      boutLimit: g.boutLimit,
      firstBout: g.firstBout,
      done: g.done,
      loser: g.loser,
      finished: g.finished,
      log: g.log.map(([p, a]) => [p, a] as [number, number]),
      boutIndex: g.boutIndex,
      stall: g.stall,
    };
  }

  static fromSnapshot(s: GameSnapshot): DurakGame {
    const g = new DurakGame(null, s.numPlayers, s.config, false);
    g.hands = s.hands.slice();
    g.known = s.known.slice();
    g.talon = s.talon.slice();
    g.trumpCard = s.trumpCard;
    g.trump = s.trump;
    g.discard = s.discard;
    g.attackCards = s.attackCards.slice();
    g.defenseCards = s.defenseCards.slice();
    g.attacker = s.attacker;
    g.defender = s.defender;
    g.throwers = s.throwers.slice();
    g.throwerIdx = s.throwerIdx;
    g.phase = s.phase;
    g.boutLimit = s.boutLimit;
    g.firstBout = s.firstBout;
    g.done = s.done;
    g.loser = s.loser;
    g.finished = s.finished.slice();
    g.log = s.log.map(([p, a]) => [p, a] as [number, number]);
    g.boutIndex = s.boutIndex;
    g.stall = s.stall;
    return g;
  }

  toString(): string {
    const fmt = (m: CardSet) => maskToList(m).map(cardStr).join(" ");
    const table = this.attackCards
      .map((a, i) => cardStr(a) + (i < this.defenseCards.length ? "/" + cardStr(this.defenseCards[i]) : ""))
      .join(" ");
    const hands = this.hands
      .map((h, p) => `  P${p}${this.finished.includes(p) ? "*" : ""}: ${fmt(h)}`)
      .join("\n");
    return (
      `<Durak n=${this.numPlayers} trump=${cardStr(this.trumpCard)} talon=${this.talon.length} ` +
      `att=P${this.attacker} def=P${this.defender} phase=${PHASE_NAMES[this.phase]} ` +
      `limit=${this.boutLimit}\n${hands}\n  table: ${table}  done=${this.done} loser=${this.loser}>`
    );
  }
}

export { FULL_MASK, NUM_CARDS };
