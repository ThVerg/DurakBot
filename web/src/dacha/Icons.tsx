// Dacha icon set (stroke icons from the concept) as inline SVG components.
import type { CSSProperties } from "react";

const P: Record<string, JSX.Element> = {
  log: (
    <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 3h11a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6z" />
      <path d="M6 3v18" />
      <path d="M4 7h3M4 12h3M4 17h3" />
      <path d="M10 8h6M10 12h6M10 16h4" />
    </g>
  ),
  sound: (
    <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" fillOpacity=".12" />
      <path d="M15.5 9a4 4 0 0 1 0 6" />
      <path d="M18 6.5a7.5 7.5 0 0 1 0 11" />
    </g>
  ),
  mute: (
    <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" fillOpacity=".12" />
      <path d="M16 9.5l5 5M21 9.5l-5 5" />
    </g>
  ),
  gear: (
    <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" />
      <circle cx="12" cy="12" r="6.6" />
    </g>
  ),
  back: <path d="M14.5 5.5 8 12l6.5 6.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />,
  hint: (
    <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 17.5h6M10 21h4" />
      <path d="M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.4 1.1 2.2v1.5h5V16c0-.8.4-1.6 1.1-2.2A6 6 0 0 0 12 3z" fill="currentColor" fillOpacity=".15" />
      <path d="M12 7v3l1.6 1.2" />
    </g>
  ),
  take: (
    <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 4v11" />
      <path d="M7 11l5 5 5-5" />
      <path d="M5 20h14" />
    </g>
  ),
  bita: (
    <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12.5l4.2 4.2L19 7" />
    </g>
  ),
  pass: (
    <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h12" />
      <path d="M13 7l5 5-5 5" />
    </g>
  ),
  eye: (
    <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="3" fill="currentColor" />
    </g>
  ),
  laurel: (
    <g fill="currentColor">
      <path d="M12 19.5c-4.4-.4-7.6-3.8-7.9-8.4l1.5-.1c.3 3.8 3 6.7 6.6 7z" />
      <path d="M12 19.5c4.4-.4 7.6-3.8 7.9-8.4l-1.5-.1c-.3 3.8-3 6.7-6.6 7z" />
      <ellipse cx="5" cy="8.6" rx="1.3" ry="2.4" transform="rotate(-20 5 8.6)" />
      <ellipse cx="5.6" cy="13" rx="1.3" ry="2.4" transform="rotate(-50 5.6 13)" />
      <ellipse cx="8" cy="16.4" rx="1.3" ry="2.4" transform="rotate(-70 8 16.4)" />
      <ellipse cx="19" cy="8.6" rx="1.3" ry="2.4" transform="rotate(20 19 8.6)" />
      <ellipse cx="18.4" cy="13" rx="1.3" ry="2.4" transform="rotate(50 18.4 13)" />
      <ellipse cx="16" cy="16.4" rx="1.3" ry="2.4" transform="rotate(70 16 16.4)" />
      <path d="M12 6.2l1.2 2.5 2.7.3-2 1.8.6 2.7L12 12.1l-2.5 1.4.6-2.7-2-1.8 2.7-.3z" />
    </g>
  ),
  sword: (
    <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.5 4.5H19.5V9.5L10 19l-5-5z" />
      <path d="M4 15l5 5M3 21l2.5-2.5" />
    </g>
  ),
  shield: (
    <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l7 3v5c0 4.6-3 8.2-7 10-4-1.8-7-5.4-7-10V6z" />
    </g>
  ),
  plus: <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />,
  play: <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" />,
  pause: <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor" />,
  step: <path d="M6 5.5v13l9-6.5zM16 5h3v14h-3z" fill="currentColor" />,
  ff: <path d="M3 5.5v13l8.5-6.5zM12 5.5v13l8.5-6.5z" fill="currentColor" />,
  users: (
    <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="8.5" r="3.3" />
      <path d="M3 19.5c.6-3.4 3-5.2 6-5.2s5.4 1.8 6 5.2" />
      <circle cx="16.8" cy="9.2" r="2.6" />
      <path d="M16.5 14.3c2.4.1 4 1.6 4.5 4.2" />
    </g>
  ),
  watch: (
    <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="12" rx="2" />
      <path d="M8 21h8M12 17v4" />
      <path d="M10 8.5v5l4.2-2.5z" fill="currentColor" />
    </g>
  ),
  stats: (
    <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20h16" />
      <rect x="5.5" y="11" width="3" height="7" rx=".8" />
      <rect x="10.5" y="6" width="3" height="12" rx=".8" fill="currentColor" fillOpacity=".2" />
      <rect x="15.5" y="9" width="3" height="9" rx=".8" />
    </g>
  ),
  rules: (
    <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 5.5C6.5 4 9.5 4 12 5.5v14C9.5 18 6.5 18 4 19.5z" />
      <path d="M20 5.5C17.5 4 14.5 4 12 5.5v14c2.5-1.5 5.5-1.5 8 0z" fill="currentColor" fillOpacity=".12" />
    </g>
  ),
  lab: (
    <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 3h6M10 3v6l-5.2 9.2A2 2 0 0 0 6.5 21h11a2 2 0 0 0 1.7-2.8L14 9V3" />
      <path d="M7.5 15h9" />
    </g>
  ),
  globe: (
    <g fill="none" stroke="currentColor" strokeWidth="1.7">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.6 2.6 3.6 5.3 3.6 8.5s-1 5.9-3.6 8.5c-2.6-2.6-3.6-5.3-3.6-8.5s1-5.9 3.6-8.5z" />
    </g>
  ),
  close: <path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />,
  flame: <path d="M12 2.5c1 3.4 5.5 5.6 5.5 10.6A5.5 5.5 0 0 1 12 18.6a5.5 5.5 0 0 1-5.5-5.5c0-2.4 1.2-3.9 2.3-5 .2 1.6.9 2.6 1.9 3.1C10.4 8 11 5.2 12 2.5z" fill="currentColor" />,
  sort: (
    <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.5" y="6" width="7" height="11" rx="1.5" transform="rotate(-10 7 11.5)" />
      <rect x="11" y="5" width="7" height="11" rx="1.5" fill="currentColor" fillOpacity=".15" />
      <path d="M14.5 19.5v-2M12.5 18.5l2 2 2-2" />
    </g>
  ),
  replay: (
    <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 12a8 8 0 1 0 2.4-5.7" />
      <path d="M4 4v4h4" />
      <path d="M10.5 9v6l4.5-3z" fill="currentColor" />
    </g>
  ),
  cards: (
    <g fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
      <rect x="4" y="5" width="11" height="15" rx="2" transform="rotate(-10 9.5 12.5)" />
      <rect x="9" y="4" width="11" height="15" rx="2" fill="currentColor" fillOpacity=".15" />
    </g>
  ),
};

export function Icon({ name, size, className, style }: { name: keyof typeof P | string; size?: number; className?: string; style?: CSSProperties }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} style={style} aria-hidden="true" focusable="false">
      {P[name] ?? null}
    </svg>
  );
}

/** Khokhloma flourish divider (240x28). */
export function Flourish({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 240 28" className={className} aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <path d="M120 14c-14 0-22-9-36-9-12 0-18 6-30 6S34 6 24 9c-6 2-9 5-14 5" />
        <path d="M120 14c14 0 22-9 36-9 12 0 18 6 30 6s20-5 30-2c6 2 9 5 14 5" />
        <path d="M120 14c-12 0-20 8-32 8-8 0-12-3-18-3" />
        <path d="M120 14c12 0 20 8 32 8 8 0 12-3 18-3" />
      </g>
      <g fill="currentColor">
        <circle cx="120" cy="14" r="4.2" />
        <circle cx="66" cy="5.6" r="2.6" />
        <circle cx="174" cy="5.6" r="2.6" />
        <circle cx="8" cy="14" r="2" />
        <circle cx="232" cy="14" r="2" />
      </g>
      <g fill="#c8361f">
        <circle cx="100" cy="10" r="3" />
        <circle cx="105" cy="6.6" r="2.4" />
        <circle cx="140" cy="10" r="3" />
        <circle cx="135" cy="6.6" r="2.4" />
      </g>
    </svg>
  );
}

/** Suit glyph (mask-based, inherits the 4-colour palette). */
export function Suit({ s, className = "" }: { s: number; className?: string }) {
  return <i className={`suit s${s} ${className}`} aria-hidden="true" />;
}
