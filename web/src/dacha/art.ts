// Art for the Dacha UI: the production kit in web/public/assets/dacha/
// (see manifest.json there). Card faces stay the CC0 set in /assets/cards*.
// Faces and backs come in 512px (1x) and, when present, @2x (1024) and @3x
// (1536) files; <img srcset> picks what the displayed size x DPR needs.
import { useEffect, useState } from "react";
import { cardCode } from "../assets";
import { ASSETS, publicUrl } from "../base"; // base-path aware (GitHub Pages)

const KIT = `${ASSETS}/dacha`;

export const BACKS = ["gzhel", "khokhloma", "stitch"] as const;
export type BackId = (typeof BACKS)[number];
export const FELTS = ["green", "cobalt", "vermilion"] as const;
export type FeltId = (typeof FELTS)[number];
export const FELT_HEX: Record<FeltId, string> = { green: "#3b8d5e", cobalt: "#3f6fc4", vermilion: "#c9553a" };

const PORTRAITS = new Set(["kostya", "dasha", "misha", "lev", "zina", "sveta", "grisha", "you"]);

export function portraitUrl(persona: string | null | undefined): string | null {
  if (!persona) return null;
  if (PORTRAITS.has(persona)) return `${KIT}/portraits/${persona}.webp`;
  return `${ASSETS}/avatars/${persona}.webp`;
}

export const frameUrl = () => `${KIT}/portraits/frame.svg`;

export function backId(id: string | null | undefined): BackId {
  return (BACKS.includes(id as BackId) ? id : "gzhel") as BackId;
}

export function backUrl(id: string): string {
  return `${KIT}/backs/${backId(id)}.webp`;
}

export function propUrl(name: string): string {
  if (name === "cap") return `${KIT}/brand/jester-cap.svg`;
  return `${KIT}/props/${name}.svg`;
}

export function brandUrl(name: "wordmark-ru" | "wordmark-ru-plain" | "wordmark-en" | "lockup" | "jester-cap"): string {
  return `${KIT}/brand/${name}.svg`;
}

export function illustrationUrl(name: "durak" | "safe", lang: string): string {
  return `${KIT}/illustrations/${name}-${lang === "ru" ? "ru" : "en"}.svg`;
}

/** Thumbnail-only faces (cards_sm) are for tiny icons; table cards use faceUrl(c, four). */
export function faceUrl(card: number, fourColor: boolean, small = false): string {
  const dir = fourColor ? "cards4" : small ? "cards_sm" : "cards";
  return `${ASSETS}/${dir}/${cardCode(card)}.webp`;
}

// ---------------------------------------------------------------- hi-res art
type HiKey = "cards" | "cards4" | "backs";
/** Which @2x / @3x sets exist (asked once; 1x only until known). */
const hi: Record<HiKey, [boolean, boolean]> = { cards: [false, false], cards4: [false, false], backs: [false, false] };
let hiPromise: Promise<void> | null = null;
const hiListeners = new Set<() => void>();

export function probeHiRes(): Promise<void> {
  if (!hiPromise) {
    // static build (VITE_BACKEND=local): the same answer, exported at build time
    hiPromise = fetch(import.meta.env.VITE_BACKEND === "local" ? publicUrl("static-data/art-hires.json") : "/api/art/hires")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Partial<Record<HiKey, [boolean, boolean]>> | null) => {
        if (!d) return;
        for (const k of Object.keys(hi) as HiKey[]) if (Array.isArray(d[k])) hi[k] = [!!d[k]![0], !!d[k]![0] && !!d[k]![1]];
        hiListeners.forEach((f) => f());
      })
      .catch(() => undefined);
  }
  return hiPromise;
}

/** Re-render once the hi-res probe has finished; returns a version number. */
export function useHiRes(): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    const f = () => setV((x) => x + 1);
    hiListeners.add(f);
    void probeHiRes();
    return () => {
      hiListeners.delete(f);
    };
  }, []);
  return v;
}

function srcSet(base: string, key: HiKey): string | undefined {
  const [two, three] = hi[key];
  if (!two) return undefined;
  return `${base}.webp 512w, ${base}@2x.webp 1024w${three ? `, ${base}@3x.webp 1536w` : ""}`;
}

/**
 * src + srcset for a card face (never the thumbnail set). ``byDpr`` (the
 * hand) picks the file matching the device pixel ratio (1x / @2x / @3x);
 * otherwise width descriptors + ``sizes`` pick by displayed size x DPR.
 * Either way the browser downloads only the one variant it needs.
 */
export function faceSrc(card: number, fourColor: boolean, byDpr = false): { src: string; srcSet?: string; byDpr?: boolean } {
  const dir = fourColor ? "cards4" : "cards";
  const base = `${ASSETS}/${dir}/${cardCode(card)}`;
  if (byDpr) {
    const [two, three] = hi[dir];
    if (!two) return { src: `${base}.webp` };
    return { src: `${base}.webp`, srcSet: `${base}.webp 1x, ${base}@2x.webp 2x${three ? `, ${base}@3x.webp 3x` : ""}`, byDpr: true };
  }
  return { src: `${base}.webp`, srcSet: srcSet(base, dir) };
}

/** src + srcset for a card back. */
export function backSrc(id: string): { src: string; srcSet?: string } {
  const base = `${KIT}/backs/${backId(id)}`;
  return { src: `${base}.webp`, srcSet: srcSet(base, "backs") };
}

/** If a hi-res candidate fails to load, fall back to the 512px file. */
export function dropSrcSet(e: { currentTarget: HTMLImageElement }) {
  const img = e.currentTarget;
  if (img.hasAttribute("srcset")) img.removeAttribute("srcset");
}

export function feltId(f: string | null | undefined): FeltId {
  return (FELTS.includes(f as FeltId) ? f : "green") as FeltId;
}

export function tableUrl(layout: "d" | "m", felt: string, lowRes = false): string {
  const f = feltId(felt);
  const name = `table-${layout === "d" ? "desktop" : "mobile"}${f === "green" ? "" : `-${f}`}`;
  return `${KIT}/table/${name}${lowRes && layout === "d" ? "@1x" : ""}.webp`;
}

/** Legacy theme ids -> felt ids. */
export function feltOf(theme: string): FeltId {
  const map: Record<string, FeltId> = { felt: "green", modern: "cobalt", kitchen: "vermilion", casino: "green", emerald: "green", royal: "cobalt", burgundy: "vermilion" };
  return (FELTS.includes(theme as FeltId) ? theme : map[theme] ?? "green") as FeltId;
}

/** Persona for each difficulty tier (title cast + lobby portraits), per the kit manifest. */
export const TIER_PERSONA: Record<string, string> = { novice: "kostya", intermediate: "dasha", expert: "misha", grandmaster: "lev" };
