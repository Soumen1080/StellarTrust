import { PaymentTransition } from "@stellartrust/shared";
import { describe, expect, it } from "vitest";
import { InMemoryAuditRepository } from "../audit/audit.repository.js";
import { DeterministicEscrowGateway } from "../escrow/escrow.gateway.js";
import { StaticWalletAddressResolver } from "../identity/wallet.resolver.js";
import { isBalanced } from "../ledger/ledger.balance.js";
import { InMemoryLedgerRepository } from "../ledger/ledger.repository.js";
import { LedgerService } from "../ledger/ledger.service.js";
import { InMemoryPaymentRepository } from "../payments/payment.repository.js";
import { PaymentService } from "../payments/payment.service.js";
import { DeterministicRwaGateway } from "./rwa.gateway.js";
import { InMemoryRwaRepository } from "./rwa.repository.js";
import { RwaService, type RwaActor } from "./rwa.service.js";
import { AssetType, TokenizationStatus, PayoutStatus } from "./rwa.types.js";
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

// Real strkeys: these reach a Soroban `Address` argument, and the service now
// rejects anything that is not a valid Stellar account.
const ISSUER_ADDRESS = "GBUV3T3YDFD232LUXGADFZV2XCMNEHXBMVTQPBD7DKHTP4Q6ZLNOSMEX";
const INVESTOR1_ADDRESS = "GDYWVMFH5JDIISEZMLDFTN6A5NHPLZGKTTYAAKGB5Z6U7MHKUV6JPVS5";
const INVESTOR2_ADDRESS = "GBNPF7BZKNCAS32XWOBWGL7KD6NFHLZO5GQDIJA7Z73B7YISNM4MFZNL";

function setup() {
  const repository = new InMemoryRwaRepository();
  const gateway = new DeterministicRwaGateway();
  const audit = new InMemoryAuditRepository();
  const ledger = new LedgerService(new InMemoryLedgerRepository());
  const addresses = new StaticWalletAddressResolver(
    new Map([["issuer-1", ISSUER_ADDRESS]]),
  );
  const service = new RwaService(repository, gateway, audit, ledger, addresses);
  return { repository, gateway, audit, ledger, service };
}

const issuer: RwaActor = { userId: "issuer-1", roles: ["user"] };
const investor: RwaActor = { userId: "investor-1", roles: ["user"] };
const investor2: RwaActor = { userId: "investor-2", roles: ["user"] };
const system: RwaActor = { userId: "system", roles: ["system"] };

async function createActiveTokenization(
  service: RwaService,
  overrides?: {
    requireAuthorization?: boolean;
    totalUnits?: string;
    linkedOrderId?: string;
    discountRateBps?: number;
    advanceRateBps?: number;
    platformFeeBps?: number;
  },
) {
  const asset = await createVerifiedAsset(service, issuer.userId);
  const tokenization = await service.createTokenization(issuer.userId, {
    assetId: asset.id,
    totalUnits: overrides?.totalUnits ?? "1000",
    faceValueAmount: String(BigInt(overrides?.totalUnits ?? "1000") * 1000n),
    faceValueCurrency: "USDC",
    advanceRateBps: overrides?.advanceRateBps ?? 10_000,
    discountRateBps: overrides?.discountRateBps ?? 0,
    platformFeeBps: overrides?.platformFeeBps ?? 0,
    maturityDate: FUTURE_MATURITY,
    requireAuthorization: overrides?.requireAuthorization ?? false,
    linkedOrderId: overrides?.linkedOrderId,
  });
  const deployed = await service.deployTokenization(tokenization.id, issuer);
  return { asset, tokenization: deployed };
}

describe("Phase 5 RWA tokenization", () => {
  it("creates an asset, tokenizes it, and deploys on-chain", async () => {
    const { service } = setup();
    const { tokenization } = await createActiveTokenization(service);
    expect(tokenization.status).toBe(TokenizationStatus.Active);
    expect(tokenization.contractId).toBeTruthy();
    expect(tokenization.unitsSold).toBe("0");
  });

  it("prevents tokenizing an asset the actor does not own", async () => {
    const { service } = setup();
    const asset = await createVerifiedAsset(service, issuer.userId, {
      assetType: AssetType.Commodity,
      assetRef: "commodity:GOLD-1",
      description: "gold bar",
      valuationAmount: "500000",
    });
    await expect(
      service.createTokenization("someone-else", {
        assetId: asset.id,
        totalUnits: "100",
        faceValueAmount: "10000",
        faceValueCurrency: "USDC",
        advanceRateBps: 10_000,
        discountRateBps: 0,
        maturityDate: FUTURE_MATURITY,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects deploying a tokenization by a non-issuer", async () => {
    const { service } = setup();
    const { tokenization } = await createActiveTokenization(service);
    // Already deployed; create a fresh draft to test deploy authorization.
    const asset = await createVerifiedAsset(service, issuer.userId, {
      assetRef: "invoice:INV-DEPLOY",
      description: "draft",
      valuationAmount: "1000",
    });
    const draft = await service.createTokenization(issuer.userId, {
      assetId: asset.id,
      totalUnits: "10",
      faceValueAmount: "100",
      faceValueCurrency: "USDC",
      advanceRateBps: 10_000,
      discountRateBps: 0,
      maturityDate: FUTURE_MATURITY,
    });
    await expect(
      service.deployTokenization(draft.id, investor),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(tokenization.status).toBe(TokenizationStatus.Active);
  });

  it("lets an investor purchase units and tracks units_sold", async () => {
    const { service } = setup();
    const { tokenization } = await createActiveTokenization(service);
    const details = await service.purchaseUnits(tokenization.id, investor, {
      units: "250",
      holderAddress: INVESTOR1_ADDRESS,
    });
    expect(details.tokenization.unitsSold).toBe("250");
    expect(details.availableUnits).toBe("750");
    expect(details.totalRaised).toBe("250000"); // 250 * 1000
    expect(details.holdings).toHaveLength(1);
    expect(details.holdings[0]?.units).toBe("250");
  });

  // ── A subscription must move money (plane.md §1.1, defect D1) ─────────────
  //
  // Until these existed, `purchaseUnits` wrote a holding row and an audit entry
  // and charged nobody: the investor paid nothing and the issuer received
  // nothing. Every assertion below is about the ledger, because the holding row
  // was never the part that was missing.

  it("posts a balanced ledger transaction for an investor subscription", async () => {
    const { service, ledger } = setup();
    const { tokenization } = await createActiveTokenization(service);

    await service.purchaseUnits(tokenization.id, investor, {
      units: "250",
      holderAddress: INVESTOR1_ADDRESS,
    });

    const posted = await ledger.getByReference(
      `rwa-subscription:${tokenization.id}:${investor.userId}:250`,
    );
    expect(posted).toBeDefined();
    expect(isBalanced(posted!.entries)).toBe(true);

    // 250 units x 1000 = 250,000 in, and with no discount configured the whole
    // amount is owed onward to the issuer.
    const debits = posted!.entries.filter((e) => e.direction === "debit");
    const credits = posted!.entries.filter((e) => e.direction === "credit");
    expect(debits).toHaveLength(1);
    expect(debits[0]?.amount).toBe("250000");
    expect(
      credits.reduce((sum, e) => sum + BigInt(e.amount), 0n).toString(),
    ).toBe("250000");
  });

  it("splits the subscription between the issuer and the investors' discount", async () => {
    const { service, ledger } = setup();
    // An 80% advance with a 4% discount — a deal the face value can actually
    // pay. (A 100% advance plus a discount is refused at creation, because the
    // collection could never cover what investors would be owed.)
    const { tokenization } = await createActiveTokenization(service, {
      advanceRateBps: 8_000,
      discountRateBps: 400,
    });

    await service.purchaseUnits(tokenization.id, investor, {
      units: "100",
      holderAddress: INVESTOR1_ADDRESS,
    });

    // 1,000,000 face x 80% = 800,000 principal over 1000 units = 800/unit.
    const unitPrice = BigInt(tokenization.pricePerUnitAmount);
    expect(unitPrice).toBe(800n);

    const paid = unitPrice * 100n; // 80,000
    const held = (paid * 400n) / 10_000n; // 4% = 3,200
    const posted = await ledger.getByReference(
      `rwa-subscription:${tokenization.id}:${investor.userId}:100`,
    );
    expect(isBalanced(posted!.entries)).toBe(true);
    expect(posted!.entries.map((e) => e.amount).sort()).toEqual(
      [paid.toString(), held.toString(), (paid - held).toString()].sort(),
    );
  });

  it("charges each subscription separately when several investors buy", async () => {
    const { service, ledger } = setup();
    const { tokenization } = await createActiveTokenization(service);

    await service.purchaseUnits(tokenization.id, investor, {
      units: "100",
      holderAddress: INVESTOR1_ADDRESS,
    });
    await service.purchaseUnits(tokenization.id, investor2, {
      units: "150",
      holderAddress: INVESTOR2_ADDRESS,
    });

    const first = await ledger.getByReference(
      `rwa-subscription:${tokenization.id}:${investor.userId}:100`,
    );
    const second = await ledger.getByReference(
      `rwa-subscription:${tokenization.id}:${investor2.userId}:150`,
    );
    expect(first?.id).toBeDefined();
    expect(second?.id).toBeDefined();
    expect(first!.id).not.toBe(second!.id);
  });

  it("records the ledger transaction id on the purchase audit entry", async () => {
    // The audit trail has to lead to the money, or "auditable" is a claim
    // rather than a property.
    const { service, audit, ledger } = setup();
    const { tokenization } = await createActiveTokenization(service);

    await service.purchaseUnits(tokenization.id, investor, {
      units: "10",
      holderAddress: INVESTOR1_ADDRESS,
    });

    const entries = await audit.listForEntity("tokenization", tokenization.id);
    const purchase = entries.find((e) => e.action === "rwa.purchase_units");
    const ledgerTransactionId = purchase?.metadata?.ledgerTransactionId;
    expect(ledgerTransactionId).toBeDefined();

    const posted = await ledger.getByReference(
      `rwa-subscription:${tokenization.id}:${investor.userId}:10`,
    );
    expect(posted!.id).toBe(ledgerTransactionId);
  });

  it("auto-transitions to funded when fully subscribed", async () => {
    const { service } = setup();
    const { tokenization } = await createActiveTokenization(service, { totalUnits: "100" });
    await service.purchaseUnits(tokenization.id, investor, {
      units: "100",
      holderAddress: INVESTOR1_ADDRESS,
    });
    const details = await service.getTokenizationDetails(tokenization.id);
    expect(details.tokenization.status).toBe(TokenizationStatus.Funded);
    expect(details.availableUnits).toBe("0");
  });

  it("rejects over-subscription", async () => {
    const { service } = setup();
    const { tokenization } = await createActiveTokenization(service, { totalUnits: "100" });
    await expect(
      service.purchaseUnits(tokenization.id, investor, {
        units: "101",
        holderAddress: INVESTOR1_ADDRESS,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("blocks purchases when frozen and resumes after unfreeze", async () => {
    const { service } = setup();
    const { tokenization } = await createActiveTokenization(service);
    await service.freezeTokenization(tokenization.id, issuer);
    await expect(
      service.purchaseUnits(tokenization.id, investor, {
        units: "10",
        holderAddress: INVESTOR1_ADDRESS,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await service.unfreezeTokenization(tokenization.id, issuer);
    const details = await service.purchaseUnits(tokenization.id, investor, {
      units: "10",
      holderAddress: INVESTOR1_ADDRESS,
    });
    expect(details.tokenization.unitsSold).toBe("10");
  });

  it("distributes pro-rata payouts to holders", async () => {
    const { service, repository } = setup();
    const { tokenization } = await createActiveTokenization(service);
    // investor1: 300 units (30%), investor2: 200 units (20%), issuer keeps 500 (50%)
    await service.purchaseUnits(tokenization.id, investor, {
      units: "300",
      holderAddress: INVESTOR1_ADDRESS,
    });
    await service.purchaseUnits(tokenization.id, investor2, {
      units: "200",
      holderAddress: INVESTOR2_ADDRESS,
    });

    const distribution = await service.distributePayout(
      tokenization.id,
      "order-1",
      "release",
      10_000n,
      "USDC",
      system,
    );
    expect(distribution.status).toBe(PayoutStatus.Completed);
    expect(distribution.totalAmount).toBe("10000");

    const records = await repository.listPayoutRecords(distribution.id);
    // Only the two investors hold via purchase; issuer holding is off-chain
    // (issuer is not in the holdings table). Shares are pro-rata of total units.
    const byUser = Object.fromEntries(
      records.map((r) => [r.holderUserId, r.shareAmount]),
    );
    // 300/1000 * 10000 = 3000, 200/1000 * 10000 = 2000
    expect(byUser[investor.userId]).toBe("3000");
    expect(byUser[investor2.userId]).toBe("2000");
  });

  it("posts a balanced ledger transaction for the payout", async () => {
    // A payout used to compute its ledger transaction and throw it away, then
    // record a fabricated id that referenced no row — the books showed no trace
    // of money that had been distributed.
    const { service, ledger } = setup();
    const { tokenization } = await createActiveTokenization(service);
    await service.purchaseUnits(tokenization.id, investor, {
      units: "300",
      holderAddress: INVESTOR1_ADDRESS,
    });

    const distribution = await service.distributePayout(
      tokenization.id,
      "order-1",
      "release",
      10_000n,
      "USDC",
      system,
    );

    expect(distribution.ledgerTransactionId).toBeTruthy();
    const posted = await ledger.getByReference(
      `rwa-payout:${tokenization.id}:order-1:release`,
    );
    expect(posted?.id).toBe(distribution.ledgerTransactionId);
    expect(isBalanced(posted!.entries)).toBe(true);
    // 300/1000 of 10000 — the ledger records what the holders were actually owed.
    expect(posted!.entries[0]?.amount).toBe("3000");
  });

  it("does not post the payout twice when the same release is retried", async () => {
    const { service, repository } = setup();
    const { tokenization } = await createActiveTokenization(service);
    await service.purchaseUnits(tokenization.id, investor, {
      units: "300",
      holderAddress: INVESTOR1_ADDRESS,
    });

    const first = await service.distributePayout(
      tokenization.id, "order-1", "release", 10_000n, "USDC", system,
    );
    // The escrow release hook is best-effort and retryable, so the same payout
    // can legitimately arrive twice. The ledger must not move twice for it.
    const second = await service.distributePayout(
      tokenization.id, "order-1", "release", 10_000n, "USDC", system,
    );

    expect(second.ledgerTransactionId).toBe(first.ledgerTransactionId);
    const contract = await repository.findTokenization(tokenization.id);
    expect(contract).toBeTruthy();
  });

  it("refuses a payout whose shares all round to zero", async () => {
    // Posting a zero-amount entry is rejected by the ledger schema, so this
    // must fail loudly rather than complete having recorded nothing.
    const { service } = setup();
    const { tokenization } = await createActiveTokenization(service, {
      totalUnits: "1000",
    });
    await service.purchaseUnits(tokenization.id, investor, {
      units: "1",
      holderAddress: INVESTOR1_ADDRESS,
    });
    await expect(
      service.distributePayout(
        tokenization.id, "order-1", "release", 100n, "USDC", system,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects a holder address that is not a Stellar account", async () => {
    // These reach a Soroban `Address` argument. A UUID or an empty string used
    // to pass straight through to the contract.
    const { service } = setup();
    const { tokenization } = await createActiveTokenization(service);
    for (const bad of ["", "GINVESTOR1", "8b1f0f2e-0b6e-4a1e-9f6b-1f2a3b4c5d6e"]) {
      await expect(
        service.purchaseUnits(tokenization.id, investor, {
          units: "10",
          holderAddress: bad,
        }),
      ).rejects.toMatchObject({ code: "VALIDATION" });
    }
  });

  it("holds the supply at the gateway's custodian, not a user id or wallet", async () => {
    // The on-chain issuer is whichever account the gateway can sign for. The
    // Soroban adapter can only be the server signer, so a custodial model is
    // what actually ships — and both adapters must agree on it, or a green
    // local suite says nothing about the deployed system. Passing the issuer's
    // own wallet here used to be silently replaced on-chain while the local
    // adapter kept using it.
    const { service, gateway } = setup();
    const { tokenization } = await createActiveTokenization(service);
    const custodian = await gateway.issuerAddress("issuer-1");

    expect(await gateway.getBalance(tokenization.contractId!, custodian))
      .toBe(1000n);
    // Neither the internal user id nor the issuer's personal wallet holds units.
    expect(await gateway.getBalance(tokenization.contractId!, issuer.userId))
      .toBe(0n);
    expect(await gateway.getBalance(tokenization.contractId!, ISSUER_ADDRESS))
      .toBe(0n);
  });

  it("refuses to act as an address it cannot sign for", async () => {
    // Silently substituting the custodian is exactly the drift this replaced.
    const { gateway } = setup();
    await expect(
      gateway.deployToken({
        issuerUserId: "issuer-1",
        issuerAddress: ISSUER_ADDRESS,
        assetRef: "invoice:INV-X",
        assetType: AssetType.Invoice,
        description: "test",
        totalUnits: 1000n,
        requireAuthorization: false,
      }),
    ).rejects.toThrow(/own signature, which this server does not hold/);
  });

  it("refuses payout distribution from a non-system/non-compliance actor", async () => {
    const { service } = setup();
    const { tokenization } = await createActiveTokenization(service);
    await service.purchaseUnits(tokenization.id, investor, {
      units: "100",
      holderAddress: INVESTOR1_ADDRESS,
    });
    await expect(
      service.distributePayout(
        tokenization.id,
        "order-1",
        "release",
        1000n,
        "USDC",
        investor,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("enforces holder authorization when required", async () => {
    const { service, gateway } = setup();
    const { tokenization } = await createActiveTokenization(service, {
      requireAuthorization: true,
    });
    // Service authorizes the holder as part of purchase.
    await service.purchaseUnits(tokenization.id, investor, {
      units: "50",
      holderAddress: INVESTOR1_ADDRESS,
    });
    expect(await gateway.isAuthorized(tokenization.contractId!, INVESTOR1_ADDRESS)).toBe(true);
    expect(await gateway.isAuthorized(tokenization.contractId!, "GUNKNOWN")).toBe(false);
  });

  it("computes an investor portfolio across holdings", async () => {
    const { service } = setup();
    const { tokenization } = await createActiveTokenization(service);
    await service.purchaseUnits(tokenization.id, investor, {
      units: "100",
      holderAddress: INVESTOR1_ADDRESS,
    });
    const portfolio = await service.getInvestorPortfolio(investor.userId);
    expect(portfolio.holdings).toHaveLength(1);
    expect(portfolio.totalInvested).toBe("100000"); // 100 * 1000
    expect(portfolio.holdings[0]?.asset.assetType).toBe(AssetType.Invoice);
  });
});

describe("Phase 5 RWA gateway (deterministic)", () => {
  /** Deploy a token contract issued by whoever the gateway can sign for. */
  async function deploy(gateway: DeterministicRwaGateway) {
    const contractId = await gateway.deployToken({
      issuerUserId: "issuer-1",
      issuerAddress: await gateway.issuerAddress("issuer-1"),
      assetRef: "invoice:INV-1",
      assetType: AssetType.Invoice,
      description: "test",
      totalUnits: 1000n,
      requireAuthorization: false,
    });
    return { contractId, custodian: await gateway.issuerAddress("issuer-1") };
  }

  it("deploys with the custodian holding all units", async () => {
    const gateway = new DeterministicRwaGateway();
    const { contractId, custodian } = await deploy(gateway);
    expect(await gateway.getBalance(contractId, custodian)).toBe(1000n);
  });

  it("transfers units and computes pro-rata shares", async () => {
    const gateway = new DeterministicRwaGateway();
    const { contractId, custodian } = await deploy(gateway);
    await gateway.transferUnits({
      contractId,
      issuerUserId: "issuer-1",
      from: custodian,
      to: INVESTOR1_ADDRESS,
      units: 250n,
    });
    expect(await gateway.getBalance(contractId, INVESTOR1_ADDRESS)).toBe(250n);
    expect(await gateway.getBalance(contractId, custodian)).toBe(750n);

    const shares = await gateway.getPayoutShares({ contractId, payoutAmount: 4000n });
    const total = shares.reduce((sum, s) => sum + s.shareAmount, 0n);
    expect(total).toBe(4000n);
  });

  it("reports holder balances for reconciliation", async () => {
    const gateway = new DeterministicRwaGateway();
    const { contractId, custodian } = await deploy(gateway);
    await gateway.transferUnits({
      contractId,
      issuerUserId: "issuer-1",
      from: custodian,
      to: INVESTOR1_ADDRESS,
      units: 250n,
    });

    const balances = await gateway.getHolderBalances(contractId);
    expect(balances).toEqual(
      expect.arrayContaining([
        { holderAddress: custodian, units: 750n },
        { holderAddress: INVESTOR1_ADDRESS, units: 250n },
      ]),
    );
  });

  it("refuses a transfer from an address it cannot sign for", async () => {
    // The contract gates `transfer` with `from.require_auth()`. Accepting a
    // `from` we hold no key for would green-light a call the chain rejects.
    const gateway = new DeterministicRwaGateway();
    const { contractId } = await deploy(gateway);
    await expect(
      gateway.transferUnits({
        contractId,
        issuerUserId: "issuer-1",
        from: INVESTOR1_ADDRESS,
        to: INVESTOR2_ADDRESS,
        units: 10n,
      }),
    ).rejects.toThrow(/own signature, which this server does not hold/);
  });

  it("blocks transfers when frozen", async () => {
    const gateway = new DeterministicRwaGateway();
    const { contractId, custodian } = await deploy(gateway);
    await gateway.freezeToken(contractId);
    await expect(
      gateway.transferUnits({
        contractId,
        issuerUserId: "issuer-1",
        from: custodian,
        to: INVESTOR1_ADDRESS,
        units: 10n,
      }),
    ).rejects.toMatchObject({ code: "CHAIN" });
  });
});

describe("Phase 5 RWA payout integration with escrow release", () => {
  function integratedSetup() {
    const rwaRepository = new InMemoryRwaRepository();
    const rwaGateway = new DeterministicRwaGateway();
    const audit = new InMemoryAuditRepository();
    const ledger = new LedgerService(new InMemoryLedgerRepository());
    const rwa = new RwaService(
      rwaRepository,
      rwaGateway,
      audit,
      ledger,
      new StaticWalletAddressResolver(new Map([["issuer-1", ISSUER_ADDRESS]])),
    );

    const paymentRepository = new InMemoryPaymentRepository();
    const escrowGateway = new DeterministicEscrowGateway();
    const payments = new PaymentService(
      paymentRepository,
      escrowGateway,
      audit,
      rwa,
    );
    return { rwa, rwaRepository, payments, ledger };
  }

  it("distributes an RWA payout automatically when the linked order is released", async () => {
    const { rwa, rwaRepository, payments } = integratedSetup();
    const buyer = { userId: "buyer-1", roles: ["user"] };
    const seller = { userId: "seller-1", roles: ["user"] };

    // Create and run the escrow happy path up to lock.
    const created = await payments.createOrder(buyer.userId, {
      sellerId: seller.userId,
      amount: { amount: "10000", currency: "USDC" },
    });
    const orderId = created.order.id;

    // Issuer tokenizes an asset linked to this order and an investor buys in.
    const asset = await createVerifiedAsset(rwa, issuer.userId, {
      assetRef: "invoice:INV-LINKED",
      description: "linked receivable",
      valuationAmount: "10000",
    });
    const tokenization = await rwa.createTokenization(issuer.userId, {
      assetId: asset.id,
      totalUnits: "1000",
      faceValueAmount: "10000",
      faceValueCurrency: "USDC",
      advanceRateBps: 10_000,
      discountRateBps: 0,
      maturityDate: FUTURE_MATURITY,
      linkedOrderId: orderId,
    });
    const deployed = await rwa.deployTokenization(tokenization.id, issuer);
    await rwa.purchaseUnits(deployed.id, investor, {
      units: "400",
      holderAddress: INVESTOR1_ADDRESS,
    });

    // Advance the escrow to release.
    await payments.transition(orderId, PaymentTransition.Accept, seller);
    await payments.transition(orderId, PaymentTransition.Deposit, buyer);
    await payments.transition(orderId, PaymentTransition.Lock, buyer);
    await payments.transition(orderId, PaymentTransition.Confirm, buyer);
    await payments.transition(orderId, PaymentTransition.Release, buyer);

    // The release should have triggered a completed payout distribution.
    const distributions = await rwaRepository.listDistributions(deployed.id);
    expect(distributions).toHaveLength(1);
    expect(distributions[0]?.status).toBe(PayoutStatus.Completed);
    expect(distributions[0]?.triggeredByOrderId).toBe(orderId);
    expect(distributions[0]?.totalAmount).toBe("10000");

    const records = await rwaRepository.listPayoutRecords(distributions[0]!.id);
    const investorShare = records.find((r) => r.holderUserId === investor.userId);
    // 400/1000 * 10000 = 4000
    expect(investorShare?.shareAmount).toBe("4000");
  });

  it("does not distribute when no tokenization is linked to the order", async () => {
    const { rwa, rwaRepository, payments } = integratedSetup();
    const buyer = { userId: "buyer-1", roles: ["user"] };
    const seller = { userId: "seller-1", roles: ["user"] };

    const created = await payments.createOrder(buyer.userId, {
      sellerId: seller.userId,
      amount: { amount: "5000", currency: "USDC" },
    });
    const orderId = created.order.id;

    await payments.transition(orderId, PaymentTransition.Accept, seller);
    await payments.transition(orderId, PaymentTransition.Deposit, buyer);
    await payments.transition(orderId, PaymentTransition.Lock, buyer);
    await payments.transition(orderId, PaymentTransition.Confirm, buyer);
    const released = await payments.transition(orderId, PaymentTransition.Release, buyer);

    expect(released.order.status).toBe("released");
    // No tokenizations exist, so none should be created/distributed.
    const all = await rwa.listTokenizations();
    expect(all).toHaveLength(0);
    // Sanity: no distribution rows anywhere.
    expect(await rwaRepository.listDistributions("nonexistent")).toHaveLength(0);
  });
});

/**
 * The payout waterfall (plane.md §1.3).
 *
 * Before this, `distributePayout` handed the *entire* collection to unit
 * holders: the platform earned nothing and the seller's retained first-loss —
 * the thing that makes the structure work — silently went to investors. These
 * tests pin the ordering and the exact minor units, because "roughly right" in
 * a waterfall is a misallocation of somebody's money.
 */
describe("RWA payout waterfall", () => {
  /**
   * The worked example from plane.md §1.2, scaled to whole units.
   *
   * 100,000 face @ 80% advance, 4% discount, 1% fee:
   *   financed 80,000 · investors 83,200 · platform 800 · seller 16,000
   */
  async function fundedInvoice(service: RwaService) {
    const { tokenization } = await createActiveTokenization(service, {
      totalUnits: "1000",
      advanceRateBps: 8_000,
      discountRateBps: 400,
      platformFeeBps: 100,
    });
    // The helper derives face value as totalUnits × 1000 = 1,000,000 minor
    // units. All the amounts below are that scale, not the doc's 100,000.
    return tokenization;
  }

  it("pays investors, then the platform, then the seller's residual", async () => {
    const { service, repository, ledger } = setup();
    const tokenization = await fundedInvoice(service);

    // Fully subscribed: shares are pro-rata of *total* units, so the whole
    // investor leg is paid out only when every unit is held by an investor.
    await service.purchaseUnits(tokenization.id, investor, {
      units: "750",
      holderAddress: INVESTOR1_ADDRESS,
    });
    await service.purchaseUnits(tokenization.id, investor2, {
      units: "250",
      holderAddress: INVESTOR2_ADDRESS,
    });

    // The debtor pays face value, on time.
    const distribution = await service.distributePayout(
      tokenization.id,
      "order-1",
      "release",
      1_000_000n,
      "USDC",
      system,
    );
    expect(distribution.status).toBe(PayoutStatus.Completed);

    // Investors receive principal 800,000 + 4% yield 32,000 = 832,000 —
    // NOT the full 1,000,000 collected.
    const records = await repository.listPayoutRecords(distribution.id);
    const paid = records.reduce((sum, r) => sum + BigInt(r.shareAmount), 0n);
    expect(paid).toBe(832_000n);

    // 750/250 of the investor leg, not of the gross collection.
    const byUser = Object.fromEntries(
      records.map((r) => [r.holderUserId, r.shareAmount]),
    );
    expect(byUser[investor.userId]).toBe("624000");
    expect(byUser[investor2.userId]).toBe("208000");

    // The ledger carries all three legs and still balances: 1% fee of face is
    // 10,000, leaving the seller the retained 20% less the yield = 158,000.
    const posted = await ledger.getByReference(
      `rwa-payout:${tokenization.id}:order-1:release`,
    );
    expect(isBalanced(posted!.entries)).toBe(true);
    const credited = posted!.entries
      .filter((e) => e.direction === "credit")
      .map((e) => e.amount)
      .sort();
    expect(credited).toEqual(["10000", "158000", "832000"].sort());

    // The legs reconstitute the collection exactly — no minor unit invented
    // or lost between what the debtor paid and what the books recorded.
    const debited = posted!.entries
      .filter((e) => e.direction === "debit")
      .reduce((sum, e) => sum + BigInt(e.amount), 0n);
    expect(debited).toBe(1_000_000n);
  });

  it("marks the position repaid and stamps when it was collected", async () => {
    const { service, repository } = setup();
    const tokenization = await fundedInvoice(service);
    await service.purchaseUnits(tokenization.id, investor, {
      units: "1000",
      holderAddress: INVESTOR1_ADDRESS,
    });

    await service.distributePayout(
      tokenization.id,
      "order-1",
      "release",
      1_000_000n,
      "USDC",
      system,
    );

    const after = await repository.findTokenization(tokenization.id);
    expect(after?.status).toBe(TokenizationStatus.Repaid);
    expect(after?.collectedAt).toBeTruthy();
  });

  it("pays investors first and leaves platform and seller nothing on a partial collection", async () => {
    const { service, repository, ledger } = setup();
    const tokenization = await fundedInvoice(service);
    await service.purchaseUnits(tokenization.id, investor, {
      units: "1000",
      holderAddress: INVESTOR1_ADDRESS,
    });

    // Only half the face value arrives — less than the investors' 832,000
    // entitlement, so strict priority gives them all of it.
    const distribution = await service.distributePayout(
      tokenization.id,
      "order-1",
      "release",
      500_000n,
      "USDC",
      system,
    );

    const records = await repository.listPayoutRecords(distribution.id);
    const paid = records.reduce((sum, r) => sum + BigInt(r.shareAmount), 0n);
    expect(paid).toBe(500_000n);

    // One credit leg only: nothing reached the platform or the seller.
    const posted = await ledger.getByReference(
      `rwa-payout:${tokenization.id}:order-1:release`,
    );
    expect(isBalanced(posted!.entries)).toBe(true);
    expect(posted!.entries.filter((e) => e.direction === "credit")).toHaveLength(
      1,
    );

    // A shortfall leaves the position open — it is the input to the default
    // path, not a completed repayment.
    const after = await repository.findTokenization(tokenization.id);
    expect(after?.status).not.toBe(TokenizationStatus.Repaid);
  });

  it("refuses a collection too small to pay any investor", async () => {
    const { service } = setup();
    const tokenization = await fundedInvoice(service);
    await service.purchaseUnits(tokenization.id, investor, {
      units: "1000",
      holderAddress: INVESTOR1_ADDRESS,
    });

    await expect(
      service.distributePayout(
        tokenization.id,
        "order-1",
        "release",
        0n,
        "USDC",
        system,
      ),
    ).rejects.toThrow(/too small/i);
  });
});
