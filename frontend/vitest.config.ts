/**
 * Frontend test configuration (plane.md §4.6).
 *
 * The frontend had zero tests. That is defensible for presentational markup
 * and indefensible for the three flows that decide whether money moves
 * correctly from a user's point of view: buying units, moving an escrow order
 * through its states, and filing a dispute.
 *
 * jsdom rather than a real browser: these assert component behaviour — what is
 * disabled, what is sent, what a refusal says — not rendering. A browser would
 * add minutes to CI to test what jsdom already answers.
 */
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
