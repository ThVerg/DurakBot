// Loads the Python-generated engine traces (scripts/export_engine_fixtures.py).
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test-fixtures", "engine");

export interface StateSnap {
  legal: number;
  phase: number;
  cur: number | null;
  hands: number[];
  known: number[];
  att: number[];
  def: number[];
  talon: number;
  discard: number;
  attacker: number;
  defender: number;
  throwers: number[];
  tidx: number;
  limit: number;
  first: boolean;
  bout: number;
  finished: number[];
  done: boolean;
  loser: number | null;
  stall: number;
  unseen: number[];
}

export interface Trace {
  seed: number;
  num_players: number;
  policy: string;
  deck: number[];
  fallback_attacker: number;
  used_fallback: boolean;
  trump_card: number;
  trump: number;
  initial: StateSnap;
  actions: number[];
  states: StateSnap[];
  returns: number[];
  log: [number, number][];
  special?: string;
}

export function loadTraces(n: number): Trace[] {
  const raw = gunzipSync(readFileSync(join(DIR, `traces_${n}p.json.gz`))).toString("utf8");
  return (JSON.parse(raw) as { traces: Trace[] }).traces;
}

export function loadCards(): { full_mask: number; rank_masks: number[]; suit_masks: number[]; beaters: number[][] } {
  return JSON.parse(readFileSync(join(DIR, "cards.json"), "utf8"));
}

export interface SessionCall {
  call: string;
  args: unknown[];
  response: Record<string, unknown>;
}

export interface SessionScenario {
  name: string;
  seed: number;
  num_players: number;
  human_seat: number | null;
  debug_at_start: boolean;
  deck: number[];
  fallback_attacker: number;
  names: string[];
  personas: (string | null)[];
  actions: number[];
  calls: SessionCall[];
}

export function loadScenarios(): SessionScenario[] {
  const p = join(DIR, "..", "session", "scenarios.json.gz");
  return (JSON.parse(gunzipSync(readFileSync(p)).toString("utf8")) as { scenarios: SessionScenario[] }).scenarios;
}

export function loadStorageFixture(): {
  records: Record<string, unknown>[];
  stats: Record<string, unknown>;
  timeline: Record<string, unknown>[];
} {
  const p = join(DIR, "..", "session", "scenarios.json.gz");
  return JSON.parse(gunzipSync(readFileSync(p)).toString("utf8")).storage;
}

export function loadStaticData(name: string): unknown {
  const p = join(DIR, "..", "..", "public", "static-data", name);
  return JSON.parse(readFileSync(p, "utf8"));
}
