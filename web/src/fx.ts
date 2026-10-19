// Confetti for escaping the durak (canvas on an overlay layer).

let layer: HTMLDivElement | null = null;

function fxLayer(): HTMLDivElement {
  if (layer && document.body.contains(layer)) return layer;
  layer = document.createElement("div");
  layer.className = "fx-layer";
  layer.setAttribute("aria-hidden", "true");
  document.body.appendChild(layer);
  return layer;
}

export function clearFx() {
  if (layer) layer.replaceChildren();
}

export const reducedMotion = () => {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
};

// ------------------------------------------------------------------ confetti
const SUIT_PATHS = [
  "M50 2 C60 20 98 38 98 62 C98 78 86 88 72 88 C63 88 56 84 53 77 C54 88 58 95 67 100 L33 100 C42 95 46 88 47 77 C44 84 37 88 28 88 C14 88 2 78 2 62 C2 38 40 20 50 2 Z",
  "M50 4 A21 21 0 0 1 66 39 A21 21 0 1 1 55 72 C56 86 60 94 68 100 L32 100 C40 94 44 86 45 72 A21 21 0 1 1 34 39 A21 21 0 0 1 50 4 Z",
  "M50 0 L90 50 L50 100 L10 50 Z",
  "M50 92 C22 70 2 52 2 30 C2 13 15 3 29 3 C39 3 46 9 50 18 C54 9 61 3 71 3 C85 3 98 13 98 30 C98 52 78 70 50 92 Z",
];

export function confetti(durationMs = 3200) {
  if (reducedMotion()) return;
  const canvas = document.createElement("canvas");
  canvas.className = "fx-confetti";
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = window.innerWidth;
  const H = window.innerHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  fxLayer().appendChild(canvas);
  const c = canvas.getContext("2d");
  if (!c) return;
  c.scale(dpr, dpr);
  const paths = SUIT_PATHS.map((d) => new Path2D(d));
  const colors = ["#c8361f", "#e0a52a", "#2350b4", "#2f6b45", "#f7d673", "#fffaf0", "#e2563a"];
  const parts = Array.from({ length: Math.min(160, Math.round(W / 6)) }, (_, i) => ({
    x: W / 2 + (Math.random() - 0.5) * W * 0.3,
    y: H * 0.55,
    vx: (Math.random() - 0.5) * 14,
    vy: -10 - Math.random() * 12,
    r: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.3,
    s: 7 + Math.random() * 9,
    kind: i % 3 === 0 ? 4 : Math.floor(Math.random() * 4),
    color: colors[i % colors.length],
    wob: Math.random() * 10,
  }));
  const t0 = performance.now();
  const tick = (now: number) => {
    const t = now - t0;
    c.clearRect(0, 0, W, H);
    const fade = Math.max(0, Math.min(1, (durationMs - t) / 600));
    for (const p of parts) {
      p.vy += 0.38;
      p.vx *= 0.99;
      p.x += p.vx + Math.sin((t / 200) + p.wob) * 0.6;
      p.y += p.vy;
      p.r += p.vr;
      c.save();
      c.globalAlpha = fade;
      c.translate(p.x, p.y);
      c.rotate(p.r);
      c.fillStyle = p.color;
      if (p.kind === 4) {
        c.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
      } else {
        c.scale(p.s / 100, p.s / 100);
        c.translate(-50, -50);
        c.fill(paths[p.kind]);
      }
      c.restore();
    }
    if (t < durationMs) requestAnimationFrame(tick);
    else canvas.remove();
  };
  requestAnimationFrame(tick);
}
