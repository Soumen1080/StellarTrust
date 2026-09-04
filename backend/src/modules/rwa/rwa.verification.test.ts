/**
 * Asset verification before tokenization (plane.md §3.1).
 *
 * The defect these cover is D7: `valuationAmount` was whatever the issuer
 * typed, with no document behind it and no check that the same receivable was
 * not already financed elsewhere. The two acceptance conditions the plan names
 * are "unverified asset refused" and "double-pledge refused"; the rest of the
 * file covers the workflow that gets an asset from one to the other, because a
 * gate with no usable path through it is just a wall.
 */

import { describe, expect, it } from "vitest";
import { InMemoryAuditRepository } from "../audit/audit.repository.js";
import { StaticWalletAddressResolver } from "../identity/wallet.resolver.js";
import { InMemoryLedgerRepository } from "../ledger/ledger.repository.js";
import { LedgerService } from "../ledger/ledger.service.js";
import { DeterministicRwaGateway } from "./rwa.gateway.js";
import { InMemoryRwaRepository } from "./rwa.repository.js";
import { RwaService, type RwaActor } from "./rwa.service.js";
import { AssetType, AssetVerificationStatus } from "./rwa.types.js";
import { COMPLIANCE, createVerifiedAsset } from "./rwa.test-fixtures.js";

const ISSUER_ADDRESS = "GBUV3T3YDFD232LUXGADFZV2XCMNEHXBMVTQPBD7DKHTP4Q6ZLNOSMEX";

const FUTURE_MATURITY = new Date(
  Date.now() + 90 * 24 * 60 * 60 * 1000,
).toISOString();

const issuer: RwaActor = { userId: "issuer-1", roles: ["user"] };
const otherIssuer: RwaActor = { userId: "issuer-2", roles: ["user"] };

function setup() {
  const repository = new InMemoryRwaRepository();
  const audit = new InMemoryAuditRepository();
  const service = new RwaService(
    repository,
    new DeterministicRwaGateway(),
    audit,
    new LedgerService(new InMemoryLedgerRepository()),
    new StaticWalletAddressResolver(
      new Map([
        ["issuer-1", ISSUER_ADDRESS],
        ["issuer-2", ISSUER_ADDRESS],
      ]),
    ),
  );
  return { repository, audit, service };
}

/** An asset with evidence attached but no decision yet. */
async function draftAsset(
  service: RwaService,
  owner: RwaActor,
  assetRef: string,
) {
  return service.createAsset(owner.userId, {
    assetType: AssetType.Invoice,
    assetRef,
    description: "90-day receivable",
    valuationAmount: "1000000",
    valuationCurrency: "USDC",
    documents: [
      { docRef: "s3://docs/inv.pdf", docType: "invoice", sha256: "a".repeat(64) },
    ],
    counterparty: { ref: "counterparty:ACME-LTD", name: "Acme Ltd" },
  });
}

function tokenizationTerms(assetId: string) {
  return {
    assetId,
    totalUnits: "1000",
    faceValueAmount: "1000000",
    faceValueCurrency: "USDC" as const,
    advanceRateBps: 10_000,
    discountRateBps: 0,
    maturityDate: FUTURE_MATURITY,
  };
}

describe("asset verification gates tokenization", () => {
  it("refuses to tokenize an unverified asset", async () => {
    const { service } = setup();
    const asset = await draftAsset(service, issuer, "invoice:INV-1");

    // The gate, and the whole of D7: this is the $10M invoice that does not
    // exist, and it never reaches an investor.
    expect(asset.verificationStatus).toBe(AssetVerificationStatus.Unverified);
    await expect(
      service.createTokenization(issuer.userId, tokenizationTerms(asset.id)),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses to tokenize an asset still under review", async () => {
    const { service } = setup();
    const asset = await draftAsset(service, issuer, "invoice:INV-2");
    await service.submitAssetForReview(asset.id, issuer);

    await expect(
      service.createTokenization(issuer.userId, tokenizationTerms(asset.id)),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses to tokenize a rejected asset", async () => {
    const { service } = setup();
    const asset = await draftAsset(service, issuer, "invoice:INV-3");
    await service.submitAssetForReview(asset.id, issuer);
    await service.reviewAsset(asset.id, COMPLIANCE, {
      decision: "reject",
      note: "The appraisal predates the lien search",
    });

    await expect(
      service.createTokenization(issuer.userId, tokenizationTerms(asset.id)),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("allows a verified asset through", async () => {
    const { service } = setup();
    const asset = await createVerifiedAsset(service, issuer.userId);

    const tokenization = await service.createTokenization(
      issuer.userId,
      tokenizationTerms(asset.id),
    );
    expect(tokenization.assetId).toBe(asset.id);
  });
});

describe("the verification workflow", () => {
  it("walks unverified → under review → verified", async () => {
    const { service } = setup();
    const asset = await draftAsset(service, issuer, "invoice:INV-4");
    expect(asset.verificationStatus).toBe(AssetVerificationStatus.Unverified);

    const submitted = await service.submitAssetForReview(asset.id, issuer);
    expect(submitted.verificationStatus).toBe(
      AssetVerificationStatus.UnderReview,
    );

    const verified = await service.reviewAsset(asset.id, COMPLIANCE, {
      decision: "verify",
    });
    expect(verified.verificationStatus).toBe(AssetVerificationStatus.Verified);
    // Who decided and when, so the approval is an audit trail rather than a
    // flag that appeared from nowhere.
    expect(verified.verifiedByUserId).toBe(COMPLIANCE.userId);
    expect(verified.verifiedAt).toBeTruthy();
  });

  it("refuses to submit an asset with no supporting document", async () => {
    const { service } = setup();
    const asset = await service.createAsset(issuer.userId, {
      assetType: AssetType.Commodity,
      assetRef: "commodity:GOLD-1",
      description: "gold bar",
      valuationAmount: "500000",
      valuationCurrency: "USDC",
    });

    // A reviewer with nothing to review would rubber-stamp the valuation,
    // which is exactly the failure the workflow exists to prevent.
    await expect(
      service.submitAssetForReview(asset.id, issuer),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("refuses to submit an invoice with no counterparty", async () => {
    const { service } = setup();
    const asset = await service.createAsset(issuer.userId, {
      assetType: AssetType.Invoice,
      assetRef: "invoice:INV-NOCP",
      description: "receivable with no named debtor",
      valuationAmount: "1000",
      valuationCurrency: "USDC",
      documents: [{ docRef: "s3://docs/a.pdf", docType: "invoice" }],
    });

    // The credit risk an investor takes is the debtor's. An unnamed debtor
    // cannot be assessed at all.
    await expect(
      service.submitAssetForReview(asset.id, issuer),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("lets a non-invoice asset through without a counterparty", async () => {
    const { service } = setup();
    const asset = await service.createAsset(issuer.userId, {
      assetType: AssetType.Commodity,
      assetRef: "commodity:GOLD-2",
      description: "gold bar",
      valuationAmount: "500000",
      valuationCurrency: "USDC",
      documents: [{ docRef: "s3://docs/assay.pdf", docType: "assay" }],
    });

    const submitted = await service.submitAssetForReview(asset.id, issuer);
    expect(submitted.verificationStatus).toBe(
      AssetVerificationStatus.UnderReview,
    );
  });

  it("requires a stated reason on a rejection", async () => {
    const { service } = setup();
    const asset = await draftAsset(service, issuer, "invoice:INV-5");
    await service.submitAssetForReview(asset.id, issuer);

    // A rejection the issuer cannot act on is a dead end.
    await expect(
      service.reviewAsset(asset.id, COMPLIANCE, { decision: "reject" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("refuses a review from someone without the compliance role", async () => {
    const { service } = setup();
    const asset = await draftAsset(service, issuer, "invoice:INV-6");
    await service.submitAssetForReview(asset.id, issuer);

    // Notably including the issuer: self-verification is the gate's whole
    // failure mode.
    await expect(
      service.reviewAsset(asset.id, issuer, { decision: "verify" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses to submit an asset the actor does not own", async () => {
    const { service } = setup();
    const asset = await draftAsset(service, issuer, "invoice:INV-7");

    await expect(
      service.submitAssetForReview(asset.id, otherIssuer),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses to decide an asset that was never submitted", async () => {
    const { service } = setup();
    const asset = await draftAsset(service, issuer, "invoice:INV-8");

    await expect(
      service.reviewAsset(asset.id, COMPLIANCE, { decision: "verify" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses to change documents after a decision", async () => {
    const { service } = setup();
    const asset = await createVerifiedAsset(service, issuer.userId);

    // Adding evidence to an approved asset would change what was approved
    // without anyone re-reading it.
    await expect(
      service.addAssetDocuments(asset.id, issuer, [
        { docRef: "s3://docs/late.pdf", docType: "invoice" },
      ]),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("accumulates documents across several calls before review", async () => {
    const { service } = setup();
    const asset = await draftAsset(service, issuer, "invoice:INV-9");

    const updated = await service.addAssetDocuments(asset.id, issuer, [
      { docRef: "s3://docs/bol.pdf", docType: "bill_of_lading" },
    ]);
    expect(updated.documents).toHaveLength(2);
    expect(updated.documents.map((doc) => doc.docType)).toContain(
      "bill_of_lading",
    );
  });

  it("rejects a document digest that is not a SHA-256", async () => {
    const { service } = setup();
    const asset = await draftAsset(service, issuer, "invoice:INV-10");

    // A digest that is not a digest looks like integrity evidence and proves
    // nothing.
    await expect(
      service.addAssetDocuments(asset.id, issuer, [
        { docRef: "s3://docs/x.pdf", docType: "invoice", sha256: "nope" },
      ]),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("keeps document contents out of the audit trail", async () => {
    const { service, audit } = setup();
    const asset = await draftAsset(service, issuer, "invoice:INV-11");
    await service.addAssetDocuments(asset.id, issuer, [
      { docRef: "s3://docs/bol.pdf", docType: "bill_of_lading" },
    ]);

    const entry = (await audit.listForEntity("asset", asset.id)).find(
      (e) => e.action === "rwa.add_asset_documents",
    );
    // References and types only — the file is opaque to this platform
    // (Rules.md §3).
    expect(entry?.metadata).toMatchObject({
      docRefs: ["s3://docs/bol.pdf"],
      docTypes: ["bill_of_lading"],
    });
    expect(JSON.stringify(entry?.metadata)).not.toContain("sha256");
  });

  it("lists only assets awaiting a decision, oldest first", async () => {
    const { service } = setup();
    const first = await draftAsset(service, issuer, "invoice:INV-Q1");
    const second = await draftAsset(service, issuer, "invoice:INV-Q2");
    await draftAsset(service, issuer, "invoice:INV-Q3"); // never submitted

    await service.submitAssetForReview(first.id, issuer);
    await service.submitAssetForReview(second.id, issuer);

    const queue = await service.listAssetsForReview(COMPLIANCE);
    expect(queue.map((a) => a.assetRef)).toEqual([
      "invoice:INV-Q1",
      "invoice:INV-Q2",
    ]);
  });

  it("refuses the review queue to a non-compliance actor", async () => {
    const { service } = setup();
    await expect(service.listAssetsForReview(issuer)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("double-pledge guard", () => {
  it("refuses to verify a second asset with a live pledge on the same ref", async () => {
    const { service } = setup();

    // One issuer finances a receivable.
    const first = await createVerifiedAsset(service, issuer.userId, {
      assetRef: "invoice:INV-DUP",
    });
    await service.createTokenization(
      issuer.userId,
      tokenizationTerms(first.id),
    );

    // A second account files the same receivable. The unique constraint on
    // (owner_user_id, asset_ref) cannot see this — the owners differ — which
    // is precisely how the fraud is done.
    const second = await draftAsset(service, otherIssuer, "invoice:INV-DUP");
    await service.submitAssetForReview(second.id, otherIssuer);

    await expect(
      service.reviewAsset(second.id, COMPLIANCE, { decision: "verify" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses at tokenization when the competing pledge appears after approval", async () => {
    const { service } = setup();

    // Both assets clear review while neither is financed, so the check at
    // review time passes for both.
    const first = await createVerifiedAsset(service, issuer.userId, {
      assetRef: "invoice:INV-RACE",
    });
    const second = await createVerifiedAsset(service, otherIssuer.userId, {
      assetRef: "invoice:INV-RACE",
    });

    await service.createTokenization(
      issuer.userId,
      tokenizationTerms(first.id),
    );

    // This is why the check runs a second time at tokenization: the window
    // between approval and financing is real.
    await expect(
      service.createTokenization(
        otherIssuer.userId,
        tokenizationTerms(second.id),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("records the conflicting tokenization for compliance without leaking it to the caller", async () => {
    const { service, audit } = setup();
    const first = await createVerifiedAsset(service, issuer.userId, {
      assetRef: "invoice:INV-AUDIT",
    });
    const tokenization = await service.createTokenization(
      issuer.userId,
      tokenizationTerms(first.id),
    );

    const second = await draftAsset(service, otherIssuer, "invoice:INV-AUDIT");
    await service.submitAssetForReview(second.id, otherIssuer);
    const refusal = await service
      .reviewAsset(second.id, COMPLIANCE, { decision: "verify" })
      .catch((err: Error) => err);

    // The other party's tokenization id is compliance's to see, not the
    // competing issuer's.
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).not.toContain(tokenization.id);
    const entry = (await audit.listForEntity("asset", second.id)).find(
      (e) => e.action === "rwa.double_pledge_refused",
    );
    expect(entry?.metadata).toMatchObject({
      conflictingTokenizationId: tokenization.id,
    });
  });

  it("allows re-financing once the earlier pledge is settled", async () => {
    const { service, repository } = setup();
    const first = await createVerifiedAsset(service, issuer.userId, {
      assetRef: "invoice:INV-REPAID",
    });
    const tokenization = await service.createTokenization(
      issuer.userId,
      tokenizationTerms(first.id),
    );

    // A repaid position is a finished claim: the receivable it was drawn
    // against is free, and refusing here would strand an issuer who had
    // already paid their investors back.
    await repository.updateTokenization({
      ...tokenization,
      status: "repaid" as typeof tokenization.status,
    });

    const second = await draftAsset(service, otherIssuer, "invoice:INV-REPAID");
    await service.submitAssetForReview(second.id, otherIssuer);
    const verified = await service.reviewAsset(second.id, COMPLIANCE, {
      decision: "verify",
    });
    expect(verified.verificationStatus).toBe(AssetVerificationStatus.Verified);
  });
});

describe("counterparty scoring", () => {
  it("attaches the advisory score at verification when a reader is wired", async () => {
    const repository = new InMemoryRwaRepository();
    const service = new RwaService(
      repository,
      new DeterministicRwaGateway(),
      new InMemoryAuditRepository(),
      new LedgerService(new InMemoryLedgerRepository()),
      new StaticWalletAddressResolver(new Map([["issuer-1", ISSUER_ADDRESS]])),
      undefined,
      undefined,
      undefined,
      { getScore: async () => 72 },
    );

    const asset = await createVerifiedAsset(service, issuer.userId);
    expect(asset.counterparty?.reputationScore).toBe(72);
  });

  it("verifies anyway when scoring fails", async () => {
    const repository = new InMemoryRwaRepository();
    const service = new RwaService(
      repository,
      new DeterministicRwaGateway(),
      new InMemoryAuditRepository(),
      new LedgerService(new InMemoryLedgerRepository()),
      new StaticWalletAddressResolver(new Map([["issuer-1", ISSUER_ADDRESS]])),
      undefined,
      undefined,
      undefined,
      {
        getScore: async () => {
          throw new Error("reputation store unavailable");
        },
      },
    );

    // The score is advisory. A scoring outage must not block a compliance
    // decision that is otherwise ready.
    const asset = await createVerifiedAsset(service, issuer.userId);
    expect(asset.verificationStatus).toBe(AssetVerificationStatus.Verified);
    expect(asset.counterparty?.reputationScore).toBeNull();
  });
});
