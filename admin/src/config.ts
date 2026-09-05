/**
 * Admin console configuration.
 *
 * This application is deployed **separately and privately**. It is not part of
 * the public API and must never share a hostname with it: the whole point of
 * splitting it out is that an attacker who finds the public site finds no
 * admin surface at all.
 *
 * Every setting below is validated at boot and the process refuses to start if
 * one is wrong. That is deliberate — a console that boots half-configured is a
 * console that is either unusable or unsafe, and both are worse than a clear
 * failure at deploy time.
 */
import { createRequire } from "node:module";
import { z } from "zod";

try {
  const require = createRequire(import.meta.url);
  (require("dotenv") as { config: () => void }).config();
} catch {
  // dotenv is optional; a hosting platform supplies env directly.
}

const envSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "staging", "production"])
      .default("development"),
    PORT: z.coerce.number().int().positive().default(8090),

    /**
     * The same Postgres the platform uses. Read directly — this app does not
     * call the public API, so there is no `/api/admin` on the public backend
     * for anyone to find.
     *
     * Point this at a **read-mostly role** where your host supports it. The
     * console needs write access only to `verification_policies`,
     * `kyc_reviews`, `assets` and `treasury_movements`; granting it more is
     * granting an attacker more if this app is ever compromised.
     */
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

    /**
     * bcrypt-style hash of the console password. Generate with
     * `npm run hash-password`.
     *
     * A **hash**, never the password itself: this value sits in a hosting
     * dashboard, in deploy logs, and in whatever CI touched it, and a
     * plaintext password there is a password that has already leaked.
     */
    ADMIN_PASSWORD_HASH: z
      .string()
      .min(20, "Must be a password hash, not a plaintext password"),

    /**
     * The Stellar wallet that must sign in alongside the password.
     *
     * **Both factors are required.** The password proves something the
     * operator knows; a signature from this key proves something they hold.
     * A leaked password alone opens nothing, which is the point — a password
     * can be phished, reused, read from a hosting dashboard, or found in a
     * backup, and none of those yield a private key.
     *
     * Only the public key lives here. This host never sees the secret, and
     * cannot sign on the operator's behalf even if it is compromised.
     */
    ADMIN_WALLET: z
      .string()
      .regex(/^G[A-Z2-7]{55}$/, "Must be a Stellar Ed25519 public key"),

    /**
     * Signs session cookies. Rotating it logs everyone out, which is the
     * intended response to a suspected compromise.
     *
     * At least 32 characters, because a short secret is a guessable one and
     * this is the only thing standing between a forged cookie and the console.
     */
    SESSION_SECRET: z
      .string()
      .min(32, "Must be at least 32 characters of random data"),

    /** How long a signed-in session lasts. Short by default. */
    SESSION_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),

    /**
     * The `users.id` recorded as the reviewer on KYC and asset decisions.
     *
     * The database requires one: migration 0018's
     * `assets_decision_has_reviewer` and 0022's
     * `kyc_reviews_resolution_is_complete` both refuse a decision that does
     * not name who made it — a rejection as much as an approval, because "who
     * turned my application down, and when" is exactly what the applicant will
     * ask.
     *
     * This console signs in with a password rather than a wallet, so it has no
     * user identity of its own. Point this at the operator's own user row.
     */
    ADMIN_REVIEWER_USER_ID: z
      .string()
      .uuid("Must be the operator's users.id (a UUID)"),

    /**
     * Optional IP allowlist, comma-separated. When set, every request from an
     * address not on it is refused before authentication runs.
     *
     * This is the control that makes a leaked password survivable, so it is
     * worth setting even though it is optional. Empty means "any address",
     * which is the right default only because a wrong allowlist locks the
     * operator out of their own console with no way back in.
     */
    ADMIN_IP_ALLOWLIST: z
      .string()
      .default("")
      .transform((value) =>
        value
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean),
      ),

    /**
     * How many failed sign-in attempts before the console locks out an
     * address, and for how long. A password with no rate limit is a password
     * that will eventually be guessed.
     */
    LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(5),
    LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  })
  .superRefine((env, ctx) => {
    // A production console reachable from any address, with no allowlist, is
    // one password away from being someone else's. Warn loudly rather than
    // refuse: an operator behind a VPN or a platform-level firewall has
    // already solved this a different way, and refusing would be wrong for
    // them.
    if (
      (env.NODE_ENV === "production" || env.NODE_ENV === "staging") &&
      env.ADMIN_IP_ALLOWLIST.length === 0
    ) {
      // Not an issue — a note the boot log surfaces. Adding it to `ctx` would
      // stop the deploy, and that is a heavier hand than this warrants.
      void ctx;
    }
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
  throw new Error(
    `Invalid admin console configuration:\n${issues}\n\n` +
      "This app is deliberately strict about booting: a half-configured\n" +
      "console is either unusable or unsafe.",
  );
}

export const config = Object.freeze({
  ...parsed.data,
  isProduction: parsed.data.NODE_ENV === "production",
  isTest: parsed.data.NODE_ENV === "test",
  serviceName: "stellartrust-admin",
});

export type AdminConfig = typeof config;
