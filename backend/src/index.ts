/** Server bootstrap. */
import { createApp } from "./app.js";
import { config } from "./config/index.js";
import { closePool } from "./db/index.js";
import { logger } from "./lib/logger.js";
import { closeRedis } from "./lib/redis.js";

const app = createApp();
const reconciliationJob = app.locals.reconciliationJob as {
  start(): void;
  stop(): void;
};
const settlementReconciliationJob = app.locals
  .settlementReconciliationJob as {
  start(): void;
  stop(): void;
};
const rwaReconciliationJob = app.locals.rwaReconciliationJob as {
  start(): void;
  stop(): void;
};
const rwaLifecycleJob = app.locals.rwaLifecycleJob as {
  start(): void;
  stop(): void;
};
const businessMetricsJob = app.locals.businessMetricsJob as {
  start(): void;
  stop(): void;
};
reconciliationJob.start();
settlementReconciliationJob.start();
rwaReconciliationJob.start();
rwaLifecycleJob.start();
businessMetricsJob.start();

const server = app.listen(config.PORT, () => {
  logger.info(
    { port: config.PORT, env: config.NODE_ENV },
    `${config.serviceName} listening`,
  );
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "shutting down");
  reconciliationJob.stop();
  settlementReconciliationJob.stop();
  rwaReconciliationJob.stop();
  rwaLifecycleJob.stop();
  businessMetricsJob.stop();
  server.close(() => {
    void Promise.allSettled([closePool(), closeRedis()]).finally(() =>
      process.exit(0),
    );
  });
  // Force-exit if graceful shutdown stalls.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
