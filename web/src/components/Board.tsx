import { type CSSProperties, type ReactNode } from "react";
import type { GameState, Player } from "../api";
import { SUIT_NAMES, sortHand } from "../cards";
import { Card, CardBack, SuitIcon } from "./Card";

export interface Bubble {
  seat: number;
  text: string;
  tone: "play" | "pass" | "take" | "bita" | "out";
  key: number;
}

export interface Fresh {
  card: number;
  dx: number;
  dy: number;
}

export interface Sweep {
  dx: number;
  dy: number;
}

const AVATAR_COLORS = ["#e07a5f", "#3d8bfd", "#f2cc8f", "#81b29a", "#c77dff", "#f28482"];

export function Avatar({ player, size = 40 }: { player: Player; size?: number }) {
  const bg = player.is_human ? "#f4d35e" : AVATAR_COLORS[player.seat % AVATAR_COLORS.length];
  return (
    <div className="avatar" style={{ width: size, height: size, background: bg, fontSize: size * 0.42 }}>
      {player.is_human ? "★" : player.name[0]}
    </div>
  );
}

export function RoleBadges({ player, state }: { player: Player; state: GameState }) {
  const out: ReactNode[] = [];
  if (state.done) {
    if (player.is_durak) out.push(<span key="d" className="badge durak">Durak</span>);
    else if (player.place) out.push(<span key="o" className="badge out">Out · #{player.place}</span>);
    return <div className="badges">{out}</div>;
  }
  if (player.out) out.push(<span key="o" className="badge out">Out · #{player.place}</span>);
  if (player.is_attacker) out.push(<span key="a" className="badge attacker">Attacker</span>);
  if (player.is_defender) out.push(<span key="f" className="badge defender">Defender</span>);
  if (player.is_thrower) out.push(<span key="t" className="badge thrower">Thrower</span>);
  return <div className="badges">{out}</div>;
}

function BubbleView({ bubble }: { bubble?: Bubble | null }) {
  if (!bubble) return null;
  return (
    <div key={bubble.key} className={`bubble tone-${bubble.tone}`}>
      {bubble.text}
    </div>
  );
}

function OpponentHand({ player, state, reveal }: { player: Player; state: GameState; reveal: boolean }) {
  if (player.hand_size === 0) return <div className="opp-hand empty">no cards</div>;
  if (reveal && player.hand) {
    const cards = sortHand(player.hand, state.trump_suit);
    const known = new Set(player.known);
    return (
      <div className="opp-hand revealed">
        {cards.map((c) => (
          <Card key={c} card={c} className="mini" known={known.has(c)} trump={Math.floor(c / 9) === state.trump_suit} />
        ))}
      </div>
    );
  }
  const hidden = player.hand_size - player.known.length;
  const shownBacks = Math.min(hidden, 7);
  return (
    <div className="opp-hand">
      <div className="backs">
        {Array.from({ length: shownBacks }, (_, i) => (
          <CardBack key={i} className="mini" style={{ "--i": i, "--n": shownBacks } as CSSProperties} />
        ))}
        <span className="count" title={`${player.hand_size} cards`}>
          {player.hand_size}
        </span>
      </div>
      {player.known.length > 0 && (
        <div className="known-row" title="Cards this player picked up (publicly known)">
          {sortHand(player.known, state.trump_suit).map((c) => (
            <Card key={c} card={c} className="mini" known />
          ))}
        </div>
      )}
    </div>
  );
}

export function Opponent({
  player,
  state,
  style,
  bubble,
  thinking,
  reveal,
  winProb,
  refCb,
}: {
  player: Player;
  state: GameState;
  style?: CSSProperties;
  bubble?: Bubble | null;
  thinking: boolean;
  reveal: boolean;
  winProb?: number;
  refCb: (el: HTMLDivElement | null) => void;
}) {
  const cls = [
    "opponent",
    player.to_move && !state.done ? "to-move" : "",
    player.out ? "is-out" : "",
    player.is_durak ? "is-durak" : "",
    player.is_defender && !state.done ? "role-defender" : "",
    player.is_attacker && !state.done ? "role-attacker" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls} style={style} ref={refCb} data-seat={player.seat}>
      <div className="opp-head">
        <Avatar player={player} size={34} />
        <div className="opp-name">
          <div className="name">{player.name}</div>
          <div className="sub">
            {player.bot ? <span className="bot-tag">{player.bot}</span> : null}
            {winProb !== undefined && <span className="wp-tag">{Math.round(winProb * 100)}%</span>}
          </div>
        </div>
        {thinking && player.to_move && !state.done && (
          <div className="thinking" aria-label="thinking">
            <i />
            <i />
            <i />
          </div>
        )}
      </div>
      <RoleBadges player={player} state={state} />
      <OpponentHand player={player} state={state} reveal={reveal} />
      <BubbleView bubble={bubble} />
    </div>
  );
}

export function TableCenter({
  state,
  fresh,
  sweep,
  refCb,
}: {
  state: GameState;
  fresh: Fresh | null;
  sweep: Sweep | null;
  refCb: (el: HTMLDivElement | null) => void;
}) {
  const attackCount = state.table.length;
  return (
    <div className="table-center" ref={refCb}>
      <div className="bout-info">
        {state.done ? (
          "Game over"
        ) : (
          <>
            Bout {state.bout + 1} · {attackCount}/{state.bout_limit} cards
            {state.first_bout ? " · first bout" : ""}
            {state.phase === "throw_in" ? " · taking" : ""}
          </>
        )}
      </div>
      <div
        className={`pairs ${sweep ? "sweeping" : ""}`}
        style={sweep ? ({ "--tx": `${sweep.dx}px`, "--ty": `${sweep.dy}px` } as CSSProperties) : undefined}
      >
        {state.table.length === 0 && !state.done && <div className="table-empty">Table is empty</div>}
        {state.table.map((p) => {
          const freshA = fresh && fresh.card === p.attack;
          const freshD = fresh && p.defense !== null && fresh.card === p.defense;
          return (
            <div className={`pair ${p.defense === null ? "uncovered" : "covered"}`} key={p.attack}>
              <Card
                key={p.attack}
                card={p.attack}
                className={`table-card attack ${freshA ? "fly-in" : ""}`}
                style={freshA ? ({ "--fx": `${fresh!.dx}px`, "--fy": `${fresh!.dy}px` } as CSSProperties) : undefined}
                trump={Math.floor(p.attack / 9) === state.trump_suit}
              />
              {p.defense !== null && (
                <Card
                  key={p.defense}
                  card={p.defense}
                  className={`table-card defense ${freshD ? "fly-in" : ""}`}
                  style={freshD ? ({ "--fx": `${fresh!.dx}px`, "--fy": `${fresh!.dy}px` } as CSSProperties) : undefined}
                  trump={Math.floor(p.defense / 9) === state.trump_suit}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function Talon({ state }: { state: GameState }) {
  const n = state.talon_size;
  const layers = Math.min(Math.max(n - 1, 0), 5);
  return (
    <div className="talon" title={`Talon: ${n} card${n === 1 ? "" : "s"} · trump ${SUIT_NAMES[state.trump_suit]}`}>
      <div className="talon-stack">
        {n > 0 ? (
          <>
            <Card card={state.trump_card} className="table-card trump-card" />
            {n > 1 &&
              Array.from({ length: layers }, (_, i) => (
                <CardBack key={i} className="table-card talon-back" style={{ "--i": i } as CSSProperties} />
              ))}
          </>
        ) : (
          <div className="talon-empty">
            <SuitIcon suit={state.trump_suit} size={34} />
          </div>
        )}
      </div>
      <div className="talon-label">
        <span className="trump-chip">
          Trump <SuitIcon suit={state.trump_suit} size={13} />
        </span>
        <span className="talon-count">{n > 0 ? `${n} left` : "talon empty"}</span>
      </div>
    </div>
  );
}

export function DiscardPile({ count, refCb }: { count: number; refCb: (el: HTMLDivElement | null) => void }) {
  const layers = Math.min(count, 6);
  return (
    <div className="discard" ref={refCb} title={`${count} cards discarded`}>
      <div className="discard-stack">
        {layers === 0 ? (
          <div className="discard-empty" />
        ) : (
          Array.from({ length: layers }, (_, i) => (
            <CardBack key={i} className="table-card discard-back" style={{ "--r": `${((i * 37) % 29) - 14}deg` } as CSSProperties} />
          ))
        )}
      </div>
      <div className="talon-label">
        <span className="talon-count">Bita · {count}</span>
      </div>
    </div>
  );
}
