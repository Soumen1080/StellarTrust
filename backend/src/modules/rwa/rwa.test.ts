import { PaymentTransition } from "@stellartrust/shared";
import { describe, expect, it } from "vitest";
import { InMemoryAuditRepository } from "../audit/audit.repository.js";
import { DeterministicEscrowGateway } from "../escrow/escrow.gateway.js";
import { InMemoryPaymentRepository } from "../payments/payment.repository.js";
import { PaymentService } from "../payments/payment.service.js";
import { DeterministicRwaGateway } from "./rwa.gateway.js";
import { InMemoryRwaRepository } from "./rwa.repository.js";
import { RwaService, type RwaActor } from "./rwa.service.js";
import { AssetType, TokenizationStatus, PayoutStatus } from "./rwa.types.js";

function setup() {
  const repository = new InMemoryRwaRepository();
  const gateway = new DeterministicRwaGateway();
  const audit = new InMemoryAuditRepository();
  const service = new RwaService(repository, gateway, audit);
  return { repository, gateway, audit, service };
}

const issuer: RwaActor = { userId: "issuer-1", roles: ["user"] };
const investor: RwaActor = { userId: "investor-1", roles: ["user"] };
const investor2: RwaActor = { userId: "investor-2", roles: ["user"] };
const system: RwaActor = { userId: "system", roles: ["system"] };

async function createActiveTokenization(
  service: RwaService,
  overrides?: { requireAuthorization?: boolean; totalUnits?: string; linkedOrderId?: string },
) {
  const asset = await service.createAsset(issuer.userId, {
    assetType: AssetType.Invoice,
    assetRef: `invoice:INV-${Math.random().toString(36).slice(2, 8)}`,
    description: "90-day receivable",
    valuationAmount: "1000000",
    valuationCurrency: "USDC",
  });
  const tokenization = await service.createTokenization(issuer.userId, {
    assetId: asset.id,
    totalUnits: overrides?.totalUnits ?? "1000",
    pricePerUnitAmount: "1000",
    pricePerUnitCurrency: "USDC",
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
    const asset = await service.createAsset(issuer.userId, {
      assetType: AssetType.Commodity,
      assetRef: "commodity:GOLD-1",
      description: "gold bar",
      valuationAmount: "500000",
      valuationCurrency: "USDC",
    });
    await expect(
      service.createTokenization("someone-else", {
        assetId: asset.id,
        totalUnits: "100",
        pricePerUnitAmount: "100",
        pricePerUnitCurrency: "USDC",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects deploying a tokenization by a non-issuer", async () => {
    const { service } = setup();
    const { tokenization } = await createActiveTokenization(service);
    // Already deployed; create a fresh draft to test deploy authorization.
    const asset = await service.createAsset(issuer.userId, {
      assetType: AssetType.Invoice,
      assetRef: "invoice:INV-DEPLOY",
      description: "draft",
      valuationAmount: "1000",
      valuationCurrency: "USDC",
    });
    const draft = await service.createTokenization(issuer.userId, {
      assetId: asset.id,
      totalUnits: "10",
      pricePerUnitAmount: "10",
      pricePerUnitCurrency: "USDC",
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
      holderAddress: "GINVESTOR1",
    });
    expect(details.tokenization.unitsSold).toBe("250");
    expect(details.availableUnits).toBe("750");
    expect(details.totalRaised).toBe("250000"); // 250 * 1000
    expect(details.holdings).toHaveLength(1);
    expect(details.holdings[0]?.units).toBe("250");
  });

  it("auto-transitions to funded when fully subscribed", async () => {
    const { service } = setup();
    const { tokenization } = await createActiveTokenization(service, { totalUnits: "100" });
    await service.purchaseUnits(tokenization.id, investor, {
      units: "100",
      holderAddress: "GINVESTOR1",
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
        holderAddress: "GINVESTOR1",
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
        holderAddress: "GINVESTOR1",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await service.unfreezeTokenization(tokenization.id, issuer);
    const details = await service.purchaseUnits(tokenization.id, investor, {
      units: "10",
      holderAddress: "GINVESTOR1",
    });
    expect(details.tokenization.unitsSold).toBe("10");
  });

  it("distributes pro-rata payouts to holders", async () => {
    const { service, repository } = setup();
    const { tokenization } = await createActiveTokenization(service);
    // investor1: 300 units (30%), investor2: 200 units (20%), issuer keeps 500 (50%)
    await service.purchaseUnits(tokenization.id, investor, {
      units: "300",
      holderAddress: "GINVESTOR1",
    });
    await service.purchaseUnits(tokenization.id, investor2, {
      units: "200",
      holderAddress: "GINVESTOR2",
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

  it("refuses payout distribution from a non-system/non-compliance actor", async () => {
    const { service } = setup();
    const { tokenization } = await createActiveTokenization(service);
    await service.purchaseUnits(tokenization.id, investor, {
      units: "100",
      holderAddress: "GINVESTOR1",
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
      holderAddress: "GINVESTOR1",
    });
    expect(await gateway.isAuthorized(tokenization.contractId!, "GINVESTOR1")).toBe(true);
    expect(await gateway.isAuthorized(tokenization.contractId!, "GUNKNOWN")).toBe(false);
  });

  it("computes an investor portfolio across holdings", async () => {
    const { service } = setup();
    const { tokenization } = await createActiveTokenization(service);
    await service.purchaseUnits(tokenization.id, investor, {
      units: "100",
      holderAddress: "GINVESTOR1",
    });
    const portfolio = await service.getInvestorPortfolio(investor.userId);
    expect(portfolio.holdings).toHaveLength(1);
    expect(portfolio.totalInvested).toBe("100000"); // 100 * 1000
    expect(portfolio.holdings[0]?.asset.assetType).toBe(AssetType.Invoice);
  });
});

describe("Phase 5 RWA gateway (deterministic)", () => {
  it("deploys with issuer holding all units", async () => {
    const gateway = new DeterministicRwaGateway();
    const contractId = await gateway.deployToken({
      issuerAddress: "GISSUER",
      assetRef: "invoice:INV-1",
      assetType: AssetType.Invoice,
      description: "test",
      totalUnits: 1000n,
      requireAuthorization: false,
    });
    expect(await gateway.getBalance(contractId, "GISSUER")).toBe(1000n);
  });

  it("transfers units and computes pro-rata shares", async () => {
    const gateway = new DeterministicRwaGateway();
    const contractId = await gateway.deployToken({
      issuerAddress: "GISSUER",
      assetRef: "invoice:INV-1",
      assetType: AssetType.Invoice,
      description: "test",
      totalUnits: 1000n,
      requireAuthorization: false,
    });
    await gateway.transferUnits({ contractId, from: "GISSUER", to: "GINV1", units: 250n });
    expect(await gateway.getBalance(contractId, "GINV1")).toBe(250n);
    expect(await gateway.getBalance(contractId, "GISSUER")).toBe(750n);

    const shares = await gateway.getPayoutShares({ contractId, payoutAmount: 4000n });
    const total = shares.reduce((sum, s) => sum + s.shareAmount, 0n);
    expect(total).toBe(4000n);
  });

  it("blocks transfers when frozen", async () => {
    const gateway = new DeterministicRwaGateway();
    const contractId = await gateway.deployToken({
      issuerAddress: "GISSUER",
      assetRef: "invoice:INV-1",
      assetType: AssetType.Invoice,
      description: "test",
      totalUnits: 1000n,
      requireAuthorization: false,
    });
    await gateway.freezeToken(contractId);
    await expect(
      gateway.transferUnits({ contractId, from: "GISSUER", to: "GINV1", units: 10n }),
    ).rejects.toMatchObject({ code: "CHAIN" });
  });
});

describe("Phase 5 RWA payout integration with escrow release", () => {
  function integratedSetup() {
    const rwaRepository = new InMemoryRwaRepository();
    const rwaGateway = new DeterministicRwaGateway();
    const audit = new InMemoryAuditRepository();
    const rwa = new RwaService(rwaRepository, rwaGateway, audit);

    const paymentRepository = new InMemoryPaymentRepository();
    const escrowGateway = new DeterministicEscrowGateway();
    const payments = new PaymentService(
      paymentRepository,
      escrowGateway,
      audit,
      rwa,
    );
    return { rwa, rwaRepository, payments };
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
    const asset = await rwa.createAsset(issuer.userId, {
      assetType: AssetType.Invoice,
      assetRef: "invoice:INV-LINKED",
      description: "linked receivable",
      valuationAmount: "10000",
      valuationCurrency: "USDC",
    });
    const tokenization = await rwa.createTokenization(issuer.userId, {
      assetId: asset.id,
      totalUnits: "1000",
      pricePerUnitAmount: "10",
      pricePerUnitCurrency: "USDC",
      linkedOrderId: orderId,
    });
    const deployed = await rwa.deployTokenization(tokenization.id, issuer);
    await rwa.purchaseUnits(deployed.id, investor, {
      units: "400",
      holderAddress: "GINVESTOR1",
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
