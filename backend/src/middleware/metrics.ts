/**
 * HTTP metrics middleware (Phase 6 observability).
 *
 * Records request counts and latency. To keep label cardinality bounded we use
 * the matched Express route pattern (e.g. `/api/payments/orders/:orderId`)
 * rather than the concrete path, and never include query strings or ids.
 */
import type { NextFunction, Request, Response } from "express";
import type { MetricsRegistry } from "../lib/metrics.js";

/** Resolve a low-cardinality route label from the Express request. */
function routeLabel(req: Request): string {
  // `req.route` is populated after routing; `baseUrl` carries the mount path.
  const base = req.baseUrl ?? "";
  const path = (req.route as { path?: string } | undefined)?.path;
  if (path) return `${base}${path}` || "/";
  // Fall back to the mount path (or "unmatched") to avoid per-id cardinality.
  return base || "unmatched";
}

export function httpMetrics(registry: MetricsRegistry) {
  return function metricsMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      const durationSeconds =
        Number(process.hrtime.bigint() - start) / 1_000_000_000;
      const labels = {
        method: req.method,
        route: routeLabel(req),
        status: String(res.statusCode),
      };
      registry.httpRequestsTotal.inc(labels);
      registry.httpRequestDurationSeconds.observe(durationSeconds, {
        method: labels.method,
        route: labels.route,
      });
    });
    next();
  };
}
