// Seat plaque: portrait in a gold ring, name, bot level, card count, role chip.
import { useEffect, useState } from "react";
import type { GameState, Player } from "../api";
import { avatarUrl } from "../assets";
import { Avatar } from "../components/Avatar";
import { displayName, type Bubble } from "../components/Board";
import { useI18n } from "../i18n";

export function Portrait({ player, size }: { player: Pick<Player, "is_human" | "persona" | "name" | "seat">; size: number }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const id = player.is_human ? "you" : player.persona;
    if (id) avatarUrl(id).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [player.persona, player.is_human]);
  return (
    <span className="portrait" style={{ width: size, height: size }}>
      {url ? <img src={url} alt="" width={size} height={size} draggable={false} /> : <Avatar player={player} size={size} />}
    </span>
  );
}

export function roleChip(p: Player, s: GameState): { cls: string; key: string } | null {
  if (s.done) return p.is_durak ? { cls: "durak", key: "chip.durak" } : p.place ? { cls: "out", key: "chip.out" } : null;
  if (p.out) return { cls: "out", key: "chip.out" };
  if (p.is_defender) return { cls: "defend", key: "chip.defend" };
  if (p.is_attacker) return { cls: "attack", key: "chip.attack" };
  if (p.is_thrower) return { cls: "throw", key: "chip.throw" };
  return null;
}

export function Plaque({
  player,
  state,
  thinking,
  bubble,
  botLabel,
  winProb,
  compact,
}: {
  player: Player;
  state: GameState;
  thinking: boolean;
  bubble?: Bubble | null;
  botLabel?: string;
  winProb?: number;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const chip = roleChip(player, state);
  const cls = [
    "plaque",
    compact ? "compact" : "",
    player.to_move && !state.done ? "to-move" : "",
    thinking ? "thinking-now" : "",
    player.out ? "is-out" : "",
    player.is_durak ? "is-durak" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const name = displayName(player, t);
  return (
    <div className={cls} data-seat={player.seat} aria-label={name}>
      <Portrait player={player} size={compact ? 40 : 52} />
      <div className="plaque-body">
        <div className="pl-name">{name}</div>
        <div className="pl-meta">
          {botLabel && <span className="pl-bot">{botLabel}</span>}
          <span className="pl-count" title={`${player.hand_size}`}>
            <i aria-hidden="true" />
            {player.hand_size}
          </span>
          {winProb !== undefined && <span className="pl-wp">{Math.round(winProb * 100)}%</span>}
        </div>
      </div>
      {chip && (
        <span className={`role-chip ${chip.cls}`}>
          {t(chip.key)}
          {chip.cls === "out" && player.place ? ` #${player.place}` : ""}
        </span>
      )}
      {thinking && (
        <span className="pl-thinking" aria-label={t("status.thinking", { name })}>
          <i />
          <i />
          <i />
        </span>
      )}
      {bubble && (
        <div key={bubble.key} className={`bubble tone-${bubble.tone}`} role="status">
          {bubble.text}
        </div>
      )}
    </div>
  );
}
