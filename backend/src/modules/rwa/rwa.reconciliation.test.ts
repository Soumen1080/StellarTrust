/**
 * RWA records are checked against the token contract — before a payout, and
 * on a schedule.
 *
 * Payout shares used to be computed purely from the `holdings` table, with the
 * contract consulted only for the total supply. The contract is the authority
 * on who holds what: a holder can move units directly on-chain, and a transfer
 * can succeed while the row write fails. Paying pro-rata against a stale
 * mirror sends money to the wrong people, so drift has to stop a payout — and
 * be found before anyone attempts one.
 */
import { describe, expect, it } from "vitest";
import { InMemoryAuditRepository } from "../audit/audit.repository.js";
import { StaticWalletAddressResolver } from "../identity/wallet.resolver.js";
import { PrefundedLedgerService } from "../ledger/ledger.test-fixtures.js";
import { DeterministicRwaGateway } from "./rwa.gateway.js";
import { RwaReconciliationJob } from "./rwa.reconciliation.job.js";
import { InMemoryRwaRepository } from "./rwa.repository.js";
import { RwaService, type RwaActor } from "./rwa.service.js";
import { createVerifiedAsset } from "./rwa.test-fixtures.js";


/**
 * A maturity comfortably in the future.
 *
 * Financing terms are rejected at creation when maturity is not in the future
 * (a position born past due would start accruing late yield before anyone
 * subscribed), so every fixture needs a real date rather than a fixed string
 * that would eventually go stale and start failing on its own.
 */
const FUTURE_MATURITY = new Date(
  Date.now() + 90 * 24 * 60 * 60 * 1000,
).toISOString();

const ISSUER_ADDRESS = "GBUV3T3YDFD232LUXGADFZV2XCMNEHXBMVTQPBD7DKHTP4Q6ZLNOSMEX";
const INVESTOR1_ADDRESS = "GDYWVMFH5JDIISEZMLDFTN6A5NHPLZGKTTYAAKGB5Z6U7MHKUV6JPVS5";
const INVESTOR2_ADDRESS = "GBNPF7BZKNCAS32XWOBWGL7KD6NFHLZO5GQDIJA7Z73B7YISNM4MFZNL";

const issuer: RwaActor = { userId: "issuer-1", roles: ["user"] };
const investor: RwaActor = { userId: "investor-1", roles: ["user"] };
const system: RwaActor = { userId: "system", roles: ["system"] };

function setup() {
  const repository = new InMemoryRwaRepository();
  const gateway = new DeterministicRwaGateway();
  const service = new RwaService(
    repository,
    gateway,
    new InMemoryAuditRepository(),
    new PrefundedLedgerService(),
    new StaticWalletAddressResolver(new Map([["issuer-1", ISSUER_ADDRESS]])),
  );
  const job = new RwaReconciliationJob(repository, gateway, 60_000);
  return { repository, gateway, service, job };
}

/** A deployed tokenization with one investor holding 250 of 1000 units. */
async function tokenizationWithHolder(service: RwaService) {
  const asset = await createVerifiedAsset(service, issuer.userId, {
    assetRef: "invoice:INV-RECON",
  });
  const draft = await service.createTokenization(issuer.userId, {
    assetId: asset.id,
    totalUnits: "1000",
    faceValueAmount: "1000000",
    faceValueCurrency: "USDC",
    advanceRateBps: 10_000,
    discountRateBps: 0,
    maturityDate: FUTURE_MATURITY,
    requireAuthorization: false,
  });
  const tokenization = await service.deployTokenization(draft.id, issuer);
  await service.purchaseUnits(tokenization.id, investor, {
    units: "250",
    holderAddress: INVESTOR1_ADDRESS,
  });
  return tokenization;
}

describe("RWA reconciliation", () => {
  it("matches when holdings and contract balances agree", async () => {
    const { service, job } = setup();
    await tokenizationWithHolder(service);

    const report = await job.run();

    expect(report.status).toBe("matched");
    expect(report.unresolved).toBe(0);
    expect(job.lastUnresolved()).toBe(0);
  });

  it("flags units moved on-chain without a matching holding", async () => {
    const { service, gateway, job } = setup();
    const tokenization = await tokenizationWithHolder(service);
    const custodian = await gateway.issuerAddress("issuer-1");

    // A direct on-chain transfer the backend never saw. Nothing in our tables
    // changes; the contract now disagrees with every one of them.
    await gateway.transferUnits({
      contractId: tokenization.contractId as string,
      issuerUserId: "issuer-1",
      from: custodian,
      to: INVESTOR2_ADDRESS,
      units: 100n,
    });

    const report = await job.run();

    expect(report.status).toBe("mismatch");
    expect(report.mismatches.map((m) => m.reason).join(" ")).toMatch(
      /holds 100 units on-chain with no recorded holding/,
    );
  });

  it("flags a compliance freeze applied to the contract but not the record", async () => {
    const { service, gateway, job } = setup();
    const tokenization = await tokenizationWithHolder(service);

    await gateway.freezeToken(tokenization.contractId as string);

    const report = await job.run();
    expect(report.status).toBe("mismatch");
    expect(report.mismatches.map((m) => m.reason).join(" ")).toMatch(
      /transfers are frozen but our records say they are not/,
    );
  });

  it("ignores draft tokenizations that have no contract yet", async () => {
    const { service, job } = setup();
    const asset = await createVerifiedAsset(service, issuer.userId, {
      assetRef: "invoice:INV-DRAFT",
      description: "not deployed",
      valuationAmount: "1000",
    });
    await service.createTokenization(issuer.userId, {
      assetId: asset.id,
      totalUnits: "10",
      faceValueAmount: "1000",
      faceValueCurrency: "USDC",
      advanceRateBps: 10_000,
      discountRateBps: 0,
      maturityDate: FUTURE_MATURITY,
      requireAuthorization: false,
    });

    const report = await job.run();
    expect(report.checked).toBe(0);
    expect(report.status).toBe("matched");
  });
});

describe("payouts refuse to run against drifted unit records", () => {
  it("stops when a holder's on-chain balance no longer matches", async () => {
    const { service, gateway } = setup();
    const tokenization = await tokenizationWithHolder(service);
    const custodian = await gateway.issuerAddress("issuer-1");

    // The holder sells half their units on-chain. Our holdings row still says
    // 250, so a pro-rata payout would overpay them and underpay everyone else.
    await gateway.transferUnits({
      contractId: tokenization.contractId as string,
      issuerUserId: "issuer-1",
      from: custodian,
      to: INVESTOR1_ADDRESS,
      units: 250n,
    });

    await expect(
      service.distributePayout(
        tokenization.id,
        "order-1",
        "release",
        100_000n,
        "USDC",
        system,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("stops when the contract reports a holder we have no record of", async () => {
    const { service, gateway } = setup();
    const tokenization = await tokenizationWithHolder(service);
    const custodian = await gateway.issuerAddress("issuer-1");

    await gateway.transferUnits({
      contractId: tokenization.contractId as string,
      issuerUserId: "issuer-1",
      from: custodian,
      to: INVESTOR2_ADDRESS,
      units: 100n,
    });

    await expect(
      service.distributePayout(
        tokenization.id,
        "order-1",
        "release",
        100_000n,
        "USDC",
        system,
      ),
    ).rejects.toThrow(/no record of/);
  });

  it("still distributes when records and contract agree", async () => {
    const { service } = setup();
    const tokenization = await tokenizationWithHolder(service);

    const distribution = await service.distributePayout(
      tokenization.id,
      "order-1",
      "release",
      100_000n,
      "USDC",
      system,
    );

    expect(distribution.status).toBe("completed");
    // 250/1000 of 100_000.
    expect(distribution.totalAmount).toBe("100000");
  });
});
