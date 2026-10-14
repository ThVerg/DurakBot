import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { api, type BotsResponse, type GameState, type Step } from "./api";
import { PASS, cardLabel, isRed, sortHand } from "./cards";
import { DiscardPile, Opponent, TableCenter, Talon, type Bubble, type Fresh, type Sweep } from "./components/Board";
import { GameOverDialog, NewGameDialog, RulesDialog, StatsDialog, type Settings } from "./components/Dialogs";
import { HumanPanel } from "./components/HumanPanel";
import { describeStep, stepText, type LogEntry, type Seg } from "./log";

type Speed = "slow" | "normal" | "fast" | "instant";
const SPEED_MS: Record<Speed, number> = { slow: 1300, normal: 700, fast: 300, instant: 0 };
type DialogKind = "new" | "stats" | "rules" | "over" | null;

interface Prefs {
  speed: Speed;
  showWinProb: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

const DEFAULT_SETTINGS: Settings = {
  numPlayers: 2,
  seat: 0,
  bot: "",
  perSeat: false,
  seatBots: [],
  seed: "",
  spectate: false,
  debug: false,
};

function center(el: Element | null | undefined) {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** Positions (fractions of the board) of opponents around the top of the table. */
function ringPositions(k: number): { x: number; y: number }[] {
  const out = [];
  for (let i = 0; i < k; i++) {
    const theta = Math.PI - ((i + 1) * Math.PI) / (k + 1);
    out.push({ x: 0.5 + 0.41 * Math.cos(theta), y: 0.5 - 0.4 * Math.sin(theta) });
  }
  return out;
}

export default function App() {
  const [bots, setBots] = useState<BotsResponse | null>(null);
  const [settings, setSettings] = useState<Settings>(() => load("durak.settings", DEFAULT_SETTINGS));
  const [prefs, setPrefs] = useState<Prefs>(() => load("durak.prefs", { speed: "normal" as Speed, showWinProb: true }));
  const [gid, setGid] = useState<string | null>(null);
  const [view, setView] = useState<GameState | null>(null);
  const [busy, setBusy] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [bubbles, setBubbles] = useState<Record<number, Bubble>>({});
  const [fresh, setFresh] = useState<Fresh | null>(null);
  const [sweep, setSweep] = useState<Sweep | null>(null);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [winProb, setWinProb] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [autoPlay, setAutoPlay] = useState(true);
  const [narrow, setNarrow] = useState(false);

  const genRef = useRef(0);
  const skipRef = useRef(false);
  const speedRef = useRef(prefs.speed);
  const bubbleKey = useRef(0);
  const seatEls = useRef(new Map<number, HTMLElement>());
  const tableEl = useRef<HTMLDivElement | null>(null);
  const discardEl = useRef<HTMLDivElement | null>(null);
  const boardEl = useRef<HTMLDivElement | null>(null);
  const logEnd = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    speedRef.current = prefs.speed;
    save("durak.prefs", prefs);
  }, [prefs]);
  useEffect(() => save("durak.settings", settings), [settings]);

  useLayoutEffect(() => {
    const el = boardEl.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth < 640));
    ro.observe(el);
    setNarrow(el.clientWidth < 640);
    return () => ro.disconnect();
  }, [view === null]);

  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: "end" });
  }, [log]);

  // ---------------------------------------------------------------- boot
  useEffect(() => {
    api.bots().then(
      (b) => {
        setBots(b);
        setSettings((s) => ({ ...s, bot: b.bots.some((x) => x.name === s.bot) ? s.bot : b.default }));
        const saved = localStorage.getItem("durak.gameId");
        if (saved) {
          api.get(saved).then(
            (r) => {
              if (r.state.done) {
                setDialog("new");
                return;
              }
              setGid(r.game_id);
              setView(r.state);
              setLog(r.history.flatMap((st) => describeStep(st, r.state.human_seat)));
            },
            () => setDialog("new"),
          );
        } else {
          setDialog("new");
        }
      },
      (e) => setError(`Cannot reach the server: ${e}`),
    );
  }, []);

  const names = useMemo(() => (view ? view.players.map((p) => p.name) : []), [view?.game_id]);

  // ------------------------------------------------------------ animation
  const showBubble = useCallback((seat: number, text: string, tone: Bubble["tone"]) => {
    bubbleKey.current += 1;
    const b = { seat, text, tone, key: bubbleKey.current };
    setBubbles((prev) => ({ ...prev, [seat]: b }));
  }, []);

  const vectorFromSeat = (seat: number) => {
    const from = center(seatEls.current.get(seat)?.querySelector(".opp-hand, .hand") ?? seatEls.current.get(seat));
    const to = center(tableEl.current?.querySelector(".pairs"));
    return from && to ? { dx: from.x - to.x, dy: from.y - to.y } : { dx: 0, dy: -120 };
  };
  const vectorToEl = (el: Element | null | undefined) => {
    const to = center(el);
    const from = center(tableEl.current?.querySelector(".pairs"));
    return from && to ? { dx: to.x - from.x, dy: to.y - from.y } : { dx: 200, dy: 0 };
  };

  const runSteps = useCallback(
    async (steps: Step[], final: GameState, opts: { humanFirst?: boolean } = {}) => {
      const gen = ++genRef.current;
      skipRef.current = false;
      setBusy(true);
      const entries: LogEntry[] = [];
      for (let i = 0; i < steps.length; i++) {
        if (genRef.current !== gen) return;
        const st = steps[i];
        const lines = describeStep(st, final.human_seat);
        const delay = skipRef.current ? 0 : SPEED_MS[speedRef.current];
        if (delay === 0) {
          entries.push(...lines);
          continue;
        }
        if (entries.length) {
          const flush = entries.splice(0);
          setLog((l) => [...l, ...flush]);
        }
        const isHuman = opts.humanFirst && i === 0;
        const endsBout = st.events.find((e) => e.type === "bita" || e.type === "pickup");
        const text = st.card !== null ? cardLabel(st.card) : stepText(st.kind);
        showBubble(st.player, text, st.card !== null ? "play" : st.kind === "take" ? "take" : st.kind === "bita" ? "bita" : "pass");
        setLog((l) => [...l, ...lines]);
        if (endsBout) {
          // Let the final table be seen, then sweep it to the discard / the taker.
          if (!isHuman) await sleep(delay * 0.6);
          if (genRef.current !== gen) return;
          const target = endsBout.type === "bita" ? discardEl.current : seatEls.current.get(endsBout.player);
          setSweep(vectorToEl(target));
          await sleep(Math.min(420, Math.max(160, delay * 0.55)));
          if (genRef.current !== gen) return;
          setSweep(null);
          setFresh(null);
          setView(st.view ?? final);
          for (const e of st.events) if (e.type === "out") showBubble(e.player, `Out! #${e.place}`, "out");
          await sleep(skipRef.current ? 0 : delay * 0.5);
        } else {
          setFresh(st.card !== null ? { card: st.card, ...vectorFromSeat(st.player) } : null);
          setView(st.view ?? final);
          await sleep(isHuman ? Math.min(delay, 200) : delay);
        }
      }
      if (genRef.current !== gen) return;
      if (entries.length) setLog((l) => [...l, ...entries]);
      setSweep(null);
      setView(final);
      setBusy(false);
      if (final.done) setTimeout(() => genRef.current === gen && setDialog("over"), skipRef.current ? 100 : 700);
    },
    [showBubble],
  );

  // ---------------------------------------------------------------- actions
  const startGame = useCallback(
    async (s: Settings) => {
      setSettings(s);
      setDialog(null);
      genRef.current++;
      setBusy(true);
      setThinking(true);
      setError(null);
      setWinProb({});
      setBubbles({});
      setFresh(null);
      setSweep(null);
      setSelected(null);
      const n = s.numPlayers;
      const seat = s.seat === "random" ? Math.floor(Math.random() * n) : Math.min(s.seat, n - 1);
      try {
        const res = await api.create({
          num_players: n,
          human_seat: s.spectate ? null : seat,
          spectate: s.spectate,
          bot: s.bot || undefined,
          bots: s.perSeat ? s.seatBots.slice(0, n).map((b, i) => (!s.spectate && i === seat ? null : b)) : undefined,
          seed: s.seed ? Number(s.seed) : null,
          debug_reveal: !s.spectate && s.debug,
        });
        localStorage.setItem("durak.gameId", res.game_id);
        setGid(res.game_id);
        const p0 = res.state.players[res.state.attacker];
        setLog([
          {
            id: "start",
            seat: null,
            tone: "bout",
            segs: [
              `New game · ${n} players · trump `,
              { card: res.state.trump_card },
              ` · `,
              { who: p0.seat },
              p0.is_human ? " attack first" : " attacks first",
            ],
          },
        ]);
        setThinking(false);
        if (res.steps.length) {
          setView({ ...res.steps[0].view!, table: [], your_turn: false, legal: [] });
          await sleep(300);
        }
        await runSteps(res.steps, res.state);
      } catch (e) {
        setError(String(e));
        setBusy(false);
        setThinking(false);
      }
    },
    [runSteps],
  );

  const play = useCallback(
    async (action: number) => {
      if (!gid || !view || busy || !view.your_turn || !view.legal.includes(action)) return;
      setSelected(null);
      setBusy(true);
      // Optimistic display of the human's own card while the bots think.
      if (action !== PASS) {
        const me = view.human_seat!;
        const table =
          view.phase === "defend"
            ? view.table.map((p, i) => (i === view.table.length - 1 ? { ...p, defense: action } : p))
            : [...view.table, { attack: action, defense: null }];
        setFresh({ card: action, ...vectorFromSeat(me) });
        setView({
          ...view,
          table,
          hand: view.hand.filter((c) => c !== action),
          players: view.players.map((p) =>
            p.seat === me ? { ...p, hand: (p.hand ?? []).filter((c) => c !== action), hand_size: p.hand_size - 1 } : p,
          ),
          your_turn: false,
          legal: [],
        });
      } else {
        setView({ ...view, your_turn: false, legal: [] });
      }
      setThinking(true);
      try {
        const res = await api.act(gid, action);
        setThinking(false);
        await runSteps(res.steps, res.state, { humanFirst: true });
      } catch (e) {
        setThinking(false);
        setError(String(e));
        try {
          const r = await api.get(gid);
          setView(r.state);
        } catch {
          /* ignore */
        }
        setBusy(false);
      }
    },
    [gid, view, busy, runSteps],
  );

  const advance = useCallback(
    async (until: "step" | "bout" | "end") => {
      if (!gid || !view || busy || view.done) return;
      setBusy(true);
      setThinking(true);
      try {
        const res = await api.advance(gid, until);
        setThinking(false);
        await runSteps(res.steps, res.state);
      } catch (e) {
        setThinking(false);
        setError(String(e));
        setBusy(false);
      }
    },
    [gid, view, busy, runSteps],
  );

  const toggleDebug = useCallback(async () => {
    if (!gid || !view || busy || view.mode !== "play") return;
    try {
      const r = await api.debug(gid, !view.debug_reveal);
      setView(r.state);
    } catch (e) {
      setError(String(e));
    }
  }, [gid, view, busy]);

  // Auto-play for spectate mode, and when the human is out (server already
  // plays the game out, but spectate needs explicit advancing).
  useEffect(() => {
    if (!view || view.mode !== "spectate" || !autoPlay || busy || view.done || dialog) return;
    const t = setTimeout(() => advance("bout"), Math.max(150, SPEED_MS[prefs.speed] * 0.6));
    return () => clearTimeout(t);
  }, [view, autoPlay, busy, dialog, advance, prefs.speed]);

  // Champion win-probability estimate.
  useEffect(() => {
    if (!gid || !view || !prefs.showWinProb || !bots?.evaluate_available || busy || view.done) return;
    let alive = true;
    const t = setTimeout(() => {
      api.evaluate(gid).then(
        (r) => alive && r.available && setWinProb(r.values),
        () => undefined,
      );
    }, 120);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [gid, view?.moves, view?.done, busy, prefs.showWinProb, bots?.evaluate_available]);

  // ------------------------------------------------------------- keyboard
  const bottomSeat = view ? (view.human_seat ?? 0) : 0;
  const legalSorted = useMemo(() => {
    if (!view || !view.your_turn) return [];
    const legal = new Set(view.legal);
    return sortHand(view.hand, view.trump_suit).filter((c) => legal.has(c));
  }, [view]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      const k = e.key;
      if (k === "Escape") {
        if (dialog) setDialog(null);
        else if (busy) skipRef.current = true;
        return;
      }
      if (dialog) return;
      if (busy && (k === " " || k === "Enter")) {
        e.preventDefault();
        skipRef.current = true;
        return;
      }
      if (k === "n" || k === "N") return setDialog("new");
      if (k === "s" || k === "S") return setDialog("stats");
      if (k === "?" || k === "h" || k === "H") return setDialog("rules");
      if (k === "l" || k === "L") return setLogOpen((o) => !o);
      if (k === "d" || k === "D") return void toggleDebug();
      if (!view) return;
      if (view.mode === "spectate") {
        if (k === " ") {
          e.preventDefault();
          setAutoPlay((a) => !a);
        } else if (k === "ArrowRight") advance("step");
        return;
      }
      if (!view.your_turn || busy) return;
      if (/^[1-9]$/.test(k)) {
        const c = legalSorted[Number(k) - 1];
        if (c !== undefined) play(c);
      } else if (k === " ") {
        e.preventDefault();
        if (view.legal.includes(PASS)) play(PASS);
      } else if (k === "ArrowRight" || k === "ArrowLeft") {
        e.preventDefault();
        if (!legalSorted.length) return;
        const i = selected === null ? -1 : legalSorted.indexOf(selected);
        const next = k === "ArrowRight" ? (i + 1) % legalSorted.length : (i - 1 + legalSorted.length) % legalSorted.length;
        setSelected(legalSorted[next]);
      } else if (k === "Enter" && selected !== null && legalSorted.includes(selected)) {
        e.preventDefault();
        play(selected);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialog, busy, view, legalSorted, selected, play, advance, toggleDebug]);

  // ------------------------------------------------------------- rendering
  const renderSegs = (segs: Seg[]) =>
    segs.map((s, i) => {
      if (typeof s === "string") return <span key={i}>{s}</span>;
      if ("card" in s)
        return (
          <span key={i} className={`log-card ${isRed(s.card) ? "red" : "black"}`}>
            {cardLabel(s.card)}
          </span>
        );
      let name = names[s.who] ?? `P${s.who + 1}`;
      if (view && s.who === view.human_seat && i > 0) name = name.toLowerCase();
      return (
        <b key={i} className={view && s.who === view.human_seat ? "log-you" : ""}>
          {name}
        </b>
      );
    });

  const status = useMemo((): ReactNode => {
    if (!view) return null;
    const P = (seat: number) => <b>{view.players[seat]?.name}</b>;
    if (view.done) {
      if (view.loser === null) return "Game over — a draw.";
      return view.loser === view.human_seat ? <>Game over — <b>you</b> are the durak.</> : <>Game over — {P(view.loser)} is the durak.</>;
    }
    const me = view.human_seat;
    const toMove = view.to_move!;
    if (view.mode === "spectate") return <>{P(toMove)} to move · {P(view.attacker)} attacks {P(view.defender)}</>;
    const meP = view.players[me!];
    if (meP.out) return <>You are out (#{meP.place}) — watching the rest…</>;
    if (busy && !view.your_turn) {
      return thinking ? <>{P(toMove)} is thinking…</> : <>{P(toMove)} to move</>;
    }
    if (!view.your_turn) return <>Waiting for {P(toMove)}</>;
    const uncovered = view.table.find((p) => p.defense === null);
    switch (view.phase) {
      case "attack":
        if (!view.table.length) return <>Your attack on {P(view.defender)} — lead any card</>;
        return view.pass_label === "bita" ? (
          <>All covered — throw in a matching rank, or call <b>Bita</b></>
        ) : (
          <>All covered — throw in a matching rank, or <b>Pass</b> to the other thrower</>
        );
      case "defend":
        return (
          <>
            Defend: beat{" "}
            {uncovered && <span className={`log-card ${isRed(uncovered.attack) ? "red" : "black"}`}>{cardLabel(uncovered.attack)}</span>} or{" "}
            <b>Take</b>
          </>
        );
      case "throw_in":
        return <>{P(view.defender)} takes — throw in more matching cards, then <b>Done</b></>;
    }
  }, [view, busy, thinking]);

  if (!view) {
    return (
      <div className="app">
        <TopBar
          prefs={prefs}
          setPrefs={setPrefs}
          onNew={() => setDialog("new")}
          onStats={() => setDialog("stats")}
          onRules={() => setDialog("rules")}
          evalAvailable={!!bots?.evaluate_available}
        />
        <div className="splash">
          <div className="splash-cards">
            <span className="sc red">A♥︎</span>
            <span className="sc">K♠︎</span>
            <span className="sc red">Q♦︎</span>
          </div>
          <h1>DurakBot</h1>
          <p>Podkidnoy Durak for 2–6 players against the bots.</p>
          {error && <div className="error">{error}</div>}
          <button type="button" className="btn primary" onClick={() => setDialog("new")}>
            New game
          </button>
        </div>
        {dialog === "new" && <NewGameDialog bots={bots} initial={settings} onStart={startGame} onClose={() => setDialog(null)} />}
        {dialog === "stats" && <StatsDialog onClose={() => setDialog(null)} />}
        {dialog === "rules" && <RulesDialog onClose={() => setDialog(null)} />}
      </div>
    );
  }

  const n = view.num_players;
  const opponents = Array.from({ length: n - 1 }, (_, i) => view.players[(bottomSeat + 1 + i) % n]);
  const ring = ringPositions(opponents.length);
  const bottom = view.players[bottomSeat];
  const reveal = view.mode === "spectate" || view.debug_reveal;
  const myWp = view.human_seat !== null && prefs.showWinProb ? winProb[String(view.human_seat)] : undefined;

  const spectateControls =
    view.mode === "spectate" ? (
      <>
        <button type="button" className="btn" onClick={() => setAutoPlay((a) => !a)} disabled={view.done}>
          {autoPlay ? "❚❚ Pause" : "▶ Play"}
        </button>
        <button type="button" className="btn ghost" onClick={() => advance("step")} disabled={busy || view.done || autoPlay}>
          Step
        </button>
        <button type="button" className="btn ghost" onClick={() => advance("bout")} disabled={busy || view.done || autoPlay}>
          Bout
        </button>
        <button type="button" className="btn ghost" onClick={() => advance("end")} disabled={busy || view.done}>
          To end
        </button>
      </>
    ) : null;

  return (
    <div className={`app ${narrow ? "narrow" : ""}`}>
      <TopBar
        prefs={prefs}
        setPrefs={setPrefs}
        onNew={() => setDialog("new")}
        onStats={() => setDialog("stats")}
        onRules={() => setDialog("rules")}
        onLog={() => setLogOpen((o) => !o)}
        evalAvailable={!!bots?.evaluate_available}
        debug={view.mode === "play" ? { on: view.debug_reveal, toggle: toggleDebug } : undefined}
        info={
          <>
            {n} players · {view.mode === "spectate" ? "spectating" : `you are seat ${bottomSeat + 1}`}
          </>
        }
      />
      <main className={`main ${logOpen ? "log-open" : ""}`}>
        <section className="play-area">
          <div className={`board ${narrow ? "layout-row" : "layout-ring"} opp-${opponents.length}`} ref={boardEl}>
            <div className="felt" />
            <div className="opponents">
              {opponents.map((p, i) => (
                <Opponent
                  key={p.seat}
                  player={p}
                  state={view}
                  style={narrow ? undefined : ({ left: `${ring[i].x * 100}%`, top: `${ring[i].y * 100}%` } as CSSProperties)}
                  bubble={bubbles[p.seat]}
                  thinking={thinking || busy}
                  reveal={reveal}
                  winProb={view.mode === "spectate" && prefs.showWinProb ? winProb[String(p.seat)] : undefined}
                  refCb={(el) => {
                    if (el) seatEls.current.set(p.seat, el);
                    else seatEls.current.delete(p.seat);
                  }}
                />
              ))}
            </div>
            <div className="table-zone">
              <Talon state={view} />
              <TableCenter state={view} fresh={fresh} sweep={sweep} refCb={(el) => (tableEl.current = el)} />
              <DiscardPile count={view.discard_count} refCb={(el) => (discardEl.current = el)} />
            </div>
            {busy && !thinking && SPEED_MS[prefs.speed] > 0 && (
              <button type="button" className="skip-btn" onClick={() => (skipRef.current = true)} title="Skip animation (Space)">
                Skip ▸▸
              </button>
            )}
          </div>
          <HumanPanel
            state={view}
            player={bottom}
            status={status}
            busy={busy}
            selected={selected}
            onPlay={play}
            bubble={bubbles[bottomSeat] ?? null}
            winProb={myWp}
            extraControls={spectateControls}
            refCb={(el) => {
              if (el) seatEls.current.set(bottomSeat, el);
            }}
          />
        </section>
        <aside className="log-panel" aria-label="Move log">
          <div className="log-head">
            <h3>Move log</h3>
            <span className="muted">{view.moves} moves</span>
            <button type="button" className="icon-btn log-close" onClick={() => setLogOpen(false)} aria-label="Close log">
              ✕
            </button>
          </div>
          <div className="log-list">
            {log.map((e) => (
              <div key={e.id} className={`log-entry tone-${e.tone}`}>
                {renderSegs(e.segs)}
              </div>
            ))}
            <div ref={logEnd} />
          </div>
        </aside>
      </main>
      {error && (
        <div className="toast" role="alert" onClick={() => setError(null)}>
          {error}
        </div>
      )}
      {dialog === "new" && <NewGameDialog bots={bots} initial={settings} onStart={startGame} onClose={() => setDialog(null)} />}
      {dialog === "stats" && <StatsDialog onClose={() => setDialog(null)} />}
      {dialog === "rules" && <RulesDialog onClose={() => setDialog(null)} />}
      {dialog === "over" && view.done && (
        <GameOverDialog
          state={view}
          onAgain={() => startGame({ ...settings, seed: "" })}
          onNew={() => setDialog("new")}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

function TopBar({
  prefs,
  setPrefs,
  onNew,
  onStats,
  onRules,
  onLog,
  evalAvailable,
  debug,
  info,
}: {
  prefs: Prefs;
  setPrefs: (f: (p: Prefs) => Prefs) => void;
  onNew: () => void;
  onStats: () => void;
  onRules: () => void;
  onLog?: () => void;
  evalAvailable: boolean;
  debug?: { on: boolean; toggle: () => void };
  info?: ReactNode;
}) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="logo" aria-hidden="true">
          <i />
          <i />
        </span>
        <span className="brand-name">DurakBot</span>
        {info && <span className="brand-info">{info}</span>}
      </div>
      <nav className="tools">
        <label className="speed" title="Animation speed">
          <span>Speed</span>
          <select value={prefs.speed} onChange={(e) => setPrefs((p) => ({ ...p, speed: e.target.value as Speed }))}>
            <option value="slow">Slow</option>
            <option value="normal">Normal</option>
            <option value="fast">Fast</option>
            <option value="instant">Instant</option>
          </select>
        </label>
        {evalAvailable && (
          <button
            type="button"
            className={`chip ${prefs.showWinProb ? "on" : ""}`}
            onClick={() => setPrefs((p) => ({ ...p, showWinProb: !p.showWinProb }))}
            title="Show the champion's estimate of your chance to avoid being durak"
          >
            Win %
          </button>
        )}
        {debug && (
          <button
            type="button"
            className={`chip debug ${debug.on ? "on" : ""}`}
            onClick={debug.toggle}
            title="Debug: reveal bot hands (D). Flagged in stats."
            data-testid="debug-toggle"
          >
            Reveal
          </button>
        )}
        <button type="button" className="btn ghost small" onClick={onRules} title="Rules & shortcuts (?)">
          <span className="wide-only">Rules</span>
          <span className="narrow-only">?</span>
        </button>
        <button type="button" className="btn ghost small" onClick={onStats} title="Statistics (S)">
          Stats
        </button>
        {onLog && (
          <button type="button" className="btn ghost small log-toggle" onClick={onLog} title="Move log (L)">
            Log
          </button>
        )}
        <button type="button" className="btn primary small" onClick={onNew} title="New game (N)" data-testid="new-game">
          <span className="wide-only">New game</span>
          <span className="narrow-only">New</span>
        </button>
      </nav>
    </header>
  );
}
