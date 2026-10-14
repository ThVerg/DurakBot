import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { GameState, Player } from "../api";
import { PASS, sortHand, suitOf } from "../cards";
import { Avatar, RoleBadges, type Bubble } from "./Board";
import { Card } from "./Card";

const PASS_TEXT: Record<string, string> = { bita: "Bita", pass: "Pass", take: "Take", done: "Done" };
const PASS_HELP: Record<string, string> = {
  bita: "End the bout: the table goes to the discard pile",
  pass: "Pass — the other thrower may still add cards",
  take: "Give up defending and pick up the table",
  done: "Stop throwing in; the defender picks up",
};

export function HumanPanel({
  state,
  player,
  status,
  busy,
  selected,
  onPlay,
  bubble,
  winProb,
  refCb,
  extraControls,
}: {
  state: GameState;
  player: Player;
  status: ReactNode;
  busy: boolean;
  selected: number | null;
  onPlay: (action: number) => void;
  bubble: Bubble | null;
  winProb?: number;
  refCb: (el: HTMLDivElement | null) => void;
  extraControls?: ReactNode;
}) {
  const handRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  useLayoutEffect(() => {
    const el = handRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const cards = sortHand(player.hand ?? [], state.trump_suit);
  const canAct = state.your_turn && !busy;
  const legal = new Set(canAct ? state.legal : []);
  const legalCards = cards.filter((c) => legal.has(c));
  const known = new Set(player.known);

  const cw = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--cw")) || 86;
  const n = cards.length;
  const maxStep = cw * 0.78;
  const stepPx = n > 1 ? Math.min(maxStep, (width - cw - 8) / (n - 1)) : 0;
  const total = n > 0 ? cw + stepPx * (n - 1) : 0;

  return (
    <div className={`human-panel ${state.your_turn && !busy ? "my-turn" : ""} ${player.out ? "is-out" : ""}`} ref={refCb}>
      <div className="human-bar">
        <div className="human-id">
          <Avatar player={player} size={36} />
          <div>
            <div className="name">
              {player.name}
              {state.mode === "spectate" && player.bot ? <span className="bot-tag">{player.bot}</span> : null}
            </div>
            <RoleBadges player={player} state={state} />
          </div>
        </div>
        <div className="status" aria-live="polite">
          {status}
        </div>
        {winProb !== undefined && (
          <div className="winprob" title="Champion's estimate that you will NOT be the durak">
            <span>Safe</span>
            <div className="meter">
              <div style={{ width: `${Math.round(winProb * 100)}%` }} />
            </div>
            <b>{Math.round(winProb * 100)}%</b>
          </div>
        )}
        <div className="actions">
          {state.mode === "play" && state.pass_label && (
            <button
              type="button"
              className={`btn action-btn pass-${state.pass_label}`}
              disabled={!canAct || !legal.has(PASS)}
              onClick={() => onPlay(PASS)}
              title={`${PASS_HELP[state.pass_label]} (Space)`}
            >
              {PASS_TEXT[state.pass_label]}
              <kbd>Space</kbd>
            </button>
          )}
          {extraControls}
        </div>
      </div>
      {bubble && (
        <div key={bubble.key} className={`bubble human-bubble tone-${bubble.tone}`}>
          {bubble.text}
        </div>
      )}
      <div className="hand" ref={handRef}>
        <div className="hand-inner" style={{ width: total }}>
          {cards.map((c, i) => {
            const isLegal = legal.has(c);
            const hintIdx = legalCards.indexOf(c);
            return (
              <Card
                key={c}
                card={c}
                className="hand-card"
                style={{ left: i * stepPx, zIndex: i + 1 } as CSSProperties}
                legal={isLegal}
                dimmed={canAct && !isLegal}
                selected={selected === c}
                known={known.has(c)}
                trump={suitOf(c) === state.trump_suit}
                hint={isLegal && hintIdx < 9 ? String(hintIdx + 1) : undefined}
                onClick={isLegal ? () => onPlay(c) : undefined}
                title={isLegal ? undefined : canAct ? "Not playable now" : undefined}
              />
            );
          })}
          {n === 0 && !state.done && <div className="hand-empty">{player.out ? "You're out of cards" : "No cards"}</div>}
        </div>
      </div>
    </div>
  );
}
