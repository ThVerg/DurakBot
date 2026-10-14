// Turns server steps/events into human-readable move-log entries.
import type { Step } from "./api";

export type Seg = string | { card: number } | { who: number };

export interface LogEntry {
  id: string;
  seat: number | null;
  tone: "play" | "pass" | "take" | "bita" | "info" | "out" | "end" | "bout";
  segs: Seg[];
}

const VERB: Record<string, [string, string]> = {
  lead: ["leads", "lead"],
  throw: ["throws in", "throw in"],
  beat: ["covers with", "cover with"],
  throw_in: ["adds", "add"],
};

export function stepText(kind: string): string {
  switch (kind) {
    case "bita":
      return "Bita!";
    case "pass":
      return "Pass";
    case "take":
      return "I take";
    case "done":
      return "Done";
    default:
      return "";
  }
}

export function describeStep(st: Step, human: number | null): LogEntry[] {
  const out: LogEntry[] = [];
  // Third person for bots, second person for "You".
  const v = (p: number | null, third: string, second: string) => (p !== null && p === human ? second : third);
  const id = (k: string) => `${st.seq}-${k}`;
  if (st.card !== null) {
    out.push({ id: id("a"), seat: st.player, tone: "play", segs: [{ who: st.player }, ` ${VERB[st.kind] ? v(st.player, ...VERB[st.kind]) : "plays"} `, { card: st.card }] });
  } else {
    const p = st.player;
    const txt =
      st.kind === "take"
        ? v(p, " takes", " take")
        : st.kind === "bita"
          ? v(p, " says bita", " say bita")
          : st.kind === "done"
            ? v(p, " is done throwing in", " are done throwing in")
            : v(p, " passes", " pass");
    out.push({ id: id("a"), seat: st.player, tone: st.kind === "take" ? "take" : "pass", segs: [{ who: st.player }, txt] });
  }
  const draws: Seg[] = [];
  st.events.forEach((e, i) => {
    switch (e.type) {
      case "bita":
        out.push({ id: id(`e${i}`), seat: null, tone: "bita", segs: [`Bita — ${e.cards.length} cards discarded`] });
        break;
      case "pickup":
        out.push({ id: id(`e${i}`), seat: e.player, tone: "take", segs: [{ who: e.player }, `${v(e.player, " picks", " pick")} up ${e.cards.length} card${e.cards.length === 1 ? "" : "s"}`] });
        break;
      case "draw":
        if (draws.length) draws.push(", ");
        draws.push({ who: e.player }, ` +${e.count}`);
        if (e.cards && e.cards.length) {
          draws.push(" (");
          e.cards.forEach((c, j) => {
            if (j) draws.push(" ");
            draws.push({ card: c });
          });
          draws.push(")");
        }
        break;
      case "talon_empty":
        out.push({ id: id(`e${i}`), seat: null, tone: "info", segs: ["The talon is empty"] });
        break;
      case "out":
        out.push({ id: id(`e${i}`), seat: e.player, tone: "out", segs: [{ who: e.player }, `${v(e.player, " is", " are")} out — place #${e.place}`] });
        break;
      case "game_over":
        out.push({
          id: id(`e${i}`),
          seat: e.loser,
          tone: "end",
          segs: e.loser === null ? ["Game over — a draw, nobody is the durak"] : ["Game over — ", { who: e.loser }, v(e.loser, " is", " are") + " the durak!"],
        });
        break;
      case "new_bout":
        out.push({
          id: id(`e${i}`),
          seat: null,
          tone: "bout",
          segs: [{ who: e.attacker }, v(e.attacker, " attacks ", " attack "), { who: e.defender }],
        });
        break;
    }
  });
  if (draws.length) {
    const idx = out.findIndex((x) => x.tone === "out" || x.tone === "end" || x.tone === "bout" || x.tone === "info");
    const entry: LogEntry = { id: id("draw"), seat: null, tone: "info", segs: ["Draw: ", ...draws] };
    if (idx >= 0) out.splice(idx, 0, entry);
    else out.push(entry);
  }
  return out;
}
