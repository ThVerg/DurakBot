// Texture factory: card faces/backs (assets when present, procedural
// placeholders otherwise) and procedural table materials. All textures are
// cached and can be disposed together.
import * as THREE from "three";
import { backUrl, cardFaceUrl, loadImage, tableUrl } from "../assets";
import { drawBack, faceSvg, svgToCanvas } from "./cardArt";

const cache = new Map<string, THREE.Texture>();
let maxAniso = 4;

export function setMaxAnisotropy(n: number) {
  maxAniso = Math.max(1, Math.min(8, n));
}

function prep(t: THREE.Texture, srgb = true): THREE.Texture {
  t.anisotropy = maxAniso;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

function blankCanvas(w = 8, h = 11, color = "#f6f0e2") {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  g.fillStyle = color;
  g.fillRect(0, 0, w, h);
  return c;
}

/** Card face texture; fills in asynchronously (asset > SVG placeholder). */
export function faceTexture(card: number, fourColor: boolean): THREE.Texture {
  const key = `face:${card}:${fourColor ? 4 : 2}`;
  let t = cache.get(key);
  if (t) return t;
  const tex = prep(new THREE.CanvasTexture(blankCanvas()));
  cache.set(key, tex);
  t = tex;
  (async () => {
    const url = await cardFaceUrl(card, fourColor);
    const img = url ? await loadBitmap(url) : null;
    swapImage(tex, img ?? (await svgToCanvas(faceSvg(card, fourColor), 512, 716)));
  })();
  return t;
}

export function backTexture(id: string): THREE.Texture {
  const key = `back:${id}`;
  let t = cache.get(key);
  if (t) return t;
  const tex = prep(new THREE.CanvasTexture(drawBack(id)));
  cache.set(key, tex);
  t = tex;
  (async () => {
    const url = await backUrl(id);
    const img = url ? await loadBitmap(url) : null;
    if (img) swapImage(tex, img);
  })();
  return t;
}

/** Replace a texture's image. WebGL2 textures use immutable storage, so a
 * size change needs the GPU texture to be re-created (dispose first). */
export function swapImage(tex: THREE.Texture, img: TexImageSource | HTMLCanvasElement | HTMLImageElement) {
  const old = tex.image as { width?: number; height?: number } | undefined;
  const nw = (img as { width: number }).width, nh = (img as { height: number }).height;
  tex.image = img;
  if (!old || old.width !== nw || old.height !== nh) tex.dispose();
  tex.needsUpdate = true;
}

/** Load an image without the HEAD probe (the caller knows it exists). */
function loadBitmap(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

// ----------------------------------------------------------- procedural maps
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function heightToNormal(h: Float32Array, n: number, strength: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = n;
  const g = c.getContext("2d")!;
  const img = g.createImageData(n, n);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const hl = h[y * n + ((x - 1 + n) % n)];
      const hr = h[y * n + ((x + 1) % n)];
      const hu = h[((y - 1 + n) % n) * n + x];
      const hd = h[((y + 1) % n) * n + x];
      let nx = (hl - hr) * strength;
      let ny = (hu - hd) * strength;
      let nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;
      img.data[i * 4] = (nx * 0.5 + 0.5) * 255;
      img.data[i * 4 + 1] = (ny * 0.5 + 0.5) * 255;
      img.data[i * 4 + 2] = (nz * 0.5 + 0.5) * 255;
      img.data[i * 4 + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  return c;
}

/** Felt: fine fibres (normal) + subtle colour mottling. */
export function feltMaps(color: string): { map: THREE.Texture; normal: THREE.Texture } {
  const key = `felt:${color}`;
  const hit = cache.get(key);
  if (hit) return { map: hit, normal: cache.get("felt:normal")! };
  const n = 256;
  const r = rng(7);
  // colour map
  const c = document.createElement("canvas");
  c.width = c.height = n;
  const g = c.getContext("2d")!;
  g.fillStyle = color;
  g.fillRect(0, 0, n, n);
  for (let i = 0; i < 2600; i++) {
    const x = r() * n, y = r() * n;
    const a = r() * Math.PI;
    const l = 2 + r() * 5;
    g.strokeStyle = r() < 0.5 ? "rgba(255,255,255,0.035)" : "rgba(0,0,0,0.05)";
    g.lineWidth = 0.7;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
    g.stroke();
  }
  const map = prep(new THREE.CanvasTexture(c));
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  cache.set(key, map);
  let normal = cache.get("felt:normal");
  if (!normal) {
    const h = new Float32Array(n * n);
    for (let i = 0; i < 9000; i++) {
      let x = r() * n, y = r() * n;
      const a = r() * Math.PI * 2;
      for (let k = 0; k < 6; k++) {
        h[(Math.floor(y + n) % n) * n + (Math.floor(x + n) % n)] += 0.35;
        x += Math.cos(a);
        y += Math.sin(a);
      }
    }
    for (let i = 0; i < h.length; i++) h[i] += r() * 0.25;
    normal = prep(new THREE.CanvasTexture(heightToNormal(h, n, 1.6)), false);
    normal.wrapS = normal.wrapT = THREE.RepeatWrapping;
    cache.set("felt:normal", normal);
  }
  return { map, normal };
}

/** Polished walnut grain. */
export function walnutMap(): THREE.Texture {
  const hit = cache.get("walnut");
  if (hit) return hit;
  const w = 1024, h = 128;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, "#3b2214");
  grad.addColorStop(0.5, "#4f2e1b");
  grad.addColorStop(1, "#2e190e");
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  const r = rng(3);
  for (let i = 0; i < 70; i++) {
    const y0 = r() * h;
    g.strokeStyle = r() < 0.5 ? "rgba(20,10,4,0.35)" : "rgba(120,72,40,0.25)";
    g.lineWidth = 0.6 + r() * 1.8;
    g.beginPath();
    for (let x = 0; x <= w; x += 16) {
      const y = y0 + Math.sin(x * 0.006 + i) * 6 + Math.sin(x * 0.021 + i * 3) * 2;
      if (x === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }
  const t = prep(new THREE.CanvasTexture(c));
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  cache.set("walnut", t);
  return t;
}

/** Leather pebble normal map. */
export function leatherNormal(): THREE.Texture {
  const hit = cache.get("leather");
  if (hit) return hit;
  const n = 128;
  const r = rng(11);
  const h = new Float32Array(n * n);
  for (let i = 0; i < 700; i++) {
    const cx = r() * n, cy = r() * n, rad = 2 + r() * 4;
    for (let y = -6; y <= 6; y++)
      for (let x = -6; x <= 6; x++) {
        const d = Math.hypot(x, y) / rad;
        if (d < 1) h[((Math.floor(cy + y) + n) % n) * n + ((Math.floor(cx + x) + n) % n)] += (1 - d * d) * 0.5;
      }
  }
  const t = prep(new THREE.CanvasTexture(heightToNormal(h, n, 1.2)), false);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  cache.set("leather", t);
  return t;
}

/** Gold emblem decal for the felt centre. */
export function emblemTexture(): THREE.Texture {
  const hit = cache.get("emblem");
  if (hit) return hit;
  const w = 1024, h = 512;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  g.strokeStyle = "rgba(212,175,55,0.9)";
  g.fillStyle = "rgba(212,175,55,0.9)";
  g.lineWidth = 4;
  g.beginPath();
  g.ellipse(w / 2, h / 2, 470, 220, 0, 0, Math.PI * 2);
  g.stroke();
  g.lineWidth = 1.5;
  g.beginPath();
  g.ellipse(w / 2, h / 2, 450, 204, 0, 0, Math.PI * 2);
  g.stroke();
  g.font = "700 120px 'Playfair Display', Georgia, serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("ДУРАК", w / 2, h / 2 - 18);
  g.font = "500 34px Inter, Arial, sans-serif";
  g.fillText("P O D K I D N O Y   ·   D U R A K B O T", w / 2, h / 2 + 78);
  const t = prep(new THREE.CanvasTexture(c));
  cache.set("emblem", t);
  return t;
}

/** Replace a procedural texture by a table asset when it exists. */
export async function upgradeFromAsset(tex: THREE.Texture, key: string, srgb = true): Promise<boolean> {
  const url = await tableUrl(key);
  const img = url ? await loadImage(url) : null;
  if (!img) return false;
  if (!srgb) tex.colorSpace = THREE.NoColorSpace;
  swapImage(tex, img);
  return true;
}

export function disposeAll() {
  for (const t of cache.values()) t.dispose();
  cache.clear();
}

/**
 * A texture from /assets (sRGB colour or linear data). Starts from
 * ``fallback`` (procedural) and swaps in the asset once loaded; if the asset
 * is missing the fallback simply stays.
 */
export function assetTexture(url: string, opts: { srgb?: boolean; fallback?: () => THREE.Texture; repeat?: [number, number] } = {}): THREE.Texture {
  const key = `asset:${url}`;
  let t = cache.get(key);
  if (t) return t;
  const base = opts.fallback ? opts.fallback().clone() : new THREE.Texture();
  if (!opts.fallback) base.image = blankCanvas(4, 4, "#777");
  const tex = prep(base, opts.srgb !== false);
  if (opts.srgb === false) tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  if (opts.repeat) tex.repeat.set(opts.repeat[0], opts.repeat[1]);
  cache.set(key, tex);
  loadBitmap(url).then((img) => {
    if (img) swapImage(tex, img);
  });
  return tex;
}

/** Equirectangular environment (reflections) + blurred room background. */
export function roomEnv(url: string): Promise<THREE.Texture | null> {
  return loadBitmap(url).then((img) => {
    if (!img) return null;
    const t = new THREE.Texture(img);
    t.mapping = THREE.EquirectangularReflectionMapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    cache.set(`env:${url}`, t);
    return t;
  });
}
