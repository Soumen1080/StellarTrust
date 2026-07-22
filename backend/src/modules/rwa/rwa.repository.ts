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
import { TokenizationStatus } from "./rwa.types.js";
import { ConflictError, NotFoundError } from "../../lib/errors.js";

export interface RwaRepository {
  // Assets
  createAsset(ownerUserId: string, input: CreateAssetInput): Promise<AssetDTO>;
  findAsset(assetId: string): Promise<AssetDTO | undefined>;
  listAssets(ownerUserId: string): Promise<AssetDTO[]>;

  // Tokenizations
  createTokenization(
    issuerUserId: string,
    input: CreateTokenizationInput,
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

  // Tokenizations
  async createTokenization(
    issuerUserId: string,
    input: CreateTokenizationInput,
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
