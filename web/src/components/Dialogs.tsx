import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, type BotInfo, type BotsResponse, type GameState, type StatsResponse } from "../api";
import { Rich, useI18n, type Lang } from "../i18n";
import { BACKS, THEMES, type Prefs } from "../prefs";
import { Avatar } from "./Avatar";
import { displayName } from "./Board";
import { Card, CardBack, SuitIcon } from "./Card";

export interface Settings {
  numPlayers: number;
  seat: number | "random";
  bot: string;
  perSeat: boolean;
  seatBots: string[];
  seed: string;
  spectate: boolean;
  debug: boolean;
}

/** Accessible modal: focuses itself, traps Tab, closes on backdrop click. */
export function Modal({
  title,
  onClose,
  children,
  wide,
  className = "",
}: {
  title: ReactNode;
  onClose?: () => void;
  children: ReactNode;
  wide?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const prev = document.activeElement as HTMLElement | null;
    const first =
      el.querySelector<HTMLElement>("[autofocus]") ?? el.querySelector<HTMLElement>("button.primary:not([disabled])") ?? el.querySelector<HTMLElement>("button, select, input");
    (first ?? el).focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const f = Array.from(el.querySelectorAll<HTMLElement>("button:not([disabled]), select, input, [tabindex='0']"));
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
      prev?.focus?.();
    };
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal ${wide ? "wide" : ""} ${className}`} role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined} ref={ref} tabIndex={-1}>
        <div className="modal-head">
          <h2>{title}</h2>
          {onClose && (
            <button type="button" className="icon-btn" onClick={onClose} aria-label={t("a11y.close")} title={`${t("a11y.close")} (Esc)`}>
              ✕
            </button>
          )}
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function Stars({ tier }: { tier: number | null }) {
  const { t } = useI18n();
  if (tier === null || tier === undefined) return null;
  return (
    <span className="stars" aria-label={t("bot.tier", { t: tier })} title={t("bot.tier", { t: tier })}>
      {Array.from({ length: 5 }, (_, i) => (
        <i key={i} className={i < tier ? "on" : ""}>
          ★
        </i>
      ))}
    </span>
  );
}

export const botLabel = (b: BotInfo | undefined, name: string, lang: Lang) => (b ? b.labels?.[lang] ?? b.label : name);

export function NewGameDialog({
  bots,
  initial,
  onStart,
  onClose,
}: {
  bots: BotsResponse | null;
  initial: Settings;
  onStart: (s: Settings) => void;
  onClose?: () => void;
}) {
  const { t, lang } = useI18n();
  const [s, setS] = useState<Settings>(initial);
  const list = bots?.bots ?? [];
  const n = s.numPlayers;
  const set = (patch: Partial<Settings>) => setS((prev) => ({ ...prev, ...patch }));
  const seatBots = Array.from({ length: n }, (_, i) => s.seatBots[i] ?? s.bot);
  const seatValid = s.seat === "random" || s.seat < n;

  return (
    <Modal title={t("new.title")} onClose={onClose} className="newgame" wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onStart({ ...s, seat: seatValid ? s.seat : 0, seatBots });
        }}
      >
        <div className="newgame-grid">
          <div>
            <div className="field">
              <label>{t("new.mode")}</label>
              <div className="seg">
                <button type="button" className={!s.spectate ? "on" : ""} onClick={() => set({ spectate: false })} aria-pressed={!s.spectate}>
                  {t("new.play")}
                </button>
                <button type="button" className={s.spectate ? "on" : ""} onClick={() => set({ spectate: true })} aria-pressed={s.spectate}>
                  {t("new.watch")}
                </button>
              </div>
            </div>
            <div className="field">
              <label>{t("new.players")}</label>
              <div className="seg" role="group" aria-label={t("new.players")}>
                {[2, 3, 4, 5, 6].map((k) => (
                  <button type="button" key={k} className={n === k ? "on" : ""} onClick={() => set({ numPlayers: k })} aria-pressed={n === k} data-players={k}>
                    {k}
                  </button>
                ))}
              </div>
              <div className="hint">{s.spectate ? t("new.bots", { n }) : t("new.youPlus", { k: n - 1 })}</div>
            </div>
            {!s.spectate && (
              <div className="field">
                <label htmlFor="seat">{t("new.seat")}</label>
                <select id="seat" value={String(seatValid ? s.seat : 0)} onChange={(e) => set({ seat: e.target.value === "random" ? "random" : Number(e.target.value) })}>
                  <option value="random">{t("new.random")}</option>
                  {Array.from({ length: n }, (_, i) => (
                    <option key={i} value={i}>
                      {t("new.seatN", { n: i + 1 })}
                    </option>
                  ))}
                </select>
                <div className="hint">{t("new.seatHint")}</div>
              </div>
            )}
            <div className="field row2">
              <div>
                <label htmlFor="seed">{t("new.seed")}</label>
                <input id="seed" inputMode="numeric" placeholder={t("new.seedPh")} value={s.seed} onChange={(e) => set({ seed: e.target.value.replace(/[^0-9]/g, "") })} />
              </div>
              {!s.spectate && (
                <label className="check debug-check">
                  <input type="checkbox" checked={s.debug} onChange={(e) => set({ debug: e.target.checked })} /> {t("new.debug")}
                </label>
              )}
            </div>
          </div>
          <div>
            <div className="field">
              <label id="opp-label">{t("new.opponent")}</label>
              <div className="bot-grid" role="radiogroup" aria-labelledby="opp-label">
                {list.map((b) => (
                  <button
                    type="button"
                    key={b.name}
                    role="radio"
                    aria-checked={s.bot === b.name}
                    className={`bot-card ${s.bot === b.name ? "on" : ""}`}
                    onClick={() => set({ bot: b.name, seatBots: [] })}
                    data-bot={b.name}
                  >
                    <div className="bot-card-top">
                      <b>{botLabel(b, b.name, lang)}</b>
                      <Stars tier={b.tier} />
                    </div>
                    <div className="bot-desc">{b.desc?.[lang] ?? ""}</div>
                    <div className="bot-meta">
                      {b.name === bots?.default && <span className="mini-tag gold">{t("new.strongest")}</span>}
                      {b.elo !== null && b.elo !== undefined && <span className="mini-tag">{t("new.elo", { e: b.elo })}</span>}
                    </div>
                  </button>
                ))}
              </div>
              <label className="check">
                <input type="checkbox" checked={s.perSeat} onChange={(e) => set({ perSeat: e.target.checked })} /> {t("new.perSeat")}
              </label>
            </div>
            {s.perSeat && (
              <div className="field seats">
                <label>{t("new.seats")}</label>
                <div className="seat-grid">
                  {seatBots.map((b, i) => {
                    const isHuman = !s.spectate && seatValid && s.seat === i;
                    return (
                      <div key={i} className="seat-row">
                        <span>{t("new.seatN", { n: i + 1 })}</span>
                        {isHuman ? (
                          <span className="you">{t("role.you")}</span>
                        ) : (
                          <select
                            value={b}
                            aria-label={t("new.seatN", { n: i + 1 })}
                            onChange={(e) => {
                              const next = [...seatBots];
                              next[i] = e.target.value;
                              set({ seatBots: next });
                            }}
                          >
                            {list.map((x) => (
                              <option key={x.name} value={x.name}>
                                {botLabel(x, x.name, lang)}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="modal-actions">
          {onClose && (
            <button type="button" className="btn ghost" onClick={onClose}>
              {t("new.cancel")}
            </button>
          )}
          <button type="submit" className="btn primary" data-testid="start-game" disabled={!list.length}>
            {s.spectate ? t("new.watchStart") : t("new.deal")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function GameOverDialog({
  state,
  onAgain,
  onNew,
  onClose,
  onAnalyze,
  botLabelOf,
}: {
  state: GameState;
  onAgain: () => void;
  onNew: () => void;
  onClose: () => void;
  onAnalyze?: () => void;
  botLabelOf: (name: string) => string;
}) {
  const { t } = useI18n();
  const res = state.result;
  const loser = state.loser;
  const durak = loser !== null ? state.players[loser] : null;
  const human = state.human_seat !== null ? state.players[state.human_seat] : null;
  let headline: string;
  let tone: string;
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
    tone = "draw";
  }
  const order = [...state.finished, ...(loser !== null ? [loser] : [])];
  const rest = state.players.filter((p) => !order.includes(p.seat)).map((p) => p.seat);
  return (
    <Modal title={t("over.title")} onClose={onClose} className={`gameover tone-${tone}`}>
      <div className="go-headline" data-testid="game-over" data-reason={res?.reason ?? ""}>
        {headline}
      </div>
      {sub && <p className="go-sub">{sub}</p>}
      {durak && (
        <div className="go-durak">
          <Avatar player={durak} size={52} />
          <div>
            <div className="go-label">{t("over.durak")}</div>
            <div className="go-name">
              {displayName(durak, t)}
              {durak.bot ? <span className="bot-tag">{botLabelOf(durak.bot)}</span> : null}
            </div>
          </div>
          <div className="go-pogony" aria-hidden="true">
            <Card card={0} className="mini" />
            <Card card={27} className="mini" />
          </div>
        </div>
      )}
      <ol className="go-order">
        {[...order, ...rest].map((seat, i) => {
          const p = state.players[seat];
          return (
            <li key={seat} className={seat === loser ? "durak" : ""}>
              <span className="place">{seat === loser ? "Д" : rest.includes(seat) ? "=" : i + 1}</span>
              <Avatar player={p} size={24} />
              <span>{displayName(p, t)}</span>
              {p.bot && <span className="bot-tag">{botLabelOf(p.bot)}</span>}
            </li>
          );
        })}
      </ol>
      <div className="go-meta">
        {t("over.meta", { n: state.num_players, m: state.moves })}
        {state.seed != null ? ` · ${t("over.seed", { s: state.seed })}` : ""}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onNew}>
          {t("over.settings")}
        </button>
        {onAnalyze && (
          <button type="button" className="btn" onClick={onAnalyze} data-testid="analyze">
            📈 {t("over.analyze")}
          </button>
        )}
        <button type="button" className="btn primary" onClick={onAgain} data-testid="play-again" autoFocus>
          {t("over.again")}
        </button>
      </div>
    </Modal>
  );
}

const pct = (x: number | null | undefined) => (x === null || x === undefined ? "—" : `${(x * 100).toFixed(1)}%`);

export function StatsDialog({ onClose, botLabelOf }: { onClose: () => void; botLabelOf: (n: string) => string }) {
  const { t } = useI18n();
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.stats().then(setStats, (e) => setErr(String(e)));
  }, []);
  return (
    <Modal title={t("stats.title")} onClose={onClose} wide className="stats">
      {err && <div className="error">{err}</div>}
      {!stats && !err && <div className="loading">{t("loading")}</div>}
      {stats && (
        <>
          <div className="stat-tiles">
            <div className="tile">
              <b>{stats.human_games}</b>
              <span>{t("stats.games")}</span>
            </div>
            <div className="tile">
              <b>{stats.human_durak}</b>
              <span>{t("stats.durakTimes")}</span>
            </div>
            <div className="tile">
              <b>{pct(stats.human_durak_rate)}</b>
              <span>{t("stats.durakRate")}</span>
            </div>
            <div className="tile">
              <b>{stats.spectated_games}</b>
              <span>{t("stats.botGames")}</span>
            </div>
          </div>
          <h3>{t("stats.byN")}</h3>
          {stats.by_players.length === 0 ? (
            <p className="muted">{t("stats.none")}</p>
          ) : (
            <div className="table-wrap">
              <table>
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
              <table>
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
          <p className="muted small">{t("stats.fairNote")}</p>
          {stats.recent.length > 0 && (
            <>
              <h3>{t("stats.recent")}</h3>
              <div className="table-wrap">
                <table>
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
                            <span key={i} className={`mini-tag ${i === r.loser ? "durak" : ""}`}>
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
    </Modal>
  );
}

export function RulesDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Modal title={t("rules.title")} onClose={onClose} wide className="rules">
      <div className="rules-grid">
        <section>
          <h3>{t("rules.goal")}</h3>
          <p>
            <Rich text={t("rules.goalText")} /> <SuitIcon suit={3} size={12} />
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
    </Modal>
  );
}

export function SettingsDialog({
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
    <Modal title={t("settings.title")} onClose={onClose} className="settings">
      <div className="field">
        <label>{t("settings.language")}</label>
        <div className="seg">
          <button type="button" className={prefs.lang === "en" ? "on" : ""} aria-pressed={prefs.lang === "en"} onClick={() => set({ lang: "en" })} data-lang="en">
            English
          </button>
          <button type="button" className={prefs.lang === "ru" ? "on" : ""} aria-pressed={prefs.lang === "ru"} onClick={() => set({ lang: "ru" })} data-lang="ru">
            Русский
          </button>
        </div>
      </div>
      <div className="field">
        <label>{t("nav.speed")}</label>
        <div className="seg">
          {(["slow", "normal", "fast", "instant"] as const).map((sp) => (
            <button type="button" key={sp} className={prefs.speed === sp ? "on" : ""} aria-pressed={prefs.speed === sp} onClick={() => set({ speed: sp })}>
              {t(`speed.${sp}`)}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <label>{t("settings.theme")}</label>
        <div className="swatches">
          {THEMES.map((th) => (
            <button
              type="button"
              key={th}
              className={`swatch theme-swatch swt-${th} ${prefs.theme === th ? "on" : ""}`}
              onClick={() => set({ theme: th })}
              aria-pressed={prefs.theme === th}
              data-theme-choice={th}
            >
              <span className="sw-felt" />
              <span className="sw-name">{t(`theme.${th}`)}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <label>{t("settings.back")}</label>
        <div className="swatches backs">
          {BACKS.map((b) => (
            <button
              type="button"
              key={b}
              className={`swatch back-swatch ${prefs.back === b ? "on" : ""}`}
              onClick={() => set({ back: b })}
              aria-pressed={prefs.back === b}
              data-back-choice={b}
            >
              <span className={`back-preview back-${b}`}>
                <CardBack className="mini preview-back" />
              </span>
              <span className="sw-name">{t(`back.${b}`)}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <label className="check">
          <input type="checkbox" checked={prefs.fourColor} onChange={(e) => set({ fourColor: e.target.checked })} data-testid="four-color" />
          {t("settings.fourColor")} <span className="muted small">— {t("settings.fourColorHint")}</span>
        </label>
        <div className="four-preview">
          {[2, 11, 20, 29].map((c) => (
            <Card key={c} card={c} className="mini" />
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
            <input type="checkbox" checked={debug.on} onChange={debug.toggle} /> {t("new.debug")}
          </label>
        )}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onTutorial}>
          {t("settings.tutorial")}
        </button>
        <button type="button" className="btn primary" onClick={onClose}>
          OK
        </button>
      </div>
    </Modal>
  );
}
