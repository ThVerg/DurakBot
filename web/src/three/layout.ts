// Maps a game view to 3D card targets. Pure functions (no three.js imports).
import type { GameState, Step } from "../api";
import { sortHand } from "../cards";
import type { SortMode } from "../prefs";

export type V3 = [number, number, number];

export interface Dims {
  A: number; // felt half-width (x)
  B: number; // felt half-depth (z)
  portrait: boolean;
}

export const LANDSCAPE: Dims = { A: 6.0, B: 3.45, portrait: false };
export const PORTRAIT: Dims = { A: 3.5, B: 4.6, portrait: true };

export const CARD_W = 1.0;
export const CARD_H = 1.4;

export interface CardTarget {
  key: string;
  card: number | null; // null = an anonymous back
  pos: V3;
  rot: V3; // euler YXZ: [tiltX, yaw, roll]
  faceUp: boolean;
  scale: number;
  zone: "hand" | "table" | "opp" | "talon" | "trump" | "discard";
  seat?: number;
  known?: boolean;
  spawn?: { pos: V3; rot: V3; faceUp: boolean };
  delay?: number;
}

export interface Anchors {
  talon: V3;
  discard: V3;
  tableCenter: V3;
  seats: Record<number, { seat: V3; fan: V3; plaque: V3; yaw: number }>;
  hand: { origin: V3; tilt: number };
}

/** Deterministic pseudo-random in [0,1) from an int. */
export const hash01 = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

export function anchors(view: GameState, d: Dims): Anchors {
  const n = view.num_players;
  const bottom = view.human_seat ?? 0;
  const k = n - 1;
  const seats: Anchors["seats"] = {};
  for (let i = 0; i < k; i++) {
    const seat = (bottom + 1 + i) % n;
    // spread opponents over the far half of the oval, left to right
    const span = d.portrait ? 0.86 : 0.92;
    const theta = Math.PI - ((i + 1) * Math.PI) / (k + 1);
    const th = Math.PI / 2 + (theta - Math.PI / 2) * span;
    const sx = Math.cos(th);
    const sz = -Math.sin(th);
    const rim: V3 = [sx * (d.A + 0.55), 0, sz * (d.B + 0.55)];
    const fan: V3 = [sx * (d.A - 0.95), 0.02, sz * (d.B - 0.85)];
    // portrait: plaques sit on the felt just in front of each fan (clear of the status banner)
    // portrait: keep side plaques on screen and the top pair far enough apart
    const px = sx * (d.A + 0.25) * 0.8;
    const pxSafe = k >= 3 && Math.abs(px) < 1.75 ? Math.sign(px || 1) * 1.75 : px;
    const plaque: V3 = d.portrait ? [k === 1 ? 0 : pxSafe, 0.9, sz * (d.B + 0.3)] : [sx * (d.A + 0.35), 0.9, sz * (d.B + 0.45)];
    const yaw = Math.atan2(-fan[0], -fan[2]); // +z faces the centre
    seats[seat] = { seat: rim, fan, plaque, yaw };
  }
  const talon: V3 = d.portrait ? [-d.A + 1.4, 0, d.B - 1.7] : [-d.A + 1.55, 0, 0.35];
  const discard: V3 = d.portrait ? [d.A - 1.05, 0, d.B - 1.7] : [d.A - 1.55, 0, 0.35];
  const tableCenter: V3 = d.portrait ? [0, 0, -0.35] : [0, 0, 0.05];
  const hand = d.portrait ? { origin: [0, 1.5, d.B + 1.55] as V3, tilt: -1.0 } : { origin: [0, 0.82, d.B + 0.62] as V3, tilt: -0.9 };
  // human "seat" for flights (pickups go to the hand)
  seats[bottom] = { seat: hand.origin, fan: hand.origin, plaque: hand.origin, yaw: 0 };
  return { talon, discard, tableCenter, seats, hand };
}

/** Position on the hand plane (x along screen, y up the tilted plane). */
export function handPoint(a: Anchors, x: number, y: number, depth: number): V3 {
  const t = a.hand.tilt;
  // card plane after tilting an upright card around X by t
  const up: V3 = [0, Math.cos(t), Math.sin(t)];
  const nrm: V3 = [0, -Math.sin(t), Math.cos(t)];
  const o = a.hand.origin;
  return [o[0] + x, o[1] + up[1] * y + nrm[1] * depth, o[2] + up[2] * y + nrm[2] * depth];
}

export interface LayoutInput {
  view: GameState;
  dims: Dims;
  sort: SortMode;
  reveal: boolean;
  handWidth: number; // visible world width at the hand
  discardIds: number[];
  dealing: boolean;
  step: Step | null;
}

export function computeLayout(inp: LayoutInput): { targets: CardTarget[]; anchors: Anchors } {
  const { view, dims, sort } = inp;
  const a = anchors(view, dims);
  const out: CardTarget[] = [];
  const bottom = view.human_seat ?? 0;
  const me = view.players[bottom];
  const trump = view.trump_suit;

  // ---------------- table pairs
  const pairs = view.table;
  const perRow = dims.portrait ? 2 : 3;
  const rows = Math.ceil(pairs.length / perRow) || 1;
  const sxp = dims.portrait ? 1.5 : 1.7;
  const szp = 1.95;
  const tc = a.tableCenter;
  pairs.forEach((p, i) => {
    const row = Math.floor(i / perRow);
    const inRow = Math.min(perRow, pairs.length - row * perRow);
    const col = i % perRow;
    const x = tc[0] + (col - (inRow - 1) / 2) * sxp;
    const z = tc[2] + (row - (rows - 1) / 2) * szp - (rows > 1 ? 0.45 : 0.25);
    const jitter = (hash01(p.attack) - 0.5) * 0.12;
    out.push({ key: `c${p.attack}`, card: p.attack, pos: [x, 0.012, z], rot: [-Math.PI / 2, jitter, 0], faceUp: true, scale: 1.2, zone: "table" });
    if (p.defense !== null) {
      const j2 = 0.2 + (hash01(p.defense) - 0.5) * 0.1;
      out.push({
        key: `c${p.defense}`,
        card: p.defense,
        pos: [x + 0.28, 0.03, z + 0.36],
        rot: [-Math.PI / 2, -j2, 0],
        faceUp: true,
        scale: 1.2,
        zone: "table",
      });
    }
  });

  // ---------------- talon (stack drawn by the scene) + trump card under it
  if (view.talon_size > 0) {
    const t = a.talon;
    out.push({
      key: `c${view.trump_card}`,
      card: view.trump_card,
      pos: [t[0] + (dims.portrait ? 0.0 : 0.62), 0.006, t[2] + (dims.portrait ? -0.62 : 0)],
      rot: [-Math.PI / 2, Math.PI / 2 + 0.05, 0],
      faceUp: true,
      scale: 1.02,
      zone: "trump",
    });
  }

  // ---------------- discard pile (never duplicate a card shown elsewhere)
  const shown = new Set<number>();
  for (const p of view.table) {
    shown.add(p.attack);
    if (p.defense !== null) shown.add(p.defense);
  }
  for (const pl of view.players) {
    for (const c of pl.hand ?? []) shown.add(c);
    for (const c of pl.known) shown.add(c);
  }
  if (view.talon_size > 0) shown.add(view.trump_card);
  inp.discardIds.filter((c) => !shown.has(c)).forEach((c, i) => {
    const d = a.discard;
    const h = hash01(c * 7 + 3);
    out.push({
      key: `c${c}`,
      card: c,
      pos: [d[0] + (h - 0.5) * 0.45, 0.01 + i * 0.006, d[2] + (hash01(c * 13) - 0.5) * 0.45],
      rot: [-Math.PI / 2, (h - 0.5) * 1.6, 0],
      faceUp: false,
      scale: 0.95,
      zone: "discard",
    });
  });

  // ---------------- human (bottom) hand
  const handCards = sortHand(me?.hand ?? [], trump, sort);
  const n = handCards.length;
  if (n) {
    // Size the fan to the hand and the viewport: keep every card's corner
    // index visible (step >= ~30% of a card), cap the card size, and shrink
    // the cards smoothly for very large hands instead of over-overlapping.
    const baseScale = dims.portrait ? 1.05 : 0.86;
    const avail = Math.max(2.4, inp.handWidth);
    const minStepK = 0.34; // fraction of card width that stays visible
    const fitScale = n > 1 ? avail / (CARD_W * (1 + (n - 1) * minStepK)) : baseScale;
    const scale = Math.max(dims.portrait ? 0.6 : 0.62, Math.min(baseScale, fitScale));
    const w = CARD_W * scale;
    const step = n > 1 ? Math.min(w * 0.7, Math.max(w * minStepK, (avail - w) / (n - 1))) : 0;
    const spread = n > 1 ? Math.min(0.045, 0.32 / n) : 0;
    handCards.forEach((c, i) => {
      const off = i - (n - 1) / 2;
      const x = off * step;
      const y = -Math.abs(off) * Math.abs(off) * spread * 0.3 * scale;
      out.push({
        key: `c${c}`,
        card: c,
        pos: handPoint(a, x, y, i * 0.012),
        rot: [a.hand.tilt, 0, -off * spread],
        faceUp: true,
        scale,
        zone: "hand",
        seat: bottom,
      });
    });
  }

  // ---------------- opponents' fans
  for (const p of view.players) {
    if (p.seat === bottom) continue;
    const s = a.seats[p.seat];
    if (!s) continue;
    const showAll = inp.reveal && p.hand;
    const known = new Set(p.known);
    const cards: (number | null)[] = showAll ? sortHand(p.hand!, trump) : [...sortHand(p.known, trump), ...Array(Math.max(0, p.hand_size - p.known.length)).fill(null)];
    const m = cards.length;
    const spacing = Math.min(0.2, 1.7 / Math.max(1, m));
    const fanSpread = Math.min(0.13, 0.9 / Math.max(1, m));
    let hidden = 0;
    cards.forEach((c, i) => {
      const off = i - (m - 1) / 2;
      const cosY = Math.cos(s.yaw), sinY = Math.sin(s.yaw);
      // tangent (screen-ish right for that seat) = rotate x-axis by yaw
      const tx = cosY, tz = -sinY;
      const pos: V3 = [s.fan[0] + tx * off * spacing, 0.32 - Math.abs(off) * 0.01 + i * 0.002, s.fan[2] + tz * off * spacing];
      const key = c === null ? `h${p.seat}:${hidden++}` : `c${c}`;
      out.push({
        key,
        card: c,
        pos,
        rot: [-0.55, s.yaw, -off * fanSpread],
        faceUp: c !== null,
        scale: 0.56,
        zone: "opp",
        seat: p.seat,
        known: c !== null && known.has(c),
      });
    });
  }

  // ---------------- spawn points for cards that appear
  const talonTop: V3 = [a.talon[0], 0.3, a.talon[2]];
  const flatDown: V3 = [Math.PI / 2 * -1, 0, 0];
  const st = inp.step;
  for (const t of out) {
    if (t.zone === "table" && st && st.card === t.card) {
      const src = a.seats[st.player];
      if (src && st.player !== bottom) t.spawn = { pos: [src.fan[0], 0.6, src.fan[2]], rot: [-0.42, src.yaw, 0], faceUp: false };
    } else if (t.zone === "hand" || t.zone === "opp") {
      t.spawn = { pos: talonTop, rot: flatDown, faceUp: false };
    }
  }

  // ---------------- deal: stagger hand/opponent cards round-robin
  if (inp.dealing) {
    const bySeat = new Map<number, CardTarget[]>();
    for (const t of out) if (t.seat !== undefined && (t.zone === "hand" || t.zone === "opp")) bySeat.set(t.seat, [...(bySeat.get(t.seat) ?? []), t]);
    const order = Array.from({ length: view.num_players }, (_, i) => (bottom + 1 + i) % view.num_players);
    let k = 0;
    for (let r = 0; r < 6; r++)
      for (const s of order) {
        const list = bySeat.get(s) ?? [];
        if (list[r]) {
          list[r].delay = k * 0.055;
          list[r].spawn = { pos: talonTop, rot: flatDown, faceUp: false };
          k++;
        }
      }
  }
  return { targets: out, anchors: a };
}
