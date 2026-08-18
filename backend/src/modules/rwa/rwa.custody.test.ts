/**
 * Issuer self-custody: the issuer holds their own units and signs for them.
 *
 * Under `RWA_CUSTODY=platform` the server signer is the on-chain issuer. It
 * holds the entire supply and signs every operation, which is convenient and
 * entirely custodial — the issuer owns nothing on-chain.
 *
 * `RWA_CUSTODY=issuer` moves the supply to the issuer's own SEP-10 wallet.
 * Everything the contract gates on `issuer.require_auth()` then needs their
 * signature, and the consequences reach well past the gateway: the platform
 * cannot deliver purchased units, cannot freeze the token for compliance, and
 * cannot arm the contract's payout guard. Each of those has to be handled
 * honestly rather than silently skipped — a purchase that records units nobody
 * transferred is worse than one that says it is still pending.
 */
import {
  ChainSigningMode,
  RwaCustodyMode,
  RwaTransition,
  TokenHoldingStatus,
  TokenizationStatus,
} from "@stellartrust/shared";
import { describe, expect, it } from "vitest";
import { InMemoryAuditRepository } from "../audit/audit.repository.js";
import { StaticWalletAddressResolver } from "../identity/wallet.resolver.js";
import { InMemoryLedgerRepository } from "../ledger/ledger.repository.js";
import { LedgerService } from "../ledger/ledger.service.js";
import { DeterministicRwaGateway } from "./rwa.gateway.js";
import { RwaReconciliationJob } from "./rwa.reconciliation.job.js";
import { InMemoryRwaRepository } from "./rwa.repository.js";
import { RwaService, type RwaActor } from "./rwa.service.js";
import { AssetType } from "./rwa.types.js";

const ISSUER_WALLET = "GBUV3T3YDFD232LUXGADFZV2XCMNEHXBMVTQPBD7DKHTP4Q6ZLNOSMEX";
const INVESTOR1 = "GDYWVMFH5JDIISEZMLDFTN6A5NHPLZGKTTYAAKGB5Z6U7MHKUV6JPVS5";

const issuer: RwaActor = { userId: "issuer-1", roles: ["user"] };
const investor: RwaActor = { userId: "investor-1", roles: ["user"] };
const compliance: RwaActor = { userId: "compliance-1", roles: ["compliance"] };
const system: RwaActor = { userId: "system", roles: ["system"] };

function setup() {
  const repository = new InMemoryRwaRepository();
  const addresses = new StaticWalletAddressResolver(
    new Map([["issuer-1", ISSUER_WALLET]]),
  );
  const gateway = new DeterministicRwaGateway(
    RwaCustodyMode.Issuer,
    addresses,
  );
  const audit = new InMemoryAuditRepository();
  const service = new RwaService(
    repository,
    gateway,
    audit,
    new LedgerService(new InMemoryLedgerRepository()),
    addresses,
  );
  const job = new RwaReconciliationJob(repository, gateway, 60_000);
  return { repository, gateway, audit, service, job };
}

/** Sign a prepared envelope the way the issuer's wallet would. */
function sign(unsignedXdr: string): string {
  return `signed:${unsignedXdr}`;
}

/** Take a draft tokenization all the way to Active via the issuer's wallet. */
async function deployedTokenization(service: RwaService) {
  const asset = await service.createAsset(issuer.userId, {
    assetType: AssetType.Invoice,
    assetRef: "invoice:INV-SELF",
    description: "90-day receivable",
    valuationAmount: "1000000",
    valuationCurrency: "USDC",
  });
  const draft = await service.createTokenization(issuer.userId, {
    assetId: asset.id,
    totalUnits: "1000",
    pricePerUnitAmount: "1000",
    pricePerUnitCurrency: "USDC",
    requireAuthorization: false,
  });

  const prepared = await service.prepareOperation(
    draft.id,
    RwaTransition.Deploy,
    issuer,
  );
  await service.submitSignedOperation(
    draft.id,
    RwaTransition.Deploy,
    issuer,
    sign(prepared.unsignedXdr),
  );
  return service.getTokenizationDetails(draft.id);
}

describe("capabilities advertise who signs", () => {
  it("reports every contract operation as wallet-signed", async () => {
    const { service } = setup();
    const capabilities = await service.capabilities();

    expect(capabilities.custody).toBe(RwaCustodyMode.Issuer);
    expect(capabilities.signingModes[RwaTransition.Deploy]).toBe(
      ChainSigningMode.Wallet,
    );
    expect(capabilities.walletSignedTransitions).toEqual(
      expect.arrayContaining([
        RwaTransition.Deploy,
        RwaTransition.Transfer,
        RwaTransition.Freeze,
        RwaTransition.Distribute,
      ]),
    );
  });

  it("refuses the single-call deploy and names the route that works", async () => {
    const { service } = setup();
    const asset = await service.createAsset(issuer.userId, {
      assetType: AssetType.Invoice,
      assetRef: "invoice:INV-X",
      description: "draft",
      valuationAmount: "1000",
      valuationCurrency: "USDC",
    });
    const draft = await service.createTokenization(issuer.userId, {
      assetId: asset.id,
      totalUnits: "10",
      pricePerUnitAmount: "100",
      pricePerUnitCurrency: "USDC",
    });

    await expect(
      service.deployTokenization(draft.id, issuer),
    ).rejects.toThrow(/must be signed by your wallet/);
  });
});

describe("the issuer holds their own supply", () => {
  it("deploys with the supply at the issuer's own wallet", async () => {
    const { service, gateway } = setup();
    const { tokenization } = await deployedTokenization(service);

    expect(tokenization.status).toBe(TokenizationStatus.Active);
    expect(
      await gateway.getBalance(tokenization.contractId as string, ISSUER_WALLET),
    ).toBe(1000n);
  });

  it("prepares the deploy for the issuer's account, not the platform's", async () => {
    const { service } = setup();
    const asset = await service.createAsset(issuer.userId, {
      assetType: AssetType.Invoice,
      assetRef: "invoice:INV-P",
      description: "draft",
      valuationAmount: "1000",
      valuationCurrency: "USDC",
    });
    const draft = await service.createTokenization(issuer.userId, {
      assetId: asset.id,
      totalUnits: "10",
      pricePerUnitAmount: "100",
      pricePerUnitCurrency: "USDC",
    });

    const prepared = await service.prepareOperation(
      draft.id,
      RwaTransition.Deploy,
      issuer,
    );
    expect(prepared.signerAddress).toBe(ISSUER_WALLET);
  });

  it("reuses the deployed instance when a signature is abandoned", async () => {
    // An abandoned signature should cost one idle contract, not one per retry.
    const { service } = setup();
    const asset = await service.createAsset(issuer.userId, {
      assetType: AssetType.Invoice,
      assetRef: "invoice:INV-R",
      description: "draft",
      valuationAmount: "1000",
      valuationCurrency: "USDC",
    });
    const draft = await service.createTokenization(issuer.userId, {
      assetId: asset.id,
      totalUnits: "10",
      pricePerUnitAmount: "100",
      pricePerUnitCurrency: "USDC",
    });

    const first = await service.prepareOperation(
      draft.id,
      RwaTransition.Deploy,
      issuer,
    );
    const second = await service.prepareOperation(
      draft.id,
      RwaTransition.Deploy,
      issuer,
    );
    expect(second.contractId).toBe(first.contractId);
  });

  it("refuses to let anyone but the issuer sign for the contract", async () => {
    const { service } = setup();
    const { tokenization } = await deployedTokenization(service);

    // Not even compliance: the contract would reject the envelope, so handing
    // one out would be offering a transaction nobody can sign.
    await expect(
      service.prepareOperation(tokenization.id, RwaTransition.Freeze, compliance),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("a purchase is a claim until the issuer signs it over", () => {
  it("records the holding as pending and moves no units", async () => {
    const { service, gateway } = setup();
    const { tokenization } = await deployedTokenization(service);

    const details = await service.purchaseUnits(tokenization.id, investor, {
      units: "250",
      holderAddress: INVESTOR1,
    });

    expect(details.holdings[0]?.status).toBe(TokenHoldingStatus.Pending);
    // Units are reserved against the supply, so nobody can oversell them...
    expect(details.tokenization.unitsSold).toBe("250");
    // ...but the contract has not moved anything.
    expect(
      await gateway.getBalance(tokenization.contractId as string, INVESTOR1),
    ).toBe(0n);
  });

  it("settles the holding once the issuer signs the transfer", async () => {
    const { service, gateway } = setup();
    const { tokenization } = await deployedTokenization(service);
    const purchase = await service.purchaseUnits(tokenization.id, investor, {
      units: "250",
      holderAddress: INVESTOR1,
    });
    const holdingId = purchase.holdings[0]?.id as string;

    const prepared = await service.prepareOperation(
      tokenization.id,
      RwaTransition.Transfer,
      issuer,
      { holdingId },
    );
    expect(prepared.signerAddress).toBe(ISSUER_WALLET);
    expect(prepared.holdingId).toBe(holdingId);

    const settled = await service.submitSignedOperation(
      tokenization.id,
      RwaTransition.Transfer,
      issuer,
      sign(prepared.unsignedXdr),
      { holdingId },
    );

    expect(settled.holdings[0]?.status).toBe(TokenHoldingStatus.Settled);
    expect(
      await gateway.getBalance(tokenization.contractId as string, INVESTOR1),
    ).toBe(250n);
  });

  it("refuses to settle the same holding twice", async () => {
    const { service } = setup();
    const { tokenization } = await deployedTokenization(service);
    const purchase = await service.purchaseUnits(tokenization.id, investor, {
      units: "250",
      holderAddress: INVESTOR1,
    });
    const holdingId = purchase.holdings[0]?.id as string;

    const prepared = await service.prepareOperation(
      tokenization.id,
      RwaTransition.Transfer,
      issuer,
      { holdingId },
    );
    await service.submitSignedOperation(
      tokenization.id,
      RwaTransition.Transfer,
      issuer,
      sign(prepared.unsignedXdr),
      { holdingId },
    );

    await expect(
      service.prepareOperation(tokenization.id, RwaTransition.Transfer, issuer, {
        holdingId,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects an envelope the gateway never issued", async () => {
    const { service } = setup();
    const { tokenization } = await deployedTokenization(service);
    const purchase = await service.purchaseUnits(tokenization.id, investor, {
      units: "10",
      holderAddress: INVESTOR1,
    });

    await expect(
      service.submitSignedOperation(
        tokenization.id,
        RwaTransition.Transfer,
        issuer,
        "signed:not-a-real-envelope",
        { holdingId: purchase.holdings[0]?.id as string },
      ),
    ).rejects.toThrow(/not prepared by the gateway/);
  });
});

describe("payouts only reach holders who actually hold units", () => {
  /** One settled holder (250 units) and one still pending (100 units). */
  async function mixedHolders(service: RwaService) {
    const { tokenization } = await deployedTokenization(service);
    const purchase = await service.purchaseUnits(tokenization.id, investor, {
      units: "250",
      holderAddress: INVESTOR1,
    });
    const holdingId = purchase.holdings[0]?.id as string;
    const prepared = await service.prepareOperation(
      tokenization.id,
      RwaTransition.Transfer,
      issuer,
      { holdingId },
    );
    await service.submitSignedOperation(
      tokenization.id,
      RwaTransition.Transfer,
      issuer,
      sign(prepared.unsignedXdr),
      { holdingId },
    );
    return tokenization;
  }

  it("pays the settled holder and leaves the guard for the issuer", async () => {
    const { service, gateway, audit } = setup();
    const tokenization = await mixedHolders(service);

    const distribution = await service.distributePayout(
      tokenization.id,
      "order-1",
      "release",
      100_000n,
      "USDC",
      system,
    );

    expect(distribution.status).toBe("completed");
    // The money moved in the ledger, which is platform-side and did happen.
    // The contract's one-shot guard did not, because only the issuer can set
    // it — and the audit trail says so rather than leaving it unexplained.
    const meta = await gateway.getContractMeta(
      tokenization.contractId as string,
    );
    expect(meta?.distributed).toBe(false);
    const entries = await audit.listForEntity("tokenization", tokenization.id);
    expect(entries.map((e) => e.action)).toContain(
      "rwa.distribute.guard_pending",
    );
  });

  it("refuses to pay out against a purchase that was never delivered", async () => {
    const { service } = setup();
    const { tokenization } = await deployedTokenization(service);
    await service.purchaseUnits(tokenization.id, investor, {
      units: "250",
      holderAddress: INVESTOR1,
    });

    // The only holding is pending: nobody holds units, so there is nothing to
    // distribute pro-rata against.
    await expect(
      service.distributePayout(
        tokenization.id,
        "order-1",
        "release",
        100_000n,
        "USDC",
        system,
      ),
    ).rejects.toThrow(/No settled holdings/);
  });

  it("lets the issuer arm the guard afterwards", async () => {
    const { service, gateway } = setup();
    const tokenization = await mixedHolders(service);
    await service.distributePayout(
      tokenization.id,
      "order-1",
      "release",
      100_000n,
      "USDC",
      system,
    );

    const prepared = await service.prepareOperation(
      tokenization.id,
      RwaTransition.Distribute,
      issuer,
    );
    await service.submitSignedOperation(
      tokenization.id,
      RwaTransition.Distribute,
      issuer,
      sign(prepared.unsignedXdr),
    );

    const meta = await gateway.getContractMeta(
      tokenization.contractId as string,
    );
    expect(meta?.distributed).toBe(true);
  });
});

describe("compliance cannot unilaterally freeze a self-custodied token", () => {
  it("freezes the record, says it did not reach the contract, and is reported", async () => {
    const { service, gateway, audit, job } = setup();
    const { tokenization } = await deployedTokenization(service);

    const frozen = await service.freezeTokenization(tokenization.id, compliance);

    // Platform-side the hold is immediate: no further purchases are mediated.
    expect(frozen.frozen).toBe(true);
    // On-chain it is not, and cannot be — the contract accepts `freeze` only
    // from the issuer. That is a property of handing issuers their own keys.
    const meta = await gateway.getContractMeta(
      tokenization.contractId as string,
    );
    expect(meta?.frozen).toBe(false);
    const entries = await audit.listForEntity("tokenization", tokenization.id);
    expect(entries.map((e) => e.action)).toContain(
      "rwa.freeze.requires_issuer",
    );

    // And it is surfaced, not swallowed: someone has to chase the issuer.
    const report = await job.run();
    expect(report.status).toBe("mismatch");
    expect(report.mismatches.map((m) => m.reason).join(" ")).toMatch(
      /only the issuer can sign the freeze/,
    );
  });
});

describe("reconciliation understands undelivered purchases", () => {
  it("reports a pending holding as outstanding, not as drift", async () => {
    const { service, job } = setup();
    const { tokenization } = await deployedTokenization(service);
    await service.purchaseUnits(tokenization.id, investor, {
      units: "250",
      holderAddress: INVESTOR1,
    });

    const report = await job.run();

    expect(report.status).toBe("mismatch");
    const reasons = report.mismatches.map((m) => m.reason).join(" ");
    expect(reasons).toMatch(/has paid for 250 units that the issuer has not/);
    // Not reported as a balance disagreement, which would send an operator
    // hunting for drift that does not exist.
    expect(reasons).not.toMatch(/units on-chain but/);
  });

  it("matches once every purchase has been signed over", async () => {
    const { service, job } = setup();
    const { tokenization } = await deployedTokenization(service);
    const purchase = await service.purchaseUnits(tokenization.id, investor, {
      units: "250",
      holderAddress: INVESTOR1,
    });
    const holdingId = purchase.holdings[0]?.id as string;
    const prepared = await service.prepareOperation(
      tokenization.id,
      RwaTransition.Transfer,
      issuer,
      { holdingId },
    );
    await service.submitSignedOperation(
      tokenization.id,
      RwaTransition.Transfer,
      issuer,
      sign(prepared.unsignedXdr),
      { holdingId },
    );

    const report = await job.run();
    expect(report.status).toBe("matched");
  });
});
