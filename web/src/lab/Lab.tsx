// Lab: training curves, evaluation history, promotions, eval summary,
// ladder and human-vs-bot results. Lazy-loaded.
import { useEffect, useMemo, useState } from "react";
import { api, type EvalEntry, type LabData } from "../api";
import { useI18n } from "../i18n";
import { ChartCard, LineChart, SERIES_COLORS, fmtNum, pctFmt, smooth, type Pt, type Series } from "./charts";

const NS = ["2", "3", "4", "5", "6"];

function Tile({ v, label }: { v: string; label: string }) {
  return (
    <div className="tile">
      <b>{v}</b>
      <span>{label}</span>
    </div>
  );
}

function ciText(r?: { rate?: number; ci?: [number, number] }) {
  if (!r || r.rate === undefined) return "—";
  return `${(r.rate * 100).toFixed(1)}%${r.ci ? ` [${(r.ci[0] * 100).toFixed(0)}–${(r.ci[1] * 100).toFixed(0)}]` : ""}`;
}

function RateBar({ rate, ci, baseline }: { rate?: number; ci?: [number, number]; baseline: number }) {
  if (rate === undefined) return <span className="muted">—</span>;
  const scale = (v: number) => `${Math.min(100, (v / Math.max(0.6, baseline * 1.6)) * 100)}%`;
  const good = rate < baseline;
  return (
    <div className="ratebar" title={ciText({ rate, ci })}>
      <div className="rb-track">
        {ci && <span className="rb-ci" style={{ left: scale(ci[0]), width: `calc(${scale(ci[1])} - ${scale(ci[0])})` }} />}
        <span className="rb-base" style={{ left: scale(baseline) }} />
        <span className={`rb-dot ${good ? "good" : "bad"}`} style={{ left: scale(rate) }} />
      </div>
      <span className={`rb-val ${good ? "good" : "bad"}`}>{(rate * 100).toFixed(1)}%</span>
    </div>
  );
}

export default function Lab({ onBack, botLabelOf }: { onBack: () => void; botLabelOf: (n: string) => string }) {
  const { t } = useI18n();
  const [data, setData] = useState<LabData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [run, setRun] = useState<string>("main");
  const [ladderN, setLadderN] = useState<string>("2");
  const [tables, setTables] = useState(false);
  const [evalOpp, setEvalOpp] = useState("heuristic");

  useEffect(() => {
    let alive = true;
    const load = () =>
      api.lab(run).then(
        (d) => alive && (setData(d), setErr(null)),
        (e) => alive && setErr(String(e)),
      );
    load();
    const id = setInterval(load, 30000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [run]);

  const train = data?.train;
  const S = train?.series ?? {};
  const xIter = S.iter ?? [];

  const mk = (key: string, win = 1): Pt[] =>
    smooth(
      xIter.map((x, i) => ({ x: x ?? i, y: S[key]?.[i] ?? null })),
      win,
    );

  const trainDurak: Series[] = useMemo(
    () =>
      NS.map((n, i) => ({
        key: n,
        label: t("lab.n", { n }),
        color: SERIES_COLORS[i],
        points: smooth(
          xIter.map((x, j) => ({ x: x ?? j, y: S[`durak_${n}p_vs_heuristic`]?.[j] ?? null })),
          15,
        ),
      })).filter((s) => s.points.some((p) => p.y !== null)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, t],
  );

  const evals: EvalEntry[] = data?.evals ?? [];
  const promos = data?.promotions ?? [];
  const promotedIters = new Set(promos.filter((p) => p.promoted !== false).map((p) => p.iter));
  const opps = [...new Set(evals.flatMap((e) => Object.keys(e.rates ?? {})))].filter((o) => o !== "champ");
  const evalSeries: Series[] = NS.map((n, i) => ({
    key: n,
    label: t("lab.n", { n }),
    color: SERIES_COLORS[i],
    points: evals
      .filter((e) => e.iter !== undefined)
      .map((e) => {
        const r = e.rates?.[evalOpp]?.[n];
        return { x: e.iter as number, y: r?.rate ?? null, lo: r?.ci?.[0] ?? null, hi: r?.ci?.[1] ?? null };
      }),
  })).filter((s) => s.points.some((p) => p.y !== null));
  const evalRefs = evalSeries.map((s) => ({ y: 1 / Number(s.key), color: s.color }));
  const evalMarkers = evals.filter((e) => e.iter !== undefined && (e.promoted || promotedIters.has(e.iter))).map((e) => ({ x: e.iter as number, label: "★" }));

  // Human vs bots: rolling durak rate over games.
  const human = data?.human ?? [];
  const rolling: Pt[] = human.map((_, i) => {
    const win = human.slice(Math.max(0, i - 9), i + 1);
    return { x: i + 1, y: win.filter((x) => x.result === "durak").length / win.length };
  });
  const fair: Pt[] = human.map((_, i) => {
    const win = human.slice(Math.max(0, i - 9), i + 1);
    return { x: i + 1, y: win.reduce((a, x) => a + 1 / x.num_players, 0) / win.length };
  });
  const byBot = new Map<string, { games: number; durak: number; fair: number }>();
  for (const g of human)
    for (const b of g.bots) {
      const r = byBot.get(b) ?? { games: 0, durak: 0, fair: 0 };
      r.games++;
      r.durak += g.result === "durak" ? 1 : 0;
      r.fair += 1 / g.num_players;
      byBot.set(b, r);
    }

  const last = (k: string) => {
    const v = S[k];
    if (!v) return null;
    for (let i = v.length - 1; i >= 0; i--) if (v[i] !== null) return v[i];
    return null;
  };
  const summary = data?.eval_summary;
  const ladder = data?.ladder;
  const ladderNs = ladder?.by_n ? Object.keys(ladder.by_n).sort() : [];
  const lN = ladderNs.includes(ladderN) ? ladderN : ladderNs[0];
  const champ = data?.champion;

  return (
    <div className="lab">
      <div className="lab-head">
        <div>
          <h1>{t("lab.title")}</h1>
          <p className="muted">{t("lab.subtitle")}</p>
        </div>
        <div className="lab-controls">
          {data && data.runs.length > 1 && (
            <label className="speed">
              <span>{t("lab.run")}</span>
              <select value={data.run} onChange={(e) => setRun(e.target.value)}>
                {data.runs.map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            </label>
          )}
          {data && (
            <span className={`live ${data.training_active ? "on" : ""}`}>
              <i /> {data.training_active ? t("lab.active") : t("lab.idle")}
            </span>
          )}
          <button type="button" className="chip" onClick={() => setTables((x) => !x)} aria-pressed={tables}>
            {tables ? t("lab.chart") : t("lab.table")}
          </button>
          <button type="button" className="btn btn--sm" onClick={onBack}>
            {t("lab.back")}
          </button>
        </div>
      </div>
      {err && <div className="error">{err}</div>}
      {!data && !err && <div className="loading">{t("loading")}</div>}
      {data && (
        <>
          <div className="stat-tiles lab-tiles">
            <Tile v={last("iter") !== null ? fmtNum(last("iter") as number) : "—"} label={t("lab.iterations")} />
            <Tile v={last("steps") !== null ? fmtNum(last("steps") as number) : "—"} label={t("lab.steps")} />
            <Tile v={last("hours") !== null ? (last("hours") as number).toFixed(1) : "—"} label={t("lab.hours")} />
            <Tile v={last("games") !== null ? fmtNum(last("games") as number) : "—"} label={t("lab.gamesPlayed")} />
            <Tile v={champ?.iter !== undefined ? `#${champ.iter}` : "—"} label={`${t("lab.championLabel")}${champ?.time ? ` · ${champ.time.slice(5, 16)}` : ""}`} />
          </div>

          {train ? (
            <>
              <h2>{t("lab.training")}</h2>
              <div className="chart-grid">
                {[
                  ["entropy", "lab.entropy"],
                  ["kl", "lab.kl"],
                  ["explained_var", "lab.ev"],
                  ["v_loss", "lab.vloss"],
                  ["bel_acc", "lab.belAcc"],
                  ["draw_frac", "lab.drawFrac"],
                ]
                  .filter(([k]) => S[k])
                  .map(([k, label], i) => (
                    <ChartCard key={k} title={t(label)}>
                      <LineChart
                        ariaLabel={t(label)}
                        height={170}
                        xLabel={t("lab.iterAxis")}
                        series={[{ key: k, label: t(label), color: SERIES_COLORS[i % 3 === 0 ? 0 : i], points: mk(k, 9) }]}
                      />
                    </ChartCard>
                  ))}
                {S.steps && (
                  <ChartCard title={t("lab.stepsChart")}>
                    <LineChart ariaLabel={t("lab.stepsChart")} height={170} xLabel={t("lab.iterAxis")} series={[{ key: "steps", label: t("lab.steps"), color: SERIES_COLORS[2], points: mk("steps") }]} />
                  </ChartCard>
                )}
                {trainDurak.length > 0 && (
                  <ChartCard title={t("lab.trainDurak")}>
                    <LineChart ariaLabel={t("lab.trainDurak")} height={170} xLabel={t("lab.iterAxis")} yFormat={pctFmt} series={trainDurak} />
                  </ChartCard>
                )}
              </div>
            </>
          ) : (
            <p className="muted">{t("lab.noData")}</p>
          )}

          {evalSeries.length > 0 && (
            <ChartCard
              title={t("lab.evalHistory", { opp: botLabelOf(evalOpp) })}
              note={t("lab.evalNote")}
              actions={
                opps.length > 1 ? (
                  <select value={evalOpp} onChange={(e) => setEvalOpp(e.target.value)} aria-label={t("lab.opp")}>
                    {opps.map((o) => (
                      <option key={o} value={o}>
                        {botLabelOf(o)}
                      </option>
                    ))}
                  </select>
                ) : null
              }
            >
              {tables ? (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>{t("lab.iter")}</th>
                        {evalSeries.map((s) => (
                          <th key={s.key}>{s.label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {evals.map((e) => (
                        <tr key={e.iter}>
                          <td>
                            {e.iter}
                            {promotedIters.has(e.iter) ? " ★" : ""}
                          </td>
                          {evalSeries.map((s) => (
                            <td key={s.key}>{ciText(e.rates?.[evalOpp]?.[s.key])}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <LineChart
                  ariaLabel={t("lab.evalHistory", { opp: evalOpp })}
                  height={260}
                  xLabel={t("lab.iterAxis")}
                  yFormat={pctFmt}
                  series={evalSeries}
                  refLines={evalRefs}
                  markers={evalMarkers}
                />
              )}
            </ChartCard>
          )}

            <ChartCard title={t("lab.summary")} note={summary?.updated ? t("lab.updated", { t: summary.updated }) : undefined}>
            {summary?.results && Object.keys(summary.results).length ? (
              <div className="table-wrap">
                <table className="summary-table">
                  <thead>
                    <tr>
                      <th>{t("lab.opp")}</th>
                      {NS.map((n) => (
                        <th key={n}>{t("lab.n", { n })}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(summary.results).map(([opp, byN]) => (
                      <tr key={opp}>
                        <td>
                          <span className="bot-tag">{botLabelOf(opp)}</span>
                        </td>
                        {NS.map((n) => (
                          <td key={n}>
                            <RateBar rate={byN?.[n]?.rate} ci={byN?.[n]?.ci} baseline={1 / Number(n)} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted">{t("lab.summaryNone")}</p>
            )}
          </ChartCard>

          <div className="lab-two">
            <ChartCard title={t("lab.promotions")}>
              {promos.length ? (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>{t("lab.iter")}</th>
                        <th>{t("lab.time")}</th>
                        {NS.map((n) => (
                          <th key={n}>{t("lab.n", { n })}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {[...promos].reverse().map((p, i) => (
                        <tr key={i}>
                          <td>
                            <b>{p.iter}</b> {p.promoted === false ? <span className="mini-tag">{t("lab.rejected")}</span> : <span className="mini-tag gold">★</span>}
                          </td>
                          <td className="muted">{p.time ?? "—"}</td>
                          {NS.map((n) => (
                            <td key={n}>{p.rates?.heuristic?.[n]?.rate !== undefined ? pctFmt(p.rates.heuristic[n].rate as number) : "—"}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="muted">{t("lab.noData")}</p>
              )}
            </ChartCard>
            <ChartCard
              title={t("lab.ladder")}
              note={ladder?.updated ? t("lab.updated", { t: ladder.updated }) : undefined}
              actions={
                ladderNs.length > 1 ? (
                  <div className="seg small-seg">
                    {ladderNs.map((n) => (
                      <button key={n} type="button" className={n === lN ? "on" : ""} onClick={() => setLadderN(n)} aria-pressed={n === lN}>
                        {t("lab.n", { n })}
                      </button>
                    ))}
                  </div>
                ) : null
              }
            >
              {ladder && lN && ladder.by_n[lN]?.length ? (
                <div className="ladder">
                  {(() => {
                    const rows = ladder.by_n[lN];
                    const lo = Math.min(...rows.map((r) => r.elo));
                    const hi = Math.max(...rows.map((r) => r.elo));
                    return rows.map((r, i) => (
                      <div key={r.bot} className="ladder-row">
                        <span className="rank">{i + 1}</span>
                        <span className="bot-tag">{botLabelOf(r.bot)}</span>
                        <span className="ladder-bar">
                          <span style={{ width: `${hi === lo ? 100 : 12 + ((r.elo - lo) / (hi - lo)) * 88}%` }} />
                        </span>
                        <b>{Math.round(r.elo)}</b>
                      </div>
                    ));
                  })()}
                </div>
              ) : (
                <p className="muted">{t("lab.ladderNone")}</p>
              )}
            </ChartCard>

            <ChartCard title={t("lab.human")} wide>
              {human.length ? (
                <>
                  <LineChart
                    ariaLabel={t("lab.rolling")}
                    height={180}
                    xLabel={t("lab.gameAxis")}
                    yFormat={pctFmt}
                    yDomain={[0, 1]}
                    series={[
                      { key: "you", label: t("lab.rolling"), color: SERIES_COLORS[1], points: rolling },
                      { key: "fair", label: t("stats.fair"), color: "#8a6d4e", points: fair, dashed: true },
                    ]}
                  />
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>{t("stats.bot")}</th>
                          <th>{t("stats.gamesCol")}</th>
                          <th>{t("stats.youDurak")}</th>
                          <th>{t("stats.fair")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...byBot.entries()].map(([b, r]) => (
                          <tr key={b}>
                            <td>
                              <span className="bot-tag">{botLabelOf(b)}</span>
                            </td>
                            <td>{r.games}</td>
                            <td className={r.durak / r.games > r.fair / r.games ? "bad" : "good"}>{pctFmt(r.durak / r.games)}</td>
                            <td className="muted">{pctFmt(r.fair / r.games)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <p className="muted">{t("lab.humanNone")}</p>
              )}
            </ChartCard>
          </div>
        </>
      )}
    </div>
  );
}
