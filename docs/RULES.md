# Rules of Podkidnoy Durak (as implemented)

This page describes the exact rules that DurakBot implements. The rules engine, [`durak/engine.py`](../durak/engine.py), is the single source of truth: the server, the bots, the solver and the training code all call it, and the web app only displays what it reports. The examples on this page were checked against the engine.

Podkidnoy Durak ("throw-in fool") is the most widely played form of Durak. There is no winner: the players who get rid of their cards are safe, and the last player left holding cards is the *durak* (the fool).

**Contents:** [Cards](#cards-and-notation) · [Setup](#setup) · [Roles in a bout](#roles-in-a-bout) · [Beating a card](#beating-a-card) · [The bout limit](#the-bout-limit) · [Playing a bout](#playing-a-bout) · [Drawing](#drawing-cards) · [The next bout](#who-attacks-next) · [Going out and the end of the game](#going-out-and-the-end-of-the-game) · [The stall rule](#the-stall-rule) · [Scoring](#scoring) · [Public information](#public-information) · [Variant notes](#variant-notes) · [Worked examples](#worked-examples)

## Cards and notation

- A 36-card deck: ranks 6, 7, 8, 9, 10, J, Q, K, A in four suits, spades ♠, clubs ♣, diamonds ♦ and hearts ♥.
- Within a suit, cards rank from 6 (lowest) to Ace (highest).
- This page writes cards as rank plus suit symbol (7♠, 10♥). The engine's text form uses letters: `7S`, `10H`, `AD`, `QC`. How cards are numbered internally is described in [ENGINE.md](ENGINE.md).

## Setup

- **Players**: 2 to 6. Seats are numbered 0 to N−1 and play goes clockwise, which means increasing seat number.
- **Deal**: every player receives 6 cards. The remaining cards form the *talon* (the stock).
- **Trump**: the bottom card of the talon is placed face up; its suit is the trump suit for the whole game. This card stays visible and is the last card to be drawn from the talon.
- **Six players**: 6 × 6 = 36, so the talon is empty right after the deal. The last card dealt (to seat 5) sets the trump suit and is shown to everybody, so all players know that seat 5 holds it.
- **First attacker**: the player holding the lowest trump. If nobody holds a trump (possible with 2 to 5 players), the first attacker is chosen at random.

## Roles in a bout

The game is a sequence of *bouts*. In each bout:

- The **attacker** (also called the main attacker) opens the bout.
- The **defender** is the next player clockwise who is still in the game.
- The **throwers** are the players allowed to add cards: the attacker and the defender's *other* neighbour (the next active player after the defender), if that is a different player. This is the *neighbours-only* throw-in rule. With only two players left, the attacker is the only thrower.
- Everyone else sits the bout out.

With four players, for example, if seat 0 attacks seat 1, the throwers are seats 0 and 2, and seat 3 may not add cards to this bout even if it holds matching ranks.

## Beating a card

A defending card beats an attacking card if:

- it has the **same suit and a higher rank**, or
- it is a **trump** and the attacking card is not.

A trump can only be beaten by a higher trump. A card of a different non-trump suit never beats anything, whatever its rank.

## The bout limit

At the start of every bout the number of attacking cards allowed in that bout is fixed as

```text
limit = min(6, number of cards the defender holds at the start of the bout)
```

In the **first bout of the game only**, 5 replaces 6. The limit counts every attacking card played in the bout, beaten or not, including cards thrown in after the defender has decided to take.

## Playing a bout

Play is strictly one card at a time. At each moment exactly one player is to move, and every choice is either a card or a *pass*. A pass means different things depending on the phase, and the web app labels it accordingly.

### 1. The lead

On an empty table the attacker must play a card; any card may be led. Passing is not allowed.

### 2. Defending

The defender faces exactly one uncovered card at a time and either:

- **beats** it with a card that beats it (see above), or
- **passes, which means taking**: the defender gives up the bout. Play moves to the throw-in phase described in step 4.

The defender may take even when they could beat the card.

### 3. Adding cards (attack phase)

Whenever every card on the table is covered, the throwers are asked **in priority order, the attacker first**. The player asked either:

- **adds** one card whose rank already appears on the table (attacking or defending cards), provided the bout limit has not been reached. The defender must then deal with that card (step 2); or
- **passes**.

After each successful beat, priority starts again from the attacker, so a thrower who passed earlier may add a card later in the same bout.

If **all throwers pass in a row**, the bout ends with **bita**: the table goes to the discard pile. Everyone has seen these cards, so the engine treats the contents of the discard pile as public information. The web app labels the final pass "bita" and earlier passes "pass".

### 4. Throwing in after a take

When the defender takes, each thrower in priority order (the attacker first) may add **any number of cards** whose rank appears on the table, as long as the bout limit is not exceeded, and then passes ("done"). When the last thrower has passed, the defender **picks up every card on the table**: the attacking cards, the cards thrown in and the defender's own beating cards.

## Drawing cards

After every bout the players refill their hands to six cards from the talon, in this order:

1. the attacker,
2. the other players clockwise from the attacker, skipping the defender,
3. the defender, last.

Drawing stops as soon as the talon is empty, so near the end of the talon the order matters: the defender may get nothing. Players who already hold six or more cards draw nothing. The face-up trump card is the last card drawn, and everybody sees who takes it.

## Who attacks next

- After **bita** (a successful defence), the defender becomes the next attacker.
- After a **take**, the defender loses their turn: the next attacker is the next active player after the defender.
- Players who are out are skipped. If the defender went out during a successful defence, the next active player after them attacks.

The new defender is again the next active player after the new attacker.

## Going out and the end of the game

- A player is **out** (safe) when, at the end of a bout, the talon is empty and they have no cards. While the talon still has cards, nobody goes out, because every player can still draw. Players who go out at the end of the same bout are recorded in drawing order.
- The game ends when at most one player still has cards.
  - If exactly one player is left, that player is the **durak**.
  - If the last players run out of cards in the same bout, so that nobody is left, the game is a **draw**.
- The players who still hold cards keep playing among themselves until at most one is left.

## The stall rule

With three or more players, a game with an empty talon can cycle forever: the same cards can be passed round the table in an endless series of takes. To guarantee that every game ends, the engine declares a **draw** when, with the talon empty and at least three players still in the game, **30 consecutive bouts end in a take** (`Config.stall_bouts`). Any bita resets the count.

With two players this cannot happen, because every take shrinks the attacker's hand, so the rule never applies there. In self-play training, draws (from this rule and from players going out together) make up about 4–5% of all games.

## Scoring

The engine reports a zero-sum result (`DurakGame.returns()`):

| Outcome | Durak | Every other player |
|---|---|---|
| A durak is decided | −1 | +1/(N−1) |
| Draw (all out together, or the stall rule) | 0 | 0 |

With two players this is simply +1 for the winner and −1 for the durak. The order in which the safe players went out does not change the score. The web app shows it as a place (1st, 2nd, ...) for interest only.

## Public information

All players see the table, the discard pile, the trump card, the talon size, every hand size and every move. In addition, some cards in the hands become **publicly known**:

- every card a defender picks up after a take,
- the face-up trump card, once someone draws it,
- with six players, the trump card dealt to seat 5.

A known card stops being known when it is played. The engine tracks these cards in `game.known`, the web app marks them on the opponents' card fans, and the bots may use them. Everything else in an opponent's hand, and the order of the talon, is hidden.

Once the talon is empty and only two players remain, nothing is hidden any more: each player can work out the opponent's hand as every card that is neither in their own hand, on the table nor in the discard. The [endgame solver](SOLVER.md) relies on this.

## Variant notes

Durak has many house rules. This implementation makes the following choices:

- **No transferring.** This is Podkidnoy, not Perevodnoy: the defender can never pass the attack on by playing a card of the same rank.
- **Neighbours only.** Only the attacker and the defender's other neighbour may add cards; the rest of the table may not.
- **Five cards in the first bout**, and never more cards than the defender held at the start of the bout.
- **One card at a time, in priority order.** Throwers do not race each other: the attacker always has priority, and the bout ends only after every thrower has passed in turn.
- **Taking is always allowed**, even when the defender could beat the card.
- **Draws** happen only when the last players go out together, or through the stall rule.
- **No further house rules**, such as restrictions on the last card played or extra penalties: the only result is who, if anyone, is the durak.

## Worked examples

In these examples the trump suit is hearts ♥ unless stated otherwise.

### Example 1: beating

| Attack | Defence | Beats? | Why |
|---|---|---|---|
| 7♠ | 9♠ | yes | same suit, higher rank |
| A♠ | 6♥ | yes | trump against a non-trump |
| 7♥ | K♠ | no | only a higher trump beats a trump |
| 7♥ | 10♥ | yes | higher trump |
| 6♠ | 7♦ | no | different non-trump suit |

### Example 2: a four-player bout ending in a take

The talon holds a single card, the face-up trump 6♥. The hands are:

| Seat | Role | Hand |
|---|---|---|
| 0 | attacker | 7♠ 7♣ Q♦ |
| 1 | defender | 9♠ 10♠ K♥ |
| 2 | co-thrower (defender's other neighbour) | 7♦ J♣ A♣ |
| 3 | sits out | 7♥ 8♣ 9♦ |

The defender holds 3 cards, so the bout limit is 3.

1. Seat 0 leads **7♠**. Seat 1 may beat it with 9♠, 10♠ or K♥, or take.
2. Seat 1 beats with **9♠**. The table is covered, so seat 0 is asked first and may add a 7 or a 9: it adds **7♣**.
3. Seat 1 has no clubs, so only a trump beats 7♣: it plays **K♥**.
4. Seat 0 is asked again. Q♦ matches no rank on the table (7, 9, K), so it must pass. Seat 2 is asked next and adds **7♦**. Seat 3 also holds a 7 (7♥) but is not a thrower and cannot add it.
5. Seat 1 holds only 10♠, which cannot beat 7♦, so it **takes**. The limit of 3 attacking cards has been reached, so neither thrower may throw in more; both pass.
6. Seat 1 picks up 7♠, 9♠, 7♣, K♥ and 7♦. All five are now publicly known to be in seat 1's hand.
7. Drawing: the attacker draws first. Seat 0 holds only Q♦ and takes the last card, the face-up 6♥; nobody else draws.
8. Because seat 1 took, it loses its turn: **seat 2 attacks seat 3** next, and seat 3's other neighbour, seat 0, is the co-thrower.

### Example 3: bout limits

- In the first bout of any game at most 5 attacking cards can be played, even though the defender holds 6.
- Later, a defender who holds 3 cards at the start of a bout faces at most 3 attacking cards, however many matching cards the throwers have.
- With three players, an attacker holding 7♠ 7♣ against a defender holding a single 9♠ (talon empty) may lead 7♠, but after 9♠ beats it the attacker cannot add 7♣: the limit is 1.

### Example 4: the drawing order decides who goes out

Three players. The talon has 5 cards left, including the face-up trump 6♥. Seat 0 holds 7♠, seat 1 holds 9♠ and seat 2 holds 8♣.

1. Seat 0 leads 7♠, seat 1 beats it with 9♠, and both throwers (seats 0 and 2) pass: bita.
2. Drawing: seat 0 (attacker) draws first and needs 6 cards, so it takes all 5 remaining cards, including 6♥. Seat 2 and then seat 1 (the defender, last) get nothing.
3. The talon is now empty and seat 1 has no cards: **seat 1 is out** in first place.
4. Seat 1 defended successfully but is out, so the next active player, seat 2, attacks seat 0. With two players left, seat 2 is the only thrower.

### Example 5: how a game ends

Two players are left, the talon is empty and seat 0 attacks.

- Seat 0 holds 7♠ and seat 1 holds 9♠ 6♣. Seat 0 leads 7♠, seat 1 beats it with 9♠, and seat 0, with no cards left, can only pass: bita. Seat 0 is out and **seat 1 is the durak**.
- Same, but seat 1 holds only 9♠. After the beat both players are out of cards at the end of the same bout: the game is a **draw**.
- Seat 0 holds 7♠ and seat 1 holds 6♣ 8♦. Seat 1 cannot beat 7♠ and takes. Seat 0 is out and **seat 1 is the durak**.

---

See also: [ENGINE.md](ENGINE.md) for how these rules map onto the engine API, and [BOTS.md](BOTS.md) for the computer players.
