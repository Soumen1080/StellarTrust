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
    },
  },
});
