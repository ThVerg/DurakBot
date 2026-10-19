"""Dump engine traces for the TypeScript parity test (web/src/local/engine.test.ts).

For every player count 2..6, plays seeded games with a few action policies
(uniform random, take-heavy, pass-heavy) and records the injected deal, the
action sequence and the full public + hidden state after every step. The TS
engine replays the same deal and actions and must match exactly.

    .venv/bin/python scripts/export_engine_fixtures.py [--games 24] [--out web/test-fixtures/engine]
"""

from __future__ import annotations

import argparse
import gzip
import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from durak.cards import (  # noqa: E402
    FULL_MASK,
    NUM_CARDS,
    RANK_MASKS,
    SUIT_MASKS,
    beaters_mask,
)
from durak.engine import PASS, DurakGame  # noqa: E402


class _DeckRng:
    """Stands in for random.Random inside DurakGame._deal: the shuffle yields a
    fixed deck order and randrange a fixed first attacker."""

    def __init__(self, deck: list[int], fallback: int):
        self.deck = deck
        self.fallback = fallback
        self.used_fallback = False

    def shuffle(self, x: list[int]) -> None:
        x[:] = self.deck

    def randrange(self, n: int) -> int:
        self.used_fallback = True
        return self.fallback % n


def deal(deck: list[int], n: int, fallback: int) -> tuple[DurakGame, bool]:
    g = DurakGame(num_players=n, deal=False)
    rng = _DeckRng(deck, fallback)
    g._deal(rng)  # noqa: SLF001 - deliberate: inject the deal
    return g, rng.used_fallback


def snapshot(g: DurakGame) -> dict:
    return {
        "legal": g.legal_mask_int(),
        "phase": g.phase,
        "cur": g.current_player if not g.done else None,
        "hands": list(g.hands),
        "known": list(g.known),
        "att": list(g.attack_cards),
        "def": list(g.defense_cards),
        "talon": len(g.talon),
        "discard": g.discard,
        "attacker": g.attacker,
        "defender": g.defender,
        "throwers": list(g.throwers),
        "tidx": g.thrower_idx,
        "limit": g.bout_limit,
        "first": g.first_bout,
        "bout": g.bout_index,
        "finished": list(g.finished),
        "done": g.done,
        "loser": g.loser,
        "stall": g.stall,
        "unseen": [g.unseen_mask(p) for p in range(g.num_players)],
    }


def choose(g: DurakGame, rng: random.Random, policy: str) -> int:
    legal = g.legal_actions()
    if len(legal) == 1:
        return legal[0]
    cards = [a for a in legal if a != PASS]
    if policy == "take" and PASS in legal:
        # Defender takes a lot, throwers keep adding: drives stalls and big pickups.
        if g.phase == 1:
            return PASS if rng.random() < 0.75 else rng.choice(cards)
        return rng.choice(cards) if cards and rng.random() < 0.8 else PASS
    if policy == "pass" and PASS in legal and g.phase != 1:
        return PASS if rng.random() < 0.7 else rng.choice(legal)
    return rng.choice(legal)


def play(seed: int, n: int, policy: str, max_steps: int = 4000, deck: list[int] | None = None) -> dict:
    rng = random.Random(seed)
    if deck is None:
        deck = list(range(NUM_CARDS))
        rng.shuffle(deck)
    fallback = rng.randrange(n)
    g, used_fallback = deal(deck, n, fallback)
    trace = {
        "seed": seed,
        "num_players": n,
        "policy": policy,
        "deck": deck,
        "fallback_attacker": fallback,
        "used_fallback": used_fallback,
        "trump_card": g.trump_card,
        "trump": g.trump,
        "initial": snapshot(g),
        "actions": [],
        "states": [],
    }
    steps = 0
    while not g.done and steps < max_steps:
        a = choose(g, rng, policy)
        g.step(a)
        trace["actions"].append(a)
        trace["states"].append(snapshot(g))
        steps += 1
    trace["returns"] = list(g.returns())
    trace["log"] = [list(x) for x in g.log]
    return trace


def no_trump_deck(n: int, seed: int) -> list[int] | None:
    """A deck where every trump lies in the talon (nobody holds one), if the
    talon is big enough (n <= 4)."""
    rng = random.Random(seed)
    trump = rng.randrange(4)
    trumps = [trump * 9 + r for r in range(9)]
    others = [c for c in range(NUM_CARDS) if c // 9 != trump]
    rng.shuffle(trumps)
    rng.shuffle(others)
    dealt = n * 6
    if NUM_CARDS - dealt < 9:
        return None
    hands = others[:dealt]
    rest = others[dealt:] + trumps[1:]
    rng.shuffle(rest)
    return hands + [trumps[0]] + rest


def find_special(n: int, want: str, start: int, policy: str = "random", limit: int = 200000) -> dict | None:
    """Search seeds for a game with a rare property."""
    for seed in range(start, start + limit):
        rng = random.Random(seed)
        deck = list(range(NUM_CARDS))
        rng.shuffle(deck)
        if want == "no_trump_holder":
            deck = no_trump_deck(n, seed)
            if deck is None:
                return None
            return play(seed, n, policy, deck=deck)
        t = play(seed, n, policy)
        last = t["states"][-1] if t["states"] else t["initial"]
        if want == "stalemate" and last["done"] and last["stall"] >= 30:
            return t
        if want == "draw" and last["done"] and last["loser"] is None and last["stall"] < 30:
            return t
    return None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--games", type=int, default=24, help="games per player count and policy mix")
    ap.add_argument("--out", default=str(ROOT / "web" / "test-fixtures" / "engine"))
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    cards = {
        "full_mask": FULL_MASK,
        "rank_masks": RANK_MASKS,
        "suit_masks": SUIT_MASKS,
        "beaters": [[beaters_mask(a, t) for a in range(NUM_CARDS)] for t in range(4)],
    }
    (out / "cards.json").write_text(json.dumps(cards, separators=(",", ":")))

    total = 0
    for n in range(2, 7):
        traces = []
        policies = ["random"] * (args.games // 2) + ["take"] * (args.games // 4) + ["pass"] * (args.games - args.games // 2 - args.games // 4)
        for i, policy in enumerate(policies):
            traces.append(play(1000 * n + i, n, policy))
        specials = [("no_trump_holder", "random")] if n <= 4 else []
        if n >= 3:
            specials += [("stalemate", "take")]
        specials += [("draw", "random")]
        for want, policy in specials:
            t = find_special(n, want, 500000 + 1000 * n, policy, limit=4000)
            if t is not None:
                t["special"] = want
                traces.append(t)
            else:
                print(f"  {n}p: no {want} game found", file=sys.stderr)
        path = out / f"traces_{n}p.json.gz"
        raw = json.dumps({"num_players": n, "traces": traces}, separators=(",", ":")).encode()
        path.write_bytes(gzip.compress(raw, 9, mtime=0))
        steps = sum(len(t["actions"]) for t in traces)
        total += steps
        kinds = {}
        for t in traces:
            last = t["states"][-1]
            k = t.get("special") or ("stalemate" if last["stall"] >= 30 else "draw" if last["loser"] is None else "durak")
            kinds[k] = kinds.get(k, 0) + 1
        print(f"{n}p: {len(traces)} games, {steps} steps, {path.stat().st_size // 1024} KB, {kinds}")
    print(f"total steps: {total}")


if __name__ == "__main__":
    main()
