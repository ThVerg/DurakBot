// Persistence for the in-browser backend: finished games (for /api/stats and
// the Lab's human timeline) and resumable sessions, in IndexedDB. Falls back to
// memory when IndexedDB is unavailable (private mode, tests).
// stats() and timeline() are ports of server/storage.py.

import { pyRound } from "./pyround";

export interface GameRecord {
  id: string;
  date: string;
  mode: string;
  num_players: number;
  human_seat: number | null;
  seats: string[];
  loser: number | null;
  finished: number[];
  human_result: string | null;
  human_place: number | null;
  moves: number;
  seed: number | null;
  debug_used: boolean;
  end_reason: string | null;
  hints_used: number;
  /** Insertion counter (stable order for games recorded in the same second). */
  seq?: number;
}

/** What is needed to rebuild a live session after a page reload. */
export interface SavedSession {
  id: string;
  seed: number;
  num_players: number;
  human_seat: number | null;
  seat_bots: (string | null)[];
  debug_reveal: boolean;
  debug_used: boolean;
  hints_used: number;
  recorded: boolean;
  actions: number[];
  history: Record<string, unknown>[];
  touched: number;
}

export interface Store {
  record(rec: Omit<GameRecord, "date" | "seq"> & { date?: string }): Promise<void>;
  /** Newest first. */
  rows(): Promise<GameRecord[]>;
  saveSession(s: SavedSession): Promise<void>;
  loadSession(id: string): Promise<SavedSession | null>;
  /** Keep only the `keep` most recently touched sessions. */
  pruneSessions(keep: number): Promise<void>;
}

/** Python: datetime.now(timezone.utc).isoformat(timespec="seconds"). */
export function isoNow(): string {
  return new Date().toISOString().slice(0, 19) + "+00:00";
}

function sortRows(rows: GameRecord[]): GameRecord[] {
  return rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.seq ?? 0) - (a.seq ?? 0)));
}

// ------------------------------------------------------------------ memory
export class MemoryStore implements Store {
  private games = new Map<string, GameRecord>();
  private sessions = new Map<string, SavedSession>();
  private seq = 0;

  async record(rec: Omit<GameRecord, "date" | "seq"> & { date?: string }): Promise<void> {
    const row: GameRecord = { ...rec, date: rec.date ?? isoNow(), seq: ++this.seq } as GameRecord;
    this.games.set(row.id, row);
  }
  async rows(): Promise<GameRecord[]> {
    return sortRows([...this.games.values()].map((r) => ({ ...r })));
  }
  async saveSession(s: SavedSession): Promise<void> {
    this.sessions.set(s.id, structuredCloneSafe(s));
  }
  async loadSession(id: string): Promise<SavedSession | null> {
    const s = this.sessions.get(id);
    return s ? structuredCloneSafe(s) : null;
  }
  async pruneSessions(keep: number): Promise<void> {
    const all = [...this.sessions.values()].sort((a, b) => b.touched - a.touched);
    for (const s of all.slice(keep)) this.sessions.delete(s.id);
  }
}

function structuredCloneSafe<T>(x: T): T {
  return typeof structuredClone === "function" ? structuredClone(x) : (JSON.parse(JSON.stringify(x)) as T);
}

// --------------------------------------------------------------- IndexedDB
const DB_NAME = "durakbot-local";
const DB_VERSION = 1;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export class IDBStore implements Store {
  private db: Promise<IDBDatabase>;

  constructor(private readonly name = DB_NAME) {
    this.db = new Promise((resolve, reject) => {
      const open = indexedDB.open(this.name, DB_VERSION);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains("games")) db.createObjectStore("games", { keyPath: "id" });
        if (!db.objectStoreNames.contains("sessions")) db.createObjectStore("sessions", { keyPath: "id" });
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
      open.onblocked = () => reject(new Error("IndexedDB blocked"));
    });
  }

  /** Resolves true if the database opens (used to pick a fallback). */
  async ready(): Promise<boolean> {
    try {
      await this.db;
      return true;
    } catch {
      return false;
    }
  }

  private async tx<T>(stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => Promise<T>): Promise<T> {
    const db = await this.db;
    const t = db.transaction(stores, mode);
    const done = new Promise<void>((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error ?? new Error("transaction aborted"));
    });
    done.catch(() => undefined); // observed below; avoid an unhandled rejection if fn throws
    const out = await fn(t);
    await done;
    return out;
  }

  async record(rec: Omit<GameRecord, "date" | "seq"> & { date?: string }): Promise<void> {
    await this.tx(["games", "meta"], "readwrite", async (t) => {
      const meta = t.objectStore("meta");
      const seq = ((await req(meta.get("seq"))) as number | undefined) ?? 0;
      meta.put(seq + 1, "seq");
      t.objectStore("games").put({ ...rec, date: rec.date ?? isoNow(), seq: seq + 1 });
    });
  }

  async rows(): Promise<GameRecord[]> {
    const rows = await this.tx(["games"], "readonly", (t) => req(t.objectStore("games").getAll()));
    return sortRows(rows as GameRecord[]);
  }

  async saveSession(s: SavedSession): Promise<void> {
    await this.tx(["sessions"], "readwrite", async (t) => {
      t.objectStore("sessions").put(s);
    });
  }

  async loadSession(id: string): Promise<SavedSession | null> {
    const s = await this.tx(["sessions"], "readonly", (t) => req(t.objectStore("sessions").get(id)));
    return (s as SavedSession | undefined) ?? null;
  }

  async pruneSessions(keep: number): Promise<void> {
    await this.tx(["sessions"], "readwrite", async (t) => {
      const st = t.objectStore("sessions");
      const all = ((await req(st.getAll())) as SavedSession[]).sort((a, b) => b.touched - a.touched);
      for (const s of all.slice(keep)) st.delete(s.id);
    });
  }
}

/** IndexedDB when it works, else memory. */
export async function openStore(): Promise<Store> {
  if (typeof indexedDB !== "undefined") {
    try {
      const s = new IDBStore();
      if (await s.ready()) return s;
    } catch {
      /* fall through */
    }
  }
  return new MemoryStore();
}

// ------------------------------------------------------------------- stats
const rate = (a: number, b: number): number | null => (b ? pyRound(a / b, 4) : null);
const round = pyRound;

/** Port of Storage.stats() (the /api/stats payload). */
export function stats(rows: GameRecord[]) {
  const play = rows.filter((r) => r.mode === "play");

  const byN = [];
  for (let n = 2; n <= 6; n++) {
    const rs = play.filter((r) => r.num_players === n);
    if (!rs.length) continue;
    const durak = rs.filter((r) => r.human_result === "durak").length;
    const draws = rs.filter((r) => r.human_result === "draw").length;
    const places = rs.map((r) => r.human_place).filter((p): p is number => !!p);
    byN.push({
      num_players: n,
      games: rs.length,
      human_durak: durak,
      human_durak_rate: rate(durak, rs.length),
      expected_durak_rate: round(1 / n, 4),
      draws,
      avg_place: places.length ? round(places.reduce((s, x) => s + x, 0) / places.length, 2) : null,
    });
  }

  interface BotAcc {
    bot: string;
    seats: number;
    durak: number;
    expected: number;
    human_games: number;
    human_durak: number;
  }
  const bots = new Map<string, BotAcc>();
  for (const r of rows) {
    r.seats.forEach((name, seat) => {
      if (name === "human") return;
      let b = bots.get(name);
      if (!b) {
        b = { bot: name, seats: 0, durak: 0, expected: 0, human_games: 0, human_durak: 0 };
        bots.set(name, b);
      }
      b.seats += 1;
      b.expected += 1 / r.num_players;
      if (r.loser === seat) b.durak += 1;
    });
    if (r.mode === "play") {
      for (const name of new Set(r.seats.filter((s) => s !== "human"))) {
        const b = bots.get(name)!;
        b.human_games += 1;
        b.human_durak += r.human_result === "durak" ? 1 : 0;
      }
    }
  }
  const byBot = [...bots.values()]
    .sort((a, b) => (a.bot < b.bot ? -1 : a.bot > b.bot ? 1 : 0))
    .map((b) => ({
      bot: b.bot,
      seats: b.seats,
      durak: b.durak,
      durak_rate: rate(b.durak, b.seats),
      expected_durak_rate: rate(b.expected, b.seats),
      human_games: b.human_games,
      human_durak: b.human_durak,
      human_durak_rate: rate(b.human_durak, b.human_games),
    }));

  const humanDurak = play.filter((r) => r.human_result === "durak").length;
  const humanSafe = play.filter((r) => r.human_result === "safe").length;
  let best = 0;
  let cur = 0;
  for (const r of [...play].reverse()) {
    // oldest first
    if (r.human_result === "safe") {
      cur += 1;
      best = Math.max(best, cur);
    } else if (r.human_result === "durak") cur = 0;
  }
  const keys = [
    "id", "date", "mode", "num_players", "human_seat", "seats", "loser",
    "human_result", "human_place", "moves", "debug_used", "end_reason", "hints_used",
  ] as const;
  return {
    total_games: rows.length,
    human_games: play.length,
    spectated_games: rows.length - play.length,
    human_durak: humanDurak,
    human_safe: humanSafe,
    streak_best: best,
    streak_current: cur,
    human_durak_rate: rate(humanDurak, play.length),
    by_players: byN,
    by_bot: byBot,
    recent: rows.slice(0, 20).map((r) => Object.fromEntries(keys.map((k) => [k, r[k] ?? null]))),
  };
}

/** Port of Storage.timeline(): human games, oldest first (Lab page). */
export function timeline(rows: GameRecord[]) {
  return [...rows]
    .reverse()
    .filter((r) => r.mode === "play")
    .map((r) => ({
      date: r.date,
      num_players: r.num_players,
      bots: [...new Set(r.seats.filter((s) => s !== "human"))].sort(),
      result: r.human_result,
      place: r.human_place,
      moves: r.moves,
      assisted: !!r.debug_used || !!r.hints_used,
    }));
}
