// Dacha paper sheets: the dialog shell plus settings, stats, rules, game
// over (with the durak moment), the full-screen reveal and the tutorial.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { api, type GameState, type StatsResponse } from "../api";
import { RANKS, rankOf, suitOf } from "../cards";
import { Rich, ordinal, useI18n } from "../i18n";
import type { Prefs, Speed } from "../prefs";
import { BACKS, FELTS, FELT_HEX, backSrc, dropSrcSet, faceUrl, illustrationUrl, propUrl } from "./art";
import { Icon, Suit } from "./Icons";
import { displayName } from "./names";
import { Medal } from "./Scene";

/** Accessible modal sheet rendered into <body>: traps Tab, closes on backdrop. */
export function Sheet({
  title,
  ru,
  onClose,
  children,
  wide,
  className = "",
  testid,
  label,
}: {
  title: ReactNode;
  ru?: string;
  onClose?: () => void;
  children: ReactNode;
  wide?: boolean;
  className?: string;
  testid?: string;
  label?: string;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const prev = document.activeElement as HTMLElement | null;
    const first =
      el.querySelector<HTMLElement>("[autofocus]") ?? el.querySelector<HTMLElement>(".btn-primary:not([disabled])") ?? el.querySelector<HTMLElement>("button, select, input");
    (first ?? el).focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const f = Array.from(el.querySelectorAll<HTMLElement>("button:not([disabled]), select, input, a[href], [tabindex='0']"));
      if (!f.length) return;
      const i = f.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey && i <= 0) {
        e.preventDefault();
        f[f.length - 1].focus();
      } else if (!e.shiftKey && i === f.length - 1) {
        e.preventDefault();
        f[0].focus();
      }
    };
    el.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("keydown", onKey);
      prev?.focus?.({ preventScroll: true });
    };
  }, []);
  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div
        className={`sheet ${wide ? "sheet--wide" : ""} ${className}`}
        role="dialog"
        aria-modal="true"
        aria-label={label ?? (typeof title === "string" ? title : undefined)}
        ref={ref}
        tabIndex={-1}
        data-testid={testid}
      >
        <header className="sheet__head">
          <div>
            {ru && (
              <span className="ru" lang="ru">
                {ru}
              </span>
            )}
            <h2>{title}</h2>
          </div>
          {onClose && (
            <button type="button" className="ibtn ibtn--sm" onClick={onClose} aria-label={t("a11y.close")} title={`${t("a11y.close")} (Esc)`} data-testid="sheet-close">
              <Icon name="close" />
            </button>
          )}
        </header>
        <div className="sheet__body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

// ------------------------------------------------------------------ settings
const SPEEDS: Speed[] = ["slow", "normal", "fast", "instant"];

export function SettingsSheet({
  prefs,
  setPrefs,
  onClose,
  onTutorial,
  evalAvailable,
  debug,
}: {
  prefs: Prefs;
  setPrefs: (f: (p: Prefs) => Prefs) => void;
  onClose: () => void;
  onTutorial: () => void;
  evalAvailable: boolean;
  debug?: { on: boolean; toggle: () => void };
}) {
  const { t } = useI18n();
  const set = (patch: Partial<Prefs>) => setPrefs((p) => ({ ...p, ...patch }));
  return (
    <Sheet title={t("settings.title")} ru="Настройки" onClose={onClose} className="settings-sheet" testid="settings-sheet">
      <div className="field">
        <span className="field__label">{t("settings.language")}</span>
        <div className="chips">
          {(["en", "ru"] as const).map((l) => (
            <button type="button" key={l} className="chip" aria-pressed={prefs.lang === l} onClick={() => set({ lang: l })} data-lang={l}>
              {l === "en" ? "English" : "Русский"}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <span className="field__label">{t("nav.speed")}</span>
        <div className="chips">
          {SPEEDS.map((sp) => (
            <button type="button" key={sp} className="chip" aria-pressed={prefs.speed === sp} onClick={() => set({ speed: sp })} data-speed={sp}>
              {t(`speed.${sp}`)}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <span className="field__label">{t("settings.theme")}</span>
        <div className="swatches">
          {FELTS.map((f) => (
            <button
              type="button"
              key={f}
              className={`swatch ${prefs.theme === f ? "is-on" : ""}`}
              aria-pressed={prefs.theme === f}
              onClick={() => set({ theme: f })}
              data-theme-choice={f}
            >
              <span className="swatch__felt" style={{ "--felt": FELT_HEX[f] } as CSSProperties} />
              <span className="swatch__name">{t(`d.felt.${f}`)}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <span className="field__label">{t("settings.back")}</span>
        <div className="swatches swatches--backs">
          {BACKS.map((b) => (
            <button type="button" key={b} className={`swatch ${prefs.back === b ? "is-on" : ""}`} aria-pressed={prefs.back === b} onClick={() => set({ back: b })} data-back-choice={b}>
              <img className="swatch__back" {...backSrc(b)} sizes="52px" alt="" onError={dropSrcSet} />
              <span className="swatch__name">{t(`d.back.${b}`)}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <label className="check">
          <input type="checkbox" checked={prefs.fourColor} onChange={(e) => set({ fourColor: e.target.checked })} data-testid="four-color" />
          <span>
            {t("settings.fourColor")} <span className="muted">— {t("settings.fourColorHint")}</span>
          </span>
        </label>
        <div className="four-preview" aria-hidden="true">
          {[2, 11, 20, 29].map((c) => (
            <img key={c} src={faceUrl(c, prefs.fourColor, true)} alt="" />
          ))}
        </div>
        <label className="check">
          <input type="checkbox" checked={prefs.sound} onChange={(e) => set({ sound: e.target.checked })} /> {t("settings.sound")}
        </label>
        {evalAvailable && (
          <label className="check">
            <input type="checkbox" checked={prefs.showWinProb} onChange={(e) => set({ showWinProb: e.target.checked })} /> {t("nav.winpct")} — {t("hint.win")}
          </label>
        )}
        {debug && (
          <label className="check">
            <input type="checkbox" checked={debug.on} onChange={debug.toggle} data-testid="debug-toggle" /> {t("new.debug")}
          </label>
        )}
      </div>
      <div className="sheet__actions">
        <button type="button" className="btn" onClick={onTutorial}>
          <Icon name="rules" />
          {t("settings.tutorial")}
        </button>
        <button type="button" className="btn-primary btn-primary--sm" onClick={onClose}>
          OK
        </button>
      </div>
    </Sheet>
  );
}

// --------------------------------------------------------------------- stats
const pct = (x: number | null | undefined) => (x === null || x === undefined ? "—" : `${(x * 100).toFixed(1)}%`);

export function StatsSheet({ onClose, botLabelOf }: { onClose: () => void; botLabelOf: (n: string) => string }) {
  const { t } = useI18n();
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.stats().then(setStats, (e) => setErr(String(e)));
  }, []);
  const safe = stats ? stats.human_safe ?? stats.human_games - stats.human_durak : 0;
  return (
    <Sheet title={t("stats.title")} ru="Статистика" onClose={onClose} wide className="stats-sheet" testid="stats-sheet">
      {err && <div className="error">{err}</div>}
      {!stats && !err && (
        <div className="loading">
          <span className="spin" /> {t("loading")}
        </div>
      )}
      {stats && (
        <>
          <ul className="tiles">
            <li>
              <b>{stats.human_games}</b>
              <span>{t("d.recGames")}</span>
            </li>
            <li className="is-good">
              <b>{safe}</b>
              <span>{t("d.recWins")}</span>
            </li>
            <li className="is-fool">
              <b>{stats.human_durak}×</b>
              <span>{t("d.recFool")}</span>
            </li>
            <li>
              <b>{pct(stats.human_durak_rate)}</b>
              <span>{t("stats.durakRate")}</span>
            </li>
            <li>
              <b>{stats.streak_best ?? 0}</b>
              <span>{t("d.recStreak")}</span>
            </li>
            <li>
              <b>{stats.spectated_games}</b>
              <span>{t("stats.botGames")}</span>
            </li>
          </ul>
          <h3>{t("stats.byN")}</h3>
          {stats.by_players.length === 0 ? (
            <p className="muted">{t("stats.none")}</p>
          ) : (
            <div className="table-wrap">
              <table className="ledger">
                <thead>
                  <tr>
                    <th>{t("stats.players")}</th>
                    <th>{t("stats.gamesCol")}</th>
                    <th>{t("stats.durak")}</th>
                    <th>{t("stats.rate")}</th>
                    <th>{t("stats.fair")}</th>
                    <th>{t("stats.place")}</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.by_players.map((r) => (
                    <tr key={r.num_players}>
                      <td>{r.num_players}</td>
                      <td>{r.games}</td>
                      <td>{r.human_durak}</td>
                      <td className={r.human_durak_rate !== null && r.human_durak_rate > r.expected_durak_rate ? "bad" : "good"}>{pct(r.human_durak_rate)}</td>
                      <td className="muted">{pct(r.expected_durak_rate)}</td>
                      <td>{r.avg_place ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h3>{t("stats.byBot")}</h3>
          {stats.by_bot.length === 0 ? (
            <p className="muted">{t("stats.none")}</p>
          ) : (
            <div className="table-wrap">
              <table className="ledger">
                <thead>
                  <tr>
                    <th>{t("stats.bot")}</th>
                    <th>{t("stats.seats")}</th>
                    <th>{t("stats.botDurak")}</th>
                    <th>{t("stats.fair")}</th>
                    <th>{t("stats.vsYou")}</th>
                    <th>{t("stats.youDurak")}</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.by_bot.map((r) => (
                    <tr key={r.bot}>
                      <td>
                        <span className="bot-tag">{botLabelOf(r.bot)}</span>
                      </td>
                      <td>{r.seats}</td>
                      <td className={r.durak_rate !== null && r.expected_durak_rate !== null && r.durak_rate < r.expected_durak_rate ? "good" : ""}>{pct(r.durak_rate)}</td>
                      <td className="muted">{pct(r.expected_durak_rate)}</td>
                      <td>{r.human_games}</td>
                      <td>{pct(r.human_durak_rate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="note">{t("stats.fairNote")}</p>
          {stats.recent.length > 0 && (
            <>
              <h3>{t("stats.recent")}</h3>
              <div className="table-wrap">
                <table className="ledger">
                  <thead>
                    <tr>
                      <th>{t("stats.date")}</th>
                      <th>N</th>
                      <th>{t("stats.seats")}</th>
                      <th>{t("stats.result")}</th>
                      <th>{t("stats.moves")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.recent.map((r) => (
                      <tr key={r.id}>
                        <td className="muted">{new Date(r.date).toLocaleString()}</td>
                        <td>{r.num_players}</td>
                        <td className="seats-cell">
                          {r.seats.map((x, i) => (
                            <span key={i} className={`mini-tag ${i === r.loser ? "is-durak" : ""}`}>
                              {x === "human" ? t("stats.you") : botLabelOf(x)}
                            </span>
                          ))}
                        </td>
                        <td>
                          {r.loser === null
                            ? r.end_reason === "stalemate"
                              ? t("stats.stalemateShort")
                              : t("stats.drawShort")
                            : r.mode === "spectate"
                              ? t("stats.seatDurak", { s: r.loser + 1 })
                              : r.human_result === "durak"
                                ? t("stats.youDurakShort")
                                : t("stats.youPlace", { p: r.human_place ?? "" })}
                          {r.debug_used ? <span className="mini-tag">debug</span> : null}
                        </td>
                        <td>{r.moves}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </Sheet>
  );
}

// --------------------------------------------------------------------- rules
export function RulesSheet({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Sheet title={t("rules.title")} ru="Правила" onClose={onClose} wide className="rules-sheet" testid="rules-sheet">
      <div className="rules-grid">
        <section>
          <h3>{t("rules.goal")}</h3>
          <p>
            <Rich text={t("rules.goalText")} />
          </p>
          <h3>{t("rules.bout")}</h3>
          <p>
            <Rich text={t("rules.boutText1")} />
          </p>
          <p>
            <Rich text={t("rules.boutText2")} />
          </p>
        </section>
        <section>
          <h3>{t("rules.ending")}</h3>
          <ul>
            <li>
              <Rich text={t("rules.bitaText")} />
            </li>
            <li>
              <Rich text={t("rules.takeText")} />
            </li>
          </ul>
          <p>{t("rules.drawText")}</p>
          <h3>{t("rules.play")}</h3>
          <p>
            <Rich text={t("rules.playText")} />
          </p>
          <h3>{t("rules.keys")}</h3>
          <ul className="keys">
            <li>
              <kbd>1</kbd>–<kbd>9</kbd> {t("rules.k1")}
            </li>
            <li>
              <kbd>←</kbd> <kbd>→</kbd> <Rich text={t("rules.k2")} />
            </li>
            <li>
              <kbd>Space</kbd> {t("rules.k3")}
            </li>
            <li>
              <kbd>H</kbd> {t("rules.k4")}
            </li>
            <li>
              <kbd>N</kbd> <Rich text={t("rules.k5")} />
            </li>
          </ul>
        </section>
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------------------ game over
export function GameOverSheet({
  state,
  onAgain,
  onLobby,
  onClose,
  onAnalyze,
  levelOf,
}: {
  state: GameState;
  onAgain: () => void;
  onLobby: () => void;
  onClose: () => void;
  onAnalyze?: () => void;
  levelOf: (bot: string) => string;
}) {
  const { t, lang } = useI18n();
  const res = state.result;
  const loser = state.loser;
  const durak = loser !== null ? state.players[loser] : null;
  const human = state.human_seat !== null ? state.players[state.human_seat] : null;
  let headline: string;
  let tone: "lose" | "win" | "draw" | "watch";
  let sub: string | null = null;
  if (!res || res.draw) {
    headline = res?.reason === "stalemate" ? t("over.stalemate") : t("over.draw");
    if (res?.reason === "stalemate") sub = t("over.stalemateSub", { n: 30 });
    tone = "draw";
  } else if (human && res.human === "durak") {
    headline = t("over.lose");
    tone = "lose";
  } else if (human) {
    headline = res.place === 1 ? t("over.first") : t("over.escaped", { p: res.place ?? "" });
    tone = "win";
  } else {
    headline = t("over.botDurak", { name: durak ? displayName(durak, t) : "" });
    tone = "watch";
  }
  const order = [...state.finished, ...(loser !== null ? [loser] : [])];
  const rest = state.players.filter((p) => !order.includes(p.seat)).map((p) => p.seat);
  const art = tone === "lose" ? illustrationUrl("durak", lang) : tone === "win" ? illustrationUrl("safe", lang) : null;
  return (
    <Sheet title={t("over.title")} ru="Конец игры" onClose={onClose} className={`over over--${tone}`} label={headline}>
      <div className="over__hero" data-testid="game-over" data-reason={res?.reason ?? ""}>
        {art ? (
          <img className="over__art" src={art} alt="" />
        ) : durak ? (
          <div className="over__durak">
            <Medal persona={durak.persona} size={132} me={durak.is_human ? "Я" : undefined}>
              <img className="medal__cap" src={propUrl("cap")} alt="" />
            </Medal>
            <span className="over__stamp" lang="ru">
              ДУРАК
            </span>
          </div>
        ) : (
          <div className="over__draw" aria-hidden="true">
            <Icon name="laurel" />
          </div>
        )}
        <h3 className="over__headline">{headline}</h3>
        {sub && <p className="over__sub">{sub}</p>}
      </div>
      <div className="over__order">
        <span className="field__label">{t("d.order")}</span>
        <ol>
          {[...order, ...rest].map((seat, i) => {
            const p = state.players[seat];
            const isDurak = seat === loser;
            return (
              <li key={seat} className={`${isDurak ? "is-durak" : ""} ${p.is_human ? "is-you" : ""}`}>
                <span className="over__place">{isDurak ? "Д" : rest.includes(seat) ? "=" : ordinal(i + 1, lang)}</span>
                <Medal persona={p.is_human ? null : p.persona} size={34} />
                <span className="over__name">{displayName(p, t)}</span>
                {p.bot && <span className="mini-tag">{levelOf(p.bot)}</span>}
              </li>
            );
          })}
        </ol>
      </div>
      <p className="over__meta">
        {t("over.meta", { n: state.num_players, m: state.moves })}
        {state.seed != null ? ` · ${t("over.seed", { s: state.seed })}` : ""}
      </p>
      <div className="sheet__actions">
        <button type="button" className="btn" onClick={onLobby} data-testid="over-lobby">
          <Icon name="users" />
          {t("d.newGame")}
        </button>
        {onAnalyze && (
          <button type="button" className="btn" onClick={onAnalyze} data-testid="analyze">
            <Icon name="replay" />
            {t("over.analyze")}
          </button>
        )}
        <button type="button" className="btn-primary btn-primary--sm" onClick={onAgain} data-testid="play-again" autoFocus>
          <Icon name="play" />
          {t("over.again")}
        </button>
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------- the durak moment
export function DurakReveal({ lose, onDone }: { lose: boolean; onDone: () => void }) {
  const { t, lang } = useI18n();
  useEffect(() => {
    const id = setTimeout(onDone, lose ? 2800 : 2000);
    return () => clearTimeout(id);
  }, [lose, onDone]);
  return createPortal(
    <div className={`reveal ${lose ? "reveal--lose" : "reveal--win"}`} onClick={onDone} role="alert" data-testid="reveal">
      <img className="reveal__art" src={illustrationUrl(lose ? "durak" : "safe", lang)} alt={lose ? "ДУРАК!" : t("reveal.sub.win")} />
      <div className="reveal__sub">{lose ? t("reveal.sub.lose") : t("reveal.sub.win")}</div>
      <div className="reveal__tap">{t("reveal.tap")}</div>
    </div>,
    document.body,
  );
}

// --------------------------------------------------------------- tutorial
const TUT_STEPS = [
  { sel: ".tut-hand", key: "hand" },
  { sel: ".tut-table", key: "table" },
  { sel: ".talon", key: "talon" },
  { sel: ".seat", key: "opps" },
  { sel: ".actions", key: "actions" },
];

export function Tutorial({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const step = TUT_STEPS[i];
  useLayoutEffect(() => {
    const upd = () => {
      const el = document.querySelector(step.sel);
      setRect(el ? el.getBoundingClientRect() : null);
    };
    upd();
    window.addEventListener("resize", upd);
    return () => window.removeEventListener("resize", upd);
  }, [step.sel]);
  const last = i === TUT_STEPS.length - 1;
  const pad = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const tw = Math.min(340, vw - 24);
  let tipStyle: CSSProperties = { left: vw / 2 - tw / 2, top: vh / 2 - 90, width: tw };
  if (rect) {
    const below = rect.bottom + 200 < vh;
    const left = Math.max(12, Math.min(vw - tw - 12, rect.left + rect.width / 2 - tw / 2));
    tipStyle = below ? { left, top: rect.bottom + pad + 12, width: tw } : { left, top: Math.max(12, rect.top - pad - 12 - 190), width: tw };
  }
  return createPortal(
    <div className="tutorial" role="dialog" aria-modal="true" aria-label={t(`tut.${step.key}.t`)} data-testid="tutorial">
      {rect && <div className="tut-spot" style={{ left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }} />}
      <div className="tut-tip" style={tipStyle}>
        <div className="tut-count">
          {i + 1} / {TUT_STEPS.length}
        </div>
        <h3>{t(`tut.${step.key}.t`)}</h3>
        <p>
          <Rich text={t(`tut.${step.key}.b`)} />
        </p>
        <div className="tut-actions">
          <button type="button" className="btn btn--sm" onClick={onDone}>
            {t("tut.skip")}
          </button>
          <button type="button" className="btn btn--sm btn--cobalt" autoFocus onClick={() => (last ? onDone() : setI(i + 1))} data-testid="tut-next">
            {last ? t("tut.done") : t("tut.next")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Inline card chip for rich text (8♦). */
export function CardChip({ c }: { c: number }) {
  return (
    <b className="cref">
      {RANKS[rankOf(c)]}
      <Suit s={suitOf(c)} />
    </b>
  );
}
