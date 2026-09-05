/**
 * Who may open the operations console.
 *
 * The console shows every user's position, every queue, and the controls that
 * decide verifications and release withdrawals. Access is granted by exactly
 * one thing — a wallet's presence in `ADMIN_WALLETS` — and that is worth a
 * test because the failure is silent in the dangerous direction: a change that
 * accidentally widens the grant looks identical from the outside to one that
 * does not, right up until someone who should not be an administrator opens
 * the panel.
 *
 * The role decision is reproduced here rather than imported, because it lives
 * inside `Sep10Service.verify` behind a signed challenge that a unit test
 * cannot produce. What is asserted is the *rule* — membership decides the
 * role, and nothing else does — plus the route guard that consumes it.
 */
import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { requireRole } from "../../middleware/authorization.js";
import { errorHandler } from "../../middleware/error.js";
import type { AuthedRequest } from "../../middleware/auth.js";

const ADMIN = "GAEOFN7X2JSDH5BSM46P7EDDFRKFEJMW7PTSDOGBDGHUPOM7MEXSIZQE";
const OTHER = "GDYWVMFH5JDIISEZMLDFTN6A5NHPLZGKTTYAAKGB5Z6U7MHKUV6JPVS5";
const THIRD = "GBNPF7BZKNCAS32XWOBWGL7KD6NFHLZO5GQDIJA7Z73B7YISNM4MFZNL";

/**
 * The rule `Sep10Service` applies once a wallet has proved control of its key.
 * Membership in the configured set is the whole of it.
 */
function rolesFor(wallet: string, adminWallets: Set<string>): string[] {
  return adminWallets.has(wallet) ? ["user", "compliance"] : ["user"];
}

describe("only a configured wallet earns the compliance role", () => {
  const admins = new Set([ADMIN]);

  it("grants it to the configured wallet", () => {
    expect(rolesFor(ADMIN, admins)).toContain("compliance");
  });

  it("withholds it from every other wallet", () => {
    for (const wallet of [OTHER, THIRD]) {
      expect(rolesFor(wallet, admins)).not.toContain("compliance");
    }
  });

  it("still gives an ordinary user their own role", () => {
    // Refusing admin must not refuse the platform. A non-admin is a customer,
    // not a stranger.
    expect(rolesFor(OTHER, admins)).toEqual(["user"]);
  });

  it("grants nothing when no administrators are configured", () => {
    // The right default for an unconfigured deployment: a console nobody can
    // open, rather than one everybody can.
    const none = new Set<string>();
    expect(rolesFor(ADMIN, none)).not.toContain("compliance");
  });

  it("is case- and whitespace-exact", () => {
    // Stellar addresses are upper-case base32 and the set is compared by
    // identity. A near-miss must not be treated as a match.
    expect(rolesFor(ADMIN.toLowerCase(), admins)).not.toContain("compliance");
    expect(rolesFor(` ${ADMIN}`, admins)).not.toContain("compliance");
  });

  it("supports more than one administrator", () => {
    // Comma-separated, so a second operator does not require a code change.
    const two = new Set([ADMIN, OTHER]);
    expect(rolesFor(ADMIN, two)).toContain("compliance");
    expect(rolesFor(OTHER, two)).toContain("compliance");
    expect(rolesFor(THIRD, two)).not.toContain("compliance");
  });
});

describe("the route guard the console sits behind", () => {
  /** A router mounted exactly as `createAdminRouter` mounts its guard. */
  function appFor(roles: string[] | null) {
    const app = express();
    app.use((req, _res, next) => {
      if (roles) (req as AuthedRequest).auth = { userId: "u1", roles };
      next();
    });
    app.use(requireRole("compliance"));
    app.get("/metrics", (_req, res) => res.json({ ok: true }));
    app.use(errorHandler);
    return app;
  }

  it("lets a compliance session through", async () => {
    await request(appFor(["user", "compliance"])).get("/metrics").expect(200);
  });

  it("refuses an ordinary signed-in user with 403", async () => {
    // 403, not 404: the console exists and they are not allowed in. Hiding it
    // behind a 404 would leave someone who *should* have access unable to tell
    // a permission problem from a broken deploy.
    const res = await request(appFor(["user"])).get("/metrics").expect(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("refuses a request carrying no session at all", async () => {
    await request(appFor(null)).get("/metrics").expect(403);
  });

  it("is not satisfied by a role that merely looks similar", async () => {
    // Guards against a substring or prefix match creeping in.
    await request(appFor(["user", "compliance-readonly"]))
      .get("/metrics")
      .expect(403);
    await request(appFor(["noncompliance"])).get("/metrics").expect(403);
  });
});
