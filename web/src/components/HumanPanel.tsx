import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { GameState, Player } from "../api";
import { PASS, sortHand, suitOf } from "../cards";
import { useI18n } from "../i18n";
import type { SortMode } from "../prefs";
import { Avatar } from "./Avatar";
import { BubbleView, RoleBadges, displayName, type Bubble } from "./Board";
import { Card } from "./Card";

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(800);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

export function Hand({
  bubble,
  cards,
  state,
  legal,
  canAct,
  known,
  selected,
  hintAction,
  onPlay,
  sort,
}: {
  bubble: Bubble | null;
  cards: number[];
  state: GameState;
  legal: Set<number>;
  canAct: boolean;
  known: Set<number>;
  selected: number | null;
  hintAction: number | null;
  onPlay: (c: number) => void;
  sort: SortMode;
}) {
  const { t } = useI18n();
  const [ref, width] = useWidth<HTMLDivElement>();
  const prev = useRef<Set<number>>(new Set(cards));
  const fresh = new Set(cards.filter((c) => !prev.current.has(c)));
  useLayoutEffect(() => {
    prev.current = new Set(cards);
  });

  const sorted = sortHand(cards, state.trump_suit, sort);
  const legalSorted = sorted.filter((c) => legal.has(c));
  const cw = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--cw")) || 86;
  const n = sorted.length;
  const spread = n > 1 ? Math.min(4.5, 30 / n) : 0;
  // Rotated edge cards stick out sideways; keep them inside the panel.
  const sideRoom = cw * 1.45 * Math.sin((((n - 1) / 2) * spread * Math.PI) / 180) + 12;
  const stepPx = n > 1 ? Math.max(8, Math.min(cw * 0.74, (width - cw - 2 * sideRoom) / (n - 1))) : 0;
  const total = n > 0 ? cw + stepPx * (n - 1) : 0;

  return (
    <div className="hand" ref={ref} role="group" aria-label={t("a11y.hand")}>
      <BubbleView bubble={bubble} className="human-bubble" />
      <div className="hand-inner" style={{ width: total }}>
        {sorted.map((c, i) => {
          const isLegal = legal.has(c);
          const hintIdx = legalSorted.indexOf(c);
          const off = i - (n - 1) / 2;
          const style = {
            left: i * stepPx,
            zIndex: i + 1,
            "--rot": `${off * spread}deg`,
            "--dy": `${off * off * spread * 0.22}px`,
          } as CSSProperties;
          return (
            <Card
              key={c}
              card={c}
              className={`hand-card ${fresh.has(c) ? "drawn" : ""} ${hintAction === c ? "hinted" : ""}`}
              style={style}
              legal={isLegal}
              dimmed={canAct && !isLegal}
              selected={selected === c}
              known={known.has(c)}
              trump={suitOf(c) === state.trump_suit}
              hint={isLegal && hintIdx < 9 ? String(hintIdx + 1) : undefined}
              onClick={isLegal ? () => onPlay(c) : undefined}
            />
          );
        })}
        {n === 0 && !state.done && <div className="hand-empty">{t("hand.none")}</div>}
      </div>
    </div>
  );
}

export function HumanPanel({
  state,
  player,
  status,
  busy,
  selected,
  onPlay,
  bubble,
  winProb,
  extraControls,
  handCards,
  sort,
  onSort,
  onHint,
  hintAvailable,
  hintAction,
  hintOpen,
}: {
  state: GameState;
  player: Player;
  status: ReactNode;
  busy: boolean;
  selected: number | null;
  onPlay: (action: number) => void;
  bubble: Bubble | null;
  winProb?: number;
  extraControls?: ReactNode;
  handCards: number[];
  sort: SortMode;
  onSort: () => void;
  onHint?: () => void;
  hintAvailable: boolean;
  hintAction: number | null;
  hintOpen: boolean;
}) {
  const { t } = useI18n();
  const canAct = state.your_turn && !busy;
  const legal = new Set(canAct ? state.legal : []);
  const known = new Set(player.known);
  const pl = state.pass_label;

  return (
    <div
      className={`human-panel ${canAct ? "my-turn" : ""} ${player.out ? "is-out" : ""}`}
      data-seat={player.seat}
    >
      <div className="human-bar">
        <div className="human-id">
          <Avatar player={player} size={38} />
          <div>
            <div className="name">
              {displayName(player, t)}
              {state.mode === "spectate" && player.bot ? <span className="bot-tag">{player.bot}</span> : null}
            </div>
            <RoleBadges player={player} state={state} />
          </div>
        </div>
        <div className="status" aria-live="polite" data-testid="status">
          {status}
        </div>
        {winProb !== undefined && (
          <div className="winprob" title={t("hint.win")}>
            <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(winProb * 100)} aria-label={t("hint.win")}>
              <div style={{ width: `${Math.round(winProb * 100)}%` }} />
            </div>
            <b>{Math.round(winProb * 100)}%</b>
          </div>
        )}
        <div className="actions">
          {state.mode === "play" && !player.out && !state.done && (
            <>
              <button
                type="button"
                className="btn ghost small sort-btn"
                onClick={onSort}
                title={`${t("hand.sort")}: ${sort === "suit" ? t("hand.sortSuit") : t("hand.sortRank")}`}
                aria-label={`${t("hand.sort")}: ${sort === "suit" ? t("hand.sortSuit") : t("hand.sortRank")}`}
              >
                {sort === "suit" ? "♠♥" : "6→A"}
              </button>
              {onHint && (
                <button
                  type="button"
                  className={`btn hint-btn ${hintOpen ? "on" : ""}`}
                  onClick={onHint}
                  disabled={!canAct || !hintAvailable}
                  data-testid="hint"
                  title={`${t("hint.button")} (H)`}
                >
                  <span aria-hidden="true">💡</span> {t("hint.button")}
                </button>
              )}
            </>
          )}
          {state.mode === "play" && pl && (
            <button
              type="button"
              className={`btn action-btn pass-${pl} ${hintAction === PASS ? "hinted" : ""}`}
              disabled={!canAct || !legal.has(PASS)}
              onClick={() => onPlay(PASS)}
              title={`${t(`passHelp.${pl}`)} (Space)`}
              data-testid="pass"
            >
              {t(`pass.${pl}`)}
              <kbd>Space</kbd>
            </button>
          )}
          {extraControls}
        </div>
      </div>
      <Hand
        bubble={bubble}
        cards={handCards}
        state={state}
        legal={legal}
        canAct={canAct}
        known={known}
        selected={selected}
        hintAction={hintAction}
        onPlay={onPlay}
        sort={sort}
      />
    </div>
  );
}
