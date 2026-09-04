import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// Unmount between tests. Without this, a query in one test can match a node
// another test left behind, and the failure looks like a component bug.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// `crypto.randomUUID` is what every mutating call uses for its idempotency key
// (Rules.md #4). jsdom's crypto has getRandomValues but not randomUUID.
if (!globalThis.crypto?.randomUUID) {
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    value: () => "00000000-0000-4000-8000-000000000000",
    configurable: true,
  });
}
