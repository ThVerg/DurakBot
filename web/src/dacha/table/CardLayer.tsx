// All cards on the table as keyed, absolutely positioned elements in SCREEN
// pixels (the card layer is not inside the scaled design stage): each card is
// laid out at its real displayed size and rests with only translate + rotate,
// so faces are never resampled from a scaled bitmap. When a card's target
// pose changes it flies there (Web Animations API: arc, slight lift, landing
// squash); face-up/face-down changes flip it with a 2D squeeze mid-flight.
import { memo, useEffect, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { RANKS, SUIT_SYMBOLS, rankOf, suitOf } from "../../cards";
import { backSrc, dropSrcSet, faceSrc } from "../art";
import { ASPECT, type CardTarget, type Pose } from "./layout";

/**
 * CSS transform that shows ``p`` (design px) on an element whose box is
 * ``boxW`` x ``boxW*ASPECT`` screen px, with stage scale ``S``. At rest
 * (p.w*S === boxW) there is no scale() at all and the offset is whole pixels.
 */
export function poseTransform(p: Pose, S: number, boxW: number, lift = 0, k = 1, rest = false): string {
  const boxH = boxW * ASPECT;
  let tx = p.x * S - boxW / 2;
  let ty = p.y * S - boxH / 2 - lift * S;
  const sc = ((p.w * S) / boxW) * k;
  if (rest) {
    tx = Math.round(tx);
    ty = Math.round(ty);
  }
  const scale = Math.abs(sc - 1) < 1e-4 ? "" : ` scale(${sc.toFixed(4)})`;
  return `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) rotate(${p.rot.toFixed(2)}deg)${scale}`;
}

export interface Settle {
  until: number; // performance.now() ms when the last running flight lands
}

export interface FlyCardProps {
  t: CardTarget;
  S: number; // stage scale: screen px per design px
  hires: number; // re-render when hi-res art is discovered
  speed: number; // time scale (0 = instant)
  back: string;
  four: boolean;
  settle: Settle;
  onLand?: (t: CardTarget, spawned: boolean) => void;
  // hand interaction
  legal?: boolean;
  dim?: boolean;
  hint?: boolean;
  selected?: boolean;
  label?: string;
  onPlay?: (card: number) => void;
  onHover?: (card: number | null) => void;
  badge?: ReactNode;
  tabIndex?: number;
  extraClass?: string;
  // drag & drop (hand cards)
  onDrag?: (card: number | null, x?: number, y?: number) => void;
  canDrop?: (x: number, y: number) => boolean;
}

interface DragState {
  id: number;
  sx: number;
  sy: number;
  on: boolean;
  from: Pose;
  cur: Pose;
}

const easing = "cubic-bezier(.25,.8,.3,1)";

/** <img> for a face or back, with srcset sized to the displayed width. */
export function CardImg({
  cls,
  src,
  srcSet,
  byDpr,
  cssW,
  style,
}: {
  cls: string;
  src: string;
  srcSet?: string;
  byDpr?: boolean;
  cssW: number;
  style?: CSSProperties;
}) {
  return (
    <img
      className={cls}
      src={src}
      srcSet={srcSet}
      sizes={srcSet && !byDpr ? `${Math.ceil(cssW)}px` : undefined}
      alt=""
      draggable={false}
      decoding="async"
      style={style}
      onError={srcSet ? dropSrcSet : undefined}
    />
  );
}

export const FlyCard = memo(function FlyCard(p: FlyCardProps) {
  const { t, S } = p;
  const ref = useRef<HTMLDivElement>(null);
  const flipRef = useRef<HTMLDivElement>(null);
  const prev = useRef<Pose | null>(null);
  const prevFace = useRef<boolean | null>(null);
  const boxRef = useRef(0); // box width (screen px) the running animation was built for
  const anim = useRef<Animation | null>(null);
  const flipAnim = useRef<Animation | null>(null);
  const flipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drag = useRef<DragState | null>(null);
  const suppressClick = useRef(false);
  const boxW = t.w * S;

  useLayoutEffect(() => {
    const el = ref.current;
    const flip = flipRef.current;
    if (!el || !flip) return;
    const to: Pose = { x: t.x, y: t.y, rot: t.rot, w: t.w };
    let from = prev.current;
    const spawned = !from && !!t.spawn;
    if (!from && t.spawn) from = t.spawn;
    prev.current = to;
    const startFace = prevFace.current ?? (t.spawn ? t.spawn.faceUp : t.faceUp);
    prevFace.current = t.faceUp;
    const oldBox = boxRef.current || boxW;
    boxRef.current = boxW;
    const sp = p.speed;
    const setFace = (up: boolean) => flip.classList.toggle("is-down", !up);
    const same = from && Math.abs(from.x - to.x) < 0.5 && Math.abs(from.y - to.y) < 0.5 && Math.abs(from.rot - to.rot) < 0.5 && Math.abs(from.w - to.w) < 0.5;
    if (flipTimer.current) clearTimeout(flipTimer.current);
    flipAnim.current?.cancel();
    if (!from || same || sp <= 0) {
      setFace(t.faceUp);
      if (from && !same && sp <= 0) p.onLand?.(t, spawned);
      return;
    }
    // where we are right now if a flight is in progress
    if (anim.current && anim.current.playState === "running") {
      const m = new DOMMatrix(getComputedStyle(el).transform);
      anim.current.cancel();
      const rot = (Math.atan2(m.b, m.a) * 180) / Math.PI;
      const sc = Math.hypot(m.a, m.b);
      from = { x: (m.e + oldBox / 2) / S, y: (m.f + (oldBox * ASPECT) / 2) / S, rot, w: (sc * oldBox) / S };
    }
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    const long = dist > 60;
    const dur = Math.round(sp * (long ? Math.min(640, 330 + dist * 0.28) : 240));
    const delay = Math.round((t.delay ?? 0) * 1000 * Math.max(0.4, sp));
    const arc = long ? Math.min(70, 14 + dist * 0.09) : 0;
    const mid: Pose = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, rot: (from.rot + to.rot) / 2 + (long ? 7 : 0), w: (from.w + to.w) / 2 };
    const kf: Keyframe[] = [
      { transform: poseTransform(from, S, boxW), offset: 0 },
      { transform: poseTransform(mid, S, boxW, arc, long ? 1.07 : 1), offset: 0.5 },
    ];
    if (long && t.zone === "table") kf.push({ transform: poseTransform(to, S, boxW, 0, 1.04), offset: 0.86 });
    kf.push({ transform: poseTransform(to, S, boxW, 0, 1, true), offset: 1 });
    // layer promotion only while flying (removed on landing: crisp at rest)
    el.classList.add("is-flying");
    anim.current = el.animate(kf, { duration: dur, delay, easing, fill: "backwards" });
    p.settle.until = Math.max(p.settle.until, performance.now() + delay + dur);
    // flip: a 2D squeeze half-way through the flight, swapping faces in the middle
    setFace(startFace);
    if (startFace !== t.faceUp) {
      const fd = Math.round(dur * 0.6);
      const fdelay = delay + Math.round(dur * 0.2);
      flipAnim.current = flip.animate(
        [{ transform: "scaleX(1)" }, { transform: "scaleX(0.04)", offset: 0.5 }, { transform: "scaleX(1)" }],
        { duration: fd, delay: fdelay, easing: "ease-in-out" },
      );
      flipTimer.current = setTimeout(() => setFace(t.faceUp), fdelay + fd / 2);
    }
    const a = anim.current;
    a.finished.then(
      () => {
        el.classList.remove("is-flying");
        p.onLand?.(t, spawned);
      },
      () => el.classList.remove("is-flying"),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t.x, t.y, t.rot, t.w, t.faceUp]);

  useEffect(
    () => () => {
      anim.current?.cancel();
      flipAnim.current?.cancel();
      if (flipTimer.current) clearTimeout(flipTimer.current);
    },
    [],
  );

  const isHand = t.zone === "hand";
  const cls = [
    "fc",
    `fc--${t.zone}`,
    p.legal ? "is-legal" : "",
    p.dim ? "is-dim" : "",
    p.hint ? "is-hint" : "",
    p.selected ? "is-selected" : "",
    t.known ? "is-known" : "",
    p.extraClass ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  const style = {
    width: boxW,
    height: boxW * ASPECT,
    transform: poseTransform(t, S, boxW, 0, 1, true),
    zIndex: t.z,
  } as CSSProperties;
  // the hand gets the DPR-matched file (it is looked at closely, lifted, dragged)
  const face = t.card !== null ? faceSrc(t.card, p.four, t.zone === "hand") : null;
  const bk = backSrc(p.back);
  const faces = (
    <div className="fc__flip" ref={flipRef}>
      {face ? <CardImg cls="fc__face" src={face.src} srcSet={face.srcSet} byDpr={face.byDpr} cssW={boxW} /> : <span className="fc__face fc__blank" />}
      <CardImg cls="fc__back" src={bk.src} srcSet={bk.srcSet} cssW={boxW} />
    </div>
  );
  if (isHand && t.card !== null) {
    const card = t.card;
    const endDrag = (drop: boolean) => {
      const d = drag.current;
      drag.current = null;
      const el = ref.current;
      if (!d || !d.on || !el) return;
      suppressClick.current = true;
      setTimeout(() => (suppressClick.current = false), 80);
      el.classList.remove("is-dragging", "is-flying");
      const ok = drop && !!p.legal && (p.canDrop?.(d.cur.x, d.cur.y) ?? false);
      p.onDrag?.(null);
      const back = () => {
        const home: Pose = { x: t.x, y: t.y, rot: t.rot, w: t.w };
        el.style.transform = poseTransform(home, S, boxW, 0, 1, true);
        prev.current = home;
        anim.current = el.animate([{ transform: poseTransform(d.cur, S, boxW) }, { transform: poseTransform(home, S, boxW, 0, 1, true) }], {
          duration: 260,
          easing,
        });
      };
      if (ok) {
        // fly on from where it was dropped once the new target arrives
        prev.current = d.cur;
        p.onPlay?.(card);
        setTimeout(() => {
          if (prev.current === d.cur && ref.current) back();
        }, 1500);
      } else back();
    };
    return (
      <div className={cls} style={style} ref={ref} data-card={card}>
        <button
          type="button"
          className="fc__lift"
          disabled={!p.legal}
          aria-disabled={!p.legal}
          aria-label={p.label ?? `${RANKS[rankOf(card)]}${SUIT_SYMBOLS[suitOf(card)]}`}
          tabIndex={p.tabIndex}
          data-testid={`hand-${card}`}
          onClick={() => {
            if (suppressClick.current) {
              suppressClick.current = false;
              return;
            }
            if (p.legal) p.onPlay?.(card);
          }}
          onPointerDown={(e) => {
            if (!p.legal || e.button !== 0 || !p.onDrag) return;
            const pose: Pose = { x: t.x, y: t.y, rot: t.rot, w: t.w };
            drag.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, on: false, from: pose, cur: pose };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            const el = ref.current;
            if (!d || d.id !== e.pointerId || !el) return;
            const dx = (e.clientX - d.sx) / S;
            const dy = (e.clientY - d.sy) / S;
            if (!d.on) {
              if (Math.hypot(dx, dy) < 8) return;
              d.on = true;
              try {
                e.currentTarget.setPointerCapture(e.pointerId);
              } catch {
                /* ignore */
              }
              anim.current?.cancel();
              el.classList.add("is-dragging", "is-flying");
            }
            d.cur = { x: d.from.x + dx, y: d.from.y + dy - 24, rot: Math.max(-12, Math.min(12, dx * 0.04)), w: d.from.w * 1.06 };
            el.style.transform = poseTransform(d.cur, S, boxW);
            p.onDrag?.(card, d.cur.x, d.cur.y);
          }}
          onPointerUp={() => endDrag(true)}
          onPointerCancel={() => endDrag(false)}
          onLostPointerCapture={(e) => e.target === e.currentTarget && drag.current?.on && endDrag(true)}
          onMouseEnter={() => p.onHover?.(card)}
          onMouseLeave={() => p.onHover?.(null)}
          onFocus={() => p.onHover?.(card)}
          onBlur={() => p.onHover?.(null)}
        >
          {faces}
          {p.badge}
        </button>
      </div>
    );
  }
  return (
    <div className={cls} style={style} ref={ref} data-card={t.card ?? undefined} aria-hidden="true">
      <div className="fc__lift">{faces}</div>
    </div>
  );
});
