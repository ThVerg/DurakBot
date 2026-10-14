"""Strong rule-based Durak agent for any number of players.

The agent only uses information the player is entitled to: its own hand, public
table/discard/talon size, ``game.known`` (cards publicly seen entering a hand),
``game.unseen_mask(player)`` and hand sizes. It never reads opponents' hidden
cards, except when the position is perfect information (talon empty and two
players left). There the opponent's hand equals the unseen pool plus their known
cards, which the agent derives from public information itself.

Main ideas:
  * Card value: non-trumps by rank; trumps above every non-trump.
  * Lead low non-trumps, preferring ranks we hold several of. In the endgame,
    lead cards the defender probably cannot beat.
  * Add or throw in cheap cards. The threshold rises as the talon shrinks, when
    the defender is weak, and when we are the defender's other neighbour (a take
    means we attack next instead of being attacked).
  * Defend with the cheapest beater, avoiding giving the throwers new ranks.
    Take instead of spending a high trump when the talon is large and the
    table is cheap.
  * Card counting: the probability that a hidden card is in a given hand comes
    from the unseen pool and the hand sizes.

Parameters were tuned in the arena (``durak.arena``) against random and earlier
versions. Adding aggressively and counting-aware beater choice gave the
largest gains. Games with 3+ players use ``MULTI_PARAMS`` overrides.
"""

from __future__ import annotations

import random

from ..cards import RANK_MASKS, SUIT_MASKS, beaters_mask, rank_of, suit_of
from ..engine import ATTACK, DEFEND, PASS, DurakGame
from . import Agent, register

DEFAULT_PARAMS = dict(
    trump_bonus=9.0,  # value of a trump card = trump_bonus + rank
    # Leading
    lead_pair_bonus=1.2,  # per extra card of the same rank in hand
    lead_trump_penalty=6.0,
    lead_unbeatable_bonus=6.0,  # * P(defender cannot beat), endgame
    lead_count_talon=3,  # before the endgame, use counting for leads once talon <= this
    lead_count_weight=3.0,  # ...with this weight * P(defender cannot beat)
    # Adding during the bout (ATTACK phase, table non-empty)
    add_thr_base=10.0,  # add a card if its value <= threshold (trumps count trump_bonus + rank)
    add_thr_talon_slope=0.35,  # threshold increase per card fewer in the talon
    add_thr_neighbour=1.5,  # we are the defender's other neighbour
    add_thr_weak_def=2.0,  # defender has few cards left
    # Throw-in after a take
    thr_thr_base=4.5,
    thr_thr_talon_slope=0.35,
    # Defending
    take_talon_min=6,  # only consider taking (when we could beat) if talon >= this
    take_trump_rank_min=4,  # trump beater rank idx >= this (10+) is "expensive"
    take_table_max=2,  # ...and the table holds at most this many cards
    take_attack_max=4,  # ...and every attack card is a non-trump of value <= this
    new_rank_penalty=4.0,  # beater opens a rank the throwers can follow: * P(they hold it)
)

# Overrides for games with 3+ players (tuned in the arena): conserve trumps more
# and value same-rank groups less.
MULTI_PARAMS = dict(trump_bonus=14.0, lead_pair_bonus=0.5)


class HeuristicAgent(Agent):
    name = "heuristic"

    def __init__(self, seed: int | None = None, **params):
        unknown = set(params) - set(DEFAULT_PARAMS)
        if unknown:
            raise TypeError(f"unknown heuristic params: {sorted(unknown)}")
        self.p2 = {**DEFAULT_PARAMS, **params}
        self.pm = {**DEFAULT_PARAMS, **MULTI_PARAMS, **params}
        self.p = self.p2
        self.rng = random.Random(seed)

    # ------------------------------------------------------------ utilities
    def _val(self, c: int, trump: int) -> float:
        r = rank_of(c)
        return r + self.p["trump_bonus"] if suit_of(c) == trump else float(r)

    def _cheapest(self, cards: list[int], trump: int) -> int:
        return min(cards, key=lambda c: (self._val(c, trump), c))

    @staticmethod
    def _bits(m: int) -> list[int]:
        out = []
        while m:
            low = m & -m
            out.append(low.bit_length() - 1)
            m ^= low
        return out

    def _hidden_model(self, game: DurakGame, me: int):
        """Return (unseen_mask, {q: (known_mask, n_unknown)}, n_hidden_talon)."""
        unseen = game.unseen_mask(me)
        model = {}
        for q in game.active_players:
            if q == me:
                continue
            k = game.known[q]
            model[q] = (k, game.hands[q].bit_count() - k.bit_count())
        hidden_talon = max(0, len(game.talon) - 1)
        return unseen, model, hidden_talon

    def _p_can_beat(self, game: DurakGame, me: int, q: int, c: int, model=None) -> float:
        """Probability that player ``q`` holds a card beating ``c``."""
        unseen, m, hidden_talon = model or self._hidden_model(game, me)
        known_q, unk_q = m[q]
        bm = beaters_mask(c, game.trump)
        if known_q & bm:
            return 1.0
        n_pool = unseen.bit_count()
        b = (unseen & bm).bit_count()
        if b == 0 or unk_q == 0 or n_pool == 0:
            return 0.0
        # P(none of the b beaters among q's unk_q unknown cards) (hypergeometric)
        p_none = 1.0
        for i in range(unk_q):
            p_none *= max(0.0, (n_pool - b - i)) / (n_pool - i)
            if p_none == 0.0:
                break
        return 1.0 - p_none

    def _p_throwers_hold(self, game: DurakGame, me: int, cards_mask: int, model) -> float:
        """Probability that at least one thrower holds a card of ``cards_mask``."""
        unseen, m, _ = model
        n_pool = unseen.bit_count()
        p_none = 1.0
        for q in game.throwers:
            if q == me or q not in m:
                continue
            known_q, unk_q = m[q]
            if known_q & cards_mask:
                return 1.0
            b = (unseen & cards_mask).bit_count()
            if b == 0 or unk_q == 0 or n_pool == 0:
                continue
            for i in range(unk_q):
                p_none *= max(0.0, (n_pool - b - i)) / (n_pool - i)
            # (independence between throwers is an approximation)
        return 1.0 - p_none

    def _perfect_opp_hand(self, game: DurakGame, me: int):
        """Opponent hand when it is derivable from public info (talon empty,
        two active players), else None."""
        act = game.active_players
        if game.talon or len(act) != 2 or me not in act:
            return None
        q = act[0] if act[1] == me else act[1]
        return q, game.unseen_mask(me) | game.known[q]

    # ---------------------------------------------------------------- act
    def act(self, game: DurakGame, player: int) -> int:
        legal = game.legal_actions()
        if len(legal) == 1:
            return legal[0]
        self.p = self.p2 if game.num_players == 2 else self.pm
        if game.phase == DEFEND:
            return self._defend(game, player, legal)
        if game.phase == ATTACK:
            if not game.attack_cards:
                return self._lead(game, player, legal)
            return self._add(game, player, legal, throw_in=False)
        return self._add(game, player, legal, throw_in=True)

    # -------------------------------------------------------------- lead
    def _lead(self, game: DurakGame, me: int, legal: list[int]) -> int:
        trump = game.trump
        hand = game.hands[me]
        talon = len(game.talon)
        dfd = game.defender
        p = self.p
        endgame = talon == 0
        model = self._hidden_model(game, me) if (endgame or talon <= p["lead_count_talon"]) else None
        perfect = self._perfect_opp_hand(game, me)
        n_hand = hand.bit_count()
        all_trump = (hand & ~SUIT_MASKS[trump]) == 0
        best, best_s = None, None
        for c in legal:
            v = self._val(c, trump)
            same = (hand & RANK_MASKS[rank_of(c)]).bit_count() - 1
            s = v - p["lead_pair_bonus"] * same
            if suit_of(c) == trump and not all_trump:
                s += p["lead_trump_penalty"] if not endgame else 1.0
            if endgame:
                if perfect is not None:
                    opp_hand = perfect[1]
                    pb = 1.0 if opp_hand & beaters_mask(c, trump) else 0.0
                else:
                    pb = self._p_can_beat(game, me, dfd, c, model)
                s -= p["lead_unbeatable_bonus"] * (1.0 - pb)
                # Dumping a rank we hold many of gets us closer to going out.
                s -= 0.5 * same
                if same + 1 == n_hand:
                    s -= 5.0  # whole hand is one rank: lead it, try to go out
            elif model is not None:
                pb = self._p_can_beat(game, me, dfd, c, model)
                s -= p["lead_count_weight"] * (1.0 - pb) * (1.0 if v < 9 else 0.3)
            if best_s is None or s < best_s:
                best, best_s = c, s
        return best

    # --------------------------------------------------------- add / throw
    def _add(self, game: DurakGame, me: int, legal: list[int], throw_in: bool) -> int:
        cards = [c for c in legal if c != PASS]
        if not cards:
            return PASS
        trump = game.trump
        p = self.p
        talon = len(game.talon)
        hand = game.hands[me]
        n_hand = hand.bit_count()
        dfd = game.defender
        nact = len(game.active_players)
        # Going out: with an empty talon, if we can dump our whole hand, do it.
        if talon == 0 and len(cards) == n_hand:
            room = game.bout_limit - len(game.attack_cards)
            if room >= n_hand:
                return self._cheapest(cards, trump)
        talon_short = max(0, 12 - talon)  # 0 while the talon is big
        if throw_in:
            thr = p["thr_thr_base"] + p["thr_thr_talon_slope"] * talon_short
        else:
            thr = p["add_thr_base"] + p["add_thr_talon_slope"] * talon_short
            if nact > 2 and me != game.attacker:
                # A take means we attack next; a defence means the defender
                # attacks us next.
                thr += p["add_thr_neighbour"]
            d_left = game.hands[dfd].bit_count()
            if d_left <= 2:
                thr += p["add_thr_weak_def"]
        if talon == 0:
            thr = max(thr, 8.0)  # endgame: dump any non-trump
            if throw_in:
                thr = max(thr, 8.0 + 0.5 * p["trump_bonus"])  # and low trumps
        c = self._cheapest(cards, trump)
        v = self._val(c, trump)
        if not throw_in and talon == 0:
            # Endgame add: prefer a card the defender can't beat.
            perfect = self._perfect_opp_hand(game, me)
            model = None if perfect else self._hidden_model(game, me)

            def pbeat(x):
                if perfect is not None:
                    return 1.0 if perfect[1] & beaters_mask(x, trump) else 0.0
                return self._p_can_beat(game, me, dfd, x, model)

            scored = sorted(cards, key=lambda x: (self._val(x, trump) - 6.0 * (1.0 - pbeat(x)), x))
            c = scored[0]
            v = self._val(c, trump) - 6.0 * (1.0 - pbeat(c))
        if v <= thr:
            return c
        return PASS

    # ------------------------------------------------------------- defend
    def _defend(self, game: DurakGame, me: int, legal: list[int]) -> int:
        beats = [c for c in legal if c != PASS]
        if not beats:
            return PASS
        trump = game.trump
        p = self.p
        talon = len(game.talon)
        att = game.attack_cards[-1]
        table_ranks = 0
        for x in game.attack_cards:
            table_ranks |= RANK_MASKS[rank_of(x)]
        for x in game.defense_cards:
            table_ranks |= RANK_MASKS[rank_of(x)]

        room = game.bout_limit - len(game.attack_cards)
        model = self._hidden_model(game, me) if room > 0 else None

        def cost(c):
            v = self._val(c, trump)
            rm = RANK_MASKS[rank_of(c)]
            if room > 0 and not (table_ranks & rm):
                # A new rank on the table lets the throwers add more cards.
                v += p["new_rank_penalty"] * self._p_throwers_hold(game, me, rm & ~(1 << c), model)
            return v

        b = min(beats, key=lambda c: (cost(c), c))
        if suit_of(b) == trump and talon >= p["take_talon_min"]:
            table_n = len(game.attack_cards) + len(game.defense_cards)
            cheap_table = all(suit_of(x) != trump and rank_of(x) <= p["take_attack_max"] for x in game.attack_cards)
            if (
                rank_of(b) >= p["take_trump_rank_min"]
                and table_n <= p["take_table_max"]
                and cheap_table
                and suit_of(att) != trump
            ):
                return PASS
        return b


register("heuristic", HeuristicAgent)
