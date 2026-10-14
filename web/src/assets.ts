// Optional premium assets under /assets (manifest.json). Everything degrades
// gracefully to procedural placeholders when files are missing.

import { RANKS, SUITS } from "./cards";

export interface Manifest {
  version?: number;
  cards?: { dir?: string; dir_small?: string; dir_four?: string; ext?: string; width?: number; height?: number; codes?: string[] } | string[] | boolean;
  backs?: string[] | Record<string, unknown>;
  table?: Record<string, string>;
  avatars?: string[] | Record<string, string>;
  env?: Record<string, string> | string;
  ui?: Record<string, string> | string[];
  [k: string]: unknown;
}

let manifestPromise: Promise<Manifest | null> | null = null;

export function loadManifest(): Promise<Manifest | null> {
  if (!manifestPromise) {
    manifestPromise = fetch("/assets/manifest.json", { cache: "no-cache" })
      .then((r) => (r.ok ? (r.json() as Promise<Manifest>) : null))
      .catch(() => null);
  }
  return manifestPromise;
}

export const cardCode = (c: number) => `${RANKS[c % 9]}${SUITS[Math.floor(c / 9)]}`;

const exists = new Map<string, Promise<boolean>>();

/** HEAD-check a URL once (cached). */
export function urlExists(url: string): Promise<boolean> {
  let p = exists.get(url);
  if (!p) {
    p = fetch(url, { method: "HEAD" })
      .then((r) => r.ok && !(r.headers.get("content-type") ?? "").includes("text/html"))
      .catch(() => false);
    exists.set(url, p);
  }
  return p;
}

/** Load an image if it exists; resolves null otherwise. */
export function loadImage(url: string): Promise<HTMLImageElement | null> {
  return urlExists(url).then(
    (ok) =>
      ok
        ? new Promise<HTMLImageElement | null>((resolve) => {
            const img = new Image();
            img.decoding = "async";
            img.onload = () => resolve(img);
            img.onerror = () => resolve(null);
            img.src = url;
          })
        : null,
  );
}

function listFrom(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (v && typeof v === "object") return Object.keys(v as object);
  return [];
}

const probe = new Map<string, Promise<boolean>>();
/** Whether a whole asset directory is present (probes one known file once). */
function dirPresent(dir: string, sample: string): Promise<boolean> {
  let p = probe.get(dir);
  if (!p) {
    p = urlExists(`/assets/${dir}/${sample}`);
    probe.set(dir, p);
  }
  return p;
}

export async function cardFaceUrl(c: number, fourColor: boolean, small = false): Promise<string | null> {
  const dir = fourColor ? "cards4" : small ? "cards_sm" : "cards";
  if (await dirPresent(dir, "AS.webp")) return `/assets/${dir}/${cardCode(c)}.webp`;
  return fourColor ? cardFaceUrl(c, false, small) : null;
}

/** Card-back asset ids (our pref ids map onto the art set). */
const BACK_FILE: Record<string, string> = { classic: "red", red: "red", navy: "navy", khokhloma: "khokhloma", gzhel: "gzhel" };

export async function backUrl(id: string, small = false): Promise<string | null> {
  const file = BACK_FILE[id];
  if (!file) return null;
  const dir = small ? "backs_sm" : "backs";
  if (!(await dirPresent(dir, "red.webp"))) return null;
  return `/assets/${dir}/${file}.webp`;
}

export async function avatarUrl(id: string): Promise<string | null> {
  const m = await loadManifest();
  if (!m || !m.avatars) return null;
  const url = `/assets/avatars/${id}.webp`;
  return (await urlExists(url)) ? url : null;
}

export async function tableUrl(key: string): Promise<string | null> {
  const m = await loadManifest();
  if (!m || !m.table) return null;
  const v = (m.table as Record<string, unknown>)[key];
  const candidates = typeof v === "string" ? [v.startsWith("/") ? v : `/assets/${v.startsWith("table/") ? v : `table/${v}`}`] : [`/assets/table/${key}.webp`];
  for (const u of candidates) if (await urlExists(u)) return u;
  return null;
}

export async function envUrl(): Promise<string | null> {
  const m = await loadManifest();
  if (!m || !m.env) return null;
  const url = typeof m.env === "string" ? `/assets/${m.env}` : "/assets/env/room.webp";
  return (await urlExists(url)) ? url : null;
}

export async function backIds(): Promise<string[]> {
  const m = await loadManifest();
  return m ? listFrom(m.backs) : [];
}
