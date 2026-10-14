"""Helpers for building specific Durak positions (tests, solver benchmarks).

Example::

    g = make_position(3, hands=["6S 7S", "8S", "AH KH"], trump="H", talon=[], attacker=0)

Cards may be given as ints, as strings like ``"10H"`` or as whitespace-separated
strings. Hands may also be given as int bitmasks via ``hand_masks``.
"""

from __future__ import annotations

from .cards import NUM_CARDS, SUITS, list_to_mask, parse_card, suit_of
from .engine import ATTACK, DEFAULT_CONFIG, DEFEND, Config, DurakGame


def cards(spec) -> list[int]:
    """Parse ``"6S 7H"`` / ``["6S", 7]`` / ``None`` into a list of card ints."""
    if spec is None:
        return []
    if isinstance(spec, str):
        spec = spec.split()
    return [c if isinstance(c, int) else parse_card(c) for c in spec]


def mask(spec) -> int:
    return list_to_mask(cards(spec))


def make_position(
    num_players: int,
    hands,
    trump=None,
    talon=None,
    attacker: int = 0,
    finished=None,
    first_bout: bool = False,
    discard=None,
    known=None,
    trump_card=None,
    bout_index: int = 1,
    config: Config = DEFAULT_CONFIG,
    start: bool = True,
) -> DurakGame:
    """Build a game at the start of a bout (empty table, ATTACK phase).

    * ``hands``: list of N card specs (or int masks).
    * ``talon``: card spec listed in engine order (``talon[0]`` is the face-up
      trump card, cards are drawn from the end). Defaults to empty.
    * ``trump``: suit letter / index. If omitted, taken from ``trump_card`` or
      ``talon[0]``.
    * ``trump_card``: defaults to ``talon[0]``; with an empty talon to the
      lowest unused card of the trump suit (or any trump-suit card).
    * ``discard``: card spec; if ``None`` all remaining cards go to the discard.
    * ``known``: list of N card specs (publicly known cards per player).
    """
    n = num_players
    g = DurakGame(deal=False, num_players=n, config=config)
    g.hands = [h if isinstance(h, int) else mask(h) for h in hands]
    assert len(g.hands) == n
    g.talon = cards(talon)
    if trump_card is not None:
        tc = cards([trump_card])[0]
    elif g.talon:
        tc = g.talon[0]
    else:
        tc = None
    if trump is None:
        assert tc is not None, "need trump, trump_card or a talon"
        t = suit_of(tc)
    else:
        t = SUITS.index(trump.upper()) if isinstance(trump, str) else int(trump)
    if tc is None:
        tc = t * 9  # nominal: the trump 6 (only matters for display/unseen)
    g.trump_card, g.trump = tc, t
    used = 0
    for h in g.hands:
        assert not (used & h), "card in two hands"
        used |= h
    tmask = list_to_mask(g.talon)
    assert not (used & tmask)
    used |= tmask
    if discard is None:
        g.discard = ((1 << NUM_CARDS) - 1) & ~used
    else:
        g.discard = mask(discard)
        assert not (used & g.discard)
    g.known = [0] * n if known is None else [k if isinstance(k, int) else mask(k) for k in known]
    for p in range(n):
        assert g.known[p] & ~g.hands[p] == 0, "known card not in hand"
    g.attack_cards, g.defense_cards = [], []
    g.done, g.loser = False, None
    g.finished = list(finished or [])
    g.log = []
    g.bout_index = 0 if first_bout else bout_index
    g.stall = 0
    g.first_bout = first_bout
    g.attacker = attacker
    if start:
        g._start_bout()
    return g


def check_invariants(g: DurakGame) -> None:
    """Assert structural invariants of any reachable state."""
    full = (1 << NUM_CARDS) - 1
    parts = list(g.hands) + [list_to_mask(g.talon), list_to_mask(g.attack_cards), list_to_mask(g.defense_cards), g.discard]
    acc = 0
    for m in parts:
        assert acc & m == 0, "card in two places"
        acc |= m
    assert acc == full, "cards lost"
    assert len(set(g.talon)) == len(g.talon)
    assert len(g.attack_cards) + len(g.defense_cards) == bin(list_to_mask(g.attack_cards) | list_to_mask(g.defense_cards)).count("1")
    for p in range(g.num_players):
        assert g.known[p] & ~g.hands[p] == 0, "known not subset of hand"
    if g.talon:
        assert g.talon[0] == g.trump_card
    if not g.done:
        assert g.legal_mask_int() != 0
        na, nd = len(g.attack_cards), len(g.defense_cards)
        if g.phase == ATTACK:
            assert nd == na
        elif g.phase == DEFEND:
            assert nd == na - 1
        else:
            assert nd <= na - 1
        assert len(g.attack_cards) <= g.bout_limit
        assert g.attacker not in g.finished and g.defender not in g.finished
        for p in g.finished:
            assert g.hands[p] == 0
        if g.talon:
            assert not g.finished
