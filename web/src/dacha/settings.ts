/** New-game settings (persisted). */
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

export const DEFAULT_SETTINGS: Settings = {
  numPlayers: 2,
  seat: 0,
  bot: "",
  perSeat: false,
  seatBots: [],
  seed: "",
  spectate: false,
  debug: false,
};
