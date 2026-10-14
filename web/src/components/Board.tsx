import { type CSSProperties, type ReactNode } from "react";
import type { GameState, Player } from "../api";
import { sortHand, suitOf } from "../cards";
import { SUIT_NAMES, useI18n, type TFn } from "../i18n";
import { Avatar } from "./Avatar";
import { Card, CardBack, SuitIcon } from "./Card";

export interface Bubble {
  seat: number;
  text: string;
  tone: "play" | "pass" | "take" | "bita" | "out" | "say";
  key: number;
}

export interface Dealing {
  dealt: number[];
  trumpShown: boolean;
  extra: number; // cards still in the dealer's hands (shown on the talon)
}

export function displayName(p: Pick<Player, "is_human" | "persona" | "name">, t: TFn, short = false): string {
  if (p.is_human) return t("role.you");
  return p.persona ? t(`${short ? "personaShort" : "persona"}.${p.persona}`) : p.name;
}

export function RoleBadges({ player, state }: { player: Player; state: GameState }) {
  const { t } = useI18n();
  const out: ReactNode[] = [];
  if (state.done) {
    if (player.is_durak) out.push(<span key="d" className="badge durak">{t("role.durak")}</span>);
    else if (player.place) out.push(<span key="o" className="badge out">{t("role.out", { p: player.place })}</span>);
    return <div className="badges">{out}</div>;
  }
  if (player.out) out.push(<span key="o" className="badge out">{t("role.out", { p: player.place ?? "" })}</span>);
  if (player.is_attacker) out.push(<span key="a" className="badge attacker">{t("role.attacker")}</span>);
  if (player.is_defender) out.push(<span key="f" className="badge defender">{t("role.defender")}</span>);
  if (player.is_thrower) out.push(<span key="t" className="badge thrower">{t("role.thrower")}</span>);
  return <div className="badges">{out}</div>;
}

export function BubbleView({ bubble, className = "" }: { bubble?: Bubble | null; className?: string }) {
  if (!bubble) return null;
  return (
    <div key={bubble.key} className={`bubble tone-${bubble.tone} ${className}`} role="status">
      {bubble.text}
    </div>
  );
}

function OpponentHand({ player, state, reveal, count }: { player: Player; state: GameState; reveal: boolean; count: number }) {
  const { t } = useI18n();
  if (count === 0) return <div className="opp-hand empty">{player.out || state.done ? t("opp.noCards") : ""}</div>;
  if (reveal && player.hand) {
    const cards = sortHand(player.hand, state.trump_suit);
    const known = new Set(player.known);
    return (
      <div className="opp-hand revealed">
        {cards.map((c) => (
          <Card key={c} card={c} className="mini" known={known.has(c)} />
        ))}
      </div>
    );
  }
  const knownCards = count === player.hand_size ? player.known : [];
  const hidden = count - knownCards.length;
  const shownBacks = Math.min(hidden, 7);
  return (
    <div className="opp-hand">
      <div className="backs">
        {Array.from({ length: shownBacks }, (_, i) => (
          <CardBack key={i} className="mini" style={{ "--i": i, "--n": shownBacks } as CSSProperties} />
        ))}
        <span className="count" aria-label={`${count}`}>
          {count}
        </span>
      </div>
      {knownCards.length > 0 && (
        <div className="known-row">
          {sortHand(knownCards, state.trump_suit).map((c) => (
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
  botLabel,
  count,
}: {
  player: Player;
  state: GameState;
  style?: CSSProperties;
  bubble?: Bubble | null;
  thinking: boolean;
  reveal: boolean;
  winProb?: number;
  botLabel?: string;
  count: number;
}) {
  const { t } = useI18n();
  const cls = [
    "opponent",
    player.to_move && !state.done ? "to-move" : "",
    thinking ? "thinking-now" : "",
    player.out ? "is-out" : "",
    player.is_durak ? "is-durak" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const name = displayName(player, t);
  return (
    <div className={cls} style={style} data-seat={player.seat} aria-label={name}>
      <div className="opp-head">
        <Avatar player={player} size={36} />
        <div className="opp-name">
          <div className="name">{name}</div>
          <div className="sub">
            {botLabel ? <span className="bot-tag">{botLabel}</span> : null}
            {winProb !== undefined && <span className="wp-tag">{Math.round(winProb * 100)}%</span>}
          </div>
        </div>
        {thinking && (
          <div className="thinking" aria-label={t("status.thinking", { name })}>
            <i />
            <i />
            <i />
          </div>
        )}
      </div>
      <RoleBadges player={player} state={state} />
      <OpponentHand player={player} state={state} reveal={reveal} count={count} />
      <BubbleView bubble={bubble} />
    </div>
  );
}

export function TableCenter({ state, hintCard }: { state: GameState; hintCard?: number | null }) {
  const { t } = useI18n();
  const attackCount = state.table.length;
  const bits: string[] = [];
  if (!state.done) {
    bits.push(t("table.bout", { b: state.bout + 1 }), t("table.cards", { a: attackCount, l: state.bout_limit }));
    if (state.first_bout) bits.push(t("table.first"));
    if (state.phase === "throw_in") bits.push(t("table.taking"));
  }
  return (
    <div className="table-center" aria-label={t("a11y.table")}>
      <div className="bout-info">{state.done ? t("table.over") : bits.join(" · ")}</div>
      <div className="pairs">
        {state.table.length === 0 && !state.done && <div className="table-empty">{t("table.empty")}</div>}
        {state.table.map((p, i) => (
          <div
            className={`pair ${p.defense === null ? "uncovered" : "covered"} ${hintCard !== undefined && hintCard !== null && p.defense === null ? "hint-target" : ""}`}
            key={p.attack}
            style={{ "--k": i } as CSSProperties}
          >
            <Card card={p.attack} className="table-card attack" />
            {p.defense !== null && <Card card={p.defense} className="table-card defense" />}
          </div>
        ))}
      </div>
    </div>
  );
}

export function Talon({ state, dealing }: { state: GameState; dealing: Dealing | null }) {
  const { lang, t } = useI18n();
  const n = state.talon_size + (dealing ? dealing.extra : 0);
  const layers = Math.min(Math.max(n - 1, 0), 6);
  const showTrump = !dealing || dealing.trumpShown;
  return (
    <div className="talon" title={`${t("talon.left", { n })} · ${t("talon.trump")} ${SUIT_NAMES[lang][state.trump_suit]}`}>
      <div className="talon-stack">
        {n > 0 ? (
          <>
            {showTrump ? (
              <Card card={state.trump_card} className="table-card trump-card flip-in" />
            ) : (
              <CardBack className="table-card trump-card" />
            )}
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
          {t("talon.trump")} <SuitIcon suit={state.trump_suit} size={13} />
        </span>
        <span className="talon-count">{n > 0 ? t("talon.left", { n }) : t("talon.empty")}</span>
      </div>
    </div>
  );
}

export function DiscardPile({ count }: { count: number }) {
  const { t } = useI18n();
  const layers = Math.min(count, 7);
  return (
    <div className="discard" title={t("discard.label", { n: count })}>
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
        <span className="talon-count">{t("discard.label", { n: count })}</span>
      </div>
    </div>
  );
}

export const isTrump = (c: number, s: GameState) => suitOf(c) === s.trump_suit;
