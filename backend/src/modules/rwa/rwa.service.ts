/**
 * Phase 5: RWA Service
 * Business logic for tokenization operations.
 *
 * DTOs use integer strings for units/amounts (JSON-safe). Exact arithmetic
 * (pro-rata shares, capacity checks) converts to `bigint` locally.
 */

import {
  AssetType,
  AssetVerificationStatus,
  ChainSigningMode,
  EntryDirection,
  KycStatus,
  RwaTransition,
  TokenHoldingStatus,
  type CurrencyCode,
  type PreparedRwaOperationResponse,
  type RwaCapabilitiesResponse,
  type SecondaryTransferResponse,
  type TokenHoldingDTO,
  type TokenizationListResponse,
  type SecondaryTransferInput,
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
// `rwa_investor_cash_clearing`, `rwa_payout_payable` and
// `rwa_secondary_seller_payable` are deliberately no longer imported. Each was
// the shared account standing in for a user who had no account of their own;
// every posting that used one now addresses the user directly (plane.md §4.5).
// The seeded rows stay — they hold the history posted before the change — but
// nothing new lands on them.
import {
  RWA_INVESTMENT_LIABILITY,
  RWA_ISSUER_PROCEEDS_PAYABLE,
  RWA_PAYOUT_RESERVE,
  RWA_PLATFORM_FEE_REVENUE,
  RWA_RECOVERY_RECEIVABLE,
} from "../ledger/system-accounts.js";
import {
  applyBps,
  daysBetween,
  investorYieldFor,
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
  AssetDocumentInput,
  CreateAssetInput,
  PayoutRecordDTO,
  PortfolioPositionDTO,
  ReviewAssetInput,
  TokenizationRiskDTO,
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
  /**
   * The ledger account reference an individual user's cash posts against
   * (plane.md §4.5).
   *
   * Part of the port rather than constructed here because the naming
   * convention is the ledger module's to own — RWA formatting the string
   * itself is how the two ends of a per-user balance drift apart.
   */
  userAccount(userId: string): string;
  /**
   * Refuse an operation the user cannot fund (plane.md §1.1, §3.2, §4.5).
   *
   * The check the plan had to leave unwritten while every posting landed on a
   * system account. It throws rather than returning a boolean: the only
   * correct response to an underfunded purchase is to stop, and a boolean
   * invites a caller to continue past it.
   */
  assertSufficientFunds(
    userId: string,
    currency: CurrencyCode,
    required: bigint,
  ): Promise<void>;
}

/**
 * Whether an order currently has an unresolved dispute (plane.md §2.2).
 *
 * A narrow port rather than the dispute service itself: RWA needs one boolean,
 * and depending on the whole service would recreate the cross-module coupling
 * the event spine exists to remove. Satisfied structurally by
 * `DisputeService`.
 */
export interface DisputeReader {
  hasOpenDispute(orderId: string): Promise<boolean>;
}

/**
 * Whether an investor has cleared KYC (plane.md §3.2).
 *
 * A narrow port for the same reason as `DisputeReader`: RWA needs one status,
 * and importing `KycService` would put the whole identity module on the RWA
 * module's dependency edge. Satisfied structurally by `KycService`.
 */
export interface InvestorKycReader {
  getStatus(userId: string): Promise<{ status: KycStatus }>;
}

/**
 * Advisory credit score for a counterparty, in [0, 100] (plane.md §3.1).
 *
 * Scores are *surfaced*, never gating: a counterparty with no history scores
 * null, and refusing those would make the platform unusable for exactly the
 * new sellers it exists to finance.
 */
export interface CounterpartyReputationReader {
  getScore(userId: string): Promise<number>;
}

/** Investor-protection limits (plane.md §3.2), read from config at wiring. */
export interface InvestorLimits {
  /** Max share of one tokenization a single investor may hold, in bps. */
  maxConcentrationBps: number;
  /** Max outstanding exposure across all tokenizations, in minor units. */
  maxExposure: bigint;
  /** Smallest purchase the platform will accept, in minor units. */
  minTicketAmount: bigint;
  /** Purchases must be a whole multiple of this many units. */
  unitGranularity: bigint;
  /** Hours after purchase during which it may be cancelled. 0 disables it. */
  coolingOffHours: number;
}

/**
 * The limits applied when none are wired.
 *
 * Deliberately permissive rather than absent: a construction that forgot to
 * pass limits gets the old unrestricted behaviour and its tests keep meaning
 * what they meant, while `app.ts` — the only wiring that faces real users —
 * passes the configured ones. The alternative, defaulting to the strict
 * production numbers, would silently change what a dozen existing tests
 * assert about arithmetic that has nothing to do with §3.2.
 */
export const UNRESTRICTED_INVESTOR_LIMITS: InvestorLimits = {
  maxConcentrationBps: 10_000,
  maxExposure: 0n,
  minTicketAmount: 0n,
  unitGranularity: 1n,
  coolingOffHours: 0,
};

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
    /**
     * Optional so existing constructions keep working. When absent, the
     * `PayoutHeld` status is still honoured — only the live cross-check against
     * the dispute module is skipped.
     */
    private readonly disputes?: DisputeReader,
    /**
     * Investor protection (plane.md §3.2). Optional for the same reason the
     * dispute reader is: existing constructions keep working, and only the
     * wiring that faces real users passes the configured limits.
     */
    private readonly kyc?: InvestorKycReader,
    private readonly limits: InvestorLimits = UNRESTRICTED_INVESTOR_LIMITS,
    private readonly reputation?: CounterpartyReputationReader,
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

  /**
   * Attach supporting evidence to an asset (plane.md §3.1).
   *
   * Only before a decision: adding a document to an asset that compliance has
   * already verified would change what was approved without anyone re-reading
   * it. A rejected asset is terminal for the same reason — the issuer files a
   * fresh one rather than editing their way past a refusal.
   */
  async addAssetDocuments(
    assetId: string,
    actor: RwaActor,
    documents: AssetDocumentInput[],
  ): Promise<AssetDTO> {
    const asset = await this.requireAsset(assetId);
    if (asset.ownerUserId !== actor.userId) {
      throw new ForbiddenError("Only the asset owner can attach documents");
    }
    if (
      asset.verificationStatus === AssetVerificationStatus.Verified ||
      asset.verificationStatus === AssetVerificationStatus.Rejected
    ) {
      throw new ConflictError(
        `Asset verification is already ${asset.verificationStatus}; ` +
          "documents cannot be changed after a decision",
      );
    }
    if (documents.length === 0) {
      throw new ValidationError("At least one document is required");
    }
    for (const doc of documents) {
      if (!doc.docRef?.trim()) {
        throw new ValidationError("Document reference is required");
      }
      if (!doc.docType?.trim()) {
        throw new ValidationError("Document type is required");
      }
      // A digest that is not a digest is worse than none: it looks like
      // integrity evidence and proves nothing.
      if (doc.sha256 !== undefined && !/^[0-9a-f]{64}$/i.test(doc.sha256)) {
        throw new ValidationError("Document sha256 must be a hex SHA-256");
      }
    }

    const now = new Date().toISOString();
    const added = documents.map((doc) => ({
      docRef: doc.docRef,
      docType: doc.docType,
      sha256: doc.sha256 ?? null,
      uploadedAt: now,
    }));

    const updated = await this.repository.updateAsset({
      ...asset,
      documents: [...asset.documents, ...added],
    });

    await this.audit.append({
      actor: `user:${actor.userId}`,
      action: "rwa.add_asset_documents",
      entity: "asset",
      entityId: asset.id,
      // Document *references* and types only. The files themselves are opaque
      // to this platform and their contents never reach an audit row
      // (Rules.md §3).
      metadata: {
        docRefs: added.map((doc) => doc.docRef),
        docTypes: added.map((doc) => doc.docType),
        documentCount: updated.documents.length,
      },
    });

    return updated;
  }

  /**
   * Submit an asset for compliance review (plane.md §3.1).
   *
   * The evidence requirements are enforced here rather than at creation so an
   * issuer can draft an asset and gather documents over several requests. What
   * cannot happen is reaching `UnderReview` without them: a reviewer with
   * nothing to review would rubber-stamp a valuation, which is precisely the
   * failure this workflow exists to prevent.
   */
  async submitAssetForReview(
    assetId: string,
    actor: RwaActor,
  ): Promise<AssetDTO> {
    const asset = await this.requireAsset(assetId);
    if (asset.ownerUserId !== actor.userId) {
      throw new ForbiddenError("Only the asset owner can submit it for review");
    }
    if (asset.verificationStatus !== AssetVerificationStatus.Unverified) {
      throw new ConflictError(
        `Asset is ${asset.verificationStatus}; only an unverified asset can be submitted`,
      );
    }
    if (asset.documents.length === 0) {
      throw new ValidationError(
        "At least one supporting document is required before review",
      );
    }
    // An invoice with no named debtor cannot be credit-assessed at all: the
    // risk an investor takes is the counterparty's, so for a receivable it is
    // required rather than merely recorded.
    if (asset.assetType === AssetType.Invoice && !asset.counterparty) {
      throw new ValidationError(
        "A counterparty is required before an invoice can be reviewed",
      );
    }

    const updated = await this.repository.updateAsset({
      ...asset,
      verificationStatus: AssetVerificationStatus.UnderReview,
    });

    await this.audit.append({
      actor: `user:${actor.userId}`,
      action: "rwa.submit_asset_for_review",
      entity: "asset",
      entityId: asset.id,
      metadata: {
        documentCount: asset.documents.length,
        counterpartyRef: asset.counterparty?.ref ?? null,
        status: updated.verificationStatus,
      },
    });

    return updated;
  }

  /** Assets awaiting a compliance decision, oldest first. */
  async listAssetsForReview(actor: RwaActor): Promise<AssetDTO[]> {
    if (!actor.roles.includes("compliance")) {
      throw new ForbiddenError("Only compliance can read the review queue");
    }
    return this.repository.listAssetsForReview();
  }

  /**
   * Record a compliance decision on an asset under review (plane.md §3.1).
   *
   * Verifying is where the double-pledge check runs, not only at tokenization.
   * Both would work, but a seller is entitled to find out that their
   * receivable is already financed elsewhere at review time — when a human is
   * looking at it — rather than after building a deal on top of it. The check
   * runs again at tokenization anyway, because a competing pledge can appear
   * in between.
   */
  async reviewAsset(
    assetId: string,
    actor: RwaActor,
    input: ReviewAssetInput,
  ): Promise<AssetDTO> {
    if (!actor.roles.includes("compliance")) {
      throw new ForbiddenError("Only compliance can review an asset");
    }
    const asset = await this.requireAsset(assetId);
    if (asset.verificationStatus !== AssetVerificationStatus.UnderReview) {
      throw new ConflictError(
        `Asset is ${asset.verificationStatus}; only an asset under review can be decided`,
      );
    }
    if (input.decision !== "verify" && input.decision !== "reject") {
      throw new ValidationError(`Decision must be "verify" or "reject"`);
    }
    // A rejection the issuer cannot act on is a dead end. The reason is the
    // difference between "fix the appraisal date" and silence.
    if (input.decision === "reject" && !input.note?.trim()) {
      throw new ValidationError("A rejection must state a reason");
    }

    if (input.decision === "verify") {
      await this.assertNotDoublePledged(asset);
    }

    const now = new Date().toISOString();
    const updated = await this.repository.updateAsset({
      ...asset,
      verificationStatus:
        input.decision === "verify"
          ? AssetVerificationStatus.Verified
          : AssetVerificationStatus.Rejected,
      verifiedByUserId: actor.userId,
      verifiedAt: now,
      verificationNote: input.note?.trim() || null,
      counterparty: await this.scoreCounterparty(asset),
    });

    await this.audit.append({
      actor: `user:${actor.userId}`,
      action: "rwa.review_asset",
      entity: "asset",
      entityId: asset.id,
      metadata: {
        decision: input.decision,
        status: updated.verificationStatus,
        // The reviewer's own words, which are about the evidence rather than
        // about a person, and are the record of why this valuation was
        // accepted.
        note: updated.verificationNote,
        valuationAmount: asset.valuationAmount,
        valuationCurrency: asset.valuationCurrency,
      },
    });

    return updated;
  }

  /**
   * Refuse a second live financing of the same underlying asset.
   *
   * Double-pledging — the same receivable sold to two sets of investors — is
   * the classic invoice-financing fraud, and it is invisible to the unique
   * constraint on `(owner_user_id, asset_ref)` because the second filing is
   * usually made under another account. Matching on `assetRef` across owners
   * is what closes that.
   */
  private async assertNotDoublePledged(asset: AssetDTO): Promise<void> {
    const pledge = await this.repository.findActivePledge(
      asset.assetRef,
      asset.id,
    );
    if (!pledge) return;

    // The competing tokenization's id is withheld from the error: it belongs
    // to another party's deal, and naming it would leak one issuer's financing
    // to another. The audit entry carries it for compliance.
    await this.audit.append({
      actor: "system:rwa",
      action: "rwa.double_pledge_refused",
      entity: "asset",
      entityId: asset.id,
      metadata: {
        assetRef: asset.assetRef,
        conflictingTokenizationId: pledge.id,
        conflictingStatus: pledge.status,
      },
    });
    throw new ConflictError(
      `Asset reference ${asset.assetRef} is already financed by an active ` +
        "tokenization and cannot be pledged twice",
    );
  }

  /**
   * Attach the counterparty's advisory credit score, if one is known.
   *
   * Advisory only — a null score never blocks anything. The reputation store
   * is keyed by user id, so this resolves only for a counterparty that is
   * itself a platform user; an external debtor keeps a null score until it
   * has history here.
   */
  private async scoreCounterparty(
    asset: AssetDTO,
  ): Promise<AssetDTO["counterparty"]> {
    if (!asset.counterparty || !this.reputation) return asset.counterparty;
    try {
      const score = await this.reputation.getScore(asset.counterparty.ref);
      return { ...asset.counterparty, reputationScore: score };
    } catch (err) {
      // A scoring outage must not block a compliance decision that is
      // otherwise ready; the score is advisory and can be filled in later.
      logger.warn(
        { assetId: asset.id, err },
        "Counterparty reputation lookup failed; leaving the score unset",
      );
      return asset.counterparty;
    }
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

    // ── The verification gate (plane.md §3.1) ───────────────────────────────
    //
    // Until this existed, `valuationAmount` was whatever the issuer typed:
    // anyone could tokenize a $10M invoice that did not exist and investors
    // would fund it. Refusing here rather than at purchase is deliberate — the
    // unverified deal never reaches an investor at all, so there is no window
    // in which one can subscribe to something that later turns out to have no
    // evidence behind it.
    if (asset.verificationStatus !== AssetVerificationStatus.Verified) {
      throw new ConflictError(
        `Asset is ${asset.verificationStatus}; only a verified asset can be ` +
          "tokenized. Attach supporting documents and submit it for review.",
      );
    }

    // Checked again here even though verification already checked it: a
    // competing pledge can be filed in the window between approval and
    // tokenization, and this is the last moment before investors are invited
    // in.
    await this.assertNotDoublePledged(asset);

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

    // An existing holder may add to their position (plane.md §3.3). This used
    // to be refused outright — finding D6 — which meant an investor who liked
    // a deal could not put more into it and had to be told to wait for the
    // next one. The holding row is unique on (tokenization, holder), so a
    // top-up increases the existing row rather than creating a second.
    const existingHolding = await this.repository.findHolding(
      tokenizationId,
      actor.userId,
    );
    if (existingHolding && existingHolding.holderAddress !== input.holderAddress) {
      // The row is also unique on (tokenization, holder_address), and the
      // on-chain balance lives at one address. Topping up into a different
      // address would split the position across two accounts while the record
      // claims one.
      throw new ConflictError(
        "This position is held at a different address. Top up from the same " +
          "wallet you bought with, or sell and re-buy.",
      );
    }

    // ── Investor protection (plane.md §3.2) ─────────────────────────────────
    //
    // Every check runs before the ledger posting, so a refused purchase has
    // moved no money and created no obligation to unwind. They are ordered
    // cheapest-first, and the two that need a round trip (KYC, exposure) come
    // last.
    // The limits see the *resulting* position, not just the units being added.
    // Checking the increment alone would let an investor walk past a
    // concentration cap in small steps, which is the one thing a concentration
    // cap exists to stop.
    await this.assertInvestorLimits(
      tokenization,
      actor,
      units,
      purchaseAmount,
      existingHolding,
    );

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
    //
    // It keys on the *resulting* unit total rather than the increment. Once a
    // top-up is possible (§3.3), keying on the increment would give "buy 10,
    // then buy 10 more" the same reference as the first purchase — and the
    // conflict path would recover the original posting and hand out the second
    // 10 units for free. The running total makes each step in a sequence
    // distinct while a retry of any one step still converges.
    // Now that the investor has an account of their own (plane.md §4.5), the
    // check §1.1 and §3.2 both had to leave unwritten is possible: refuse a
    // purchase the investor cannot fund. It runs after every other limit and
    // immediately before the posting, so a refusal here — like every other —
    // has moved no money and left nothing to unwind.
    await this.ledger.assertSufficientFunds(
      actor.userId,
      tokenization.pricePerUnitCurrency as CurrencyCode,
      purchaseAmount,
    );

    const resultingUnits = BigInt(existingHolding?.units ?? "0") + units;
    const ledgerReferenceId = `rwa-subscription:${tokenizationId}:${actor.userId}:${resultingUnits}`;
    const ledgerTransaction = await this.recordSubscriptionLedger(
      ledgerReferenceId,
      tokenization,
      purchaseAmount,
      actor.userId,
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
    if (existingHolding) {
      await this.repository.updateHolding({
        ...existingHolding,
        units: (BigInt(existingHolding.units) + units).toString(),
        purchaseAmount: (
          BigInt(existingHolding.purchaseAmount) + purchaseAmount
        ).toString(),
        // `purchasedAt` keeps the *original* date. It is what the cooling-off
        // window and the yield accrual are measured from, and letting a top-up
        // reset it would reopen a window that had closed on the earlier units.
        //
        // A position part-delivered and part-pending cannot be represented by
        // one status, so a top-up that is not yet settled marks the whole
        // holding pending — the conservative direction, since it withholds a
        // payout rather than paying one on undelivered units.
        status: walletSigned
          ? TokenHoldingStatus.Pending
          : existingHolding.status,
        updatedAt: now,
      });
    } else {
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
    }

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
        topUp: existingHolding !== undefined,
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
    investorUserId: string,
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
        // The investor's own account, not a shared clearing account
        // (plane.md §4.5). A user account is a *liability* — the platform owes
        // the user their balance — so spending money debits it, reducing what
        // we owe them. Posting to the clearing account instead is what made
        // "this investor's balance" a thing that did not exist, and why the
        // insufficient-funds check could not be written.
        accountId: this.ledger.userAccount(investorUserId),
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

  /**
   * Apply the investor-protection limits to a proposed purchase
   * (plane.md §3.2).
   *
   * These approximate the controls a regulator would require, so the
   * architecture is shaped correctly. They are **not** legal compliance and
   * must not be described as such (plane.md §7).
   *
   * All the arithmetic is `bigint`. A concentration limit computed in floating
   * point is a limit that can be stepped over by rounding, and the amounts
   * being compared are money.
   */
  private async assertInvestorLimits(
    tokenization: TokenizationDTO,
    actor: RwaActor,
    units: bigint,
    purchaseAmount: bigint,
    /**
     * The investor's current holding in this tokenization, when they already
     * have one (a top-up, plane.md §3.3). Concentration is measured on the
     * resulting position; without this an investor could step past the cap in
     * increments.
     */
    existingHolding?: TokenHoldingDTO,
  ): Promise<void> {
    const {
      unitGranularity,
      minTicketAmount,
      maxConcentrationBps,
      maxExposure,
    } = this.limits;

    // Granularity first: it is pure arithmetic on values already in hand.
    if (unitGranularity > 1n && units % unitGranularity !== 0n) {
      throw new ValidationError(
        `Units must be a multiple of ${unitGranularity}`,
      );
    }

    if (purchaseAmount < minTicketAmount) {
      throw new ValidationError(
        `Minimum investment is ${minTicketAmount} ` +
          `${tokenization.pricePerUnitCurrency} (this purchase is ${purchaseAmount})`,
      );
    }

    // Concentration, measured in units rather than money: units are what the
    // tokenization is denominated in, and the price is uniform, so the two are
    // equivalent — but units avoid a second multiplication that could round.
    //
    // The comparison is cross-multiplied instead of dividing, so a limit like
    // 33.33% is applied exactly rather than through an integer division that
    // would quietly round in the investor's favour.
    if (maxConcentrationBps < 10_000) {
      const totalUnits = BigInt(tokenization.totalUnits);
      const resulting =
        units + BigInt(existingHolding?.units ?? "0");
      if (resulting * 10_000n > totalUnits * BigInt(maxConcentrationBps)) {
        const maxUnits = (totalUnits * BigInt(maxConcentrationBps)) / 10_000n;
        throw new ValidationError(
          `A single investor may hold at most ${maxConcentrationBps / 100}% of ` +
            `this tokenization (${maxUnits} units); this would make ${resulting}`,
        );
      }
    }

    // KYC. Checked in the RWA path rather than trusted from onboarding,
    // because a purchase is the money-moving step and it is the only place
    // that can refuse.
    if (this.kyc) {
      const { status } = await this.kyc.getStatus(actor.userId);
      if (status !== KycStatus.Verified) {
        throw new ForbiddenError(
          "Investor identity verification must be complete before investing",
        );
      }
    }

    // Exposure across every position the investor holds. Zero means no cap.
    if (maxExposure > 0n) {
      const held = await this.repository.listHoldingsByUser(actor.userId);
      const outstanding = held.reduce(
        (sum, holding) => sum + BigInt(holding.purchaseAmount),
        0n,
      );
      if (outstanding + purchaseAmount > maxExposure) {
        // The investor's own outstanding total is theirs to know, so it is
        // named — this is the one number that makes the refusal actionable.
        throw new ValidationError(
          `This purchase would take total exposure to ` +
            `${outstanding + purchaseAmount}, above the ${maxExposure} limit`,
        );
      }
    }
  }

  /**
   * Sell units from one holder to another at an agreed price (plane.md §3.3).
   *
   * This replaces the D6 refusal. Until now an investor could enter a position
   * and never leave it: `purchaseUnits` was the only way units moved, and it
   * only ever moved them from the issuer. A claim that cannot be sold is not
   * an investment.
   *
   * The price is agreed between the parties rather than derived from the
   * financing terms, and that is the point of a secondary market: an invoice
   * near maturity is worth more than one just issued, and a disputed one less.
   * The platform records the trade; it does not price it.
   *
   * Ordering mirrors `purchaseUnits`: every refusal first, then the ledger,
   * then the chain, then the records. A trade that fails a check has moved
   * nothing.
   */
  async transferHolding(
    tokenizationId: string,
    seller: RwaActor,
    input: SecondaryTransferInput,
    now: Date = new Date(),
  ): Promise<SecondaryTransferResponse> {
    const tokenization = await this.requireTokenization(tokenizationId);

    // ── Refusals the plan names explicitly ─────────────────────────────────
    //
    // The frozen flag is a compliance control: it stops transfers, and a
    // secondary trade is the transfer it most exists to stop. The contract
    // enforces this too, but refusing here means the ledger is never touched
    // for a trade the chain would reject.
    if (tokenization.frozen) {
      throw new ConflictError("Transfers are frozen on this tokenization");
    }

    if (seller.userId === input.toUserId) {
      throw new ValidationError("A holder cannot sell units to themselves");
    }

    // A position under an open dispute or already paying out is not tradeable:
    // the payout is imminent or held, and letting units change hands in that
    // window makes it ambiguous who the distribution belongs to.
    if (
      tokenization.status === TokenizationStatus.PayoutHeld ||
      tokenization.status === TokenizationStatus.Distributing ||
      tokenization.status === TokenizationStatus.Distributed ||
      tokenization.status === TokenizationStatus.Repaid ||
      tokenization.collectedAt !== null
    ) {
      throw new ConflictError(
        `This tokenization is ${tokenization.status} and its units are no ` +
          "longer tradeable",
      );
    }

    let units: bigint;
    let priceAmount: bigint;
    try {
      units = BigInt(input.units);
      priceAmount = BigInt(input.priceAmount);
    } catch {
      throw new ValidationError("Units and price must be integers");
    }
    if (units <= 0n) {
      throw new ValidationError("Units must be positive");
    }
    if (priceAmount < 0n) {
      throw new ValidationError("Price cannot be negative");
    }

    const sellerHolding = await this.repository.findHolding(
      tokenizationId,
      seller.userId,
    );
    if (!sellerHolding) {
      throw new NotFoundError("You hold no units in this tokenization");
    }
    if (BigInt(sellerHolding.units) < units) {
      throw new ValidationError(
        `You hold ${sellerHolding.units} units; cannot sell ${units}`,
      );
    }

    // Undelivered units are not the seller's to sell. Under issuer custody a
    // holding sits `Pending` until the issuer signs the transfer, and selling
    // in that window would pass on a claim to units that have not moved and
    // might never.
    if (
      tokenization.contractId !== null &&
      sellerHolding.status !== TokenHoldingStatus.Settled
    ) {
      throw new ConflictError(
        "These units have not been delivered yet and cannot be sold on until " +
          "the issuer signs the transfer",
      );
    }

    const toHolderAddress = assertStellarAddress(
      input.toHolderAddress,
      "toHolderAddress",
    );

    const buyer: RwaActor = { userId: input.toUserId, roles: [] };
    const buyerHolding = await this.repository.findHolding(
      tokenizationId,
      input.toUserId,
    );
    if (buyerHolding && buyerHolding.holderAddress !== toHolderAddress) {
      throw new ConflictError(
        "The buyer already holds this tokenization at a different address",
      );
    }

    // The authorization allowlist. When the token requires it, the contract
    // refuses a transfer to an unauthorized address — so the buyer must be
    // authorized before any money moves, not after.
    if (tokenization.requireAuthorization && tokenization.contractId) {
      const authorized = await this.gateway.isAuthorized(
        tokenization.contractId,
        toHolderAddress,
      );
      if (!authorized) {
        throw new ForbiddenError(
          "The buyer is not on this tokenization's authorization allowlist",
        );
      }
    }

    // The buyer is subject to the same protections as a primary investor
    // (§3.2) — KYC, concentration, exposure, ticket size. A secondary market
    // that skipped them would be the way around every limit the platform has.
    // `units` is what they acquire and `priceAmount` what they pay, which is
    // the trade's own economics rather than the primary unit price.
    await this.assertInvestorLimits(
      tokenization,
      buyer,
      units,
      priceAmount,
      buyerHolding,
    );

    // The buyer must be able to pay before the seller's units are committed
    // (plane.md §4.5). Same ordering as the primary purchase: last of the
    // checks, immediately before the posting, so a refusal moves no money.
    await this.ledger.assertSufficientFunds(
      input.toUserId,
      tokenization.pricePerUnitCurrency as CurrencyCode,
      priceAmount,
    );

    // ── The money moves first ──────────────────────────────────────────────
    const ledgerTransaction = await this.recordSecondaryTradeLedger(
      tokenizationId,
      seller.userId,
      input.toUserId,
      units,
      priceAmount,
      tokenization.pricePerUnitCurrency as CurrencyCode,
    );

    // ── Then the chain, where the platform can sign for it ─────────────────
    //
    // The contract gates `transfer` on `from.require_auth()`, so the platform
    // can only move units it is itself the `from` for — which it never is on a
    // holder-to-holder trade. The on-chain leg is therefore the seller's to
    // sign, exactly as the cooling-off cancellation found in §3.2.
    //
    // The records below are the platform's account of the trade, and the
    // reconciliation job is what surfaces a chain that has not caught up.
    const walletSigned =
      (await this.gateway.signingMode(RwaTransition.Transfer)) ===
      ChainSigningMode.Wallet;

    const remaining = BigInt(sellerHolding.units) - units;
    const nowIso = now.toISOString();

    // The seller's cost basis moves with the units, pro-rata. Keeping the full
    // basis on a part-sold position would overstate what the remainder cost
    // and understate the gain on what was sold.
    const basisSold =
      (BigInt(sellerHolding.purchaseAmount) * units) /
      BigInt(sellerHolding.units);

    let updatedSeller: TokenHoldingDTO | null = null;
    if (remaining === 0n) {
      // A zero-unit holding owns nothing and matches no on-chain balance. It
      // is deleted rather than kept at zero, which is also what the 0019
      // constraint requires.
      await this.repository.deleteHolding(sellerHolding.id);
    } else {
      updatedSeller = await this.repository.updateHolding({
        ...sellerHolding,
        units: remaining.toString(),
        purchaseAmount: (
          BigInt(sellerHolding.purchaseAmount) - basisSold
        ).toString(),
        updatedAt: nowIso,
      });
    }

    // The buyer's basis is what they actually paid — the agreed price, not the
    // primary unit price. That is what makes their yield and any realized loss
    // reflect their own trade rather than the issue's terms.
    let updatedBuyer: TokenHoldingDTO;
    if (buyerHolding) {
      updatedBuyer = await this.repository.updateHolding({
        ...buyerHolding,
        units: (BigInt(buyerHolding.units) + units).toString(),
        purchaseAmount: (
          BigInt(buyerHolding.purchaseAmount) + priceAmount
        ).toString(),
        updatedAt: nowIso,
      });
    } else {
      updatedBuyer = await this.repository.createHolding({
        tokenizationId,
        holderUserId: input.toUserId,
        holderAddress: toHolderAddress,
        units: units.toString(),
        purchaseAmount: priceAmount.toString(),
        purchaseCurrency: tokenization.pricePerUnitCurrency,
        // The buyer's own clock starts here: their cooling-off window and
        // their holding period are measured from when they bought, not from
        // when the seller did.
        purchasedAt: nowIso,
        authorized: true,
        // A trade the platform cannot sign for is a claim until the seller
        // signs it over, exactly like an issuer-custody purchase.
        status: walletSigned
          ? TokenHoldingStatus.Pending
          : TokenHoldingStatus.Settled,
        updatedAt: nowIso,
      });
    }

    await this.audit.append({
      actor: `user:${seller.userId}`,
      action: "rwa.transfer_units",
      entity: "tokenization",
      entityId: tokenizationId,
      metadata: {
        toUserId: input.toUserId,
        units: units.toString(),
        priceAmount: priceAmount.toString(),
        currency: tokenization.pricePerUnitCurrency,
        sellerUnitsRemaining: remaining.toString(),
        ledgerTransactionId: ledgerTransaction.id,
        walletSigned,
      },
    });

    return {
      tokenizationId,
      sellerHolding: updatedSeller,
      buyerHolding: updatedBuyer,
      units: units.toString(),
      priceAmount: priceAmount.toString(),
      priceCurrency: tokenization.pricePerUnitCurrency as CurrencyCode,
      ledgerTransactionId: ledgerTransaction.id,
    };
  }

  /**
   * Post both legs of a secondary trade.
   *
   * Two legs, not three: unlike a subscription, the platform is not standing
   * between the parties and no discount is being held. Cash comes in from the
   * buyer and is owed out to the seller.
   *
   *   debit  investor cash clearing        priceAmount  (buyer's cash in)
   *   credit secondary seller payable      priceAmount  (owed to the seller)
   *
   * The credit does *not* go to `rwa_issuer_proceeds_payable`: the issuer is
   * not party to this trade and crediting them would overstate what the
   * platform owes them for a sale they had no part in.
   *
   * A zero-price transfer — a gift, or a transfer between two accounts of the
   * same beneficial owner — posts nothing at all, because the ledger schema
   * rejects zero-amount entries and there is genuinely no money to record.
   */
  private async recordSecondaryTradeLedger(
    tokenizationId: string,
    sellerUserId: string,
    buyerUserId: string,
    units: bigint,
    priceAmount: bigint,
    currency: CurrencyCode,
  ): Promise<{ id: string }> {
    if (priceAmount === 0n) {
      return { id: "" };
    }

    // Derived from the trade, so a double-submitted sale converges on one
    // posting rather than charging the buyer twice.
    const referenceId = `rwa-secondary:${tokenizationId}:${sellerUserId}:${buyerUserId}:${units}:${priceAmount}`;
    try {
      return await this.ledger.record({
        referenceId,
        description: `RWA secondary transfer for tokenization ${tokenizationId}`,
        entries: [
          {
            // Buyer pays from their own balance (plane.md §4.5). Debiting a
            // liability reduces what the platform owes them, which is what
            // spending is.
            accountId: this.ledger.userAccount(buyerUserId),
            direction: EntryDirection.Debit,
            amount: priceAmount.toString(),
            currency,
          },
          {
            // Seller is credited directly rather than into the shared
            // `rwa_secondary_seller_payable` holding account. The payable
            // account was the right destination while no user had an account
            // of their own; now that they do, crediting the seller's own
            // balance is what makes the proceeds spendable rather than an
            // obligation someone has to settle by hand.
            accountId: this.ledger.userAccount(sellerUserId),
            direction: EntryDirection.Credit,
            amount: priceAmount.toString(),
            currency,
          },
        ],
      });
    } catch (err) {
      if (!(err instanceof ConflictError)) throw err;
      const existing = await this.ledger.getByReference(referenceId);
      if (!existing) throw err;
      logger.info(
        { tokenizationId, ledgerTransactionId: existing.id },
        "RWA secondary trade already posted; reusing it",
      );
      return existing;
    }
  }

  /**
   * Cancel a purchase within the cooling-off window (plane.md §3.2).
   *
   * The window is the investor protection: a subscription is a considered
   * decision, and a platform that cannot be exited in the first hours is one
   * that profits from haste. After it closes, the position is a real
   * investment and the exit is the secondary market (§3.3), not a refund.
   *
   * The reversal is posted as its own ledger transaction rather than by
   * deleting the original. The ledger is append-only and is the system of
   * record (Golden Rule #1): an unwound subscription is two facts — it
   * happened, and it was reversed — not the absence of one.
   *
   * Limited to holdings whose units have not been delivered on-chain; see the
   * `TokenHoldingStatus.Settled` refusal below for why that boundary is the
   * contract's, not a choice made here.
   */
  async cancelPurchase(
    tokenizationId: string,
    actor: RwaActor,
    now: Date = new Date(),
  ): Promise<TokenizationDetailsResponse> {
    const tokenization = await this.requireTokenization(tokenizationId);

    const holding = await this.repository.findHolding(
      tokenizationId,
      actor.userId,
    );
    if (!holding) {
      throw new NotFoundError("No holding to cancel for this investor");
    }

    if (this.limits.coolingOffHours <= 0) {
      throw new ConflictError("Cooling-off cancellation is not enabled");
    }

    const deadline =
      new Date(holding.purchasedAt).getTime() +
      this.limits.coolingOffHours * 60 * 60 * 1000;
    if (now.getTime() > deadline) {
      throw new ConflictError(
        `The ${this.limits.coolingOffHours}h cooling-off window for this ` +
          "purchase has closed",
      );
    }

    // A position whose payout is already running or settled cannot be unwound:
    // the money has left, and handing back the subscription as well would pay
    // the investor twice. The window is short enough that this is rare, but it
    // is exactly the race that would be expensive.
    if (
      tokenization.status === TokenizationStatus.Distributing ||
      tokenization.status === TokenizationStatus.Distributed ||
      tokenization.status === TokenizationStatus.Repaid ||
      tokenization.collectedAt !== null
    ) {
      throw new ConflictError(
        "This tokenization has already paid out; the purchase cannot be cancelled",
      );
    }

    // ── Why settled units cannot be cancelled here ─────────────────────────
    //
    // The token contract's `transfer` calls `from.require_auth()`, so moving
    // units *back* off the investor's account needs the investor's own
    // signature — which the platform never holds, under either custody mode.
    // A refund posted against units still on-chain in the investor's name
    // would hand back the cash and leave them the units.
    //
    // So the window is only exitable while the units have not been delivered.
    // Under platform custody a purchase settles inline, which makes this the
    // narrow case; the honest answer for a delivered position is the secondary
    // market (§3.3), not a refund this side cannot enforce.
    if (
      tokenization.contractId !== null &&
      holding.status === TokenHoldingStatus.Settled
    ) {
      throw new ConflictError(
        "These units have already been delivered on-chain and only their " +
          "holder can transfer them back, so the purchase cannot be " +
          "cancelled from here.",
      );
    }

    const purchaseAmount = BigInt(holding.purchaseAmount);
    const ledgerTransaction = await this.reverseSubscriptionLedger(
      tokenizationId,
      actor.userId,
      holding,
      purchaseAmount,
    );

    await this.repository.deleteHolding(holding.id);

    await this.audit.append({
      actor: `user:${actor.userId}`,
      action: "rwa.cancel_purchase",
      entity: "tokenization",
      entityId: tokenizationId,
      metadata: {
        units: holding.units,
        refundAmount: purchaseAmount.toString(),
        currency: holding.purchaseCurrency,
        purchasedAt: holding.purchasedAt,
        ledgerTransactionId: ledgerTransaction.id,
      },
    });

    return this.getTokenizationDetails(tokenizationId);
  }

  /**
   * Post the reversal of a subscription.
   *
   * Exactly the legs of `recordSubscriptionLedger` with the directions
   * inverted, and the discount recomputed the same way, so the two
   * transactions sum to nothing on every account they touch. Deriving the
   * split here rather than reading it back keeps one definition of what a
   * subscription's legs are.
   */
  private async reverseSubscriptionLedger(
    tokenizationId: string,
    investorUserId: string,
    holding: TokenHoldingDTO,
    purchaseAmount: bigint,
  ): Promise<{ id: string }> {
    const tokenization = await this.requireTokenization(tokenizationId);
    const currency = holding.purchaseCurrency as CurrencyCode;

    const discountHeld = applyBps(
      purchaseAmount,
      BigInt(tokenization.discountRateBps),
    );
    const issuerShare = purchaseAmount - discountHeld;

    const entries: LedgerTransactionInput["entries"] = [
      {
        // Mirrors the subscription's debit of the same account, so the two
        // transactions net to zero on the investor's own balance rather than
        // on a shared clearing account (plane.md §4.5).
        accountId: this.ledger.userAccount(investorUserId),
        direction: EntryDirection.Credit,
        amount: purchaseAmount.toString(),
        currency,
      },
      {
        accountId: RWA_ISSUER_PROCEEDS_PAYABLE,
        direction: EntryDirection.Debit,
        amount: issuerShare.toString(),
        currency,
      },
    ];
    if (discountHeld > 0n) {
      entries.push({
        accountId: RWA_INVESTMENT_LIABILITY,
        direction: EntryDirection.Debit,
        amount: discountHeld.toString(),
        currency,
      });
    }

    // Derived from the holding, so a double-submitted cancel converges on one
    // reversal exactly as the subscription converges on one posting.
    const referenceId = `rwa-cancellation:${tokenizationId}:${investorUserId}:${holding.units}`;
    try {
      return await this.ledger.record({
        referenceId,
        description: `RWA subscription cancelled for tokenization ${tokenizationId}`,
        entries,
      });
    } catch (err) {
      if (!(err instanceof ConflictError)) throw err;
      const existing = await this.ledger.getByReference(referenceId);
      if (!existing) throw err;
      logger.info(
        { tokenizationId, ledgerTransactionId: existing.id },
        "RWA cancellation already posted; reusing it",
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
      risk: await this.riskFor(tokenization, asset),
    };
  }

  /**
   * What an investor is actually taking on (plane.md §3.4).
   *
   * Every field here was derivable only by a client that understood the
   * financing model, which meant in practice that none of them were shown: the
   * marketplace card advertised a unit price with no yield, no maturity, and
   * no hint that the underlying invoice was in dispute. Computing it here
   * gives one definition of "days remaining" rather than one per screen.
   *
   * The dispute read is live rather than inferred from the tokenization's
   * status. `PayoutHeld` is set when the dispute event is handled, and an
   * investor about to buy needs to know about a dispute filed a moment ago,
   * not one that has already been processed.
   */
  private async riskFor(
    tokenization: TokenizationDTO,
    asset: AssetDTO,
    now: Date = new Date(),
  ): Promise<TokenizationRiskDTO> {
    const maturity = new Date(tokenization.maturityDate);

    // Signed, deliberately: `daysBetween` floors at zero, which would erase
    // exactly the overdue case this field exists to surface.
    const daysRemaining = Math.floor(
      (maturity.getTime() - now.getTime()) / (24 * 60 * 60 * 1000),
    );

    // Past due only counts while collection has not arrived. A position that
    // collected late is closed, not overdue.
    const overdue = daysRemaining < 0 && tokenization.collectedAt === null;

    let disputed = tokenization.status === TokenizationStatus.PayoutHeld;
    if (!disputed && this.disputes && tokenization.linkedOrderId) {
      try {
        disputed = await this.disputes.hasOpenDispute(
          tokenization.linkedOrderId,
        );
      } catch (err) {
        // A dispute-reader outage must not take down the marketplace. The
        // durable `PayoutHeld` status still answers, and the payout path has
        // its own two independent checks (§2.2) — this one is for display.
        logger.warn(
          { tokenizationId: tokenization.id, err },
          "Dispute lookup failed while building risk; falling back to status",
        );
      }
    }

    let issuerReputationScore: number | null = null;
    if (this.reputation) {
      try {
        issuerReputationScore = await this.reputation.getScore(
          tokenization.issuerUserId,
        );
      } catch (err) {
        logger.warn(
          { tokenizationId: tokenization.id, err },
          "Issuer reputation lookup failed while building risk",
        );
      }
    }

    // What investors earn across the whole issue if collection arrived today,
    // accruing late yield where it applies. The same function the waterfall
    // uses, so the number shown is the number that will be paid.
    const projectedYield = investorYieldFor(
      this.termsOf(tokenization),
      daysBetween(new Date(tokenization.createdAt), maturity),
      daysBetween(maturity, tokenization.collectedAt ? new Date(tokenization.collectedAt) : now),
    );

    return {
      advanceRateBps: tokenization.advanceRateBps,
      discountRateBps: tokenization.discountRateBps,
      maturityDate: tokenization.maturityDate,
      daysRemaining,
      overdue,
      issuerReputationScore,
      counterparty: asset.counterparty,
      disputed,
      projectedYieldAmount: projectedYield.toString(),
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

  /**
   * List tokenizations with the risk each one carries (plane.md §3.4).
   *
   * The marketplace renders every open deal at once, and fetching a detail
   * response per card to show a maturity date is how a risk disclosure ends up
   * dropped for being slow. One call returns both.
   */
  async listTokenizationsWithRisk(filters?: {
    issuerUserId?: string;
    status?: TokenizationStatus;
    linkedOrderId?: string;
  }): Promise<TokenizationListResponse> {
    const tokenizations = await this.repository.listTokenizations(filters);
    const now = new Date();

    const entries = await Promise.all(
      tokenizations.map(async (tokenization) => {
        const asset = await this.repository.findAsset(tokenization.assetId);
        // An asset that has gone missing is a data-integrity problem, not a
        // reason to fail the whole marketplace listing. The tokenization is
        // still returned; only its risk block is absent.
        if (!asset) return null;
        return [
          tokenization.id,
          await this.riskFor(tokenization, asset, now),
        ] as const;
      }),
    );

    return {
      tokenizations,
      risk: Object.fromEntries(
        entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null),
      ),
    };
  }

  /** Get an investor's portfolio across all holdings. */
  async getInvestorPortfolio(
    holderUserId: string,
  ): Promise<InvestorPortfolioResponse> {
    const holdings = await this.repository.listHoldingsByUser(holderUserId);
    const payoutRecords =
      await this.repository.listPayoutRecordsByUser(holderUserId);

    const now = new Date();

    // A payout record points at a distribution, not at a tokenization, so
    // attributing "payouts received" to a position needs that link. Built once
    // here rather than per holding: a portfolio of twenty positions should not
    // be forty repository round trips.
    const distributionOwner = new Map<string, string>();
    await Promise.all(
      [...new Set(holdings.map((h) => h.tokenizationId))].map(
        async (tokenizationId) => {
          for (const distribution of await this.repository.listDistributions(
            tokenizationId,
          )) {
            distributionOwner.set(distribution.id, tokenizationId);
          }
        },
      ),
    );

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
          position: this.positionFor(
            holding,
            tokenization!,
            payoutRecords.filter(
              (record) =>
                distributionOwner.get(record.distributionId) ===
                holding.tokenizationId,
            ),
            now,
          ),
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

    // "Total invested" on its own reads like a balance: it says nothing about
    // what a position is now worth, whether it is late, or whether any of it
    // has been lost. These three are what turn a list of purchases into a
    // portfolio (plane.md §3.4).
    const totals = enrichedHoldings.reduce(
      (acc, { position }) => ({
        accrued: acc.accrued + BigInt(position.accruedYield),
        loss: acc.loss + BigInt(position.realizedLoss),
        overdue: acc.overdue + (position.overdue ? 1 : 0),
      }),
      { accrued: 0n, loss: 0n, overdue: 0 },
    );

    return {
      holdings: enrichedHoldings,
      totalInvested: totalInvested.toString(),
      totalPayoutsReceived: totalPayoutsReceived.toString(),
      totalAccruedYield: totals.accrued.toString(),
      totalRealizedLoss: totals.loss.toString(),
      overdueCount: totals.overdue,
    };
  }

  /**
   * One position's economics (plane.md §3.4).
   *
   * Pure and synchronous, and given only the payout records that belong to
   * this position — the caller resolved the distribution→tokenization link
   * once for the whole portfolio.
   */
  private positionFor(
    holding: TokenHoldingDTO,
    tokenization: TokenizationDTO,
    payoutRecords: PayoutRecordDTO[],
    now: Date,
  ): PortfolioPositionDTO {
    const maturity = new Date(tokenization.maturityDate);
    const daysRemaining = Math.floor(
      (maturity.getTime() - now.getTime()) / (24 * 60 * 60 * 1000),
    );

    const payoutsReceived = payoutRecords.reduce(
      (sum, record) => sum + BigInt(record.shareAmount),
      0n,
    );

    const closed =
      tokenization.status === TokenizationStatus.Repaid ||
      tokenization.status === TokenizationStatus.Distributed ||
      tokenization.status === TokenizationStatus.WrittenOff;

    // Accrued yield is a projection of what is still owed, so a closed
    // position has none: once the payout has run, the payout record is the
    // truth and continuing to show an accrual would double-count it.
    let accruedYield = 0n;
    if (!closed) {
      const issueYield = investorYieldFor(
        this.termsOf(tokenization),
        daysBetween(new Date(tokenization.createdAt), maturity),
        daysBetween(maturity, now),
      );
      // Pro-rata to units held. The whole-issue yield is what the waterfall
      // will split, and this holder's share of it is their share of the units.
      accruedYield =
        (issueYield * BigInt(holding.units)) / BigInt(tokenization.totalUnits);
    }

    // A loss is realized only when the position is closed at one. While it is
    // open, a shortfall is a risk rather than a loss, and calling it realized
    // would put a number on the screen that is not yet true.
    const invested = BigInt(holding.purchaseAmount);
    const realizedLoss =
      tokenization.status === TokenizationStatus.WrittenOff &&
      invested > payoutsReceived
        ? invested - payoutsReceived
        : 0n;

    return {
      accruedYield: accruedYield.toString(),
      payoutsReceived: payoutsReceived.toString(),
      realizedLoss: realizedLoss.toString(),
      daysRemaining,
      overdue: daysRemaining < 0 && tokenization.collectedAt === null && !closed,
      disputed: tokenization.status === TokenizationStatus.PayoutHeld,
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

    // No payout escapes a live dispute (plane.md §2.2).
    //
    // Two checks, because they fail independently. The status is the durable
    // record — set when the dispute opened, and still true after a restart that
    // loses nothing else. The live read catches the window where a dispute was
    // filed but its event has not been handled yet. Either one alone leaves a
    // gap through which money reaches investors who may have to give it back.
    if (tokenization.status === TokenizationStatus.PayoutHeld) {
      throw new ConflictError(
        `Payout for ${tokenizationId} is held pending dispute resolution`,
      );
    }
    if (
      this.disputes &&
      tokenization.linkedOrderId &&
      (await this.disputes.hasOpenDispute(tokenization.linkedOrderId))
    ) {
      throw new ConflictError(
        `Cannot distribute a payout while order ${tokenization.linkedOrderId} ` +
          "has an open dispute",
      );
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
              // Credited per holder to their own account, exactly as a payout
              // is (plane.md §4.5). A recovery is money coming back to the
              // investors who lost it; crediting a shared payable would leave
              // it as an obligation nobody could spend. Shares that round to
              // zero are skipped — the schema rejects a zero-amount entry and
              // `distributed` already excludes them, so the set balances.
              ...holdings.flatMap((holding, index) => {
                const share = shares[index] ?? 0n;
                if (share <= 0n) return [];
                return [
                  {
                    accountId: this.ledger.userAccount(holding.holderUserId),
                    direction: EntryDirection.Credit,
                    amount: share.toString(),
                    currency: tokenization.faceValueCurrency,
                  },
                ];
              }),
            ],
          }));
        ledgerTransactionId = posted.id;

        // Record who received what, not only that money moved.
        //
        // Until §3.4 needed it, the write-off posted the recovery to the
        // ledger and stopped there: no distribution, no payout records. The
        // ledger knew the platform owed 30,000 and nothing said which holders
        // it was owed to — so a portfolio reading "invested less received"
        // reported the *whole* investment as lost even when most of it had
        // come back. The shares were already computed above to split the
        // posting; they just were not written down.
        const now = new Date().toISOString();
        const distribution = await this.repository.createDistribution({
          tokenizationId,
          triggeredByOrderId: tokenization.linkedOrderId,
          triggeredByTransition: "write_off",
          totalAmount: distributed.toString(),
          totalCurrency: tokenization.faceValueCurrency,
          status: PayoutStatus.Completed,
          ledgerTransactionId: posted.id,
          initiatedAt: now,
          completedAt: now,
        });

        await this.repository.createPayoutRecords(
          holdings
            .map((holding, index) => ({
              distributionId: distribution.id,
              holderUserId: holding.holderUserId,
              unitsHeld: holding.units,
              shareAmount: (shares[index] ?? 0n).toString(),
              shareCurrency: tokenization.faceValueCurrency,
              ledgerEntryId: null,
              createdAt: now,
            }))
            // A holder whose pro-rata share rounds to nothing gets no record:
            // a zero-amount payout row is noise in a statement, not a payment.
            .filter((record) => record.shareAmount !== "0"),
        );
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
    payoutRecords: Array<{ shareAmount: string; holderUserId: string }>,
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
    ];

    // One credit per holder, to that holder's own account (plane.md §4.5).
    //
    // This used to be a single credit of `totalAmount` to the shared
    // `rwa_payout_payable`. That posting balanced, but it recorded only that
    // the platform owed *someone* the money — the per-holder split lived in
    // `payout_records` and nowhere the ledger could see. Crediting each holder
    // individually is what turns a payout into a balance they can spend, and
    // it makes the ledger agree with the payout records by construction rather
    // than by cross-referencing two tables.
    //
    // Shares that round to zero are skipped, since the schema rejects a
    // zero-amount entry; they are already excluded from `totalAmount`, so the
    // set still balances.
    //
    // Multiple records for one holder are summed rather than posted twice: two
    // entries on the same account in one transaction is legal, but one credit
    // per holder is what a statement should read like.
    const perHolder = new Map<string, bigint>();
    for (const record of payoutRecords) {
      const share = BigInt(record.shareAmount);
      if (share <= 0n) continue;
      perHolder.set(
        record.holderUserId,
        (perHolder.get(record.holderUserId) ?? 0n) + share,
      );
    }
    for (const [holderUserId, share] of perHolder) {
      entries.push({
        accountId: this.ledger.userAccount(holderUserId),
        direction: EntryDirection.Credit,
        amount: share.toString(),
        currency: currency as CurrencyCode,
      });
    }
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

  private async requireAsset(assetId: string): Promise<AssetDTO> {
    const asset = await this.repository.findAsset(assetId);
    if (!asset) {
      throw new NotFoundError("Asset not found");
    }
    return asset;
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
