"""Rules engine for 2-player Podkidnoy Durak (36 cards).

See docs/SPEC.md for the full rule set and the action encoding. In short:

* Actions are ints in [0, 37): 0..35 play that card, 36 = PASS. PASS means
  "bita / end attack" for the attacker in ATTACK phase, "take" for the
  defender in DEFEND phase, and "done throwing in" in THROW_IN phase.
* Play is strictly sequential: the attacker plays one card, the defender
  beats it (or takes), the attacker adds another card or ends the bout.
"""

from __future__ import annotations

import random
from dataclasses import dataclass

from .cards import (
    FULL_MASK,
    NUM_CARDS,
    RANK_MASKS,
    SUIT_MASKS,
    beaters_mask,
    card_str,
    list_to_mask,
    mask_to_list,
    rank_of,
    suit_of,
)

PASS = NUM_CARDS  # 36
NUM_ACTIONS = NUM_CARDS + 1  # 37

# Phases
ATTACK = 0  # attacker to move: play a card (or PASS = bita if table non-empty)
DEFEND = 1  # defender to move: beat the single uncovered card, or PASS = take
THROW_IN = 2  # defender has taken; attacker may add cards, PASS = done
PHASE_NAMES = ["attack", "defend", "throw_in"]

HAND_SIZE = 6


@dataclass(frozen=True)
class Config:
    hand_size: int = HAND_SIZE
    max_bout_cards: int = 6
    # Limit on attack cards in the very first bout of the game only.
    first_bout_limit: int = 5


DEFAULT_CONFIG = Config()


class DurakGame:
    """Mutable game state. Use :meth:`clone` for search."""

    __slots__ = (
        "config",
        "hands",
        "talon",
        "trump_card",
        "trump",
        "discard",
        "known",
        "attack_cards",
        "defense_cards",
        "attacker",
        "phase",
        "bout_limit",
        "first_bout",
        "done",
        "winner",
        "log",
        "bout_index",
    )

    def __init__(self, seed: int | None = None, config: Config = DEFAULT_CONFIG, deal: bool = True):
        self.config = config
        if deal:
            self._deal(random.Random(seed))

    # ------------------------------------------------------------------ setup
    def _deal(self, rng: random.Random) -> None:
        deck = list(range(NUM_CARDS))
        rng.shuffle(deck)
        n = self.config.hand_size
        # Talon is drawn from the END; talon[0] is the face-up trump card.
        self.hands = [list_to_mask(deck[:n]), list_to_mask(deck[n : 2 * n])]
        self.talon = deck[2 * n :]
        self.trump_card = self.talon[0]
        self.trump = suit_of(self.trump_card)
        self.discard = 0
        self.known = [0, 0]  # publicly known cards in each player's hand
        self.attack_cards: list[int] = []
        self.defense_cards: list[int] = []
        self.done = False
        self.winner: int | None = None  # None while running or on a draw
        self.log: list[tuple[int, int]] = []  # (player, action)
        self.bout_index = 0
        self.first_bout = True

        # First attacker: holder of the lowest trump; random if nobody has one.
        tmask = SUIT_MASKS[self.trump]
        lows = []
        for p in (0, 1):
            t = self.hands[p] & tmask
            lows.append((t & -t).bit_length() if t else 99)
        if lows[0] == lows[1] == 99:
            self.attacker = rng.randrange(2)
        else:
            self.attacker = 0 if lows[0] < lows[1] else 1
        self.phase = ATTACK
        self._start_bout()

    def _start_bout(self) -> None:
        cap = self.config.first_bout_limit if self.first_bout else self.config.max_bout_cards
        self.bout_limit = min(cap, self.hands[self.defender].bit_count())
        self.attack_cards = []
        self.defense_cards = []
        self.phase = ATTACK

    # ------------------------------------------------------------ properties
    @property
    def defender(self) -> int:
        return 1 - self.attacker

    @property
    def current_player(self) -> int:
        return self.defender if self.phase == DEFEND else self.attacker

    @property
    def table_mask(self) -> int:
        return list_to_mask(self.attack_cards) | list_to_mask(self.defense_cards)

    def _table_rank_mask(self) -> int:
        """Bitmask of all cards whose rank appears on the table."""
        m = 0
        for c in self.attack_cards:
            m |= RANK_MASKS[rank_of(c)]
        for c in self.defense_cards:
            m |= RANK_MASKS[rank_of(c)]
        return m

    # ---------------------------------------------------------- legal moves
    def legal_mask_int(self) -> int:
        """Legal actions as a 37-bit int (bit 36 = PASS)."""
        if self.done:
            return 0
        if self.phase == DEFEND:
            uncovered = self.attack_cards[-1]
            return (self.hands[self.defender] & beaters_mask(uncovered, self.trump)) | (1 << PASS)
        hand = self.hands[self.attacker]
        if self.phase == ATTACK and not self.attack_cards:
            return hand  # must lead a card; cannot pass on an empty table
        m = 1 << PASS
        if len(self.attack_cards) < self.bout_limit:
            m |= hand & self._table_rank_mask()
        return m

    def legal_actions(self) -> list[int]:
        return mask_to_list(self.legal_mask_int())

    def is_legal(self, action: int) -> bool:
        return 0 <= action < NUM_ACTIONS and bool(self.legal_mask_int() >> action & 1)

    # ------------------------------------------------------------------ step
    def step(self, action: int) -> None:
        if not self.is_legal(action):
            raise ValueError(f"illegal action {action} in phase {PHASE_NAMES[self.phase]}")
        player = self.current_player
        self.log.append((player, action))
        if self.phase == ATTACK:
            if action == PASS:  # bita: successful defence
                self.discard |= self.table_mask
                self._end_bout(defended=True)
            else:
                self._remove(player, action)
                self.attack_cards.append(action)
                self.phase = DEFEND
        elif self.phase == DEFEND:
            if action == PASS:  # take
                self.phase = THROW_IN
            else:
                self._remove(player, action)
                self.defense_cards.append(action)
                self.phase = ATTACK
        else:  # THROW_IN
            if action == PASS:
                d = self.defender
                picked = self.table_mask
                self.hands[d] |= picked
                self.known[d] |= picked
                self._end_bout(defended=False)
            else:
                self._remove(player, action)
                self.attack_cards.append(action)

    def _remove(self, player: int, card: int) -> None:
        bit = 1 << card
        self.hands[player] &= ~bit
        self.known[player] &= ~bit

    def _end_bout(self, defended: bool) -> None:
        # Draw: attacker first, then defender.
        for p in (self.attacker, self.defender):
            need = self.config.hand_size - self.hands[p].bit_count()
            while need > 0 and self.talon:
                self.hands[p] |= 1 << self.talon.pop()
                need -= 1
        self.bout_index += 1
        self.first_bout = False
        if not self.talon:
            e0, e1 = self.hands[0] == 0, self.hands[1] == 0
            if e0 or e1:
                self.done = True
                self.winner = None if (e0 and e1) else (0 if e0 else 1)
                self.attack_cards = []
                self.defense_cards = []
                return
        if defended:
            self.attacker = self.defender
        self._start_bout()

    # ------------------------------------------------------------ utilities
    @property
    def loser(self) -> int | None:
        if not self.done or self.winner is None:
            return None
        return 1 - self.winner

    def returns(self) -> tuple[float, float]:
        """Terminal payoff: +1 win, -1 loss, 0 draw (or not finished)."""
        if not self.done or self.winner is None:
            return (0.0, 0.0)
        return (1.0, -1.0) if self.winner == 0 else (-1.0, 1.0)

    def clone(self) -> "DurakGame":
        g = DurakGame.__new__(DurakGame)
        g.config = self.config
        g.hands = self.hands[:]
        g.talon = self.talon[:]
        g.trump_card = self.trump_card
        g.trump = self.trump
        g.discard = self.discard
        g.known = self.known[:]
        g.attack_cards = self.attack_cards[:]
        g.defense_cards = self.defense_cards[:]
        g.attacker = self.attacker
        g.phase = self.phase
        g.bout_limit = self.bout_limit
        g.first_bout = self.first_bout
        g.done = self.done
        g.winner = self.winner
        g.log = self.log[:]
        g.bout_index = self.bout_index
        return g

    def unseen_mask(self, player: int) -> int:
        """Cards whose location is unknown to ``player``: in the opponent's hand
        (not publicly known) or in the talon (excluding the face-up trump card)."""
        opp = 1 - player
        seen = self.hands[player] | self.discard | self.table_mask | self.known[opp]
        if self.talon:
            seen |= 1 << self.trump_card
        return FULL_MASK & ~seen

    def determinize(self, player: int, rng: random.Random) -> "DurakGame":
        """Return a clone where all hidden information (from ``player``'s point
        of view) is resampled uniformly consistent with what ``player`` knows."""
        g = self.clone()
        opp = 1 - player
        pool = mask_to_list(self.unseen_mask(player))
        rng.shuffle(pool)
        n_opp_hidden = self.hands[opp].bit_count() - self.known[opp].bit_count()
        g.hands[opp] = self.known[opp] | list_to_mask(pool[:n_opp_hidden])
        rest = pool[n_opp_hidden:]
        g.talon = ([self.trump_card] + rest) if self.talon else []
        assert len(g.talon) == len(self.talon)
        return g

    def info_state(self, player: int) -> dict:
        """Everything ``player`` is allowed to know. Basis for observations."""
        opp = 1 - player
        return {
            "player": player,
            "hand": mask_to_list(self.hands[player]),
            "opp_hand_size": self.hands[opp].bit_count(),
            "opp_known": mask_to_list(self.known[opp]),
            "attack_cards": list(self.attack_cards),
            "defense_cards": list(self.defense_cards),
            "discard": mask_to_list(self.discard),
            "trump_card": self.trump_card,
            "trump": self.trump,
            "talon_size": len(self.talon),
            "attacker": self.attacker,
            "phase": self.phase,
            "bout_limit": self.bout_limit,
            "first_bout": self.first_bout,
            "to_move": self.current_player,
            "legal": self.legal_actions() if self.current_player == player else [],
            "done": self.done,
            "winner": self.winner,
        }

    def __repr__(self) -> str:
        def fmt(m):
            return " ".join(card_str(c) for c in mask_to_list(m))

        table = " ".join(
            card_str(a) + ("/" + card_str(self.defense_cards[i]) if i < len(self.defense_cards) else "")
            for i, a in enumerate(self.attack_cards)
        )
        return (
            f"<Durak trump={card_str(self.trump_card)} talon={len(self.talon)} "
            f"att=P{self.attacker} phase={PHASE_NAMES[self.phase]} limit={self.bout_limit}\n"
            f"  P0: {fmt(self.hands[0])}\n  P1: {fmt(self.hands[1])}\n  table: {table}"
            f"  done={self.done} winner={self.winner}>"
        )


def action_str(action: int) -> str:
    return "PASS" if action == PASS else card_str(action)
