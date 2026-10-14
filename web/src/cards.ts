// Card helpers mirroring durak/cards.py encoding: card = suit * 9 + rank_idx.
// Display only; all rules live in the server engine.

export const PASS = 36;
export const SUITS = ["S", "C", "D", "H"] as const;
export const SUIT_SYMBOLS = ["♠︎", "♣︎", "♦︎", "♥︎"];
export const RANKS = ["6", "7", "8", "9", "10", "J", "Q", "K", "A"];

export const suitOf = (c: number) => Math.floor(c / 9);
export const rankOf = (c: number) => c % 9;
export const isRed = (c: number) => suitOf(c) === 2 || suitOf(c) === 3;
export const cardLabel = (c: number) => `${RANKS[rankOf(c)]}${SUIT_SYMBOLS[suitOf(c)]}`;

/**
 * Sort a hand. "suit": grouped by suit (alternating colours), rank ascending;
 * "rank": by rank across suits. Trumps always go last.
 */
export function sortHand(cards: number[], trump: number, mode: "suit" | "rank" = "suit"): number[] {
  const order = [0, 3, 1, 2].filter((s) => s !== trump).concat([trump]);
  return [...cards].sort((a, b) => {
    const ta = suitOf(a) === trump ? 1 : 0;
    const tb = suitOf(b) === trump ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (mode === "rank" && rankOf(a) !== rankOf(b)) return rankOf(a) - rankOf(b);
    const sa = order.indexOf(suitOf(a));
    const sb = order.indexOf(suitOf(b));
    return sa !== sb ? sa - sb : rankOf(a) - rankOf(b);
  });
}
