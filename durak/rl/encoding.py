"""Observation encoding for the RL policy.

Everything here uses only information available to the acting player:
their own hand, public fields of the game, ``game.known`` and the public
action log. Hidden opponent hands / talon order are never read.

Layout of an observation (float32 vector of length ``OBS_DIM``):

* ``NUM_PLANES`` card planes of 36 entries each, in *canonical suit space*
  (see below), then ``NUM_SCALARS`` scalar features.

Suit canonicalisation: the trump suit is always canonical suit 0. The three
non-trump suits are sorted by a key made from all card planes restricted to
that suit (descending), so suits that are indistinguishable in the
observation are interchangeable; ties therefore don't matter. Canonical card
``c' = canon[suit(c)] * 9 + rank(c)``; :func:`to_real_action` inverts it.

Seats are relative to the acting player: slot 0 is self, slots 1..5 are the
opponents clockwise (seat ``(player + k) % N``), padded with "absent".

The :class:`PublicTracker` replays the public action log (it needs only the
number of players, the trump suit and the first attacker) to derive cheap
belief signals per seat:

* ``cant_beat``: cards a player is believed not to hold because they took
  instead of beating (beaters of the uncovered card at the take), cleared
  when that player draws from the talon.
* ``no_throw``: cards of table ranks a thrower declined to throw in while the
  defender was taking (with capacity left); cleared on drawing.
* number of takes so far and whether the player took in the last bout.
"""

from __future__ import annotations

import numpy as np

from ..cards import FULL_MASK, NUM_CARDS, NUM_RANKS, RANK_MASKS, beaters_mask, rank_of
from ..engine import ATTACK, DEFEND, PASS, THROW_IN, DurakGame

MAX_PLAYERS = 6
MAX_OPP = MAX_PLAYERS - 1
SUIT_BITS = (1 << NUM_RANKS) - 1

# --------------------------------------------------------------------- planes
P_HAND = 0
P_OPP_KNOWN = 1  # 5 planes, rel seats 1..5
P_DISCARD = 6
P_UNCOVERED = 7
P_COVERED = 8
P_DEFENSE = 9
P_UNSEEN = 10
P_TRUMP_FACEUP = 11
P_MY_KNOWN = 12  # my cards the opponents know about
P_CANT_BEAT = 13  # 5 planes
P_NO_THROW = 18  # 5 planes
NUM_PLANES = 23

# -------------------------------------------------------------------- scalars
SEAT_FEATS = 9  # present, active, hand/6, attacker, defender, cothrower, takes, took_last, to_draw_rank
NUM_SCALARS_V1 = MAX_PLAYERS * SEAT_FEATS + 3 + 4 + 4 + 5 + 5 + 5 + 3
NUM_SCALARS = NUM_SCALARS_V1 + 1 + 5 + 1  # + stall, unknown counts (5 opp seats, talon)
OBS_DIM_V1 = NUM_PLANES * NUM_CARDS + NUM_SCALARS_V1  # 911 (models before round 2)
OBS_DIM = NUM_PLANES * NUM_CARDS + NUM_SCALARS
# column of the first "unknown count" scalar (5 opp seats then talon) -> belief feasibility
UNKNOWN_COL = OBS_DIM_V1 + 1
NUM_LOCS = 6  # belief classes: opponent rel seat 1..5, talon
NUM_ACTIONS = NUM_CARDS + 1


class PublicTracker:
    """Replays the public log with card *counts* only (no hidden info)."""

    __slots__ = (
        "n", "trump", "counts", "talon", "finished", "attacker", "defender", "throwers",
        "thrower_idx", "phase", "attack", "defense", "first_bout", "bout_limit", "done",
        "cant_beat", "no_throw", "takes", "took_last", "n_events",
    )

    def __init__(self, num_players: int, trump: int, first_attacker: int):
        n = num_players
        self.n = n
        self.trump = trump
        self.counts = [6] * n
        self.talon = 36 - 6 * n
        self.finished: list[int] = []
        self.attacker = first_attacker
        self.first_bout = True
        self.done = False
        self.cant_beat = [0] * n
        self.no_throw = [0] * n
        self.takes = [0] * n
        self.took_last = [False] * n
        self.n_events = 0
        self._start_bout()

    @classmethod
    def from_game(cls, game: DurakGame) -> "PublicTracker":
        """Build a tracker by replaying ``game.log`` (public information)."""
        first = game.log[0][0] if game.log else game.attacker
        t = cls(game.num_players, game.trump, first)
        t.sync(game)
        return t

    def sync(self, game: DurakGame) -> None:
        """Consume any new entries of ``game.log``."""
        log = game.log
        while self.n_events < len(log):
            p, a = log[self.n_events]
            self.event(p, a)

    # -- replay -------------------------------------------------------------
    def _next_active(self, p: int) -> int:
        n = self.n
        for k in range(1, n + 1):
            q = (p + k) % n
            if q not in self.finished:
                return q
        raise RuntimeError("no active players")

    def _start_bout(self) -> None:
        self.defender = self._next_active(self.attacker)
        other = self._next_active(self.defender)
        self.throwers = [self.attacker] if other == self.attacker else [self.attacker, other]
        self.thrower_idx = 0
        cap = 5 if self.first_bout else 6
        self.bout_limit = min(cap, self.counts[self.defender])
        self.attack: list[int] = []
        self.defense: list[int] = []
        self.phase = ATTACK

    def event(self, p: int, a: int) -> None:
        self.n_events += 1
        ph = self.phase
        if ph == ATTACK:
            if a == PASS:
                self.thrower_idx += 1
                if self.thrower_idx == len(self.throwers):
                    self._end_bout(True)
            else:
                self.counts[p] -= 1
                self.attack.append(a)
                self.phase = DEFEND
        elif ph == DEFEND:
            if a == PASS:
                self.cant_beat[p] |= beaters_mask(self.attack[-1], self.trump)
                self.phase = THROW_IN
                self.thrower_idx = 0
            else:
                self.counts[p] -= 1
                self.defense.append(a)
                self.phase = ATTACK
                self.thrower_idx = 0
        else:
            if a == PASS:
                if len(self.attack) < self.bout_limit:
                    m = 0
                    for c in self.attack:
                        m |= RANK_MASKS[rank_of(c)]
                    for c in self.defense:
                        m |= RANK_MASKS[rank_of(c)]
                    self.no_throw[p] |= m
                self.thrower_idx += 1
                if self.thrower_idx == len(self.throwers):
                    d = self.defender
                    self.counts[d] += len(self.attack) + len(self.defense)
                    self.takes[d] += 1
                    self._end_bout(False)
            else:
                self.counts[p] -= 1
                self.attack.append(a)

    def _end_bout(self, defended: bool) -> None:
        order = [self.attacker]
        p = self._next_active(self.attacker)
        while p != self.attacker:
            if p != self.defender:
                order.append(p)
            p = self._next_active(p)
        order.append(self.defender)
        for p in order:
            need = 6 - self.counts[p]
            if need > 0 and self.talon > 0:
                k = min(need, self.talon)
                self.counts[p] += k
                self.talon -= k
                self.cant_beat[p] = 0
                self.no_throw[p] = 0
        for q in range(self.n):
            self.took_last[q] = False
        if not defended:
            self.took_last[self.defender] = True
        self.first_bout = False
        if self.talon == 0:
            for p in order:
                if self.counts[p] == 0 and p not in self.finished:
                    self.finished.append(p)
        active = [q for q in range(self.n) if q not in self.finished]
        if len(active) <= 1:
            self.done = True
            return
        if defended and self.defender not in self.finished:
            self.attacker = self.defender
        else:
            self.attacker = self._next_active(self.defender)
        self._start_bout()


# --------------------------------------------------------------- suit canon
def _suit_chunks(mask: int) -> tuple[int, int, int, int]:
    return (mask & SUIT_BITS, (mask >> 9) & SUIT_BITS, (mask >> 18) & SUIT_BITS, (mask >> 27) & SUIT_BITS)


def canon_perm(planes: list[int], trump: int) -> list[int]:
    """Return ``canon[s]`` = canonical index of real suit ``s`` (trump -> 0)."""
    others = [s for s in range(4) if s != trump]
    keys = {s: tuple((m >> (9 * s)) & SUIT_BITS for m in planes) for s in others}
    others.sort(key=lambda s: keys[s], reverse=True)
    canon = [0] * 4
    for i, s in enumerate(others):
        canon[s] = i + 1
    return canon


def remap_mask(mask: int, canon: list[int]) -> int:
    out = 0
    for s in range(4):
        out |= ((mask >> (9 * s)) & SUIT_BITS) << (9 * canon[s])
    return out


def inverse_perm(canon: list[int]) -> list[int]:
    inv = [0] * 4
    for s, c in enumerate(canon):
        inv[c] = s
    return inv


def to_real_action(a: int, canon: list[int]) -> int:
    if a >= NUM_CARDS:
        return a
    inv = inverse_perm(canon)
    return inv[a // 9] * 9 + a % 9


def to_canon_action(a: int, canon: list[int]) -> int:
    if a >= NUM_CARDS:
        return a
    return canon[a // 9] * 9 + a % 9


# ------------------------------------------------------------------ encoding
def encode_parts(game: DurakGame, player: int, tracker: PublicTracker):
    """Return (canonical plane masks, scalar list, canonical legal mask, canon).

    ``tracker`` must be in sync with ``game.log``.
    """
    n = game.num_players
    hand = game.hands[player]
    known = game.known
    atk = game.attack_cards
    dfn = game.defense_cards
    unseen = game.unseen_mask(player)

    planes = [0] * NUM_PLANES
    planes[P_HAND] = hand
    for k in range(1, n):
        q = (player + k) % n
        planes[P_OPP_KNOWN + k - 1] = known[q]
        planes[P_CANT_BEAT + k - 1] = tracker.cant_beat[q] & unseen
        planes[P_NO_THROW + k - 1] = tracker.no_throw[q] & unseen
    planes[P_DISCARD] = game.discard
    nd = len(dfn)
    unc = 0
    for c in atk[nd:]:  # 1 card when defending; several during throw-in
        unc |= 1 << c
    planes[P_UNCOVERED] = unc
    cov = 0
    for c in atk[:nd]:
        cov |= 1 << c
    planes[P_COVERED] = cov
    dm = 0
    for c in dfn:
        dm |= 1 << c
    planes[P_DEFENSE] = dm
    planes[P_UNSEEN] = unseen
    talon_n = len(game.talon)
    if talon_n:
        planes[P_TRUMP_FACEUP] = 1 << game.trump_card
    planes[P_MY_KNOWN] = known[player]

    canon = canon_perm(planes, game.trump)
    cplanes = [remap_mask(m, canon) if m else 0 for m in planes]

    # ---- scalars
    sc: list[float] = []
    finished = game.finished
    attacker, defender, throwers = game.attacker, game.defender, game.throwers
    for k in range(MAX_PLAYERS):
        if k < n:
            q = (player + k) % n
            act = q not in finished
            sc += [
                1.0,
                1.0 if act else 0.0,
                game.hands[q].bit_count() / 6.0,
                1.0 if q == attacker else 0.0,
                1.0 if q == defender else 0.0,
                1.0 if (q in throwers and q != attacker) else 0.0,
                min(tracker.takes[q], 8) / 4.0,
                1.0 if tracker.took_last[q] else 0.0,
                (finished.index(q) + 1) / 5.0 if not act else 0.0,
            ]
        else:
            sc += [0.0] * SEAT_FEATS
    ph = game.phase
    sc += [1.0 if ph == ATTACK else 0.0, 1.0 if ph == DEFEND else 0.0, 1.0 if ph == THROW_IN else 0.0]
    if player == attacker:
        role = 0
    elif player == defender:
        role = 2
    elif player in throwers:
        role = 1
    else:
        role = 3
    r4 = [0.0] * 4
    r4[role] = 1.0
    sc += r4
    sc += [talon_n / 24.0, 1.0 if talon_n == 0 else 0.0, 1.0 if game.first_bout else 0.0, 1.0 if not atk else 0.0]
    na = len(atk)
    sc += [
        game.bout_limit / 6.0,
        na / 6.0,
        max(game.bout_limit - na, 0) / 6.0,
        nd / 6.0,
        (na - nd) / 6.0,
    ]
    n1 = [0.0] * 5
    n1[n - 2] = 1.0
    sc += n1
    n_act = n - len(finished)
    a1 = [0.0] * 5
    a1[max(min(n_act, 6), 2) - 2] = 1.0
    sc += a1
    sc += [unseen.bit_count() / 36.0, len(finished) / 5.0, game.thrower_idx / 2.0]
    # v2 scalars (appended so v1 models can use the obs prefix): stall counter and
    # the number of *unknown* cards per location (belief-head feasibility).
    sc.append(getattr(game, "stall", 0) / 30.0)
    for k in range(1, MAX_PLAYERS):
        if k < n:
            q = (player + k) % n
            sc.append((game.hands[q].bit_count() - known[q].bit_count()) / 6.0)
        else:
            sc.append(0.0)
    sc.append(max(talon_n - 1, 0) / 24.0)

    # legal moves only for the player to move (never read another hand)
    legal = game.legal_mask_int() if (not game.done and game.current_player == player) else 0
    clegal = remap_mask(legal & FULL_MASK, canon) | (legal & (1 << PASS))
    return cplanes, sc, clegal, canon


def belief_targets(game: DurakGame, player: int, canon: list[int]) -> list[int]:
    """Ground truth for the belief head (training only; reads hidden hands):
    6 canonical masks = unseen cards held by opponent rel seat 1..5, and in the talon."""
    n = game.num_players
    unseen = game.unseen_mask(player)
    out = [0] * NUM_LOCS
    rest = unseen
    for k in range(1, n):
        m = game.hands[(player + k) % n] & unseen
        if m:
            out[k - 1] = remap_mask(m, canon)
            rest &= ~m
    if rest:
        out[5] = remap_mask(rest, canon)
    return out


_SHIFTS = np.arange(NUM_ACTIONS, dtype=np.uint64)


def masks_to_bits(masks: np.ndarray, width: int) -> np.ndarray:
    """uint64 array (...,) -> float32 (..., width) of bits."""
    return ((masks[..., None] >> _SHIFTS[:width]) & np.uint64(1)).astype(np.float32)


def build_batch(parts: list) -> tuple[np.ndarray, np.ndarray]:
    """Stack ``encode_parts`` outputs into (obs float32 [B, OBS_DIM], mask bool [B, 37])."""
    b = len(parts)
    planes = np.array([p[0] for p in parts], dtype=np.uint64)  # [B, NUM_PLANES]
    obs = np.empty((b, OBS_DIM), dtype=np.float32)
    obs[:, : NUM_PLANES * NUM_CARDS] = masks_to_bits(planes, NUM_CARDS).reshape(b, -1)
    obs[:, NUM_PLANES * NUM_CARDS :] = np.array([p[1] for p in parts], dtype=np.float32)
    legal = np.array([p[2] for p in parts], dtype=np.uint64)
    mask = masks_to_bits(legal, NUM_ACTIONS).astype(bool)
    return obs, mask


def encode(game: DurakGame, player: int, tracker: PublicTracker | None = None):
    """Single observation: (obs [OBS_DIM], mask [37], canon)."""
    if tracker is None:
        tracker = PublicTracker.from_game(game)
    else:
        tracker.sync(game)
    parts = encode_parts(game, player, tracker)
    obs, mask = build_batch([parts])
    return obs[0], mask[0], parts[3]
