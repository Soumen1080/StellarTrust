/**
 * The admin console HTTP application.
 *
 * Deployed separately from the public backend and frontend, on its own host,
 * behind its own password. Nothing here is reachable from the public site.
 *
 * Request pipeline, in order — each layer refuses before the next runs, so the
 * cheapest and broadest checks come first:
 *
 *   1. IP allowlist   — if configured, a wrong address never reaches the form
 *   2. Rate limit     — a password with no throttle is one that gets guessed
 *   3. Session        — every route except /login and /health
 *   4. Handler
 */
import express, { type Express, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import helmetImport from "helmet";
import { config } from "./config.js";
import { verifyPassword } from "./lib/password.js";
import {
  clearCookieHeader,
  clearFailures,
  createSession,
  isLockedOut,
  readSessionCookie,
  recordFailure,
  requireSession,
  sessionCookieHeader,
  verifySession,
} from "./lib/session.js";
import { issueChallenge, verifyWalletProof } from "./lib/wallet.js";
import { createApiRouter } from "./routes/api.js";
import { loginPage } from "./views/login.js";
import { consolePage } from "./views/console.js";

type HelmetFactory = (options?: unknown) => RequestHandler;

function resolveHelmet(imported: unknown): HelmetFactory {
  if (typeof imported === "function") return imported as HelmetFactory;
  if (imported && typeof imported === "object" && "default" in imported) {
    const fallback = (imported as { default: unknown }).default;
    if (typeof fallback === "function") return fallback as HelmetFactory;
  }
  throw new TypeError("Helmet did not expose a callable middleware factory");
}

const helmet = resolveHelmet(helmetImport);

export function createApp(): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use(
    helmet({
      // The console is one self-contained page with an inline script and no
      // external resources at all. Saying so exactly means an injected
      // <script src> from anywhere is refused by the browser.
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
          objectSrc: ["'none'"],
        },
      },
    }),
  );
  app.use(express.urlencoded({ extended: false, limit: "16kb" }));
  app.use(express.json({ limit: "64kb" }));

  // ── 1. IP allowlist ───────────────────────────────────────────────────────
  //
  // Runs before everything, including the login form: an address that is not
  // allowed should not learn that a console exists here, let alone get a
  // password field to try against.
  if (config.ADMIN_IP_ALLOWLIST.length > 0) {
    const allowed = new Set(config.ADMIN_IP_ALLOWLIST);
    app.use((req, res, next) => {
      // `req.ip` respects `trust proxy`, so behind a load balancer this is the
      // real client rather than the balancer's own address.
      const ip = req.ip ?? "";
      // IPv4-mapped IPv6 (`::ffff:1.2.3.4`) is how a v4 client often arrives;
      // an operator writing `1.2.3.4` in the allowlist means that address.
      const normalized = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
      if (allowed.has(ip) || allowed.has(normalized)) {
        next();
        return;
      }
      res.status(404).type("text/plain").send("Not found");
    });
  }

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: config.serviceName });
  });

  // ── 2. Rate limit ─────────────────────────────────────────────────────────
  //
  // Tighter than the public API's, because this console serves one operator.
  // Legitimate traffic here is a handful of requests a minute.
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 120,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

  // ── Sign in ───────────────────────────────────────────────────────────────

  app.get("/login", (req, res) => {
    // Already signed in: skip the form rather than inviting a second password
    // entry that would do nothing.
    if (verifySession(readSessionCookie(req))) {
      res.redirect("/");
      return;
    }
    res.type("html").send(loginPage(null));
  });

  /**
   * Step one of two: the password.
   *
   * A correct password does **not** create a session. It only unlocks a wallet
   * challenge, which must then be signed by the configured key. That ordering
   * is the whole security property: whoever holds a leaked password gets a
   * nonce to sign and nothing else.
   *
   * Returns JSON rather than redirecting, because the wallet step happens in
   * the browser and the page needs to stay put to drive it.
   */
  app.post("/login", async (req, res) => {
    const key = req.ip ?? "unknown";
    const lockedFor = isLockedOut(key);
    if (lockedFor > 0) {
      res.status(429).json({
        error: {
          message: `Too many attempts. Try again in ${Math.ceil(lockedFor / 60)} minute(s).`,
        },
      });
      return;
    }

    const password = (req.body as { password?: unknown })?.password;
    const ok =
      typeof password === "string" &&
      (await verifyPassword(password, config.ADMIN_PASSWORD_HASH));

    if (!ok) {
      recordFailure(key);
      // One message for a wrong password and for a missing one. Distinguishing
      // them tells an attacker which half of their guess was right.
      res.status(401).json({ error: { message: "Incorrect password." } });
      return;
    }

    // Still no session. The password has bought exactly one thing: a challenge.
    const challenge = issueChallenge();
    res.json({
      challengeId: challenge.challengeId,
      message: challenge.message,
      wallet: config.ADMIN_WALLET,
    });
  });

  /**
   * Step two of two: proof of the wallet.
   *
   * The signature is checked against the *configured* public key, never one
   * the request names — a request supplying its own key would be proving
   * control of a key it chose, which proves nothing.
   *
   * A failure here counts toward the same lockout as a wrong password. An
   * attacker who has the password must not get unlimited attempts at the
   * second factor.
   */
  app.post("/login/verify", (req, res) => {
    const key = req.ip ?? "unknown";
    if (isLockedOut(key) > 0) {
      res.status(429).json({
        error: { message: "Too many attempts. Try again later." },
      });
      return;
    }

    const body = (req.body ?? {}) as {
      challengeId?: unknown;
      signature?: unknown;
    };
    if (typeof body.challengeId !== "string" || typeof body.signature !== "string") {
      recordFailure(key);
      res.status(400).json({ error: { message: "Malformed wallet proof." } });
      return;
    }

    const proof = verifyWalletProof(body.challengeId, body.signature);
    if (!proof.ok) {
      recordFailure(key);
      res.status(401).json({ error: { message: proof.reason } });
      return;
    }

    // Both factors are now satisfied. Only here does a session exist.
    clearFailures(key);
    const { cookie, expiresAt } = createSession();
    res.setHeader("set-cookie", sessionCookieHeader(cookie, expiresAt));
    res.json({ ok: true });
  });

  app.post("/logout", (_req, res) => {
    res.setHeader("set-cookie", clearCookieHeader());
    res.redirect("/login");
  });

  // ── 3. Everything below requires a session ────────────────────────────────

  app.use(requireSession);

  app.get("/", (_req, res) => {
    res.type("html").send(consolePage());
  });

  app.use("/api", createApiRouter());

  app.use((_req, res) => {
    res.status(404).type("text/plain").send("Not found");
  });

  // Error boundary. The message is deliberately generic: this console talks to
  // the database directly, and a leaked driver error names tables and columns.
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      console.error("admin console error:", err);
      if (res.headersSent) return;
      res
        .status(500)
        .json({ error: { code: "INTERNAL", message: "Something went wrong" } });
    },
  );

  return app;
}
