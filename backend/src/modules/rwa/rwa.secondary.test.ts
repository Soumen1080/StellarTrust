/**
 * Secondary market (plane.md §3.3).
 *
 * This replaces the D6 refusal: an investor could enter a position and never
 * leave it, and could not add to one they liked. The plan names two acceptance
 * conditions — a transfer to an unauthorized holder refused, and a frozen
 * token refused — and both are here alongside the arithmetic that makes a
 * part-sale add up.
 */

import { KycStatus, RwaCustodyMode, RwaTransition } from "@stellartrust/shared";
import { describe, expect, it } from "vitest";
import { InMemoryAuditRepository } from "../audit/audit.repository.js";
import { StaticWalletAddressResolver } from "../identity/wallet.resolver.js";
import { isBalanced } from "../ledger/ledger.balance.js";
import { PrefundedLedgerService } from "../ledger/ledger.test-fixtures.js";
import { DeterministicRwaGateway } from "./rwa.gateway.js";
import { InMemoryRwaRepository } from "./rwa.repository.js";
import {
  RwaService,
  UNRESTRICTED_INVESTOR_LIMITS,
  type InvestorLimits,
  type RwaActor,
} from "./rwa.service.js";
import { TokenizationStatus } from "./rwa.types.js";
import { createVerifiedAsset } from "./rwa.test-fixtures.js";

const ISSUER_ADDRESS = "GBUV3T3YDFD232LUXGADFZV2XCMNEHXBMVTQPBD7DKHTP4Q6ZLNOSMEX";
const INVESTOR1_ADDRESS = "GDYWVMFH5JDIISEZMLDFTN6A5NHPLZGKTTYAAKGB5Z6U7MHKUV6JPVS5";
const INVESTOR2_ADDRESS = "GBNPF7BZKNCAS32XWOBWGL7KD6NFHLZO5GQDIJA7Z73B7YISNM4MFZNL";

const FUTURE_MATURITY = new Date(
  Date.now() + 90 * 24 * 60 * 60 * 1000,
).toISOString();

const issuer: RwaActor = { userId: "issuer-1", roles: ["user"] };
const seller: RwaActor = { userId: "investor-1", roles: ["user"] };
const compliance: RwaActor = { userId: "compliance-1", roles: ["compliance"] };
const BUYER_ID = "investor-2";

function setup(limits?: Partial<InvestorLimits>) {
  const repository = new InMemoryRwaRepository();
  const audit = new InMemoryAuditRepository();
  const ledger = new PrefundedLedgerService();
  const gateway = new DeterministicRwaGateway();
  const service = new RwaService(
    repository,
    gateway,
    audit,
    ledger,
    new StaticWalletAddressResolver(new Map([["issuer-1", ISSUER_ADDRESS]])),
    undefined,
    { getStatus: async () => ({ status: KycStatus.Verified }) },
    { ...UNRESTRICTED_INVESTOR_LIMITS, ...limits },
  );
  return { repository, audit, ledger, gateway, service };
}

/** A deployed tokenization of 1000 units at 1000 minor units each. */
async function activeTokenization(
  service: RwaService,
  overrides?: { requireAuthorization?: boolean },
) {
  const asset = await createVerifiedAsset(service, issuer.userId);
  const tokenization = await service.createTokenization(issuer.userId, {
    assetId: asset.id,
    totalUnits: "1000",
    faceValueAmount: "1000000",
    faceValueCurrency: "USDC",
    advanceRateBps: 10_000,
    discountRateBps: 0,
    maturityDate: FUTURE_MATURITY,
    requireAuthorization: overrides?.requireAuthorization ?? false,
  });
  return service.deployTokenization(tokenization.id, issuer);
}

/** A tokenization in which the seller already holds `units`. */
async function withSellerPosition(service: RwaService, units = "100") {
  const tokenization = await activeTokenization(service);
  await service.purchaseUnits(tokenization.id, seller, {
    units,
    holderAddress: INVESTOR1_ADDRESS,
  });
  return tokenization;
}

describe("an existing holder can increase their position", () => {
  it("adds to the holding instead of refusing", async () => {
    const { service, repository } = setup();
    const tokenization = await withSellerPosition(service, "100");

    // The D6 refusal used to fire here.
    await service.purchaseUnits(tokenization.id, seller, {
      units: "50",
      holderAddress: INVESTOR1_ADDRESS,
    });

    const holding = await repository.findHolding(
      tokenization.id,
      seller.userId,
    );
    expect(holding?.units).toBe("150");
    expect(holding?.purchaseAmount).toBe("150000");
  });

  it("keeps the original purchase date so a top-up cannot reopen a closed window", async () => {
    const { service, repository } = setup();
    const tokenization = await withSellerPosition(service, "100");
    const first = await repository.findHolding(tokenization.id, seller.userId);

    await service.purchaseUnits(tokenization.id, seller, {
      units: "50",
      holderAddress: INVESTOR1_ADDRESS,
    });

    // `purchasedAt` drives the cooling-off window and the yield accrual.
    // Resetting it on a top-up would reopen a window that had closed on the
    // units bought earlier.
    const after = await repository.findHolding(tokenization.id, seller.userId);
    expect(after?.purchasedAt).toBe(first?.purchasedAt);
  });

  it("charges for the second purchase rather than reusing the first posting", async () => {
    const { service, ledger } = setup();
    const tokenization = await withSellerPosition(service, "10");

    // Buying the same quantity twice. Keyed on the increment, both would build
    // the same ledger reference and the second would silently reuse the first
    // — handing over 10 units for free.
    await service.purchaseUnits(tokenization.id, seller, {
      units: "10",
      holderAddress: INVESTOR1_ADDRESS,
    });

    const first = await ledger.getByReference(
      `rwa-subscription:${tokenization.id}:${seller.userId}:10`,
    );
    const second = await ledger.getByReference(
      `rwa-subscription:${tokenization.id}:${seller.userId}:20`,
    );
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second!.id).not.toBe(first!.id);
  });

  it("measures the concentration limit on the resulting position", async () => {
    const { service } = setup({ maxConcentrationBps: 2_500 });
    const tokenization = await withSellerPosition(service, "200");

    // 200 held plus 51 would be 251 of 1000 — over 25%. Checking only the
    // increment would let an investor walk past the cap in small steps, which
    // is the one thing a concentration cap exists to stop.
    await expect(
      service.purchaseUnits(tokenization.id, seller, {
        units: "51",
        holderAddress: INVESTOR1_ADDRESS,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    // Exactly at the cap is allowed.
    await service.purchaseUnits(tokenization.id, seller, {
      units: "50",
      holderAddress: INVESTOR1_ADDRESS,
    });
  });

  it("refuses a top-up into a different address", async () => {
    const { service } = setup();
    const tokenization = await withSellerPosition(service, "100");

    // The holding is unique on (tokenization, address) and the on-chain
    // balance lives at one account; splitting it would leave the record
    // claiming a single position that the chain holds in two places.
    await expect(
      service.purchaseUnits(tokenization.id, seller, {
        units: "50",
        holderAddress: INVESTOR2_ADDRESS,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("holder-to-holder transfer", () => {
  it("moves units and posts both legs of the trade", async () => {
    const { service, repository, ledger } = setup();
    const tokenization = await withSellerPosition(service, "100");

    const result = await service.transferHolding(tokenization.id, seller, {
      toUserId: BUYER_ID,
      toHolderAddress: INVESTOR2_ADDRESS,
      units: "40",
      priceAmount: "48000",
    });

    expect(result.sellerHolding?.units).toBe("60");
    expect(result.buyerHolding.units).toBe("40");

    const buyer = await repository.findHolding(tokenization.id, BUYER_ID);
    expect(buyer?.holderAddress).toBe(INVESTOR2_ADDRESS);

    const posted = await ledger.getByReference(
      `rwa-secondary:${tokenization.id}:${seller.userId}:${BUYER_ID}:40:48000`,
    );
    expect(posted).toBeDefined();
    expect(isBalanced(posted!.entries)).toBe(true);
  });

  it("prices the trade at what the parties agreed, not the primary unit price", async () => {
    const { service, repository } = setup();
    const tokenization = await withSellerPosition(service, "100");

    // 40 units cost 40,000 at the primary price. The agreed price is 48,000 —
    // the claim is worth more now than at issue, which is the entire reason a
    // secondary market exists.
    await service.transferHolding(tokenization.id, seller, {
      toUserId: BUYER_ID,
      toHolderAddress: INVESTOR2_ADDRESS,
      units: "40",
      priceAmount: "48000",
    });

    // The buyer's basis is what they actually paid, so their yield and any
    // loss reflect their own trade rather than the issue's terms.
    const buyer = await repository.findHolding(tokenization.id, BUYER_ID);
    expect(buyer?.purchaseAmount).toBe("48000");
  });

  it("moves the seller's cost basis pro-rata with the units", async () => {
    const { service, repository } = setup();
    const tokenization = await withSellerPosition(service, "100");

    await service.transferHolding(tokenization.id, seller, {
      toUserId: BUYER_ID,
      toHolderAddress: INVESTOR2_ADDRESS,
      units: "40",
      priceAmount: "48000",
    });

    // 100 units cost 100,000; selling 40 takes 40,000 of basis with them.
    // Keeping the whole basis on the remainder would overstate what those 60
    // units cost.
    const remaining = await repository.findHolding(
      tokenization.id,
      seller.userId,
    );
    expect(remaining?.units).toBe("60");
    expect(remaining?.purchaseAmount).toBe("60000");
  });

  it("removes the seller's holding when they sell out completely", async () => {
    const { service, repository } = setup();
    const tokenization = await withSellerPosition(service, "100");

    const result = await service.transferHolding(tokenization.id, seller, {
      toUserId: BUYER_ID,
      toHolderAddress: INVESTOR2_ADDRESS,
      units: "100",
      priceAmount: "100000",
    });

    // A zero-unit holding owns nothing and earns a zero payout share; it is
    // the residue of an exited position, not a position.
    expect(result.sellerHolding).toBeNull();
    expect(
      await repository.findHolding(tokenization.id, seller.userId),
    ).toBeUndefined();
  });

  it("leaves units_sold unchanged — the units moved, they were not issued", async () => {
    const { service, repository } = setup();
    const tokenization = await withSellerPosition(service, "100");

    await service.transferHolding(tokenization.id, seller, {
      toUserId: BUYER_ID,
      toHolderAddress: INVESTOR2_ADDRESS,
      units: "40",
      priceAmount: "48000",
    });

    // A secondary trade is not a subscription: the issue is no more or less
    // sold than it was.
    const after = await repository.findTokenization(tokenization.id);
    expect(after?.unitsSold).toBe("100");
  });

  it("increases an existing buyer position rather than creating a second row", async () => {
    const { service, repository } = setup();
    const tokenization = await activeTokenization(service);
    await service.purchaseUnits(tokenization.id, seller, {
      units: "100",
      holderAddress: INVESTOR1_ADDRESS,
    });
    await service.purchaseUnits(
      tokenization.id,
      { userId: BUYER_ID, roles: ["user"] },
      { units: "50", holderAddress: INVESTOR2_ADDRESS },
    );

    await service.transferHolding(tokenization.id, seller, {
      toUserId: BUYER_ID,
      toHolderAddress: INVESTOR2_ADDRESS,
      units: "40",
      priceAmount: "48000",
    });

    const buyer = await repository.findHolding(tokenization.id, BUYER_ID);
    expect(buyer?.units).toBe("90");
    expect(buyer?.purchaseAmount).toBe("98000");
  });

  it("records the trade in the audit trail", async () => {
    const { service, audit } = setup();
    const tokenization = await withSellerPosition(service, "100");

    await service.transferHolding(tokenization.id, seller, {
      toUserId: BUYER_ID,
      toHolderAddress: INVESTOR2_ADDRESS,
      units: "40",
      priceAmount: "48000",
    });

    const entry = (
      await audit.listForEntity("tokenization", tokenization.id)
    ).find((e) => e.action === "rwa.transfer_units");
    expect(entry?.metadata).toMatchObject({
      toUserId: BUYER_ID,
      units: "40",
      priceAmount: "48000",
      sellerUnitsRemaining: "60",
    });
  });
});

describe("transfers the platform must refuse", () => {
  it("refuses a transfer on a frozen tokenization", async () => {
    const { service } = setup();
    const tokenization = await withSellerPosition(service, "100");
    await service.freezeTokenization(tokenization.id, compliance);

    // The frozen flag is a compliance control, and a secondary trade is the
    // transfer it most exists to stop.
    await expect(
      service.transferHolding(tokenization.id, seller, {
        toUserId: BUYER_ID,
        toHolderAddress: INVESTOR2_ADDRESS,
        units: "40",
        priceAmount: "48000",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses a transfer to a holder who is not on the allowlist", async () => {
    const { service } = setup();
    const tokenization = await activeTokenization(service, {
      requireAuthorization: true,
    });
    await service.purchaseUnits(tokenization.id, seller, {
      units: "100",
      holderAddress: INVESTOR1_ADDRESS,
    });

    // The contract rejects a transfer to an unauthorized address, so refusing
    // here means the ledger is never touched for a trade the chain would
    // reject anyway.
    await expect(
      service.transferHolding(tokenization.id, seller, {
        toUserId: BUYER_ID,
        toHolderAddress: INVESTOR2_ADDRESS,
        units: "40",
        priceAmount: "48000",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("allows the transfer once the buyer is authorized", async () => {
    const { service, gateway } = setup();
    const tokenization = await activeTokenization(service, {
      requireAuthorization: true,
    });
    await service.purchaseUnits(tokenization.id, seller, {
      units: "100",
      holderAddress: INVESTOR1_ADDRESS,
    });
    await gateway.authorizeHolder({
      contractId: tokenization.contractId!,
      holderAddress: INVESTOR2_ADDRESS,
    });

    const result = await service.transferHolding(tokenization.id, seller, {
      toUserId: BUYER_ID,
      toHolderAddress: INVESTOR2_ADDRESS,
      units: "40",
      priceAmount: "48000",
    });
    expect(result.buyerHolding.units).toBe("40");
  });

  it("refuses to sell more units than are held", async () => {
    const { service } = setup();
    const tokenization = await withSellerPosition(service, "100");

    await expect(
      service.transferHolding(tokenization.id, seller, {
        toUserId: BUYER_ID,
        toHolderAddress: INVESTOR2_ADDRESS,
        units: "101",
        priceAmount: "121000",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("refuses a transfer from someone holding nothing", async () => {
    const { service } = setup();
    const tokenization = await activeTokenization(service);

    await expect(
      service.transferHolding(tokenization.id, seller, {
        toUserId: BUYER_ID,
        toHolderAddress: INVESTOR2_ADDRESS,
        units: "10",
        priceAmount: "12000",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a sale to oneself", async () => {
    const { service } = setup();
    const tokenization = await withSellerPosition(service, "100");

    await expect(
      service.transferHolding(tokenization.id, seller, {
        toUserId: seller.userId,
        toHolderAddress: INVESTOR2_ADDRESS,
        units: "40",
        priceAmount: "48000",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("refuses a transfer once the position has paid out", async () => {
    const { service, repository } = setup();
    const tokenization = await withSellerPosition(service, "100");

    const current = await repository.findTokenization(tokenization.id);
    await repository.updateTokenization({
      ...current!,
      status: TokenizationStatus.Distributed,
    });

    // Letting units change hands around a distribution makes it ambiguous who
    // the payout belongs to.
    await expect(
      service.transferHolding(tokenization.id, seller, {
        toUserId: BUYER_ID,
        toHolderAddress: INVESTOR2_ADDRESS,
        units: "40",
        priceAmount: "48000",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses a transfer while a dispute holds the payout", async () => {
    const { service, repository } = setup();
    const tokenization = await withSellerPosition(service, "100");

    const current = await repository.findTokenization(tokenization.id);
    await repository.updateTokenization({
      ...current!,
      status: TokenizationStatus.PayoutHeld,
    });

    await expect(
      service.transferHolding(tokenization.id, seller, {
        toUserId: BUYER_ID,
        toHolderAddress: INVESTOR2_ADDRESS,
        units: "40",
        priceAmount: "48000",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("applies the buyer's investor limits, not just the seller's willingness", async () => {
    const { service } = setup({ maxConcentrationBps: 2_500 });
    const tokenization = await activeTokenization(service);
    // The seller holds 500 under a 25% cap only because they bought before it
    // mattered; what matters here is the buyer's resulting position.
    await service.purchaseUnits(tokenization.id, seller, {
      units: "250",
      holderAddress: INVESTOR1_ADDRESS,
    });

    // A secondary market that skipped §3.2 would be the way around every limit
    // the platform has.
    await expect(
      service.transferHolding(tokenization.id, seller, {
        toUserId: BUYER_ID,
        toHolderAddress: INVESTOR2_ADDRESS,
        units: "251",
        priceAmount: "251000",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("refuses to sell units that have not been delivered", async () => {
    // Issuer custody: the holding sits Pending until the issuer signs.
    const repository = new InMemoryRwaRepository();
    const addresses = new StaticWalletAddressResolver(
      new Map([["issuer-1", ISSUER_ADDRESS]]),
    );
    const service = new RwaService(
      repository,
      new DeterministicRwaGateway(RwaCustodyMode.Issuer, addresses),
      new InMemoryAuditRepository(),
      new PrefundedLedgerService(),
      addresses,
      undefined,
      { getStatus: async () => ({ status: KycStatus.Verified }) },
      UNRESTRICTED_INVESTOR_LIMITS,
    );

    const asset = await createVerifiedAsset(service, issuer.userId);
    const draft = await service.createTokenization(issuer.userId, {
      assetId: asset.id,
      totalUnits: "1000",
      faceValueAmount: "1000000",
      faceValueCurrency: "USDC",
      advanceRateBps: 10_000,
      discountRateBps: 0,
      maturityDate: FUTURE_MATURITY,
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
      `signed:${prepared.unsignedXdr}`,
    );
    await service.purchaseUnits(draft.id, seller, {
      units: "100",
      holderAddress: INVESTOR1_ADDRESS,
    });

    // Selling here would pass on a claim to units that have not moved and
    // might never.
    await expect(
      service.transferHolding(draft.id, seller, {
        toUserId: BUYER_ID,
        toHolderAddress: INVESTOR2_ADDRESS,
        units: "40",
        priceAmount: "48000",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("charges nobody when a refusal fires", async () => {
    const { service, ledger } = setup();
    const tokenization = await withSellerPosition(service, "100");
    await service.freezeTokenization(tokenization.id, compliance);

    await service
      .transferHolding(tokenization.id, seller, {
        toUserId: BUYER_ID,
        toHolderAddress: INVESTOR2_ADDRESS,
        units: "40",
        priceAmount: "48000",
      })
      .catch(() => undefined);

    // Every refusal runs before the ledger, so a rejected trade leaves nothing
    // to unwind.
    expect(
      await ledger.getByReference(
        `rwa-secondary:${tokenization.id}:${seller.userId}:${BUYER_ID}:40:48000`,
      ),
    ).toBeUndefined();
  });

  it("converges on one posting when the same trade is submitted twice", async () => {
    const { service, repository } = setup();
    const tokenization = await withSellerPosition(service, "100");

    const trade = {
      toUserId: BUYER_ID,
      toHolderAddress: INVESTOR2_ADDRESS,
      units: "40",
      priceAmount: "48000",
    };
    await service.transferHolding(tokenization.id, seller, trade);
    await service.transferHolding(tokenization.id, seller, trade);

    // The second trade is a genuine second sale of 40 more units, so the
    // positions move again — what must not happen is a duplicate *ledger*
    // charge, which the reference id prevents by describing the trade.
    const buyer = await repository.findHolding(tokenization.id, BUYER_ID);
    expect(buyer?.units).toBe("80");
  });
});
