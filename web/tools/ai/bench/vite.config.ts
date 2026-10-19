// Standalone build of the AI bench page, under the same /DurakBot/ base as the site.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = fileURLToPath(new URL(".", import.meta.url));
export default defineConfig({
  root: here,
  base: "/DurakBot/",
  publicDir: fileURLToPath(new URL("../../../public", import.meta.url)),
  worker: { format: "es" },
  build: {
    outDir: process.env.BENCH_OUT ?? join(tmpdir(), "durak-ai-bench"),
    emptyOutDir: true,
    sourcemap: false,
    copyPublicDir: true,
  },
});
