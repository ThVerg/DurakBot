// Small hand-built SVG charts: multi-series line chart with optional CI
// bands, reference lines, markers, crosshair tooltip, legend + end labels.
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

// Categorical palette on warm paper (Dacha inks).
export const SERIES_COLORS = ["#2350b4", "#c8361f", "#2f6b45", "#c98500", "#8a4fb0", "#4f78d2", "#e2563a", "#6f9e3a"];

export interface Pt {
  x: number;
  y: number | null;
  lo?: number | null;
  hi?: number | null;
}

export interface Series {
  key: string;
  label: string;
  color: string;
  points: Pt[];
  dashed?: boolean;
}

export interface RefLine {
  y: number;
  color: string;
  label?: string;
}

export interface Marker {
  x: number;
  label: string;
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

function niceTicks(lo: number, hi: number, count = 4): number[] {
  if (!isFinite(lo) || !isFinite(hi)) return [];
  if (hi === lo) return [lo];
  const span = hi - lo;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toPrecision(12));
  return out;
}

export function fmtNum(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  if (a >= 10 || Number.isInteger(v)) return v.toFixed(0);
  if (a >= 1) return v.toFixed(1);
  return v.toFixed(a >= 0.1 ? 2 : 3);
}

export const pctFmt = (v: number) => `${Math.round(v * 100)}%`;

/** Centered moving average (ignores nulls). */
export function smooth(points: Pt[], win: number): Pt[] {
  if (win <= 1) return points;
  const h = Math.floor(win / 2);
  return points.map((p, i) => {
    let s = 0;
    let n = 0;
    for (let j = Math.max(0, i - h); j <= Math.min(points.length - 1, i + h); j++) {
      const y = points[j].y;
      if (y !== null && isFinite(y)) {
        s += y;
        n++;
      }
    }
    return { ...p, y: n ? s / n : null };
  });
}

export function LineChart({
  series,
  height = 200,
  yDomain,
  yFormat = fmtNum,
  xFormat = fmtNum,
  xLabel,
  refLines = [],
  markers = [],
  legend = true,
  ariaLabel,
}: {
  series: Series[];
  height?: number;
  yDomain?: [number, number];
  yFormat?: (v: number) => string;
  xFormat?: (v: number) => string;
  xLabel?: string;
  refLines?: RefLine[];
  markers?: Marker[];
  legend?: boolean;
  ariaLabel: string;
}) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const endLabels = series.length > 1 && series.length <= 4 && series.every((s) => s.label.length <= 4);
  const m = { l: 44, r: endLabels ? 40 : 14, t: 10, b: xLabel ? 34 : 22 };
  const W = Math.max(200, width);
  const H = height;
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;

  const { xs, x0, x1, y0, y1 } = useMemo(() => {
    const allX = new Set<number>();
    let ylo = Infinity;
    let yhi = -Infinity;
    for (const s of series)
      for (const p of s.points) {
        allX.add(p.x);
        for (const v of [p.y, p.lo, p.hi]) {
          if (v !== null && v !== undefined && isFinite(v)) {
            ylo = Math.min(ylo, v);
            yhi = Math.max(yhi, v);
          }
        }
      }
    for (const r of refLines) {
      ylo = Math.min(ylo, r.y);
      yhi = Math.max(yhi, r.y);
    }
    const xs = [...allX].sort((a, b) => a - b);
    let [y0, y1] = yDomain ?? [ylo, yhi];
    if (!yDomain) {
      const pad = (y1 - y0) * 0.08 || Math.abs(y1) * 0.1 || 1;
      y0 -= pad;
      y1 += pad;
    }
    return { xs, x0: xs[0] ?? 0, x1: xs[xs.length - 1] ?? 1, y0, y1 };
  }, [series, refLines, yDomain]);

  const sx = (x: number) => m.l + (x1 === x0 ? iw / 2 : ((x - x0) / (x1 - x0)) * iw);
  const sy = (y: number) => m.t + ih - ((y - y0) / (y1 - y0 || 1)) * ih;

  if (!xs.length) return <div className="chart-empty">—</div>;

  const path = (pts: Pt[], key: "y" | "lo" | "hi") => {
    let d = "";
    let pen = false;
    for (const p of pts) {
      const v = p[key];
      if (v === null || v === undefined || !isFinite(v)) {
        pen = false;
        continue;
      }
      d += `${pen ? "L" : "M"}${sx(p.x).toFixed(1)},${sy(v).toFixed(1)}`;
      pen = true;
    }
    return d;
  };
  const band = (pts: Pt[]) => {
    const ok = pts.filter((p) => p.lo !== null && p.lo !== undefined && p.hi !== null && p.hi !== undefined);
    if (ok.length < 2) return "";
    const top = ok.map((p, i) => `${i ? "L" : "M"}${sx(p.x).toFixed(1)},${sy(p.hi as number).toFixed(1)}`).join("");
    const bot = [...ok].reverse().map((p) => `L${sx(p.x).toFixed(1)},${sy(p.lo as number).toFixed(1)}`).join("");
    return `${top}${bot}Z`;
  };

  const yTicks = niceTicks(y0, y1, Math.max(2, Math.floor(ih / 45)));
  const xTicks = niceTicks(x0, x1, Math.max(2, Math.floor(iw / 90)));

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const r = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const px = e.clientX - r.left + m.l;
    let best = xs[0];
    let bd = Infinity;
    for (const x of xs) {
      const d = Math.abs(sx(x) - px);
      if (d < bd) {
        bd = d;
        best = x;
      }
    }
    setHover(best);
  };

  const hoverRows: { s: Series; p: Pt }[] = [];
  if (hover !== null)
    for (const s of series) {
      const p = s.points.find((q) => q.x === hover);
      if (p && p.y !== null) hoverRows.push({ s, p });
    }

  // Direct end labels for <= 4 series (de-overlapped vertically).
  const ends: { s: Series; y: number }[] = [];
  if (endLabels)
    for (const s of series) {
      const last = [...s.points].reverse().find((p) => p.y !== null);
      if (last && last.y !== null) ends.push({ s, y: sy(last.y) });
    }
  ends.sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 12) ends[i].y = ends[i - 1].y + 12;

  return (
    <div className="chart" ref={ref}>
      {legend && series.length > 1 && (
        <div className="chart-legend">
          {series.map((s) => (
            <span key={s.key}>
              <i style={{ background: s.color }} className={s.dashed ? "dashed" : ""} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      <svg width={W} height={H} role="img" aria-label={ariaLabel}>
        {yTicks.map((v) => (
          <g key={`y${v}`}>
            <line x1={m.l} x2={W - m.r} y1={sy(v)} y2={sy(v)} className="grid" />
            <text x={m.l - 6} y={sy(v) + 4} textAnchor="end" className="tick">
              {yFormat(v)}
            </text>
          </g>
        ))}
        {xTicks.map((v) => (
          <text key={`x${v}`} x={sx(v)} y={H - m.b + 15} textAnchor="middle" className="tick">
            {xFormat(v)}
          </text>
        ))}
        {xLabel && (
          <text x={m.l + iw / 2} y={H - 4} textAnchor="middle" className="axis-label">
            {xLabel}
          </text>
        )}
        <line x1={m.l} x2={W - m.r} y1={m.t + ih} y2={m.t + ih} className="axis" />
        {refLines.map((r, i) => (
          <line key={`r${i}`} x1={m.l} x2={W - m.r} y1={sy(r.y)} y2={sy(r.y)} stroke={r.color} strokeDasharray="4 4" strokeWidth={1.2} opacity={0.75} />
        ))}
        {series.map((s) => (
          <path key={`b${s.key}`} d={band(s.points)} fill={s.color} opacity={0.14} />
        ))}
        {series.map((s) => (
          <path
            key={s.key}
            d={path(s.points, "y")}
            fill="none"
            stroke={s.color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            strokeDasharray={s.dashed ? "5 4" : undefined}
          />
        ))}
        {series.map((s) =>
          s.points.length <= 40
            ? s.points
                .filter((p) => p.y !== null)
                .map((p) => <circle key={`${s.key}-${p.x}`} cx={sx(p.x)} cy={sy(p.y as number)} r={3} fill={s.color} stroke="var(--chart-surface)" strokeWidth={1.5} />)
            : null,
        )}
        {markers.map((mk, i) => (
          <g key={`m${i}`}>
            <line x1={sx(mk.x)} x2={sx(mk.x)} y1={m.t} y2={m.t + ih} className="marker-line" />
            <text x={sx(mk.x)} y={m.t + 10} textAnchor="middle" className="marker">
              {mk.label}
            </text>
          </g>
        ))}
        {ends.map((e) => (
          <text key={`e${e.s.key}`} x={W - m.r + 6} y={e.y + 4} className="end-label">
            {e.s.label}
          </text>
        ))}
        {hover !== null && (
          <g>
            <line x1={sx(hover)} x2={sx(hover)} y1={m.t} y2={m.t + ih} className="crosshair" />
            {hoverRows.map(({ s, p }) => (
              <circle key={s.key} cx={sx(hover)} cy={sy(p.y as number)} r={4.5} fill={s.color} stroke="var(--chart-surface)" strokeWidth={2} />
            ))}
          </g>
        )}
        <rect
          x={m.l}
          y={m.t}
          width={iw}
          height={ih}
          fill="transparent"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        />
      </svg>
      {hover !== null && hoverRows.length > 0 && (
        <div className="chart-tip" style={{ left: Math.min(W - 170, Math.max(0, sx(hover) + 10)) }}>
          <div className="tip-x">{xFormat(hover)}</div>
          {hoverRows.map(({ s, p }) => (
            <div key={s.key} className="tip-row">
              <i style={{ background: s.color }} />
              <span>{s.label}</span>
              <b>{yFormat(p.y as number)}</b>
              {p.lo !== undefined && p.lo !== null && p.hi !== undefined && p.hi !== null && (
                <span className="muted">
                  [{yFormat(p.lo)}–{yFormat(p.hi)}]
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ChartCard({
  title,
  children,
  note,
  actions,
  wide,
}: {
  title: string;
  children: ReactNode;
  note?: string;
  actions?: ReactNode;
  wide?: boolean;
}) {
  return (
    <section className={`chart-card ${wide ? "span-2" : ""}`}>
      <header>
        <h3>{title}</h3>
        {actions}
      </header>
      {children}
      {note && <p className="muted small">{note}</p>}
    </section>
  );
}
