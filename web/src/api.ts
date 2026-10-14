// Types and fetch helpers for the DurakBot API (server/app.py).

export type Phase = "attack" | "defend" | "throw_in";
export type PassLabel = "bita" | "pass" | "take" | "done";
export type StepKind = "lead" | "throw" | "beat" | "throw_in" | PassLabel;
export type EndReason = "durak" | "draw" | "stalemate";

export interface Player {
  seat: number;
  name: string;
  persona: string | null;
  bot: string | null;
  is_human: boolean;
  hand_size: number;
  known: number[];
  hand?: number[];
  is_attacker: boolean;
  is_defender: boolean;
  is_thrower: boolean;
  to_move: boolean;
  out: boolean;
  place: number | null;
  is_durak: boolean;
}

export interface TablePair {
  attack: number;
  defense: number | null;
}

export interface Result {
  loser: number | null;
  draw: boolean;
  reason: EndReason;
  finished: number[];
  human?: "durak" | "safe" | "draw";
  place?: number | null;
}

export interface GameState {
  game_id: string;
  mode: "play" | "spectate";
  num_players: number;
  human_seat: number | null;
  debug_reveal: boolean;
  players: Player[];
  hand: number[];
  table: TablePair[];
  bout_limit: number;
  first_bout: boolean;
  trump_card: number;
  trump_suit: number;
  talon_size: number;
  discard_count: number;
  discard?: number[];
  attacker: number;
  defender: number;
  throwers: number[];
  thrower_idx: number;
  phase: Phase;
  to_move: number | null;
  your_turn: boolean;
  legal: number[];
  pass_label: PassLabel | null;
  bout: number;
  moves: number;
  stall: number;
  done: boolean;
  loser: number | null;
  finished: number[];
  result: Result | null;
  seed?: number | null;
}

export type GameEvent =
  | { type: "bita"; cards: number[] }
  | { type: "pickup"; player: number; cards: number[] }
  | { type: "draw"; player: number; count: number; cards?: number[]; took_trump_card?: boolean }
  | { type: "talon_empty" }
  | { type: "out"; player: number; place: number }
  | { type: "game_over"; loser: number | null; reason?: EndReason }
  | { type: "new_bout"; attacker: number; defender: number };

export interface Step {
  seq: number;
  player: number;
  action: number;
  card: number | null;
  kind: StepKind;
  phase: Phase;
  events: GameEvent[];
  think_ms?: number;
  view?: GameState;
}

export interface StepsResponse {
  game_id: string;
  steps: Step[];
  state: GameState;
}

export interface BotInfo {
  name: string;
  label: string;
  labels: { en: string; ru: string };
  desc: { en: string; ru: string };
  tier: number | null;
  elo: number | null;
}

export interface BotsResponse {
  bots: BotInfo[];
  default: string;
  evaluate_available: boolean;
  min_players: number;
  max_players: number;
}

export interface HintMove {
  action: number;
  win: number | null;
  policy: number | null;
}

export interface Hint {
  available: boolean;
  has_values: boolean;
  exact?: boolean;
  current?: number;
  recommended: number;
  best?: number;
  moves: HintMove[];
}

export interface Decision {
  seq: number;
  chosen: number;
  best: number;
  chosen_win: number;
  best_win: number;
  loss: number;
  values: { action: number; win: number }[];
}

export interface Analysis {
  status: "running" | "ready" | "error" | "unavailable";
  progress?: number;
  partial?: boolean;
  timeline?: { seq: number; win: number }[];
  decisions?: Decision[];
  mistakes?: Decision[];
  accuracy?: number | null;
}

export interface ReplayFrame {
  seq: number;
  step: Step | null;
  view: GameState;
}

export interface StatsResponse {
  total_games: number;
  human_games: number;
  spectated_games: number;
  human_durak: number;
  human_durak_rate: number | null;
  by_players: {
    num_players: number;
    games: number;
    human_durak: number;
    human_durak_rate: number | null;
    expected_durak_rate: number;
    draws: number;
    avg_place: number | null;
  }[];
  by_bot: {
    bot: string;
    seats: number;
    durak: number;
    durak_rate: number | null;
    expected_durak_rate: number | null;
    human_games: number;
    human_durak: number;
    human_durak_rate: number | null;
  }[];
  recent: {
    id: string;
    date: string;
    mode: string;
    num_players: number;
    human_seat: number | null;
    seats: string[];
    loser: number | null;
    human_result: string | null;
    human_place: number | null;
    moves: number;
    debug_used: boolean;
    end_reason?: string | null;
  }[];
}

export interface RateCI {
  rate?: number;
  ci?: [number, number];
  games?: number;
}

export interface EvalEntry {
  iter?: number;
  steps?: number;
  time?: string;
  promoted?: boolean;
  rejected?: string;
  ckpt?: string;
  rates: Record<string, Record<string, RateCI>>;
}

export interface LabData {
  run: string;
  runs: string[];
  training_active: boolean;
  train: { rows: number; columns: string[]; series: Record<string, (number | null)[]> } | null;
  evals: EvalEntry[] | null;
  promotions: EvalEntry[] | null;
  champion: EvalEntry | null;
  eval_summary: {
    updated?: string;
    iteration?: number;
    results?: Record<string, Record<string, RateCI>>;
  } | null;
  ladder: { updated?: string; by_n: Record<string, { bot: string; elo: number; games?: number; ci?: unknown }[]>; raw?: unknown } | null;
  human: { date: string; num_players: number; bots: string[]; result: string | null; place: number | null; moves: number; assisted: boolean }[];
}

export interface CreateGameRequest {
  num_players: number;
  human_seat: number | null;
  spectate: boolean;
  bot?: string;
  bots?: (string | null)[];
  seed?: number | null;
  debug_reveal?: boolean;
  auto?: boolean;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = await res.json();
      msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, msg);
  }
  return (await res.json()) as T;
}

/** Retry transient network failures (not HTTP 4xx). */
async function retrying<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (e instanceof ApiError && e.status < 500) throw e;
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw last;
}

export const api = {
  bots: () => request<BotsResponse>("GET", "/bots"),
  create: (req: CreateGameRequest) => request<StepsResponse>("POST", "/games", req),
  get: (id: string) => retrying(() => request<{ game_id: string; state: GameState; history: Step[] }>("GET", `/games/${id}`)),
  act: (id: string, action: number) => request<StepsResponse>("POST", `/games/${id}/action`, { action, auto: false }),
  advance: (id: string, until: "step" | "bout" | "end", max_steps = 1) =>
    retrying(() => request<StepsResponse>("POST", `/games/${id}/advance`, { until, max_steps })),
  debug: (id: string, reveal: boolean) =>
    request<{ game_id: string; state: GameState }>("POST", `/games/${id}/debug`, { reveal }),
  evaluate: (id: string) =>
    request<{ available: boolean; values: Record<string, number> }>("GET", `/games/${id}/evaluate`),
  hint: (id: string) => request<Hint>("GET", `/games/${id}/hint`),
  analysis: (id: string) => request<Analysis>("GET", `/games/${id}/analysis`),
  replay: (id: string) => request<{ game_id: string; frames: ReplayFrame[] }>("GET", `/games/${id}/replay`),
  stats: () => request<StatsResponse>("GET", "/stats"),
  lab: (run?: string) => request<LabData>("GET", `/lab${run ? `?run=${encodeURIComponent(run)}` : ""}`),
};
