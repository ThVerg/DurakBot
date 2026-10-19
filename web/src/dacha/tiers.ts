import type { BotsResponse } from "../api";

/** The four difficulty tiers shown to players; each maps to the first
 * available registry agent in its list. */
export const TIERS = [
  { id: "novice", agents: ["novice", "random"], strength: 1, suit: 1 },
  { id: "intermediate", agents: ["intermediate", "heuristic"], strength: 2, suit: 2 },
  { id: "expert", agents: ["expert", "solver"], strength: 3, suit: 0 },
  { id: "grandmaster", agents: ["grandmaster", "champion", "champion_fast"], strength: 4, suit: 3 },
] as const;
export type Tier = (typeof TIERS)[number];

export function tierAgent(tier: Tier, bots: BotsResponse | null): string | null {
  const avail = new Set((bots?.bots ?? []).map((b) => b.name));
  return tier.agents.find((a) => avail.has(a)) ?? null;
}

export function tierOfAgent(agent: string): Tier | null {
  return TIERS.find((t) => (t.agents as readonly string[]).includes(agent)) ?? null;
}
