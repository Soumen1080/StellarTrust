/**
 * Server bootstrap for the admin console.
 *
 * Separate from `app.ts` so tests can import the app without opening a port.
 */
import { config } from "./config.js";
import { createApp } from "./app.js";
import { closePool, getPool } from "./lib/db.js";

const app = createApp();

// Prove the database is reachable before announcing readiness. A console that
// binds a port and then fails every request is harder to diagnose than one
// that refuses to start and says why.
try {
  await getPool().query("select 1");
  console.log("admin: database reachable");
} catch (err) {
  console.error(
    "admin: cannot reach the database — check DATABASE_URL and that this " +
      "host's IP is allowed by the database's network rules.\n",
    (err as Error).message,
  );
  process.exit(1);
}

if (
  (config.isProduction || config.NODE_ENV === "staging") &&
  config.ADMIN_IP_ALLOWLIST.length === 0
) {
  console.warn(
    "admin: ADMIN_IP_ALLOWLIST is empty — this console is reachable from any " +
      "address, and a leaked password is then enough to open it. Set it, or " +
      "put the deployment behind a VPN or platform firewall.",
  );
}

const server = app.listen(config.PORT, () => {
  console.log(
    `${config.serviceName} listening on ${config.PORT} (${config.NODE_ENV})`,
  );
});

async function shutdown(signal: string): Promise<void> {
  console.log(`admin: shutting down (${signal})`);
  server.close(() => {
    void closePool().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
