// Turns server steps/events into structured, translatable move-log entries.
import type { Step } from "./api";

export type Val = string | number | { card: number } | { who: number } | { list: Val[] } | { t: string };

export interface LogEntry {
  id: string;
  seat: number | null;
  tone: "play" | "pass" | "take" | "bita" | "info" | "out" | "end" | "bout";
  key: string;
  params: Record<string, Val>;
}

export function describeStep(st: Step, human: number | null): LogEntry[] {
  const out: LogEntry[] = [];
  const id = (k: string) => `${st.seq}-${k}`;
  const you = (p: number | null) => p !== null && p === human;
  const k = (base: string, p: number | null) => (you(p) ? `${base}.you` : base);
  const p = st.player;
  if (st.card !== null) {
    out.push({ id: id("a"), seat: p, tone: "play", key: k(`log.${st.kind}`, p), params: { who: { who: p }, card: { card: st.card } } });
  } else {
    out.push({
      id: id("a"),
      seat: p,
      tone: st.kind === "take" ? "take" : "pass",
      key: k(`log.${st.kind}`, p),
      params: { who: { who: p } },
    });
  }
  const draws: Val[] = [];
  st.events.forEach((e, i) => {
    switch (e.type) {
      case "bita":
        out.push({ id: id(`e${i}`), seat: null, tone: "bita", key: "log.bitaEvent", params: { n: e.cards.length } });
        break;
      case "pickup":
        out.push({ id: id(`e${i}`), seat: e.player, tone: "take", key: k("log.pickup", e.player), params: { who: { who: e.player }, n: e.cards.length } });
        break;
      case "draw": {
        const item: Val[] = [{ who: e.player }, ` +${e.count}`];
        if (e.cards && e.cards.length) {
          item.push(" (");
          e.cards.forEach((c, j) => {
            if (j) item.push(" ");
            item.push({ card: c });
          });
          item.push(")");
        }
        if (draws.length) draws.push(", ");
        draws.push({ list: item });
        break;
      }
      case "talon_empty":
        out.push({ id: id(`e${i}`), seat: null, tone: "info", key: "log.talonEmpty", params: {} });
        break;
      case "out":
        out.push({ id: id(`e${i}`), seat: e.player, tone: "out", key: k("log.out", e.player), params: { who: { who: e.player }, p: e.place } });
        break;
      case "game_over":
        if (e.loser === null) {
          out.push({ id: id(`e${i}`), seat: null, tone: "end", key: e.reason === "stalemate" ? "log.overStalemate" : "log.overDraw", params: {} });
        } else {
          out.push({ id: id(`e${i}`), seat: e.loser, tone: "end", key: k("log.overDurak", e.loser), params: { who: { who: e.loser } } });
        }
        break;
      case "new_bout":
        out.push({
          id: id(`e${i}`),
          seat: null,
          tone: "bout",
          key: k("log.newBout", e.attacker),
          params: { att: { who: e.attacker }, def: { who: e.defender } },
        });
        break;
    }
  });
  if (draws.length) {
    const idx = out.findIndex((x) => x.tone === "out" || x.tone === "end" || x.tone === "bout" || x.tone === "info");
    const entry: LogEntry = { id: id("draw"), seat: null, tone: "info", key: "log.draw", params: { list: { list: draws } } };
    if (idx >= 0) out.splice(idx, 0, entry);
    else out.push(entry);
  }
  return out;
}
