// Illustrated bot personas (inline SVG) and their speech lines.
import type { Player } from "../api";

const BG: Record<string, string> = {
  zina: "#f28482",
  misha: "#3d8bfd",
  sveta: "#c77dff",
  kostya: "#f4a261",
  lev: "#81b29a",
  dasha: "#4ecdc4",
  grisha: "#e9c46a",
};

const SKIN = "#f6d2b3";
const INK = "#2b2118";

function Face({ cheeks = true }: { cheeks?: boolean }) {
  return (
    <g>
      <circle cx="32" cy="34" r="14" fill={SKIN} />
      <circle cx="27" cy="33" r="1.6" fill={INK} />
      <circle cx="37" cy="33" r="1.6" fill={INK} />
      {cheeks && (
        <>
          <circle cx="24" cy="38" r="2.4" fill="#f29c9c" opacity="0.6" />
          <circle cx="40" cy="38" r="2.4" fill="#f29c9c" opacity="0.6" />
        </>
      )}
      <path d="M28 40 Q32 43 36 40" stroke={INK} strokeWidth="1.4" fill="none" strokeLinecap="round" />
    </g>
  );
}

function Shoulders({ color }: { color: string }) {
  return <path d="M10 64 C12 52 22 47 32 47 C42 47 52 52 54 64 Z" fill={color} />;
}

function Persona({ k }: { k: string }) {
  switch (k) {
    case "zina": // babushka with a polka-dot headscarf
      return (
        <g>
          <Shoulders color="#7b2d26" />
          <Face />
          <path d="M16 36 C14 18 50 14 48 36 C46 26 40 21 32 21 C24 21 18 26 16 36 Z" fill="#c1121f" />
          <path d="M18 40 L14 52 L22 46 Z M46 40 L50 52 L42 46 Z" fill="#c1121f" />
          {[[24, 23], [32, 20], [40, 23], [20, 30], [44, 30]].map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r="1.6" fill="#fff" />
          ))}
          <circle cx="27" cy="33" r="3.2" fill="none" stroke={INK} strokeWidth="0.9" />
          <circle cx="37" cy="33" r="3.2" fill="none" stroke={INK} strokeWidth="0.9" />
        </g>
      );
    case "misha": // uncle in an ushanka, moustache
      return (
        <g>
          <Shoulders color="#344e41" />
          <Face cheeks={false} />
          <path d="M17 31 C17 14 47 14 47 31 L47 33 L17 33 Z" fill="#6b4f3a" />
          <rect x="15" y="27" width="34" height="7" rx="3.5" fill="#a98467" />
          <rect x="13" y="30" width="7" height="14" rx="3.5" fill="#a98467" />
          <rect x="44" y="30" width="7" height="14" rx="3.5" fill="#a98467" />
          <circle cx="32" cy="22" r="2.4" fill="#e63946" />
          <path d="M25 39 Q32 35 39 39 Q35 41 32 39 Q29 41 25 39 Z" fill="#5c4033" />
        </g>
      );
    case "sveta": // long hair, earrings
      return (
        <g>
          <path d="M14 56 C12 30 18 18 32 18 C46 18 52 30 50 56 Z" fill="#e9c46a" />
          <Shoulders color="#5a189a" />
          <Face />
          <path d="M18 32 C18 20 46 18 46 32 C40 26 30 24 18 32 Z" fill="#e9c46a" />
          <circle cx="18.5" cy="40" r="1.8" fill="#ffd166" />
          <circle cx="45.5" cy="40" r="1.8" fill="#ffd166" />
        </g>
      );
    case "kostya": // backwards cap
      return (
        <g>
          <Shoulders color="#264653" />
          <Face cheeks={false} />
          <path d="M18 30 C18 18 46 18 46 30 Z" fill="#e76f51" />
          <rect x="12" y="27" width="12" height="4" rx="2" fill="#c44536" />
          <circle cx="32" cy="20" r="1.5" fill="#fff" />
          <path d="M26 31 L29 30 M35 30 L38 31" stroke={INK} strokeWidth="1.2" />
        </g>
      );
    case "lev": // professor: glasses, grey hair, bow tie
      return (
        <g>
          <Shoulders color="#3a3a3a" />
          <path d="M28 49 L32 51 L36 49 L36 53 L32 51 L28 53 Z" fill="#c1121f" />
          <Face cheeks={false} />
          <path d="M17 30 C17 22 22 20 24 23 C26 18 38 18 40 23 C42 20 47 22 47 30 C45 26 42 26 40 27 C36 23 28 23 24 27 C22 26 19 26 17 30 Z" fill="#d9d9d9" />
          <circle cx="27" cy="33" r="4" fill="none" stroke={INK} strokeWidth="1.3" />
          <circle cx="37" cy="33" r="4" fill="none" stroke={INK} strokeWidth="1.3" />
          <path d="M31 33 L33 33" stroke={INK} strokeWidth="1.3" />
        </g>
      );
    case "dasha": // braids
      return (
        <g>
          <Shoulders color="#ef476f" />
          <path d="M16 36 C14 46 14 54 18 58 C21 54 20 46 20 38 Z M48 36 C50 46 50 54 46 58 C43 54 44 46 44 38 Z" fill="#7f4f24" />
          <Face />
          <path d="M18 34 C16 18 48 18 46 34 C42 25 36 24 32 26 C28 24 22 25 18 34 Z" fill="#7f4f24" />
          <circle cx="18" cy="57" r="2.2" fill="#ffd166" />
          <circle cx="46" cy="57" r="2.2" fill="#ffd166" />
        </g>
      );
    case "grisha": // beard and beanie
      return (
        <g>
          <Shoulders color="#6d597a" />
          <Face cheeks={false} />
          <path d="M19 36 C19 52 45 52 45 36 C42 42 38 44 32 44 C26 44 22 42 19 36 Z" fill="#8d5524" />
          <path d="M28 40 Q32 42 36 40" stroke="#f6d2b3" strokeWidth="1.4" fill="none" strokeLinecap="round" />
          <path d="M18 30 C18 14 46 14 46 30 Z" fill="#2a9d8f" />
          <rect x="17" y="27" width="30" height="5" rx="2.5" fill="#21867a" />
          <circle cx="32" cy="15" r="3" fill="#e9c46a" />
        </g>
      );
    default:
      return (
        <g>
          <Shoulders color="#555" />
          <Face />
        </g>
      );
  }
}

export function Avatar({ player, size = 40 }: { player: Pick<Player, "is_human" | "persona" | "name" | "seat">; size?: number }) {
  if (player.is_human) {
    return (
      <div className="avatar human" style={{ width: size, height: size, fontSize: size * 0.46 }} aria-hidden="true">
        ★
      </div>
    );
  }
  const k = player.persona ?? "";
  return (
    <svg className="avatar" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <clipPath id={`av-clip-${k || "x"}`}>
          <circle cx="32" cy="32" r="32" />
        </clipPath>
      </defs>
      <g clipPath={`url(#av-clip-${k || "x"})`}>
        <rect width="64" height="64" fill={BG[k] ?? "#888"} />
        <circle cx="32" cy="10" r="40" fill="#fff" opacity="0.12" />
        <Persona k={k} />
      </g>
    </svg>
  );
}

/** Pick a speech line key for an event, or null (bots don't talk every time). */
export function speechKey(event: "take" | "out" | "bita" | "durak" | "winVsYou", seed: number, prob = 0.45): string | null {
  const counts = { take: 3, out: 3, bita: 2, durak: 2, winVsYou: 2 } as const;
  const r = Math.abs(Math.sin(seed * 12.9898) * 43758.5453) % 1;
  if (r > prob) return null;
  return `say.${event}.${Math.floor((r / prob) * counts[event]) % counts[event]}`;
}
