"""Exact endgame solver for Durak positions with perfect information.

Once the talon is empty and exactly two players are still active (true at the
end of every game, whatever ``num_players`` is), nothing is hidden: each player
knows their own hand, and the opponent's hand is every card that is not in the
discard, on the table or in their own hand. With two players and a talon of a
single card (the face-up trump card), the position is also perfect information.
The order in which the last card is drawn is deterministic, so this module
solves those positions as well.

The search is a two-player alpha-beta over the actual move sequence. Each
bout's moves (attacks, beats, adds, take, throw-ins) form one game tree, and the
transposition table works across bouts. Values are in {-1, 0, +1}:
+1 means the *other* player ends up the durak, 0 is a draw, -1 means we lose.

Internally a state is always seen from the current bout's **attacker** ("a")
against the **defender** ("d"). With two players, the roles swap after a
successful defence and stay the same after a take. Seats therefore drop out,
and the transposition table is keyed on
``(a_hand, d_hand, table, uncovered_card, limit, trump_in_talon)``.

Public API::

    solve(game, player, time_limit=1.0, node_limit=None) -> (value, action) | None
    applicable(game) -> bool
    EndgameSolver(trump_card).solve_game(game, player, ...)
"""

from __future__ import annotations

import ctypes
import hashlib
import os
import subprocess
import tempfile
import time

from .cards import NUM_CARDS, RANK_MASKS, SUIT_MASKS, beaters_mask, rank_of, suit_of
from .engine import ATTACK, DEFEND, PASS, THROW_IN, DurakGame

WIN, DRAW, LOSS = 1, 0, -1
_INF = 1  # values lie in [-1, 1]; a full window is (-1, 1)


class SearchAborted(Exception):
    pass


# ----------------------------------------------------------- native core
_ABORT = -100
_NATIVE = None
_NATIVE_TRIED = False
_U64 = ctypes.c_uint64
_INT = ctypes.c_int


def _load_native():
    """Compile (once, cached by source hash) and load ``_solver.c``. Returns
    the ctypes library or None (pure-Python fallback). Disable with
    DURAK_SOLVER_NATIVE=0."""
    global _NATIVE, _NATIVE_TRIED
    if _NATIVE_TRIED:
        return _NATIVE
    _NATIVE_TRIED = True
    if os.environ.get("DURAK_SOLVER_NATIVE", "1") == "0":
        return None
    try:
        src = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_solver.c")
        code = open(src, "rb").read()
        h = hashlib.sha1(code).hexdigest()[:12]
        cache = os.environ.get("DURAK_CACHE") or os.path.join(os.path.expanduser("~"), ".cache", "durakbot")
        os.makedirs(cache, exist_ok=True)
        so = os.path.join(cache, f"_solver_{h}.so")
        if not os.path.exists(so):
            fd, tmp = tempfile.mkstemp(suffix=".so", dir=cache)
            os.close(fd)
            subprocess.run(["gcc", "-O2", "-shared", "-fPIC", "-o", tmp, src], check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)
            os.replace(tmp, so)  # atomic: safe with parallel workers
        lib = ctypes.CDLL(so)
        lib.dk_init.argtypes = [_INT]
        lib.dk_set_trump.argtypes = [_INT]
        lib.dk_set_budget.argtypes = [ctypes.c_longlong, ctypes.c_double]
        lib.dk_nodes.restype = ctypes.c_longlong
        lib.dk_set_option.argtypes = [_INT, _INT]
        lib.dk_attack.argtypes = [_U64, _U64, _U64, _INT, _INT, _INT, _INT, _INT]
        lib.dk_defend.argtypes = [_U64, _U64, _U64, _INT, _INT, _INT, _INT, _INT, _INT]
        lib.dk_take.argtypes = [_U64, _U64, _U64, _INT, _INT, _INT, _INT, _INT]
        lib.dk_end_bout.argtypes = [_U64, _U64, _INT, _INT, _INT, _INT]
        if lib.dk_init(int(os.environ.get("DURAK_SOLVER_TT_LOG2", "21"))) != 0:
            return None
        _NATIVE = lib
    except Exception:  # no compiler etc.: pure-Python fallback
        _NATIVE = None
    return _NATIVE


def native_available() -> bool:
    return _load_native() is not None


def _bits(m: int) -> list[int]:
    out = []
    while m:
        low = m & -m
        out.append(low.bit_length() - 1)
        m ^= low
    return out


def _popcount(m: int) -> int:
    return m.bit_count()


def applicable(game: DurakGame) -> bool:
    """True when the position is perfect information and two-player: the talon
    is empty and exactly two players are active, or two players play with only
    the face-up trump card left in the talon."""
    if game.done:
        return False
    active = game.active_players
    if len(active) != 2:
        return False
    if not game.talon:
        return True
    return len(game.talon) == 1 and game.num_players == 2


class EndgameSolver:
    """Alpha-beta solver bound to one trump card (one game). Reuse it across
    moves of the same game: the transposition table carries over."""

    def __init__(self, trump_card: int, max_tt: int = 3_000_000):
        self.trump_card = trump_card
        self.trump = suit_of(trump_card)
        self.tc_bit = 1 << trump_card
        self.beaters = [beaters_mask(c, self.trump) for c in range(NUM_CARDS)]
        self.rankmask = [RANK_MASKS[rank_of(c)] for c in range(NUM_CARDS)]
        tmask = SUIT_MASKS[self.trump]
        self.tmask = tmask
        # Static card ordering value: non-trumps by rank, trumps above all.
        self.order_val = [rank_of(c) + (20 if suit_of(c) == self.trump else 0) for c in range(NUM_CARDS)]
        self.tt: dict = {}
        self.max_tt = max_tt
        self.nodes = 0
        self._deadline = None
        self._node_limit = None

    # -------------------------------------------------------------- helpers
    def _check(self):
        self.nodes += 1
        if self._node_limit is not None and self.nodes > self._node_limit:
            raise SearchAborted
        if self.nodes & 1023 == 0 and self._deadline is not None and time.perf_counter() > self._deadline:
            raise SearchAborted

    def _sorted_cards(self, m: int) -> list[int]:
        cs = _bits(m)
        cs.sort(key=self.order_val.__getitem__)
        return cs

    def _store(self, key, v, alpha, beta, move, old):
        # Values lie in [-1, 1]; (lo, hi) are proven bounds.
        if old is None:
            lo, hi = LOSS, WIN
        else:
            lo, hi = old[0], old[1]
        if v <= alpha:
            if v < hi:
                hi = v
        elif v >= beta:
            if v > lo:
                lo = v
        else:
            lo = hi = v
        self.tt[key] = (lo, hi, move)

    # ------------------------------------------------------------- end bout
    def _end_bout(self, a: int, d: int, defended: bool, flag: int, alpha: int, beta: int) -> int:
        """Value (attacker frame) after the bout ends. ``a`` and ``d`` are the
        hands after the table has been discarded or picked up."""
        if flag:
            if _popcount(a) < 6:
                a |= self.tc_bit
                flag = 0
            elif _popcount(d) < 6:
                d |= self.tc_bit
                flag = 0
        if not flag:
            if not a:
                return DRAW if not d else WIN
            if not d:
                return LOSS
        if defended:
            return -self._attack(d, a, 0, 0, min(6, _popcount(a)), flag, -beta, -alpha)
        return self._attack(a, d, 0, 0, min(6, _popcount(d)), flag, alpha, beta)

    # ---------------------------------------------------------- attack node
    def _attack(self, a: int, d: int, tab: int, n: int, limit: int, flag: int, alpha: int, beta: int) -> int:
        """Attacker to move; table holds ``n`` attack cards, all covered. Max node."""
        if n == 0 and not flag:
            # Quick exact rule: the attacker can lead their whole hand (one rank,
            # within the limit) and the defender cannot run out at the same time.
            low = a & -a
            r = self.rankmask[low.bit_length() - 1]
            na = _popcount(a)
            if not (a & ~r) and na <= limit:
                if _popcount(d) > na:
                    return WIN
                if na == 1:
                    return DRAW if (d & self.beaters[low.bit_length() - 1]) else WIN
        self._check()
        key = (a, d, tab, -1, limit, flag)
        e = self.tt.get(key)
        tmove = None
        if e is not None:
            lo, hi, tmove = e
            if lo == hi or lo >= beta:
                return lo
            if hi <= alpha:
                return hi
            if lo > alpha:
                alpha = lo
            if hi < beta:
                beta = hi
        a0 = alpha
        if n == 0:
            cands = a
        elif n < limit:
            ranks = 0
            t = tab
            while t:
                low = t & -t
                ranks |= self.rankmask[low.bit_length() - 1]
                t ^= low
            cands = a & ranks
        else:
            cands = 0
        beaters = self.beaters
        moves = self._sorted_cards(cands)
        # Cards the defender cannot beat first (stable: cheap first within groups).
        moves.sort(key=lambda c: 0 if (d & beaters[c]) == 0 else 1)
        if n > 0:
            moves.append(PASS)
        if tmove is not None and tmove in moves:
            moves.remove(tmove)
            moves.insert(0, tmove)
        best, bmove = LOSS - 1, None
        for c in moves:
            if c == PASS:
                v = self._end_bout(a, d, True, flag, alpha, beta)
            else:
                bit = 1 << c
                v = self._defend(a ^ bit, d, tab | bit, n + 1, c, limit, flag, alpha, beta)
            if v > best:
                best, bmove = v, c
                if v > alpha:
                    alpha = v
                    if alpha >= beta:
                        break
        if len(self.tt) < self.max_tt:
            self._store(key, best, a0, beta, bmove, e)
        return best

    # --------------------------------------------------------- defend node
    def _defend(self, a: int, d: int, tab: int, n: int, c: int, limit: int, flag: int, alpha: int, beta: int) -> int:
        """Defender to move vs uncovered attack card ``c``. Min node."""
        self._check()
        key = (a, d, tab, c, limit, flag)
        e = self.tt.get(key)
        tmove = None
        if e is not None:
            lo, hi, tmove = e
            if lo == hi or lo >= beta:
                return lo
            if hi <= alpha:
                return hi
            if lo > alpha:
                alpha = lo
            if hi < beta:
                beta = hi
        b0 = beta
        moves = self._sorted_cards(d & self.beaters[c])
        moves.append(PASS)
        if tmove is not None and tmove != moves[0]:
            moves.remove(tmove)
            moves.insert(0, tmove)
        best, bmove = WIN + 1, None
        for b in moves:
            if b == PASS:
                v = self._take(a, d, tab, n, limit, flag, alpha, beta)
            else:
                bit = 1 << b
                v = self._attack(a, d ^ bit, tab | bit, n, limit, flag, alpha, beta)
            if v < best:
                best, bmove = v, b
                if v < beta:
                    beta = v
                    if alpha >= beta:
                        break
        if len(self.tt) < self.max_tt:
            self._store(key, best, alpha, b0, bmove, e)
        return best

    # ----------------------------------------------------------- throw-in
    def _take(self, a: int, d: int, tab: int, n: int, limit: int, flag: int, alpha: int, beta: int) -> int:
        """Defender takes; the attacker throws in any subset of matching cards
        (within the limit), then the defender picks everything up. Max node."""
        ranks = 0
        t = tab
        while t:
            low = t & -t
            ranks |= self.rankmask[low.bit_length() - 1]
            t ^= low
        cm = a & ranks
        room = limit - n
        if not cm or room <= 0:
            return self._end_bout(a, d | tab, False, flag, alpha, beta)
        self._check()
        key = (a, d, tab, -2, limit, flag)
        e = self.tt.get(key)
        tmove = None
        if e is not None:
            lo, hi, tmove = e
            if lo == hi or lo >= beta:
                return lo
            if hi <= alpha:
                return hi
            if lo > alpha:
                alpha = lo
            if hi < beta:
                beta = hi
        a0 = alpha
        subs = self._subsets(self._sorted_cards(cm), room)
        if tmove is not None:
            subs.remove(tmove)
            subs.insert(0, tmove)
        best, bmove = LOSS - 1, None
        for s in subs:
            v = self._end_bout(a ^ s, d | tab | s, False, flag, alpha, beta)
            if v > best:
                best, bmove = v, s
                if v > alpha:
                    alpha = v
                    if alpha >= beta:
                        break
        if len(self.tt) < self.max_tt:
            self._store(key, best, a0, beta, bmove, e)
        return best

    @staticmethod
    def _subsets(cands: list[int], room: int):
        """Subsets of ``cands`` with size <= room, as masks. Cheapest-first
        order: the full cheap prefix, then the empty set, then the rest."""
        k = len(cands)
        out = []
        # all subsets by bit enumeration (k is small in practice)
        if k <= 12:
            for sub in range(1 << k):
                if sub.bit_count() <= room:
                    m = 0
                    i = 0
                    s = sub
                    while s:
                        if s & 1:
                            m |= 1 << cands[i]
                        s >>= 1
                        i += 1
                    out.append(m)
        else:  # pragma: no cover - extremely rare; restrict to prefixes
            for j in range(min(k, room) + 1):
                m = 0
                for c in cands[:j]:
                    m |= 1 << c
                out.append(m)
        # Order: largest cheap throws first, then nothing, then others.
        out.sort(key=lambda m: -m.bit_count())
        return out

    # ------------------------------------------------------------ root API
    def _set_budget(self, time_limit, node_limit):
        self.nodes = 0
        self._deadline = None if time_limit is None else time.perf_counter() + time_limit
        self._node_limit = node_limit
        if len(self.tt) >= self.max_tt:
            self.tt.clear()

    def action_values(self, game: DurakGame, player: int, time_limit: float | None = 1.0,
                      node_limit: int | None = None) -> dict[int, int] | None:
        """Exact value (for ``player``) of every legal action of the player to
        move. None if out of budget."""
        self._set_budget(time_limit, node_limit)
        try:
            return self._root_values(game, player)
        except SearchAborted:
            return None

    def solve_game(self, game: DurakGame, player: int, time_limit: float | None = 1.0,
                   node_limit: int | None = None):
        """(value for ``player``, best action for the player to move) or None."""
        self._set_budget(time_limit, node_limit)
        try:
            return self._root_best(game, player)
        except SearchAborted:
            return None

    def _root_state(self, game: DurakGame):
        att, dfd = game.attacker, game.defender
        a, d = game.hands[att], game.hands[dfd]
        tab = game.table_mask
        n = len(game.attack_cards)
        flag = 1 if game.talon else 0
        return att, dfd, a, d, tab, n, game.bout_limit, flag

    def _child_values(self, game: DurakGame, alpha_first: bool = False):
        """Yield (action, value-in-attacker-frame) for every legal action."""
        att, dfd, a, d, tab, n, limit, flag = self._root_state(game)
        out = []
        legal = game.legal_actions()
        if game.phase == ATTACK:
            for act in legal:
                if act == PASS:
                    v = self._end_bout(a, d, True, flag, -_INF, _INF)
                else:
                    bit = 1 << act
                    v = self._defend(a ^ bit, d, tab | bit, n + 1, act, limit, flag, -_INF, _INF)
                out.append((act, v))
        elif game.phase == DEFEND:
            c = game.attack_cards[-1]
            for act in legal:
                if act == PASS:
                    v = self._take(a, d, tab, n, limit, flag, -_INF, _INF)
                else:
                    bit = 1 << act
                    v = self._attack(a, d ^ bit, tab | bit, n, limit, flag, -_INF, _INF)
                out.append((act, v))
        else:  # THROW_IN: attacker keeps throwing; PASS = done
            for act in legal:
                if act == PASS:
                    v = self._end_bout(a, d | tab, False, flag, -_INF, _INF)
                else:
                    bit = 1 << act
                    v = self._take(a ^ bit, d, tab | bit, n + 1, limit, flag, -_INF, _INF)
                out.append((act, v))
        return att, out

    def _root_values(self, game: DurakGame, player: int) -> dict[int, int]:
        att, vals = self._child_values(game)
        sign = 1 if player == att else -1
        return {act: sign * v for act, v in vals}

    def _root_moves(self, game: DurakGame, d: int) -> list[int]:
        legal = game.legal_actions()
        cards = [x for x in legal if x != PASS]
        cards.sort(key=self.order_val.__getitem__)
        if game.phase == ATTACK:
            cards.sort(key=lambda c: 0 if (d & self.beaters[c]) == 0 else 1)
        return cards + ([PASS] if PASS in legal else [])

    def _root_best(self, game: DurakGame, player: int):
        """Null-window (MTD-style) root: first look for a winning move, then
        for a drawing one. With only three values, that needs at most two
        null-window passes over the root moves."""
        att, dfd, a, d, tab, n, limit, flag = self._root_state(game)
        maximizing = game.current_player == att  # attacker-frame maximiser
        moves = self._root_moves(game, d)
        sign = 1 if player == att else -1
        if maximizing:
            for target in (WIN, DRAW):  # is there a move with value >= target?
                for act in moves:
                    if self._child(game, act, a, d, tab, n, limit, flag, target - 1, target) >= target:
                        return sign * target, act
            return sign * LOSS, moves[0]
        for target in (LOSS, DRAW):  # is there a move with value <= target?
            for act in moves:
                if self._child(game, act, a, d, tab, n, limit, flag, target, target + 1) <= target:
                    return sign * target, act
        return sign * WIN, moves[0]

    def _child(self, game, act, a, d, tab, n, limit, flag, alpha, beta):
        if game.phase == ATTACK:
            if act == PASS:
                return self._end_bout(a, d, True, flag, alpha, beta)
            bit = 1 << act
            return self._defend(a ^ bit, d, tab | bit, n + 1, act, limit, flag, alpha, beta)
        if game.phase == DEFEND:
            if act == PASS:
                return self._take(a, d, tab, n, limit, flag, alpha, beta)
            bit = 1 << act
            return self._attack(a, d ^ bit, tab | bit, n, limit, flag, alpha, beta)
        if act == PASS:
            return self._end_bout(a, d | tab, False, flag, alpha, beta)
        bit = 1 << act
        return self._take(a ^ bit, d, tab | bit, n + 1, limit, flag, alpha, beta)


class NativeEndgameSolver(EndgameSolver):
    """Same search with the node functions in C (``_solver.c``). Typically
    50-100x faster. The transposition table is global in the C library and
    keyed by trump card, so instances can interleave."""

    def __init__(self, trump_card: int):
        super().__init__(trump_card, max_tt=0)
        self.lib = _load_native()

    def _set_budget(self, time_limit, node_limit):
        self.nodes = 0
        self.lib.dk_set_trump(self.trump_card)
        self.lib.dk_set_budget(-1 if node_limit is None else int(node_limit),
                               -1.0 if time_limit is None else float(time_limit))

    @staticmethod
    def _ok(v):
        if v == _ABORT:
            raise SearchAborted
        return v

    def _attack(self, a, d, tab, n, limit, flag, alpha, beta):
        return self._ok(self.lib.dk_attack(a, d, tab, n, limit, flag, alpha, beta))

    def _defend(self, a, d, tab, n, c, limit, flag, alpha, beta):
        return self._ok(self.lib.dk_defend(a, d, tab, n, c, limit, flag, alpha, beta))

    def _take(self, a, d, tab, n, limit, flag, alpha, beta):
        return self._ok(self.lib.dk_take(a, d, tab, n, limit, flag, alpha, beta))

    def _end_bout(self, a, d, defended, flag, alpha, beta):
        return self._ok(self.lib.dk_end_bout(a, d, 1 if defended else 0, flag, alpha, beta))

    def solve_game(self, *args, **kw):
        r = super().solve_game(*args, **kw)
        self.nodes = self.lib.dk_nodes()
        return r


# ------------------------------------------------------------- module API
_SOLVERS: dict[int, EndgameSolver] = {}


def get_solver(trump_card: int) -> EndgameSolver:
    s = _SOLVERS.get(trump_card)
    if s is None:
        if len(_SOLVERS) >= 4:
            _SOLVERS.clear()
        cls = NativeEndgameSolver if _load_native() is not None else EndgameSolver
        s = _SOLVERS[trump_card] = cls(trump_card)
    return s


def solve(game: DurakGame, player: int, time_limit: float | None = 1.0, node_limit: int | None = None):
    """Exact solve of a perfect-information endgame.

    Returns ``(value, best_action)``. ``value`` is for ``player``: +1 means
    the other active player will be the durak with best play, 0 a draw, and -1
    means ``player`` is the durak. ``best_action`` is the best action for the
    player to move (``game.current_player``). Returns None if the position is
    not perfect information (see :func:`applicable`), ``player`` is not
    active, or the time/node budget runs out. Safe to call on a determinized
    copy, because determinization is exact in these positions.
    """
    if not applicable(game) or player not in game.active_players:
        return None
    return get_solver(game.trump_card).solve_game(game, player, time_limit, node_limit)


def action_values(game: DurakGame, player: int, time_limit: float | None = 1.0, node_limit: int | None = None):
    """``{action: value for player}`` for every legal action, or None."""
    if not applicable(game) or player not in game.active_players:
        return None
    return get_solver(game.trump_card).action_values(game, player, time_limit, node_limit)


def brute_force(game: DurakGame, player: int, memo: dict | None = None) -> int:
    """Reference minimax through the real engine: no pruning, no solver code,
    only memoized on the full engine state. Exponential, so use it only for
    small positions in tests."""
    if game.done:
        if game.loser is None:
            return 0
        return -1 if game.loser == player else 1
    if memo is None:
        memo = {}
    key = (tuple(game.hands), tuple(game.attack_cards), tuple(game.defense_cards), game.phase,
           game.thrower_idx, game.attacker, game.defender, tuple(game.talon), tuple(game.finished),
           game.bout_limit)
    v = memo.get(key)
    if v is not None:
        return v
    mover = game.current_player
    vals = []
    for act in game.legal_actions():
        g = game.clone()
        g.step(act)
        vals.append(brute_force(g, player, memo))
    v = max(vals) if mover == player else min(vals)
    memo[key] = v
    return v
