// 2D, top-down table geometry for the Dacha table (design px on the stage).
// Every card on screen is a keyed target; the card layer animates a card
// from its previous target to its new one (or from a spawn point).
import type { GameState, Step } from "../../api";
import { sortHand } from "../../cards";
import type { SortMode } from "../../prefs";
import type { Layout } from "../Scene";

export const ASPECT = 716 / 512; // card height / width

export type Zone = "hand" | "table" | "opp" | "trump" | "discard";

export interface Pose {
  x: number; // centre, design px
  y: number;
  rot: number; // degrees
  w: number; // card width, design px
}

export interface CardTarget extends Pose {
  key: string;
  card: number | null; // null = an anonymous back
  faceUp: boolean;
  z: number;
  zone: Zone;
  seat?: number;
  known?: boolean;
  spawn?: Pose & { faceUp: boolean };
  delay?: number; // seconds (scaled by speed)
}

export interface SeatGeo {
  seat: number;
  x: number; // place-card box
  y: number;
  w: number;
  h: number;
  fanX: number; // centre of the first fan card
  fanY: number;
  fanStep: number;
  fanW: number; // fan card width
  fanSpan: number; // centre-to-centre width of the whole fan
  side: "left" | "right" | "top";
}

export interface Geo {
  layout: Layout;
  W: number;
  H: number;
  cx: number;
  table: { x: number; y: number; w: number; h: number }; // outer box of the table (rail included)
  talon: { x: number; y: number; w: number };
  bito: { x: number; y: number; w: number };
  battle: { x: number; y: number };
  ribbonY: number;
  handBottom: number;
  seats: Record<number, SeatGeo>;
  bottom: SeatGeo; // place-card for the bottom seat when watching bots
  me: { x: number; y: number }; // where cards fly when the human picks up
}

/** Deterministic pseudo-random in [0,1). */
export const hash01 = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

// seat slots (desktop artboard 1440x900), clockwise from your left, per number
// of opponents. The place-cards straddle the oval's leather rail.
export const SEAT_W = 280;
export const SEAT_H = 116;
function desktopSeats(k: number): { x: number; y: number; side: SeatGeo["side"] }[] {
  const left = { x: 34, y: 404, side: "left" as const };
  const right = { x: 1440 - 34 - SEAT_W, y: 404, side: "right" as const };
  const top = (cx: number) => ({ x: cx - SEAT_W / 2, y: 96, side: "top" as const });
  switch (k) {
    case 1:
      return [top(720)];
    case 2:
      return [top(450), top(990)];
    case 3:
      return [left, top(720), right];
    case 4:
      return [left, top(436), top(1020), right];
    default:
      return [left, top(372), top(720), top(1068), right];
  }
}

export interface LayoutInput {
  view: GameState;
  layout: Layout;
  W: number;
  H: number;
  sort: SortMode;
  reveal: boolean;
  discardIds: number[];
  dealing: boolean;
  step: Step | null;
  /** A card the human just played (or is dragging): drawn at its table slot. */
  pending?: number | null;
}

/** The view as it will be once ``card`` is played from the bottom hand. */
export function withPending(view: GameState, card: number | null | undefined): GameState {
  if (card === null || card === undefined) return view;
  const bottom = view.human_seat ?? 0;
  const me = view.players[bottom];
  if (!me?.hand?.includes(card)) return view;
  const table = view.table.map((p) => ({ ...p }));
  const open = table.find((p) => p.defense === null);
  if (view.phase === "defend" && open) open.defense = card;
  else table.push({ attack: card, defense: null });
  const players = view.players.map((p) => (p.seat === bottom ? { ...p, hand: p.hand!.filter((c) => c !== card), hand_size: p.hand_size - 1 } : p));
  return { ...view, table, players, hand: view.hand.filter((c) => c !== card) };
}

export function geometry(view: GameState, layout: Layout, W: number, H: number): Geo {
  const bottom = view.human_seat ?? 0;
  const n = view.num_players;
  const k = n - 1;
  const seats: Record<number, SeatGeo> = {};
  if (layout === "d") {
    // artboard 1440x900 centred in the (possibly larger) stage
    const ox = (W - 1440) / 2;
    const oy = Math.max(0, (H - 900) / 2);
    const slots = desktopSeats(k);
    for (let i = 0; i < k; i++) {
      const seat = (bottom + 1 + i) % n;
      const s = slots[i];
      const x = s.x + ox;
      const y = s.y + oy;
      seats[seat] = { seat, x, y, w: SEAT_W, h: SEAT_H, fanX: x + 116 + 16, fanY: y + 87, fanStep: 13, fanW: 32, fanSpan: 78, side: s.side };
    }
    return {
      layout,
      W,
      H,
      cx: W / 2,
      table: { x: ox + 30, y: oy + 50, w: 1380, h: 780 },
      talon: { x: ox + 416, y: oy + 353, w: 96 },
      bito: { x: ox + 1018, y: oy + 358, w: 92 },
      battle: { x: ox + 748, y: oy + 372 },
      ribbonY: oy + 545,
      handBottom: H - 36,
      seats,
      bottom: { seat: bottom, x: ox + 34, y: oy + 632, w: SEAT_W, h: SEAT_H, fanX: 0, fanY: 0, fanStep: 0, fanW: 0, fanSpan: 0, side: "left" },
      me: { x: W / 2, y: H - 120 },
    };
  }
  // phone: a row of arched place-cards over the far end of a portrait table
  const gap = k >= 4 ? 8 : 10;
  const sw = Math.min(k <= 2 ? 118 : 104, (W - 24 - (k - 1) * gap) / Math.max(k, 1));
  const rowW = k * sw + (k - 1) * gap;
  const x0 = W / 2 - rowW / 2;
  for (let i = 0; i < k; i++) {
    const seat = (bottom + 1 + i) % n;
    const x = x0 + i * (sw + gap);
    const fanSpan = Math.min(30, sw - 52);
    const total = fanSpan + 17 + 4 + 21;
    seats[seat] = { seat, x, y: 60, w: sw, h: 143, fanX: x + sw / 2 - total / 2 + 8.5, fanY: 60 + 121, fanStep: 6, fanW: 17, fanSpan, side: "top" };
  }
  return {
    layout,
    W,
    H,
    cx: W / 2,
    table: { x: W / 2 - 219, y: 58, w: 438, h: 628 },
    talon: { x: W / 2 - 1, y: 261, w: 56 },
    bito: { x: W / 2 + 113, y: 262, w: 52 },
    battle: { x: W / 2, y: Math.max(396, (H - 33) / 2) },
    ribbonY: H - 302,
    handBottom: H - 108,
    seats,
    bottom: { seat: bottom, x: W / 2, y: H - 302 + 27, w: 150, h: 30, fanX: 0, fanY: 0, fanStep: 0, fanW: 0, fanSpan: 0, side: "left" },
    me: { x: W / 2, y: H - 160 },
  };
}

export function computeLayout(inp: LayoutInput): { targets: CardTarget[]; geo: Geo } {
  const { layout, sort } = inp;
  const view = withPending(inp.view, inp.pending);
  const g = geometry(view, layout, inp.W, inp.H);
  const d = layout === "d";
  const out: CardTarget[] = [];
  const bottom = view.human_seat ?? 0;
  const me = view.players[bottom];
  const trump = view.trump_suit;

  // ---------------- battle pairs
  const pairs = view.table;
  const np = pairs.length;
  const two = np > 3;
  const perRow = 3;
  const rows = Math.ceil(np / perRow) || 1;
  // card width / spacing by how many pairs there are
  const cw = d ? (np <= 2 ? 128 : np === 3 ? 100 : 90) : np <= 2 ? 104 : np === 3 ? 84 : 58;
  const sx = d ? (np <= 2 ? 196 : np === 3 ? 132 : 122) : np <= 2 ? 146 : np === 3 ? 110 : 80;
  const sy = d ? 136 : 100;
  const dx = cw * 0.17;
  const dy = cw * 0.235;
  const by = d ? g.battle.y : g.battle.y + (two ? 0 : 0);
  pairs.forEach((p, i) => {
    const row = Math.floor(i / perRow);
    const inRow = Math.min(perRow, np - row * perRow);
    const col = i % perRow;
    const x = g.battle.x + (col - (inRow - 1) / 2) * sx - dx / 2;
    const y = by + (row - (rows - 1) / 2) * sy - (two ? dy / 2 : 0);
    const ja = (hash01(p.attack) - 0.5) * 6;
    out.push({ key: `c${p.attack}`, card: p.attack, x, y, rot: ja - 1, w: cw, faceUp: true, z: 300 + i * 2, zone: "table" });
    if (p.defense !== null) {
      const jd = 8 + (hash01(p.defense) - 0.5) * 5;
      out.push({ key: `c${p.defense}`, card: p.defense, x: x + dx, y: y + dy, rot: jd, w: cw, faceUp: true, z: 301 + i * 2, zone: "table" });
    }
  });

  // ---------------- trump card under the talon
  if (view.talon_size > 0) {
    const t = g.talon;
    out.push({
      key: `c${view.trump_card}`,
      card: view.trump_card,
      x: t.x + t.w * 0.6,
      y: t.y + t.w * 0.12,
      rot: 90,
      w: t.w,
      faceUp: true,
      z: 100,
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
  const disc = inp.discardIds.filter((c) => !shown.has(c)).slice(-10);
  disc.forEach((c, i) => {
    const b = g.bito;
    const h = hash01(c * 7 + 3);
    out.push({
      key: `c${c}`,
      card: c,
      x: b.x + (h - 0.5) * (d ? 20 : 12),
      y: b.y + (hash01(c * 13) - 0.5) * (d ? 16 : 10),
      rot: (h - 0.5) * 48,
      w: b.w,
      faceUp: false,
      z: 150 + i,
      zone: "discard",
    });
  });

  // ---------------- the bottom player's hand (you, or seat 0 when watching)
  const handCards = sortHand(me?.hand ?? [], trump, sort);
  const n = handCards.length;
  if (n) {
    const span = d ? Math.min(800, inp.W - 680) : inp.W - 40;
    const minK = 0.3; // fraction of a card that always stays visible
    const baseW = d ? 142 : 88;
    const fitW = n > 1 ? span / (1 + (n - 1) * minK) : baseW;
    const w = Math.max(d ? 92 : 58, Math.min(baseW, fitW));
    const step = n > 1 ? Math.min(d ? 86 : 42, Math.max(w * minK, (span - w) / (n - 1))) : 0;
    const mid = (n - 1) / 2;
    const arcK = mid > 0 ? Math.min(d ? 3.4 : 2, (d ? 34 : 16) / (mid * mid)) : 0;
    const rotK = mid > 0 ? Math.min(d ? 3.6 : 3.4, (d ? 16 : 13) / mid) : 0;
    const h = w * ASPECT;
    handCards.forEach((c, i) => {
      const off = i - mid;
      out.push({
        key: `c${c}`,
        card: c,
        x: g.cx + off * step,
        y: g.handBottom - h / 2 + off * off * arcK,
        rot: off * rotK,
        w,
        faceUp: true,
        z: 600 + i,
        zone: "hand",
        seat: bottom,
      });
    });
  }

  // ---------------- opponents' fans
  for (const p of view.players) {
    if (p.seat === bottom) continue;
    const s = g.seats[p.seat];
    if (!s) continue;
    const showAll = inp.reveal && p.hand;
    const known = new Set(p.known);
    const cards: (number | null)[] = showAll
      ? sortHand(p.hand!, trump)
      : [...sortHand(p.known, trump), ...Array(Math.max(0, p.hand_size - p.known.length)).fill(null)];
    const m = cards.length;
    const step = m > 1 ? Math.min(s.fanStep, s.fanSpan / (m - 1)) : 0;
    const midF = (m - 1) / 2;
    const rk = m > 1 ? Math.min(5, 26 / m) : 0;
    let hidden = 0;
    cards.forEach((c, i) => {
      const off = i - midF;
      const key = c === null ? `h${p.seat}:${hidden++}` : `c${c}`;
      out.push({
        key,
        card: c,
        x: s.fanX + i * step,
        y: s.fanY + Math.abs(off) * 0.6,
        rot: off * rk,
        w: s.fanW,
        faceUp: c !== null,
        z: 500 + i,
        zone: "opp",
        seat: p.seat,
        known: c !== null && known.has(c),
      });
    });
  }

  // ---------------- spawn points for cards that appear
  const t = g.talon;
  const talonTop = { x: t.x, y: t.y, rot: -3, w: t.w, faceUp: false };
  const st = inp.step;
  for (const tg of out) {
    if (tg.zone === "table" && st && st.card === tg.card && st.player !== bottom) {
      const src = g.seats[st.player];
      if (src) tg.spawn = { x: src.fanX + src.fanSpan / 2, y: src.fanY, rot: -12, w: src.fanW * 1.4, faceUp: false };
    } else if (tg.zone === "hand" || tg.zone === "opp") {
      tg.spawn = talonTop;
    } else if (tg.zone === "trump") {
      tg.spawn = { ...talonTop, faceUp: false };
    }
  }

  // ---------------- deal: round-robin stagger from the talon
  if (inp.dealing) {
    const bySeat = new Map<number, CardTarget[]>();
    for (const tg of out) if (tg.seat !== undefined && (tg.zone === "hand" || tg.zone === "opp")) bySeat.set(tg.seat, [...(bySeat.get(tg.seat) ?? []), tg]);
    const order = Array.from({ length: view.num_players }, (_, i) => (bottom + 1 + i) % view.num_players);
    let k = 0;
    for (let r = 0; r < 6; r++)
      for (const s of order) {
        const list = bySeat.get(s) ?? [];
        if (list[r]) {
          list[r].delay = 0.25 + k * 0.05;
          list[r].spawn = talonTop;
          k++;
        }
      }
    for (const tg of out) if (tg.zone === "trump") tg.delay = 0.3 + k * 0.05;
  }
  return { targets: out, geo: g };
}
