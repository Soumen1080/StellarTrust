/**
 * Phase 5: RWA Repository
 * Data access layer for tokenization operations.
 *
 * DTOs use integer strings for units/amounts (JSON-safe). Arithmetic that must
 * be exact (e.g. units_sold accumulation) converts to bigint locally.
 */

import { randomUUID } from "node:crypto";
import type {
  AssetDTO,
  CreateAssetInput,
  CreateTokenizationInput,
  PayoutDistributionDTO,
  PayoutRecordDTO,
  TokenHoldingDTO,
  TokenizationDTO,
} from "./rwa.types.js";
import { AssetVerificationStatus, TokenizationStatus } from "./rwa.types.js";
import { ConflictError, NotFoundError } from "../../lib/errors.js";

/**
 * What a repository needs to persist a tokenization.
 *
 * The wire input carries financing *terms*; the unit price is derived from them
 * by the service (a price supplied alongside inconsistent terms is how a
 * waterfall becomes unpayable). By the time a repository sees this, that
 * derivation has happened and the fee has been defaulted, so both are required
 * rather than optional.
 */
export type PersistTokenizationInput = CreateTokenizationInput & {
  pricePerUnitAmount: string;
  pricePerUnitCurrency: CreateTokenizationInput["faceValueCurrency"];
  platformFeeBps: number;
};

/**
 * Tokenization statuses that constitute a live claim on the underlying asset.
 *
 * The complement is the point: `Cancelled`, `Repaid`, `Distributed` and
 * `WrittenOff` are all *finished* — the claim is settled, so the same
 * receivable may legitimately be financed again. Everything else, including a
 * `Draft` that has not yet deployed and a `Defaulted` position still being
 * recovered, is an outstanding pledge that a second financing would double up.
 */
export const LIVE_PLEDGE_STATUSES: readonly TokenizationStatus[] = [
  TokenizationStatus.Draft,
  TokenizationStatus.Active,
  TokenizationStatus.Funded,
  TokenizationStatus.Distributing,
  TokenizationStatus.Frozen,
  TokenizationStatus.Matured,
  TokenizationStatus.Defaulted,
  TokenizationStatus.PayoutHeld,
];

export function isLivePledge(status: TokenizationStatus): boolean {
  return LIVE_PLEDGE_STATUSES.includes(status);
}

export interface RwaRepository {
  // Assets
  createAsset(ownerUserId: string, input: CreateAssetInput): Promise<AssetDTO>;
  findAsset(assetId: string): Promise<AssetDTO | undefined>;
  listAssets(ownerUserId: string): Promise<AssetDTO[]>;
  updateAsset(asset: AssetDTO): Promise<AssetDTO>;
  /**
   * Assets awaiting a compliance decision, oldest first — a review queue is
   * only useful in the order things arrived.
   */
  listAssetsForReview(): Promise<AssetDTO[]>;
  /**
   * Whether any *other* asset carrying the same `assetRef` already backs a
   * live tokenization (plane.md §3.1).
   *
   * This is the double-pledge check, and it deliberately spans owners: the
   * classic invoice-financing fraud is the same receivable financed twice, and
   * doing it under two accounts is the obvious way to try. The unique
   * constraint on `(owner_user_id, asset_ref)` only stops one owner repeating
   * themselves.
   */
  findActivePledge(
    assetRef: string,
    excludeAssetId: string,
  ): Promise<TokenizationDTO | undefined>;

  // Tokenizations
  createTokenization(
    issuerUserId: string,
    input: PersistTokenizationInput,
  ): Promise<TokenizationDTO>;
  updateTokenization(tokenization: TokenizationDTO): Promise<TokenizationDTO>;
  findTokenization(tokenizationId: string): Promise<TokenizationDTO | undefined>;
  listTokenizations(filters?: {
    issuerUserId?: string;
    status?: TokenizationStatus;
    linkedOrderId?: string;
  }): Promise<TokenizationDTO[]>;

  // Holdings
  createHolding(holding: Omit<TokenHoldingDTO, "id">): Promise<TokenHoldingDTO>;
  updateHolding(holding: TokenHoldingDTO): Promise<TokenHoldingDTO>;
  findHolding(
    tokenizationId: string,
    holderUserId: string,
  ): Promise<TokenHoldingDTO | undefined>;
  listHoldings(tokenizationId: string): Promise<TokenHoldingDTO[]>;
  listHoldingsByUser(holderUserId: string): Promise<TokenHoldingDTO[]>;
  /** Remove a holding outright — the cooling-off cancellation (plane.md §3.2). */
  deleteHolding(holdingId: string): Promise<void>;

  // Distributions
  createDistribution(
    distribution: Omit<PayoutDistributionDTO, "id">,
  ): Promise<PayoutDistributionDTO>;
  updateDistribution(
    distribution: PayoutDistributionDTO,
  ): Promise<PayoutDistributionDTO>;
  findDistribution(distributionId: string): Promise<PayoutDistributionDTO | undefined>;
  listDistributions(tokenizationId: string): Promise<PayoutDistributionDTO[]>;

  // Payout Records
  createPayoutRecords(records: Omit<PayoutRecordDTO, "id">[]): Promise<PayoutRecordDTO[]>;
  listPayoutRecords(distributionId: string): Promise<PayoutRecordDTO[]>;
  listPayoutRecordsByUser(holderUserId: string): Promise<PayoutRecordDTO[]>;
}

/**
 * In-memory implementation for local development and testing.
 * Production should use a Postgres-backed implementation.
 */
export class InMemoryRwaRepository implements RwaRepository {
  private readonly assets = new Map<string, AssetDTO>();
  private readonly tokenizations = new Map<string, TokenizationDTO>();
  private readonly holdings = new Map<string, TokenHoldingDTO>();
  private readonly distributions = new Map<string, PayoutDistributionDTO>();
  private readonly payoutRecords = new Map<string, PayoutRecordDTO>();

  // Assets
  async createAsset(
    ownerUserId: string,
    input: CreateAssetInput,
  ): Promise<AssetDTO> {
    const existing = [...this.assets.values()].find(
      (asset) =>
        asset.ownerUserId === ownerUserId && asset.assetRef === input.assetRef,
    );
    if (existing) {
      throw new ConflictError(
        `Asset with ref ${input.assetRef} already exists for this owner`,
      );
    }

    const now = new Date().toISOString();
    const asset: AssetDTO = {
      id: randomUUID(),
      ownerUserId,
      assetType: input.assetType,
      assetRef: input.assetRef,
      description: input.description,
      valuationAmount: input.valuationAmount,
      valuationCurrency: input.valuationCurrency,
      metadata: input.metadata,
      // Every asset starts unverified. There is no input that can set this:
      // the whole point of the workflow is that the issuer cannot declare
      // their own evidence acceptable.
      verificationStatus: AssetVerificationStatus.Unverified,
      documents: (input.documents ?? []).map((doc) => ({
        docRef: doc.docRef,
        docType: doc.docType,
        sha256: doc.sha256 ?? null,
        uploadedAt: now,
      })),
      counterparty: input.counterparty
        ? {
            ref: input.counterparty.ref,
            name: input.counterparty.name,
            reputationScore: null,
          }
        : null,
      verifiedByUserId: null,
      verifiedAt: null,
      verificationNote: null,
      createdAt: now,
      updatedAt: now,
    };
    this.assets.set(asset.id, asset);
    return asset;
  }

  async findAsset(assetId: string): Promise<AssetDTO | undefined> {
    return this.assets.get(assetId);
  }

  async listAssets(ownerUserId: string): Promise<AssetDTO[]> {
    return [...this.assets.values()]
      .filter((asset) => asset.ownerUserId === ownerUserId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async updateAsset(asset: AssetDTO): Promise<AssetDTO> {
    if (!this.assets.has(asset.id)) {
      throw new NotFoundError("Asset not found");
    }
    const updated = { ...asset, updatedAt: new Date().toISOString() };
    this.assets.set(updated.id, updated);
    return updated;
  }

  async listAssetsForReview(): Promise<AssetDTO[]> {
    return [...this.assets.values()]
      .filter(
        (asset) =>
          asset.verificationStatus === AssetVerificationStatus.UnderReview,
      )
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  }

  async findActivePledge(
    assetRef: string,
    excludeAssetId: string,
  ): Promise<TokenizationDTO | undefined> {
    const pledgedAssetIds = new Set(
      [...this.assets.values()]
        .filter(
          (asset) => asset.assetRef === assetRef && asset.id !== excludeAssetId,
        )
        .map((asset) => asset.id),
    );
    if (pledgedAssetIds.size === 0) return undefined;

    return [...this.tokenizations.values()].find(
      (t) => pledgedAssetIds.has(t.assetId) && isLivePledge(t.status),
    );
  }

  // Tokenizations
  async createTokenization(
    issuerUserId: string,
    input: PersistTokenizationInput,
  ): Promise<TokenizationDTO> {
    const asset = await this.findAsset(input.assetId);
    if (!asset) {
      throw new NotFoundError("Asset not found");
    }
    if (asset.ownerUserId !== issuerUserId) {
      throw new ConflictError("Only the asset owner can tokenize it");
    }

    const existing = [...this.tokenizations.values()].find(
      (t) => t.assetId === input.assetId && t.status !== TokenizationStatus.Cancelled,
    );
    if (existing) {
      throw new ConflictError("This asset is already tokenized");
    }

    const now = new Date().toISOString();
    const tokenization: TokenizationDTO = {
      id: randomUUID(),
      assetId: input.assetId,
      issuerUserId,
      contractId: null,
      contractDeployedAt: null,
      totalUnits: input.totalUnits,
      unitsSold: "0",
      pricePerUnitAmount: input.pricePerUnitAmount,
      pricePerUnitCurrency: input.pricePerUnitCurrency,
      requireAuthorization: input.requireAuthorization ?? false,
      frozen: false,
      linkedOrderId: input.linkedOrderId ?? null,
      status: TokenizationStatus.Draft,
      faceValueAmount: input.faceValueAmount,
      faceValueCurrency: input.faceValueCurrency,
      advanceRateBps: input.advanceRateBps,
      discountRateBps: input.discountRateBps,
      platformFeeBps: input.platformFeeBps,
      maturityDate: input.maturityDate,
      collectedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.tokenizations.set(tokenization.id, tokenization);
    return tokenization;
  }

  async updateTokenization(
    tokenization: TokenizationDTO,
  ): Promise<TokenizationDTO> {
    if (!this.tokenizations.has(tokenization.id)) {
      throw new NotFoundError("Tokenization not found");
    }
    const updated = {
      ...tokenization,
      updatedAt: new Date().toISOString(),
    };
    this.tokenizations.set(updated.id, updated);
    return updated;
  }

  async findTokenization(
    tokenizationId: string,
  ): Promise<TokenizationDTO | undefined> {
    return this.tokenizations.get(tokenizationId);
  }

  async listTokenizations(filters?: {
    issuerUserId?: string;
    status?: TokenizationStatus;
    linkedOrderId?: string;
  }): Promise<TokenizationDTO[]> {
    let result = [...this.tokenizations.values()];

    if (filters?.issuerUserId) {
      result = result.filter((t) => t.issuerUserId === filters.issuerUserId);
    }
    if (filters?.status) {
      result = result.filter((t) => t.status === filters.status);
    }
    if (filters?.linkedOrderId) {
      result = result.filter((t) => t.linkedOrderId === filters.linkedOrderId);
    }

    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // Holdings
  async createHolding(
    holding: Omit<TokenHoldingDTO, "id">,
  ): Promise<TokenHoldingDTO> {
    const existing = [...this.holdings.values()].find(
      (h) =>
        h.tokenizationId === holding.tokenizationId &&
        h.holderUserId === holding.holderUserId,
    );
    if (existing) {
      throw new ConflictError("Holding already exists for this user");
    }

    const created: TokenHoldingDTO = {
      id: randomUUID(),
      ...holding,
    };
    this.holdings.set(created.id, created);

    // Update units_sold on tokenization (exact bigint arithmetic).
    const tokenization = this.tokenizations.get(holding.tokenizationId);
    if (tokenization) {
      const unitsSold = BigInt(tokenization.unitsSold) + BigInt(holding.units);
      tokenization.unitsSold = unitsSold.toString();
      if (unitsSold >= BigInt(tokenization.totalUnits)) {
        tokenization.status = TokenizationStatus.Funded;
      }
      tokenization.updatedAt = new Date().toISOString();
      this.tokenizations.set(tokenization.id, tokenization);
    }

    return created;
  }

  async updateHolding(holding: TokenHoldingDTO): Promise<TokenHoldingDTO> {
    if (!this.holdings.has(holding.id)) {
      throw new NotFoundError("Holding not found");
    }
    const updated = {
      ...holding,
      updatedAt: new Date().toISOString(),
    };
    this.holdings.set(updated.id, updated);
    return updated;
  }

  async findHolding(
    tokenizationId: string,
    holderUserId: string,
  ): Promise<TokenHoldingDTO | undefined> {
    return [...this.holdings.values()].find(
      (h) =>
        h.tokenizationId === tokenizationId && h.holderUserId === holderUserId,
    );
  }

  async listHoldings(tokenizationId: string): Promise<TokenHoldingDTO[]> {
    return [...this.holdings.values()]
      .filter((h) => h.tokenizationId === tokenizationId)
      .sort((a, b) => a.purchasedAt.localeCompare(b.purchasedAt));
  }

  async listHoldingsByUser(holderUserId: string): Promise<TokenHoldingDTO[]> {
    return [...this.holdings.values()]
      .filter((h) => h.holderUserId === holderUserId)
      .sort((a, b) => b.purchasedAt.localeCompare(a.purchasedAt));
  }

  async deleteHolding(holdingId: string): Promise<void> {
    const holding = this.holdings.get(holdingId);
    if (!holding) {
      throw new NotFoundError("Holding not found");
    }
    this.holdings.delete(holdingId);

    // Return the units to the pool. A cancelled purchase that left units_sold
    // untouched would silently shrink the tokenization's sellable supply.
    const tokenization = this.tokenizations.get(holding.tokenizationId);
    if (tokenization) {
      const unitsSold = BigInt(tokenization.unitsSold) - BigInt(holding.units);
      tokenization.unitsSold = (unitsSold < 0n ? 0n : unitsSold).toString();
      // Releasing units un-funds a position that funding had closed.
      if (
        tokenization.status === TokenizationStatus.Funded &&
        BigInt(tokenization.unitsSold) < BigInt(tokenization.totalUnits)
      ) {
        tokenization.status = TokenizationStatus.Active;
      }
      tokenization.updatedAt = new Date().toISOString();
      this.tokenizations.set(tokenization.id, tokenization);
    }
  }

  // Distributions
  async createDistribution(
    distribution: Omit<PayoutDistributionDTO, "id">,
  ): Promise<PayoutDistributionDTO> {
    const created: PayoutDistributionDTO = {
      id: randomUUID(),
      ...distribution,
    };
    this.distributions.set(created.id, created);
    return created;
  }

  async updateDistribution(
    distribution: PayoutDistributionDTO,
  ): Promise<PayoutDistributionDTO> {
    if (!this.distributions.has(distribution.id)) {
      throw new NotFoundError("Distribution not found");
    }
    this.distributions.set(distribution.id, distribution);
    return distribution;
  }

  async findDistribution(
    distributionId: string,
  ): Promise<PayoutDistributionDTO | undefined> {
    return this.distributions.get(distributionId);
  }

  async listDistributions(
    tokenizationId: string,
  ): Promise<PayoutDistributionDTO[]> {
    return [...this.distributions.values()]
      .filter((d) => d.tokenizationId === tokenizationId)
      .sort((a, b) => b.initiatedAt.localeCompare(a.initiatedAt));
  }

  // Payout Records
  async createPayoutRecords(
    records: Omit<PayoutRecordDTO, "id">[],
  ): Promise<PayoutRecordDTO[]> {
    return records.map((record) => {
      const payoutRecord: PayoutRecordDTO = {
        id: randomUUID(),
        ...record,
      };
      this.payoutRecords.set(payoutRecord.id, payoutRecord);
      return payoutRecord;
    });
  }

  async listPayoutRecords(distributionId: string): Promise<PayoutRecordDTO[]> {
    return [...this.payoutRecords.values()]
      .filter((r) => r.distributionId === distributionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async listPayoutRecordsByUser(
    holderUserId: string,
  ): Promise<PayoutRecordDTO[]> {
    return [...this.payoutRecords.values()]
      .filter((r) => r.holderUserId === holderUserId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
