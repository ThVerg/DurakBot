import { defineConfig } from "vitest/config";

// Unit + parity tests for the in-browser backend (web/src/local).
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 120_000,
  },
});
