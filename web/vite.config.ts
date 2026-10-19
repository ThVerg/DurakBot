import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));

/** HTTP builds never load the in-browser backend (worker, bots, ONNX runtime):
 * its entry is swapped for a stub so none of it is bundled or emitted. */
function stubLocalBackend(): Plugin {
  const STUB = "\0local-backend-stub";
  return {
    name: "durak:stub-local-backend",
    enforce: "pre",
    resolveId(id) {
      return id === "./local/localApi" ? STUB : null;
    },
    load(id) {
      return id === STUB
        ? "export function createLocalApi() { throw new Error('built without VITE_BACKEND=local'); }"
        : null;
    },
  };
}

// VITE_BACKEND=local  -> static build: everything runs in the browser (src/local).
// VITE_BASE=/DurakBot/ -> public path when served from a sub-path (GitHub Pages).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ROOT, "VITE_");
  const local = env.VITE_BACKEND === "local";
  return {
    base: env.VITE_BASE || "/",
    plugins: [react(), ...(local ? [] : [stubLocalBackend()])],
    server: {
      proxy: { "/api": "http://127.0.0.1:8000" },
    },
    build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 1200 },
    // The in-browser backend runs in a module worker that lazy-loads the bots,
    // so worker chunks must be ES modules.
    worker: { format: "es" },
  };
});
