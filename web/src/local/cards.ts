// Card encoding for a 36-card Durak deck (port of durak/cards.py).
//
// A card is an int in [0, 36): card = suit * 9 + rankIdx, suits S C D H,
// rankIdx 0..8 = 6,7,8,9,10,J,Q,K,A.
//
// Card sets ("masks") are 36-bit integers stored in a plain JS number. A
// float64 holds every integer below 2^53 exactly, so masks compare with ===,
// serialize to JSON unchanged and match Python's int bitmasks bit for bit.
// JS bitwise operators only see 32 bits, so never use `|`, `&`, `~` or `<<`
// on a mask directly: use the helpers below, which split the mask into a low
// word (cards 0..31) and a high word (cards 32..35, plus bit 36 = PASS in a
// legal-action mask).

export type CardSet = number;

export const NUM_CARDS = 36;
export const NUM_RANKS = 9;
export const NUM_SUITS = 4;
export const PASS = 36;
export const NUM_ACTIONS = 37;

export const SUITS = "SCDH";
export const SUIT_SYMBOLS = "♠♣♦♥";
export const RANKS = ["6", "7", "8", "9", "10", "J", "Q", "K", "A"];

const TWO32 = 4294967296;

/** BIT[c] = 2^c for c in [0, 37] (37 so a legal mask can hold PASS). */
export const BIT: readonly number[] = Array.from({ length: 38 }, (_, c) => 2 ** c);

export const FULL_MASK: CardSet = 2 ** NUM_CARDS - 1;
export const EMPTY: CardSet = 0;

// ---------------------------------------------------------------- words
/** Low 32 bits (cards 0..31) as an unsigned int. */
export function lo(m: CardSet): number {
  return m >>> 0;
}
/** High bits (cards 32..36) as an unsigned int. */
export function hi(m: CardSet): number {
  return (m / TWO32) >>> 0;
}
/** Build a mask from its low and high words. */
export function fromWords(l: number, h: number): CardSet {
  return (h >>> 0) * TWO32 + (l >>> 0);
}

// ---------------------------------------------------------------- set ops
export function has(m: CardSet, c: number): boolean {
  return c < 32 ? ((m >>> c) & 1) === 1 : (((m / TWO32) >>> (c - 32)) & 1) === 1;
}
export function add(m: CardSet, c: number): CardSet {
  return has(m, c) ? m : m + BIT[c];
}
export function remove(m: CardSet, c: number): CardSet {
  return has(m, c) ? m - BIT[c] : m;
}
export function or(a: CardSet, b: CardSet): CardSet {
  return fromWords((a >>> 0) | (b >>> 0), ((a / TWO32) >>> 0) | ((b / TWO32) >>> 0));
}
export function and(a: CardSet, b: CardSet): CardSet {
  return fromWords((a >>> 0) & (b >>> 0), ((a / TWO32) >>> 0) & ((b / TWO32) >>> 0));
}
/** a & ~b */
export function andNot(a: CardSet, b: CardSet): CardSet {
  return fromWords((a >>> 0) & ~(b >>> 0), ((a / TWO32) >>> 0) & ~((b / TWO32) >>> 0));
}
export function xor(a: CardSet, b: CardSet): CardSet {
  return fromWords((a >>> 0) ^ (b >>> 0), ((a / TWO32) >>> 0) ^ ((b / TWO32) >>> 0));
}
/** Complement within the 36-card deck. */
export function complement(m: CardSet): CardSet {
  return FULL_MASK - and(m, FULL_MASK);
}
export function intersects(a: CardSet, b: CardSet): boolean {
  return ((a >>> 0) & (b >>> 0)) !== 0 || (((a / TWO32) >>> 0) & ((b / TWO32) >>> 0)) !== 0;
}
/** True if every card of `sub` is in `sup`. */
export function isSubset(sub: CardSet, sup: CardSet): boolean {
  return andNot(sub, sup) === 0;
}

export function popcount32(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
export function popcount(m: CardSet): number {
  return popcount32(m >>> 0) + popcount32((m / TWO32) >>> 0);
}

/** Lowest card in the set, or -1 if empty. */
export function lowest(m: CardSet): number {
  const l = m >>> 0;
  if (l !== 0) return 31 - Math.clz32(l & -l);
  const h = (m / TWO32) >>> 0;
  if (h !== 0) return 63 - Math.clz32(h & -h);
  return -1;
}
/** Highest card in the set, or -1 if empty. */
export function highest(m: CardSet): number {
  const h = (m / TWO32) >>> 0;
  if (h !== 0) return 63 - Math.clz32(h);
  const l = m >>> 0;
  if (l !== 0) return 31 - Math.clz32(l);
  return -1;
}

/** Cards of the set in ascending order (Python: mask_to_list). */
export function maskToList(m: CardSet): number[] {
  const out: number[] = [];
  let l = m >>> 0;
  while (l !== 0) {
    const low = l & -l;
    out.push(31 - Math.clz32(low));
    l ^= low;
  }
  let h = (m / TWO32) >>> 0;
  while (h !== 0) {
    const low = h & -h;
    out.push(63 - Math.clz32(low));
    h ^= low;
  }
  return out;
}
export const cardsOf = maskToList;

/** Call fn(card) for every card in ascending order. */
export function forEachCard(m: CardSet, fn: (c: number) => void): void {
  let l = m >>> 0;
  while (l !== 0) {
    const low = l & -l;
    fn(31 - Math.clz32(low));
    l ^= low;
  }
  let h = (m / TWO32) >>> 0;
  while (h !== 0) {
    const low = h & -h;
    fn(63 - Math.clz32(low));
    h ^= low;
  }
}

export function listToMask(cards: Iterable<number>): CardSet {
  let l = 0;
  let h = 0;
  for (const c of cards) {
    if (c < 32) l |= 1 << c;
    else h |= 1 << (c - 32);
  }
  return fromWords(l, h);
}

// ---------------------------------------------------------------- cards
export function suitOf(card: number): number {
  return (card / NUM_RANKS) | 0;
}
export function rankOf(card: number): number {
  return card % NUM_RANKS;
}
export function makeCard(suit: number, rankIdx: number): number {
  return suit * NUM_RANKS + rankIdx;
}
/** Short ASCII name, e.g. '10H', 'AS', '6C'. */
export function cardStr(card: number): string {
  return RANKS[rankOf(card)] + SUITS[suitOf(card)];
}
export function parseCard(s: string): number {
  const t = s.trim().toUpperCase();
  return makeCard(SUITS.indexOf(t[t.length - 1]), RANKS.indexOf(t.slice(0, -1)));
}
export function actionStr(action: number): string {
  return action === PASS ? "PASS" : cardStr(action);
}

/** RANK_MASKS[r]: all four cards of rank r. */
export const RANK_MASKS: readonly CardSet[] = Array.from({ length: NUM_RANKS }, (_, r) =>
  listToMask([0, 1, 2, 3].map((s) => s * NUM_RANKS + r)),
);
/** SUIT_MASKS[s]: all nine cards of suit s. */
export const SUIT_MASKS: readonly CardSet[] = Array.from({ length: NUM_SUITS }, (_, s) =>
  listToMask(Array.from({ length: NUM_RANKS }, (_, r) => s * NUM_RANKS + r)),
);

/** True if card `defense` beats card `attack` given trump suit `trump`. */
export function beats(defense: number, attack: number, trump: number): boolean {
  const ds = suitOf(defense);
  const as = suitOf(attack);
  if (ds === as) return rankOf(defense) > rankOf(attack);
  return ds === trump;
}

const BEATERS: CardSet[][] = Array.from({ length: NUM_SUITS }, (_, trump) =>
  Array.from({ length: NUM_CARDS }, (_, a) => {
    const s = suitOf(a);
    const r = rankOf(a);
    const higher: number[] = [];
    for (let rr = r + 1; rr < NUM_RANKS; rr++) higher.push(s * NUM_RANKS + rr);
    const m = listToMask(higher);
    return s === trump ? m : or(m, SUIT_MASKS[trump]);
  }),
);

/** Bitmask of every card that beats `attack`. */
export function beatersMask(attack: number, trump: number): CardSet {
  return BEATERS[trump][attack];
}
