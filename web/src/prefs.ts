// Per-viewer preferences, persisted in localStorage (best effort).
import { useEffect, useState } from "react";
import type { Lang } from "./i18n";

export type Speed = "slow" | "normal" | "fast" | "instant";
export type Theme = "felt" | "modern" | "kitchen" | "casino";
export type Back = "classic" | "navy" | "khokhloma" | "gzhel";
export type SortMode = "suit" | "rank";

export interface Prefs {
  speed: Speed;
  showWinProb: boolean;
  lang: Lang;
  theme: Theme;
  back: Back;
  fourColor: boolean;
  sound: boolean;
  sort: SortMode;
  tutorialDone: boolean;
  quality: "auto" | "high" | "medium" | "low" | "2d";
}

export const THEMES: Theme[] = ["felt", "modern", "kitchen", "casino"];
export const BACKS: Back[] = ["classic", "navy", "khokhloma", "gzhel"];

/** Animation time scale per speed (1 = slow). Instant disables flights. */
export const SPEED_SCALE: Record<Speed, number> = { slow: 1.35, normal: 0.85, fast: 0.45, instant: 0 };

function defaultLang(): Lang {
  try {
    return navigator.language?.toLowerCase().startsWith("ru") ? "ru" : "en";
  } catch {
    return "en";
  }
}

export const DEFAULT_PREFS: Prefs = {
  speed: "normal",
  showWinProb: true,
  lang: defaultLang(),
  theme: "felt",
  back: "classic",
  fourColor: false,
  sound: true,
  sort: "suit",
  tutorialDone: false,
  quality: "auto",
};

export function load<T extends object>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode etc. */
  }
}

export function usePrefs() {
  const [prefs, setPrefs] = useState<Prefs>(() => load("durak.prefs.v2", DEFAULT_PREFS));
  useEffect(() => {
    save("durak.prefs.v2", prefs);
    const root = document.documentElement;
    root.dataset.theme = prefs.theme;
    root.dataset.back = prefs.back;
    root.dataset.fourColor = prefs.fourColor ? "on" : "off";
    root.lang = prefs.lang;
  }, [prefs]);
  return [prefs, setPrefs] as const;
}
