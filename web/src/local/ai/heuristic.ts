// Strong rule-based Durak agent for any number of players: exact port of
// durak/agents/heuristic.py (same parameters, same tie-breaking, same float
// arithmetic order, so it picks the same action in every position).
//
// It only uses information the player is entitled to: its own hand, the public
// table/discard/talon size, `game.known`, `game.unseenMask(player)` and hand
// sizes. In perfect-information endgames (talon empty, two players left) the
// opponent's hand is derived from public information.

import { BIT, RANK_MASKS, SUIT_MASKS, and, andNot, beatersMask, intersects, or, popcount, rankOf, suitOf, type CardSet } from "../cards";
import { ATTACK, DEFEND, PASS, type DurakGame } from "../engine";

export interface HeuristicParams {
  trump_bonus: number;
  lead_pair_bonus: number;
  lead_trump_penalty: number;
  lead_unbeatable_bonus: number;
  lead_count_talon: number;
  lead_count_weight: number;
  add_thr_base: number;
  add_thr_talon_slope: number;
  add_thr_neighbour: number;
  add_thr_weak_def: number;
  thr_thr_base: number;
  thr_thr_talon_slope: number;
  take_talon_min: number;
  take_trump_rank_min: number;
  take_table_max: number;
  take_attack_max: number;
  new_rank_penalty: number;
}

export const DEFAULT_PARAMS: Readonly<HeuristicParams> = Object.freeze({
  trump_bonus: 9.0,
  lead_pair_bonus: 1.2,
  lead_trump_penalty: 6.0,
  lead_unbeatable_bonus: 6.0,
  lead_count_talon: 3,
  lead_count_weight: 3.0,
  add_thr_base: 10.0,
  add_thr_talon_slope: 0.35,
  add_thr_neighbour: 1.5,
  add_thr_weak_def: 2.0,
  thr_thr_base: 4.5,
  thr_thr_talon_slope: 0.35,
  take_talon_min: 6,
  take_trump_rank_min: 4,
  take_table_max: 2,
  take_attack_max: 4,
  new_rank_penalty: 4.0,
});

/** Overrides for games with 3+ players. */
export const MULTI_PARAMS: Readonly<Partial<HeuristicParams>> = Object.freeze({ trump_bonus: 14.0, lead_pair_bonus: 0.5 });

/** (unseen mask, per-opponent [known mask, number of unknown cards], hidden talon size). */
interface HiddenModel {
  unseen: CardSet;
  m: Map<number, [CardSet, number]>;
  hiddenTalon: number;
}

export class HeuristicPlayer {
  readonly p2: HeuristicParams;
  readonly pm: HeuristicParams;
  p: HeuristicParams;

  constructor(params: Partial<HeuristicParams> = {}) {
    const unknown = Object.keys(params).filter((k) => !(k in DEFAULT_PARAMS));
    if (unknown.length) throw new TypeError(`unknown heuristic params: ${unknown.sort().join(", ")}`);
    this.p2 = { ...DEFAULT_PARAMS, ...params };
    this.pm = { ...DEFAULT_PARAMS, ...MULTI_PARAMS, ...params };
    this.p = this.p2;
  }

  // ---------------------------------------------------------- utilities
  private val(c: number, trump: number): number {
    const r = rankOf(c);
    return suitOf(c) === trump ? r + this.p.trump_bonus : r;
  }

  private cheapest(cards: number[], trump: number): number {
    let best = cards[0];
    let bv = this.val(best, trump);
    for (let i = 1; i < cards.length; i++) {
      const c = cards[i];
      const v = this.val(c, trump);
      if (v < bv || (v === bv && c < best)) {
        best = c;
        bv = v;
      }
    }
    return best;
  }

  private hiddenModel(game: DurakGame, me: number): HiddenModel {
    const unseen = game.unseenMask(me);
    const m = new Map<number, [CardSet, number]>();
    for (const q of game.activePlayers) {
      if (q === me) continue;
      const k = game.known[q];
      m.set(q, [k, popcount(game.hands[q]) - popcount(k)]);
    }
    return { unseen, m, hiddenTalon: Math.max(0, game.talon.length - 1) };
  }

  /** Probability that player q holds a card beating c. */
  private pCanBeat(game: DurakGame, me: number, q: number, c: number, model: HiddenModel | null): number {
    const md = model ?? this.hiddenModel(game, me);
    const [knownQ, unkQ] = md.m.get(q) as [CardSet, number];
    const bm = beatersMask(c, game.trump);
    if (intersects(knownQ, bm)) return 1.0;
    const nPool = popcount(md.unseen);
    const b = popcount(and(md.unseen, bm));
    if (b === 0 || unkQ === 0 || nPool === 0) return 0.0;
    let pNone = 1.0;
    for (let i = 0; i < unkQ; i++) {
      pNone *= Math.max(0.0, nPool - b - i) / (nPool - i);
      if (pNone === 0.0) break;
    }
    return 1.0 - pNone;
  }

  /** Probability that at least one thrower holds a card of cardsMask. */
  private pThrowersHold(game: DurakGame, me: number, cardsMask: CardSet, model: HiddenModel): number {
    const { unseen, m } = model;
    const nPool = popcount(unseen);
    let pNone = 1.0;
    for (const q of game.throwers) {
      if (q === me || !m.has(q)) continue;
      const [knownQ, unkQ] = m.get(q) as [CardSet, number];
      if (intersects(knownQ, cardsMask)) return 1.0;
      const b = popcount(and(unseen, cardsMask));
      if (b === 0 || unkQ === 0 || nPool === 0) continue;
      for (let i = 0; i < unkQ; i++) pNone *= Math.max(0.0, nPool - b - i) / (nPool - i);
    }
    return 1.0 - pNone;
  }

  /** Opponent hand when derivable from public info (talon empty, two active). */
  private perfectOppHand(game: DurakGame, me: number): [number, CardSet] | null {
    const act = game.activePlayers;
    if (game.talon.length || act.length !== 2 || !act.includes(me)) return null;
    const q = act[1] === me ? act[0] : act[1];
    return [q, or(game.unseenMask(me), game.known[q])];
  }

  // ---------------------------------------------------------------- act
  choose(game: DurakGame, player: number): number {
    const legal = game.legalActions();
    if (legal.length === 1) return legal[0];
    this.p = game.numPlayers === 2 ? this.p2 : this.pm;
    if (game.phase === DEFEND) return this.defend(game, player, legal);
    if (game.phase === ATTACK) {
      if (!game.attackCards.length) return this.lead(game, player, legal);
      return this.add(game, player, legal, false);
    }
    return this.add(game, player, legal, true);
  }

  // -------------------------------------------------------------- lead
  private lead(game: DurakGame, me: number, legal: number[]): number {
    const trump = game.trump;
    const hand = game.hands[me];
    const talon = game.talon.length;
    const dfd = game.defender;
    const p = this.p;
    const endgame = talon === 0;
    const model = endgame || talon <= p.lead_count_talon ? this.hiddenModel(game, me) : null;
    const perfect = this.perfectOppHand(game, me);
    const nHand = popcount(hand);
    const allTrump = andNot(hand, SUIT_MASKS[trump]) === 0;
    let best = -1;
    let bestS: number | null = null;
    for (const c of legal) {
      const v = this.val(c, trump);
      const same = popcount(and(hand, RANK_MASKS[rankOf(c)])) - 1;
      let s = v - p.lead_pair_bonus * same;
      if (suitOf(c) === trump && !allTrump) s += !endgame ? p.lead_trump_penalty : 1.0;
      if (endgame) {
        let pb: number;
        if (perfect !== null) {
          pb = intersects(perfect[1], beatersMask(c, trump)) ? 1.0 : 0.0;
        } else {
          pb = this.pCanBeat(game, me, dfd, c, model);
        }
        s -= p.lead_unbeatable_bonus * (1.0 - pb);
        s -= 0.5 * same;
        if (same + 1 === nHand) s -= 5.0;
      } else if (model !== null) {
        const pb = this.pCanBeat(game, me, dfd, c, model);
        s -= p.lead_count_weight * (1.0 - pb) * (v < 9 ? 1.0 : 0.3);
      }
      if (bestS === null || s < bestS) {
        best = c;
        bestS = s;
      }
    }
    return best;
  }

  // --------------------------------------------------------- add / throw
  private add(game: DurakGame, me: number, legal: number[], throwIn: boolean): number {
    const cards = legal.filter((c) => c !== PASS);
    if (!cards.length) return PASS;
    const trump = game.trump;
    const p = this.p;
    const talon = game.talon.length;
    const hand = game.hands[me];
    const nHand = popcount(hand);
    const dfd = game.defender;
    const nact = game.activePlayers.length;
    // Going out: with an empty talon, if we can dump our whole hand, do it.
    if (talon === 0 && cards.length === nHand) {
      const room = game.boutLimit - game.attackCards.length;
      if (room >= nHand) return this.cheapest(cards, trump);
    }
    const talonShort = Math.max(0, 12 - talon);
    let thr: number;
    if (throwIn) {
      thr = p.thr_thr_base + p.thr_thr_talon_slope * talonShort;
    } else {
      thr = p.add_thr_base + p.add_thr_talon_slope * talonShort;
      if (nact > 2 && me !== game.attacker) thr += p.add_thr_neighbour;
      const dLeft = popcount(game.hands[dfd]);
      if (dLeft <= 2) thr += p.add_thr_weak_def;
    }
    if (talon === 0) {
      thr = Math.max(thr, 8.0);
      if (throwIn) thr = Math.max(thr, 8.0 + 0.5 * p.trump_bonus);
    }
    let c = this.cheapest(cards, trump);
    let v = this.val(c, trump);
    if (!throwIn && talon === 0) {
      // Endgame add: prefer a card the defender can't beat.
      const perfect = this.perfectOppHand(game, me);
      const model = perfect ? null : this.hiddenModel(game, me);
      const pbeat = (x: number): number => {
        if (perfect !== null) return intersects(perfect[1], beatersMask(x, trump)) ? 1.0 : 0.0;
        return this.pCanBeat(game, me, dfd, x, model);
      };
      let bestKey = Infinity;
      let bestC = -1;
      for (const x of cards) {
        const k = this.val(x, trump) - 6.0 * (1.0 - pbeat(x));
        if (k < bestKey || (k === bestKey && x < bestC)) {
          bestKey = k;
          bestC = x;
        }
      }
      c = bestC;
      v = this.val(c, trump) - 6.0 * (1.0 - pbeat(c));
    }
    if (v <= thr) return c;
    return PASS;
  }

  // ------------------------------------------------------------- defend
  private defend(game: DurakGame, me: number, legal: number[]): number {
    const beats = legal.filter((c) => c !== PASS);
    if (!beats.length) return PASS;
    const trump = game.trump;
    const p = this.p;
    const talon = game.talon.length;
    const att = game.attackCards[game.attackCards.length - 1];
    let tableRanks = 0;
    for (const x of game.attackCards) tableRanks = or(tableRanks, RANK_MASKS[rankOf(x)]);
    for (const x of game.defenseCards) tableRanks = or(tableRanks, RANK_MASKS[rankOf(x)]);

    const room = game.boutLimit - game.attackCards.length;
    const model = room > 0 ? this.hiddenModel(game, me) : null;

    const cost = (c: number): number => {
      let v = this.val(c, trump);
      const rm = RANK_MASKS[rankOf(c)];
      if (room > 0 && !intersects(tableRanks, rm)) {
        v += p.new_rank_penalty * this.pThrowersHold(game, me, andNot(rm, BIT[c]), model as HiddenModel);
      }
      return v;
    };

    let b = beats[0];
    let bc = cost(b);
    for (let i = 1; i < beats.length; i++) {
      const c = beats[i];
      const v = cost(c);
      if (v < bc || (v === bc && c < b)) {
        b = c;
        bc = v;
      }
    }
    if (suitOf(b) === trump && talon >= p.take_talon_min) {
      const tableN = game.attackCards.length + game.defenseCards.length;
      const cheapTable = game.attackCards.every((x) => suitOf(x) !== trump && rankOf(x) <= p.take_attack_max);
      if (
        rankOf(b) >= p.take_trump_rank_min &&
        tableN <= p.take_table_max &&
        cheapTable &&
        suitOf(att) !== trump
      ) {
        return PASS;
      }
    }
    return b;
  }
}
