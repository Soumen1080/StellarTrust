/**
 * Phase 5: RWA Service
 * Business logic for tokenization operations.
 *
 * DTOs use integer strings for units/amounts (JSON-safe). Exact arithmetic
 * (pro-rata shares, capacity checks) converts to `bigint` locally.
 */

import { EntryDirection, type CurrencyCode } from "@stellartrust/shared";
import type { LedgerTransactionInput } from "@stellartrust/shared";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { assertStellarAddress } from "../stellar/address.js";
import type { WalletAddressResolver } from "../identity/wallet.resolver.js";
import type { AuditRepository } from "../audit/audit.repository.js";
import type { RwaGateway } from "./rwa.gateway.js";
import type { RwaRepository } from "./rwa.repository.js";
import type {
  AssetDTO,
  CreateAssetInput,
  CreateTokenizationInput,
  InvestorPortfolioResponse,
  PayoutCalculation,
  PayoutDistributionDTO,
  PurchaseUnitsInput,
  TokenizationDetailsResponse,
  TokenizationDTO,
} from "./rwa.types.js";
import { PayoutStatus, TokenizationStatus } from "./rwa.types.js";

// System ledger account IDs (would come from config/database in production).
const RWA_PAYOUT_PAYABLE = "a0000000-0000-4000-8000-000000000003";
const RWA_PAYOUT_RESERVE = "a0000000-0000-4000-8000-000000000004";

export interface RwaActor {
  userId: string;
  roles: string[];
}

/**
 * The ledger write a payout must go through. Structurally satisfied by
 * `LedgerService`; declared here as a narrow port so the RWA module depends on
 * the capability rather than on the ledger module's class.
 */
export interface PayoutLedgerRecorder {
  record(input: LedgerTransactionInput): Promise<{ id: string }>;
  getByReference(
    referenceId: string,
  ): Promise<{ id: string } | undefined>;
}

export class RwaService {
  /**
   * @param ledger - required, not optional. A payout that cannot post balanced
   *   ledger entries must fail rather than quietly complete: the ledger is the
   *   system of record (Golden Rule #1), and an optional recorder is an
   *   invitation to skip it.
   * @param addresses - resolves issuer/holder user ids to the Stellar accounts
   *   the token contract expects. Without it, internal ids reach a Soroban
   *   `Address` argument and the local and on-chain adapters key balances
   *   differently.
   */
  constructor(
    private readonly repository: RwaRepository,
    private readonly gateway: RwaGateway,
    private readonly audit: AuditRepository,
    private readonly ledger: PayoutLedgerRecorder,
    private readonly addresses: WalletAddressResolver,
  ) {}

  /** Create a new asset for tokenization. */
  async createAsset(
    ownerUserId: string,
    input: CreateAssetInput,
  ): Promise<AssetDTO> {
    this.validateAssetInput(input);

    const asset = await this.repository.createAsset(ownerUserId, input);

    await this.audit.append({
      actor: `user:${ownerUserId}`,
      action: "rwa.create_asset",
      entity: "asset",
      entityId: asset.id,
      metadata: {
        assetType: asset.assetType,
        assetRef: asset.assetRef,
        valuationAmount: asset.valuationAmount,
        valuationCurrency: asset.valuationCurrency,
      },
    });

    return asset;
  }

  /** List assets owned by a user. */
  async listAssets(ownerUserId: string): Promise<AssetDTO[]> {
    return this.repository.listAssets(ownerUserId);
  }

  /** Create a tokenization for an asset. */
  async createTokenization(
    issuerUserId: string,
    input: CreateTokenizationInput,
  ): Promise<TokenizationDTO> {
    this.validateTokenizationInput(input);

    const asset = await this.repository.findAsset(input.assetId);
    if (!asset) {
      throw new NotFoundError("Asset not found");
    }
    if (asset.ownerUserId !== issuerUserId) {
      throw new ForbiddenError("Only the asset owner can tokenize it");
    }

    const tokenization = await this.repository.createTokenization(
      issuerUserId,
      input,
    );

    await this.audit.append({
      actor: `user:${issuerUserId}`,
      action: "rwa.create_tokenization",
      entity: "tokenization",
      entityId: tokenization.id,
      metadata: {
        assetId: input.assetId,
        totalUnits: input.totalUnits,
        pricePerUnit: input.pricePerUnitAmount,
        currency: input.pricePerUnitCurrency,
      },
    });

    return tokenization;
  }

  /** Deploy a tokenization to the blockchain. */
  async deployTokenization(
    tokenizationId: string,
    actor: RwaActor,
  ): Promise<TokenizationDTO> {
    const tokenization = await this.requireTokenization(tokenizationId);

    if (tokenization.issuerUserId !== actor.userId) {
      throw new ForbiddenError("Only the issuer can deploy a tokenization");
    }
    if (tokenization.status !== TokenizationStatus.Draft) {
      throw new ConflictError("Only draft tokenizations can be deployed");
    }

    const asset = await this.repository.findAsset(tokenization.assetId);
    if (!asset) {
      throw new NotFoundError("Asset not found");
    }

    // The issuer's real Stellar account, from their SEP-10-proven wallet. This
    // used to pass `actor.userId` — a UUID — straight into a Soroban `Address`
    // argument, which the on-chain adapter silently replaced with the signer
    // while the local adapter keyed balances by the UUID. The two adapters then
    // disagreed about who held anything.
    const issuerAddress = await this.addresses.resolve(
      tokenization.issuerUserId,
      "issuer",
    );

    const contractId = await this.gateway.deployToken({
      issuerAddress,
      assetRef: asset.assetRef,
      assetType: asset.assetType,
      description: asset.description,
      totalUnits: BigInt(tokenization.totalUnits),
      requireAuthorization: tokenization.requireAuthorization,
    });

    const now = new Date().toISOString();
    const updated = await this.repository.updateTokenization({
      ...tokenization,
      contractId,
      contractDeployedAt: now,
      status: TokenizationStatus.Active,
    });

    await this.audit.append({
      actor: `user:${actor.userId}`,
      action: "rwa.deploy_tokenization",
      entity: "tokenization",
      entityId: tokenization.id,
      metadata: { contractId, status: TokenizationStatus.Active },
    });

    return updated;
  }

  /** Purchase tokenized units as an investor. */
  async purchaseUnits(
    tokenizationId: string,
    actor: RwaActor,
    input: PurchaseUnitsInput,
  ): Promise<TokenizationDetailsResponse> {
    const tokenization = await this.requireTokenization(tokenizationId);

    if (tokenization.status !== TokenizationStatus.Active) {
      throw new ConflictError("Tokenization is not available for purchase");
    }
    if (tokenization.frozen) {
      throw new ConflictError("Transfers are frozen on this tokenization");
    }

    let units: bigint;
    try {
      units = BigInt(input.units);
    } catch {
      throw new ValidationError("Units must be an integer");
    }
    if (units <= 0n) {
      throw new ValidationError("Units must be positive");
    }

    const availableUnits =
      BigInt(tokenization.totalUnits) - BigInt(tokenization.unitsSold);
    if (units > availableUnits) {
      throw new ValidationError(
        `Only ${availableUnits} units available (requested ${units})`,
      );
    }

    const purchaseAmount = units * BigInt(tokenization.pricePerUnitAmount);

    const existingHolding = await this.repository.findHolding(
      tokenizationId,
      actor.userId,
    );
    if (existingHolding) {
      throw new ConflictError(
        "Investor already has holdings. Secondary purchases not yet supported.",
      );
    }

    // The recipient is a Soroban `Address`, so it must be a real strkey — an
    // empty string or a UUID reaching the contract produces an opaque host
    // error at simulation, or binds the units to nothing.
    const holderAddress = assertStellarAddress(
      input.holderAddress,
      "holderAddress",
    );

    if (tokenization.contractId) {
      const issuerAddress = await this.addresses.resolve(
        tokenization.issuerUserId,
        "issuer",
      );

      // When authorization is required, the recipient must be authorized before
      // the transfer — the contract rejects transfers to unauthorized holders.
      if (tokenization.requireAuthorization) {
        await this.gateway.authorizeHolder({
          contractId: tokenization.contractId,
          holderAddress,
        });
      }

      await this.gateway.transferUnits({
        contractId: tokenization.contractId,
        from: issuerAddress,
        to: holderAddress,
        units,
      });
    }

    const now = new Date().toISOString();
    await this.repository.createHolding({
      tokenizationId,
      holderUserId: actor.userId,
      holderAddress,
      units: units.toString(),
      purchaseAmount: purchaseAmount.toString(),
      purchaseCurrency: tokenization.pricePerUnitCurrency,
      purchasedAt: now,
      authorized: true,
      updatedAt: now,
    });

    await this.audit.append({
      actor: `user:${actor.userId}`,
      action: "rwa.purchase_units",
      entity: "tokenization",
      entityId: tokenization.id,
      metadata: {
        units: units.toString(),
        purchaseAmount: purchaseAmount.toString(),
        currency: tokenization.pricePerUnitCurrency,
      },
    });

    return this.getTokenizationDetails(tokenizationId);
  }

  /** Get detailed tokenization information. */
  async getTokenizationDetails(
    tokenizationId: string,
  ): Promise<TokenizationDetailsResponse> {
    const tokenization = await this.requireTokenization(tokenizationId);
    const asset = await this.repository.findAsset(tokenization.assetId);
    if (!asset) {
      throw new NotFoundError("Asset not found");
    }

    const holdings = await this.repository.listHoldings(tokenizationId);
    const distributions = await this.repository.listDistributions(tokenizationId);

    const availableUnits =
      BigInt(tokenization.totalUnits) - BigInt(tokenization.unitsSold);
    const totalRaised = holdings.reduce(
      (sum, h) => sum + BigInt(h.purchaseAmount),
      0n,
    );

    return {
      tokenization,
      asset,
      holdings,
      distributions,
      availableUnits: availableUnits.toString(),
      totalRaised: totalRaised.toString(),
    };
  }

  /** List tokenizations (optionally filtered). */
  async listTokenizations(filters?: {
    issuerUserId?: string;
    status?: TokenizationStatus;
    linkedOrderId?: string;
  }): Promise<TokenizationDTO[]> {
    return this.repository.listTokenizations(filters);
  }

  /** Get an investor's portfolio across all holdings. */
  async getInvestorPortfolio(
    holderUserId: string,
  ): Promise<InvestorPortfolioResponse> {
    const holdings = await this.repository.listHoldingsByUser(holderUserId);
    const payoutRecords =
      await this.repository.listPayoutRecordsByUser(holderUserId);

    const enrichedHoldings = await Promise.all(
      holdings.map(async (holding) => {
        const tokenization = await this.repository.findTokenization(
          holding.tokenizationId,
        );
        const asset = tokenization
          ? await this.repository.findAsset(tokenization.assetId)
          : undefined;
        return {
          holding,
          tokenization: tokenization!,
          asset: asset!,
        };
      }),
    );

    const totalInvested = holdings.reduce(
      (sum, h) => sum + BigInt(h.purchaseAmount),
      0n,
    );
    const totalPayoutsReceived = payoutRecords.reduce(
      (sum, r) => sum + BigInt(r.shareAmount),
      0n,
    );

    return {
      holdings: enrichedHoldings,
      totalInvested: totalInvested.toString(),
      totalPayoutsReceived: totalPayoutsReceived.toString(),
    };
  }

  /**
   * Distribute payout to all token holders (triggered by escrow release).
   * Called by the payments module when an order with a linked tokenization
   * is released.
   */
  async distributePayout(
    tokenizationId: string,
    orderId: string,
    transition: string,
    payoutAmount: bigint,
    payoutCurrency: string,
    actor: RwaActor,
  ): Promise<PayoutDistributionDTO> {
    const tokenization = await this.requireTokenization(tokenizationId);

    if (!actor.roles.includes("compliance") && !actor.roles.includes("system")) {
      throw new ForbiddenError("Only authorized systems can trigger payouts");
    }

    const holdings = await this.repository.listHoldings(tokenizationId);
    if (holdings.length === 0) {
      throw new ConflictError("No holdings to distribute to");
    }

    // The payout is identified by what caused it, so a retry of the same
    // release converges instead of paying twice. Whether the ledger already
    // holds this posting is also what tells a retry apart from a second,
    // genuinely different payout.
    const ledgerReferenceId = `rwa-payout:${tokenizationId}:${orderId}:${transition}`;
    const priorPosting = await this.ledger.getByReference(ledgerReferenceId);

    // Assert our unit records still agree with the deployed contract before
    // paying anyone. If they have drifted, the pro-rata shares below are
    // computed against the wrong denominator.
    await this.assertContractAgrees(tokenization, priorPosting !== undefined);

    const calculations = this.calculatePayoutShares(
      holdings.map((h) => ({
        holderUserId: h.holderUserId,
        holderAddress: h.holderAddress,
        unitsHeld: h.units,
      })),
      BigInt(tokenization.totalUnits),
      payoutAmount,
    );

    const now = new Date().toISOString();
    const distribution = await this.repository.createDistribution({
      tokenizationId,
      triggeredByOrderId: orderId,
      triggeredByTransition: transition,
      totalAmount: payoutAmount.toString(),
      totalCurrency: payoutCurrency as CurrencyCode,
      status: PayoutStatus.Processing,
      ledgerTransactionId: null,
      initiatedAt: now,
      completedAt: null,
    });

    const payoutRecords = await this.repository.createPayoutRecords(
      calculations.map((calc) => ({
        distributionId: distribution.id,
        holderUserId: calc.holderUserId,
        unitsHeld: calc.unitsHeld,
        shareAmount: calc.shareAmount,
        shareCurrency: payoutCurrency as CurrencyCode,
        ledgerEntryId: null,
        createdAt: now,
      })),
    );

    // Post the balanced ledger entries first. The distribution stays
    // `Processing` if this throws, which is exactly right: the payout is then
    // retryable and the books never claim a distribution that did not post.
    //
    // Order matters. Setting the contract's one-shot `distributed` flag before
    // the ledger post would deadlock a retry: the flag would already be set,
    // the money would never have been recorded, and no later attempt could
    // complete it.
    const ledgerTransaction =
      priorPosting ??
      (await this.recordPayoutLedger(
        ledgerReferenceId,
        tokenization,
        payoutRecords,
        payoutCurrency,
      ));

    // Now claim the on-chain guard. A retry finds it already set, which is the
    // expected outcome once the ledger posting above has been recognised as a
    // repeat — the contract, not this code, is the authority on it.
    if (tokenization.contractId) {
      await this.markDistributedOnce(tokenization.contractId);
    }

    const completed = await this.repository.updateDistribution({
      ...distribution,
      status: PayoutStatus.Completed,
      completedAt: new Date().toISOString(),
      ledgerTransactionId: ledgerTransaction.id,
    });

    await this.audit.append({
      actor: `user:${actor.userId}`,
      action: "rwa.distribute_payout",
      entity: "distribution",
      entityId: distribution.id,
      metadata: {
        tokenizationId,
        orderId,
        totalAmount: payoutAmount.toString(),
        holdersCount: holdings.length,
      },
    });

    return completed;
  }

  /** Freeze tokenization transfers (compliance control). */
  async freezeTokenization(
    tokenizationId: string,
    actor: RwaActor,
  ): Promise<TokenizationDTO> {
    const tokenization = await this.requireTokenization(tokenizationId);

    if (
      tokenization.issuerUserId !== actor.userId &&
      !actor.roles.includes("compliance")
    ) {
      throw new ForbiddenError(
        "Only issuer or compliance can freeze tokenization",
      );
    }

    if (tokenization.contractId) {
      await this.gateway.freezeToken(tokenization.contractId);
    }

    const updated = await this.repository.updateTokenization({
      ...tokenization,
      frozen: true,
    });

    await this.audit.append({
      actor: `user:${actor.userId}`,
      action: "rwa.freeze_tokenization",
      entity: "tokenization",
      entityId: tokenization.id,
      metadata: { frozen: true },
    });

    return updated;
  }

  /** Unfreeze tokenization transfers. */
  async unfreezeTokenization(
    tokenizationId: string,
    actor: RwaActor,
  ): Promise<TokenizationDTO> {
    const tokenization = await this.requireTokenization(tokenizationId);

    if (
      tokenization.issuerUserId !== actor.userId &&
      !actor.roles.includes("compliance")
    ) {
      throw new ForbiddenError(
        "Only issuer or compliance can unfreeze tokenization",
      );
    }

    if (tokenization.contractId) {
      await this.gateway.unfreezeToken(tokenization.contractId);
    }

    const updated = await this.repository.updateTokenization({
      ...tokenization,
      frozen: false,
    });

    await this.audit.append({
      actor: `user:${actor.userId}`,
      action: "rwa.unfreeze_tokenization",
      entity: "tokenization",
      entityId: tokenization.id,
      metadata: { frozen: false },
    });

    return updated;
  }

  /** Calculate pro-rata payout shares (exact bigint arithmetic). */
  private calculatePayoutShares(
    holders: Array<{ holderUserId: string; holderAddress: string; unitsHeld: string }>,
    totalUnits: bigint,
    payoutAmount: bigint,
  ): PayoutCalculation[] {
    return holders.map((holder) => {
      const units = BigInt(holder.unitsHeld);
      const share = (payoutAmount * units) / totalUnits;
      return {
        holderUserId: holder.holderUserId,
        holderAddress: holder.holderAddress,
        unitsHeld: holder.unitsHeld,
        shareAmount: share.toString(),
      };
    });
  }

  /**
   * Persist the balanced ledger entries for a payout distribution.
   *
   * The reference id is derived from what *caused* the payout — tokenization,
   * order, and transition — not from a timestamp or a fresh distribution id. A
   * retry therefore collides with the existing transaction instead of posting
   * the money a second time, and we recover its id rather than failing: the
   * ledger already holds the truth, so the only thing left to do is finish
   * recording it.
   */
  private async recordPayoutLedger(
    referenceId: string,
    tokenization: TokenizationDTO,
    payoutRecords: Array<{ shareAmount: string }>,
    currency: string,
  ): Promise<{ id: string }> {
    const totalAmount = payoutRecords.reduce(
      (sum, r) => sum + BigInt(r.shareAmount),
      0n,
    );
    if (totalAmount <= 0n) {
      // Every holder rounded to zero. Posting a zero-amount entry is rejected
      // by the ledger schema, and there is genuinely nothing to record.
      throw new ConflictError(
        "Payout is too small to distribute: every holder's share rounds to zero",
      );
    }

    const input: LedgerTransactionInput = {
      referenceId,
      description: `RWA payout distribution for tokenization ${tokenization.id}`,
      entries: [
        {
          accountId: RWA_PAYOUT_RESERVE,
          direction: EntryDirection.Debit,
          amount: totalAmount.toString(),
          currency: currency as CurrencyCode,
        },
        {
          accountId: RWA_PAYOUT_PAYABLE,
          direction: EntryDirection.Credit,
          amount: totalAmount.toString(),
          currency: currency as CurrencyCode,
        },
      ],
    };

    try {
      return await this.ledger.record(input);
    } catch (err) {
      if (!(err instanceof ConflictError)) throw err;
      // Lost a race with a concurrent attempt at the same payout. The ledger
      // already holds the truth; recover its id rather than failing.
      const existing = await this.ledger.getByReference(referenceId);
      if (!existing) throw err;
      logger.info(
        { tokenizationId: tokenization.id, ledgerTransactionId: existing.id },
        "RWA payout ledger transaction already posted; reusing it",
      );
      return existing;
    }
  }

  /**
   * Set the contract's one-shot `distributed` flag, tolerating the case where
   * it is already set.
   *
   * By the time this runs the ledger posting has been established as
   * authoritative for this payout, so an "already distributed" answer means a
   * previous attempt got this far — not that we are double-paying. A second,
   * genuinely different payout is refused earlier, by
   * {@link assertContractAgrees}.
   */
  private async markDistributedOnce(contractId: string): Promise<void> {
    try {
      await this.gateway.markDistributed(contractId);
    } catch (err) {
      const meta = await this.gateway.getContractMeta(contractId);
      if (!meta?.distributed) throw err;
      logger.info(
        { contractId },
        "token contract was already marked distributed by a previous attempt",
      );
    }
  }

  /**
   * Verify the deployed contract still describes the tokenization we are about
   * to pay out on. Two failures matter: a unit total that no longer matches
   * (every pro-rata share would be wrong), and a contract that already recorded
   * a distribution (the on-chain double-payout guard has fired).
   */
  private async assertContractAgrees(
    tokenization: TokenizationDTO,
    isRetry: boolean,
  ): Promise<void> {
    if (!tokenization.contractId) return;

    const meta = await this.gateway.getContractMeta(tokenization.contractId);
    if (!meta) {
      throw new ConflictError(
        `Token contract ${tokenization.contractId} could not be read; refusing ` +
          "to distribute a payout against custody we cannot verify",
      );
    }
    if (meta.totalUnits !== BigInt(tokenization.totalUnits)) {
      throw new ConflictError(
        `Tokenization ${tokenization.id} records ${tokenization.totalUnits} ` +
          `units but the contract holds ${meta.totalUnits}; payout shares ` +
          "would be computed against the wrong total",
      );
    }
    // The contract allows one distribution per tokenization. A repeat of the
    // *same* payout is fine — the ledger already holds it, and we are just
    // finishing the record. A different one is not.
    if (meta.distributed && !isRetry) {
      throw new ConflictError(
        `Token contract ${tokenization.contractId} has already distributed a payout`,
      );
    }
  }

  private async requireTokenization(
    tokenizationId: string,
  ): Promise<TokenizationDTO> {
    const tokenization = await this.repository.findTokenization(tokenizationId);
    if (!tokenization) {
      throw new NotFoundError("Tokenization not found");
    }
    return tokenization;
  }

  private validateAssetInput(input: CreateAssetInput): void {
    if (!input.assetRef || input.assetRef.trim().length === 0) {
      throw new ValidationError("Asset reference is required");
    }
    if (!input.description || input.description.trim().length === 0) {
      throw new ValidationError("Description is required");
    }
    if (!/^\d+$/.test(input.valuationAmount) || BigInt(input.valuationAmount) <= 0n) {
      throw new ValidationError("Valuation amount must be a positive integer");
    }
    if (!input.valuationCurrency || input.valuationCurrency.trim().length === 0) {
      throw new ValidationError("Valuation currency is required");
    }
  }

  private validateTokenizationInput(input: CreateTokenizationInput): void {
    if (!/^\d+$/.test(input.totalUnits) || BigInt(input.totalUnits) <= 0n) {
      throw new ValidationError("Total units must be a positive integer");
    }
    if (
      !/^\d+$/.test(input.pricePerUnitAmount) ||
      BigInt(input.pricePerUnitAmount) <= 0n
    ) {
      throw new ValidationError("Price per unit must be a positive integer");
    }
    if (
      !input.pricePerUnitCurrency ||
      input.pricePerUnitCurrency.trim().length === 0
    ) {
      throw new ValidationError("Price currency is required");
    }
  }
}
