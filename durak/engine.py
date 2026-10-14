"""Rules engine for Podkidnoy Durak, 2-6 players, 36 cards.

See docs/SPEC.md for the full rule set and the action encoding. In short:

* Actions are ints in [0, 37): 0..35 play that card, 36 = PASS.
* Play is strictly sequential, one card at a time. The main attacker leads;
  only the main attacker and the defender's other neighbour ("throwers") may
  add cards. Each time the table is fully covered, throwers are asked in
  priority order (main attacker first) to add a card or PASS; when all of them
  pass in a row the bout ends with "bita". The defender beats the single
  uncovered card or PASSes (= take). After a take, each thrower in order may
  add cards and then PASSes ("done"); then the defender picks everything up.
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
MIN_PLAYERS, MAX_PLAYERS = 2, 6

# Phases
ATTACK = 0  # a thrower to move: lead/add a card, or PASS (only once the table is non-empty)
DEFEND = 1  # defender to move: beat the single uncovered card, or PASS = take
THROW_IN = 2  # defender has taken; throwers in order may add cards, PASS = done
PHASE_NAMES = ["attack", "defend", "throw_in"]


@dataclass(frozen=True)
class Config:
    hand_size: int = 6
    max_bout_cards: int = 6
    # Limit on attack cards in the very first bout of the game only.
    first_bout_limit: int = 5


DEFAULT_CONFIG = Config()


class DurakGame:
    """Mutable game state. Use :meth:`clone` for search."""

    __slots__ = (
        "config",
        "num_players",
        "hands",
        "talon",
        "trump_card",
        "trump",
        "discard",
        "known",
        "attack_cards",
        "defense_cards",
        "attacker",
        "defender",
        "throwers",
        "thrower_idx",
        "phase",
        "bout_limit",
        "first_bout",
        "done",
        "loser",
        "finished",
        "log",
        "bout_index",
    )

    def __init__(
        self,
        seed: int | None = None,
        num_players: int = 2,
        config: Config = DEFAULT_CONFIG,
        deal: bool = True,
    ):
        if not MIN_PLAYERS <= num_players <= MAX_PLAYERS:
            raise ValueError(f"num_players must be in [{MIN_PLAYERS}, {MAX_PLAYERS}]")
        self.config = config
        self.num_players = num_players
        if deal:
            self._deal(random.Random(seed))

    # ------------------------------------------------------------------ setup
    def _deal(self, rng: random.Random) -> None:
        n_p, hs = self.num_players, self.config.hand_size
        deck = list(range(NUM_CARDS))
        rng.shuffle(deck)
        self.hands = [list_to_mask(deck[p * hs : (p + 1) * hs]) for p in range(n_p)]
        self.known = [0] * n_p  # publicly known cards in each player's hand
        # Talon is drawn from the END; talon[0] is the face-up trump card.
        self.talon = deck[n_p * hs :]
        if self.talon:
            self.trump_card = self.talon[0]
        else:
            # 6 players: the last dealt card is shown to everyone and sets trump.
            self.trump_card = deck[-1]
            self.known[n_p - 1] |= 1 << self.trump_card
        self.trump = suit_of(self.trump_card)
        self.discard = 0
        self.attack_cards: list[int] = []
        self.defense_cards: list[int] = []
        self.done = False
        self.loser: int | None = None  # the durak; None while running or on a draw
        self.finished: list[int] = []  # players in the order they went out
        self.log: list[tuple[int, int]] = []  # (player, action)
        self.bout_index = 0
        self.first_bout = True

        # First attacker: holder of the lowest trump; random if nobody has one.
        tmask = SUIT_MASKS[self.trump]
        best, best_bit = None, 99
        for p in range(n_p):
            t = self.hands[p] & tmask
            if t and (t & -t).bit_length() < best_bit:
                best, best_bit = p, (t & -t).bit_length()
        self.attacker = best if best is not None else rng.randrange(n_p)
        self._start_bout()

    def _start_bout(self) -> None:
        self.defender = self._next_active(self.attacker)
        other = self._next_active(self.defender)
        self.throwers = [self.attacker] if other == self.attacker else [self.attacker, other]
        self.thrower_idx = 0
        cap = self.config.first_bout_limit if self.first_bout else self.config.max_bout_cards
        self.bout_limit = min(cap, self.hands[self.defender].bit_count())
        self.attack_cards = []
        self.defense_cards = []
        self.phase = ATTACK

    # ------------------------------------------------------------ properties
    def is_active(self, p: int) -> bool:
        """Still in the game (has cards, or could still draw from the talon)."""
        return p not in self.finished

    @property
    def active_players(self) -> list[int]:
        return [p for p in range(self.num_players) if p not in self.finished]

    def _next_active(self, p: int) -> int:
        n = self.num_players
        for k in range(1, n + 1):
            q = (p + k) % n
            if q not in self.finished:
                return q
        raise RuntimeError("no active players")

    @property
    def current_player(self) -> int:
        return self.defender if self.phase == DEFEND else self.throwers[self.thrower_idx]

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
        hand = self.hands[self.current_player]
        if not self.attack_cards:
            return hand  # main attacker must lead a card
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
            if action == PASS:
                self.thrower_idx += 1
                if self.thrower_idx == len(self.throwers):  # everyone passed: bita
                    self.discard |= self.table_mask
                    self._end_bout(defended=True)
            else:
                self._remove(player, action)
                self.attack_cards.append(action)
                self.phase = DEFEND
        elif self.phase == DEFEND:
            if action == PASS:  # take; throwers may now add cards
                self.phase = THROW_IN
                self.thrower_idx = 0
            else:
                self._remove(player, action)
                self.defense_cards.append(action)
                self.phase = ATTACK
                self.thrower_idx = 0  # priority restarts with the main attacker
        else:  # THROW_IN
            if action == PASS:
                self.thrower_idx += 1
                if self.thrower_idx == len(self.throwers):
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
        self.attack_cards = []
        self.defense_cards = []
        # Draw: main attacker, then the other players clockwise, defender last.
        hs = self.config.hand_size
        order = [self.attacker]
        p = self._next_active(self.attacker)
        while p != self.attacker:
            if p != self.defender:
                order.append(p)
            p = self._next_active(p)
        order.append(self.defender)
        for p in order:
            need = hs - self.hands[p].bit_count()
            while need > 0 and self.talon:
                self.hands[p] |= 1 << self.talon.pop()
                need -= 1
        self.bout_index += 1
        self.first_bout = False

        # Players with no cards and nothing left to draw are out.
        if not self.talon:
            for p in order:
                if self.hands[p] == 0 and p not in self.finished:
                    self.finished.append(p)
        active = self.active_players
        if len(active) <= 1:
            self.done = True
            self.loser = active[0] if active else None
            return

        # Next attacker: the defender after a successful defence, otherwise the
        # player after the defender (skipping players who went out).
        if defended and self.defender not in self.finished:
            self.attacker = self.defender
        else:
            self.attacker = self._next_active(self.defender)
        self._start_bout()

    # ------------------------------------------------------------ utilities
    @property
    def winner(self) -> int | None:
        """2-player convenience: the non-loser (None while running / draw)."""
        if not self.done or self.loser is None or self.num_players != 2:
            return None
        return 1 - self.loser

    def returns(self) -> tuple[float, ...]:
        """Terminal payoff (zero-sum): the durak gets -1, everyone else
        +1/(n-1). All zeros on a draw or while running."""
        n = self.num_players
        if not self.done or self.loser is None:
            return (0.0,) * n
        win = 1.0 / (n - 1)
        return tuple(-1.0 if p == self.loser else win for p in range(n))

    def clone(self) -> "DurakGame":
        g = DurakGame.__new__(DurakGame)
        g.config = self.config
        g.num_players = self.num_players
        g.hands = self.hands[:]
        g.talon = self.talon[:]
        g.trump_card = self.trump_card
        g.trump = self.trump
        g.discard = self.discard
        g.known = self.known[:]
        g.attack_cards = self.attack_cards[:]
        g.defense_cards = self.defense_cards[:]
        g.attacker = self.attacker
        g.defender = self.defender
        g.throwers = self.throwers[:]
        g.thrower_idx = self.thrower_idx
        g.phase = self.phase
        g.bout_limit = self.bout_limit
        g.first_bout = self.first_bout
        g.done = self.done
        g.loser = self.loser
        g.finished = self.finished[:]
        g.log = self.log[:]
        g.bout_index = self.bout_index
        return g

    def unseen_mask(self, player: int) -> int:
        """Cards whose location is unknown to ``player``: hidden in an
        opponent's hand or in the talon (excluding the face-up trump card)."""
        seen = self.hands[player] | self.discard | self.table_mask
        for q in range(self.num_players):
            if q != player:
                seen |= self.known[q]
        if self.talon:
            seen |= 1 << self.trump_card
        return FULL_MASK & ~seen

    def determinize(self, player: int, rng: random.Random) -> "DurakGame":
        """Return a clone where all hidden information (from ``player``'s point
        of view) is resampled uniformly consistent with what ``player`` knows.
        With the talon empty and only two players left this is exact."""
        g = self.clone()
        pool = mask_to_list(self.unseen_mask(player))
        rng.shuffle(pool)
        i = 0
        for q in range(self.num_players):
            if q == player:
                continue
            k = self.hands[q].bit_count() - self.known[q].bit_count()
            g.hands[q] = self.known[q] | list_to_mask(pool[i : i + k])
            i += k
        rest = pool[i:]
        g.talon = ([self.trump_card] + rest) if self.talon else []
        assert len(g.talon) == len(self.talon)
        return g

    def info_state(self, player: int) -> dict:
        """Everything ``player`` is allowed to know. Basis for observations."""
        return {
            "player": player,
            "num_players": self.num_players,
            "hand": mask_to_list(self.hands[player]),
            "hand_sizes": [h.bit_count() for h in self.hands],
            "known": [mask_to_list(k) if q != player else [] for q, k in enumerate(self.known)],
            "attack_cards": list(self.attack_cards),
            "defense_cards": list(self.defense_cards),
            "discard": mask_to_list(self.discard),
            "trump_card": self.trump_card,
            "trump": self.trump,
            "talon_size": len(self.talon),
            "attacker": self.attacker,
            "defender": self.defender,
            "throwers": list(self.throwers),
            "phase": self.phase,
            "bout_limit": self.bout_limit,
            "first_bout": self.first_bout,
            "finished": list(self.finished),
            "to_move": self.current_player if not self.done else None,
            "legal": self.legal_actions() if not self.done and self.current_player == player else [],
            "done": self.done,
            "loser": self.loser,
        }

    def __repr__(self) -> str:
        def fmt(m):
            return " ".join(card_str(c) for c in mask_to_list(m))

        table = " ".join(
            card_str(a) + ("/" + card_str(self.defense_cards[i]) if i < len(self.defense_cards) else "")
            for i, a in enumerate(self.attack_cards)
        )
        hands = "\n".join(f"  P{p}{'*' if p in self.finished else ''}: {fmt(h)}" for p, h in enumerate(self.hands))
        return (
            f"<Durak n={self.num_players} trump={card_str(self.trump_card)} talon={len(self.talon)} "
            f"att=P{self.attacker} def=P{self.defender} phase={PHASE_NAMES[self.phase]} "
            f"limit={self.bout_limit}\n{hands}\n  table: {table}  done={self.done} loser={self.loser}>"
        )


def action_str(action: int) -> str:
    return "PASS" if action == PASS else card_str(action)
