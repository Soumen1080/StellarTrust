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
      // Tests must not inherit developer-local demo/chain wiring: a placeholder
      // value in someone's .env would otherwise fail config validation at
      // import time and take down every suite that touches config. Blank means
      // "unset" (see optionalEnv in src/config).
      AUTH_DEMO_WALLET: "",
      DEMO_SIGNER_SECRET: "",
      DEMO_MODE: "false",
      ESCROW_GATEWAY: "deterministic",
      RWA_GATEWAY: "deterministic",
      ESCROW_WASM_HASH: "",
      RWA_WASM_HASH: "",
    },
  },
});
