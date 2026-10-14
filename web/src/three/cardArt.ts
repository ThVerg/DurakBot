// Procedural card art (placeholders until /assets/cards are available):
// SVG faces rasterised to canvases, and ornate card backs drawn on canvas.
import { RANKS } from "../cards";

const SUIT_PATHS = [
  "M50 2 C60 20 98 38 98 62 C98 78 86 88 72 88 C63 88 56 84 53 77 C54 88 58 95 67 100 L33 100 C42 95 46 88 47 77 C44 84 37 88 28 88 C14 88 2 78 2 62 C2 38 40 20 50 2 Z",
  "M50 4 A21 21 0 0 1 66 39 A21 21 0 1 1 55 72 C56 86 60 94 68 100 L32 100 C40 94 44 86 45 72 A21 21 0 1 1 34 39 A21 21 0 0 1 50 4 Z",
  "M50 0 L90 50 L50 100 L10 50 Z",
  "M50 92 C22 70 2 52 2 30 C2 13 15 3 29 3 C39 3 46 9 50 18 C54 9 61 3 71 3 C85 3 98 13 98 30 C98 52 78 70 50 92 Z",
];

export const SUIT_COLORS = ["#16181d", "#16181d", "#b3122a", "#b3122a"];
export const SUIT_COLORS_4 = ["#16181d", "#0b6e37", "#1555b3", "#b3122a"];

function pip(s: number, x: number, y: number, size: number, flip = false) {
  const k = size / 100;
  return `<path d="${SUIT_PATHS[s]}" transform="translate(${x} ${y}) ${flip ? "rotate(180)" : ""} translate(${-size / 2} ${-size / 2}) scale(${k})"/>`;
}

const L = 31, R = 69, C = 50;
const LAYOUT: Record<number, [number, number][]> = {
  0: [[L, 34], [L, 70], [L, 106], [R, 34], [R, 70], [R, 106]],
  1: [[L, 34], [L, 70], [L, 106], [R, 34], [R, 70], [R, 106], [C, 52]],
  2: [[L, 34], [L, 70], [L, 106], [R, 34], [R, 70], [R, 106], [C, 52], [C, 88]],
  3: [[L, 34], [L, 58], [L, 82], [L, 106], [R, 34], [R, 58], [R, 82], [R, 106], [C, 70]],
  4: [[L, 34], [L, 58], [L, 82], [L, 106], [R, 34], [R, 58], [R, 82], [R, 106], [C, 46], [C, 94]],
};

/** SVG markup for a card face (viewBox 0 0 100 140). */
export function faceSvg(card: number, fourColor: boolean): string {
  const s = Math.floor(card / 9);
  const r = card % 9;
  const color = (fourColor ? SUIT_COLORS_4 : SUIT_COLORS)[s];
  const rank = RANKS[r];
  const corner = `<g><text x="${r === 4 ? 11.5 : 11}" y="20" text-anchor="middle" font-size="${r === 4 ? 15 : 18}" font-weight="700" letter-spacing="${r === 4 ? -1.2 : 0}" font-family="Playfair Display, Georgia, serif">${rank}</text>${pip(s, 11, 30, 10)}</g>`;
  let center = "";
  if (r <= 4) center = LAYOUT[r].map(([x, y]) => pip(s, x, y, 17, y > 70)).join("");
  else if (r === 8)
    center = `<circle cx="50" cy="70" r="27" fill="none" stroke="${color}" stroke-opacity="0.18" stroke-width="1"/>${pip(s, 50, 70, 40)}`;
  else {
    const g = { 5: "J", 6: "Q", 7: "K" }[r as 5 | 6 | 7];
    center = `<rect x="21" y="25" width="58" height="90" rx="5" fill="url(#tint)" stroke="${color}" stroke-width="1.1"/>
      <rect x="24.5" y="28.5" width="51" height="83" rx="3.5" fill="none" stroke="#b8902e" stroke-width="0.8"/>
      ${pip(s, 50, 42, 13)}
      <text x="50" y="84" text-anchor="middle" font-size="34" font-weight="700" font-family="Playfair Display, Georgia, serif">${g}</text>
      ${pip(s, 50, 100, 13, true)}`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 140" width="512" height="716">
    <defs>
      <linearGradient id="paper" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fffdf6"/><stop offset="1" stop-color="#f3ecdc"/></linearGradient>
      <linearGradient id="tint" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fbf3e0"/><stop offset="1" stop-color="#f0e2c2"/></linearGradient>
    </defs>
    <rect x="0" y="0" width="100" height="140" rx="7" fill="url(#paper)"/>
    <rect x="2.2" y="2.2" width="95.6" height="135.6" rx="5.5" fill="none" stroke="#d9c9a3" stroke-width="0.6"/>
    <g fill="${color}">${corner}<g transform="rotate(180 50 70)">${corner}</g>${center}</g>
  </svg>`;
}

/** Rasterise an SVG string to a canvas of the given size. */
export function svgToCanvas(svg: string, w: number, h: number): Promise<HTMLCanvasElement> {
  return new Promise((resolve) => {
    const img = new Image();
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    img.onload = () => {
      canvas.getContext("2d")!.drawImage(img, 0, 0, w, h);
      resolve(canvas);
    };
    img.onerror = () => resolve(canvas);
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}

export interface BackStyle {
  base: [string, string];
  ink: string;
  accent: string;
  edge: string;
}

export const BACK_STYLES: Record<string, BackStyle> = {
  classic: { base: ["#7a1424", "#4a0a15"], ink: "rgba(255,225,170,0.22)", accent: "#d4af37", edge: "#f5ecd6" },
  navy: { base: ["#1b2f6b", "#0b1533"], ink: "rgba(190,210,255,0.2)", accent: "#c9d6ff", edge: "#eef2ff" },
  khokhloma: { base: ["#1a1210", "#0b0706"], ink: "rgba(212,175,55,0.35)", accent: "#d62828", edge: "#d4af37" },
  gzhel: { base: ["#fbfdff", "#e8eef9"], ink: "rgba(29,79,179,0.35)", accent: "#1d4fb3", edge: "#1d4fb3" },
  emerald: { base: ["#0e4d3a", "#06261c"], ink: "rgba(212,175,55,0.25)", accent: "#d4af37", edge: "#e8dcc0" },
};

/** Ornate procedural card back (512x716). */
export function drawBack(styleId: string): HTMLCanvasElement {
  const st = BACK_STYLES[styleId] ?? BACK_STYLES.classic;
  const W = 512, H = 716;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  const rr = (x: number, y: number, w: number, h: number, r: number) => {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  };
  // paper edge
  g.fillStyle = st.edge;
  rr(0, 0, W, H, 36);
  g.fill();
  // field
  const grad = g.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, st.base[0]);
  grad.addColorStop(1, st.base[1]);
  g.fillStyle = grad;
  rr(22, 22, W - 44, H - 44, 22);
  g.fill();
  g.save();
  rr(22, 22, W - 44, H - 44, 22);
  g.clip();
  // lattice
  g.strokeStyle = st.ink;
  g.lineWidth = 2;
  for (let i = -H; i < W + H; i += 22) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i + H, H);
    g.stroke();
    g.beginPath();
    g.moveTo(i, H);
    g.lineTo(i + H, 0);
    g.stroke();
  }
  // rosette rings
  const cx = W / 2, cy = H / 2;
  for (let k = 0; k < 7; k++) {
    g.beginPath();
    g.strokeStyle = k % 2 ? st.ink : st.accent;
    g.globalAlpha = k % 2 ? 1 : 0.85;
    g.lineWidth = k % 2 ? 2 : 3;
    g.ellipse(cx, cy, 40 + k * 18, 56 + k * 24, 0, 0, Math.PI * 2);
    g.stroke();
  }
  g.globalAlpha = 1;
  // petals
  g.fillStyle = st.accent;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    g.save();
    g.translate(cx + Math.cos(a) * 70, cy + Math.sin(a) * 92);
    g.rotate(a);
    g.beginPath();
    g.ellipse(0, 0, 16, 7, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }
  g.beginPath();
  g.arc(cx, cy, 22, 0, Math.PI * 2);
  g.fill();
  // vignette
  const v = g.createRadialGradient(cx, cy, 80, cx, cy, 420);
  v.addColorStop(0, "rgba(255,255,255,0.08)");
  v.addColorStop(1, "rgba(0,0,0,0.35)");
  g.fillStyle = v;
  g.fillRect(0, 0, W, H);
  g.restore();
  // inner hairline
  g.strokeStyle = st.accent;
  g.lineWidth = 3;
  rr(36, 36, W - 72, H - 72, 14);
  g.stroke();
  return c;
}
