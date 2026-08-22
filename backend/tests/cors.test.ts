import { describe, expect, it } from "vitest";
import { isAllowedOrigin } from "../src/lib/cors.js";

const APP = "https://stellar-trust-frontend.vercel.app";
const PREVIEW = "https://stellar-trust-frontend-*.vercel.app";

describe("isAllowedOrigin", () => {
  it("allows an exactly configured origin", () => {
    expect(isAllowedOrigin(APP, [APP])).toBe(true);
  });

  it("rejects an origin that is not configured", () => {
    expect(isAllowedOrigin("https://evil.example.com", [APP])).toBe(false);
  });

  it("matches a Vercel preview subdomain via the wildcard entry", () => {
    expect(
      isAllowedOrigin(
        "https://stellar-trust-frontend-git-abc123.vercel.app",
        [APP, PREVIEW],
      ),
    ).toBe(true);
  });

  it("keeps a wildcard inside one host label", () => {
    // Would match under a naive `.*`, letting any host that merely ends with
    // the configured suffix through.
    expect(
      isAllowedOrigin("https://evil.stellar-trust-frontend-x.vercel.app", [
        PREVIEW,
      ]),
    ).toBe(false);
  });

  it("does not let a wildcard cross into another domain", () => {
    expect(
      isAllowedOrigin("https://stellar-trust-frontend-x.evil.com", [PREVIEW]),
    ).toBe(false);
  });

  it("treats the entry as a literal, not a regular expression", () => {
    expect(isAllowedOrigin("https://a-b.vercel.app", ["https://a.b.vercel.app"]))
      .toBe(false);
  });
});

describe("configured origins are normalized before matching", () => {
  // The regression this whole module exists for: a dashboard value typed with
  // a trailing slash can never equal an `Origin` header, so every request from
  // the deployed frontend was CORS-blocked and surfaced only as a browser-side
  // "Failed to fetch". Config now normalizes via `new URL(...).origin`.
  it("strips a trailing slash so the browser's Origin still matches", async () => {
    process.env.FRONTEND_ORIGINS = `${APP}/`;
    const { config } = await import("../src/config/index.js");
    expect(config.FRONTEND_ORIGINS).toContain(APP);
    expect(isAllowedOrigin(APP, config.FRONTEND_ORIGINS)).toBe(true);
  });
});
