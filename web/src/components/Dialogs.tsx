import { useEffect, useState, type ReactNode } from "react";
import { api, type BotsResponse, type GameState, type StatsResponse } from "../api";
import { SuitIcon } from "./Card";
import { Avatar } from "./Board";

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
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal ${wide ? "wide" : ""} ${className}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2>{title}</h2>
          {onClose && (
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" title="Close (Esc)">
              ✕
            </button>
          )}
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

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
  const [s, setS] = useState<Settings>(initial);
  const names = bots?.bots ?? [];
  const n = s.numPlayers;
  const set = (patch: Partial<Settings>) => setS((prev) => ({ ...prev, ...patch }));
  const seatBots = Array.from({ length: n }, (_, i) => s.seatBots[i] ?? s.bot);
  const seatValid = s.seat === "random" || s.seat < n;

  return (
    <Modal title="New game" onClose={onClose} className="newgame">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onStart({ ...s, seat: seatValid ? s.seat : 0, seatBots });
        }}
      >
        <div className="field">
          <label>Mode</label>
          <div className="seg">
            <button type="button" className={!s.spectate ? "on" : ""} onClick={() => set({ spectate: false })}>
              Play vs bots
            </button>
            <button type="button" className={s.spectate ? "on" : ""} onClick={() => set({ spectate: true })}>
              Watch bots
            </button>
          </div>
        </div>
        <div className="field">
          <label>Players</label>
          <div className="seg" role="radiogroup" aria-label="Number of players">
            {[2, 3, 4, 5, 6].map((k) => (
              <button
                type="button"
                key={k}
                className={n === k ? "on" : ""}
                onClick={() => set({ numPlayers: k })}
                aria-pressed={n === k}
                data-players={k}
              >
                {k}
              </button>
            ))}
          </div>
          <div className="hint">{s.spectate ? `${n} bots` : `You + ${n - 1} bot${n > 2 ? "s" : ""}`}</div>
        </div>
        <div className="field">
          <label htmlFor="bot">Bot</label>
          <select id="bot" value={s.bot} onChange={(e) => set({ bot: e.target.value, seatBots: [] })}>
            {names.map((b) => (
              <option key={b.name} value={b.name}>
                {b.label}
                {b.name === bots?.default ? " (strongest available)" : ""}
              </option>
            ))}
          </select>
          <label className="check">
            <input type="checkbox" checked={s.perSeat} onChange={(e) => set({ perSeat: e.target.checked })} /> Choose per seat
          </label>
        </div>
        {!s.spectate && (
          <div className="field">
            <label htmlFor="seat">Your seat</label>
            <select
              id="seat"
              value={String(seatValid ? s.seat : 0)}
              onChange={(e) => set({ seat: e.target.value === "random" ? "random" : Number(e.target.value) })}
            >
              <option value="random">Random</option>
              {Array.from({ length: n }, (_, i) => (
                <option key={i} value={i}>
                  Seat {i + 1}
                </option>
              ))}
            </select>
            <div className="hint">Play passes clockwise in seat order; the lowest trump leads first.</div>
          </div>
        )}
        {s.perSeat && (
          <div className="field seats">
            <label>Seats</label>
            <div className="seat-grid">
              {seatBots.map((b, i) => {
                const isHuman = !s.spectate && seatValid && s.seat === i;
                return (
                  <div key={i} className="seat-row">
                    <span>Seat {i + 1}</span>
                    {isHuman ? (
                      <span className="you">You</span>
                    ) : (
                      <select
                        value={b}
                        onChange={(e) => {
                          const next = [...seatBots];
                          next[i] = e.target.value;
                          set({ seatBots: next });
                        }}
                      >
                        {names.map((x) => (
                          <option key={x.name} value={x.name}>
                            {x.label}
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
        <div className="field row2">
          <div>
            <label htmlFor="seed">Seed</label>
            <input id="seed" inputMode="numeric" placeholder="random" value={s.seed} onChange={(e) => set({ seed: e.target.value.replace(/[^0-9]/g, "") })} />
          </div>
          {!s.spectate && (
            <label className="check debug-check" title="Shows the bots' hidden cards. Games played with this on are flagged in stats.">
              <input type="checkbox" checked={s.debug} onChange={(e) => set({ debug: e.target.checked })} /> Debug: reveal bot hands
            </label>
          )}
        </div>
        <div className="modal-actions">
          {onClose && (
            <button type="button" className="btn ghost" onClick={onClose}>
              Cancel
            </button>
          )}
          <button type="submit" className="btn primary" data-testid="start-game" disabled={!names.length}>
            {s.spectate ? "Start watching" : "Deal cards"}
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
}: {
  state: GameState;
  onAgain: () => void;
  onNew: () => void;
  onClose: () => void;
}) {
  const res = state.result;
  const loser = state.loser;
  const durak = loser !== null ? state.players[loser] : null;
  const human = state.human_seat !== null ? state.players[state.human_seat] : null;
  let headline: string;
  let tone: string;
  if (!res || res.draw) {
    headline = "Draw — nobody is the durak";
    tone = "draw";
  } else if (human && res.human === "durak") {
    headline = "You are the Durak!";
    tone = "lose";
  } else if (human) {
    headline = res.place === 1 ? "You went out first!" : `You escaped — place #${res.place}`;
    tone = "win";
  } else {
    headline = `${durak?.name} is the Durak`;
    tone = "draw";
  }
  const order = [...state.finished, ...(loser !== null ? [loser] : [])];
  return (
    <Modal title="Game over" onClose={onClose} className={`gameover tone-${tone}`}>
      <div className="go-headline" data-testid="game-over">
        {headline}
      </div>
      {durak && (
        <div className="go-durak">
          <Avatar player={durak} size={44} />
          <div>
            <div className="go-label">Durak</div>
            <div className="go-name">
              {durak.name}
              {durak.bot ? <span className="bot-tag">{durak.bot}</span> : null}
            </div>
          </div>
        </div>
      )}
      <ol className="go-order">
        {order.map((seat, i) => {
          const p = state.players[seat];
          return (
            <li key={seat} className={seat === loser ? "durak" : ""}>
              <span className="place">{seat === loser ? "D" : i + 1}</span>
              <span>{p.name}</span>
              {p.bot && <span className="bot-tag">{p.bot}</span>}
            </li>
          );
        })}
      </ol>
      <div className="go-meta">
        {state.num_players} players · {state.moves} moves{state.seed != null ? ` · seed ${state.seed}` : ""}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onNew}>
          Settings…
        </button>
        <button type="button" className="btn primary" onClick={onAgain} data-testid="play-again" autoFocus>
          Play again
        </button>
      </div>
    </Modal>
  );
}

const pct = (x: number | null | undefined) => (x === null || x === undefined ? "—" : `${(x * 100).toFixed(1)}%`);

export function StatsDialog({ onClose }: { onClose: () => void }) {
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.stats().then(setStats, (e) => setErr(String(e)));
  }, []);
  return (
    <Modal title="Statistics" onClose={onClose} wide className="stats">
      {err && <div className="error">{err}</div>}
      {!stats && !err && <div className="loading">Loading…</div>}
      {stats && (
        <>
          <div className="stat-tiles">
            <div className="tile">
              <b>{stats.human_games}</b>
              <span>games played</span>
            </div>
            <div className="tile">
              <b>{stats.human_durak}</b>
              <span>times you were durak</span>
            </div>
            <div className="tile">
              <b>{pct(stats.human_durak_rate)}</b>
              <span>your durak rate</span>
            </div>
            <div className="tile">
              <b>{stats.spectated_games}</b>
              <span>bot-vs-bot games</span>
            </div>
          </div>
          <h3>You, by number of players</h3>
          {stats.by_players.length === 0 ? (
            <p className="muted">No finished games yet.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Players</th>
                    <th>Games</th>
                    <th>Durak</th>
                    <th>Durak rate</th>
                    <th>Fair share</th>
                    <th>Avg place</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.by_players.map((r) => (
                    <tr key={r.num_players}>
                      <td>{r.num_players}</td>
                      <td>{r.games}</td>
                      <td>{r.human_durak}</td>
                      <td className={r.human_durak_rate !== null && r.human_durak_rate > r.expected_durak_rate ? "bad" : "good"}>
                        {pct(r.human_durak_rate)}
                      </td>
                      <td className="muted">{pct(r.expected_durak_rate)}</td>
                      <td>{r.avg_place ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h3>By bot</h3>
          {stats.by_bot.length === 0 ? (
            <p className="muted">No finished games yet.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Bot</th>
                    <th>Seats</th>
                    <th>Bot durak</th>
                    <th>Fair share</th>
                    <th>Games vs you</th>
                    <th>You durak</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.by_bot.map((r) => (
                    <tr key={r.bot}>
                      <td>
                        <span className="bot-tag">{r.bot}</span>
                      </td>
                      <td>{r.seats}</td>
                      <td className={r.durak_rate !== null && r.expected_durak_rate !== null && r.durak_rate < r.expected_durak_rate ? "good" : ""}>
                        {pct(r.durak_rate)}
                      </td>
                      <td className="muted">{pct(r.expected_durak_rate)}</td>
                      <td>{r.human_games}</td>
                      <td>{pct(r.human_durak_rate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted small">
            “Fair share” is the durak rate expected by chance (1/N per seat). A bot below its fair share is beating the table.
          </p>
          {stats.recent.length > 0 && (
            <>
              <h3>Recent games</h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>N</th>
                      <th>Seats</th>
                      <th>Result</th>
                      <th>Moves</th>
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
                              {x === "human" ? "you" : x}
                            </span>
                          ))}
                        </td>
                        <td>
                          {r.mode === "spectate"
                            ? r.loser === null
                              ? "draw"
                              : `seat ${r.loser + 1} durak`
                            : r.human_result === "durak"
                              ? "you: durak"
                              : r.human_result === "draw"
                                ? "draw"
                                : `you: #${r.human_place}`}
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
  return (
    <Modal title="How to play Podkidnoy Durak" onClose={onClose} wide className="rules">
      <div className="rules-grid">
        <section>
          <h3>Goal</h3>
          <p>
            Get rid of all your cards. The last player still holding cards is the <b>durak</b> (“fool”). 36-card deck (6 to Ace), 6 cards each. The
            card under the talon sets the <b>trump</b> suit <SuitIcon suit={3} size={12} />; it is drawn last.
          </p>
          <h3>A bout</h3>
          <p>
            The <b>attacker</b> leads any card against the next player clockwise, the <b>defender</b>. The defender must beat each card with a higher
            card of the same suit, or any trump (trump vs trump by rank) — or <b>Take</b> the whole table.
          </p>
          <p>
            Once all cards are covered, the <b>throwers</b> may add cards whose rank is already on the table. Only the main attacker and the
            defender’s other neighbour may throw in. At most 6 attack cards per bout (5 in the very first bout), and never more than the defender held
            at the start.
          </p>
        </section>
        <section>
          <h3>Ending a bout</h3>
          <ul>
            <li>
              <b>Bita</b> — every thrower passes in turn: the table is discarded and the defender attacks next. A co-thrower’s pass alone is just
              <b> Pass</b>; the bout ends with the last thrower’s pass.
            </li>
            <li>
              <b>Take</b> — the defender gives up. Throwers may add more cards, then say <b>Done</b>; the defender picks everything up (those cards
              become known to all) and loses their turn to attack.
            </li>
          </ul>
          <p>After each bout everyone refills to 6 from the talon: attacker first, defender last. With an empty talon, players without cards are out.</p>
          <h3>Keyboard</h3>
          <ul className="keys">
            <li>
              <kbd>1</kbd>–<kbd>9</kbd> play the numbered card
            </li>
            <li>
              <kbd>←</kbd> <kbd>→</kbd> select, <kbd>Enter</kbd> play selected
            </li>
            <li>
              <kbd>Space</kbd> Bita / Pass / Take / Done (or skip animation)
            </li>
            <li>
              <kbd>N</kbd> new game · <kbd>S</kbd> stats · <kbd>L</kbd> log · <kbd>D</kbd> debug · <kbd>?</kbd> help
            </li>
          </ul>
        </section>
      </div>
    </Modal>
  );
}
