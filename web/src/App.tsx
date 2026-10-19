// DurakBot web client: the sunlit dacha (title, lobby, table) in 2D DOM/SVG.
// The server is the rules authority; this file streams bot moves one at a
// time and lets the table renderer animate every card between poses.
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { ApiError, api, type BotsResponse, type GameState, type Hint, type Step, type StepsResponse } from "./api";
import { PASS, sortHand } from "./cards";
import { feltId } from "./dacha/art";
import { Icon } from "./dacha/Icons";
import { Lobby } from "./dacha/Lobby";
import { displayName, speechKey, type Bubble } from "./dacha/names";
import { Scene, useStage } from "./dacha/Scene";
import { DEFAULT_SETTINGS, type Settings } from "./dacha/settings";
import { CardChip, DurakReveal, GameOverSheet, RulesSheet, SettingsSheet, StatsSheet, Tutorial } from "./dacha/Sheets";
import { TableView, type PrimaryKind, type TableApi } from "./dacha/table/TableView";
import { TIERS, tierAgent, tierOfAgent } from "./dacha/tiers";
import { LangSwitch, TitleScreen } from "./dacha/Title";
import { confetti, reducedMotion } from "./fx";
import { I18nProvider, Rich, makeT, ordinal, type TFn } from "./i18n";
import { describeStep, type LogEntry, type Val } from "./log";
import { SPEED_SCALE, load, save, usePrefs, type Prefs, type Speed } from "./prefs";
import { setSoundEnabled, sfx, unlockAudio } from "./sound";

const Lab = lazy(() => import("./lab/Lab"));
const Replay = lazy(() => import("./dacha/Replay"));

type DialogKind = "stats" | "rules" | "over" | "settings" | null;
type Screen = "title" | "lobby" | "game";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const tRU = makeT("ru");
const tEN = makeT("en");

function useHashRoute() {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash.startsWith("#/lab") ? "lab" : "game";
}

export default function App() {
  const [prefs, setPrefs] = usePrefs();
  const t = useMemo(() => makeT(prefs.lang), [prefs.lang]);
  return (
    <I18nProvider lang={prefs.lang}>
      <Game prefs={prefs} setPrefs={setPrefs} t={t} />
    </I18nProvider>
  );
}

function Game({ prefs, setPrefs, t }: { prefs: Prefs; setPrefs: (f: (p: Prefs) => Prefs) => void; t: TFn }) {
  const route = useHashRoute();
  const dims = useStage();
  const [bots, setBots] = useState<BotsResponse | null>(null);
  const [settings, setSettings] = useState<Settings>(() => load("durak.settings", DEFAULT_SETTINGS));
  const [gid, setGid] = useState<string | null>(null);
  const [view, setViewState] = useState<GameState | null>(null);
  const [busy, setBusy] = useState(false);
  const [thinkingSeat, setThinkingSeat] = useState<number | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [logSeen, setLogSeen] = useState(0);
  const [bubbles, setBubbles] = useState<Record<number, Bubble>>({});
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [replayOpen, setReplayOpen] = useState(false);
  const [reveal, setReveal] = useState<"lose" | "win" | null>(null);
  const [winProb, setWinProb] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<number | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [autoPlay, setAutoPlay] = useState(true);
  const [hint, setHint] = useState<{ open: boolean; loading: boolean; data: Hint | null }>({ open: false, loading: false, data: null });
  const [tutorial, setTutorial] = useState(false);
  const [lastStep, setLastStep] = useState<Step | null>(null);
  const [screen, setScreen] = useState<Screen>("title");
  const [, force] = useState(0);
  const tableApi = useRef<TableApi | null>(null);

  const genRef = useRef(0);
  const skipRef = useRef(false);
  const ffRef = useRef(false); // fast-forward to the end (spectate "To end")
  const speedRef = useRef<Speed>(prefs.speed);
  const viewRef = useRef<GameState | null>(null);
  const gidRef = useRef<string | null>(null);
  const autoRef = useRef(true);
  const celebratedRef = useRef(false);
  const bubbleKey = useRef(0);
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    speedRef.current = prefs.speed;
    setSoundEnabled(prefs.sound);
  }, [prefs.speed, prefs.sound]);
  useEffect(() => save("durak.settings", settings), [settings]);
  useEffect(() => {
    autoRef.current = autoPlay;
  }, [autoPlay]);
  useEffect(() => {
    if (logOpen) setLogSeen(log.length);
  }, [logOpen, log.length]);
  useEffect(() => {
    if (logOpen) document.querySelector(".log__list li:last-child")?.scrollIntoView({ block: "end" });
  }, [log, logOpen]);

  const setView = useCallback((v: GameState | null) => {
    viewRef.current = v;
    setViewState(v);
  }, []);
  const scale = () => (skipRef.current || ffRef.current || reducedMotion() ? 0 : SPEED_SCALE[speedRef.current]);
  const skip = () => {
    skipRef.current = true;
    force((x) => x + 1);
  };

  const botLabelOf = useCallback((name: string) => {
    const b = bots?.bots.find((x) => x.name === name);
    return b ? b.labels?.[prefs.lang] ?? b.label : name;
  }, [bots, prefs.lang]);
  /** What a seat shows: the difficulty tier when the engine is one, else its label. */
  const levelOf = useCallback(
    (name: string) => {
      const tier = tierOfAgent(name);
      return tier ? t(`tier.${tier.id}`) : botLabelOf(name);
    },
    [botLabelOf, t],
  );

  // ---------------------------------------------------------------- boot
  useEffect(() => {
    api.bots().then(
      (b) => {
        setBots(b);
        setSettings((s) => ({
          ...s,
          bot: b.bots.some((x) => x.name === s.bot) ? s.bot : tierAgent(TIERS[3], b) ?? b.default,
        }));
        let saved: string | null = null;
        try {
          saved = localStorage.getItem("durak.gameId");
        } catch {
          /* ignore */
        }
        if (!saved) return;
        api.get(saved).then(
          (r) => {
            if (r.state.done) return;
            gidRef.current = r.game_id;
            setGid(r.game_id);
            setView(r.state);
            setLog(r.history.flatMap((st) => describeStep(st, r.state.human_seat)));
          },
          () => undefined,
        );
      },
      (e) => setError(tRef.current("err.server", { e: String(e) })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ------------------------------------------------------------ animation
  /** A speech bubble: the Russian phrase plus an English gloss. */
  const say = useCallback((seat: number, key: string, tone: Bubble["tone"], params?: Record<string, string | number>) => {
    bubbleKey.current += 1;
    const k = bubbleKey.current;
    const b: Bubble = { seat, ru: tRU(key, params), en: tEN(key, params), tone, key: k };
    setBubbles((prev) => ({ ...prev, [seat]: b }));
    // gone after the fade-out, so a persistent prompt ("Твой ход!") can show again
    setTimeout(() => {
      setBubbles((prev) => {
        if (prev[seat]?.key !== k) return prev;
        const next = { ...prev };
        delete next[seat];
        return next;
      });
    }, 3000);
  }, []);

  const animateStep = async (st: Step) => {
    const v = st.view;
    const human = viewRef.current?.human_seat ?? null;
    const isHuman = st.player === human;
    const endEv = st.events.find((e) => e.type === "bita" || e.type === "pickup");
    if (!isHuman) {
      if (st.kind === "take") {
        const k = speechKey("take", st.seq + st.player, 0.5);
        say(st.player, k ?? "bubble.take", k ? "say" : "take");
      } else if (st.kind === "bita") say(st.player, "bubble.bita", "bita");
      else if (st.kind === "pass") say(st.player, "bubble.pass", "pass");
      else if (st.kind === "done") say(st.player, "bubble.done", "pass");
    }
    setLog((l) => [...l, ...describeStep(st, human)]);
    if (!v) return;
    const sc = scale();
    // let the final position of a bout sink in before the sweep
    if (endEv && sc > 0) await sleep(isHuman ? 160 : 460 * sc);
    flushSync(() => {
      setLastStep(st);
      setView(v);
      if (isHuman) setPending(null);
    });
    if (endEv) endEv.type === "bita" ? sfx.swoosh() : sfx.take();
    if (sc > 0) {
      await nextFrame();
      await nextFrame();
      await sleep(Math.min(2600, tableApi.current?.settleMs() ?? 400 * sc));
    }
    afterEvents(st, human);
    if (sc > 0) await sleep((isHuman ? 40 : 160) * sc);
  };

  /** Out / game-over side effects (sounds, bubbles, confetti). */
  const afterEvents = (st: Step, human: number | null) => {
    for (const e of st.events) {
      if (e.type === "out") {
        if (e.player === human) {
          sfx.win();
          if (!celebratedRef.current) {
            celebratedRef.current = true;
            confetti();
          }
        } else {
          sfx.out();
          const k = speechKey("out", st.seq + e.player, 0.6);
          say(e.player, k ?? "bubble.out", k ? "say" : "out", { p: e.place });
        }
      }
      if (e.type === "game_over" && e.loser !== null && e.loser !== human) {
        const k = speechKey("durak", st.seq, 1);
        if (k) say(e.loser, k, "say");
      }
      if (e.type === "game_over" && e.loser !== null && e.loser === human) {
        const v = viewRef.current;
        const other = v?.players.find((p) => !p.is_human && !p.is_durak);
        const k = speechKey("winVsYou", st.seq, 1);
        if (other && k) say(other.seat, k, "say");
      }
    }
  };

  const onGameOver = (v: GameState) => {
    if (v.mode === "play" && v.result?.human === "durak") {
      sfx.lose();
      setReveal("lose");
    } else if (v.mode === "play" && v.result?.human === "safe") {
      if (!celebratedRef.current) {
        celebratedRef.current = true;
        confetti();
        sfx.win();
      }
      setReveal("win");
    } else {
      setTimeout(() => setDialog("over"), 900);
    }
  };

  /** Pull bot moves one at a time and animate each as it arrives. */
  const pump = async (gen: number) => {
    const id = gidRef.current;
    // the next bot move is requested while the current one animates (play mode)
    let next: Promise<StepsResponse> | null = null;
    while (genRef.current === gen && id) {
      const v = viewRef.current;
      if (!v || v.done || v.your_turn) break;
      if (v.mode === "spectate" && !autoRef.current) break;
      setThinkingSeat(v.to_move);
      const t0 = performance.now();
      let res: StepsResponse;
      try {
        res = await (next ?? api.advance(id, "step"));
        next = null;
      } catch (e) {
        next = null;
        if (genRef.current !== gen) return;
        if (e instanceof ApiError && e.status === 409) {
          try {
            const r = await api.get(id);
            setView(r.state);
            continue;
          } catch {
            /* fall through */
          }
        }
        setError(String(e));
        break;
      }
      if (genRef.current !== gen) return;
      const minThink = (v.mode === "spectate" ? 220 : 420) * scale();
      await sleep(minThink - (performance.now() - t0));
      if (genRef.current !== gen) return;
      setThinkingSeat(null);
      const nx = res.state;
      if (nx.mode === "play" && !nx.done && !nx.your_turn) {
        next = api.advance(id, "step");
        next.catch(() => undefined);
      }
      for (const st of res.steps) {
        if (genRef.current !== gen) return;
        await animateStep(st);
      }
      if (genRef.current !== gen) return;
      setView(res.state);
    }
    if (genRef.current !== gen) return;
    setThinkingSeat(null);
    setBusy(false);
    skipRef.current = false;
    const v = viewRef.current;
    if (v?.done) onGameOver(v);
  };

  // ---------------------------------------------------------------- actions
  const startGame = useCallback(
    async (s: Settings) => {
      unlockAudio();
      setSettings(s);
      setDialog(null);
      setScreen("game");
      setReplayOpen(false);
      setReveal(null);
      setLogOpen(false);
      const gen = ++genRef.current;
      setBusy(true);
      setError(null);
      setWinProb({});
      setBubbles({});
      setSelected(null);
      setPending(null);
      setHint({ open: false, loading: false, data: null });
      setThinkingSeat(null);
      celebratedRef.current = false;
      skipRef.current = false;
      ffRef.current = false;
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
          auto: false,
        });
        if (genRef.current !== gen) return;
        try {
          localStorage.setItem("durak.gameId", res.game_id);
        } catch {
          /* ignore */
        }
        gidRef.current = res.game_id;
        setGid(res.game_id);
        const st = res.state;
        const p0 = st.players[st.attacker];
        const first: LogEntry = {
          id: "start",
          seat: null,
          tone: "bout",
          key: "log.newGame",
          params: { n, card: { card: st.trump_card }, who: { who: p0.seat }, verb: { t: p0.is_human ? "log.attackFirstYou" : "log.attacksFirst" } },
        };
        setLog([first]);
        setLogSeen(1);
        setLastStep(null);
        const sc = scale();
        if (sc > 0) sfx.shuffle();
        setView(st);
        if (sc > 0) {
          await nextFrame();
          await nextFrame();
          await sleep(Math.min(5000, tableApi.current?.settleMs() ?? 1500));
        }
        if (genRef.current !== gen) return;
        await pump(gen);
      } catch (e) {
        setError(String(e));
        setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const continueGame = () => {
    setScreen("game");
    const v = viewRef.current;
    if (v && !v.done && !v.your_turn) {
      const gen = ++genRef.current;
      setBusy(true);
      void pump(gen);
    }
  };

  const play = useCallback(
    async (action: number) => {
      const v = viewRef.current;
      const id = gidRef.current;
      if (!id || !v || busy || !v.your_turn || !v.legal.includes(action)) return;
      unlockAudio();
      setSelected(null);
      setHint({ open: false, loading: false, data: null });
      setBusy(true);
      // instant feedback: the card leaves the hand before the server answers
      if (action !== PASS) setPending(action);
      const gen = ++genRef.current;
      try {
        const res = await api.act(id, action);
        if (genRef.current !== gen) return;
        for (const st of res.steps) await animateStep(st);
        setView(res.state);
        setPending(null);
        await pump(gen);
      } catch (e) {
        setPending(null);
        setError(String(e));
        try {
          const r = await api.get(id);
          setView(r.state);
        } catch {
          /* ignore */
        }
        setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busy],
  );

  const spectateRun = useCallback(
    async (until: "step" | "end") => {
      const id = gidRef.current;
      const v = viewRef.current;
      if (!id || !v || v.done) return;
      if (busy) {
        if (until === "end") {
          ffRef.current = true;
          setAutoPlay(true);
          autoRef.current = true;
        }
        return;
      }
      setBusy(true);
      const gen = ++genRef.current;
      try {
        if (until === "step") {
          const res = await api.advance(id, "step");
          for (const st of res.steps) await animateStep(st);
          setView(res.state);
          setBusy(false);
          if (res.state.done) onGameOver(res.state);
        } else {
          ffRef.current = true;
          setAutoPlay(true);
          autoRef.current = true;
          await pump(gen);
        }
      } catch (e) {
        setError(String(e));
        setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busy],
  );

  // resume auto-play in spectate mode
  useEffect(() => {
    if (!view || view.mode !== "spectate" || !autoPlay || busy || view.done || dialog || screen !== "game") return;
    const gen = ++genRef.current;
    setBusy(true);
    void pump(gen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPlay, busy, view?.done, view?.mode, dialog, screen]);

  const toggleDebug = useCallback(async () => {
    const v = viewRef.current;
    const id = gidRef.current;
    if (!id || !v || busy || v.mode !== "play" || v.done) return;
    try {
      const r = await api.debug(id, !v.debug_reveal);
      setView(r.state);
    } catch (e) {
      setError(String(e));
    }
  }, [busy, setView]);

  const askHint = useCallback(async () => {
    const id = gidRef.current;
    const v = viewRef.current;
    if (!id || !v || !v.your_turn || busy) return;
    if (hint.open) return setHint({ open: false, loading: false, data: null });
    setHint({ open: true, loading: true, data: null });
    try {
      const h = await api.hint(id);
      sfx.hint();
      setHint({ open: true, loading: false, data: h });
    } catch (e) {
      setHint({ open: false, loading: false, data: null });
      setError(String(e));
    }
  }, [busy, hint.open]);

  // champion win-probability estimate
  useEffect(() => {
    if (!gid || !view || !prefs.showWinProb || !bots?.evaluate_available || busy || view.done) return;
    let alive = true;
    const tm = setTimeout(() => {
      api.evaluate(gid).then(
        (r) => alive && r.available && setWinProb(r.values),
        () => undefined,
      );
    }, 150);
    return () => {
      alive = false;
      clearTimeout(tm);
    };
  }, [gid, view?.moves, view?.done, busy, prefs.showWinProb, bots?.evaluate_available]);

  // first-game coach marks
  useEffect(() => {
    if (!prefs.tutorialDone && screen === "game" && view?.mode === "play" && view.your_turn && !busy && !dialog && route === "game" && !replayOpen)
      setTutorial(true);
  }, [prefs.tutorialDone, view?.your_turn, busy, dialog, route, view?.mode, screen, replayOpen]);

  // ------------------------------------------------------------- keyboard
  const legalSorted = useMemo(() => {
    if (!view || !view.your_turn) return [];
    const legal = new Set(view.legal);
    return sortHand(view.hand, view.trump_suit, prefs.sort).filter((c) => legal.has(c));
  }, [view, prefs.sort]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key;
      const tag = (e.target as HTMLElement)?.tagName;
      const inField = tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";
      if (inField && k !== "Escape") return;
      if (screen !== "game" || route !== "game") {
        if (k === "Escape") {
          if (dialog) setDialog(null);
          else if (screen === "lobby") setScreen("title");
        }
        return;
      }
      if (replayOpen || tutorial || reveal) {
        if (k === "Escape" && dialog) setDialog(null);
        return;
      }
      if (k === "Escape") {
        if (dialog) setDialog(null);
        else if (logOpen) setLogOpen(false);
        else if (hint.open) setHint({ open: false, loading: false, data: null });
        else if (busy) skip();
        return;
      }
      if (dialog) return;
      if (busy && (k === " " || k === "Enter")) {
        e.preventDefault();
        skip();
        return;
      }
      const lower = k.toLowerCase();
      if (lower === "n") return setScreen("lobby");
      if (lower === "s") return setDialog("stats");
      if (k === "?") return setDialog("rules");
      if (lower === "l") return setLogOpen((o) => !o);
      if (lower === "d") return void toggleDebug();
      if (lower === "m") return setPrefs((p) => ({ ...p, sound: !p.sound }));
      if (!view) return;
      if (view.mode === "spectate") {
        if (k === " ") {
          e.preventDefault();
          setAutoPlay((a) => !a);
        } else if (k === "ArrowRight") void spectateRun("step");
        return;
      }
      if (!view.your_turn || busy) return;
      if (lower === "h") return void askHint();
      if (/^[1-9]$/.test(k)) {
        const c = legalSorted[Number(k) - 1];
        if (c !== undefined) void play(c);
      } else if (k === " ") {
        e.preventDefault();
        if (view.legal.includes(PASS)) void play(PASS);
      } else if (k === "ArrowRight" || k === "ArrowLeft") {
        e.preventDefault();
        if (!legalSorted.length) return;
        const i = selected === null ? -1 : legalSorted.indexOf(selected);
        const nx = k === "ArrowRight" ? (i + 1) % legalSorted.length : (i - 1 + legalSorted.length) % legalSorted.length;
        setSelected(legalSorted[nx]);
      } else if (k === "Enter" && selected !== null && legalSorted.includes(selected)) {
        e.preventDefault();
        void play(selected);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialog, busy, view, legalSorted, selected, play, spectateRun, toggleDebug, askHint, hint.open, route, replayOpen, tutorial, reveal, setPrefs, screen, logOpen]);

  // ------------------------------------------------------------- rendering
  const nameOf = (seat: number, len: "full" | "mid" = "full") => (view ? displayName(view.players[seat], t, len) : `P${seat + 1}`);

  const renderVal = (v: Val, key: string, i: number): ReactNode => {
    if (typeof v === "string" || typeof v === "number") return <span key={i}>{v}</span>;
    if ("card" in v) return <CardChip key={i} c={v.card} />;
    if ("who" in v) {
      const isYou = view && v.who === view.human_seat;
      const subject = key === "who" || key === "att";
      return <b key={i}>{isYou ? (subject ? t("log.you") : t("log.youObj")) : nameOf(v.who)}</b>;
    }
    if ("t" in v) return <span key={i}>{t(v.t)}</span>;
    return <span key={i}>{v.list.map((x, j) => renderVal(x, key === "list" ? "list" : key, j))}</span>;
  };
  const renderEntry = (e: LogEntry) => {
    const nodes: Record<string, ReactNode> = {};
    for (const [k, v] of Object.entries(e.params)) nodes[k] = renderVal(v, k, 0);
    return <Rich text={t(e.key)} nodes={nodes} />;
  };
  const logNode = useMemo(() => {
    const items: ReactNode[] = [];
    let round = 0;
    log.forEach((e, i) => {
      if (e.tone === "bout") {
        round += 1;
        items.push(
          <li key={`r${e.id}`} className="log__round">
            {t("d.logRound", { n: round })}
          </li>,
        );
      }
      items.push(
        <li key={e.id} className={`tone-${e.tone} ${i === log.length - 1 ? "is-now" : ""}`}>
          {renderEntry(e)}
        </li>,
      );
    });
    return (
      <ol className="log__list" aria-live="off">
        {items}
      </ol>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [log, t, view?.game_id]);

  // status ribbon + sub line + the primary button
  const table = useMemo(() => {
    if (!view) return null;
    const P = (seat: number) => <b>{nameOf(seat, dims.layout === "m" ? "mid" : "full")}</b>;
    const human = view.human_seat;
    const legalCards = view.legal.filter((a) => a !== PASS);
    let main: ReactNode = null;
    let sub: ReactNode = null;
    let tone: "you" | "wait" | "good" | "over" = "wait";
    let primary: PrimaryKind = "wait";
    if (view.done) {
      tone = "over";
      primary = "again";
      main = t("d.r.over");
      if (view.loser === null) sub = view.result?.reason === "stalemate" ? t("d.s.overStalemate") : t("d.s.overDraw");
      else if (view.loser === human) sub = t("d.s.overYou");
      else sub = <Rich text={t("d.s.overDurak")} nodes={{ name: P(view.loser) }} />;
    } else if (busy && view.moves === 0) {
      main = t("d.r.dealing");
    } else if (view.mode === "spectate") {
      const tm = view.to_move ?? 0;
      main = thinkingSeat !== null ? <Rich text={t("d.r.wait")} nodes={{ name: P(thinkingSeat) }} /> : <Rich text={t("d.r.toMove")} nodes={{ name: P(tm) }} />;
      sub = <Rich text={t("d.s.wait")} nodes={{ att: P(view.attacker), def: P(view.defender) }} />;
    } else {
      const me = view.players[human!];
      if (me.out) {
        tone = "good";
        main = t("d.r.out", { ord: ordinal(me.place ?? 0, prefs.lang), p: me.place ?? "" });
        sub = t("d.s.out");
      } else if (!view.your_turn || busy) {
        const tm = view.to_move ?? view.attacker;
        main = thinkingSeat !== null ? <Rich text={t("d.r.wait")} nodes={{ name: P(thinkingSeat) }} /> : <Rich text={t("d.r.toMove")} nodes={{ name: P(tm) }} />;
        sub =
          view.attacker === human ? (
            <Rich text={t("d.s.youAttack")} nodes={{ def: P(view.defender) }} />
          ) : view.defender === human ? (
            <Rich text={t("d.s.waitYou")} nodes={{ att: P(view.attacker) }} />
          ) : (
            <Rich text={t("d.s.wait")} nodes={{ att: P(view.attacker), def: P(view.defender) }} />
          );
      } else {
        tone = "you";
        if (view.legal.includes(PASS) && view.pass_label) primary = view.pass_label;
        else if (view.phase === "attack" && !view.table.length) primary = "lead";
        if (view.phase === "attack" && !view.table.length) {
          main = t("d.r.lead");
          sub = <Rich text={t("d.s.lead")} nodes={{ def: P(view.defender) }} />;
        } else if (view.phase === "attack") {
          main = view.pass_label === "bita" ? t("d.r.throwBita") : t("d.r.throwPass");
          sub = legalCards.length ? t("d.s.throw") : t("d.s.throwNone");
        } else if (view.phase === "defend") {
          const open = view.table.find((p) => p.defense === null);
          main = <Rich text={t("d.r.defend")} nodes={{ card: open ? <CardChip c={open.attack} /> : null }} />;
          const n = legalCards.length;
          sub =
            n === 0 ? (
              t("d.s.defendNone")
            ) : (
              <Rich text={n === 1 ? t("d.s.defend1") : t("d.s.defend")} nodes={{ att: P(view.attacker), n: <b>{n}</b> }} />
            );
        } else {
          main = <Rich text={t("d.r.throwIn")} nodes={{ def: P(view.defender) }} />;
          sub = t("d.s.throwIn");
        }
      }
    }
    return { main, sub, tone, primary };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, busy, thinkingSeat, t, dims.layout, prefs.lang]);

  const sheets = (
    <>
      {dialog === "stats" && <StatsSheet onClose={() => setDialog(null)} botLabelOf={botLabelOf} />}
      {dialog === "rules" && <RulesSheet onClose={() => setDialog(null)} />}
      {dialog === "settings" && (
        <SettingsSheet
          prefs={prefs}
          setPrefs={setPrefs}
          evalAvailable={!!bots?.evaluate_available}
          debug={screen === "game" && view?.mode === "play" && !view.done ? { on: view.debug_reveal, toggle: toggleDebug } : undefined}
          onClose={() => setDialog(null)}
          onTutorial={() => {
            setDialog(null);
            setPrefs((p) => ({ ...p, tutorialDone: false }));
            if (viewRef.current?.your_turn && screen === "game") setTutorial(true);
          }}
        />
      )}
      {error && (
        <div className="toast" role="alert" onClick={() => setError(null)}>
          {error}
        </div>
      )}
    </>
  );
  const langSwitch = <LangSwitch lang={prefs.lang} setLang={(l) => setPrefs((p) => ({ ...p, lang: l }))} />;
  const felt = feltId(prefs.theme);

  if (route === "lab") {
    return (
      <div className="app app--lab">
        <Scene variant="lobby" dims={dims} />
        <div className="labpage">
          <header className="labpage__top">
            <a className="brand" href="#/" aria-label={t("lab.back")}>
              <span className="brand__back">
                <Icon name="back" />
              </span>
              <span className="brand__word">ДУРАК</span>
              <span className="brand__meta">{t("d.lab")}</span>
            </a>
            {langSwitch}
          </header>
          <Suspense
            fallback={
              <div className="loading">
                <span className="spin" /> {t("loading")}
              </div>
            }
          >
            <Lab onBack={() => (window.location.hash = "")} botLabelOf={botLabelOf} />
          </Suspense>
        </div>
        {sheets}
      </div>
    );
  }

  if (screen !== "game" || !view) {
    const resume = view && !view.done && view.mode === "play" ? view : null;
    return (
      <div className={`app app--${screen}`}>
        <Scene variant={screen === "lobby" ? "lobby" : "title"} dims={dims} />
        {screen === "lobby" ? (
          <Lobby dims={dims} bots={bots} initial={settings} onStart={startGame} onBack={() => setScreen("title")} langSwitch={langSwitch} />
        ) : (
          <TitleScreen
            dims={dims}
            bots={bots}
            settings={settings}
            resume={resume}
            onPlay={() => startGame({ ...settings, spectate: false, seed: "" })}
            onContinue={continueGame}
            onLobby={(tier) => {
              const tr = TIERS.find((x) => x.id === tier);
              const agent = tr ? tierAgent(tr, bots) : null;
              if (agent) setSettings((s) => ({ ...s, bot: agent, seatBots: [] }));
              setScreen("lobby");
            }}
            onWatch={() => startGame({ ...settings, spectate: true, numPlayers: Math.max(3, settings.numPlayers), seed: "" })}
            onStats={() => setDialog("stats")}
            onRules={() => setDialog("rules")}
            setLang={(l) => setPrefs((p) => ({ ...p, lang: l }))}
            onSettings={() => setDialog("settings")}
            sound={prefs.sound}
            toggleSound={() => setPrefs((p) => ({ ...p, sound: !p.sound }))}
          />
        )}
        {sheets}
      </div>
    );
  }

  const human = view.human_seat;
  const canAct = view.your_turn && !busy;
  const speed = skipRef.current || ffRef.current || reducedMotion() ? 0 : SPEED_SCALE[prefs.speed];
  return (
    <div className="app app--game">
      {replayOpen && gid ? (
        <Suspense fallback={<Scene variant="table" dims={dims} felt={felt} />}>
          <Replay
            gameId={gid}
            onClose={() => setReplayOpen(false)}
            sort={prefs.sort}
            back={prefs.back}
            four={prefs.fourColor}
            felt={felt}
            levelOf={levelOf}
          />
        </Suspense>
      ) : (
        <>
          <Scene variant="table" dims={dims} felt={felt} />
          <TableView
            view={view}
            step={lastStep}
            dims={dims}
            sort={prefs.sort}
            back={prefs.back}
            four={prefs.fourColor}
            speed={speed}
            canAct={canAct}
            selected={selected}
            hint={hint}
            bubbles={bubbles}
            thinkingSeat={thinkingSeat}
            winProb={prefs.showWinProb && human !== null ? winProb[String(human)] : undefined}
            seatWin={prefs.showWinProb ? winProb : undefined}
            levelOf={levelOf}
            ribbon={{ main: table!.main, sub: table!.sub, tone: table!.tone }}
            primary={
              table!.primary === "again"
                ? { kind: "again", enabled: !busy, onClick: () => void startGame({ ...settings, seed: "" }) }
                : { kind: table!.primary, enabled: canAct && view.legal.includes(PASS), onClick: () => void play(PASS) }
            }
            onPlay={(a) => void play(a)}
            onHint={bots ? askHint : undefined}
            onHintClose={() => setHint({ open: false, loading: false, data: null })}
            spectate={
              view.mode === "spectate"
                ? { auto: autoPlay, done: view.done, busy, toggle: () => setAutoPlay((a) => !a), step: () => void spectateRun("step"), end: () => void spectateRun("end") }
                : undefined
            }
            busy={busy}
            onSkip={skip}
            apiRef={tableApi}
            onSound={(k) => (k === "snap" ? sfx.snap() : sfx.deal())}
            topbar={{
              onHome: () => setScreen("title"),
              onLog: () => setLogOpen((o) => !o),
              logDot: !logOpen && log.length > logSeen,
              sound: prefs.sound,
              onSound: () => setPrefs((p) => ({ ...p, sound: !p.sound })),
              onSettings: () => setDialog("settings"),
            }}
            onSort={() => setPrefs((p) => ({ ...p, sort: p.sort === "suit" ? "rank" : "suit" }))}
            logOpen={logOpen}
            logNode={logNode}
            onLogClose={() => setLogOpen(false)}
            pending={pending}
          />
        </>
      )}
      {sheets}
      {reveal && (
        <DurakReveal
          lose={reveal === "lose"}
          onDone={() => {
            setReveal(null);
            setDialog("over");
          }}
        />
      )}
      {dialog === "over" && view.done && (
        <GameOverSheet
          state={view}
          onAgain={() => startGame({ ...settings, seed: "" })}
          onLobby={() => {
            setDialog(null);
            setScreen("lobby");
          }}
          onClose={() => setDialog(null)}
          onAnalyze={
            view.mode === "play"
              ? () => {
                  setDialog(null);
                  setReplayOpen(true);
                }
              : undefined
          }
          levelOf={levelOf}
        />
      )}
      {tutorial && (
        <Tutorial
          onDone={() => {
            setTutorial(false);
            setPrefs((p) => ({ ...p, tutorialDone: true }));
          }}
        />
      )}
    </div>
  );
}
