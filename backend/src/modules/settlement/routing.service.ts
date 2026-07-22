/**
 * Routing service (Phase 3 — Cross-Border Settlement).
 *
 * Given the costed candidate routes for a corridor, pick the best executable
 * route that respects the caller's slippage and fee constraints. "Best" means
 * the most destination value delivered, tie-broken by lower fee then faster
 * settlement. Pure functions with no I/O so routing is trivially testable and
 * reproducible for audit (Phase 3 acceptance: best path + fee/slippage limits).
 */
import type { SettlementRouteDTO } from "@stellartrust/shared";
import { ValidationError } from "../../lib/errors.js";

export interface RoutingConstraints {
  maxSlippageBps: number;
  /** Optional cap on the source-side fee (minor units string). */
  maxFeeAmount?: string;
}

export interface RoutingResult {
  best: SettlementRouteDTO;
  /** All candidates that satisfied the constraints, best-first. */
  ranked: SettlementRouteDTO[];
}

/** Order two routes best-first. Assumes both share source/destination currency. */
function compareRoutes(a: SettlementRouteDTO, b: SettlementRouteDTO): number {
  // 1) Most destination value wins.
  const destA = BigInt(a.destinationAmount.amount);
  const destB = BigInt(b.destinationAmount.amount);
  if (destA !== destB) return destA > destB ? -1 : 1;
  // 2) Lower source-side fee.
  const feeA = BigInt(a.fee.amount);
  const feeB = BigInt(b.fee.amount);
  if (feeA !== feeB) return feeA < feeB ? -1 : 1;
  // 3) Faster settlement.
  return a.estimatedSeconds - b.estimatedSeconds;
}

export class RoutingService {
  /**
   * Select the best route that satisfies the constraints. Routes exceeding the
   * slippage or fee limits are excluded (fail closed). Throws ValidationError
   * when no candidate remains.
   */
  select(
    candidates: SettlementRouteDTO[],
    constraints: RoutingConstraints,
  ): RoutingResult {
    if (candidates.length === 0) {
      throw new ValidationError("No liquidity route is available for this corridor");
    }

    const maxFee =
      constraints.maxFeeAmount !== undefined
        ? BigInt(constraints.maxFeeAmount)
        : undefined;

    const eligible = candidates.filter((route) => {
      if (route.slippageBps > constraints.maxSlippageBps) return false;
      if (maxFee !== undefined && BigInt(route.fee.amount) > maxFee) return false;
      return true;
    });

    if (eligible.length === 0) {
      throw new ValidationError(
        "No route satisfies the requested fee and slippage limits",
        [
          {
            path: "maxSlippageBps",
            message: `tightest available slippage is ${Math.min(
              ...candidates.map((route) => route.slippageBps),
            )} bps`,
          },
        ],
      );
    }

    const ranked = [...eligible].sort(compareRoutes);
    const best = ranked[0];
    if (!best) {
      throw new ValidationError(
        "No route satisfies the requested fee and slippage limits",
      );
    }
    return { best, ranked };
  }
}
