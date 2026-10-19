"""Evaluation arena for N-player Durak. The main metric is the durak (loss) rate.

Setup ("1 vs field"): for each deal, agent A sits in seat s and N-1 copies of
B fill the other seats. A rotates through every seat over the same deal, so
each deal is played N times. With N=2 this gives paired deals with the seats
swapped. Agents only ever see ``game.determinize(player, rng)`` copies, never
the real game.

Library::

    from durak.arena import play_match
    res = play_match("heuristic", "random", num_players=4, n_games=2000, seed=0, workers=4)
    res["a_durak_rate"], res["a_durak_ci95"], res["baseline"], ...

``agent_a_factory`` / ``agent_b_factory`` can be a registered agent name or any
zero-argument callable that returns an :class:`~durak.agents.Agent`. Lambdas
work too: workers are forked, so nothing needs to be picklable.

CLI::

    python -m durak.arena heuristic random --players 4 --games 2000 --workers 4 --seed 0
"""

from __future__ import annotations

import argparse
import math
import multiprocessing as mp
import random
import time
from typing import Callable

from .agents import Agent, get_agent
from .engine import DurakGame

AgentFactory = Callable[[], Agent] | str


def _make(factory: AgentFactory) -> Agent:
    return get_agent(factory) if isinstance(factory, str) else factory()


MAX_STEPS = 20000  # safety net only; normal games take ~100-300 steps


class GameTimeout(RuntimeError):
    """The game exceeded ``max_steps``. Should not happen: the engine's stall
    rule (``Config.stall_bouts``) already ends endless take cycles with a draw.
    The arena would score such a game as a draw."""


def play_game(agents: list[Agent], deal_seed: int, num_players: int, rng: random.Random,
              max_steps: int = MAX_STEPS) -> DurakGame:
    """Play one game. ``agents[p]`` plays seat ``p``. Each agent gets a fresh
    determinization from its own point of view at every decision. Raises
    :class:`GameTimeout` after ``max_steps`` actions."""
    game = DurakGame(seed=deal_seed, num_players=num_players)
    for a in agents:
        a.reset()
    steps = 0
    while not game.done:
        p = game.current_player
        view = game.determinize(p, rng)
        action = agents[p].act(view, p)
        game.step(action)  # raises ValueError on an illegal action
        steps += 1
        if steps > max_steps:
            raise GameTimeout(f"game did not terminate within {max_steps} steps")
    return game


def _run_deals(args) -> list[tuple[int, int, int | None, int, bool]]:
    """Worker: play every deal in ``deal_ids`` with A rotated through all seats.
    Returns tuples ``(deal_id, a_seat, loser, steps, stalled)``."""
    fa, fb, num_players, base_seed, deal_ids = args
    agent_a = _make(fa)
    agents_b = [_make(fb) for _ in range(num_players - 1)]
    out = []
    for deal in deal_ids:
        deal_seed = base_seed * 1_000_003 + deal
        for seat in range(num_players):
            it = iter(agents_b)
            seats = [agent_a if p == seat else next(it) for p in range(num_players)]
            # Reproducibility: agents exposing a random.Random as ``.rng`` are
            # reseeded per game and seat.
            for p, ag in enumerate(seats):
                if isinstance(getattr(ag, "rng", None), random.Random):
                    ag.rng.seed(deal_seed * 131 + seat * 17 + p)
            rng = random.Random(deal_seed * 7 + seat)
            try:
                g = play_game(seats, deal_seed, num_players, rng)
                stalled = g.loser is None and g.stall >= g.config.stall_bouts
                out.append((deal, seat, g.loser, len(g.log), stalled))
            except GameTimeout:
                out.append((deal, seat, None, -1, False))  # scored as a draw
    return out


_FORK_ARGS = None


def _run_forked(i):
    fa, fb, n, seed, chunks = _FORK_ARGS
    return _run_deals((fa, fb, n, seed, chunks[i]))


def play_match(agent_a_factory: AgentFactory, agent_b_factory: AgentFactory, num_players: int = 2,
               n_games: int = 1000, seed: int = 0, workers: int = 1, verbose: bool = False) -> dict:
    """Play A vs a field of B. ``n_games`` is rounded up to a multiple of
    ``num_players`` (each deal is played once per seat for A).

    Returns a dict with:
      games, deals, num_players, baseline (=1/N),
      a_durak_rate, a_durak_ci95 (half-width, deal-clustered),
      b_durak_rate (per B player), draw_rate,
      a_score (A's mean zero-sum return), a_score_ci95,
      a_durak_rate_by_seat, games_per_sec, mean_steps,
      stall_rate (draws by the engine's stall rule), timeout_rate (games cut
      at MAX_STEPS and scored as draws; should be 0)
    """
    n = num_players
    deals = max(1, math.ceil(n_games / n))
    deal_ids = list(range(deals))
    t0 = time.perf_counter()
    if workers <= 1:
        results = _run_deals((agent_a_factory, agent_b_factory, n, seed, deal_ids))
    else:
        global _FORK_ARGS
        chunks = [deal_ids[i::workers * 4] for i in range(workers * 4)]
        chunks = [c for c in chunks if c]
        _FORK_ARGS = (agent_a_factory, agent_b_factory, n, seed, chunks)
        ctx = mp.get_context("fork")
        with ctx.Pool(workers) as pool:
            results = [r for part in pool.imap_unordered(_run_forked, range(len(chunks))) for r in part]
        _FORK_ARGS = None
    elapsed = time.perf_counter() - t0
    return summarize(results, n, elapsed)


def summarize(results, n: int, elapsed: float = 0.0) -> dict:
    games = len(results)
    per_deal_loss: dict[int, list[float]] = {}
    per_deal_score: dict[int, list[float]] = {}
    a_lost = b_lost = draws = 0
    seat_loss = [0] * n
    seat_games = [0] * n
    steps = 0
    timeouts = stalls = 0
    win = 1.0 / (n - 1)
    for rec in results:
        deal, seat, loser, st = rec[:4]
        stalls += bool(rec[4]) if len(rec) > 4 else 0
        if st < 0:
            timeouts += 1
        else:
            steps += st
        seat_games[seat] += 1
        if loser is None:
            draws += 1
            l, s = 0.0, 0.0
        elif loser == seat:
            a_lost += 1
            seat_loss[seat] += 1
            l, s = 1.0, -1.0
        else:
            b_lost += 1
            l, s = 0.0, win
        per_deal_loss.setdefault(deal, []).append(l)
        per_deal_score.setdefault(deal, []).append(s)

    def mean_ci(groups):
        xs = [sum(v) / len(v) for v in groups.values()]
        m = sum(xs) / len(xs)
        if len(xs) < 2:
            return m, float("nan")
        var = sum((x - m) ** 2 for x in xs) / (len(xs) - 1)
        return m, 1.96 * math.sqrt(var / len(xs))

    a_rate, a_ci = mean_ci(per_deal_loss)
    a_score, s_ci = mean_ci(per_deal_score)
    return {
        "games": games,
        "deals": len(per_deal_loss),
        "num_players": n,
        "baseline": 1.0 / n,
        "a_durak_rate": a_rate,
        "a_durak_ci95": a_ci,
        "b_durak_rate": b_lost / (games * (n - 1)) if games else 0.0,
        "draw_rate": draws / games if games else 0.0,
        "a_score": a_score,
        "a_score_ci95": s_ci,
        "a_durak_rate_by_seat": [seat_loss[s] / seat_games[s] if seat_games[s] else 0.0 for s in range(n)],
        "games_per_sec": games / elapsed if elapsed > 0 else float("nan"),
        "mean_steps": steps / max(1, games - timeouts),
        "timeout_rate": timeouts / games if games else 0.0,
        "stall_rate": stalls / games if games else 0.0,
    }


def format_result(name_a: str, name_b: str, r: dict) -> str:
    n = r["num_players"]
    return (
        f"{name_a} vs field of {name_b}  (N={n}, {r['games']} games / {r['deals']} deals)\n"
        f"  A durak rate: {r['a_durak_rate']:.4f} ± {r['a_durak_ci95']:.4f}   (fair baseline 1/N = {r['baseline']:.4f})\n"
        f"  B durak rate: {r['b_durak_rate']:.4f} per B player\n"
        f"  draw rate:    {r['draw_rate']:.4f}   (of which stall-rule draws: {r['stall_rate']:.4f}, step-cap timeouts: {r['timeout_rate']:.4f})\n"
        f"  A score:      {r['a_score']:+.4f} ± {r['a_score_ci95']:.4f}\n"
        f"  A durak by seat: {' '.join(f'{x:.3f}' for x in r['a_durak_rate_by_seat'])}\n"
        f"  {r['games_per_sec']:.1f} games/s, {r['mean_steps']:.0f} steps/game"
    )


def main(argv=None):
    ap = argparse.ArgumentParser(description="Durak arena: agent A vs a field of agent B")
    ap.add_argument("a")
    ap.add_argument("b")
    ap.add_argument("--players", "-n", type=int, default=2)
    ap.add_argument("--games", "-g", type=int, default=1000)
    ap.add_argument("--workers", "-w", type=int, default=1)
    ap.add_argument("--seed", "-s", type=int, default=0)
    args = ap.parse_args(argv)
    r = play_match(args.a, args.b, args.players, args.games, args.seed, args.workers)
    print(format_result(args.a, args.b, r))
    return r


if __name__ == "__main__":
    main()
