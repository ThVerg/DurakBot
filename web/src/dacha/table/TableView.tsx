// The Dacha game table: D's oval table in the sunlit dacha, with C's
// place-cards, ribbon status, tea-glass win meter and lacquer buttons.
// All cards live in one keyed layer and fly between poses.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { GameState, Hint, Player, Step } from "../../api";
import { PASS, RANKS, rankOf, suitOf } from "../../cards";
import { ordinal, useI18n } from "../../i18n";
import type { SortMode } from "../../prefs";
import { backSrc, propUrl, useHiRes } from "../art";
import { Icon, Suit } from "../Icons";
import { displayName, type Bubble } from "../names";
import { Medal, Stage, type StageDims } from "../Scene";
import { type Anchor, type Box, bubbleSize, hit, placeBubble, textWidth, useBubbles } from "./bubbles";
import { CardImg, FlyCard, type Settle } from "./CardLayer";
import { tierOfAgent } from "../tiers";
import { ASPECT, computeLayout, type CardTarget, type Geo, type SeatGeo } from "./layout";

export type PrimaryKind = "take" | "bita" | "pass" | "done" | "wait" | "lead" | "again";

export interface TableApi {
  settleMs: () => number;
}

export interface TableViewProps {
  view: GameState;
  step: Step | null;
  dims: StageDims;
  sort: SortMode;
  back: string;
  four: boolean;
  speed: number;
  canAct: boolean;
  selected: number | null;
  hint: { open: boolean; loading: boolean; data: Hint | null };
  bubbles: Record<number, Bubble>;
  thinkingSeat: number | null;
  winProb?: number;
  seatWin?: Record<string, number>;
  levelOf: (bot: string) => string;
  ribbon: { main: ReactNode; sub: ReactNode; tone: "you" | "wait" | "good" | "over" };
  primary: { kind: PrimaryKind; enabled: boolean; onClick: () => void };
  onPlay: (a: number) => void;
  onHint?: () => void;
  onHintClose?: () => void;
  spectate?: { auto: boolean; done: boolean; busy: boolean; toggle: () => void; step: () => void; end: () => void };
  busy: boolean;
  onSkip?: () => void;
  apiRef: { current: TableApi | null };
  onSound?: (k: "snap" | "deal") => void;
  topbar: { onHome: () => void; onLog: () => void; logDot: boolean; sound: boolean; onSound: () => void; onSettings: () => void };
  onSort: () => void;
  logOpen: boolean;
  logNode?: ReactNode;
  onLogClose: () => void;
  readOnly?: boolean;
  /** Card the human just played, shown on the table before the server answers. */
  pending?: number | null;
  children?: ReactNode;
}

function CardRef({ c }: { c: number }) {
  return (
    <b className="cref">
      {RANKS[rankOf(c)]}
      <Suit s={suitOf(c)} />
    </b>
  );
}
export { CardRef };

function Tag({ p, view, short }: { p: Player; view: GameState; short?: boolean }) {
  const { t, lang } = useI18n();
  if (view.done && p.is_durak)
    return (
      <span className="tag tag--durak">
        <span>{t("d.tag.durak")}</span>
      </span>
    );
  if (p.out || (view.done && p.place))
    return <span className="tag tag--out">{t(short ? "d.tag.outShort" : "d.tag.out", { ord: ordinal(p.place ?? 0, lang), p: p.place ?? "" })}</span>;
  if (view.done) return null;
  if (p.is_attacker)
    return (
      <span className="tag tag--attack">
        <Icon name="sword" />
        <span>{t("d.tag.attack")}</span>
      </span>
    );
  if (p.is_defender)
    return (
      <span className="tag tag--defend">
        <Icon name="shield" />
        <span>{t("d.tag.defend")}</span>
      </span>
    );
  if (p.is_thrower)
    return (
      <span className="tag tag--throw">
        <Icon name="plus" />
        <span>{t(short ? "d.tag.throwShort" : "d.tag.throw")}</span>
      </span>
    );
  if (p.known.length)
    return (
      <span className="known">
        <Icon name="eye" />
        {!short && <span>{t("d.known")}</span>}
        {p.known.slice(0, short ? 1 : 2).map((c) => (
          <b key={c}>
            {RANKS[rankOf(c)]}
            <Suit s={suitOf(c)} />
          </b>
        ))}
      </span>
    );
  return null;
}

function Seat({
  p,
  view,
  geo,
  sg,
  thinking,
  level,
  win,
  fanCount,
}: {
  p: Player;
  view: GameState;
  geo: Geo;
  sg?: SeatGeo;
  thinking: boolean;
  level?: string;
  win?: number;
  fanCount: number;
}) {
  const { t } = useI18n();
  const s = sg ?? geo.seats[p.seat];
  const m = geo.layout === "m";
  const k = Object.keys(geo.seats).length;
  const cls = [
    "seat",
    m ? "seat--m" : "seat--d",
    `seat--${s.side}`,
    s.x + s.w / 2 > geo.W / 2 + 4 ? "seat--rhs" : "seat--lhs",
    m && k >= 5 ? "seat--xs" : "",
    !view.done && p.is_attacker ? "is-attacker" : "",
    !view.done && p.to_move ? "to-move" : "",
    thinking ? "is-thinking" : "",
    p.out ? "is-out" : "",
    view.done && p.is_durak ? "is-durak" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const span = fanCount > 1 ? Math.min(s.fanStep * (fanCount - 1), s.fanSpan) : 0;
  const countX = s.fanX - s.x + span + s.fanW / 2 + (m ? 4 : 8);
  const countY = s.fanY - s.y;
  const name = displayName(p, t, m ? (k >= 5 ? "short" : "mid") : "full");
  const strength = p.bot ? tierOfAgent(p.bot)?.strength ?? 0 : 0;
  const medalSize = m ? (k >= 5 ? 46 : 56) : 92;
  return (
    <section className={cls} style={{ left: s.x, top: s.y, width: s.w, height: s.h } as CSSProperties} data-seat={p.seat} aria-label={name}>
      <div className="seat__id">
        <Medal persona={p.persona} size={medalSize}>
          {view.done && p.is_durak && <img className="medal__cap" src={propUrl("cap")} alt="" />}
        </Medal>
        {strength > 0 && !p.out && !thinking && (
          <span className="pips" title={level} aria-label={level}>
            {[1, 2, 3, 4].map((i) => (
              <i key={i} className={i <= strength ? "" : "off"} />
            ))}
          </span>
        )}
        {p.out && !p.is_durak && (
          <span className="laurel" aria-hidden="true">
            <Icon name="laurel" />
          </span>
        )}
        {thinking && (
          <span className="think" aria-label={t("d.thinking")}>
            {!m && <span className="think__txt">{t("d.thinking")}</span>}
            <span className="thinking">
              <i />
              <i />
              <i />
            </span>
          </span>
        )}
      </div>
      <div className="seat__body">
        <div className="seat__name">{name}</div>
        <div className="seat__meta">
          <Tag p={p} view={view} short={m} />
          {win !== undefined && <span className="seat__win">{Math.round(win * 100)}%</span>}
        </div>
        {!m && p.out && !fanCount && <div className="seat__note">{t("d.safe")}</div>}
      </div>
      {fanCount > 0 && (
        <span className="count" style={{ left: countX, top: countY }}>
          {p.hand_size}
        </span>
      )}
    </section>
  );
}

const SUIT_IDX = [0, 1, 2, 3];
function TrumpChip({ view, compact }: { view: GameState; compact?: boolean }) {
  const { t } = useI18n();
  const s = view.trump_suit;
  return (
    <div className={`trumpchip ${compact ? "trumpchip--m" : ""}`}>
      <span className={`trumpchip__disc s${s}`}>
        <Suit s={s} />
      </span>
      <span className="trumpchip__txt">
        <b>{t("d.trump")}</b>{" "}
        {view.talon_size > 0 ? (
          <span className="trumpchip__card">
            {RANKS[rankOf(view.trump_card)]}
            <Suit s={s} />
          </span>
        ) : null}{" "}
        {!compact && <span className="trumpchip__suit">{view.talon_size > 0 ? t(`d.suit.${SUIT_IDX[s]}`) : t("d.deckEmpty")}</span>}
      </span>
    </div>
  );
}

/** The deck's backs, in screen px inside the card layer (crisp at rest). */
function TalonBacks({ view, geo, back, S }: { view: GameState; geo: Geo; back: string; S: number }) {
  const t = geo.talon;
  const w = t.w * S;
  const h = w * ASPECT;
  const deck = Math.max(0, view.talon_size - 1); // the trump card is drawn by the card layer
  const layers = Math.min(4, Math.ceil(deck / 6));
  const bk = backSrc(back);
  return (
    <>
      {Array.from({ length: layers }, (_, i) => (
        <CardImg
          key={i}
          cls="talonback"
          src={bk.src}
          srcSet={bk.srcSet}
          cssW={w}
          style={{
            width: w,
            height: h,
            zIndex: 110 + i,
            transform: `translate(${Math.round(t.x * S - w / 2 + i * 1.6 * S)}px, ${Math.round(t.y * S - h / 2 - i * 1.6 * S)}px) rotate(${-4 + i}deg)`,
          }}
        />
      ))}
    </>
  );
}

/** Deck count + trump chip, drawn above the deck (over stage). */
function TalonInfo({ view, geo }: { view: GameState; geo: Geo }) {
  const m = geo.layout === "m";
  const t = geo.talon;
  const w = t.w;
  const h = w * ASPECT;
  return (
    <section className={`talon ${m ? "talon--m" : ""}`} style={{ left: t.x - w / 2, top: t.y - h / 2, width: w, height: h }} aria-label="talon">
      {view.talon_size > 0 && (
        <span className="talon__count">
          <b>{view.talon_size}</b>
        </span>
      )}
      <TrumpChip view={view} compact={m} />
    </section>
  );
}

function Bito({ view, geo }: { view: GameState; geo: Geo }) {
  const { t } = useI18n();
  const b = geo.bito;
  const m = geo.layout === "m";
  return (
    <div className={`bito__label ${m ? "bito__label--m" : ""}`} style={m ? { left: b.x + b.w / 2 + 6, top: b.y - 22 } : { left: b.x, top: b.y + 82 }}>
      <span className="ru" lang="ru">
        Бито
      </span>
      <span className="bito__n">{m ? view.discard_count : t("d.discard", { n: view.discard_count })}</span>
    </div>
  );
}

const PRIMARY: Record<PrimaryKind, { icon: string; ru: string; cls: string }> = {
  take: { icon: "take", ru: "беру", cls: "" },
  bita: { icon: "bita", ru: "бито", cls: "is-green" },
  pass: { icon: "pass", ru: "пас", cls: "is-cobalt" },
  done: { icon: "bita", ru: "всё", cls: "is-cobalt" },
  wait: { icon: "", ru: "", cls: "is-wait" },
  lead: { icon: "", ru: "", cls: "is-wait" },
  again: { icon: "replay", ru: "ещё раз", cls: "" },
};

function TeaMeter({ p }: { p: number | undefined }) {
  const { t } = useI18n();
  const pct = p === undefined ? null : Math.round(p * 100);
  const level = 84 - (pct ?? 0) * 0.78;
  return (
    <div className="meter" aria-label={`${t("d.winChance")} ${pct ?? "—"}%`} data-testid="win-meter">
      <svg className="meter__glass" viewBox="0 0 64 92" aria-hidden="true">
        <defs>
          <linearGradient id="teaG" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#e8913a" />
            <stop offset="1" stopColor="#a8440f" />
          </linearGradient>
          <linearGradient id="silv" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#9a8e74" />
            <stop offset=".35" stopColor="#fffdf4" />
            <stop offset=".7" stopColor="#d7cfbb" />
            <stop offset="1" stopColor="#8a7d63" />
          </linearGradient>
          <clipPath id="glassClip">
            <path d="M12 6 L46 6 L43 84 L15 84 Z" />
          </clipPath>
        </defs>
        <path d="M12 6 L46 6 L43 84 L15 84 Z" fill="#fff8ec" opacity=".55" />
        <g clipPath="url(#glassClip)">
          <rect x="0" y={level} width="64" height="90" fill="url(#teaG)" className="meter__tea" />
          <ellipse cx="29" cy={level} rx="17" ry="2.2" fill="#f5b265" className="meter__tea" />
        </g>
        <path d="M12 6 L46 6 L43 84 L15 84 Z" fill="none" stroke="#7a6a4c" strokeWidth="1.6" />
        <path d="M17 10 L19 78" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" opacity=".8" />
        <path d="M11 50 L47 50 L45 86 L13 86 Z" fill="url(#silv)" stroke="#6f634c" strokeWidth="1.4" />
        <path d="M14 58 h30 M14 66 h30" stroke="#8a7d63" strokeWidth="1" strokeDasharray="2 2.5" />
        <path d="M18 72 q11 -10 22 0 q-11 10 -22 0z" fill="none" stroke="#c9952e" strokeWidth="1.6" />
        <path d="M9 86 h40 v4 h-40z" fill="url(#silv)" stroke="#6f634c" strokeWidth="1.2" />
        <path d="M47 54 C 60 54 60 80 46 80" fill="none" stroke="#8a7d63" strokeWidth="5" strokeLinecap="round" />
        <path d="M47 54 C 60 54 60 80 46 80" fill="none" stroke="#efe9db" strokeWidth="2.4" strokeLinecap="round" />
        <path d="M36 0 L 32 48" stroke="#b9ae94" strokeWidth="2.4" strokeLinecap="round" />
      </svg>
      <div className="meter__txt">
        <div className="meter__num">
          {pct ?? "—"}
          {pct !== null && <small>%</small>}
        </div>
        <div className="meter__lbl">{t("d.winChance")}</div>
      </div>
    </div>
  );
}

export function TableView(p: TableViewProps) {
  const { t, lang } = useI18n();
  const { view, dims } = p;
  const geoLayout = dims.layout;
  const bottom = view.human_seat ?? 0;
  const me = view.players[bottom];
  const settle = useMemo<Settle>(() => ({ until: 0 }), []);
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ card: number; hot: boolean } | null>(null);
  const hires = useHiRes();

  useEffect(() => {
    p.apiRef.current = { settleMs: () => Math.max(0, settle.until - performance.now()) };
    return () => {
      p.apiRef.current = null;
    };
  }, [p.apiRef, settle]);

  // discard memory (compact step views don't carry the discard list)
  const discard = useRef<{ game: string; ids: number[]; seen: number }>({ game: "", ids: [], seen: -1 });
  const dealt = useRef("");
  if (discard.current.game !== view.game_id) discard.current = { game: view.game_id, ids: view.discard ?? [], seen: -1 };
  if (view.discard) discard.current.ids = view.discard;
  if (p.step && p.step.seq !== discard.current.seen) {
    discard.current.seen = p.step.seq;
    for (const e of p.step.events) if (e.type === "bita") discard.current.ids = [...discard.current.ids.filter((c) => !e.cards.includes(c)), ...e.cards];
  }
  const dealing = !p.readOnly && dealt.current !== view.game_id && view.moves === 0;
  useEffect(() => {
    dealt.current = view.game_id;
  });

  const reveal = view.mode === "spectate" || view.debug_reveal;
  const { targets, geo } = useMemo(
    () =>
      computeLayout({
        view,
        layout: geoLayout,
        W: dims.W,
        H: dims.H,
        sort: p.sort,
        reveal,
        discardIds: discard.current.ids,
        dealing,
        step: p.step,
        pending: p.pending,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view, geoLayout, dims.W, dims.H, p.sort, reveal, p.step, dealing, p.pending],
  );

  const legal = useMemo(() => new Set(p.canAct ? view.legal : []), [p.canAct, view.legal]);
  const hintMoves = useMemo(() => {
    const out = new Map<number, number | null>();
    if (p.hint.open && p.hint.data) for (const mv of p.hint.data.moves) out.set(mv.action, mv.win);
    return out;
  }, [p.hint]);
  const rec = p.hint.open && p.hint.data ? p.hint.data.recommended : null;

  const lastLand = useRef(0);
  const onLand = (tg: CardTarget, spawned: boolean) => {
    const now = performance.now();
    if (tg.zone === "table") p.onSound?.("snap");
    else if (spawned && now - lastLand.current > 45) {
      lastLand.current = now;
      p.onSound?.("deal");
    }
  };

  const fanCount = (seat: number) => targets.filter((x) => x.zone === "opp" && x.seat === seat).length;

  // the card you must beat (defending) + drop-slot preview (hover / drag)
  const open = view.table.find((x) => x.defense === null);
  const uncovered = view.phase === "defend" && open ? open.attack : null;
  const defending = p.canAct && uncovered !== null && p.pending == null;
  const target = defending ? targets.find((x) => x.card === uncovered) : undefined;
  const handTop = useMemo(() => {
    const hs = targets.filter((x) => x.zone === "hand");
    return hs.length ? Math.min(...hs.map((x) => x.y - (x.w * ASPECT) / 2)) : dims.H - 200;
  }, [targets, dims.H]);
  const handLeft = useMemo(() => {
    const hs = targets.filter((x) => x.zone === "hand");
    return hs.length ? Math.min(...hs.map((x) => x.x - x.w / 2)) : geo.cx - 400;
  }, [targets, geo.cx]);
  const canDrop = (x: number, y: number) => y < handTop - 6 && x > 0 && x < dims.W;
  const onDrag = (card: number | null, x?: number, y?: number) => {
    if (card === null) return setDrag(null);
    const hot = canDrop(x ?? 0, y ?? dims.H);
    setDrag((d) => (d && d.card === card && d.hot === hot ? d : { card, hot }));
  };
  const slotCard = p.pending != null || !p.canAct ? null : drag ? drag.card : hover !== null && legal.has(hover) ? hover : null;
  const slot = useMemo(() => {
    if (slotCard === null) return null;
    const r = computeLayout({ view, layout: geoLayout, W: dims.W, H: dims.H, sort: p.sort, reveal, discardIds: discard.current.ids, dealing: false, step: null, pending: slotCard });
    return r.targets.find((x) => x.card === slotCard) ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slotCard, view, geoLayout, dims.W, dims.H]);

  // persistent "Твой ход!" from the attacker when you must defend
  const yourMove: Bubble | null =
    defending && view.attacker !== bottom
      ? { seat: view.attacker, ru: "Твой ход!", en: lang === "en" ? t("d.say.yourMove") : "", tone: "say", key: -1 }
      : null;

  const m = geoLayout === "m";
  const prim = PRIMARY[p.primary.kind];
  const primLabel = t(`d.${p.primary.kind}`);
  const passWin = hintMoves.get(PASS);
  // ---- speech bubbles: anchors, HUD obstacles, queue
  const showEn = lang === "en";
  const anchors = useMemo(() => {
    const out: Record<number, Anchor> = {};
    for (const sg of Object.values(geo.seats))
      out[sg.seat] = { seat: sg, kind: m ? "row" : sg.side === "top" ? "top" : "side", rhs: sg.x + sg.w / 2 > geo.W / 2 + 4 };
    if (view.mode === "spectate") {
      const name = displayName(me, t, "mid");
      const pillW = m ? 3 + 26 + 6 + textWidth(name, `700 13px "Playfair Display", Georgia, serif`) + 6 + 70 + 10 : geo.bottom.w;
      out[bottom] = m ? { seat: { ...geo.bottom, w: pillW }, kind: "pill", rhs: false } : { seat: geo.bottom, kind: "side", rhs: false };
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geo, m, view.mode, bottom, me.persona, lang]);
  const obstacles = useMemo(() => {
    const o: Box[] = [];
    const W = geo.W;
    const H = geo.H;
    for (const a of Object.values(anchors)) o.push({ x: a.seat.x, y: a.seat.y, w: a.seat.w, h: a.seat.h });
    const tl = geo.talon;
    o.push(m ? { x: tl.x - 80, y: tl.y - 39, w: 153, h: 80 } : { x: tl.x - 62, y: tl.y - 67, w: 250, h: 190 });
    // the discard pile's place is reserved even while it is empty
    const bi = geo.bito;
    o.push(m ? { x: bi.x - 42, y: bi.y - 44, w: 126, h: 90 } : { x: bi.x - 80, y: bi.y - 84, w: 160, h: 210 });
    for (const tg of targets) {
      if (tg.zone !== "table" && tg.zone !== "hand") continue;
      const h = tg.w * ASPECT;
      const lift = tg.zone === "hand" ? 36 : 0;
      o.push({ x: tg.x - tg.w / 2 - 4, y: tg.y - h / 2 - 4 - lift, w: tg.w + 8, h: h + 8 + lift });
    }
    if (target && !m) o.push({ x: target.x - 70, y: target.y - (target.w * ASPECT) / 2 - 56, w: 140, h: 38 });
    o.push(m ? { x: 0, y: geo.ribbonY - 26, w: W, h: 70 } : { x: geo.cx - 400, y: geo.ribbonY - 30, w: 800, h: 92 });
    // top bar: the whole strip on phones; the brand pill and the tools on desktop
    if (m) o.push({ x: 0, y: 0, w: W, h: 54 });
    else o.push({ x: 50, y: 14, w: 350, h: 58 }, { x: W - 236, y: 14, w: 186, h: 58 });
    o.push(m ? { x: 0, y: H - 80, w: W, h: 80 } : { x: W - 340, y: H - 212, w: 300, h: 176 });
    o.push(m ? { x: 6, y: geo.talon.y - 18, w: 104, h: 36 } : { x: W - 160, y: 76, w: 120, h: 40 });
    return o;
  }, [geo, anchors, targets, target, m]);
  const placed = useBubbles({
    game: view.game_id,
    bubbles: p.bubbles,
    persistent: yourMove,
    place: (b, shown) => {
      const a = anchors[b.seat];
      if (!a) return null;
      return placeBubble(bubbleSize(b, m, showEn), a, obstacles, shown, geo.W, geo.H);
    },
    clear: (box) => !obstacles.some((o) => hit(box, o)),
  });

  const stageCls = `${p.canAct ? "my-turn" : ""} ${p.readOnly ? "is-readonly" : ""} ${drag ? "is-dragging" : ""}`;

  return (
    <>
      <Stage dims={dims} className={`table-stage table-under ${stageCls}`}>
      {/* opponents */}
      {view.players
        .filter((pl) => pl.seat !== bottom && geo.seats[pl.seat])
        .map((pl) => (
          <Seat
            key={pl.seat}
            p={pl}
            view={view}
            geo={geo}
            thinking={p.thinkingSeat === pl.seat}
            level={pl.bot ? p.levelOf(pl.bot) : undefined}
            win={view.mode === "spectate" ? p.seatWin?.[String(pl.seat)] : undefined}
            fanCount={fanCount(pl.seat)}
          />
        ))}

      {view.mode === "spectate" && !m && (
        <Seat
          p={me}
          view={view}
          geo={geo}
          sg={geo.bottom}
          thinking={p.thinkingSeat === bottom}
          level={me.bot ? p.levelOf(me.bot) : undefined}
          win={p.seatWin?.[String(bottom)]}
          fanCount={0}
        />
      )}
        {/* tutorial anchors */}
        <div className="tut-region tut-hand" style={{ left: geo.cx - (m ? 180 : 400), top: geo.handBottom - (m ? 150 : 230), width: m ? 360 : 800, height: m ? 160 : 230 }} />
        <div className="tut-region tut-table" style={{ left: geo.battle.x - (m ? 150 : 220), top: geo.battle.y - (m ? 100 : 130), width: m ? 300 : 440, height: m ? 200 : 260 }} />
      </Stage>

      {/* every card: screen px, outside the scaled stage */}
      <div className="cardlayer" style={{ width: dims.W * dims.s, height: dims.H * dims.s, "--s": dims.s } as CSSProperties}>
        <TalonBacks view={view} geo={geo} back={p.back} S={dims.s} />
        {targets.map((tg) => {
          const isHand = tg.zone === "hand" && tg.card !== null && !p.readOnly && view.mode === "play";
          const c = tg.card;
          const lg = isHand && c !== null && legal.has(c);
          const hw = c !== null ? hintMoves.get(c) : undefined;
          return (
            <FlyCard
              key={tg.key}
              t={tg}
              S={dims.s}
              hires={hires}
              speed={p.speed}
              back={p.back}
              four={p.four}
              settle={settle}
              onLand={onLand}
              legal={lg}
              dim={isHand && p.canAct && !lg}
              hint={isHand && rec !== null && c === rec}
              selected={isHand && c === p.selected}
              onPlay={p.onPlay}
              onHover={isHand ? setHover : undefined}
              onDrag={lg ? onDrag : undefined}
              canDrop={canDrop}
              badge={lg && hw !== undefined && hw !== null ? <span className={`fc__pct ${c === rec ? "is-rec" : ""}`}>{Math.round(hw * 100)}%</span> : undefined}
              tabIndex={lg ? 0 : -1}
              extraClass={target && c === uncovered ? (drag?.hot ? "is-target is-hot" : "is-target") : undefined}
            />
          );
        })}
      </div>


      <Stage dims={dims} className={`table-stage table-over ${stageCls}`}>
      {/* top bar */}
      {!p.readOnly && (
        <header className="topbar">
          <button type="button" className="brand" onClick={p.topbar.onHome} aria-label={t("d.title")} data-testid="home">
            <span className="brand__back">
              <Icon name="back" />
            </span>
            <span className="brand__word">ДУРАК</span>
            <span className="brand__meta">
              {view.mode === "spectate" ? t("d.watching") : t("d.podkidnoy")} · {t("d.round", { n: view.bout + 1 })}
            </span>
          </button>
          <div className="tools">
            <button type="button" className="ibtn" onClick={p.topbar.onLog} aria-label={t("d.logTitle")} title={`${t("d.logTitle")} (L)`} data-testid="log-btn">
              <Icon name="log" />
              {p.topbar.logDot && <span className="dot" />}
            </button>
            <button
              type="button"
              className={`ibtn ${p.topbar.sound ? "" : "is-off"}`}
              onClick={p.topbar.onSound}
              aria-label={p.topbar.sound ? t("nav.mute") : t("nav.unmute")}
              aria-pressed={!p.topbar.sound}
              data-testid="mute"
            >
              <Icon name={p.topbar.sound ? "sound" : "mute"} />
            </button>
            <button type="button" className="ibtn" onClick={p.topbar.onSettings} aria-label={t("nav.settings")} data-testid="settings">
              <Icon name="gear" />
            </button>
          </div>
        </header>
      )}

      {/* speech bubbles: each next to its own place-card, never over the HUD */}
      {placed.map((pl) => (
        <div
          key={pl.b.key}
          className={`bubble bubble--${pl.b.tone} bubble--tail-${pl.tail} ${pl.tail !== "left" && pl.tailAt > pl.box.w / 2 ? "is-tail-r" : ""} ${m ? "bubble--m" : ""} ${pl.b.key >= 0 ? "is-fading" : "is-sticky"}`}
          style={{ left: pl.box.x, top: pl.box.y, width: pl.box.w, height: pl.box.h, "--tail": `${pl.tailAt}px` } as CSSProperties}
          data-seat={pl.b.seat}
          data-testid="bubble"
          role="status"
        >
          <span className="bubble__ru" lang="ru">
            {pl.b.ru}
          </span>
          {showEn && pl.b.en && <span className="bubble__en">{pl.b.en}</span>}
        </div>
      ))}
      {view.mode === "spectate" && m && (
        <div className={`seatpill ${me.to_move && !view.done ? "to-move" : ""}`} style={{ left: geo.bottom.x, top: geo.bottom.y }} data-seat={bottom}>
          <Medal persona={me.persona} size={26} />
          <b>{displayName(me, t, "mid")}</b>
          <Tag p={me} view={view} short />
        </div>
      )}
      <TalonInfo view={view} geo={geo} />
      {view.discard_count > 0 && <Bito view={view} geo={geo} />}

      {/* beat-this tag + drop-slot preview */}
      {target && (
        <span
          className={`beatme ${m ? "beatme--m" : ""} ${drag ? "is-big" : ""}`}
          style={{ left: target.x, top: m ? target.y + (target.w * ASPECT) / 2 - 8 : target.y - (target.w * ASPECT) / 2 - 20 }}
        >
          {t("d.beatThis")}
        </span>
      )}
      {slot && (
        <div
          className={`dropslot ${drag ? "is-drag" : ""} ${drag?.hot ? "is-hot" : ""}`}
          style={{
            left: slot.x - slot.w / 2,
            top: slot.y - (slot.w * ASPECT) / 2,
            width: slot.w,
            height: slot.w * ASPECT,
            transform: `rotate(${slot.rot}deg)`,
          }}
          data-testid="dropslot"
        >
          <span>
            {uncovered !== null ? t("d.beatWith") : view.table.length ? t("d.throwHere") : t("d.leadHere")}
            <br />
            <CardRef c={slotCard!} />
          </span>
        </div>
      )}

      {/* status ribbon + sub line / coach tip */}
      <div className={`status ${m ? "status--m" : ""}`} style={{ top: geo.ribbonY }} data-testid="status">
        <div className={`ribbon ribbon--${p.ribbon.tone === "you" ? "you" : p.ribbon.tone === "good" ? "green" : p.ribbon.tone === "over" ? "over" : "calm"}`}>
          <span>{p.ribbon.main}</span>
        </div>
        {p.hint.open ? (
          <div className="hinttip" role="status" data-testid="hint-panel">
            {p.hint.loading || !p.hint.data ? (
              <span className="hinttip__load">
                <span className="spin" /> {t("hint.loading")}
              </span>
            ) : (
              <>
                <b>{t("d.coach")}</b>{" "}
                {p.hint.data.recommended === PASS ? (
                  t("d.coachPass", { label: primLabel })
                ) : (
                  <>
                    {t("d.coachPlay", { card: "" }).replace(/\s*$/, "")} <CardRef c={p.hint.data.recommended} />
                  </>
                )}
                {p.hint.data.has_values ? (
                  <span className="hinttip__why">
                    {" · "}
                    {t("d.coachWhy", { p: Math.round((p.hint.data.moves.find((x) => x.action === p.hint.data!.recommended)?.win ?? 0) * 100) })}
                    {p.hint.data.exact ? ` · ${t("d.coachExact")}` : ""}
                  </span>
                ) : (
                  <span className="hinttip__why"> · {t("d.coachNone")}</span>
                )}
                <button type="button" className="hinttip__play" onClick={() => p.onPlay(p.hint.data!.recommended)} data-testid="hint-play">
                  {t("d.playIt")}
                </button>
                <button type="button" className="hinttip__x" onClick={p.onHintClose} aria-label={t("hint.close")}>
                  <Icon name="close" />
                </button>
              </>
            )}
          </div>
        ) : (
          p.ribbon.sub && !(m && view.mode === "spectate" && !p.readOnly) && <div className="status__sub">{p.ribbon.sub}</div>
        )}
      </div>

      {/* sort + skip */}
      {!p.readOnly && view.mode === "play" && me.hand && me.hand.length > 1 && (
        <button
          type="button"
          className="ibtn ibtn--sm sortbtn"
          style={m ? { left: 6, top: geo.ribbonY - 70 } : { left: Math.max(geo.cx - 560, handLeft - 58), top: dims.H - 70 }}
          onClick={p.onSort}
          aria-label={t(p.sort === "suit" ? "d.sortSuit" : "d.sortRank")}
          title={t(p.sort === "suit" ? "d.sortSuit" : "d.sortRank")}
        >
          <Icon name="sort" />
        </button>
      )}
      {p.busy && p.onSkip && p.speed > 0 && (
        <button type="button" className="skipbtn" onClick={p.onSkip} style={m ? { left: 8, top: geo.talon.y - 16 } : { right: 40, top: 80 }}>
          {t("d.skip")} <Icon name="ff" />
        </button>
      )}

      {/* bottom actions */}
      {!p.readOnly && (
        <section className={`actions ${m ? "actions--m" : ""} ${p.spectate ? "actions--spect" : ""}`}>
          {p.spectate ? (
            <>
              <button type="button" className="btn-primary is-cobalt spect__main" onClick={p.spectate.toggle} disabled={p.spectate.done}>
                <Icon name={p.spectate.auto ? "pause" : "play"} />
                <span>{p.spectate.auto ? t("d.pause") : t("d.resume")}</span>
              </button>
              <button type="button" className="btn" onClick={p.spectate.step} disabled={p.spectate.done || p.spectate.busy || p.spectate.auto}>
                <Icon name="step" />
                {t("d.step")}
              </button>
              <button type="button" className="btn" onClick={p.spectate.end} disabled={p.spectate.done} data-testid="to-end">
                <Icon name="ff" />
                {t("d.toEnd")}
              </button>
            </>
          ) : (
            <>
              <TeaMeter p={p.winProb} />
              {p.onHint && (
                <button
                  type="button"
                  className={`btn btn--cobalt hint ${p.hint.open ? "is-on" : ""}`}
                  onClick={p.onHint}
                  disabled={!p.canAct}
                  data-testid="hint"
                  title={`${t("d.hint")} (H)`}
                >
                  <Icon name="hint" />
                  <span>{t("d.hint")}</span>
                </button>
              )}
              <button
                type="button"
                className={`btn-primary take ${prim.cls} ${rec === PASS ? "is-hint" : ""}`}
                onClick={p.primary.onClick}
                disabled={!p.primary.enabled}
                data-testid={p.primary.kind === "again" ? "again" : "pass"}
                data-kind={p.primary.kind}
              >
                {prim.icon && <Icon name={prim.icon} />}
                <span>{primLabel}</span>
                {prim.ru && lang === "en" && <span className="sub">{prim.ru}</span>}
                {!m && p.primary.enabled && <kbd>Space</kbd>}
                {passWin !== undefined && passWin !== null && <span className="fc__pct is-btn">{Math.round(passWin * 100)}%</span>}
              </button>
            </>
          )}
        </section>
      )}

      {p.children}

      {/* move log: a squared school notebook */}
      <aside className={`log ${p.logOpen ? "is-open" : ""}`} aria-label={t("d.logTitle")} aria-hidden={!p.logOpen}>
        <div className="log__paper">
          <header className="log__head">
            <h2 className="display">{t("d.logTitle")}</h2>
            <button type="button" className="ibtn ibtn--sm" onClick={p.onLogClose} aria-label={t("a11y.close")}>
              <Icon name="close" />
            </button>
          </header>
          {p.logNode}
        </div>
      </aside>
    </Stage>
    </>
  );
}
