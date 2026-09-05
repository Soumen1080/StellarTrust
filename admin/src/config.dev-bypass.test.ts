/**
 * The development wallet bypass cannot reach a deployment.
 *
 * `ADMIN_DEV_SKIP_WALLET` removes a factor. That is acceptable on a laptop and
 * unacceptable anywhere else, and the failure mode is silent: a flag left on
 * in a hosting dashboard looks identical to one that was never set. So the
 * config refuses to boot rather than ignoring it, and this pins that shut.
 *
 * Config is read once at module load, so each case runs in its own module
 * registry via `vi.resetModules()`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** The minimum a valid config needs, so only the flag under test varies. */
function baseEnv(nodeEnv: string): void {
  process.env.NODE_ENV = nodeEnv;
  process.env.DATABASE_URL = "postgresql://localhost:5432/test";
  process.env.ADMIN_PASSWORD_HASH = "scrypt$65536$8$1$" + "a".repeat(32) + "$" + "b".repeat(128);
  process.env.SESSION_SECRET = "s".repeat(40);
  process.env.ADMIN_WALLET = "GAEOFN7X2JSDH5BSM46P7EDDFRKFEJMW7PTSDOGBDGHUPOM7MEXSIZQE";
  process.env.ADMIN_REVIEWER_USER_ID = "11111111-2222-4333-8444-555555555555";
}

beforeEach(() => {
  vi.resetModules();
  delete process.env.ADMIN_DEV_SKIP_WALLET;
});

describe("the wallet bypass is development-only", () => {
  it.each(["production", "staging", "test"])(
    "refuses to boot with the flag set and NODE_ENV=%s",
    async (nodeEnv) => {
      // Refusing beats ignoring. A console that starts and quietly enforces
      // two factors leaves the operator believing something false about their
      // setup; one that starts and honours the flag is a factor down. Neither
      // is acceptable, so the answer is not to start.
      baseEnv(nodeEnv);
      process.env.ADMIN_DEV_SKIP_WALLET = "true";
      await expect(import("./config.js")).rejects.toThrow(
        /ADMIN_DEV_SKIP_WALLET/,
      );
    },
  );

  it("allows it in development", async () => {
    baseEnv("development");
    process.env.ADMIN_DEV_SKIP_WALLET = "true";
    const { config } = await import("./config.js");
    expect(config.ADMIN_DEV_SKIP_WALLET).toBe(true);
  });

  it("is off unless explicitly enabled", async () => {
    // A shortcut that defaults on is one nobody remembers choosing.
    baseEnv("development");
    const { config } = await import("./config.js");
    expect(config.ADMIN_DEV_SKIP_WALLET).toBe(false);
  });

  it("boots in production when the flag is absent", async () => {
    baseEnv("production");
    const { config } = await import("./config.js");
    expect(config.ADMIN_DEV_SKIP_WALLET).toBe(false);
  });

  it("treats any value other than true/1 as off", async () => {
    // "false", "no", "off" must not enable it by being truthy strings.
    baseEnv("development");
    process.env.ADMIN_DEV_SKIP_WALLET = "false";
    const { config } = await import("./config.js");
    expect(config.ADMIN_DEV_SKIP_WALLET).toBe(false);
  });
});
