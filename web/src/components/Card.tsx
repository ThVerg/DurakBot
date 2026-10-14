import { memo, useState, type CSSProperties, type ReactNode } from "react";
import { cardCode } from "../assets";
import { RANKS, rankOf, suitOf } from "../cards";
import { SUIT_NAMES, useI18n } from "../i18n";

// Suit shapes in a 100x100 box.
const SUIT_PATHS: string[] = [
  // spades
  "M50 2 C60 20 98 38 98 62 C98 78 86 88 72 88 C63 88 56 84 53 77 C54 88 58 95 67 100 L33 100 C42 95 46 88 47 77 C44 84 37 88 28 88 C14 88 2 78 2 62 C2 38 40 20 50 2 Z",
  // clubs
  "M50 4 A21 21 0 0 1 66 39 A21 21 0 1 1 55 72 C56 86 60 94 68 100 L32 100 C40 94 44 86 45 72 A21 21 0 1 1 34 39 A21 21 0 0 1 50 4 Z",
  // diamonds
  "M50 0 L90 50 L50 100 L10 50 Z",
  // hearts
  "M50 92 C22 70 2 52 2 30 C2 13 15 3 29 3 C39 3 46 9 50 18 C54 9 61 3 71 3 C85 3 98 13 98 30 C98 52 78 70 50 92 Z",
];

export function SuitIcon({ suit, size = 14, className }: { suit: number; size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      aria-hidden="true"
      style={{ display: "inline-block", verticalAlign: "-0.12em" }}
    >
      <path d={SUIT_PATHS[suit]} fill={`var(--suit-${suit})`} />
    </svg>
  );
}

function Pip({ suit, x, y, s, flip }: { suit: number; x: number; y: number; s: number; flip?: boolean }) {
  const k = s / 100;
  return (
    <path
      d={SUIT_PATHS[suit]}
      transform={`translate(${x} ${y}) ${flip ? "rotate(180)" : ""} translate(${-s / 2} ${-s / 2}) scale(${k})`}
    />
  );
}

const L = 31;
const R = 69;
const C = 50;
const PIP_LAYOUTS: Record<number, [number, number][]> = {
  0: [[L, 34], [L, 70], [L, 106], [R, 34], [R, 70], [R, 106]], // 6
  1: [[L, 34], [L, 70], [L, 106], [R, 34], [R, 70], [R, 106], [C, 52]], // 7
  2: [[L, 34], [L, 70], [L, 106], [R, 34], [R, 70], [R, 106], [C, 52], [C, 88]], // 8
  3: [[L, 34], [L, 58], [L, 82], [L, 106], [R, 34], [R, 58], [R, 82], [R, 106], [C, 70]], // 9
  4: [[L, 34], [L, 58], [L, 82], [L, 106], [R, 34], [R, 58], [R, 82], [R, 106], [C, 46], [C, 94]], // 10
};

const FACE_GLYPH: Record<number, string> = { 5: "J", 6: "Q", 7: "K" };

function CardFace({ card }: { card: number }) {
  const s = suitOf(card);
  const r = rankOf(card);
  const rank = RANKS[r];
  const color = `var(--suit-${s})`;
  const corner = (
    <g>
      <text
        x={r === 4 ? 11.5 : 11}
        y={21}
        textAnchor="middle"
        fontSize={r === 4 ? 16 : 19}
        fontWeight={700}
        letterSpacing={r === 4 ? -1.5 : 0}
        fontFamily="var(--card-font)"
      >
        {rank}
      </text>
      <Pip suit={s} x={11} y={32} s={11} />
    </g>
  );
  let center: ReactNode;
  if (r <= 4) {
    center = PIP_LAYOUTS[r].map(([x, y], i) => <Pip key={i} suit={s} x={x} y={y} s={17} flip={y > 70} />);
  } else if (r === 8) {
    center = <Pip suit={s} x={50} y={70} s={46} />;
  } else {
    center = (
      <g>
        <rect x={21} y={25} width={58} height={90} rx={6} fill="var(--face-tint)" stroke={color} strokeWidth={1.4} />
        <rect x={25} y={29} width={50} height={82} rx={4} fill="none" stroke={color} strokeOpacity={0.35} strokeWidth={0.8} />
        <Pip suit={s} x={50} y={44} s={14} />
        <text x={50} y={86} textAnchor="middle" fontSize={34} fontWeight={700} fontFamily="var(--face-font)">
          {FACE_GLYPH[r]}
        </text>
        <Pip suit={s} x={50} y={100} s={14} flip />
      </g>
    );
  }
  return (
    <svg viewBox="0 0 100 140" className="card-svg" aria-hidden="true">
      <rect x={0.75} y={0.75} width={98.5} height={138.5} rx={8} fill="var(--card-bg)" stroke="var(--card-edge)" strokeWidth={1.5} />
      <g fill={color}>
        {corner}
        <g transform="rotate(180 50 70)">{corner}</g>
        {center}
      </g>
    </svg>
  );
}

/** The premium card art when available, the vector face otherwise. */
function FaceArt({ card, small }: { card: number; small: boolean }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <CardFace card={card} />;
  const four = typeof document !== "undefined" && document.documentElement.dataset.fourColor === "on";
  const dir = four ? "cards4" : small ? "cards_sm" : "cards";
  return <img className="card-img" src={`/assets/${dir}/${cardCode(card)}.webp`} alt="" draggable={false} onError={() => setFailed(true)} />;
}

export interface CardProps {
  card: number;
  className?: string;
  style?: CSSProperties;
  legal?: boolean;
  dimmed?: boolean;
  selected?: boolean;
  known?: boolean;
  trump?: boolean;
  hint?: string;
  onClick?: () => void;
  title?: string;
}

export const Card = memo(function Card({
  card,
  className = "",
  style,
  legal,
  dimmed,
  selected,
  known,
  trump,
  hint,
  onClick,
  title,
}: CardProps) {
  const { lang, t } = useI18n();
  const label = t("a11y.card", { rank: RANKS[rankOf(card)], suit: SUIT_NAMES[lang][suitOf(card)] });
  const cls = [
    "card",
    className,
    legal ? "legal" : "",
    dimmed ? "dimmed" : "",
    selected ? "selected" : "",
    known ? "known" : "",
    trump ? "is-trump" : "",
    onClick ? "clickable" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const content = (
    <>
      <FaceArt card={card} small={className.includes("mini")} />
      {known && <span className="known-tag">{t("opp.known")}</span>}
      {hint && <span className="key-hint">{hint}</span>}
    </>
  );
  if (onClick) {
    return (
      <button type="button" className={cls} style={style} onClick={onClick} title={title ?? label} aria-label={label} data-card={card}>
        {content}
      </button>
    );
  }
  return (
    <div className={cls} style={style} title={title ?? label} aria-label={label} role="img" data-card={card}>
      {content}
    </div>
  );
});

export function CardBack({ className = "", style }: { className?: string; style?: CSSProperties }) {
  return (
    <div className={`card card-back ${className}`} style={style} aria-hidden="true">
      <div className="card-back-inner" />
    </div>
  );
}
