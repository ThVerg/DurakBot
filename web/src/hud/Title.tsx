// Title screen and lobby, drawn over the live 3D table.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { BotInfo, BotsResponse, GameState, StatsResponse } from "../api";
import { api } from "../api";
import { botLabel, type Settings } from "../components/Dialogs";
import { useI18n, type Lang } from "../i18n";
import { Portrait } from "./Plaque";

export const TIERS = [
  { id: "novice", agents: ["novice", "random"], persona: "kostya", strength: 1 },
  { id: "intermediate", agents: ["intermediate", "heuristic"], persona: "dasha", strength: 2 },
  { id: "expert", agents: ["expert", "solver"], persona: "misha", strength: 3 },
  { id: "grandmaster", agents: ["grandmaster", "champion", "champion_fast"], persona: "lev", strength: 4 },
] as const;

export function tierAgent(tier: (typeof TIERS)[number], bots: BotsResponse | null): string | null {
  const avail = new Set((bots?.bots ?? []).map((b) => b.name));
  return tier.agents.find((a) => avail.has(a)) ?? null;
}

export function tierOfAgent(agent: string): (typeof TIERS)[number] | null {
  return TIERS.find((t) => (t.agents as readonly string[]).includes(agent)) ?? null;
}

function useStats() {
  const [stats, setStats] = useState<StatsResponse | null>(null);
  useEffect(() => {
    api.stats().then(setStats, () => undefined);
  }, []);
  return stats;
}

function Logo() {
  const { lang } = useI18n();
  return (
    <div className="title-logo">
      <img src="/assets/ui/logo.svg" alt="" className="title-mono" width={92} height={92} draggable={false} />
      <h1 className="title-word" lang={lang}>
        {lang === "ru" ? "ДУРАК" : "DURAK"}
      </h1>
    </div>
  );
}

function LangSwitch({ lang, setLang }: { lang: Lang; setLang: (l: Lang) => void }) {
  return (
    <div className="lang-switch" role="group" aria-label="Language">
      <button type="button" className={lang === "en" ? "on" : ""} onClick={() => setLang("en")} aria-pressed={lang === "en"} data-lang="en">
        EN
      </button>
      <button type="button" className={lang === "ru" ? "on" : ""} onClick={() => setLang("ru")} aria-pressed={lang === "ru"} data-lang="ru">
        RU
      </button>
    </div>
  );
}

export function TitleScreen({
  bots,
  settings,
  resume,
  onPlay,
  onContinue,
  onLobby,
  onWatch,
  onRules,
  setLang,
  onSettings,
  sound,
  toggleSound,
}: {
  bots: BotsResponse | null;
  settings: Settings;
  resume: GameState | null;
  onPlay: () => void;
  onContinue: () => void;
  onLobby: () => void;
  onWatch: () => void;
  onRules: () => void;
  setLang: (l: Lang) => void;
  onSettings: () => void;
  sound: boolean;
  toggleSound: () => void;
}) {
  const { t, lang } = useI18n();
  const stats = useStats();
  const playRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    playRef.current?.focus({ preventScroll: true });
  }, []);
  const botName = (name: string) => {
    const tier = tierOfAgent(name);
    return tier ? t(`tier.${tier.id}`) : botLabel(bots?.bots.find((b) => b.name === name), name, lang);
  };
  const play = stats?.human_games ?? 0;
  const durak = stats?.human_durak ?? 0;
  const draws = (stats?.by_players ?? []).reduce((a, r) => a + r.draws, 0);
  const cred = (bots as (BotsResponse & { credential?: { win_rate: number } | null }) | null)?.credential;
  const resumeBot = resume?.players.find((p) => p.bot)?.bot;
  return (
    <div className="title-screen" data-testid="title">
      <div className="title-corner">
        <button type="button" className="hud-btn icon" onClick={toggleSound} aria-label={sound ? t("nav.mute") : t("nav.unmute")} data-testid="mute">
          {sound ? "🔊" : "🔇"}
        </button>
        <button type="button" className="hud-btn icon" onClick={onSettings} aria-label={t("nav.settings")} data-testid="settings">
          ⚙
        </button>
        <LangSwitch lang={lang} setLang={setLang} />
      </div>
      <div className="title-center">
        <Logo />
        <p className="title-tagline">{t("title.tagline")}</p>
        {resume && (
          <button type="button" className="continue-card" onClick={onContinue} data-testid="continue">
            <span className="cc-label">{t("title.continue")}</span>
            <span className="cc-sub">{t("title.continueSub", { n: resume.num_players, b: resume.bout + 1, bot: resumeBot ? botName(resumeBot) : "" })}</span>
            <span className="cc-arrow" aria-hidden="true">
              →
            </span>
          </button>
        )}
        <button type="button" ref={playRef} className="play-button" onClick={onPlay} data-testid="play" disabled={!bots}>
          <span className="pb-label">{t("title.play")}</span>
          <span className="pb-sub">{t("title.playSub", { n: settings.numPlayers, bot: settings.bot ? botName(settings.bot) : "…" })}</span>
        </button>
        <nav className="title-links" aria-label="Menu">
          <button type="button" onClick={onLobby} data-testid="choose">
            {t("title.choose")}
          </button>
          <span aria-hidden="true">·</span>
          <button type="button" onClick={onWatch} data-testid="watch">
            {t("title.watch")}
          </button>
          <span aria-hidden="true">·</span>
          <a href="#/lab" data-testid="lab-link">
            {t("nav.lab")}
          </a>
          <span aria-hidden="true">·</span>
          <button type="button" onClick={onRules}>
            {t("nav.rules")}
          </button>
        </nav>
      </div>
      <div className="title-strip">
        <div className="ts-record">
          <span className="ts-k">{t("title.record")}</span>
          <span className="ts-v">{play ? t("title.recordLine", { w: play - durak - draws, l: durak, d: draws }) : t("title.noRecord")}</span>
        </div>
        <div className="ts-cred">
          <span className="ts-dot" aria-hidden="true" />
          {cred ? t("title.credential", { p: Math.round(cred.win_rate * 100) }) : t("title.credentialFallback")}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- lobby
function MiniTable({ n, seat, setSeat, tierPersona, t }: { n: number; seat: number; setSeat: (s: number) => void; tierPersona: string; t: (k: string) => string }) {
  const W = 300;
  const H = 250;
  const cx = W / 2;
  const cy = H / 2;
  const rx = 98;
  const ry = 60;
  const personas = ["zina", "misha", "sveta", "kostya", "dasha", "grisha", "lev"].filter((p) => p !== tierPersona);
  const pos = (k: number) => {
    // seat `seat` at the bottom, others clockwise
    const rel = (k - seat + n) % n;
    const a = Math.PI / 2 + (rel * 2 * Math.PI) / n;
    return { x: cx + Math.cos(a) * (rx + 30), y: cy + Math.sin(a) * (ry + 34) };
  };
  return (
    <div className="mini-table" role="radiogroup" aria-label={t("lobby.seatHint")}>
      <svg viewBox={`0 0 ${W} ${H}`} aria-hidden="true" className="mt-svg">
        <defs>
          <radialGradient id="mtFelt" cx="50%" cy="45%" r="60%">
            <stop offset="0" stopColor="#1b7a52" />
            <stop offset="1" stopColor="#0a3a27" />
          </radialGradient>
        </defs>
        <ellipse cx={cx} cy={cy} rx={rx + 10} ry={ry + 10} fill="#2a1a10" stroke="#d4af37" strokeOpacity="0.5" strokeWidth="1.2" />
        <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill="url(#mtFelt)" />
        <ellipse cx={cx} cy={cy} rx={rx - 8} ry={ry - 8} fill="none" stroke="#d4af37" strokeOpacity="0.25" />
      </svg>
      {Array.from({ length: n }, (_, k) => {
        const p = pos(k);
        const you = k === seat;
        return (
          <button
            type="button"
            key={k}
            role="radio"
            aria-checked={you}
            aria-label={`${t("new.seatN").replace("{n}", String(k + 1))}${you ? ` — ${t("lobby.you")}` : ""}`}
            className={`mt-seat ${you ? "you" : ""}`}
            style={{ left: `${(p.x / W) * 100}%`, top: `${(p.y / H) * 100}%` }}
            onClick={() => setSeat(k)}
            data-seat-choice={k}
          >
            <Portrait player={{ is_human: you, persona: you ? null : personas[k % personas.length], name: "", seat: k }} size={you ? 46 : 38} />
            <span className="mt-num">{you ? t("lobby.you") : k + 1}</span>
          </button>
        );
      })}
    </div>
  );
}

export function Lobby({
  bots,
  initial,
  onStart,
  onBack,
}: {
  bots: BotsResponse | null;
  initial: Settings;
  onStart: (s: Settings) => void;
  onBack: () => void;
}) {
  const { t, lang } = useI18n();
  const stats = useStats();
  const [s, setS] = useState<Settings>(() => ({ ...initial, seat: initial.seat === "random" ? 0 : initial.seat }));
  const [adv, setAdv] = useState(false);
  const set = (patch: Partial<Settings>) => setS((p) => ({ ...p, ...patch }));
  const n = s.numPlayers;
  const seat = typeof s.seat === "number" && s.seat < n ? s.seat : 0;
  const list = bots?.bots ?? [];
  const byName = useMemo(() => new Map(list.map((b) => [b.name, b] as [string, BotInfo])), [list]);
  const tiers = TIERS.map((tier) => ({ tier, agent: tierAgent(tier, bots) })).filter((x) => x.agent);
  const curTier = tierOfAgent(s.bot);
  const seatBots = Array.from({ length: n }, (_, i) => s.seatBots[i] ?? s.bot);
  const record = (agent: string) => stats?.by_bot.find((b) => b.bot === agent);

  const onTierKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    const i = Math.max(0, tiers.findIndex((x) => x.agent === s.bot));
    const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
    const next = tiers[(i + d + tiers.length) % tiers.length];
    if (next?.agent) {
      set({ bot: next.agent, seatBots: [] });
      (document.querySelector(`[data-tier="${next.tier.id}"]`) as HTMLElement | null)?.focus();
    }
  };

  return (
    <div className="lobby" data-testid="lobby">
      <header className="lobby-head">
        <button type="button" className="hud-btn" onClick={onBack} data-testid="lobby-back">
          ← {t("lobby.back")}
        </button>
        <div>
          <h1>{t("lobby.title")}</h1>
          <p>{t("lobby.subtitle")}</p>
        </div>
        <span />
      </header>
      <div className="lobby-body">
        <section className="tier-section" aria-label={t("lobby.opponents")}>
          <div className="tier-grid" role="radiogroup" aria-label={t("lobby.opponents")} onKeyDown={onTierKey}>
            {tiers.map(({ tier, agent }) => {
              const on = s.bot === agent;
              const b = byName.get(agent!);
              const rec = record(agent!);
              return (
                <button
                  type="button"
                  key={tier.id}
                  role="radio"
                  aria-checked={on}
                  tabIndex={on || (!curTier && tier.id === "grandmaster") ? 0 : -1}
                  className={`tier-card ${on ? "on" : ""} tier-${tier.id}`}
                  onClick={() => set({ bot: agent!, seatBots: [] })}
                  data-tier={tier.id}
                  data-bot={agent}
                >
                  <span className="tc-portrait">
                    <Portrait player={{ is_human: false, persona: tier.persona, name: "", seat: 0 }} size={96} />
                  </span>
                  <span className="tc-name">{t(`tier.${tier.id}`)}</span>
                  <span className="tc-line">{t(`tierLine.${tier.id}`)}</span>
                  <span className="tc-meter" aria-label={`${t("lobby.strength")} ${tier.strength}/4`}>
                    {[1, 2, 3, 4].map((k) => (
                      <i key={k} className={k <= tier.strength ? "on" : ""} />
                    ))}
                  </span>
                  <span className="tc-meta">
                    {b?.elo !== null && b?.elo !== undefined && <span className="tc-elo">Elo {b.elo}</span>}
                    <span className="tc-rec">
                      {rec && rec.human_games ? t("lobby.vsYou", { name: t(`tier.${tier.id}`), g: rec.human_games, d: Math.round((rec.human_durak_rate ?? 0) * rec.human_games) }) : t("lobby.never")}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>
        <section className="setup-section">
          <div className="setup-card">
            <div className="setup-label">{t("lobby.players")}</div>
            <div className="count-pick" role="radiogroup" aria-label={t("lobby.players")}>
              {[2, 3, 4, 5, 6].map((k) => (
                <button type="button" key={k} role="radio" aria-checked={n === k} className={n === k ? "on" : ""} onClick={() => set({ numPlayers: k, seat: Math.min(seat, k - 1) })} data-players={k}>
                  {k}
                </button>
              ))}
            </div>
            <MiniTable n={n} seat={seat} setSeat={(k) => set({ seat: k })} tierPersona={curTier?.persona ?? "lev"} t={t} />
            <div className="setup-hint">{t("lobby.seatHint")}</div>
            <button
              type="button"
              className="play-button deal deal-desktop"
              onClick={() => onStart({ ...s, seat, seatBots })}
              data-testid="start-game"
              disabled={!list.length}
            >
              <span className="pb-label">{s.spectate ? t("lobby.watchDeal") : t("lobby.deal")}</span>
              <span className="pb-sub">
                {t("title.playSub", { n, bot: curTier ? t(`tier.${curTier.id}`) : botLabel(byName.get(s.bot), s.bot, lang) })}
              </span>
            </button>
            <button type="button" className="adv-toggle" onClick={() => setAdv((a) => !a)} aria-expanded={adv} data-testid="advanced">
              {t("lobby.advanced")} <span aria-hidden="true">{adv ? "▴" : "▾"}</span>
            </button>
            {adv && (
              <div className="advanced">
                <label className="check">
                  <input type="checkbox" checked={s.spectate} onChange={(e) => set({ spectate: e.target.checked })} data-testid="spectate" /> {t("new.watch")}
                </label>
                <div className="adv-row">
                  <label htmlFor="agent">{t("lobby.agent")}</label>
                  <select id="agent" value={s.bot} onChange={(e) => set({ bot: e.target.value, seatBots: [] })}>
                    {list.map((b) => (
                      <option key={b.name} value={b.name}>
                        {botLabel(b, b.name, lang)}
                        {b.elo != null ? ` · Elo ${b.elo}` : ""}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="adv-row">
                  <label htmlFor="seed">{t("new.seed")}</label>
                  <input id="seed" inputMode="numeric" placeholder={t("new.seedPh")} value={s.seed} onChange={(e) => set({ seed: e.target.value.replace(/[^0-9]/g, "") })} />
                </div>
                <label className="check">
                  <input type="checkbox" checked={s.debug} onChange={(e) => set({ debug: e.target.checked })} /> {t("new.debug")}
                </label>
                <label className="check">
                  <input type="checkbox" checked={s.perSeat} onChange={(e) => set({ perSeat: e.target.checked })} /> {t("new.perSeat")}
                </label>
                {s.perSeat && (
                  <div className="seat-grid">
                    {seatBots.map((b, i) =>
                      !s.spectate && i === seat ? null : (
                        <div key={i} className="seat-row">
                          <span>{t("new.seatN", { n: i + 1 })}</span>
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
                        </div>
                      ),
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </section>
      </div>
      <div className="deal-bar">
        <button type="button" className="play-button deal" onClick={() => onStart({ ...s, seat, seatBots })} disabled={!list.length} data-testid="start-game-mobile">
          <span className="pb-label">{s.spectate ? t("lobby.watchDeal") : t("lobby.deal")}</span>
          <span className="pb-sub">{t("title.playSub", { n, bot: curTier ? t(`tier.${curTier.id}`) : botLabel(byName.get(s.bot), s.bot, lang) })}</span>
        </button>
      </div>
    </div>
  );
}
