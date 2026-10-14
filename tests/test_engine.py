"""Rules tests for the Durak engine (2-6 players)."""

import random

import pytest

from durak.cards import (
    FULL_MASK,
    NUM_CARDS,
    SUIT_MASKS,
    beaters_mask,
    beats,
    list_to_mask,
    mask_to_list,
    parse_card,
    rank_of,
    suit_of,
)
from durak.engine import ATTACK, DEFEND, PASS, THROW_IN, DurakGame
from durak.testing import cards, check_invariants, make_position, mask

C = parse_card


def play(g, *actions):
    for a in actions:
        g.step(PASS if a == "P" else (C(a) if isinstance(a, str) else a))


def hand(g, p):
    return set(mask_to_list(g.hands[p]))


# ------------------------------------------------------------------ beating
def test_beats_basic():
    t = 3  # hearts
    assert beats(C("7S"), C("6S"), t)
    assert not beats(C("6S"), C("7S"), t)
    assert not beats(C("6S"), C("6S"), t)
    assert not beats(C("AC"), C("6S"), t)  # other non-trump suit
    assert beats(C("6H"), C("AS"), t)  # trump beats non-trump
    assert not beats(C("AS"), C("6H"), t)  # non-trump never beats trump
    assert beats(C("7H"), C("6H"), t)  # trump vs trump by rank
    assert not beats(C("6H"), C("7H"), t)


def test_beaters_mask_matches_beats():
    for t in range(4):
        for a in range(NUM_CARDS):
            m = beaters_mask(a, t)
            for d in range(NUM_CARDS):
                assert bool(m >> d & 1) == beats(d, a, t)


# ------------------------------------------------------------- legal moves
def test_legal_moves_each_phase():
    g = make_position(2, hands=["6S 6C 9D", "7S AS 6H 8C"], trump="H", talon=[], attacker=0)
    assert g.phase == ATTACK and g.current_player == 0
    assert set(g.legal_actions()) == {C("6S"), C("6C"), C("9D")}  # must lead, no PASS
    play(g, "6S")
    assert g.phase == DEFEND and g.current_player == 1
    assert set(g.legal_actions()) == {C("7S"), C("AS"), C("6H"), PASS}
    play(g, "7S")
    assert g.phase == ATTACK and g.current_player == 0
    assert set(g.legal_actions()) == {C("6C"), PASS}  # ranks 6 and 7 on table
    play(g, "6C")
    assert set(g.legal_actions()) == {C("8C"), C("6H"), PASS}
    g2 = g
    assert set(g2.legal_actions()) == {C("8C"), C("6H"), PASS}
    play(g2, "P")  # take
    assert g2.phase == THROW_IN and g2.current_player == 0
    assert set(g2.legal_actions()) == {PASS}  # 9D rank not on table
    with pytest.raises(ValueError):
        g2.step(C("9D"))
    with pytest.raises(ValueError):
        g2.step(99)


def test_illegal_moves_raise():
    g = make_position(2, hands=["6S", "7C"], trump="H", talon=[], attacker=0)
    with pytest.raises(ValueError):
        g.step(PASS)  # cannot pass on empty table
    with pytest.raises(ValueError):
        g.step(C("7C"))  # not attacker's card
    play(g, "6S")
    with pytest.raises(ValueError):
        g.step(C("7C"))  # does not beat
    play(g, "P")
    play(g, "P")
    assert g.done and g.legal_actions() == [] and g.loser == 1


def test_defender_cannot_beat_only_pass():
    g = make_position(2, hands=["AS", "6C 7D"], trump="H", talon=[], attacker=0)
    play(g, "AS")
    assert g.legal_actions() == [PASS]


# --------------------------------------------------------------- bout limit
def test_bout_limit_min_six_hand():
    g = make_position(2, hands=["6S", "7S 8S AH"], trump="H", talon=[], attacker=0)
    assert g.bout_limit == 3
    g = make_position(2, hands=["6S", "7S 8S 9S 10S JS QS KS AS"], trump="H", talon=[], attacker=0)
    assert g.bout_limit == 6  # 8 cards, capped at 6
    g = make_position(2, hands=["6S", "7S 8S 9S 10S JS QS"], trump="H", talon=[], attacker=0, first_bout=True)
    assert g.bout_limit == 5
    g = make_position(2, hands=["6S", "7S 8S 9S"], trump="H", talon=[], attacker=0, first_bout=True)
    assert g.bout_limit == 3


def test_bout_limit_enforced_attack_and_throw_in():
    # defender has 2 cards: at most 2 attack cards
    g = make_position(3, hands=["6S 6C 6D", "AS AC", "6H"], trump="H", talon=[], attacker=0)
    assert g.bout_limit == 2
    play(g, "6S", "AS", "6C", "AC")
    assert g.phase == ATTACK and g.legal_actions() == [PASS]
    play(g, "P")
    assert g.current_player == 2 and g.legal_actions() == [PASS]
    # throw-in after take respects the limit too
    g = make_position(3, hands=["6S 6C 6D", "AS 7C", "6H"], trump="D", talon=[], attacker=0)
    play(g, "6S", "P")
    assert g.phase == THROW_IN
    assert set(g.legal_actions()) == {C("6C"), C("6D"), PASS}
    play(g, "6C")
    assert g.legal_actions() == [PASS]  # limit 2 reached
    play(g, "P")
    assert g.current_player == 2 and g.legal_actions() == [PASS]


def test_first_bout_limit_only_in_first_bout():
    for n in range(2, 7):
        for seed in range(20):
            g = DurakGame(seed=seed, num_players=n)
            assert g.first_bout and g.bout_limit == 5
            rng = random.Random(seed)
            b = g.bout_index
            while not g.done and g.bout_index == b:
                g.step(rng.choice(g.legal_actions()))
            if not g.done:
                assert not g.first_bout
                assert g.bout_limit == min(6, g.hands[g.defender].bit_count())


def test_first_bout_five_cards_max():
    g = make_position(
        2, hands=["6S 6C 7S 7C 8S 8C", "7D 8D 9D 10D JD QD"], talon=["6D"], attacker=0, first_bout=True
    )
    play(g, "6S", "7D", "6C", "8D", "7S", "9D", "7C", "10D", "8S", "JD")
    assert len(g.attack_cards) == 5 and g.legal_actions() == [PASS]


# ----------------------------------------------------------------- throwers
@pytest.mark.parametrize(
    "n,attacker,finished,defender,throwers",
    [
        (2, 0, [], 1, [0]),
        (2, 1, [], 0, [1]),
        (3, 0, [], 1, [0, 2]),
        (3, 2, [], 0, [2, 1]),
        (4, 0, [], 1, [0, 2]),
        (4, 3, [], 0, [3, 1]),
        (5, 4, [], 0, [4, 1]),
        (6, 5, [], 0, [5, 1]),
        (3, 0, [1], 2, [0]),  # only 2 remain
        (4, 0, [2], 1, [0, 3]),
        (4, 0, [1], 2, [0, 3]),
        (5, 1, [2, 4], 3, [1, 0]),
        (6, 0, [1, 2, 3, 4], 5, [0]),
    ],
)
def test_throwers(n, attacker, finished, defender, throwers):
    hands = [[] for _ in range(n)]
    deck = iter(range(NUM_CARDS))
    for p in range(n):
        if p not in finished:
            hands[p] = [next(deck), next(deck)]
    g = make_position(n, hands=hands, trump="H", talon=[], attacker=attacker, finished=finished)
    assert g.defender == defender and g.throwers == throwers


def test_non_neighbour_cannot_throw_4p():
    # seat 3 holds a matching card but is not a thrower when 0 attacks 1
    g = make_position(4, hands=["6S", "AS AC", "7C", "6C"], trump="H", talon=[], attacker=0)
    play(g, "6S", "AS")
    seen = set()
    while not g.done and g.bout_index == 1:
        seen.add(g.current_player)
        play(g, "P")
    assert 3 not in seen


# ------------------------------------------------------ priority & bita
def test_priority_restarts_after_each_beat_and_bita():
    g = make_position(3, hands=["6S 7D", "AS AC AD 10H", "6C 9C"], trump="H", talon=[], attacker=0)
    play(g, "6S", "AS")
    assert g.current_player == 0 and g.thrower_idx == 0
    play(g, "P")
    assert g.current_player == 2 and g.phase == ATTACK
    play(g, "6C")
    assert g.phase == DEFEND
    play(g, "AC")
    assert g.current_player == 0  # restarted with main attacker
    assert g.legal_actions() == [PASS]
    play(g, "P")
    assert g.current_player == 2
    play(g, "P")  # all passed in a row -> bita
    assert g.bout_index == 2
    assert g.discard & mask("6S AS 6C AC") == mask("6S AS 6C AC")
    assert g.attacker == 1 and g.defender == 2  # defender attacks next


def test_bita_requires_all_throwers_to_pass():
    g = make_position(3, hands=["6S 7D", "AS AC", "9C"], trump="H", talon=[], attacker=0)
    play(g, "6S", "AS", "P")
    assert g.bout_index == 1 and g.current_player == 2  # not yet bita
    play(g, "P")
    assert g.bout_index == 2


# ------------------------------------------------------ throw-in after take
def test_throw_in_after_take_each_thrower_in_order():
    g = make_position(4, hands=["6S 6D 8C", "7H 9S 9D QC", "6C 7S 6H", "KS"], trump="D", talon=[], attacker=0)
    play(g, "6S", "P")
    assert g.phase == THROW_IN and g.current_player == 0
    assert set(g.legal_actions()) == {C("6D"), PASS}
    play(g, "6D")
    assert g.phase == THROW_IN and g.current_player == 0  # may keep adding
    play(g, "P")
    assert g.current_player == 2
    assert set(g.legal_actions()) == {C("6C"), C("6H"), PASS}
    play(g, "6C", "6H")
    assert g.legal_actions() == [PASS]  # limit 4 reached
    play(g, "P")
    # defender picked everything up; known; next attacker skips defender
    assert hand(g, 1) == set(cards("7H 9S 9D QC 6S 6D 6C 6H"))
    assert g.known[1] == mask("6S 6D 6C 6H")
    assert g.attacker == 2 and g.defender == 3


def test_take_picks_up_beaten_cards_too():
    g = make_position(2, hands=["6S 7S 8C", "AS 9C KD"], trump="H", talon=[], attacker=0)
    play(g, "6S", "AS", "P")  # attacker passes: bita? no: 2p single thrower -> bita
    assert g.bout_index == 2 and g.attacker == 1
    g = make_position(2, hands=["6S 6C 8C", "AS 7C KD"], trump="H", talon=[], attacker=0)
    play(g, "6S", "AS", "6C", "P", "P")
    assert hand(g, 1) == set(cards("7C KD 6S AS 6C"))
    assert g.known[1] == mask("6S AS 6C")
    assert g.attacker == 0 and g.defender == 1  # 2p: attacker again after a take


# ---------------------------------------------------------------- drawing
def test_draw_order_attacker_others_clockwise_defender_last():
    hands = ["6S 8S 9S 10S JS QS", "7S 6C 7C 8C 9C", "6D 7D 8D 9D 10D", "KS AS 10C JC QC"]
    talon = ["6H", "7H", "8H", "9H", "10H", "JH"]  # drawn from the end: JH first
    g = make_position(4, hands=hands, trump="H", talon=talon, attacker=0, discard="")
    play(g, "6S", "7S", "P", "P")  # bita
    # attacker 0 needs 1 -> JH; then 2 needs 1 -> 10H; 3 needs 1 -> 9H; defender 1 needs 2 -> 8H, 7H
    assert C("JH") in hand(g, 0)
    assert C("10H") in hand(g, 2)
    assert C("9H") in hand(g, 3)
    assert {C("8H"), C("7H")} <= hand(g, 1)
    assert g.talon == [C("6H")]


def test_draw_short_talon_defender_gets_nothing_and_attacker_draws_first():
    hands = ["6S 7S 8S", "AS KS 6C 7C 8C 9C", "6D 7D 8D 9D 10D JD"]
    g = make_position(3, hands=hands, trump="H", talon=["6H", "7H"], attacker=0, discard=None)
    play(g, "6S", "AS", "P", "P")
    assert hand(g, 0) == set(cards("7S 8S 7H 6H"))
    assert g.talon == []
    assert g.known[0] == mask("6H")  # face-up trump card drawn: public
    assert hand(g, 1) == set(cards("KS 6C 7C 8C 9C"))


# ------------------------------------------------------- role rotation
def test_rotation_after_defence_and_take():
    hs = lambda: ["6S 7S", "AS AC", "6C 7C", "6D 7D"]  # noqa: E731
    g = make_position(4, hands=hs(), trump="H", talon=[], attacker=0)
    play(g, "6S", "AS", "P", "P")  # defended
    assert g.attacker == 1 and g.defender == 2 and g.throwers == [1, 3]
    g = make_position(4, hands=hs(), trump="H", talon=[], attacker=0)
    play(g, "7S", "P", "P", "P")  # taken
    assert g.attacker == 2 and g.defender == 3 and g.throwers == [2, 0]


def test_rotation_skips_finished_players():
    g = make_position(5, hands=["6S 7S", "AS AC", "", "6D 7D", "8D"], trump="H", talon=[], attacker=0, finished=[2])
    play(g, "7S", "P", "P", "P")  # taken by 1, seat 2 finished -> 3 attacks
    assert g.attacker == 3 and g.defender == 4
    # defender goes out after successful defence -> next after the defender attacks
    g = make_position(4, hands=["6S 7S", "AS", "6C 7C", "6D 7D"], trump="H", talon=[], attacker=0)
    play(g, "6S", "AS", "P", "P")
    assert g.finished == [1]
    assert g.attacker == 2 and g.defender == 3 and g.throwers == [2, 0]


# ------------------------------------------- going out / durak / draw
def test_finished_order_and_durak():
    # attacker plays last card, defender beats with last card: both out in draw order
    g = make_position(3, hands=["6S", "AS", "6C 7C"], trump="H", talon=[], attacker=0)
    play(g, "6S", "AS", "P", "P")
    assert g.done and g.finished == [0, 1] and g.loser == 2
    assert g.returns() == (0.5, 0.5, -1.0)


def test_defender_beats_last_card_others_continue():
    g = make_position(3, hands=["6S 8D", "AS", "6C 7C"], trump="H", talon=[], attacker=0)
    play(g, "6S", "AS", "P", "P")
    assert not g.done and g.finished == [1]
    assert g.attacker == 2 and g.defender == 0 and g.throwers == [2]


def test_defender_beats_last_card_talon_runs_out_before_defender_draws():
    hands = ["6S 7S 8S 9S 10S JS", "AS", "6C 7C 8C 9C 10C JC"]
    g = make_position(3, hands=hands, trump="H", talon=["6H"], attacker=0)
    play(g, "6S", "AS", "P", "P")
    assert C("6H") in hand(g, 0) and g.talon == []
    assert g.finished == [1] and not g.done


def test_draw_two_players_all_out_together():
    g = make_position(2, hands=["6S", "AS"], trump="H", talon=[], attacker=0)
    play(g, "6S", "AS", "P")
    assert g.done and g.loser is None and g.finished == [0, 1]
    assert g.returns() == (0.0, 0.0) and g.winner is None


def test_draw_three_players_all_out_together():
    g = make_position(3, hands=["6S", "AS AC", "6C"], trump="H", talon=[], attacker=0)
    play(g, "6S", "AS", "P", "6C", "AC", "P", "P")
    assert g.done and g.loser is None and sorted(g.finished) == [0, 1, 2]


def test_two_player_defender_out_attacker_durak():
    g = make_position(2, hands=["6S 7D", "AS"], trump="H", talon=[], attacker=0)
    play(g, "6S", "AS", "P")
    assert g.done and g.loser == 0 and g.winner == 1 and g.returns() == (-1.0, 1.0)


def test_defender_takes_last_attack_is_durak():
    g = make_position(2, hands=["6S", "7C"], trump="H", talon=[], attacker=0)
    play(g, "6S", "P", "P")
    assert g.done and g.loser == 1 and g.finished == [0]


def test_no_one_out_while_talon_nonempty():
    g = make_position(2, hands=["6S 7C 8C 9C 10C JC", "AS"], trump="H", talon=["6H", "7H"], attacker=0)
    play(g, "6S", "AS", "P")
    assert not g.done and g.finished == [] and g.talon == []
    assert C("7H") in hand(g, 0) and hand(g, 1) == {C("6H")}
    assert g.known[1] == mask("6H")


# -------------------------------------------------------------- 6p deal
def test_six_player_deal():
    for seed in range(50):
        g = DurakGame(seed=seed, num_players=6)
        assert g.talon == []
        assert all(h.bit_count() == 6 for h in g.hands)
        acc = 0
        for h in g.hands:
            assert acc & h == 0
            acc |= h
        assert acc == FULL_MASK
        assert g.hands[5] >> g.trump_card & 1
        assert g.known[5] == 1 << g.trump_card and g.known[:5] == [0] * 5
        assert g.trump == suit_of(g.trump_card)
        assert not g.unseen_mask(0) >> g.trump_card & 1
        assert g.bout_limit == 5


@pytest.mark.parametrize("n", [2, 3, 4, 5])
def test_deal_sizes(n):
    g = DurakGame(seed=7, num_players=n)
    assert all(h.bit_count() == 6 for h in g.hands)
    assert len(g.talon) == 36 - 6 * n
    assert g.talon[0] == g.trump_card and g.known == [0] * n
    check_invariants(g)


# ---------------------------------------------------------------- known
def test_known_tracking():
    g = make_position(2, hands=["6S 6C 9D 10D", "7S AS 6H 8C"], trump="H", talon=[], attacker=0)
    play(g, "6S", "7S", "6C", "P", "P")
    assert g.known[1] == mask("6S 7S 6C") and g.attacker == 0
    play(g, "9D", "6H")  # beaten with a non-known card
    assert g.known[1] == mask("6S 7S 6C")
    play(g, "P")  # bita, 1 attacks
    assert g.attacker == 1
    play(g, "6C")  # leads a known card -> leaves known
    assert g.known[1] == mask("6S 7S")
    play(g, "P", "P")  # 0 takes
    assert g.known[0] == mask("6C")


def test_known_trump_card_draw_in_real_games():
    for n in range(2, 6):
        for seed in range(30):
            g = DurakGame(seed=seed, num_players=n)
            rng = random.Random(seed)
            tc = g.trump_card
            while g.talon and not g.done:
                g.step(rng.choice(g.legal_actions()))
            for p in range(n):
                if g.hands[p] >> tc & 1:
                    assert g.known[p] >> tc & 1
                assert not g.unseen_mask(p) >> tc & 1


def test_unseen_mask():
    g = make_position(3, hands=["6S", "7S 8S", "9S"], trump="H", talon=["6H", "7H"], known=[[], ["8S"], []], discard="")
    um = g.unseen_mask(0)
    assert um == mask("7S 9S 7H") | (FULL_MASK & ~mask("6S 7S 8S 9S 6H 7H"))  # rest unaccounted
    # with discard = everything else
    g = make_position(3, hands=["6S", "7S 8S", "9S"], trump="H", talon=["6H", "7H"], known=[[], ["8S"], []])
    assert g.unseen_mask(0) == mask("7S 9S 7H")
    assert g.unseen_mask(1) == mask("6S 9S 7H")


# ---------------------------------------------------------- first attacker
@pytest.mark.parametrize("n", [2, 3, 4, 5, 6])
def test_first_attacker_lowest_trump(n):
    no_trump_seen = False
    for seed in range(300):
        g = DurakGame(seed=seed, num_players=n)
        tm = SUIT_MASKS[g.trump]
        lows = [(mask_to_list(h & tm)[0], p) for p, h in enumerate(g.hands) if h & tm]
        if lows:
            assert g.attacker == min(lows)[1]
        else:
            no_trump_seen = True
            assert 0 <= g.attacker < n
        assert g.defender == (g.attacker + 1) % n
    if n == 2:
        assert no_trump_seen


# ---------------------------------------------------------- determinize
def _random_midgame(n, seed, steps):
    g = DurakGame(seed=seed, num_players=n)
    rng = random.Random(seed * 7 + 1)
    for _ in range(steps):
        if g.done:
            break
        g.step(rng.choice(g.legal_actions()))
    return g


def _check_determinization(g, d, player):
    assert d.hands[player] == g.hands[player]
    assert len(d.talon) == len(g.talon)
    if g.talon:
        assert d.talon[0] == g.talon[0] == g.trump_card
    assert d.discard == g.discard and d.attack_cards == g.attack_cards and d.defense_cards == g.defense_cards
    assert d.known == g.known and d.finished == g.finished and d.log == g.log
    for q in range(g.num_players):
        assert d.hands[q].bit_count() == g.hands[q].bit_count()
        assert d.hands[q] & g.known[q] == g.known[q]
    # hidden cards only move within the unseen pool
    um = g.unseen_mask(player)
    for q in range(g.num_players):
        if q != player:
            assert (d.hands[q] ^ g.hands[q]) & ~um == 0
    assert (list_to_mask(d.talon) ^ list_to_mask(g.talon)) & ~um == 0
    check_invariants(d)
    if not g.done and g.current_player == player:
        assert d.legal_mask_int() == g.legal_mask_int()


@pytest.mark.parametrize("n", [2, 3, 4, 5, 6])
def test_determinize_consistent(n):
    rng = random.Random(n)
    for seed in range(40):
        g = _random_midgame(n, seed, rng.randrange(0, 120))
        for p in range(n):
            d = g.determinize(p, rng)
            _check_determinization(g, d, p)
            # determinized game is playable to the end
            r = random.Random(seed)
            while not d.done:
                d.step(r.choice(d.legal_actions()))


def test_determinize_varies_hidden_cards():
    g = DurakGame(seed=3, num_players=3)
    rng = random.Random(0)
    seen = {tuple(g.determinize(0, rng).hands) for _ in range(20)}
    assert len(seen) > 1


@pytest.mark.parametrize("n", [2, 3, 4, 5, 6])
def test_determinize_exact_when_talon_empty_two_left(n):
    rng = random.Random(100 + n)
    hits = 0
    for seed in range(200):
        g = DurakGame(seed=seed, num_players=n)
        r = random.Random(seed)
        while not g.done and not (not g.talon and len(g.active_players) == 2):
            g.step(r.choice(g.legal_actions()))
        if g.done:
            continue
        hits += 1
        for p in g.active_players:
            for _ in range(3):
                d = g.determinize(p, rng)
                assert d.hands == g.hands and d.talon == []
    assert hits > 20


def test_determinize_exact_two_players_talon_one():
    rng = random.Random(1)
    hits = 0
    for seed in range(300):
        g = DurakGame(seed=seed, num_players=2)
        r = random.Random(seed)
        while not g.done and len(g.talon) > 1:
            g.step(r.choice(g.legal_actions()))
        if g.done or len(g.talon) != 1:
            continue
        hits += 1
        for p in (0, 1):
            d = g.determinize(p, rng)
            assert d.hands == g.hands and d.talon == g.talon == [g.trump_card]
    assert hits > 50


def test_determinize_never_moves_known_cards_multiplayer():
    g = make_position(
        4,
        hands=["6S 7S", "8S 9S 10S", "JS QS", "KS AS 6C"],
        trump="H",
        talon=["6H", "7H", "8H"],
        known=["", "8S 9S", "", "AS"],
    )
    rng = random.Random(5)
    for _ in range(50):
        d = g.determinize(0, rng)
        assert d.hands[1] & mask("8S 9S") == mask("8S 9S")
        assert d.hands[3] >> C("AS") & 1
        assert d.hands[0] == g.hands[0] and d.talon[0] == C("6H")
        _check_determinization(g, d, 0)


# ------------------------------------------------------------------ clone
def test_clone_independence():
    g = _random_midgame(4, 11, 25)
    snap = (g.hands[:], g.talon[:], g.known[:], g.log[:], g.finished[:], g.attack_cards[:], g.throwers[:], repr(g))
    c = g.clone()
    assert repr(c) == repr(g)
    rng = random.Random(0)
    while not c.done:
        c.step(rng.choice(c.legal_actions()))
    assert (g.hands, g.talon, g.known, g.log, g.finished, g.attack_cards, g.throwers, repr(g)) == snap
    # all slots copied
    c2 = g.clone()
    for s in DurakGame.__slots__:
        assert getattr(c2, s) == getattr(g, s)


# ------------------------------------------------------------------- fuzz
@pytest.mark.parametrize("n", [2, 3, 4, 5, 6])
def test_fuzz_random_games(n):
    for seed in range(150):
        g = DurakGame(seed=seed, num_players=n)
        rng = random.Random(seed + 1000)
        check_invariants(g)
        steps = 0
        bout = g.bout_index
        while not g.done:
            p = g.current_player
            assert p in g.throwers or (p == g.defender and g.phase == DEFEND)
            assert p not in g.finished
            legal = g.legal_actions()
            assert legal
            if g.phase == ATTACK and not g.attack_cards:
                assert PASS not in legal
            else:
                assert PASS in legal
            g.step(rng.choice(legal))
            steps += 1
            assert steps < 3000
            check_invariants(g)
            if g.bout_index != bout and not g.done:
                bout = g.bout_index
                assert not g.first_bout
                assert g.bout_limit == min(6, g.hands[g.defender].bit_count())
                assert g.attack_cards == [] and g.phase == ATTACK
                if g.talon:
                    assert all(g.hands[q].bit_count() >= 6 for q in range(n))
                else:
                    assert all(g.hands[q] for q in g.active_players)
        r = g.returns()
        assert abs(sum(r)) < 1e-9
        if g.loser is None:
            assert r == (0.0,) * n
            if g.stall >= g.config.stall_bouts:  # draw by stalemate (3+ players left)
                assert len(g.active_players) >= 3 and not g.talon
            else:
                assert sorted(g.finished) == list(range(n))
        else:
            assert g.loser not in g.finished
            assert sorted(g.finished + [g.loser]) == list(range(n))
            assert g.hands[g.loser] != 0
            assert r[g.loser] == -1.0
        assert len(g.finished) == len(set(g.finished))


def test_stall_draw_only_with_three_or_more_players():
    # Random play in 3+ player games occasionally cycles; the stall rule must end them as draws.
    stalled = 0
    for seed in range(400):
        g = DurakGame(seed=seed, num_players=4)
        rng = random.Random(seed)
        while not g.done:
            g.step(rng.choice(g.legal_actions()))
            assert g.stall < g.config.stall_bouts or g.done
        if g.loser is None and g.stall >= g.config.stall_bouts:
            stalled += 1
            assert len(g.active_players) >= 3
    # 2 players never stall: every take shrinks the attacker's hand.
    for seed in range(300):
        g = DurakGame(seed=seed, num_players=2)
        rng = random.Random(seed)
        while not g.done:
            g.step(rng.choice(g.legal_actions()))
            assert g.stall == 0
