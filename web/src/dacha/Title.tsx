// Title screen: woodcut «ДУРАК», the PLAY plaque, "Сегодня за столом" cast
// around the samovar, and your record embroidered on a ribbon.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { api, type BotsResponse, type GameState, type StatsResponse } from "../api";
import { useI18n, type Lang } from "../i18n";
import { TIER_PERSONA, backSrc, dropSrcSet, faceSrc, propUrl, useHiRes } from "./art";
import { Lockup } from "./Brand";
import { Icon } from "./Icons";
import { Medal, type StageDims } from "./Scene";
import { TIERS, tierOfAgent } from "./tiers";
import type { Settings } from "./settings";

export function LangSwitch({ lang, setLang }: { lang: Lang; setLang: (l: Lang) => void }) {
  return (
    <div className="lang" role="group" aria-label="Language">
      <Icon name="globe" />
      <button type="button" className={lang === "en" ? "is-on" : ""} aria-pressed={lang === "en"} onClick={() => setLang("en")} data-lang="en">
        EN
      </button>
      <button type="button" className={lang === "ru" ? "is-on" : ""} aria-pressed={lang === "ru"} onClick={() => setLang("ru")} data-lang="ru">
        RU
      </button>
    </div>
  );
}

export function useStats() {
  const [stats, setStats] = useState<StatsResponse | null>(null);
  useEffect(() => {
    api.stats().then(setStats, () => undefined);
  }, []);
  return stats;
}

export interface TitleProps {
  dims: StageDims;
  bots: BotsResponse | null;
  settings: Settings;
  resume: GameState | null;
  onPlay: () => void;
  onContinue: () => void;
  onLobby: (tier?: string) => void;
  onWatch: () => void;
  onStats: () => void;
  onRules: () => void;
  setLang: (l: Lang) => void;
  onSettings: () => void;
  sound: boolean;
  toggleSound: () => void;
}

export function TitleScreen(p: TitleProps) {
  const { t, lang } = useI18n();
  const stats = useStats();
  useHiRes();
  const playRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    playRef.current?.focus({ preventScroll: true });
  }, []);
  const m = p.dims.layout === "m";
  const games = stats?.human_games ?? 0;
  const durak = stats?.human_durak ?? 0;
  const safe = stats?.human_safe ?? Math.max(0, games - durak);
  const tier = tierOfAgent(p.settings.bot);
  const botInfo = p.bots?.bots.find((b) => b.name === p.settings.bot);
  const tierName = tier ? t(`tier.${tier.id}`) : botInfo ? botInfo.labels?.[lang] ?? botInfo.label : "";

  const topbar = (
    <header className="t-topbar">
      <LangSwitch lang={lang} setLang={p.setLang} />
      <button type="button" className={`ibtn ${p.sound ? "" : "is-off"}`} onClick={p.toggleSound} aria-label={p.sound ? t("nav.mute") : t("nav.unmute")} aria-pressed={!p.sound} data-testid="mute">
        <Icon name={p.sound ? "sound" : "mute"} />
      </button>
      <button type="button" className="ibtn" onClick={p.onSettings} aria-label={t("nav.settings")} data-testid="settings">
        <Icon name="gear" />
      </button>
    </header>
  );

  const hero = (
    <main className="hero">
      <div className="kicker hero__kicker">{t("d.kicker")}</div>
      <Lockup />
      <p className="tagline">{t("d.tagline")}</p>
      <div className="cta">
        <button type="button" ref={playRef} className="btn-primary play" onClick={p.onPlay} disabled={!p.bots} data-testid="play">
          <Icon name="play" />
          <span className="play__txt">
            <span>{t("d.play")}</span>
            <span className="play__sub">{t("d.playSub", { n: p.settings.numPlayers })}</span>
          </span>
          <span className="sub">играть</span>
        </button>
        {p.resume && (
          <button type="button" className="continue" onClick={p.onContinue} data-testid="continue">
            <Icon name="flame" />
            <span>{t("d.continue", { n: p.resume.bout + 1 })}</span>
          </button>
        )}
      </div>
      <nav className="secondary" aria-label={t("d.more")}>
        <button type="button" className="btn" onClick={() => p.onLobby()} data-testid="choose">
          <Icon name="users" />
          <span>{t("d.opponents")}</span>
        </button>
        <button type="button" className="btn" onClick={p.onWatch} data-testid="watch">
          <Icon name="watch" />
          <span>{t("d.watch")}</span>
        </button>
        <button type="button" className="btn" onClick={p.onStats} data-testid="stats-btn">
          <Icon name="stats" />
          <span>{t("d.stats")}</span>
        </button>
        <button type="button" className="btn" onClick={p.onRules} data-testid="rules-btn">
          <Icon name="rules" />
          <span>{t("d.rules")}</span>
        </button>
        <a className="btn btn--icon" href="#/lab" data-testid="lab-link" aria-label={t("d.lab")} title={t("d.lab")}>
          <Icon name="lab" />
          {m && <span>{t("d.lab")}</span>}
        </a>
      </nav>
    </main>
  );

  const cast = (
    <section className="cast" aria-label={t("d.todayKicker")}>
      <div className="cast__title">
        <span className="ru" lang="ru">
          Сегодня за столом
        </span>
        <span className="kicker">{t("d.todayKicker")}</span>
      </div>
      {TIERS.map((tr) => (
        <button type="button" key={tr.id} className={`guest guest--${tr.id} ${tier?.id === tr.id ? "is-chosen" : ""}`} onClick={() => p.onLobby(tr.id)}>
          <Medal persona={TIER_PERSONA[tr.id]} size={m ? 70 : 128} />
          <span className="guest__cap">
            <b>{t(`personaMid.${TIER_PERSONA[tr.id]}`)}</b>
            <span>{t(`tier.${tr.id}`)}</span>
          </span>
        </button>
      ))}
    </section>
  );

  const cred = (p.bots as (BotsResponse & { credential?: { win_rate: number } | null }) | null)?.credential;
  const record = (
    <footer className="record" aria-label={t("title.record")}>
      <div className="record__who">
        <span className="record__me">Я</span>
        <span>
          <b>{t("d.you")}</b>
          <small>{games ? t("d.recTable", { tier: tierName }) : t("d.recFirst")}</small>
        </span>
      </div>
      <ul className="record__stats">
        <li>
          <b>{games}</b>
          <span>{t("d.recGames")}</span>
        </li>
        <li>
          <b>{safe}</b>
          <span>{t("d.recWins")}</span>
        </li>
        <li>
          <b>{games ? `${Math.round((safe / games) * 100)}%` : "—"}</b>
          <span>{t("d.recRate")}</span>
        </li>
        <li className="is-fool">
          <b>{durak}×</b>
          <span>{t("d.recFool")}</span>
        </li>
        <li>
          <b>{stats?.streak_best ?? 0}</b>
          <span>{t("d.recStreak")}</span>
        </li>
      </ul>
      {cred && !m && (
        <div className="record__cred" title={t("title.credential", { p: Math.round(cred.win_rate * 100) })}>
          <Icon name="laurel" />
          <span>{t("title.credential", { p: Math.round(cred.win_rate * 100) })}</span>
        </div>
      )}
    </footer>
  );

  if (m) {
    return (
      <div className="title-m" data-testid="title">
        {topbar}
        {hero}
        {cast}
        {record}
      </div>
    );
  }
  // desktop: a 1440x900 artboard scaled to fit, centred
  const s = Math.min(window.innerWidth / 1440, window.innerHeight / 900);
  const style = { transform: `translate(-50%, -50%) scale(${s})` } as CSSProperties;
  return (
    <div className="artboard title-d" style={style} data-testid="title">
      <div className="t-props" aria-hidden="true">
        <img className="t-seeds" src={propUrl("seeds")} alt="" />
        <img className="t-tea" src={propUrl("tea")} alt="" />
        <div className="spill">
          <img
            className="spill__card spill__back"
            {...backSrc("gzhel")}
            sizes={`${Math.ceil(118 * s)}px`}
            alt=""
            style={{ "--x": "0px", "--y": "30px", "--r": "-28deg" } as CSSProperties}
            onError={dropSrcSet}
          />
          {[
            [0, 60, 4, -14],
            [24, 126, -6, 2],
            [7, 196, 4, 16],
            [35, 262, 30, 30],
          ].map(([c, x, y, r]) => (
            <img
              key={c}
              className="spill__card"
              {...faceSrc(c, false)}
              sizes={`${Math.ceil(118 * s)}px`}
              onError={dropSrcSet}
              alt=""
              style={{ "--x": `${x}px`, "--y": `${y}px`, "--r": `${r}deg` } as CSSProperties}
            />
          ))}
        </div>
        <img className="t-samovar" src={propUrl("samovar")} alt="" />
      </div>
      {topbar}
      {hero}
      {cast}
      {record}
    </div>
  );
}
