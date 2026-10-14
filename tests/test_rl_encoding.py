"""RL observation encoding: tracker replay, planes, suit canonicalisation, masks."""

import random

import numpy as np
import pytest

from durak.cards import NUM_CARDS, SUIT_MASKS, list_to_mask, mask_to_list
from durak.engine import PASS, DurakGame
from durak.rl.encoding import (
    NUM_PLANES,
    OBS_DIM,
    P_COVERED,
    P_DEFENSE,
    P_DISCARD,
    P_HAND,
    P_OPP_KNOWN,
    P_TRUMP_FACEUP,
    P_UNCOVERED,
    P_UNSEEN,
    PublicTracker,
    canon_perm,
    encode,
    encode_parts,
    inverse_perm,
    remap_mask,
    to_canon_action,
    to_real_action,
)

NS = [2, 3, 4, 5, 6]


def random_states(n, games=20, seed=0):
    rng = random.Random(seed * 100 + n)
    for _ in range(games):
        g = DurakGame(seed=rng.getrandbits(40), num_players=n)
        t = PublicTracker(n, g.trump, g.attacker)
        while not g.done:
            yield g, t
            p = g.current_player
            a = rng.choice(g.legal_actions())
            g.step(a)
            t.event(p, a)


@pytest.mark.parametrize("n", NS)
def test_tracker_matches_engine(n):
    for g, t in random_states(n, games=60):
        assert t.phase == g.phase
        assert (t.attacker, t.defender, t.throwers, t.thrower_idx) == (g.attacker, g.defender, g.throwers, g.thrower_idx)
        assert t.counts == [h.bit_count() for h in g.hands]
        assert t.talon == len(g.talon)
        assert t.finished == g.finished
        assert t.bout_limit == g.bout_limit and t.first_bout == g.first_bout


@pytest.mark.parametrize("n", NS)
def test_tracker_replay_from_log(n):
    for i, (g, t) in enumerate(random_states(n, games=5, seed=3)):
        if i % 17:
            continue
        t2 = PublicTracker.from_game(g)
        assert t2.cant_beat == t.cant_beat and t2.no_throw == t.no_throw and t2.takes == t.takes
        assert t2.phase == t.phase and t2.counts == t.counts


@pytest.mark.parametrize("n", NS)
def test_masks_match_legal_actions(n):
    for g, t in random_states(n, games=25, seed=1):
        p = g.current_player
        obs, mask, canon = encode(g, p, t)
        assert obs.shape == (OBS_DIM,) and mask.shape == (37,)
        legal = g.legal_actions()
        real = sorted(to_real_action(int(a), canon) for a in np.flatnonzero(mask))
        assert real == sorted(legal)
        for a in legal:
            assert mask[to_canon_action(a, canon)]


@pytest.mark.parametrize("n", NS)
def test_planes_content(n):
    for g, t in random_states(n, games=6, seed=2):
        p = g.current_player
        planes, scal, _, canon = encode_parts(g, p, t)
        inv = inverse_perm(canon)
        back = [remap_mask(m, inv) for m in planes]
        assert back[P_HAND] == g.hands[p]
        assert back[P_DISCARD] == g.discard
        assert back[P_UNSEEN] == g.unseen_mask(p)
        nd = len(g.defense_cards)
        assert back[P_DEFENSE] == list_to_mask(g.defense_cards)
        assert back[P_COVERED] == list_to_mask(g.attack_cards[:nd])
        assert back[P_UNCOVERED] == list_to_mask(g.attack_cards[nd:])
        assert back[P_TRUMP_FACEUP] == ((1 << g.trump_card) if g.talon else 0)
        for k in range(1, 6):
            exp = g.known[(p + k) % n] if k < n else 0
            assert back[P_OPP_KNOWN + k - 1] == exp
        # trump is canonical suit 0; hand/discard/unseen/table/known partition 36 cards
        assert canon[g.trump] == 0 and sorted(canon) == [0, 1, 2, 3]
        tot = back[P_HAND] | back[P_DISCARD] | back[P_UNSEEN] | back[P_DEFENSE] | back[P_COVERED] | back[P_UNCOVERED] | back[P_TRUMP_FACEUP]
        for k in range(1, n):
            tot |= back[P_OPP_KNOWN + k - 1]
        assert tot == (1 << NUM_CARDS) - 1
        assert len(scal) + NUM_PLANES * NUM_CARDS == OBS_DIM


def _relabel(g: DurakGame, perm):
    """Apply a suit permutation to every card of a game (keeps all rules)."""
    def m(x):
        return remap_mask(x, perm)

    def c(x):
        return perm[x // 9] * 9 + x % 9

    h = g.clone()
    h.hands = [m(x) for x in g.hands]
    h.known = [m(x) for x in g.known]
    h.discard = m(g.discard)
    h.talon = [c(x) for x in g.talon]
    h.trump_card = c(g.trump_card)
    h.trump = perm[g.trump]
    h.attack_cards = [c(x) for x in g.attack_cards]
    h.defense_cards = [c(x) for x in g.defense_cards]
    h.log = [(pl, a if a == PASS else c(a)) for pl, a in g.log]
    return h


@pytest.mark.parametrize("n", [2, 4, 5])
def test_suit_relabel_invariance(n):
    """Relabelling suits must give the identical observation, and actions
    must map consistently through the canonicalisation."""
    rng = random.Random(9)
    for i, (g, t) in enumerate(random_states(n, games=6, seed=4)):
        if i % 5:
            continue
        perm = list(range(4))
        rng.shuffle(perm)
        h = _relabel(g, perm)
        p = g.current_player
        o1, m1, c1 = encode(g, p, PublicTracker.from_game(g))
        o2, m2, c2 = encode(h, p, PublicTracker.from_game(h))
        assert np.array_equal(o1, o2) and np.array_equal(m1, m2)
        for a in g.legal_actions():
            ca = to_canon_action(a, c1)
            b = to_real_action(ca, c2)
            # b is a's image under the relabelling, or an observation-equivalent card
            exp = a if a == PASS else perm[a // 9] * 9 + a % 9
            if b != exp:
                # only possible when two non-trump suits are fully symmetric
                assert b % 9 == exp % 9 and b // 9 != h.trump and exp // 9 != h.trump


def test_canon_inverse_roundtrip():
    rng = random.Random(0)
    for _ in range(200):
        trump = rng.randrange(4)
        planes = [rng.getrandbits(36) for _ in range(NUM_PLANES)]
        canon = canon_perm(planes, trump)
        inv = inverse_perm(canon)
        for a in range(37):
            assert to_real_action(to_canon_action(a, canon), canon) == a
        x = rng.getrandbits(36)
        assert remap_mask(remap_mask(x, canon), inv) == x
        assert canon[trump] == 0


def test_non_acting_player_does_not_read_hidden_hand():
    g = DurakGame(seed=5, num_players=3)
    p = (g.current_player + 1) % 3
    t = PublicTracker.from_game(g)
    _, _, legal, _ = encode_parts(g, p, t)
    assert legal == 0
    # changing hidden cards of others (keeping counts) must not change p's obs
    o1, _, _ = encode(g, p, t)
    h = g.determinize(p, random.Random(1))
    o2, _, _ = encode(h, p, PublicTracker.from_game(h))
    assert np.array_equal(o1, o2)
