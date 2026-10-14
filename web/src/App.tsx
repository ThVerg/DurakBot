import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { ApiError, api, type BotsResponse, type GameState, type Hint, type Step, type StepsResponse } from "./api";
import { PASS, cardLabel, sortHand, suitOf } from "./cards";
import { speechKey } from "./components/Avatar";
import { displayName, type Bubble, type Dealing } from "./components/Board";
import { DurakReveal, HintPanel, Tutorial } from "./components/Coach";
import { GameOverDialog, NewGameDialog, RulesDialog, SettingsDialog, StatsDialog, botLabel, type Settings } from "./components/Dialogs";
import { GameTable } from "./components/GameTable";
import { GameStage } from "./hud/GameStage";
import { Lobby, TIERS, TitleScreen, tierAgent } from "./hud/Title";
import type { Quality, SceneApi, SceneMode } from "./three/Scene3D";
import { clearFx, confetti, fly, hiddenDuring, makeBack, makeFlipCard, rectOf, reducedMotion } from "./fx";
import { I18nProvider, Rich, makeT, type TFn } from "./i18n";
import { describeStep, type LogEntry, type Val } from "./log";
import { SPEED_SCALE, load, save, usePrefs, type Prefs, type Speed } from "./prefs";
import { setSoundEnabled, sfx, unlockAudio } from "./sound";

const Lab = lazy(() => import("./lab/Lab"));
const Scene3D = lazy(() => import("./three/Scene3D"));

function webglAvailable(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}
const WEBGL = webglAvailable();
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const Replay = lazy(() => import("./components/Replay"));

type DialogKind = "new" | "stats" | "rules" | "over" | "settings" | null;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

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

const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const seatEl = (seat: number) => q(`[data-seat="${seat}"]`);
const seatHandRect = (seat: number) => rectOf(seatEl(seat)?.querySelector(".opp-hand .backs, .opp-hand, .hand-inner, .hand")) ?? rectOf(seatEl(seat));
const cssPx = (name: string, fallback: number) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || fallback;

/** A card-sized rect centred inside ``r``. */
function centered(r: DOMRect, w: number, h: number): DOMRect {
  return new DOMRect(r.left + r.width / 2 - w / 2, r.top + r.height / 2 - h / 2, w, h);
}

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
  const [bots, setBots] = useState<BotsResponse | null>(null);
  const [settings, setSettings] = useState<Settings>(() => load("durak.settings", DEFAULT_SETTINGS));
  const [gid, setGid] = useState<string | null>(null);
  const [view, setViewState] = useState<GameState | null>(null);
  const [busy, setBusy] = useState(false);
  const [thinkingSeat, setThinkingSeat] = useState<number | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [bubbles, setBubbles] = useState<Record<number, Bubble>>({});
  const [dealing, setDealing] = useState<Dealing | null>(null);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [replayOpen, setReplayOpen] = useState(false);
  const [reveal, setReveal] = useState<"lose" | "win" | null>(null);
  const [winProb, setWinProb] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [autoPlay, setAutoPlay] = useState(true);
  const [hint, setHint] = useState<{ open: boolean; loading: boolean; data: Hint | null }>({ open: false, loading: false, data: null });
  const [tutorial, setTutorial] = useState(false);
  const [lastStep, setLastStep] = useState<Step | null>(null);
  const [screen, setScreen] = useState<SceneMode>("title");
  const sceneApi = useRef<SceneApi | null>(null);
  const quality: Quality | "2d" =
    prefs.quality === "auto" ? "medium" : prefs.quality; // medium = soft shadows + bloom at DPR <= 1.5 (60 fps on iGPUs)
  const use3d = WEBGL && quality !== "2d";
  const use3dRef = useRef(use3d);
  use3dRef.current = use3d;

  const genRef = useRef(0);
  const skipRef = useRef(false);
  const ffRef = useRef(false); // fast-forward to the end (spectate "To end")
  const speedRef = useRef<Speed>(prefs.speed);
  const viewRef = useRef<GameState | null>(null);
  const gidRef = useRef<string | null>(null);
  const autoRef = useRef(true);
  const celebratedRef = useRef(false);
  const bubbleKey = useRef(0);
  const logEnd = useRef<HTMLDivElement | null>(null);
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
    logEnd.current?.scrollIntoView({ block: "end" });
  }, [log]);

  const setView = useCallback((v: GameState | null) => {
    viewRef.current = v;
    setViewState(v);
  }, []);
  const scale = () => (skipRef.current || ffRef.current || reducedMotion() ? 0 : SPEED_SCALE[speedRef.current]);

  const botLabelOf = useCallback(
    (name: string) => botLabel(bots?.bots.find((b) => b.name === name), name, prefs.lang),
    [bots, prefs.lang],
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
        const onGame = !window.location.hash.startsWith("#/lab");
        let saved: string | null = null;
        try {
          saved = localStorage.getItem("durak.gameId");
        } catch {
          /* ignore */
        }
        void onGame;
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
  const showBubble = useCallback((seat: number, text: string, tone: Bubble["tone"]) => {
    bubbleKey.current += 1;
    const b = { seat, text, tone, key: bubbleKey.current };
    setBubbles((prev) => ({ ...prev, [seat]: b }));
  }, []);

  const handTarget = (seat: number) => {
    const v = viewRef.current;
    if (v && seat === (v.human_seat ?? (v.mode === "spectate" ? 0 : -1))) return rectOf(q(".hand-inner")) ?? rectOf(q(".hand"));
    return seatHandRect(seat);
  };

  const animateDraws = async (st: Step, sc: number) => {
    const tw = cssPx("--tw", 70);
    const from = rectOf(q(".talon-stack"));
    if (!from || sc === 0) return;
    const start = centered(from, tw, tw * 1.4);
    const flights: Promise<void>[] = [];
    let k = 0;
    for (const e of st.events) {
      if (e.type !== "draw") continue;
      const to = handTarget(e.player);
      if (!to) continue;
      for (let i = 0; i < Math.min(e.count, 6); i++, k++) {
        const target = centered(to, tw * 0.6, tw * 0.84);
        const delay = k * 70 * sc;
        flights.push(fly(makeBack(tw), { from: start, to: target, duration: 420 * sc, delay, rotFrom: -6, rotTo: (i - 2) * 6, arc: 30, fadeOut: true }));
        setTimeout(() => sfx.deal(), delay + 300 * sc);
      }
    }
    await Promise.all(flights);
  };

  const animateStep = async (st: Step, opts: { fromRect?: DOMRect | null } = {}) => {
    const tt = tRef.current;
    const v = st.view;
    const human = viewRef.current?.human_seat ?? null;
    const isHuman = st.player === human;
    const endEv = st.events.find((e) => e.type === "bita" || e.type === "pickup") as
      | { type: "bita"; cards: number[] }
      | { type: "pickup"; player: number; cards: number[] }
      | undefined;
    const lines = describeStep(st, human);

    // speech / bubble
    if (st.card !== null) showBubble(st.player, cardLabel(st.card), "play");
    else if (st.kind === "take" && !isHuman) {
      const k = speechKey("take", st.seq + st.player, 0.5);
      showBubble(st.player, k ? tt(k) : tt("bubble.take"), k ? "say" : "take");
    } else showBubble(st.player, tt(`bubble.${st.kind}`), st.kind === "take" ? "take" : st.kind === "bita" ? "bita" : "pass");
    setLog((l) => [...l, ...lines]);

    const sc = scale();
    if (!v) return;
    if (use3dRef.current) {
      // 3D: the scene tweens every card to its new place; we just wait for it.
      if (endEv && sc > 0) await sleep(isHuman ? 140 : 420 * sc);
      flushSync(() => {
        setLastStep(st);
        setView(v);
      });
      if (endEv) endEv.type === "bita" ? sfx.swoosh() : sfx.take();
      if (sc > 0) {
        await nextFrame();
        await nextFrame();
        await sleep(Math.min(2600, sceneApi.current?.settleMs() ?? 400 * sc));
      }
      afterEvents(st, human);
      if (sc > 0) await sleep((isHuman ? 40 : 140) * sc);
      return;
    }
    if (sc === 0) {
      flushSync(() => setView(v));
      if (st.card !== null) sfx.snap();
      if (endEv) endEv.type === "bita" ? sfx.swoosh() : sfx.take();
      afterEvents(st, human);
      return;
    }

    if (endEv) {
      if (st.kind === "take" || st.kind === "done" || st.kind === "bita" || st.kind === "pass") await sleep(isHuman ? 120 : 380 * sc);
      const els = Array.from(document.querySelectorAll<HTMLElement>(".pairs .table-card"));
      const rects = els.map((el) => rectOf(el));
      const tw = cssPx("--tw", 70);
      const clones = els.map((el) => (endEv.type === "bita" ? makeFlipCard(el, tw, false) : makeFlipCard(el, tw, false)));
      flushSync(() => setView(v));
      const dst = endEv.type === "bita" ? rectOf(q(".discard-stack")) : handTarget(endEv.player);
      if (endEv.type === "bita") sfx.swoosh();
      else sfx.take();
      if (dst) {
        await Promise.all(
          clones.map((c, i) => {
            const r = rects[i];
            if (!r) return Promise.resolve();
            const to = centered(dst, r.width * (endEv.type === "bita" ? 1 : 0.7), r.height * (endEv.type === "bita" ? 1 : 0.7));
            return fly(c, {
              from: r,
              to,
              duration: 560 * sc,
              delay: i * 40 * sc,
              rotFrom: 0,
              rotTo: endEv.type === "bita" ? ((i * 37) % 29) - 14 : (i - els.length / 2) * 5,
              flip: endEv.type === "bita",
              fadeOut: endEv.type !== "bita",
              arc: 40,
            });
          }),
        );
      }
      await animateDraws(st, sc);
      afterEvents(st, human);
      await sleep(160 * sc);
      return;
    }

    flushSync(() => setView(v));
    if (st.card !== null) {
      const target = q(`.pairs [data-card="${st.card}"]`);
      const tr = rectOf(target);
      const src = opts.fromRect ?? seatHandRect(st.player);
      if (target && tr && src) {
        const clone = target.cloneNode(true) as HTMLElement;
        clone.classList.add("fx-card");
        clone.style.rotate = "0deg";
        const from = opts.fromRect ? opts.fromRect : centered(src, tr.width * 0.75, tr.height * 0.75);
        const isDef = target.classList.contains("defense");
        const p = fly(clone, {
          from: new DOMRect(from.left, from.top, from.width, from.height),
          to: tr,
          duration: (isHuman ? 300 : 420) * sc,
          rotFrom: isHuman ? 0 : -18,
          rotTo: isDef ? 9 : 0,
          land: true,
          arc: isHuman ? 20 : 50,
        });
        setTimeout(() => sfx.snap(), (isHuman ? 260 : 380) * sc);
        await hiddenDuring(target, p);
      } else sfx.snap();
      await sleep((isHuman ? 60 : 260) * sc);
    } else {
      await sleep(320 * sc);
    }
    afterEvents(st, human);
  };

  /** Out / game-over side effects (sounds, bubbles, confetti). */
  const afterEvents = (st: Step, human: number | null) => {
    const tt = tRef.current;
    for (const e of st.events) {
      if (e.type === "out") {
        if (e.player === human) {
          sfx.win();
          if (!celebratedRef.current) {
            celebratedRef.current = true;
            confetti();
          }
          showBubble(e.player, tt("bubble.out", { p: e.place }), "out");
        } else {
          sfx.out();
          const k = speechKey("out", st.seq + e.player, 0.6);
          showBubble(e.player, k ? tt(k) : tt("bubble.out", { p: e.place }), k ? "say" : "out");
        }
      }
      if (e.type === "game_over" && e.loser !== null && e.loser !== human) {
        const k = speechKey("durak", st.seq, 1);
        if (k) showBubble(e.loser, tt(k), "say");
      }
      if (e.type === "game_over" && e.loser !== null && e.loser === human) {
        const v = viewRef.current;
        const other = v?.players.find((p) => !p.is_human && !p.is_durak);
        const k = speechKey("winVsYou", st.seq, 1);
        if (other && k) showBubble(other.seat, tt(k), "say");
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
      setTimeout(() => setDialog("over"), 600);
    }
  };

  /** Pull bot moves one at a time and animate each as it arrives. */
  const pump = async (gen: number) => {
    const id = gidRef.current;
    // Next bot move requested while the current one animates (play mode).
    let pending: Promise<StepsResponse> | null = null;
    while (genRef.current === gen && id) {
      const v = viewRef.current;
      if (!v || v.done || v.your_turn) break;
      if (v.mode === "spectate" && !autoRef.current) break;
      setThinkingSeat(v.to_move);
      const t0 = performance.now();
      let res: StepsResponse;
      try {
        res = await (pending ?? api.advance(id, "step"));
        pending = null;
      } catch (e) {
        pending = null;
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
      const minThink = (v.mode === "spectate" ? 200 : 380) * scale();
      await sleep(minThink - (performance.now() - t0));
      if (genRef.current !== gen) return;
      setThinkingSeat(null);
      const nx = res.state;
      if (nx.mode === "play" && !nx.done && !nx.your_turn) {
        pending = api.advance(id, "step");
        pending.catch(() => undefined);
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

  const dealAnimation = async (v: GameState, gen: number) => {
    const sc = scale();
    const n = v.num_players;
    if (sc === 0) return;
    const sizes = v.players.map((p) => p.hand_size);
    const dealt = new Array(n).fill(0);
    const total = sizes.reduce((a, b) => a + b, 0);
    let extra = total;
    setDealing({ dealt: [...dealt], trumpShown: false, extra });
    sfx.shuffle();
    await sleep(650 * sc);
    const tw = cssPx("--tw", 70);
    const bottom = v.human_seat ?? 0;
    const flights: Promise<void>[] = [];
    const stagger = Math.max(18, (n <= 3 ? 75 : 45) * sc);
    for (let round = 0; round < 6; round++) {
      for (let k = 1; k <= n; k++) {
        if (genRef.current !== gen) return;
        const p = (bottom + k) % n;
        if (dealt[p] >= sizes[p]) continue;
        const from = rectOf(q(".talon-stack"));
        const to = p === bottom ? rectOf(q(".hand")) : seatHandRect(p);
        extra -= 1;
        const snapshot = extra;
        if (from && to) {
          const fl = fly(makeBack(tw), {
            from: centered(from, tw, tw * 1.4),
            to: centered(to, tw * 0.55, tw * 0.77),
            duration: 380 * sc,
            rotFrom: 0,
            rotTo: (Math.random() - 0.5) * 30,
            arc: 26,
            fadeOut: true,
          }).then(() => {
            dealt[p] += 1;
            if (genRef.current === gen) setDealing({ dealt: [...dealt], trumpShown: false, extra: snapshot });
            sfx.deal();
          });
          flights.push(fl);
        } else dealt[p] += 1;
        await sleep(stagger);
      }
    }
    await Promise.all(flights);
    if (genRef.current !== gen) return;
    setDealing({ dealt: sizes, trumpShown: true, extra: 0 });
    sfx.snap();
    await sleep(450 * sc);
    setDealing(null);
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
      const gen = ++genRef.current;
      clearFx();
      setBusy(true);
      setError(null);
      setWinProb({});
      setBubbles({});
      setSelected(null);
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
        setLog([
          {
            id: "start",
            seat: null,
            tone: "bout",
            key: "log.newGame",
            params: { n, card: { card: st.trump_card }, who: { who: p0.seat }, verb: { t: p0.is_human ? "log.attackFirstYou" : "log.attacksFirst" } },
          },
        ]);
        const sc = scale();
        setLastStep(null);
        if (use3dRef.current) {
          if (sc > 0) sfx.shuffle();
          setView(st);
          if (sc > 0) {
            await nextFrame();
            await nextFrame();
            await sleep(Math.min(5000, sceneApi.current?.settleMs() ?? 1500));
          }
        } else {
          if (sc > 0) setDealing({ dealt: new Array(n).fill(0), trumpShown: false, extra: 36 - st.talon_size });
          setView(st);
          await sleep(30);
          await dealAnimation(st, gen);
        }
        if (genRef.current !== gen) return;
        await pump(gen);
      } catch (e) {
        setError(String(e));
        setBusy(false);
        setDealing(null);
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
      const gen = ++genRef.current;
      const fromRect = action !== PASS ? rectOf(q(`.hand [data-card="${action}"]`)) : null;
      try {
        const res = await api.act(id, action);
        if (genRef.current !== gen) return;
        for (const st of res.steps) await animateStep(st, { fromRect });
        setView(res.state);
        await pump(gen);
      } catch (e) {
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
        // already running: just fast-forward the running loop
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
    if (!view || view.mode !== "spectate" || !autoPlay || busy || view.done || dialog || dealing) return;
    const gen = ++genRef.current;
    setBusy(true);
    void pump(gen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPlay, busy, view?.done, view?.mode, dialog, dealing]);

  const toggleDebug = useCallback(async () => {
    const v = viewRef.current;
    const id = gidRef.current;
    if (!id || !v || busy || v.mode !== "play") return;
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

  // Champion win-probability estimate.
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

  // First-game coach marks.
  useEffect(() => {
    if (!prefs.tutorialDone && screen === "game" && view?.mode === "play" && view.your_turn && !busy && !dialog && !dealing && route === "game") setTutorial(true);
  }, [prefs.tutorialDone, view?.your_turn, busy, dialog, dealing, route, view?.mode, screen]);

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
      if (screen !== "game") {
        if (k === "Escape") {
          if (dialog) setDialog(null);
          else if (screen === "lobby") setScreen("title");
        }
        return;
      }
      if (route !== "game" || replayOpen || tutorial || reveal) {
        if (k === "Escape" && dialog) setDialog(null);
        return;
      }
      if (k === "Escape") {
        if (dialog) setDialog(null);
        else if (hint.open) setHint({ open: false, loading: false, data: null });
        else if (busy) skipRef.current = true;
        return;
      }
      if (dialog) return;
      if (busy && (k === " " || k === "Enter")) {
        e.preventDefault();
        skipRef.current = true;
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
        const next = k === "ArrowRight" ? (i + 1) % legalSorted.length : (i - 1 + legalSorted.length) % legalSorted.length;
        setSelected(legalSorted[next]);
      } else if (k === "Enter" && selected !== null && legalSorted.includes(selected)) {
        e.preventDefault();
        void play(selected);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialog, busy, view, legalSorted, selected, play, spectateRun, toggleDebug, askHint, hint.open, route, replayOpen, tutorial, reveal, setPrefs, screen]);

  // ------------------------------------------------------------- rendering
  const nameOf = (seat: number) => (view ? displayName(view.players[seat], t) : `P${seat + 1}`);

  const renderVal = (v: Val, key: string, i: number): ReactNode => {
    if (typeof v === "string" || typeof v === "number") return <span key={i}>{v}</span>;
    if ("card" in v)
      return (
        <span key={i} className={`log-card suit-${suitOf(v.card)}`}>
          {cardLabel(v.card)}
        </span>
      );
    if ("who" in v) {
      const isYou = view && v.who === view.human_seat;
      const subject = key === "who" || key === "att";
      return (
        <b key={i} className={isYou ? "log-you" : ""}>
          {isYou ? (subject ? t("log.you") : t("log.youObj")) : nameOf(v.who)}
        </b>
      );
    }
    if ("t" in v) return <span key={i}>{t(v.t)}</span>;
    return <span key={i}>{v.list.map((x, j) => renderVal(x, key === "list" ? "list" : key, j))}</span>;
  };
  const renderEntry = (e: LogEntry) => {
    const nodes: Record<string, ReactNode> = {};
    for (const [k, v] of Object.entries(e.params)) nodes[k] = renderVal(v, k, 0);
    return <Rich text={t(e.key)} nodes={nodes} />;
  };

  const status = useMemo((): ReactNode => {
    if (!view) return null;
    const P = (seat: number) => <b>{nameOf(seat)}</b>;
    if (dealing) return t("status.dealing");
    if (view.done) {
      if (view.loser === null) return view.result?.reason === "stalemate" ? t("status.over.stalemate") : t("status.over.draw");
      return view.loser === view.human_seat ? <Rich text={t("status.over.you")} /> : <Rich text={t("status.over.other")} nodes={{ name: P(view.loser) }} />;
    }
    const toMove = view.to_move!;
    if (view.mode === "spectate") return <Rich text={t("status.spectate")} nodes={{ to: P(toMove), att: P(view.attacker), def: P(view.defender) }} />;
    const meP = view.players[view.human_seat!];
    if (meP.out) return t("status.out", { p: meP.place ?? "" });
    if (!view.your_turn || busy) {
      if (thinkingSeat !== null) return <Rich text={t("status.thinking")} nodes={{ name: P(thinkingSeat) }} />;
      return <Rich text={t("status.toMove")} nodes={{ name: P(toMove) }} />;
    }
    const uncovered = view.table.find((p) => p.defense === null);
    switch (view.phase) {
      case "attack":
        if (!view.table.length) return <Rich text={t("status.lead")} nodes={{ def: P(view.defender) }} />;
        return <Rich text={view.pass_label === "bita" ? t("status.throwBita") : t("status.throwPass")} />;
      case "defend":
        return (
          <Rich
            text={t("status.defend")}
            nodes={{ card: uncovered ? <span className={`log-card suit-${suitOf(uncovered.attack)}`}>{cardLabel(uncovered.attack)}</span> : null }}
          />
        );
      case "throw_in":
        return <Rich text={t("status.throwIn")} nodes={{ def: P(view.defender) }} />;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, busy, thinkingSeat, dealing, t]);

  const topBar = (
    <TopBar
      prefs={prefs}
      setPrefs={setPrefs}
      onNew={() => setScreen("lobby")}
      onStats={() => setDialog("stats")}
      onRules={() => setDialog("rules")}
      onSettings={() => setDialog("settings")}
      onHome={() => setScreen("title")}
      onLog={view ? () => setLogOpen((o) => !o) : undefined}
      evalAvailable={!!bots?.evaluate_available}
      debug={view?.mode === "play" && !view.done ? { on: view.debug_reveal, toggle: toggleDebug } : undefined}
      route={route}
      t={t}
      info={view ? <>{t("info.players", { n: view.num_players })} · {view.mode === "spectate" ? t("info.spectating") : t("info.seat", { s: (view.human_seat ?? 0) + 1 })}</> : null}
    />
  );

  const dialogs = (
    <>
      {dialog === "new" && <NewGameDialog bots={bots} initial={settings} onStart={startGame} onClose={() => setDialog(null)} />}
      {dialog === "stats" && <StatsDialog onClose={() => setDialog(null)} botLabelOf={botLabelOf} />}
      {dialog === "rules" && <RulesDialog onClose={() => setDialog(null)} />}
      {dialog === "settings" && (
        <SettingsDialog
          prefs={prefs}
          setPrefs={setPrefs}
          evalAvailable={!!bots?.evaluate_available}
          debug={view?.mode === "play" && !view.done ? { on: view.debug_reveal, toggle: toggleDebug } : undefined}
          onClose={() => setDialog(null)}
          onTutorial={() => {
            setDialog(null);
            setPrefs((p) => ({ ...p, tutorialDone: false }));
            if (viewRef.current?.your_turn) setTutorial(true);
          }}
        />
      )}
    </>
  );

  if (route === "lab") {
    return (
      <div className="app lab-route">
        {topBar}
        <main className="lab-main">
          <Suspense fallback={<div className="loading">{t("loading")}</div>}>
            <Lab onBack={() => (window.location.hash = "")} botLabelOf={botLabelOf} />
          </Suspense>
        </main>
        {dialogs}
      </div>
    );
  }

  const sceneLayer =
    use3d && !replayOpen ? (
      <div className="scene-layer" data-testid="scene-layer">
        <Suspense fallback={null}>
          <Scene3D
            mode={screen}
            view={screen === "game" ? view : null}
            step={lastStep}
            sort={prefs.sort}
            reveal={!!view && (view.mode === "spectate" || view.debug_reveal)}
            legal={new Set(view && view.your_turn && !busy ? view.legal : [])}
            canAct={!!view && view.your_turn && !busy && screen === "game"}
            hintAction={hint.open && hint.data ? hint.data.recommended : null}
            selected={selected}
            onPlay={play}
            speed={reducedMotion() ? 0 : SPEED_SCALE[prefs.speed]}
            quality={quality as Quality}
            theme={prefs.theme}
            back={prefs.back}
            fourColor={prefs.fourColor}
            bubbles={bubbles}
            thinkingSeat={thinkingSeat}
            winProb={winProb}
            showWinProb={prefs.showWinProb}
            botLabelOf={botLabelOf}
            apiRef={sceneApi}
            onSound={(k) => (k === "snap" ? sfx.snap() : sfx.deal())}
          />
        </Suspense>
      </div>
    ) : null;

  if (screen !== "game" || !view) {
    const resume = view && !view.done && view.mode === "play" ? view : null;
    return (
      <div className={`app screen-${screen} ${use3d ? "has-3d" : "no-3d"}`}>
        {sceneLayer}
        <div className="title-scrim" aria-hidden="true" />
        {screen === "lobby" ? (
          <Lobby bots={bots} initial={settings} onStart={startGame} onBack={() => setScreen("title")} />
        ) : (
          <TitleScreen
            bots={bots}
            settings={settings}
            resume={resume}
            onPlay={() => startGame({ ...settings, spectate: false, seed: "" })}
            onContinue={continueGame}
            onLobby={() => setScreen("lobby")}
            onWatch={() => startGame({ ...settings, spectate: true, numPlayers: Math.max(3, settings.numPlayers), seed: "" })}
            onRules={() => setDialog("rules")}
            setLang={(l) => setPrefs((p) => ({ ...p, lang: l }))}
            onSettings={() => setDialog("settings")}
            sound={prefs.sound}
            toggleSound={() => setPrefs((p) => ({ ...p, sound: !p.sound }))}
          />
        )}
        {error && (
          <div className="toast" role="alert" onClick={() => setError(null)}>
            {error}
          </div>
        )}
        {dialogs}
      </div>
    );
  }

  const isReveal = view.mode === "spectate" || view.debug_reveal;
  const hintAction = hint.open && hint.data ? hint.data.recommended : null;

  const spectateControls =
    view.mode === "spectate" ? (
      <>
        <button type="button" className="btn" onClick={() => setAutoPlay((a) => !a)} disabled={view.done}>
          {autoPlay ? t("spect.pause") : t("spect.play")}
        </button>
        <button type="button" className="btn ghost" onClick={() => spectateRun("step")} disabled={busy || view.done || autoPlay}>
          {t("spect.step")}
        </button>
        <button type="button" className="btn ghost" onClick={() => spectateRun("end")} disabled={view.done}>
          {t("spect.end")}
        </button>
      </>
    ) : null;

  return (
    <div className={`app screen-game ${use3d ? "has-3d" : "no-3d"}`}>
      {sceneLayer}
      {topBar}
      <main className={`main ${logOpen ? "log-open" : ""}`}>
        {use3d && replayOpen ? (
          <section className="stage" />
        ) : use3d ? (
          <GameStage
            embedScene={false}
            view={view}
            step={lastStep}
            busy={busy}
            thinkingSeat={thinkingSeat}
            bubbles={bubbles}
            reveal={isReveal}
            winProb={winProb}
            showWinProb={prefs.showWinProb}
            status={status}
            statusTone={view.done ? "over" : view.your_turn && !busy ? "you" : "wait"}
            selected={selected}
            onPlay={play}
            sort={prefs.sort}
            onSort={() => setPrefs((p) => ({ ...p, sort: p.sort === "suit" ? "rank" : "suit" }))}
            onHint={askHint}
            hintAvailable={!!bots}
            hintAction={hintAction}
            hintOpen={hint.open}
            extraControls={spectateControls}
            botLabelOf={botLabelOf}
            speed={reducedMotion() ? 0 : SPEED_SCALE[prefs.speed]}
            quality={quality as Quality}
            theme={prefs.theme}
            back={prefs.back}
            fourColor={prefs.fourColor}
            apiRef={sceneApi}
            onSound={(k) => (k === "snap" ? sfx.snap() : sfx.deal())}
            overlay={
              hint.open ? (
                <HintPanel
                  hint={hint.data}
                  loading={hint.loading}
                  passLabel={view.pass_label}
                  onPlay={(a) => void play(a)}
                  onClose={() => setHint({ open: false, loading: false, data: null })}
                />
              ) : null
            }
            boardExtra={
              busy && SPEED_SCALE[prefs.speed] > 0 ? (
                <button type="button" className="skip-btn" onClick={() => (skipRef.current = true)} title="Space">
                  {t("skip")}
                </button>
              ) : null
            }
          />
        ) : (
          <GameTable
            view={view}
            busy={busy || !!dealing}
            thinkingSeat={thinkingSeat}
            bubbles={bubbles}
            dealing={dealing}
            reveal={isReveal}
            winProb={winProb}
            showWinProb={prefs.showWinProb}
            status={status}
            selected={selected}
            onPlay={play}
            sort={prefs.sort}
            onSort={() => setPrefs((p) => ({ ...p, sort: p.sort === "suit" ? "rank" : "suit" }))}
            onHint={askHint}
            hintAvailable={!!bots}
            hintAction={hintAction}
            hintOpen={hint.open}
            extraControls={spectateControls}
            botLabelOf={botLabelOf}
            overlay={
              hint.open ? (
                <HintPanel
                  hint={hint.data}
                  loading={hint.loading}
                  passLabel={view.pass_label}
                  onPlay={(a) => void play(a)}
                  onClose={() => setHint({ open: false, loading: false, data: null })}
                />
              ) : null
            }
            boardExtra={
              busy && !dealing && SPEED_SCALE[prefs.speed] > 0 ? (
                <button type="button" className="skip-btn" onClick={() => (skipRef.current = true)} title="Space">
                  {t("skip")}
                </button>
              ) : null
            }
          />
        )}
        <aside className="log-panel" aria-label={t("log.title")}>
          <div className="log-head">
            <h3>{t("log.title")}</h3>
            <span className="muted">{t("log.moves", { n: view.moves })}</span>
            <button type="button" className="icon-btn log-close" onClick={() => setLogOpen(false)} aria-label={t("a11y.close")}>
              ✕
            </button>
          </div>
          <div className="log-list" aria-live="off">
            {log.map((e) => (
              <div key={e.id} className={`log-entry tone-${e.tone}`}>
                {renderEntry(e)}
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
      {dialogs}
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
        <GameOverDialog
          state={view}
          onAgain={() => startGame({ ...settings, seed: "" })}
          onNew={() => {
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
          botLabelOf={botLabelOf}
        />
      )}
      {replayOpen && gid && (
        <Suspense fallback={<div className="loading">{t("loading")}</div>}>
          <Replay
            gameId={gid}
            onClose={() => setReplayOpen(false)}
            sort={prefs.sort}
            botLabelOf={botLabelOf}
            stage={
              use3d
                ? { quality: quality as Quality, theme: prefs.theme, back: prefs.back, fourColor: prefs.fourColor, speed: reducedMotion() ? 0 : 0.55 }
                : undefined
            }
          />
        </Suspense>
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

function TopBar({
  prefs,
  setPrefs,
  onNew,
  onStats,
  onRules,
  onSettings,
  onHome,
  onLog,
  evalAvailable,
  debug,
  info,
  route,
  t,
}: {
  prefs: Prefs;
  setPrefs: (f: (p: Prefs) => Prefs) => void;
  onNew: () => void;
  onStats: () => void;
  onRules: () => void;
  onSettings: () => void;
  onHome?: () => void;
  onLog?: () => void;
  evalAvailable: boolean;
  debug?: { on: boolean; toggle: () => void };
  info?: ReactNode;
  route: "game" | "lab";
  t: TFn;
}) {
  return (
    <header className="topbar">
      <a className="brand" href="#/" aria-label="DurakBot" onClick={(e) => (onHome ? (e.preventDefault(), onHome()) : undefined)}>
        <span className="logo" aria-hidden="true">
          <i />
          <i />
        </span>
        <span className="brand-name">DurakBot</span>
        {info && route === "game" && <span className="brand-info">{info}</span>}
      </a>
      <nav className="tools" aria-label="Main">
        {route === "game" && (
          <label className="speed hide-narrow tb-extra" title={t("nav.speed")}>
            <span>{t("nav.speed")}</span>
            <select value={prefs.speed} onChange={(e) => setPrefs((p) => ({ ...p, speed: e.target.value as Speed }))} aria-label={t("nav.speed")}>
              <option value="slow">{t("speed.slow")}</option>
              <option value="normal">{t("speed.normal")}</option>
              <option value="fast">{t("speed.fast")}</option>
              <option value="instant">{t("speed.instant")}</option>
            </select>
          </label>
        )}
        {route === "game" && evalAvailable && (
          <button
            type="button"
            className={`chip hide-narrow tb-extra ${prefs.showWinProb ? "on" : ""}`}
            onClick={() => setPrefs((p) => ({ ...p, showWinProb: !p.showWinProb }))}
            aria-pressed={prefs.showWinProb}
          >
            {t("nav.winpct")}
          </button>
        )}
        {route === "game" && debug && (
          <button type="button" className={`chip debug hide-narrow ${debug.on ? "on" : "tb-extra"}`} onClick={debug.toggle} title={t("nav.revealTitle")} aria-pressed={debug.on} data-testid="debug-toggle">
            {t("nav.reveal")}
          </button>
        )}
        <button
          type="button"
          className={`icon-btn sound-btn ${prefs.sound ? "" : "muted-on"}`}
          onClick={() => setPrefs((p) => ({ ...p, sound: !p.sound }))}
          aria-label={prefs.sound ? t("nav.mute") : t("nav.unmute")}
          title={`${prefs.sound ? t("nav.mute") : t("nav.unmute")} (M)`}
          aria-pressed={!prefs.sound}
          data-testid="mute"
        >
          {prefs.sound ? "🔊" : "🔇"}
        </button>
        <button
          type="button"
          className="chip lang-chip hide-narrow"
          onClick={() => setPrefs((p) => ({ ...p, lang: p.lang === "en" ? "ru" : "en" }))}
          aria-label={prefs.lang === "en" ? "Русский" : "English"}
          data-testid="lang"
        >
          {prefs.lang === "en" ? "RU" : "EN"}
        </button>
        <button type="button" className="icon-btn" onClick={onSettings} aria-label={t("nav.settings")} title={t("nav.settings")} data-testid="settings">
          ⚙
        </button>
        <button type="button" className="btn ghost small" onClick={onRules} title={`${t("nav.rules")} (?)`}>
          <span className="wide-only">{t("nav.rules")}</span>
          <span className="narrow-only">?</span>
        </button>
        <button type="button" className="btn ghost small" onClick={onStats} title={`${t("nav.stats")} (S)`} aria-label={t("nav.stats")}>
          <span className="wide-only">{t("nav.stats")}</span>
          <span className="narrow-only" aria-hidden="true">📊</span>
        </button>
        {route === "game" ? (
          <a className="btn ghost small" href="#/lab" data-testid="lab-link" aria-label={t("nav.lab")} title={t("nav.lab")}>
            <span className="wide-only">{t("nav.lab")}</span>
            <span className="narrow-only" aria-hidden="true">🧪</span>
          </a>
        ) : (
          <a className="btn ghost small" href="#/">
            {t("nav.play")}
          </a>
        )}
        {onLog && route === "game" && (
          <button type="button" className="btn ghost small log-toggle" onClick={onLog} title={`${t("nav.log")} (L)`} aria-label={t("nav.log")}>
            <span className="wide-only">{t("nav.log")}</span>
            <span className="narrow-only" aria-hidden="true">📜</span>
          </button>
        )}
        {route === "game" && (
          <button type="button" className="btn primary small" onClick={onNew} title={`${t("nav.new")} (N)`} data-testid="new-game">
            <span className="wide-only">{t("nav.new")}</span>
            <span className="narrow-only">{t("nav.newShort")}</span>
          </button>
        )}
      </nav>
    </header>
  );
}
