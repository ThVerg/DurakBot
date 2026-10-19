/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "local" = run the game, bots and storage in the browser (static build); else the HTTP API. */
  readonly VITE_BACKEND?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
