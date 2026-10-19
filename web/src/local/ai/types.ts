import type { DurakGame } from "../engine";

/** Bot interface consumed by the local session (see ../ENGINE_API.md). */
export interface Agent {
  name: string;
  /** Called at the start of every game. */
  reset?(): void;
  /** Action for `player` (the player to move). `game` may be the real game or a
   * determinized copy: agents only use what `player` is entitled to know. */
  act(game: DurakGame, player: number): Promise<number>;
  /** P(`player` is NOT the durak) in [0, 1]. */
  evaluate?(game: DurakGame, player: number): Promise<number>;
  /** Policy over the legal actions of the player to move (action -> probability). */
  policy?(game: DurakGame, player: number): Promise<Map<number, number>>;
}

export interface AgentOptions {
  seed?: number;
  [k: string]: unknown;
}
