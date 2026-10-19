// Stage scaling (fixed design spaces) + the sunlit-linen scene with props.
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { portraitUrl, propUrl, tableUrl } from "./art";

export type Layout = "d" | "m";
export interface StageDims {
  layout: Layout;
  s: number; // CSS px per design px
  W: number; // stage width in design px (>= base width)
  H: number; // stage height in design px (>= base height)
}

const BASE = { d: [1440, 900], m: [390, 844] } as const;

function measure(): StageDims {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const layout: Layout = vw < 760 || vw / vh < 0.82 ? "m" : "d";
  const [BW, BH] = BASE[layout];
  const s = Math.min(vw / BW, vh / BH);
  return { layout, s, W: vw / s, H: vh / s };
}

/** Viewport-filling design stage: keeps its scale, grows to fill the screen. */
export function useStage(): StageDims {
  const [d, setD] = useState<StageDims>(() => measure());
  useEffect(() => {
    const on = () => setD(measure());
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.layout = d.layout;
  }, [d.layout]);
  return d;
}

export function Stage({ dims, className = "", children }: { dims: StageDims; className?: string; children: ReactNode }) {
  return (
    <div
      className={`dstage dstage--${dims.layout} ${className}`}
      style={{ width: dims.W, height: dims.H, transform: `scale(${dims.s})` } as CSSProperties}
    >
      {children}
    </div>
  );
}

export type SceneVariant = "title" | "lobby" | "table";

/** Background: linen, embroidered cloth borders, sunlight, leaves and props. */
export function Scene({ variant, dims, felt = "green" }: { variant: SceneVariant; dims: StageDims; felt?: string }) {
  const m = dims.layout === "m";
  if (variant === "table") return <TableScene dims={dims} felt={felt} />;
  const P = (name: string, style: CSSProperties) => (
    <div className="prop" style={style}>
      <img src={propUrl(name)} alt="" />
    </div>
  );
  return (
    <>
      <div className="scene" aria-hidden="true" />
      <div className="decor" aria-hidden="true" style={{ width: dims.W, height: dims.H, transform: `scale(${dims.s})` }}>
        {!m && <div className="stitch-h cloth__top" />}
        {!m && variant === "title" && <div className="stitch-h cloth__bottom" />}
        <div className="stitch-v cloth__left" style={m ? { width: 36, backgroundSize: "36px auto", left: -10, opacity: 0.7 } : undefined} />
        <div className="stitch-v cloth__right" style={m ? { width: 36, backgroundSize: "36px auto", right: -10, opacity: 0.7 } : undefined} />
        <div className="pools" style={m ? { left: -260, top: -20, width: 900, height: 900 } : { left: -150, top: -30, width: 1320, height: 990 }} />
        <div className="leaves" style={m ? { left: -90, top: -60, width: 380, height: 320 } : { left: -60, top: -50, width: 640, height: 530 }} />
        {variant === "title" && m && P("samovar", { width: 290, left: -172, top: -176, transform: "rotate(20deg)" })}
      </div>
    </>
  );
}

/** The hybrid world: honey-pine floor, braided rug + oval table (baked), props. */
function TableScene({ dims, felt }: { dims: StageDims; felt: string }) {
  const m = dims.layout === "m";
  const ox = m ? 0 : (dims.W - 1440) / 2;
  const oy = m ? 0 : Math.max(0, (dims.H - 900) / 2);
  const P = (name: string, style: CSSProperties) => (
    <div className="prop" style={style}>
      <img src={propUrl(name)} alt="" />
    </div>
  );
  return (
    <>
      <div className="scene scene--floor" aria-hidden="true" />
      <div className="decor" aria-hidden="true" style={{ width: dims.W, height: dims.H, transform: `scale(${dims.s})` }}>
        <div className="pools" style={m ? { left: -300, top: -40, width: 900, height: 800, opacity: 0.45 } : { left: ox - 160, top: oy - 40, width: 1320, height: 990 }} />
        <img
          className="tablebake"
          src={tableUrl(dims.layout, felt)}
          alt=""
          style={m ? { left: dims.W / 2 - 219, top: 58, width: 438, height: 628 } : { left: ox + 30, top: oy + 50, width: 1380, height: 780 }}
        />
        <div className="leaves" style={m ? { left: -90, top: -60, width: 380, height: 320 } : { left: ox - 60, top: oy - 50, width: 640, height: 530 }} />
        {m ? (
          P("rowan", { width: 150, left: -40, bottom: 64, transform: "rotate(160deg)" })
        ) : (
          <>
            {P("rowan", { width: 210, left: ox - 14, top: oy + 64, transform: "rotate(-28deg)" })}
            {P("seeds", { width: 132, left: ox + 238, top: oy + 500, transform: "rotate(-8deg)" })}
            {P("tea", { width: 146, left: ox + 1440 - 214 - 146, top: oy + 536, transform: "rotate(-16deg)" })}
            {P("stool", { width: 450, left: ox - 170, top: dims.H - 292 })}
            {P("samovar", { width: 330, left: ox - 110, top: dims.H - 232, transform: "rotate(-24deg)" })}
          </>
        )}
      </div>
    </>
  );
}

/** Gold-rimmed portrait medallion. persona=null renders the "Я" disc. */
export function Medal({
  persona,
  size = 92,
  className = "",
  children,
  me,
}: {
  persona: string | null | undefined;
  size?: number;
  className?: string;
  children?: ReactNode;
  me?: string;
}) {
  const url = portraitUrl(persona ?? (me ? null : "you"));
  return (
    <div className={`medal ${className}`} style={{ "--size": `${size}px` } as CSSProperties}>
      {url ? <img src={url} alt="" draggable={false} /> : <span className="me-disc">{me ?? "Я"}</span>}
      <i className="medal__frame" aria-hidden="true" />
      {children}
    </div>
  );
}
