/**
 * Phase 5: RWA Service
 * Business logic for tokenization operations.
 *
 * DTOs use integer strings for units/amounts (JSON-safe). Exact arithmetic
 * (pro-rata shares, capacity checks) converts to `bigint` locally.
 */

import {
  ChainSigningMode,
  EntryDirection,
  RwaTransition,
  TokenHoldingStatus,
  type CurrencyCode,
  type PreparedRwaOperationResponse,
  type RwaCapabilitiesResponse,
  type TokenHoldingDTO,
} from "@stellartrust/shared";
import type { LedgerTransactionInput } from "@stellartrust/shared";
import { config } from "../../config/index.js";
import { networkPassphrase } from "../stellar/stellar.client.js";
import type { RwaOperationInput } from "./rwa.gateway.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { assertStellarAddress } from "../stellar/address.js";
import {
  RWA_INVESTMENT_LIABILITY,
  RWA_INVESTOR_CASH_CLEARING,
  RWA_ISSUER_PROCEEDS_PAYABLE,
  RWA_PAYOUT_PAYABLE,
  RWA_PAYOUT_RESERVE,
  RWA_PLATFORM_FEE_REVENUE,
  RWA_RECOVERY_RECEIVABLE,
} from "../ledger/system-accounts.js";
import {
  applyBps,
  daysBetween,
  pricePerUnitFor,
  proRataShares,
  splitCollection,
  validateTerms,
  type FinancingTerms,
  type WaterfallSplit,
} from "./rwa.financing.js";
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
    const { terms, totalUnits } = this.validateTokenizationInput(input);

    const asset = await this.repository.findAsset(input.assetId);
    if (!asset) {
      throw new NotFoundError("Asset not found");
    }
    if (asset.ownerUserId !== issuerUserId) {
      throw new ForbiddenError("Only the asset owner can tokenize it");
    }

    // The unit price is derived, never supplied. A price inconsistent with the
    // financing terms is the easiest way to end up with a waterfall that cannot
    // be paid, so the server computes it from the terms it just validated.
    const pricePerUnitAmount = pricePerUnitFor(terms, totalUnits).toString();

    const tokenization = await this.repository.createTokenization(issuerUserId, {
      ...input,
      pricePerUnitAmount,
      pricePerUnitCurrency: input.faceValueCurrency,
      platformFeeBps: input.platformFeeBps ?? 0,
    });

    await this.audit.append({
      actor: `user:${issuerUserId}`,
      action: "rwa.create_tokenization",
      entity: "tokenization",
      entityId: tokenization.id,
      metadata: {
        assetId: input.assetId,
        totalUnits: input.totalUnits,
        faceValue: input.faceValueAmount,
        advanceRateBps: input.advanceRateBps,
        discountRateBps: input.discountRateBps,
        platformFeeBps: input.platformFeeBps ?? 0,
        maturityDate: input.maturityDate,
        pricePerUnit: pricePerUnitAmount,
        currency: input.faceValueCurrency,
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

    if (
      (await this.gateway.signingMode(RwaTransition.Deploy)) ===
      ChainSigningMode.Wallet
    ) {
      throw new ConflictError(
        "Under issuer custody you hold your own units, so the tokenization " +
          `must be signed by your wallet. Call POST /rwa/tokenizations/${tokenizationId}` +
          "/deploy/prepare, sign the returned transaction, then submit it.",
      );
    }

    // The issuer must have a SEP-10-proven wallet before their asset can be
    // tokenized: it is where payouts go, and resolving it here surfaces "you
    // have not connected a wallet" at the one moment the user can act on it.
    const issuerWallet = await this.addresses.resolve(
      tokenization.issuerUserId,
      "issuer",
    );

    // The *on-chain* issuer under platform custody is the server signer, not
    // the issuer's own account. That is a custodial arrangement, so it is
    // asked for explicitly and audited below rather than assumed.
    const onChainIssuer = await this.gateway.issuerAddress(
      tokenization.issuerUserId,
    );

    const contractId = await this.gateway.deployToken({
      issuerUserId: tokenization.issuerUserId,
      issuerAddress: onChainIssuer,
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
      metadata: {
        contractId,
        status: TokenizationStatus.Active,
        // Both addresses are recorded: who the books consider the issuer, and
        // who actually holds the supply on-chain. A custodial arrangement
        // should be legible in the audit trail, not implied by code.
        issuerWallet,
        onChainIssuer,
        custody: this.gateway.custody(),
      },
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

    // ── The money moves here, before any units do ───────────────────────────
    //
    // This posting is the whole difference between a subscription and a
    // giveaway. Until it existed, `purchaseUnits` wrote a holding row and an
    // audit entry and charged nobody: the investor paid nothing and the issuer
    // received nothing.
    //
    // It runs before the chain transfer for the same reason the escrow path
    // settles the chain before the ledger, inverted: here the ledger *is* the
    // obligation being created, and a transfer of units against an unrecorded
    // payment would hand out ownership for free. If the posting throws, no
    // units have moved and no holding exists.
    //
    // The reference id is derived from what caused the purchase, not from a
    // timestamp, so a retried click converges on one posting instead of
    // charging twice.
    const ledgerReferenceId = `rwa-subscription:${tokenizationId}:${actor.userId}:${units}`;
    const ledgerTransaction = await this.recordSubscriptionLedger(
      ledgerReferenceId,
      tokenization,
      purchaseAmount,
    );

    // Under issuer custody the platform holds no key for the issuer's account,
    // so it cannot deliver the units itself. The purchase is still real — the
    // units are reserved and paid for — but delivery waits for the issuer's
    // signature, and the holding says so rather than claiming units that have
    // not moved.
    const walletSigned =
      (await this.gateway.signingMode(RwaTransition.Transfer)) ===
      ChainSigningMode.Wallet;

    if (tokenization.contractId && !walletSigned) {
      const onChainIssuer = await this.gateway.issuerAddress(
        tokenization.issuerUserId,
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
        issuerUserId: tokenization.issuerUserId,
        from: onChainIssuer,
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
      status: walletSigned
        ? TokenHoldingStatus.Pending
        : TokenHoldingStatus.Settled,
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
        ledgerTransactionId: ledgerTransaction.id,
      },
    });

    return this.getTokenizationDetails(tokenizationId);
  }

  /**
   * Post the balanced entries for an investor subscription.
   *
   * Three legs, because a subscription is not a simple transfer — the platform
   * stands between the investor and the issuer, and the issuer receives *less*
   * than the investor pays. That difference is the investors' discount, which
   * is earned back out of the face value when the debtor pays:
   *
   *   debit  investor cash clearing     purchaseAmount   (cash in)
   *   credit issuer proceeds payable    issuerShare      (owed to the issuer)
   *   credit investment liability       discountHeld     (owed to investors
   *                                                       at collection)
   *
   * The two credits sum to the debit, so the transaction balances and the
   * database constraint that rejects unbalanced writes is satisfied by
   * construction rather than by hoping.
   *
   * A `ConflictError` means a concurrent attempt at the same subscription won
   * the race; the ledger already holds the truth, so its id is recovered
   * rather than failing a purchase that has in fact been paid for.
   */
  private async recordSubscriptionLedger(
    referenceId: string,
    tokenization: TokenizationDTO,
    purchaseAmount: bigint,
  ): Promise<{ id: string }> {
    const currency = tokenization.pricePerUnitCurrency as CurrencyCode;

    // The discount this investor's share carries, computed from the same terms
    // the waterfall will use at collection. Deriving both from one function
    // keeps the two sides of the deal consistent.
    const discountHeld = applyBps(
      purchaseAmount,
      BigInt(tokenization.discountRateBps),
    );
    const issuerShare = purchaseAmount - discountHeld;

    const entries: LedgerTransactionInput["entries"] = [
      {
        accountId: RWA_INVESTOR_CASH_CLEARING,
        direction: EntryDirection.Debit,
        amount: purchaseAmount.toString(),
        currency,
      },
      {
        accountId: RWA_ISSUER_PROCEEDS_PAYABLE,
        direction: EntryDirection.Credit,
        amount: issuerShare.toString(),
        currency,
      },
    ];

    // A zero-amount entry is rejected by the ledger schema, so the discount leg
    // is only posted when there is a discount to hold. At a 0% rate the
    // subscription is simply cash in, proceeds out.
    if (discountHeld > 0n) {
      entries.push({
        accountId: RWA_INVESTMENT_LIABILITY,
        direction: EntryDirection.Credit,
        amount: discountHeld.toString(),
        currency,
      });
    }

    const input: LedgerTransactionInput = {
      referenceId,
      description: `RWA subscription for tokenization ${tokenization.id}`,
      entries,
    };

    try {
      return await this.ledger.record(input);
    } catch (err) {
      if (!(err instanceof ConflictError)) throw err;
      const existing = await this.ledger.getByReference(referenceId);
      if (!existing) throw err;
      logger.info(
        { tokenizationId: tokenization.id, ledgerTransactionId: existing.id },
        "RWA subscription ledger transaction already posted; reusing it",
      );
      return existing;
    }
  }

  // ── Issuer-signed operations (RWA_CUSTODY=issuer) ─────────────────────────

  /**
   * How each contract operation is signed here, so a client can pick the
   * single-call or the wallet round-trip path without hard-coding a custody
   * model that changes with configuration.
   */
  async capabilities(): Promise<RwaCapabilitiesResponse> {
    const signingModes: Record<string, ChainSigningMode> = {};
    const walletSignedTransitions: RwaTransition[] = [];
    for (const transition of Object.values(RwaTransition)) {
      const mode = await this.gateway.signingMode(transition);
      signingModes[transition] = mode;
      if (mode === ChainSigningMode.Wallet) {
        walletSignedTransitions.push(transition);
      }
    }
    return {
      custody: this.gateway.custody(),
      network: config.STELLAR_NETWORK,
      networkPassphrase: networkPassphrase(),
      signingModes,
      walletSignedTransitions,
    };
  }

  /**
   * Build the unsigned contract transaction the issuer must sign.
   *
   * Authorization and state checks all run here, before any chain work, so an
   * unauthorized caller never causes a contract deploy. For a deploy the
   * contract id is persisted before returning: an abandoned signature then
   * costs one idle contract rather than one per retry.
   */
  async prepareOperation(
    tokenizationId: string,
    transition: RwaTransition,
    actor: RwaActor,
    args: { holdingId?: string; holderAddress?: string } = {},
  ): Promise<PreparedRwaOperationResponse> {
    if (
      (await this.gateway.signingMode(transition)) !== ChainSigningMode.Wallet
    ) {
      throw new ConflictError(
        `The '${transition}' operation does not require a wallet signature here`,
      );
    }
    const tokenization = await this.requireTokenization(tokenizationId);
    this.authorizeIssuerOperation(tokenization, transition, actor);

    const holding = args.holdingId
      ? await this.requirePendingHolding(tokenizationId, args.holdingId)
      : undefined;

    const prepared = await this.gateway.prepareOperation(
      await this.operationInput(tokenization, transition, {
        holding,
        holderAddress: args.holderAddress,
      }),
    );

    if (transition === RwaTransition.Deploy && !tokenization.contractId) {
      // The instance exists on-chain but holds nothing until the issuer signs.
      // Status stays Draft: nothing is tokenized yet.
      await this.repository.updateTokenization({
        ...tokenization,
        contractId: prepared.contractId,
      });
    }

    await this.audit.append({
      actor: `user:${actor.userId}`,
      action: `rwa.${transition}.prepared`,
      entity: "tokenization",
      entityId: tokenization.id,
      metadata: {
        contractId: prepared.contractId,
        signerAddress: prepared.signerAddress,
        holdingId: holding?.id ?? null,
      },
    });

    return {
      tokenizationId,
      transition,
      unsignedXdr: prepared.unsignedXdr,
      networkPassphrase: prepared.networkPassphrase,
      signerAddress: prepared.signerAddress,
      contractId: prepared.contractId,
      holdingId: holding?.id ?? null,
      expiresAt: prepared.expiresAt,
    };
  }

  /**
   * Submit an issuer-signed envelope, then apply what it did to our records.
   *
   * The chain call comes first and must settle; only then do the records move.
   * The other order would let a rejected transaction leave us claiming units
   * were delivered, or a token frozen, when nothing happened.
   */
  async submitSignedOperation(
    tokenizationId: string,
    transition: RwaTransition,
    actor: RwaActor,
    signedXdr: string,
    args: { holdingId?: string; holderAddress?: string } = {},
  ): Promise<TokenizationDetailsResponse> {
    if (
      (await this.gateway.signingMode(transition)) !== ChainSigningMode.Wallet
    ) {
      throw new ConflictError(
        `The '${transition}' operation does not require a wallet signature here`,
      );
    }
    const tokenization = await this.requireTokenization(tokenizationId);
    this.authorizeIssuerOperation(tokenization, transition, actor);

    const holding = args.holdingId
      ? await this.requirePendingHolding(tokenizationId, args.holdingId)
      : undefined;

    await this.gateway.submitSignedOperation(
      await this.operationInput(tokenization, transition, {
        holding,
        holderAddress: args.holderAddress,
      }),
      signedXdr,
    );

    await this.applyOperationToRecords(tokenization, transition, holding);
    await this.audit.append({
      actor: `user:${actor.userId}`,
      action: `rwa.${transition}`,
      entity: "tokenization",
      entityId: tokenization.id,
      metadata: {
        contractId: tokenization.contractId,
        holdingId: holding?.id ?? null,
      },
    });

    return this.getTokenizationDetails(tokenizationId);
  }

  /** Everything the gateway needs to build one issuer-authorized call. */
  private async operationInput(
    tokenization: TokenizationDTO,
    transition: RwaTransition,
    context: { holding?: TokenHoldingDTO; holderAddress?: string },
  ): Promise<RwaOperationInput> {
    const asset = await this.repository.findAsset(tokenization.assetId);
    if (!asset) throw new NotFoundError("Asset not found");

    return {
      transition,
      issuerUserId: tokenization.issuerUserId,
      contractId: tokenization.contractId,
      deploy:
        transition === RwaTransition.Deploy
          ? {
              assetRef: asset.assetRef,
              assetType: asset.assetType,
              description: asset.description,
              totalUnits: BigInt(tokenization.totalUnits),
              requireAuthorization: tokenization.requireAuthorization,
            }
          : undefined,
      transfer:
        transition === RwaTransition.Transfer && context.holding
          ? {
              to: context.holding.holderAddress,
              units: BigInt(context.holding.units),
            }
          : undefined,
      holderAddress:
        context.holderAddress ?? context.holding?.holderAddress ?? undefined,
    };
  }

  /** Move our records to match what the signed operation just did on-chain. */
  private async applyOperationToRecords(
    tokenization: TokenizationDTO,
    transition: RwaTransition,
    holding?: TokenHoldingDTO,
  ): Promise<void> {
    switch (transition) {
      case RwaTransition.Deploy:
        await this.repository.updateTokenization({
          ...tokenization,
          contractDeployedAt: new Date().toISOString(),
          status: TokenizationStatus.Active,
        });
        return;
      case RwaTransition.Transfer:
        if (!holding) return;
        // The units exist at the holder's address now, so the holding stops
        // being a claim and becomes a balance reconciliation can check.
        await this.repository.updateHolding({
          ...holding,
          status: TokenHoldingStatus.Settled,
          updatedAt: new Date().toISOString(),
        });
        return;
      case RwaTransition.Freeze:
      case RwaTransition.Unfreeze:
        await this.repository.updateTokenization({
          ...tokenization,
          frozen: transition === RwaTransition.Freeze,
        });
        return;
      case RwaTransition.Authorize:
      case RwaTransition.Revoke:
      case RwaTransition.Distribute:
        // Authorization lives on the contract, and the payout guard is the
        // contract's own flag; neither has a record of its own to update.
        return;
    }
  }

  /**
   * Only the issuer may authorize their own contract — because only they can.
   *
   * Compliance can still freeze the *record* (see {@link freezeTokenization}),
   * but the contract will not accept a freeze it did not sign, so offering
   * compliance a prepare here would produce an envelope nobody can sign.
   */
  private authorizeIssuerOperation(
    tokenization: TokenizationDTO,
    transition: RwaTransition,
    actor: RwaActor,
  ): void {
    if (tokenization.issuerUserId !== actor.userId) {
      throw new ForbiddenError(
        `Only the issuer can sign the '${transition}' operation for this ` +
          "tokenization; the contract requires their account's authorization",
      );
    }
  }

  private async requirePendingHolding(
    tokenizationId: string,
    holdingId: string,
  ): Promise<TokenHoldingDTO> {
    const holdings = await this.repository.listHoldings(tokenizationId);
    const holding = holdings.find((h) => h.id === holdingId);
    if (!holding) throw new NotFoundError("Holding not found");
    if (holding.status !== TokenHoldingStatus.Pending) {
      throw new ConflictError(
        `Holding ${holdingId} is already ${holding.status}`,
      );
    }
    return holding;
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

    // Only delivered holdings earn a payout. A pending one is a claim on units
    // the issuer has not signed over yet: there is no on-chain balance behind
    // it, and paying against it would take money from the holders who do have
    // one.
    const holdings = (await this.repository.listHoldings(tokenizationId)).filter(
      (holding) => holding.status === TokenHoldingStatus.Settled,
    );
    if (holdings.length === 0) {
      throw new ConflictError("No settled holdings to distribute to");
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

    // Split the collection across the waterfall before anyone is paid
    // (plane.md §1.3). `payoutAmount` is what the debtor actually paid; only
    // the investor leg is distributed pro-rata. Distributing the whole amount
    // — which is what this did before — silently handed the platform's fee and
    // the seller's retained first-loss to the investors, so the seller
    // financed nothing and the residual that makes the structure work
    // disappeared.
    const split = this.waterfallFor(tokenization, payoutAmount, new Date());

    if (split.investorTotal <= 0n) {
      throw new ConflictError(
        "Collection is too small to pay the investor leg of the waterfall",
      );
    }

    const calculations = this.calculatePayoutShares(
      holdings.map((h) => ({
        holderUserId: h.holderUserId,
        holderAddress: h.holderAddress,
        unitsHeld: h.units,
      })),
      BigInt(tokenization.totalUnits),
      split.investorTotal,
    );

    // Recompute the same shares on-chain and require agreement. The contract
    // owns the unit balances; our holdings table is a mirror of them, and the
    // two can drift (a holder transferring units directly, a transfer that
    // failed after the row was written). Paying out against a stale mirror
    // sends money to the wrong people, so a disagreement stops the payout.
    //
    // The contract is asked to split the *investor leg*, not the gross
    // collection: it knows unit balances, not the waterfall, so handing it the
    // full amount would have it divide a number our own shares were never
    // computed from and every payout would fail as drift.
    await this.assertSharesAgree(tokenization, calculations, split.investorTotal);

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
        split,
      ));

    // Now claim the on-chain guard. A retry finds it already set, which is the
    // expected outcome once the ledger posting above has been recognised as a
    // repeat — the contract, not this code, is the authority on it.
    //
    // Under issuer custody we cannot set it: the contract requires the
    // issuer's signature. The money has still moved (that is this ledger
    // posting, which is platform-side), so the payout completes — but the
    // guard stays unclaimed until the issuer signs, and the reconciliation job
    // reports that gap rather than letting it pass unnoticed.
    if (tokenization.contractId) {
      if (
        (await this.gateway.signingMode(RwaTransition.Distribute)) ===
        ChainSigningMode.Wallet
      ) {
        await this.audit.append({
          actor: `user:${actor.userId}`,
          action: "rwa.distribute.guard_pending",
          entity: "tokenization",
          entityId: tokenization.id,
          metadata: {
            contractId: tokenization.contractId,
            reason:
              "mark_distributed requires the issuer's signature under issuer custody",
          },
        });
      } else {
        await this.markDistributedOnce(tokenization.contractId);
      }
    }

    const completed = await this.repository.updateDistribution({
      ...distribution,
      status: PayoutStatus.Completed,
      completedAt: new Date().toISOString(),
      ledgerTransactionId: ledgerTransaction.id,
    });

    // Record the collection outcome on the tokenization itself. A collection
    // that cleared the investor leg in full closes the position as `Repaid`;
    // one that fell short leaves it open, because the shortfall is the input
    // to the default and write-off path (§1.4) rather than a finished payout.
    const collectedAt = tokenization.collectedAt ?? now;
    await this.repository.updateTokenization({
      ...tokenization,
      collectedAt,
      status:
        split.shortfall === 0n
          ? TokenizationStatus.Repaid
          : tokenization.status,
      updatedAt: new Date().toISOString(),
    });

    await this.audit.append({
      actor: `user:${actor.userId}`,
      action: "rwa.distribute_payout",
      entity: "distribution",
      entityId: distribution.id,
      metadata: {
        tokenizationId,
        orderId,
        // What arrived, and how the waterfall split it. Recorded leg by leg so
        // the audit trail explains why investors received less than the
        // collection rather than only showing the final number.
        collectedAmount: payoutAmount.toString(),
        investorTotal: split.investorTotal.toString(),
        investorPrincipal: split.investorPrincipal.toString(),
        investorYield: split.investorYield.toString(),
        platformFee: split.platformFee.toString(),
        sellerResidual: split.sellerResidual.toString(),
        shortfall: split.shortfall.toString(),
        holdersCount: holdings.length,
      },
    });

    return completed;
  }

  /**
   * Close a defaulted position, distributing any recovery pro-rata (§1.4).
   *
   * The last state in the lifecycle. A default says the debtor missed the
   * grace window; a write-off says the platform has stopped expecting the rest
   * — a credit judgement, which is why this is operator-initiated rather than
   * another date-driven sweep. Whatever was recovered (a partial payment, a
   * collections settlement, nothing at all) is split across holders by units
   * held, and the position closes.
   *
   * Recovery is distributed *pro-rata only*: the waterfall does not apply. Its
   * priority ordering exists to pay the platform and seller out of a surplus,
   * and a write-off is by definition the case where no surplus exists —
   * charging a fee against investors' recovered principal would invert the
   * first-loss structure the model is built on.
   */
  async writeOffTokenization(
    tokenizationId: string,
    recoveredAmount: bigint,
    actor: RwaActor,
  ): Promise<TokenizationDTO> {
    const tokenization = await this.requireTokenization(tokenizationId);

    if (!actor.roles.includes("compliance") && !actor.roles.includes("system")) {
      throw new ForbiddenError("Only compliance can write off a position");
    }
    if (recoveredAmount < 0n) {
      throw new ValidationError("Recovered amount cannot be negative");
    }
    // Only a defaulted position can be written off. Writing off anything
    // earlier would close a position whose debtor may still be inside the
    // grace window, destroying the investors' claim while it is still live.
    if (tokenization.status !== TokenizationStatus.Defaulted) {
      throw new ConflictError(
        `Only a defaulted tokenization can be written off; ` +
          `${tokenizationId} is ${tokenization.status}`,
      );
    }

    const holdings = (await this.repository.listHoldings(tokenizationId)).filter(
      (holding) => holding.status === TokenHoldingStatus.Settled,
    );

    // A recovery large enough to divide is distributed; anything smaller
    // closes the position without a posting. Both are legitimate outcomes of a
    // write-off, and a zero-amount ledger entry is rejected by the schema.
    let ledgerTransactionId: string | undefined;
    if (recoveredAmount > 0n && holdings.length > 0) {
      const shares = proRataShares(
        holdings.map((h) => BigInt(h.units)),
        recoveredAmount,
      );
      const distributed = shares.reduce((sum, share) => sum + share, 0n);

      if (distributed > 0n) {
        const referenceId = `rwa-writeoff:${tokenizationId}`;
        const existing = await this.ledger.getByReference(referenceId);
        const posted =
          existing ??
          (await this.ledger.record({
            referenceId,
            description: `RWA write-off recovery for tokenization ${tokenizationId}`,
            entries: [
              {
                accountId: RWA_RECOVERY_RECEIVABLE,
                direction: EntryDirection.Debit,
                amount: distributed.toString(),
                currency: tokenization.faceValueCurrency,
              },
              {
                accountId: RWA_PAYOUT_PAYABLE,
                direction: EntryDirection.Credit,
                amount: distributed.toString(),
                currency: tokenization.faceValueCurrency,
              },
            ],
          }));
        ledgerTransactionId = posted.id;
      }
    }

    const updated = await this.repository.updateTokenization({
      ...tokenization,
      status: TokenizationStatus.WrittenOff,
      updatedAt: new Date().toISOString(),
    });

    await this.audit.append({
      actor: `user:${actor.userId}`,
      action: "rwa.write_off_tokenization",
      entity: "tokenization",
      entityId: tokenizationId,
      metadata: {
        recoveredAmount: recoveredAmount.toString(),
        holdersCount: holdings.length,
        from: tokenization.status,
        to: TokenizationStatus.WrittenOff,
        ...(ledgerTransactionId ? { ledgerTransactionId } : {}),
      },
    });

    return updated;
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

    const onChain = await this.applyFreeze(tokenization, true, actor);

    const updated = await this.repository.updateTokenization({
      ...tokenization,
      frozen: true,
    });

    await this.audit.append({
      actor: `user:${actor.userId}`,
      action: "rwa.freeze_tokenization",
      entity: "tokenization",
      entityId: tokenization.id,
      metadata: { frozen: true, appliedOnChain: onChain },
    });

    return updated;
  }

  /**
   * Apply a freeze to the contract if this deployment can, and say whether it
   * did.
   *
   * Under issuer custody it cannot: the contract accepts `freeze` only from
   * the issuer, so a self-custodied token is not something compliance can halt
   * unilaterally. That is a real property of handing issuers their own keys,
   * not a bug to paper over. The platform-side freeze still takes effect
   * immediately — no further purchases are mediated — and the divergence is
   * left visible for reconciliation to report until the issuer signs.
   *
   * @returns whether the contract itself was frozen.
   */
  private async applyFreeze(
    tokenization: TokenizationDTO,
    frozen: boolean,
    actor: RwaActor,
  ): Promise<boolean> {
    if (!tokenization.contractId) return false;

    const transition = frozen
      ? RwaTransition.Freeze
      : RwaTransition.Unfreeze;
    if (
      (await this.gateway.signingMode(transition)) === ChainSigningMode.Wallet
    ) {
      await this.audit.append({
        actor: `user:${actor.userId}`,
        action: `rwa.${transition}.requires_issuer`,
        entity: "tokenization",
        entityId: tokenization.id,
        metadata: {
          contractId: tokenization.contractId,
          reason:
            "the token contract accepts this only from the issuer under issuer custody",
        },
      });
      return false;
    }

    if (frozen) {
      await this.gateway.freezeToken(tokenization.contractId);
    } else {
      await this.gateway.unfreezeToken(tokenization.contractId);
    }
    return true;
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

    const onChain = await this.applyFreeze(tokenization, false, actor);

    const updated = await this.repository.updateTokenization({
      ...tokenization,
      frozen: false,
    });

    await this.audit.append({
      actor: `user:${actor.userId}`,
      action: "rwa.unfreeze_tokenization",
      entity: "tokenization",
      entityId: tokenization.id,
      metadata: { frozen: false, appliedOnChain: onChain },
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
    split: WaterfallSplit,
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

    // The waterfall's three legs, posted against one debit of what was
    // collected (plane.md §1.3). The investor credit is `totalAmount` — the
    // sum of the per-holder shares actually written — rather than
    // `split.investorTotal`, so the posting reconciles with the payout records
    // exactly even where largest-remainder distribution moved a minor unit.
    //
    // Legs that round to zero are omitted: the ledger schema rejects a
    // zero-amount entry, and a partial collection legitimately leaves the
    // platform and seller with nothing.
    const collected = totalAmount + split.platformFee + split.sellerResidual;
    const entries: LedgerTransactionInput["entries"] = [
      {
        accountId: RWA_PAYOUT_RESERVE,
        direction: EntryDirection.Debit,
        amount: collected.toString(),
        currency: currency as CurrencyCode,
      },
      {
        accountId: RWA_PAYOUT_PAYABLE,
        direction: EntryDirection.Credit,
        amount: totalAmount.toString(),
        currency: currency as CurrencyCode,
      },
    ];
    if (split.platformFee > 0n) {
      entries.push({
        accountId: RWA_PLATFORM_FEE_REVENUE,
        direction: EntryDirection.Credit,
        amount: split.platformFee.toString(),
        currency: currency as CurrencyCode,
      });
    }
    if (split.sellerResidual > 0n) {
      entries.push({
        accountId: RWA_ISSUER_PROCEEDS_PAYABLE,
        direction: EntryDirection.Credit,
        amount: split.sellerResidual.toString(),
        currency: currency as CurrencyCode,
      });
    }

    const input: LedgerTransactionInput = {
      referenceId,
      description: `RWA payout distribution for tokenization ${tokenization.id}`,
      entries,
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
   * Check our pro-rata shares against the ones the contract computes.
   *
   * The token contract is the authority on who holds what; `holdings` is a
   * mirror maintained by this service. The contract's own `all_payout_shares`
   * is therefore the check with teeth — it reads real balances, applies the
   * same integer division, and needs no trust in our records.
   *
   * The custodian's residual balance (unsold supply) appears on-chain and not
   * in `holdings`, so it is excluded before comparing: unsold units are not
   * owed a payout.
   */
  private async assertSharesAgree(
    tokenization: TokenizationDTO,
    calculations: PayoutCalculation[],
    payoutAmount: bigint,
  ): Promise<void> {
    if (!tokenization.contractId) return;

    const onChainIssuer = await this.gateway.issuerAddress(
      tokenization.issuerUserId,
    );
    const onChain = await this.gateway.getPayoutShares({
      contractId: tokenization.contractId,
      payoutAmount,
    });

    const expected = new Map(
      calculations.map((c) => [c.holderAddress, BigInt(c.shareAmount)]),
    );
    const actual = new Map(
      onChain
        .filter((share) => share.holderAddress !== onChainIssuer)
        .map((share) => [share.holderAddress, share.shareAmount]),
    );

    for (const [address, share] of expected) {
      const chainShare = actual.get(address);
      if (chainShare === undefined) {
        throw new ConflictError(
          `Tokenization ${tokenization.id} records a holding for ${address} ` +
            "that the token contract does not; refusing to distribute a payout " +
            "against unit records the chain disagrees with",
        );
      }
      if (chainShare !== share) {
        throw new ConflictError(
          `Payout share for ${address} is ${share} in our records but ` +
            `${chainShare} on-chain; unit balances have drifted`,
        );
      }
    }
    for (const address of actual.keys()) {
      if (!expected.has(address)) {
        throw new ConflictError(
          `The token contract reports a holder (${address}) that ` +
            `tokenization ${tokenization.id} has no record of; refusing to ` +
            "distribute a payout that would skip them",
        );
      }
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

  /**
   * Validate the financing terms and return them as exact integers.
   *
   * Everything checked here is checked at *creation*, which is the point: the
   * expensive failure is a tokenization that sells units for months and only
   * proves unpayable when the debtor finally pays.
   */
  private validateTokenizationInput(
    input: CreateTokenizationInput,
  ): { terms: FinancingTerms; totalUnits: bigint } {
    if (!/^\d+$/.test(input.totalUnits) || BigInt(input.totalUnits) <= 0n) {
      throw new ValidationError("Total units must be a positive integer");
    }
    if (
      !/^\d+$/.test(input.faceValueAmount) ||
      BigInt(input.faceValueAmount) <= 0n
    ) {
      throw new ValidationError("Face value must be a positive integer");
    }
    if (
      !input.faceValueCurrency ||
      input.faceValueCurrency.trim().length === 0
    ) {
      throw new ValidationError("Face value currency is required");
    }
    for (const [name, value] of [
      ["Advance rate", input.advanceRateBps],
      ["Discount rate", input.discountRateBps],
      ["Platform fee", input.platformFeeBps ?? 0],
    ] as const) {
      if (!Number.isInteger(value)) {
        throw new ValidationError(`${name} must be a whole number of basis points`);
      }
    }

    // A maturity in the past means the position is born defaulted, and late
    // yield would start accruing before anyone had subscribed.
    const maturity = new Date(input.maturityDate);
    if (Number.isNaN(maturity.getTime())) {
      throw new ValidationError("Maturity date must be a valid ISO-8601 date");
    }
    if (maturity.getTime() <= Date.now()) {
      throw new ValidationError("Maturity date must be in the future");
    }

    const terms: FinancingTerms = {
      faceValue: BigInt(input.faceValueAmount),
      advanceRateBps: BigInt(input.advanceRateBps),
      discountRateBps: BigInt(input.discountRateBps),
      platformFeeBps: BigInt(input.platformFeeBps ?? 0),
    };
    const totalUnits = BigInt(input.totalUnits);

    // Range checks, payability, and a representable unit price.
    validateTerms(terms, totalUnits);

    return { terms, totalUnits };
  }

  /**
   * The stored financing terms of a tokenization, as exact integers.
   *
   * The DTO carries them as JSON-safe strings and numbers; the arithmetic in
   * `rwa.financing.ts` is `bigint`-only. This is the single conversion point,
   * so a widened column or a renamed field breaks in one place.
   */
  private termsOf(tokenization: TokenizationDTO): FinancingTerms {
    return {
      faceValue: BigInt(tokenization.faceValueAmount),
      advanceRateBps: BigInt(tokenization.advanceRateBps),
      discountRateBps: BigInt(tokenization.discountRateBps),
      platformFeeBps: BigInt(tokenization.platformFeeBps),
    };
  }

  /**
   * Split a collected amount across the payout waterfall (plane.md §1.3).
   *
   * Late yield accrues against `collectedAt` when the collection has been
   * recorded, and otherwise against `now`. Reading the clock here rather than
   * inside `splitCollection` keeps that function pure and lets tests pin the
   * date; the accrual date is the one input that genuinely varies with when
   * the debtor paid rather than when this code runs.
   *
   * `termDays` is measured from creation to maturity — the contractual window
   * the discount was priced for — so the daily late rate is derived from the
   * deal's own terms rather than an assumed year fraction.
   */
  private waterfallFor(
    tokenization: TokenizationDTO,
    collected: bigint,
    now: Date,
  ): WaterfallSplit {
    const maturity = new Date(tokenization.maturityDate);
    const collectedAt = tokenization.collectedAt
      ? new Date(tokenization.collectedAt)
      : now;

    return splitCollection(this.termsOf(tokenization), collected, {
      termDays: daysBetween(new Date(tokenization.createdAt), maturity),
      daysLate: daysBetween(maturity, collectedAt),
    });
  }
}
