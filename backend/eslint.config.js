// Flat ESLint config (ESLint 9). Lint step for CI (Phase 0).
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Ad hoc scripts used for manual local debugging against a live/testnet
    // backend, not part of the app or its test suite.
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "_apply_0007.mjs",
      "_diag_dispute_err.mjs",
      "_diag_http.mjs",
      "_diag_order.mjs",
      "_diag_probe_deployed.mjs",
      "_diag_schema.mjs",
      "_genkey.mjs",
      "_mkseller.mjs",
      "test-create-order.js",
      "test-db-connection.js",
      "test-full-order-flow.js",
      "tmp-db-check.mjs",
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": "warn",
    },
  },
  {
    // Operator-facing CLI tools: their output *is* the interface, so the
    // structured logger (which writes JSON to a log sink) is the wrong channel.
    files: ["src/scripts/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },
);
