/**
 * Phase 5: RWA Tokenization module types.
 *
 * The wire contracts (DTOs, enums, inputs) are the shared contracts of record.
 * We re-export them here so the rest of the module has a single import surface,
 * and add only the backend-internal types that never cross the REST boundary.
 *
 * All numeric quantities in DTOs are integer strings (units / minor-unit
 * amounts) — never `bigint` — so they serialize safely via `res.json()`.
 * Arithmetic converts to `bigint` locally and back to string at the boundary.
 */

export {
  AssetType,
  TokenizationStatus,
  PayoutStatus,
} from "@stellartrust/shared";

export type {
  AssetDTO,
  TokenizationDTO,
  TokenHoldingDTO,
  PayoutDistributionDTO,
  PayoutRecordDTO,
  CreateAssetInput,
  CreateTokenizationInput,
  PurchaseUnitsInput,
  TokenizationDetailsResponse,
  InvestorPortfolioResponse,
} from "@stellartrust/shared";

/** Backend-internal: a computed pro-rata payout share for one holder. */
export interface PayoutCalculation {
  holderUserId: string;
  holderAddress: string;
  /** Units held (integer string). */
  unitsHeld: string;
  /** Computed share (minor-unit integer string). */
  shareAmount: string;
}
