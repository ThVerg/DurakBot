// Hint panel, the dramatic "ДУРАК!" reveal and first-game coach marks.
import { useEffect, useLayoutEffect, useState, type CSSProperties } from "react";
import type { Hint, PassLabel } from "../api";
import { PASS } from "../cards";
import { Rich, useI18n } from "../i18n";
import { Card } from "./Card";

export function ActionChip({ action, passLabel }: { action: number; passLabel: PassLabel | null }) {
  const { t } = useI18n();
  if (action === PASS) return <span className={`pass-chip pass-${passLabel ?? "pass"}`}>{t(`pass.${passLabel ?? "pass"}`)}</span>;
  return <Card card={action} className="mini hint-mini" />;
}

export function HintPanel({
  hint,
  loading,
  passLabel,
  onPlay,
  onClose,
}: {
  hint: Hint | null;
  loading: boolean;
  passLabel: PassLabel | null;
  onPlay: (a: number) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="hint-panel" role="dialog" aria-label={t("hint.title")} data-testid="hint-panel">
      <div className="hint-head">
        <b>💡 {t("hint.title")}</b>
        {hint?.has_values && hint.current !== undefined && <span className="muted small">{t("hint.now", { p: `${Math.round(hint.current * 100)}%` })}</span>}
        {hint?.exact && <span className="mini-tag gold">{t("hint.exact")}</span>}
        <button type="button" className="icon-btn" onClick={onClose} aria-label={t("hint.close")}>
          ✕
        </button>
      </div>
      {loading && (
        <div className="hint-loading">
          <span className="spinner" /> {t("hint.loading")}
        </div>
      )}
      {hint && !loading && (
        <>
          <div className="hint-rec">
            <span className="muted">{hint.has_values ? t("hint.champion") : t("hint.noValues")}</span>
            <ActionChip action={hint.recommended} passLabel={passLabel} />
            <button type="button" className="btn primary small" onClick={() => onPlay(hint.recommended)} data-testid="hint-play">
              {t("hint.play")}
            </button>
          </div>
          {hint.has_values && (
            <ul className="hint-moves" aria-label={t("hint.win")}>
              {hint.moves.map((m) => {
                const p = Math.round((m.win ?? 0) * 100);
                return (
                  <li key={m.action} className={m.action === hint.recommended ? "rec" : ""}>
                    <button type="button" className="hint-move" onClick={() => onPlay(m.action)} aria-label={`${p}%`}>
                      <ActionChip action={m.action} passLabel={passLabel} />
                      <span className="bar">
                        <span style={{ width: `${p}%` }} />
                      </span>
                      <b>{p}%</b>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {hint.has_values && <div className="muted small hint-foot">{t("hint.win")}</div>}
        </>
      )}
    </div>
  );
}

export function DurakReveal({ lose, onDone }: { lose: boolean; onDone: () => void }) {
  const { t } = useI18n();
  useEffect(() => {
    const id = setTimeout(onDone, lose ? 2600 : 1800);
    return () => clearTimeout(id);
  }, [lose, onDone]);
  return (
    <div className={`reveal ${lose ? "lose" : "win"}`} onClick={onDone} role="alert" data-testid="reveal">
      <div className="reveal-inner">
        {lose ? (
          <>
            <div className="stamp" lang="ru">
              ДУРАК!
            </div>
            <div className="pogony" aria-hidden="true">
              <Card card={0} className="table-card" />
              <Card card={27} className="table-card" />
            </div>
          </>
        ) : (
          <div className="escaped">{t("reveal.sub.win")}</div>
        )}
        <div className="reveal-sub">{lose ? t("reveal.sub.lose") : ""}</div>
        <div className="reveal-tap">{t("reveal.tap")}</div>
      </div>
    </div>
  );
}

const TUT_STEPS = [
  { sel: ".hand, .tut-hand", key: "hand" },
  { sel: ".table-center, .tut-table", key: "table" },
  { sel: ".talon, .tut-talon", key: "talon" },
  { sel: ".opponent, .tut-opps", key: "opps" },
  { sel: ".human-bar .actions, .hud-actions", key: "actions" },
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
  let tipStyle: CSSProperties = { left: vw / 2 - 160, top: vh / 2 - 80 };
  if (rect) {
    const below = rect.bottom + 180 < vh;
    const left = Math.max(12, Math.min(vw - 332, rect.left + rect.width / 2 - 160));
    tipStyle = below ? { left, top: rect.bottom + pad + 10 } : { left, top: Math.max(12, rect.top - pad - 10 - 170) };
  }
  return (
    <div className="tutorial" role="dialog" aria-modal="true" aria-label={t(`tut.${step.key}.t`)} data-testid="tutorial">
      {rect && (
        <div
          className="tut-spot"
          style={{ left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }}
        />
      )}
      <div className="tut-tip" style={tipStyle}>
        <div className="tut-count">
          {i + 1} / {TUT_STEPS.length}
        </div>
        <h3>{t(`tut.${step.key}.t`)}</h3>
        <p>
          <Rich text={t(`tut.${step.key}.b`)} />
        </p>
        <div className="tut-actions">
          <button type="button" className="btn ghost small" onClick={onDone}>
            {t("tut.skip")}
          </button>
          <button type="button" className="btn primary small" autoFocus onClick={() => (last ? onDone() : setI(i + 1))} data-testid="tut-next">
            {last ? t("tut.done") : t("tut.next")}
          </button>
        </div>
      </div>
    </div>
  );
}
