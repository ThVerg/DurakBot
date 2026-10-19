import type { Player } from "../api";
import type { TFn } from "../i18n";

/** Speech bubble: a Russian phrase (always) + an English gloss (EN only). */
export interface Bubble {
  seat: number;
  ru: string;
  en: string;
  tone: "say" | "take" | "bita" | "pass" | "out" | "play";
  key: number;
}

export type NameLen = "full" | "mid" | "short";

export function displayName(p: Pick<Player, "is_human" | "persona" | "name">, t: TFn, len: NameLen | boolean = "full"): string {
  if (p.is_human) return t("role.you");
  const l = len === true ? "short" : len === false ? "full" : len;
  const key = l === "short" ? "personaShort" : l === "mid" ? "personaMid" : "persona";
  return p.persona ? t(`${key}.${p.persona}`) : p.name;
}

/** Occasional flavour lines from the bots (i18n keys say.<event>.<n>). */
export function speechKey(event: "take" | "out" | "bita" | "durak" | "winVsYou", seed: number, prob = 0.45): string | null {
  const counts = { take: 3, out: 3, bita: 2, durak: 2, winVsYou: 2 } as const;
  const r = Math.abs(Math.sin(seed * 12.9898) * 43758.5453) % 1;
  if (r > prob) return null;
  return `say.${event}.${Math.floor((r / prob) * counts[event]) % counts[event]}`;
}
