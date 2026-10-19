// Post-game replay: the same 2D table (read-only) with a notebook side panel:
// scrubber, the win-probability graph and the human's biggest mistakes
// (computed server-side from the human's information set only).
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Analysis, type PassLabel, type ReplayFrame } from "../api";
import { PASS } from "../cards";
import { Rich, useI18n } from "../i18n";
import { LineChart, pctFmt } from "../lab/charts";
import type { SortMode } from "../prefs";
import { Icon } from "./Icons";
import { Scene, type StageDims } from "./Scene";
import { CardChip } from "./Sheets";
import { TableView, type TableApi } from "./table/TableView";

function useReplayDims(): StageDims {
  const calc = (): StageDims => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const phone = vw < 760 || vw / vh < 0.82;
    if (phone) {
      const ah = Math.max(420, vh - 250);
      const s = Math.min(vw / 390, ah / 844);
      return { layout: "m", s, W: vw / s, H: ah / s };
    }
    const aw = Math.max(640, vw - 420);
    const s = Math.min(aw / 1440, vh / 900);
    return { layout: "d", s, W: aw / s, H: vh / s };
  };
  const [d, setD] = useState(calc);
  useEffect(() => {
    const on = () => setD(calc());
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return d;
}

function ActionChip({ action, passLabel }: { action: number; passLabel: PassLabel | null }) {
  const { t } = useI18n();
  if (action === PASS) return <span className={`passchip passchip--${passLabel ?? "pass"}`}>{t(`pass.${passLabel ?? "pass"}`)}</span>;
  return <CardChip c={action} />;
}

export default function Replay({
  gameId,
  onClose,
  sort,
  back,
  four,
  felt,
  levelOf,
}: {
  gameId: string;
  onClose: () => void;
  sort: SortMode;
  back: string;
  four: boolean;
  felt: string;
  levelOf: (bot: string) => string;
}) {
  const { t } = useI18n();
  const dims = useReplayDims();
  const [frames, setFrames] = useState<ReplayFrame[] | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [k, setK] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const apiRef = useMemo(() => ({ current: null as TableApi | null }), []);

  useEffect(() => {
    api.replay(gameId).then(
      (r) => {
        setFrames(r.frames);
        setK(r.frames.length - 1);
      },
      (e) => setErr(String(e)),
    );
  }, [gameId]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = () =>
      api.analysis(gameId).then(
        (a) => {
          if (!alive) return;
          setAnalysis(a);
          if (a.status === "running") timer = setTimeout(poll, 700);
        },
        () => alive && setAnalysis({ status: "unavailable" }),
      );
    poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [gameId]);

  const n = frames ? frames.length - 1 : 0;
  const go = useCallback((v: number) => setK(Math.max(0, Math.min(n, v))), [n]);

  useEffect(() => {
    if (!playing) return;
    if (k >= n) {
      setPlaying(false);
      return;
    }
    const id = setTimeout(() => setK((x) => x + 1), 700);
    return () => clearTimeout(id);
  }, [playing, k, n]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT" && e.key !== "Escape") return;
      if (e.key === "ArrowRight") go(k + 1);
      else if (e.key === "ArrowLeft") go(k - 1);
      else if (e.key === " ") {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.key === "Home") go(0);
      else if (e.key === "End") go(n);
      else if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [k, n, go, onClose]);

  const decisionAt = useMemo(() => {
    const m = new Map<number, NonNullable<Analysis["decisions"]>[number]>();
    for (const d of analysis?.decisions ?? []) m.set(d.seq + 1, d);
    return m;
  }, [analysis]);
  const mistakeSeqs = new Set((analysis?.mistakes ?? []).map((d) => d.seq + 1));

  const frame = frames?.[k];
  if (err || !frames || !frame)
    return (
      <div className="replay replay--loading" data-testid="replay">
        <Scene variant="lobby" dims={dims} />
        <div className="replay__msg paper">{err ?? <span className="spin" />}</div>
      </div>
    );

  const step = frame.step;
  const humanSeat = frame.view.human_seat;
  const d = decisionAt.get(k);
  const passLabelOf = (seq: number) => frames[seq]?.view.pass_label ?? null;
  const label = (a: number, seq: number) => <ActionChip action={a} passLabel={passLabelOf(seq)} />;
  const lossHere = step && step.player === humanSeat && d && d.loss >= 0.04 ? d.loss : null;
  const timeline = analysis?.timeline ?? [];

  return (
    <div className={`replay replay--${dims.layout}`} data-testid="replay">
      <Scene variant="table" dims={dims} felt={felt} />
      <TableView
        view={frame.view}
        step={step}
        dims={dims}
        sort={sort}
        back={back}
        four={four}
        speed={0.55}
        canAct={false}
        selected={null}
        hint={{ open: false, loading: false, data: null }}
        bubbles={{}}
        thinkingSeat={null}
        levelOf={levelOf}
        ribbon={{
          main: step ? t("replay.move", { k, n }) : t("replay.start"),
          sub: lossHere !== null ? <span className="lossnote">{t("replay.loss", { p: Math.round(lossHere * 100) })}</span> : null,
          tone: lossHere !== null ? "you" : "wait",
        }}
        primary={{ kind: "wait", enabled: false, onClick: () => undefined }}
        onPlay={() => undefined}
        busy={false}
        apiRef={apiRef}
        topbar={{ onHome: onClose, onLog: () => undefined, logDot: false, sound: false, onSound: () => undefined, onSettings: () => undefined }}
        onSort={() => undefined}
        logOpen={false}
        onLogClose={() => undefined}
        readOnly
      />
      <aside className="replay-side" aria-label={t("replay.title")}>
        <div className="replay-side__paper">
          <header className="replay-side__head">
            <div>
              <span className="ru" lang="ru">
                Разбор партии
              </span>
              <h2 className="display">{t("replay.title")}</h2>
            </div>
            <button type="button" className="btn btn--sm" onClick={onClose} data-testid="replay-close">
              <Icon name="back" />
              {t("replay.back")}
            </button>
          </header>
          <div className="scrubber">
            <button type="button" className="ibtn ibtn--sm" onClick={() => go(k - 1)} aria-label={t("replay.prev")}>
              <Icon name="back" />
            </button>
            <button type="button" className="ibtn ibtn--sm" onClick={() => setPlaying((p) => !p)} aria-label={t("replay.playPause")}>
              <Icon name={playing ? "pause" : "play"} />
            </button>
            <button type="button" className="ibtn ibtn--sm" onClick={() => go(k + 1)} aria-label={t("replay.next")}>
              <Icon name="step" />
            </button>
            <input type="range" min={0} max={n} value={k} onChange={(e) => go(Number(e.target.value))} aria-label={t("replay.move", { k, n })} data-testid="scrubber" />
            <span className="scrubber__n">
              {k}/{n}
            </span>
          </div>

          <h3>{t("replay.graph")}</h3>
          {analysis?.status === "running" && (
            <div className="progress">
              <div style={{ width: `${Math.round((analysis.progress ?? 0) * 100)}%` }} />
              <span>{t("replay.analyzing", { p: Math.round((analysis.progress ?? 0) * 100) })}</span>
            </div>
          )}
          {(analysis?.status === "unavailable" || analysis?.status === "error") && <p className="muted">{t("replay.unavailable")}</p>}
          {timeline.length > 0 && (
            <div
              className="replay-graph"
              onClick={(e) => {
                const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                const f = (e.clientX - r.left - 44) / (r.width - 58);
                if (f >= 0 && f <= 1) go(Math.round(f * n));
              }}
            >
              <LineChart
                ariaLabel={t("replay.graph")}
                height={dims.layout === "m" ? 120 : 160}
                yDomain={[0, 1]}
                yFormat={pctFmt}
                series={[{ key: "win", label: t("replay.graph"), color: "#2350b4", points: timeline.map((p) => ({ x: p.seq, y: p.win })) }]}
                markers={[{ x: k, label: "▼" }, ...[...mistakeSeqs].map((s) => ({ x: s - 1, label: "!" }))]}
              />
            </div>
          )}
          {analysis?.status === "ready" && (
            <>
              {analysis.accuracy !== null && analysis.accuracy !== undefined && (
                <div className="replay-acc">
                  <Icon name="laurel" /> {t("replay.accuracy", { p: Math.round(analysis.accuracy * 100) })}
                </div>
              )}
              <h3>{t("replay.mistakes")}</h3>
              {(analysis.mistakes ?? []).length === 0 ? (
                <p className="muted">{t("replay.noMistakes")}</p>
              ) : (
                <ul className="mistakes">
                  {(analysis.mistakes ?? []).map((m) => (
                    <li key={m.seq}>
                      <button type="button" className={`mistake ${k === m.seq + 1 ? "is-on" : ""}`} onClick={() => go(m.seq + 1)} data-testid="mistake">
                        <span className="mistake__n">#{m.seq + 1}</span>
                        <span>
                          <Rich text={t("replay.played", { a: "{a}" })} nodes={{ a: label(m.chosen, m.seq) }} />{" "}
                          <span className="muted">
                            (<Rich text={t("replay.better", { b: "{b}" })} nodes={{ b: label(m.best, m.seq) }} />)
                          </span>
                        </span>
                        <b className="bad">{t("replay.loss", { p: Math.round(m.loss * 100) })}</b>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          {d && (
            <div className="decision">
              <div className="field__label">{t("hint.win")}</div>
              <ul className="bars">
                {d.values.map((v) => (
                  <li key={v.action} className={v.action === d.chosen ? "is-chosen" : v.action === d.best ? "is-best" : ""}>
                    <ActionChip action={v.action} passLabel={passLabelOf(d.seq)} />
                    <span className="bar">
                      <span style={{ width: `${Math.round(v.win * 100)}%` }} />
                    </span>
                    <b>{Math.round(v.win * 100)}%</b>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="note">{t("replay.note")}</p>
        </div>
      </aside>
    </div>
  );
}
