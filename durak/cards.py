"""Card encoding for a 36-card Durak deck.

A card is an int in [0, 36): ``card = suit * 9 + rank_idx`` where
``rank_idx`` 0..8 maps to ranks 6,7,8,9,10,J,Q,K,A. Sets of cards are
represented as 36-bit integer bitmasks (bit ``card`` set => card present).
"""

NUM_CARDS = 36
NUM_RANKS = 9
NUM_SUITS = 4
FULL_MASK = (1 << NUM_CARDS) - 1

SUITS = "SCDH"  # spades, clubs, diamonds, hearts
SUIT_SYMBOLS = "♠♣♦♥"
RANKS = ["6", "7", "8", "9", "10", "J", "Q", "K", "A"]

# Bitmask of all cards of a given rank / suit.
RANK_MASKS = [sum(1 << (s * NUM_RANKS + r) for s in range(NUM_SUITS)) for r in range(NUM_RANKS)]
SUIT_MASKS = [((1 << NUM_RANKS) - 1) << (s * NUM_RANKS) for s in range(NUM_SUITS)]


def suit_of(card: int) -> int:
    return card // NUM_RANKS


def rank_of(card: int) -> int:
    return card % NUM_RANKS


def make_card(suit: int, rank_idx: int) -> int:
    return suit * NUM_RANKS + rank_idx


def card_str(card: int) -> str:
    """Short ASCII name, e.g. '10H', 'AS', '6C'."""
    return RANKS[rank_of(card)] + SUITS[suit_of(card)]


def parse_card(s: str) -> int:
    s = s.strip().upper()
    return make_card(SUITS.index(s[-1]), RANKS.index(s[:-1]))


def mask_to_list(mask: int) -> list[int]:
    out = []
    while mask:
        low = mask & -mask
        out.append(low.bit_length() - 1)
        mask ^= low
    return out


def list_to_mask(cards) -> int:
    m = 0
    for c in cards:
        m |= 1 << c
    return m


def popcount(mask: int) -> int:
    return mask.bit_count()


def beats(defense: int, attack: int, trump: int) -> bool:
    """True if card ``defense`` beats card ``attack`` given trump suit ``trump``."""
    ds, as_ = suit_of(defense), suit_of(attack)
    if ds == as_:
        return rank_of(defense) > rank_of(attack)
    return ds == trump


def beaters_mask(attack: int, trump: int) -> int:
    """Bitmask of every card that beats ``attack``."""
    s, r = suit_of(attack), rank_of(attack)
    higher_same = SUIT_MASKS[s] & ~((1 << (s * NUM_RANKS + r + 1)) - 1)
    if s == trump:
        return higher_same
    return higher_same | SUIT_MASKS[trump]
