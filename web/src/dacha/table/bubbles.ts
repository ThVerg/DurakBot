// Speech-bubble placement. Every bubble is anchored to its own place-card and
// must never cover another bubble or a HUD element (talon, trump chip, bito,
// "beat this" tag, ribbon, other place-cards, the battle cards). Bubbles that
// do not fit wait in a short queue; a bubble that has been read for a moment
// gives way to a newer one. Positions are fixed once shown (no jumping).
import { useEffect, useLayoutEffect, useReducer, useRef } from "react";
import type { Bubble } from "../names";
import type { SeatGeo } from "./layout";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type TailSide = "up" | "down" | "left";

export interface Placed {
  b: Bubble;
  box: Box;
  tail: TailSide;
  tailAt: number; // tail position along the bubble edge (px from left / top)
  start: number;
  until: number;
}

export interface Anchor {
  seat: SeatGeo;
  kind: "row" | "top" | "side" | "pill"; // phone row, desktop top seat, desktop side seat, phone spectate pill
  rhs: boolean; // the seat is right of centre
}

export const SHOW_MS = 2800; // matches the CSS fade-out (2.4s + .4s)
const MIN_READ_MS = 900; // a bubble may be retired for a newer one after this
const MAX_WAIT_MS = 2400; // a queued bubble older than this is dropped
const PAD = 4; // clearance around every box

// ---------------------------------------------------------------- measuring
let ctx: CanvasRenderingContext2D | null = null;
export function textWidth(text: string, font: string): number {
  if (!ctx) ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return text.length * 9;
  ctx.font = font;
  return ctx.measureText(text).width;
}

/** Size of a bubble (design px) for its text; mirrors the .bubble CSS. */
export function bubbleSize(b: Bubble, phone: boolean, showEn: boolean): { w: number; h: number } {
  const ru = phone ? `900 15px "Playfair Display", Georgia, serif` : `900 22px "Playfair Display", Georgia, serif`;
  const en = phone ? `italic 400 10px "Playfair Display", Georgia, serif` : `italic 400 12.5px "Playfair Display", Georgia, serif`;
  const withEn = showEn && !!b.en;
  const tw = Math.max(textWidth(b.ru, ru), withEn ? textWidth(b.en, en) : 0);
  const padX = phone ? 11 : 16;
  return {
    w: Math.ceil(tw + padX * 2 + 6),
    h: phone ? (withEn ? 41 : 29) : withEn ? 58 : 42,
  };
}

// ----------------------------------------------------------------- geometry
export const hit = (a: Box, b: Box) => a.x < b.x + b.w + PAD && b.x < a.x + a.w + PAD && a.y < b.y + b.h + PAD && b.y < a.y + a.h + PAD;

/** Offsets tried around a preferred position, nearest first. */
function* slide(span: number, step: number) {
  yield 0;
  for (let d = step; d <= span; d += step) {
    yield d;
    yield -d;
  }
}

/**
 * Find a spot for a bubble next to its own place-card that is clear of every
 * obstacle and every bubble already shown; null when there is none.
 */
export function placeBubble(
  size: { w: number; h: number },
  a: Anchor,
  obstacles: Box[],
  shown: Box[],
  W: number,
  H: number,
): { box: Box; tail: TailSide; tailAt: number } | null {
  const { w, h } = size;
  const s = a.seat;
  const blockers = [...obstacles, ...shown];
  const inside = (r: Box) => r.x >= 4 && r.y >= 4 && r.x + r.w <= W - 4 && r.y + r.h <= H - 4;
  const ok = (r: Box) => inside(r) && !blockers.some((o) => hit(r, o));

  if (a.kind === "pill") {
    // phone spectating: beside the bottom seat's pill, tail pointing left at it
    for (const dy of [0, -24, 24]) {
      const r = { x: s.x + s.w + 14, y: s.y + s.h / 2 - h / 2 + dy, w, h };
      if (ok(r)) return { box: r, tail: "left", tailAt: Math.max(10, Math.min(h - 10, s.y + s.h / 2 - r.y)) };
    }
    return null;
  }

  // the tail tip must land on the place-card (on its portrait on desktop)
  const aim = a.kind === "row" ? s.x + s.w / 2 : a.rhs ? s.x + s.w - 56 : s.x + 56;
  const lo = s.x + 10;
  const hi = s.x + s.w - 10;
  const rows: { y: number; tail: TailSide }[] =
    a.kind === "side"
      ? [
          { y: s.y - h - 15, tail: "down" },
          { y: s.y + s.h + 15, tail: "up" },
        ]
      : a.kind === "top"
        ? [
            { y: s.y + s.h + 15, tail: "up" },
            { y: s.y - h - 15, tail: "down" },
          ]
        : [{ y: s.y + s.h + 13, tail: "up" }];
  // preferred left edge: phone centred under the card; desktop tail near the bubble's inner end
  const pref = a.kind === "row" ? aim - w / 2 : a.rhs ? aim - w + 30 : aim - 30;
  for (const row of rows) {
    for (const d of slide(W, a.kind === "row" ? 4 : 8)) {
      const x = Math.round(pref + d);
      const tailAt = Math.max(14, Math.min(w - 14, aim - x));
      const tip = x + tailAt;
      if (tip < lo || tip > hi) continue;
      const r = { x, y: Math.round(row.y), w, h };
      if (ok(r)) return { box: r, tail: row.tail, tailAt };
    }
  }
  return null;
}

// -------------------------------------------------------------------- queue
interface QueueState {
  game: string;
  seen: Set<number>;
  vis: Placed[];
  queue: { b: Bubble; at: number }[];
  pers: Placed | null; // the standing "your move" prompt (lowest priority)
}

export interface BubbleEnv {
  game: string;
  bubbles: Record<number, Bubble>;
  persistent: Bubble | null;
  /** place a bubble among the boxes already shown (closure over current geometry) */
  place: (b: Bubble, shown: Box[]) => { box: Box; tail: TailSide; tailAt: number } | null;
  /** is a shown bubble still clear of the HUD (cards may have landed under it)? */
  clear: (box: Box) => boolean;
}

/** The bubbles to draw now: newest messages win, older ones yield or wait. */
export function useBubbles(env: BubbleEnv): Placed[] {
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const st = useRef<QueueState>({ game: env.game, seen: new Set(), vis: [], queue: [], pers: null });
  const envRef = useRef(env);
  envRef.current = env;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pump = (now: number): boolean => {
    const s = st.current;
    const e = envRef.current;
    let changed = false;
    if (s.game !== e.game) {
      st.current = { game: e.game, seen: new Set(), vis: [], queue: [], pers: null };
      return pump(now) || true;
    }
    // expire
    const alive = s.vis.filter((v) => v.until > now);
    if (alive.length !== s.vis.length) changed = true;
    s.vis = alive;
    // cards or labels that arrived under a bubble: move it, else retire it
    for (const v of [...s.vis]) {
      if (e.clear(v.box)) continue;
      const others = s.vis.filter((o) => o !== v).map((o) => o.box);
      const spot = e.place(v.b, others);
      if (spot) Object.assign(v, spot);
      else s.vis = s.vis.filter((o) => o !== v);
      changed = true;
    }
        // new messages (a seat's newer message replaces its older one)
    for (const b of Object.values(e.bubbles)) {
      if (b.key < 0 || s.seen.has(b.key)) continue;
      s.seen.add(b.key);
      const before = s.vis.length + s.queue.length;
      s.vis = s.vis.filter((v) => v.b.seat !== b.seat);
      s.queue = s.queue.filter((q) => q.b.seat !== b.seat);
      if (s.vis.length + s.queue.length !== before) changed = true;
      s.queue.push({ b, at: now });
    }
    // show what fits, oldest first; retire read bubbles to make room
    while (s.queue.length) {
      const q = s.queue[0];
      if (now - q.at > MAX_WAIT_MS) {
        s.queue.shift();
        continue;
      }
      let spot = e.place(q.b, s.vis.map((v) => v.box));
      while (!spot) {
        const old = s.vis.filter((v) => now - v.start >= MIN_READ_MS).sort((x, y) => x.start - y.start)[0];
        if (!old) break;
        s.vis = s.vis.filter((v) => v !== old);
        spot = e.place(q.b, s.vis.map((v) => v.box));
      }
      if (!spot) break;
      s.queue.shift();
      s.vis.push({ b: q.b, ...spot, start: now, until: now + SHOW_MS });
      changed = true;
    }
    // the standing prompt: keep its spot while clear, else re-place or hide
    const p = e.persistent;
    const pSeatBusy = p && s.vis.some((v) => v.b.seat === p.seat);
    if (!p || pSeatBusy) {
      if (s.pers) changed = true;
      s.pers = null;
    } else {
      const boxes = s.vis.map((v) => v.box);
      const stillOk = s.pers && s.pers.b.seat === p.seat && s.pers.b.ru === p.ru && e.clear(s.pers.box) && !boxes.some((bx) => hit(bx, s.pers!.box));
      if (!stillOk) {
        const spot = e.place(p, boxes);
        const next = spot ? { b: p, ...spot, start: now, until: Infinity } : null;
        if (!!next !== !!s.pers || (next && s.pers && next.box.x !== s.pers.box.x)) changed = true;
        s.pers = next;
      }
    }
    return changed;
  };

  const schedule = () => {
    if (timer.current) clearTimeout(timer.current);
    const s = st.current;
    const now = performance.now();
    const times = s.vis.map((v) => v.until);
    if (s.queue.length) {
      const oldest = s.vis.reduce((m, v) => Math.min(m, v.start + MIN_READ_MS), Infinity);
      times.push(oldest, s.queue[0].at + MAX_WAIT_MS + 1);
    }
    const next = Math.min(...times.filter((x) => isFinite(x)));
    if (!isFinite(next)) return;
    timer.current = setTimeout(
      () => {
        if (pump(performance.now())) bump();
        schedule();
      },
      Math.max(16, next - now + 5),
    );
  };

  // run on every render: picks up new messages and geometry changes
  useLayoutEffect(() => {
    if (pump(performance.now())) bump();
    schedule();
  });
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const s = st.current;
  return s.pers ? [...s.vis, s.pers] : s.vis;
}
