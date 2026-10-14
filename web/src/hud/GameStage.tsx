// The 3D stage: WebGL table (lazy) + crisp HTML HUD on top.
import { Suspense, lazy, type ReactNode } from "react";
import type { GameState, Step } from "../api";
import { PASS, cardLabel, sortHand } from "../cards";
import type { Bubble } from "../components/Board";
import { useI18n } from "../i18n";
import type { SortMode } from "../prefs";
import type { Quality, SceneApi } from "../three/Scene3D";
import { useEffect, useState } from "react";
import { Plaque, SeatChip } from "./Plaque";

function usePortrait() {
  const q = "(max-aspect-ratio: 19/20)";
  const [p, setP] = useState(() => typeof window !== "undefined" && window.matchMedia?.(q).matches);
  useEffect(() => {
    const m = window.matchMedia?.(q);
    if (!m) return;
    const on = () => setP(m.matches);
    m.addEventListener?.("change", on);
    return () => m.removeEventListener?.("change", on);
  }, []);
  return p;
}

const Scene3D = lazy(() => import("../three/Scene3D"));

export interface GameStageProps {
  view: GameState;
  step: Step | null;
  busy: boolean;
  thinkingSeat: number | null;
  bubbles: Record<number, Bubble>;
  reveal: boolean;
  winProb: Record<string, number>;
  showWinProb: boolean;
  status: ReactNode;
  statusTone: "you" | "wait" | "over" | "info";
  selected: number | null;
  onPlay: (a: number) => void;
  sort: SortMode;
  onSort: () => void;
  onHint?: () => void;
  hintAvailable: boolean;
  hintAction: number | null;
  hintOpen: boolean;
  overlay?: ReactNode;
  extraControls?: ReactNode;
  botLabelOf: (n: string) => string;
  boardExtra?: ReactNode;
  speed: number;
  quality: Quality;
  theme: string;
  back: string;
  fourColor: boolean;
  apiRef: { current: SceneApi | null };
  onSound: (k: "snap" | "deal") => void;
  /** render the WebGL scene here (replay); the live game shares an app-level canvas */
  embedScene?: boolean;
}

function WinRing({ p, label }: { p: number; label: string }) {
  const pct = Math.round(p * 100);
  const r = 17;
  const c = 2 * Math.PI * r;
  return (
    <div className="win-ring" title={label} role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <svg viewBox="0 0 44 44" width="44" height="44" aria-hidden="true">
        <circle cx="22" cy="22" r={r} className="wr-track" />
        <circle cx="22" cy="22" r={r} className="wr-val" strokeDasharray={`${(c * pct) / 100} ${c}`} transform="rotate(-90 22 22)" />
      </svg>
      <b>{pct}</b>
    </div>
  );
}

export function GameStage(p: GameStageProps) {
  const { t } = useI18n();
  const { view } = p;
  const bottomSeat = view.human_seat ?? 0;
  const me = view.players[bottomSeat];
  const canAct = view.your_turn && !p.busy;
  const legal = new Set(canAct ? view.legal : []);
  const pl = view.pass_label;
  const myWp = view.human_seat !== null && p.showWinProb && !view.done && !me.out ? p.winProb[String(view.human_seat)] : undefined;
  const legalCards = sortHand(view.hand, view.trump_suit, p.sort).filter((c) => legal.has(c));
  const portrait = usePortrait();
  const n = view.num_players;
  const opponents = Array.from({ length: n - 1 }, (_, i) => view.players[(bottomSeat + 1 + i) % n]);

  return (
    <section className={`stage ${canAct ? "my-turn" : ""} ${p.embedScene === false ? "hud-only" : ""}`} data-testid="play-area">
      {p.embedScene !== false && (
      <Suspense fallback={<div className="stage-loading"><span className="spinner" /></div>}>
        <Scene3D
          view={view}
          step={p.step}
          sort={p.sort}
          reveal={p.reveal}
          legal={legal}
          canAct={canAct}
          hintAction={p.hintAction}
          selected={p.selected}
          onPlay={p.onPlay}
          speed={p.speed}
          quality={p.quality}
          theme={p.theme}
          back={p.back}
          fourColor={p.fourColor}
          bubbles={p.bubbles}
          thinkingSeat={p.thinkingSeat}
          winProb={p.winProb}
          showWinProb={p.showWinProb}
          botLabelOf={p.botLabelOf}
          apiRef={p.apiRef}
          onSound={p.onSound}
        />
      </Suspense>
      )}

      <div className="hud">
        <div className={`status-banner tone-${p.statusTone}`} aria-live="polite" data-testid="status">
          <div className="sb-main">{p.status}</div>
          {!view.done && (
            <div className="sb-sub">
              {t("table.bout", { b: view.bout + 1 })} · {t("table.cards", { a: view.table.length, l: view.bout_limit })}
              {view.first_bout ? ` · ${t("table.first")}` : ""}
              <span className="sb-trump">
                {t("talon.trump")} <span className={`log-card suit-${view.trump_suit}`}>{["♠", "♣", "♦", "♥"][view.trump_suit]}&#xFE0E;</span>
              </span>
              {view.stall >= 10 && view.talon_size === 0 && <span className="sb-stall">⟳ {view.stall}/30</span>}
            </div>
          )}
        </div>

        {p.boardExtra}
        {portrait && (
          <div className={`opp-row n${opponents.length}`} data-testid="opp-row">
            {opponents.map((o) => (
              <SeatChip key={o.seat} player={o} state={view} thinking={p.thinkingSeat === o.seat} bubble={p.bubbles[o.seat]} />
            ))}
          </div>
        )}

        <div className="hud-bottom">
          <div className="hud-me">
            <Plaque player={me} state={view} thinking={false} bubble={p.bubbles[bottomSeat] ?? null} botLabel={view.mode === "spectate" && me.bot ? p.botLabelOf(me.bot) : undefined} />
            {myWp !== undefined && <WinRing p={myWp} label={t("hint.win")} />}
          </div>
          <div className="hud-actions">
            {view.mode === "play" && !me.out && !view.done && (
              <>
                <button
                  type="button"
                  className="hud-btn icon"
                  onClick={p.onSort}
                  title={`${t("hand.sort")}: ${p.sort === "suit" ? t("hand.sortSuit") : t("hand.sortRank")}`}
                  aria-label={`${t("hand.sort")}: ${p.sort === "suit" ? t("hand.sortSuit") : t("hand.sortRank")}`}
                >
                  {p.sort === "suit" ? "♠♥" : "6→A"}
                </button>
                {p.onHint && (
                  <button
                    type="button"
                    className={`hud-btn hint-btn ${p.hintOpen ? "on" : ""}`}
                    onClick={p.onHint}
                    disabled={!canAct || !p.hintAvailable}
                    data-testid="hint"
                    title={`${t("hint.button")} (H)`}
                  >
                    <span aria-hidden="true">✦</span>
                  <span className="hint-label">{t("hint.button")}</span>
                  </button>
                )}
              </>
            )}
            {view.mode === "play" && pl && (
              <button
                type="button"
                className={`primary-action pass-${pl} ${p.hintAction === PASS ? "hinted" : ""}`}
                disabled={!canAct || !legal.has(PASS)}
                onClick={() => p.onPlay(PASS)}
                title={t(`passHelp.${pl}`)}
                data-testid="pass"
              >
                <span className="pa-label">{t(`pass.${pl}`)}</span>
                <kbd>Space</kbd>
              </button>
            )}
            {p.extraControls}
          </div>
        </div>
        {p.overlay}
        {/* invisible regions for the tutorial spotlight */}
        <div className="tut-region tut-hand" aria-hidden="true" />
        <div className="tut-region tut-table" aria-hidden="true" />
        <div className="tut-region tut-talon" aria-hidden="true" />
        <div className="tut-region tut-opps" aria-hidden="true" />
        {/* Accessible / keyboard path to the 3D hand */}
        <div className="sr-only" role="group" aria-label={t("a11y.hand")}>
          {legalCards.map((c, i) => (
            <button key={c} type="button" onClick={() => p.onPlay(c)} data-testid={`hand-card-${c}`}>
              {i + 1}: {cardLabel(c)}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
