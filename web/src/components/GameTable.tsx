// The whole table: opponents around the felt, talon, table pairs, discard and
// the bottom (human) panel. Used by the live game and by the replay viewer.
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { GameState } from "../api";
import { useI18n } from "../i18n";
import type { SortMode } from "../prefs";
import { DiscardPile, Opponent, TableCenter, Talon, type Bubble, type Dealing } from "./Board";
import { HumanPanel } from "./HumanPanel";

/** Positions (fractions of the board) of opponents around the top of the table. */
function ringPositions(k: number): { x: number; y: number }[] {
  const out = [];
  for (let i = 0; i < k; i++) {
    const theta = Math.PI - ((i + 1) * Math.PI) / (k + 1);
    out.push({ x: 0.5 + 0.41 * Math.cos(theta), y: 0.2 - 0.18 * Math.sin(theta) });
  }
  return out;
}

export interface GameTableProps {
  view: GameState;
  busy: boolean;
  thinkingSeat: number | null;
  bubbles: Record<number, Bubble>;
  dealing: Dealing | null;
  reveal: boolean;
  winProb: Record<string, number>;
  showWinProb: boolean;
  status: ReactNode;
  selected: number | null;
  onPlay: (a: number) => void;
  sort: SortMode;
  onSort: () => void;
  onHint?: () => void;
  hintAvailable: boolean;
  hintAction: number | null;
  hintOpen: boolean;
  overlay?: ReactNode; // e.g. the hint panel
  extraControls?: ReactNode;
  botLabelOf: (n: string) => string;
  boardExtra?: ReactNode;
}

export function GameTable(p: GameTableProps) {
  const { view } = p;
  const { t } = useI18n();
  const boardRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const el = boardRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth < 640));
    ro.observe(el);
    setNarrow(el.clientWidth < 640);
    return () => ro.disconnect();
  }, []);

  const n = view.num_players;
  const bottomSeat = view.human_seat ?? 0;
  const opponents = Array.from({ length: n - 1 }, (_, i) => view.players[(bottomSeat + 1 + i) % n]);
  const ring = ringPositions(opponents.length);
  const bottom = view.players[bottomSeat];
  const dealt = p.dealing?.dealt;
  const handCards = (() => {
    const all = bottom.hand ?? [];
    if (!dealt) return all;
    return all.slice(0, dealt[bottomSeat] ?? 0);
  })();
  const myWp = view.human_seat !== null && p.showWinProb && !view.done && !bottom.out ? p.winProb[String(view.human_seat)] : undefined;

  return (
    <section className="play-area" data-testid="play-area">
      <div className={`board ${narrow ? "layout-row" : "layout-ring"} opp-${opponents.length}`} ref={boardRef}>
        <div className="felt" />
        <div className="opponents">
          {opponents.map((o, i) => (
            <Opponent
              key={o.seat}
              player={o}
              state={view}
              style={narrow ? undefined : ({ left: `${ring[i].x * 100}%`, top: `${ring[i].y * 100}%` } as CSSProperties)}
              bubble={p.bubbles[o.seat]}
              thinking={p.thinkingSeat === o.seat}
              reveal={p.reveal}
              winProb={view.mode === "spectate" && p.showWinProb ? p.winProb[String(o.seat)] : undefined}
              botLabel={o.bot ? p.botLabelOf(o.bot) : undefined}
              count={dealt ? Math.min(o.hand_size, dealt[o.seat] ?? 0) : o.hand_size}
            />
          ))}
        </div>
        <div className="table-zone">
          <Talon state={view} dealing={p.dealing} />
          <TableCenter state={view} hintCard={p.hintAction} />
          <DiscardPile count={view.discard_count} />
        </div>
        {p.boardExtra}
        {view.stall >= 10 && !view.done && view.talon_size === 0 && (
          <div className="stall-chip" title="stalemate counter">
            ⟳ {view.stall}/30
          </div>
        )}
      </div>
      <div className="panel-wrap">
        {p.overlay}
        <HumanPanel
          state={view}
          player={bottom}
          status={p.status}
          busy={p.busy}
          selected={p.selected}
          onPlay={p.onPlay}
          bubble={p.bubbles[bottomSeat] ?? null}
          winProb={myWp}
          extraControls={p.extraControls}
          handCards={handCards}
          sort={p.sort}
          onSort={p.onSort}
          onHint={p.onHint}
          hintAvailable={p.hintAvailable}
          hintAction={p.hintAction}
          hintOpen={p.hintOpen}
        />
      </div>
      <span className="sr-only">{t("a11y.table")}</span>
    </section>
  );
}
