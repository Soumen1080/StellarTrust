// Flat ESLint config (ESLint 9). Lint step for CI (Phase 0).
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
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
