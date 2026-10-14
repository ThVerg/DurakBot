// Post-game replay with a scrubber, the win-probability graph and the
// human's biggest mistakes (computed server-side from the human's info set).
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Analysis, type ReplayFrame } from "../api";
import { cardLabel, isRed, PASS } from "../cards";
import { Rich, useI18n } from "../i18n";
import { LineChart, pctFmt } from "../lab/charts";
import type { SortMode } from "../prefs";
import { ActionChip } from "./Coach";
import { GameTable } from "./GameTable";

export default function Replay({
  gameId,
  onClose,
  sort,
  botLabelOf,
}: {
  gameId: string;
  onClose: () => void;
  sort: SortMode;
  botLabelOf: (n: string) => string;
}) {
  const { t } = useI18n();
  const [frames, setFrames] = useState<ReplayFrame[] | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [k, setK] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
    const id = setTimeout(() => setK((x) => x + 1), 650);
    return () => clearTimeout(id);
  }, [playing, k, n]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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

  const frame = frames?.[k];
  const decisionAt = useMemo(() => {
    const m = new Map<number, NonNullable<Analysis["decisions"]>[number]>();
    for (const d of analysis?.decisions ?? []) m.set(d.seq + 1, d);
    return m;
  }, [analysis]);
  const mistakeSeqs = new Set((analysis?.mistakes ?? []).map((d) => d.seq + 1));

  if (err) return <div className="replay"><div className="error">{err}</div></div>;
  if (!frames || !frame) return <div className="replay"><div className="loading">{t("loading")}</div></div>;

  const step = frame.step;
  const humanSeat = frame.view.human_seat;
  const d = decisionAt.get(k);
  // Label of PASS at the position *before* move ``seq`` (bita / pass / take / done).
  const passLabelOf = (seq: number) => frames[seq]?.view.pass_label ?? null;
  const label = (a: number, seq: number) => {
    if (a !== PASS) return <span className={`log-card suit-${Math.floor(a / 9)} ${isRed(a) ? "red" : "black"}`}>{cardLabel(a)}</span>;
    return <b>{t(`pass.${passLabelOf(seq) ?? "pass"}`)}</b>;
  };

  const timeline = analysis?.timeline ?? [];
  return (
    <div className="replay" data-testid="replay">
      <div className="replay-main">
        <GameTable
          view={frame.view}
          busy={true}
          thinkingSeat={null}
          bubbles={{}}
          dealing={null}
          reveal={frame.view.mode === "spectate"}
          winProb={{}}
          showWinProb={false}
          status={
            step ? (
              <span>
                {t("replay.move", { k, n })}
                {step.player === humanSeat && d && d.loss >= 0.04 ? <span className="mini-tag bad" style={{ marginLeft: 8 }}>{t("replay.loss", { p: Math.round(d.loss * 100) })}</span> : null}
              </span>
            ) : (
              t("replay.start")
            )
          }
          selected={step?.card ?? null}
          onPlay={() => undefined}
          sort={sort}
          onSort={() => undefined}
          hintAvailable={false}
          hintAction={null}
          hintOpen={false}
          botLabelOf={botLabelOf}
        />
      </div>
      <aside className="replay-side">
        <div className="replay-head">
          <h2>{t("replay.title")}</h2>
          <button type="button" className="btn primary small" onClick={onClose} data-testid="replay-close">
            {t("replay.back")}
          </button>
        </div>
        <div className="scrubber">
          <button type="button" className="icon-btn" onClick={() => go(k - 1)} aria-label={t("replay.prev")}>
            ◀
          </button>
          <button type="button" className="icon-btn" onClick={() => setPlaying((p) => !p)} aria-label={t("replay.playPause")}>
            {playing ? "❚❚" : "▶"}
          </button>
          <button type="button" className="icon-btn" onClick={() => go(k + 1)} aria-label={t("replay.next")}>
            ▶▶
          </button>
          <input
            type="range"
            min={0}
            max={n}
            value={k}
            onChange={(e) => go(Number(e.target.value))}
            aria-label={t("replay.move", { k, n })}
            data-testid="scrubber"
          />
          <span className="muted small">
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
          <div className="replay-graph" onClick={(e) => {
            const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
            const f = (e.clientX - r.left - 44) / (r.width - 58);
            if (f >= 0 && f <= 1) go(Math.round(f * n));
          }}>
            <LineChart
              ariaLabel={t("replay.graph")}
              height={170}
              yDomain={[0, 1]}
              yFormat={pctFmt}
              series={[{ key: "win", label: t("replay.graph"), color: "#3987e5", points: timeline.map((p) => ({ x: p.seq, y: p.win })) }]}
              markers={[{ x: k, label: "▼" }, ...[...mistakeSeqs].map((s) => ({ x: s - 1, label: "!" }))]}
            />
          </div>
        )}
        {analysis?.status === "ready" && (
          <>
            <div className="replay-acc">
              {analysis.accuracy !== null && analysis.accuracy !== undefined && <span className="mini-tag gold">{t("replay.accuracy", { p: Math.round(analysis.accuracy * 100) })}</span>}
            </div>
            <h3>{t("replay.mistakes")}</h3>
            {(analysis.mistakes ?? []).length === 0 ? (
              <p className="muted">{t("replay.noMistakes")}</p>
            ) : (
              <ul className="mistakes">
                {(analysis.mistakes ?? []).map((m) => (
                  <li key={m.seq}>
                    <button type="button" className={`mistake ${k === m.seq + 1 ? "on" : ""}`} onClick={() => go(m.seq + 1)} data-testid="mistake">
                      <span className="mk-move">#{m.seq + 1}</span>
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
            <div className="muted small">{t("hint.win")}</div>
            <ul className="hint-moves">
              {d.values.map((v) => (
                <li key={v.action} className={v.action === d.chosen ? "chosen" : v.action === d.best ? "rec" : ""}>
                  <div className="hint-move">
                    <ActionChip action={v.action} passLabel={passLabelOf(d.seq)} />
                    <span className="bar">
                      <span style={{ width: `${Math.round(v.win * 100)}%` }} />
                    </span>
                    <b>{Math.round(v.win * 100)}%</b>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="muted small">{t("replay.note")}</p>
      </aside>
    </div>
  );
}
