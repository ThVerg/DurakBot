// Lobby: "Set the table" — players count + where you sit, four lubok-print
// difficulty cards, and the SIT DOWN plaque. Advanced options in a sheet.
import { useMemo, useState, type CSSProperties, type KeyboardEvent } from "react";
import type { BotInfo, BotsResponse } from "../api";
import { useI18n } from "../i18n";
import { TIER_PERSONA, portraitUrl, propUrl } from "./art";
import { Icon, Suit } from "./Icons";
import { Medal, type StageDims } from "./Scene";
import { Sheet } from "./Sheets";
import type { Settings } from "./settings";
import { TIERS, tierAgent, tierOfAgent } from "./tiers";
import { useStats } from "./Title";

const SEAT_PERSONAS = ["kostya", "misha", "zina", "sveta", "lev"];

export function Lobby({
  dims,
  bots,
  initial,
  onStart,
  onBack,
  langSwitch,
}: {
  dims: StageDims;
  bots: BotsResponse | null;
  initial: Settings;
  onStart: (s: Settings) => void;
  onBack: () => void;
  langSwitch: React.ReactNode;
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
  const cur = tierOfAgent(s.bot);
  const seatBots = Array.from({ length: n }, (_, i) => s.seatBots[i] ?? s.bot);
  const rec = (agent: string) => stats?.by_bot.find((b) => b.bot === agent);
  const m = dims.layout === "m";
  const curName = cur ? t(`tier.${cur.id}`) : byName.get(s.bot)?.labels?.[lang] ?? s.bot;

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

  const start = () => onStart({ ...s, seat, seatBots });

  const content = (
    <>
      <header className="l-topbar">
        <button type="button" className="brand" onClick={onBack} data-testid="lobby-back" aria-label={t("lobby.back")}>
          <span className="brand__back">
            <Icon name="back" />
          </span>
          <span className="brand__word">ДУРАК</span>
        </button>
        {langSwitch}
      </header>
      <div className="l-head">
        <span className="ru" lang="ru">
          Накрываем на стол
        </span>
        <h1 className="display">{t("d.lobbyTitle")}</h1>
      </div>

      <section className="count" aria-label={t("d.howMany")}>
        <div className="count__label">
          <b>{t("d.howMany")}</b>
          <span>{t("d.incl")}</span>
        </div>
        <div className="count__chips" role="radiogroup" aria-label={t("d.howMany")}>
          {[2, 3, 4, 5, 6].map((k) => (
            <button
              type="button"
              key={k}
              role="radio"
              aria-checked={n === k}
              className={n === k ? "is-on" : ""}
              onClick={() => set({ numPlayers: k, seat: Math.min(seat, k - 1) })}
              data-players={k}
            >
              {k}
            </button>
          ))}
        </div>
        <div className="count__seats" role="radiogroup" aria-label={t("d.seatHint")} title={t("d.seatHint")}>
          {Array.from({ length: 6 }, (_, i) => {
            if (i >= n)
              return <span key={i} className="seatdot is-empty" aria-hidden="true" />;
            const you = i === seat;
            const persona = SEAT_PERSONAS[(i - (i > seat ? 1 : 0)) % SEAT_PERSONAS.length];
            return (
              <button
                type="button"
                key={i}
                role="radio"
                aria-checked={you}
                aria-label={`${t("new.seatN", { n: i + 1 })}${you ? ` — ${t("lobby.you")}` : ""}`}
                className={`seatdot ${you ? "is-me" : ""}`}
                onClick={() => set({ seat: i })}
                data-seat-choice={i}
                style={{ zIndex: 10 - i } as CSSProperties}
              >
                {you ? "Я" : <img src={portraitUrl(persona) ?? ""} alt="" />}
              </button>
            );
          })}
        </div>
      </section>

      <section className="tiers" role="radiogroup" aria-label={t("lobby.opponents")} onKeyDown={onTierKey}>
        {tiers.map(({ tier, agent }) => {
          const on = s.bot === agent;
          const b = byName.get(agent!);
          const r = rec(agent!);
          const games = r?.human_games ?? 0;
          const lost = Math.round((r?.human_durak_rate ?? 0) * games);
          return (
            <button
              type="button"
              key={tier.id}
              role="radio"
              aria-checked={on}
              tabIndex={on || (!cur && tier.id === "grandmaster") ? 0 : -1}
              className={`tier tier--${tier.id} ${on ? "is-on" : ""}`}
              onClick={() => set({ bot: agent!, seatBots: [] })}
              data-tier={tier.id}
              data-bot={agent}
            >
              {on && <span className="tier__flag">{t("d.chosen")}</span>}
              <span className="tier__suit">
                <Suit s={tier.suit} />
              </span>
              <Medal persona={TIER_PERSONA[tier.id]} size={m ? 76 : 116} className="tier__portrait" />
              <span className="tier__ru" lang="ru">
                {["Новичок", "Любитель", "Знаток", "Гроссмейстер"][tier.strength - 1]}
              </span>
              <span className="tier__name">{t(`tier.${tier.id}`)}</span>
              <span className="tier__pips" aria-label={`${tier.strength}/4`}>
                {[1, 2, 3, 4].map((k) => (
                  <i key={k} className={k <= tier.strength ? "" : "off"} />
                ))}
              </span>
              <span className="tier__desc">{t(`d.desc.${tier.id}`)}</span>
              <span className="tier__rec">
                {b?.elo != null && <span className="tier__elo">Elo {b.elo} · </span>}
                {games ? (
                  <>
                    {t("d.vsYou")} · <b>{t("d.vsRec", { w: games - lost, l: lost })}</b>
                  </>
                ) : (
                  t("d.vsNone")
                )}
              </span>
            </button>
          );
        })}
      </section>
      {m && (
        <button type="button" className="go__adv lobby-adv" onClick={() => setAdv(true)} data-testid="advanced">
          <Icon name="gear" /> {t("lobby.advanced")}
        </button>
      )}

      <footer className="go">
        <div className="go__sum">
          <span className="kicker">{t("d.yourTable")}</span>
          <b>{t("d.sum", { n, tier: curName })}</b>
          {!m && (
            <button type="button" className="go__adv" onClick={() => setAdv(true)} data-testid="advanced">
              <Icon name="gear" /> {t("lobby.advanced")}
            </button>
          )}
        </div>
        <button type="button" className="btn" onClick={() => onStart({ ...s, seat, seatBots, spectate: true })} data-testid="watch-instead">
          <Icon name="watch" />
          <span>{t("d.watchInstead")}</span>
        </button>
        <button type="button" className="btn-primary sit" onClick={start} disabled={!list.length} data-testid="start-game">
          <Icon name="play" />
          <span>{s.spectate ? t("lobby.watchDeal") : t("d.sit")}</span>
          <span className="sub">за стол</span>
        </button>
      </footer>

      {adv && (
        <Sheet title={t("lobby.advanced")} ru="Дополнительно" onClose={() => setAdv(false)} className="adv-sheet">
          <label className="check">
            <input type="checkbox" checked={s.spectate} onChange={(e) => set({ spectate: e.target.checked })} data-testid="spectate" /> {t("new.watch")}
          </label>
          <div className="field">
            <label className="field__label" htmlFor="agent">
              {t("lobby.agent")}
            </label>
            <select id="agent" className="input" value={s.bot} onChange={(e) => set({ bot: e.target.value, seatBots: [] })}>
              {list.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.labels?.[lang] ?? b.label}
                  {b.elo != null ? ` · Elo ${b.elo}` : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="seed">
              {t("new.seed")}
            </label>
            <input id="seed" className="input" inputMode="numeric" placeholder={t("new.seedPh")} value={s.seed} onChange={(e) => set({ seed: e.target.value.replace(/[^0-9]/g, "") })} />
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
                  <label key={i} className="seat-row">
                    <span>{t("new.seatN", { n: i + 1 })}</span>
                    <select
                      className="input"
                      value={b}
                      onChange={(e) => {
                        const next = [...seatBots];
                        next[i] = e.target.value;
                        set({ seatBots: next });
                      }}
                    >
                      {list.map((x) => (
                        <option key={x.name} value={x.name}>
                          {x.labels?.[lang] ?? x.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ),
              )}
            </div>
          )}
          <div className="sheet__actions">
            <button type="button" className="btn" onClick={() => setAdv(false)}>
              OK
            </button>
            <button type="button" className="btn-primary" onClick={start} data-testid="adv-start">
              {s.spectate ? t("lobby.watchDeal") : t("d.sit")}
            </button>
          </div>
        </Sheet>
      )}
    </>
  );

  if (m)
    return (
      <div className="lobby-m" data-testid="lobby">
        {content}
      </div>
    );
  const sc = Math.min(window.innerWidth / 1440, window.innerHeight / 900);
  return (
    <div className="artboard lobby-d" style={{ transform: `translate(-50%, -50%) scale(${sc})` }} data-testid="lobby">
      <div className="t-props" aria-hidden="true">
        <img className="l-samovar" src={propUrl("samovar")} alt="" />
        <img className="l-tea" src={propUrl("tea")} alt="" />
      </div>
      {content}
    </div>
  );
}
