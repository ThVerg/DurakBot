// Flying-card animations (Web Animations API on an overlay layer) and confetti.

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

export function rectOf(el: Element | null | undefined): DOMRect | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width || r.height ? r : null;
}

/** A card-back element sized like the given card width. */
export function makeBack(width: number): HTMLElement {
  const d = document.createElement("div");
  d.className = "card card-back fx-card";
  d.style.setProperty("--w", `${width}px`);
  const inner = document.createElement("div");
  inner.className = "card-back-inner";
  d.appendChild(inner);
  return d;
}

/** Two-sided card (front = clone of a rendered card, back = card back). */
export function makeFlipCard(front: HTMLElement, width: number, showBackFirst: boolean): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = `fx-flip ${showBackFirst ? "show-back" : ""}`;
  const f = front.cloneNode(true) as HTMLElement;
  f.classList.add("fx-face", "fx-front");
  f.classList.remove("fly-in", "legal", "dimmed", "selected", "clickable");
  f.style.cssText = "";
  f.style.setProperty("--w", `${width}px`);
  const b = makeBack(width);
  b.classList.add("fx-face", "fx-backface");
  wrap.append(f, b);
  return wrap;
}

export interface FlyOptions {
  from: DOMRect;
  to: DOMRect;
  duration: number;
  delay?: number;
  rotFrom?: number;
  rotTo?: number;
  arc?: number;
  flip?: boolean; // rotateY 180 during the flight
  fadeOut?: boolean;
  land?: boolean; // little squash on landing
}

/** Fly ``el`` from one rect to another. Resolves when done (element removed). */
export function fly(el: HTMLElement, o: FlyOptions): Promise<void> {
  const root = fxLayer();
  const w = o.from.width;
  const h = o.from.height;
  el.style.position = "fixed";
  el.style.left = `${o.from.left}px`;
  el.style.top = `${o.from.top}px`;
  el.style.width = `${w}px`;
  el.style.height = `${h}px`;
  el.style.margin = "0";
  el.style.transformOrigin = "50% 50%";
  el.style.zIndex = "1";
  root.appendChild(el);
  const dx = o.to.left + o.to.width / 2 - (o.from.left + w / 2);
  const dy = o.to.top + o.to.height / 2 - (o.from.top + h / 2);
  const s = o.to.width / w;
  const arc = o.arc ?? Math.min(90, Math.hypot(dx, dy) * 0.18);
  const r0 = o.rotFrom ?? 0;
  const r1 = o.rotTo ?? 0;
  const fl = (k: number) => (o.flip ? ` rotateY(${180 * k}deg)` : "");
  const kf: Keyframe[] = [
    { transform: `translate(0px,0px) scale(1) rotate(${r0}deg)${fl(0)}`, opacity: 1, offset: 0 },
    {
      transform: `translate(${dx * 0.5}px,${dy * 0.5 - arc}px) scale(${(1 + s) / 2 + 0.08}) rotate(${(r0 + r1) / 2 + 6}deg)${fl(0.5)}`,
      opacity: 1,
      offset: 0.5,
    },
  ];
  if (o.land) {
    kf.push({ transform: `translate(${dx}px,${dy}px) scale(${s * 1.07}) rotate(${r1}deg)${fl(1)}`, opacity: 1, offset: 0.86 });
  }
  kf.push({
    transform: `translate(${dx}px,${dy}px) scale(${s}) rotate(${r1}deg)${fl(1)}`,
    opacity: o.fadeOut ? 0 : 1,
    offset: 1,
  });
  const anim = el.animate(kf, {
    duration: Math.max(1, o.duration),
    delay: o.delay ?? 0,
    easing: "cubic-bezier(.25,.75,.3,1)",
    fill: "both",
  });
  return new Promise((resolve) => {
    const done = () => {
      el.remove();
      resolve();
    };
    anim.onfinish = done;
    anim.oncancel = done;
  });
}

/** Hide an element for the duration of a promise (used for FLIP landings). */
export async function hiddenDuring<T>(el: HTMLElement | null, p: Promise<T>): Promise<T> {
  if (el) el.style.visibility = "hidden";
  try {
    return await p;
  } finally {
    if (el) el.style.visibility = "";
  }
}

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
  const colors = ["#e9c46a", "#f4d58d", "#ef6f50", "#7cf2c2", "#4ea8de", "#ffffff", "#c8102e"];
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
