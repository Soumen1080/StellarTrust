import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    globals: false,
    reporters: "default",
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      // Force the deterministic KYC decision path in tests regardless of the
      // developer's local .env (which enables the dev auto-approve shortcut).
      // Keeps tests matching CI without changing dev runtime behavior.
      KYC_AUTO_APPROVE: "false",
    },
  },
});
