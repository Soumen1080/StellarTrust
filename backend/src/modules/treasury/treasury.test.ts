/**
 * Treasury — deposits and withdrawals against real Stellar payments
 * (plane.md §4.5).
 *
 * The claims worth proving here are the ones that stop money being invented:
 *   - a deposit credits what the *chain* says arrived, never what the user says
 *   - a transaction can be credited once
 *   - only the wallet the user proved at SEP-10 can fund their balance
 *   - a failed withdrawal gives the money back
 *
 * The amount conversion gets its own block because a silent factor-of-10^5
 * between Horizon's stroops and the ledger's minor units is the defect that
 * would move the wrong quantity of real value while every test still passed.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { type CurrencyCode } from "@stellartrust/shared";
import { InMemoryAuditRepository } from "../audit/audit.repository.js";
import { InMemoryLedgerRepository } from "../ledger/ledger.repository.js";
import { LedgerService } from "../ledger/ledger.service.js";
import { DeterministicTreasuryGateway } from "./treasury.gateway.js";
import { InMemoryTreasuryRepository } from "./treasury.repository.js";
import { TreasuryService, type TreasuryActor } from "./treasury.service.js";
import { TreasuryDirection, TreasuryStatus } from "./treasury.types.js";

const USDC = "USDC" as CurrencyCode;
const XLM = "XLM" as CurrencyCode;

const TREASURY = "GTREASURYADDRESSFORTESTSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const USER_WALLET = "GDYWVMFH5JDIISEZMLDFTN6A5NHPLZGKTTYAAKGB5Z6U7MHKUV6JPVS5";
const OTHER_WALLET = "GBNPF7BZKNCAS32XWOBWGL7KD6NFHLZO5GQDIJA7Z73B7YISNM4MFZNL";

const user: TreasuryActor = { userId: "user-1", roles: ["user"] };
const compliance: TreasuryActor = {
  userId: "officer-1",
  roles: ["user", "compliance"],
};

/** A realistic 64-hex Stellar transaction hash. */
function hash(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

function setup(options?: {
  withdrawalAutoMaxMinor?: bigint;
  minDepositMinor?: bigint;
  /** The address the user proved at SEP-10. */
  userWallet?: string;
}) {
  const gateway = new DeterministicTreasuryGateway(TREASURY);
  const ledger = new LedgerService(new InMemoryLedgerRepository());
  const repository = new InMemoryTreasuryRepository();
  const audit = new InMemoryAuditRepository();
  const service = new TreasuryService(
    repository,
    gateway,
    ledger,
    { resolve: async () => options?.userWallet ?? USER_WALLET },
    audit,
    {
      minDepositMinor: options?.minDepositMinor ?? 1n,
      withdrawalAutoMaxMinor: options?.withdrawalAutoMaxMinor ?? 0n,
    },
  );
  return { service, gateway, ledger, repository, audit };
}

describe("a deposit credits what the chain says arrived", () => {
  let harness: ReturnType<typeof setup>;
  beforeEach(() => {
    harness = setup();
  });

  it("credits the user's ledger balance for the payment they made", async () => {
    const txHash = hash("a");
    harness.gateway.declarePayment({
      txHash,
      from: USER_WALLET,
      to: TREASURY,
      assetCode: "USDC",
      amount: "125.5000000",
    });

    const movement = await harness.service.claimDeposit(user, {
      stellarTxHash: txHash,
    });

    expect(movement.status).toBe(TreasuryStatus.Completed);
    // USDC is 2 decimals in the ledger: 125.50 → 12550 minor units.
    expect(movement.amount).toBe("12550");
    expect(await harness.ledger.getUserBalance(user.userId, USDC)).toBe(12_550n);
  });

  it("posts a balanced transaction keyed on the transaction hash", async () => {
    const txHash = hash("b");
    harness.gateway.declarePayment({
      txHash,
      from: USER_WALLET,
      assetCode: "USDC",
      amount: "10.0000000",
    });
    await harness.service.claimDeposit(user, { stellarTxHash: txHash });

    // Keyed on the hash, so the ledger's own uniqueness constraint is a second
    // independent guard against crediting one payment twice.
    const posted = await harness.ledger.getByReference(
      `treasury-deposit:${txHash}`,
    );
    expect(posted).toBeDefined();
    expect(posted!.entries).toHaveLength(2);
  });

  it("sums two payments to the platform in one transaction", async () => {
    const txHash = hash("c");
    harness.gateway.declarePayment({
      txHash,
      from: USER_WALLET,
      assetCode: "USDC",
      amount: "10.0000000",
    });
    harness.gateway.declarePayment({
      txHash,
      from: USER_WALLET,
      assetCode: "USDC",
      amount: "5.0000000",
    });

    const movement = await harness.service.claimDeposit(user, {
      stellarTxHash: txHash,
    });
    expect(movement.amount).toBe("1500");
  });

  it("ignores legs of the transaction that paid someone else", async () => {
    const txHash = hash("d");
    harness.gateway.declarePayment({
      txHash,
      from: USER_WALLET,
      to: TREASURY,
      assetCode: "USDC",
      amount: "10.0000000",
    });
    harness.gateway.declarePayment({
      txHash,
      from: USER_WALLET,
      to: OTHER_WALLET,
      assetCode: "USDC",
      amount: "999.0000000",
    });

    const movement = await harness.service.claimDeposit(user, {
      stellarTxHash: txHash,
    });
    expect(movement.amount).toBe("1000");
  });
});

describe("a deposit is refused when it should be", () => {
  it("refuses a hash that names nothing on this network", async () => {
    const { service } = setup();
    await expect(
      service.claimDeposit(user, { stellarTxHash: hash("e") }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a failed transaction, which moved nothing", async () => {
    const { service, gateway } = setup();
    const txHash = hash("f");
    gateway.declarePayment({
      txHash,
      from: USER_WALLET,
      amount: "10.0000000",
      successful: false,
    });
    await expect(
      service.claimDeposit(user, { stellarTxHash: txHash }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a payment that went somewhere other than the treasury", async () => {
    const { service, gateway } = setup();
    const txHash = hash("1");
    gateway.declarePayment({
      txHash,
      from: USER_WALLET,
      to: OTHER_WALLET,
      amount: "10.0000000",
    });
    await expect(
      service.claimDeposit(user, { stellarTxHash: txHash }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses a payment sent from someone else's wallet", async () => {
    // The acceptance condition: without this, anyone could claim anyone's
    // payment simply by pasting the hash first.
    const { service, gateway, ledger } = setup();
    const txHash = hash("2");
    gateway.declarePayment({
      txHash,
      from: OTHER_WALLET,
      to: TREASURY,
      amount: "10.0000000",
    });
    await expect(
      service.claimDeposit(user, { stellarTxHash: txHash }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await ledger.getUserBalance(user.userId, XLM)).toBe(0n);
  });

  it("refuses a second claim on a transaction already credited", async () => {
    const { service, gateway, ledger } = setup();
    const txHash = hash("3");
    gateway.declarePayment({
      txHash,
      from: USER_WALLET,
      assetCode: "USDC",
      amount: "10.0000000",
    });

    await service.claimDeposit(user, { stellarTxHash: txHash });
    await expect(
      service.claimDeposit(user, { stellarTxHash: txHash }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // The balance moved once, which is the whole point of the refusal.
    expect(await ledger.getUserBalance(user.userId, USDC)).toBe(1_000n);
  });

  it("refuses a malformed hash before reading the chain", async () => {
    const { service } = setup();
    await expect(
      service.claimDeposit(user, { stellarTxHash: "not-a-hash" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("refuses a deposit below the configured minimum", async () => {
    const { service, gateway } = setup({ minDepositMinor: 1_000n });
    const txHash = hash("4");
    gateway.declarePayment({
      txHash,
      from: USER_WALLET,
      assetCode: "USDC",
      amount: "1.0000000",
    });
    await expect(
      service.claimDeposit(user, { stellarTxHash: txHash }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("refuses a mixed-asset transaction rather than guessing", async () => {
    const { service, gateway } = setup();
    const txHash = hash("5");
    gateway.declarePayment({
      txHash,
      from: USER_WALLET,
      assetCode: "USDC",
      amount: "10.0000000",
    });
    gateway.declarePayment({
      txHash,
      from: USER_WALLET,
      assetCode: "XLM",
      amount: "10.0000000",
    });
    await expect(
      service.claimDeposit(user, { stellarTxHash: txHash }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("Horizon decimals convert to ledger minor units exactly", () => {
  it("treats XLM at full stroop precision", async () => {
    // XLM is 7 decimals in the ledger too, so a stroop survives the trip. If
    // this ever reads 10000000 for 1.0000001 XLM, real value is being rounded
    // away one deposit at a time.
    const { service, gateway } = setup();
    const txHash = hash("6");
    gateway.declarePayment({
      txHash,
      from: USER_WALLET,
      assetCode: "XLM",
      amount: "1.0000001",
    });
    const movement = await service.claimDeposit(user, {
      stellarTxHash: txHash,
    });
    expect(movement.amount).toBe("10000001");
  });

  it("refuses USDC precision the ledger cannot record rather than rounding it away", async () => {
    // Rounding a deposit down is quietly keeping the difference.
    const { service, gateway } = setup();
    const txHash = hash("7");
    gateway.declarePayment({
      txHash,
      from: USER_WALLET,
      assetCode: "USDC",
      amount: "10.0000001",
    });
    await expect(
      service.claimDeposit(user, { stellarTxHash: txHash }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("converts a whole-number XLM payment without drift", async () => {
    const { service, gateway } = setup();
    const txHash = hash("8");
    gateway.declarePayment({
      txHash,
      from: USER_WALLET,
      assetCode: "XLM",
      amount: "100.0000000",
    });
    const movement = await service.claimDeposit(user, {
      stellarTxHash: txHash,
    });
    expect(movement.amount).toBe("1000000000");
  });
});

describe("a withdrawal moves value out", () => {
  async function fundedHarness() {
    const harness = setup();
    const txHash = hash("9");
    harness.gateway.declarePayment({
      txHash,
      from: USER_WALLET,
      assetCode: "XLM",
      amount: "100.0000000",
    });
    await harness.service.claimDeposit(user, { stellarTxHash: txHash });
    return harness;
  }

  it("debits the balance and sends the payment", async () => {
    const { service, gateway, ledger } = await fundedHarness();

    const movement = await service.withdraw(user, {
      amount: "250000000", // 25 XLM
      currency: XLM,
    });

    expect(movement.status).toBe(TreasuryStatus.Completed);
    expect(movement.stellarTxHash).toBeTruthy();
    expect(await ledger.getUserBalance(user.userId, XLM)).toBe(750_000_000n);

    // The chain was asked for the right quantity in the right units — the
    // conversion back out is as load-bearing as the one on the way in.
    expect(gateway.sentPayments()).toEqual([
      expect.objectContaining({
        destination: USER_WALLET,
        amount: "25.0000000",
        assetCode: "XLM",
      }),
    ]);
  });

  it("refuses a withdrawal larger than the balance", async () => {
    const { service, gateway } = await fundedHarness();
    await expect(
      service.withdraw(user, { amount: "2000000000", currency: XLM }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    // Nothing was sent, because the check runs before anything is written.
    expect(gateway.sentPayments()).toHaveLength(0);
  });

  it("gives the money back when the payment cannot be submitted", async () => {
    const { service, gateway, ledger } = await fundedHarness();
    gateway.sendPayment = async () => {
      throw new Error("horizon is down");
    };

    await expect(
      service.withdraw(user, { amount: "250000000", currency: XLM }),
    ).rejects.toThrow();

    // Debited then reversed: the two postings net to zero, so the user is
    // whole. A user left debited for a payment that never went out is the one
    // outcome this path must not produce.
    expect(await ledger.getUserBalance(user.userId, XLM)).toBe(1_000_000_000n);
  });

  it("records the failure rather than losing the attempt", async () => {
    const { service, gateway, repository } = await fundedHarness();
    gateway.sendPayment = async () => {
      throw new Error("horizon is down");
    };
    await service
      .withdraw(user, { amount: "250000000", currency: XLM })
      .catch(() => undefined);

    // The deposit that funded the harness is also a movement, so pick the
    // withdrawal explicitly rather than trusting the ordering.
    const movements = await repository.listForUser(user.userId);
    const withdrawal = movements.find(
      (movement) => movement.direction === TreasuryDirection.Withdrawal,
    );
    expect(withdrawal).toMatchObject({
      status: TreasuryStatus.Failed,
      failureReason: expect.any(String),
    });
  });

  it("sends to an explicitly named destination when one is given", async () => {
    const { service, gateway } = await fundedHarness();
    await service.withdraw(user, {
      amount: "100000000",
      currency: XLM,
      destinationAddress: OTHER_WALLET,
    });
    expect(gateway.sentPayments()[0]?.destination).toBe(OTHER_WALLET);
  });

  it("refuses a destination that is not a Stellar address", async () => {
    const { service } = await fundedHarness();
    await expect(
      service.withdraw(user, {
        amount: "100000000",
        currency: XLM,
        destinationAddress: "not-an-address",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("a large withdrawal is a decision, not a transfer", () => {
  async function harnessWithCeiling() {
    const harness = setup({ withdrawalAutoMaxMinor: 100_000_000n });
    const txHash = hash("0");
    harness.gateway.declarePayment({
      txHash,
      from: USER_WALLET,
      assetCode: "XLM",
      amount: "100.0000000",
    });
    await harness.service.claimDeposit(user, { stellarTxHash: txHash });
    return harness;
  }

  it("pays out automatically at the ceiling", async () => {
    const { service, gateway } = await harnessWithCeiling();
    const movement = await service.withdraw(user, {
      amount: "100000000",
      currency: XLM,
    });
    expect(movement.status).toBe(TreasuryStatus.Completed);
    expect(gateway.sentPayments()).toHaveLength(1);
  });

  it("holds one minor unit above the ceiling for review", async () => {
    const { service, gateway, ledger } = await harnessWithCeiling();
    const movement = await service.withdraw(user, {
      amount: "100000001",
      currency: XLM,
    });

    expect(movement.status).toBe(TreasuryStatus.Pending);
    expect(gateway.sentPayments()).toHaveLength(0);
    // Nothing is debited while it waits — the hold is not a charge.
    expect(await ledger.getUserBalance(user.userId, XLM)).toBe(1_000_000_000n);
  });

  it("pays a held withdrawal once compliance releases it", async () => {
    const { service, gateway, ledger } = await harnessWithCeiling();
    const held = await service.withdraw(user, {
      amount: "100000001",
      currency: XLM,
    });

    const released = await service.approveWithdrawal(held.id, compliance);
    expect(released.status).toBe(TreasuryStatus.Completed);
    expect(gateway.sentPayments()).toHaveLength(1);
    expect(await ledger.getUserBalance(user.userId, XLM)).toBe(899_999_999n);
  });

  it("refuses to release a held withdrawal without the compliance role", async () => {
    const { service } = await harnessWithCeiling();
    const held = await service.withdraw(user, {
      amount: "100000001",
      currency: XLM,
    });
    await expect(
      service.approveWithdrawal(held.id, user),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses a held withdrawal the user can no longer afford", async () => {
    // The hold may last a while, and the money may be gone by the time it is
    // released. Re-checking is the difference between a queue and an overdraft.
    const { service, ledger } = await harnessWithCeiling();
    const held = await service.withdraw(user, {
      amount: "100000001",
      currency: XLM,
    });
    // Spend it elsewhere in the meantime, in instalments that each stay under
    // the ceiling so they pay out immediately rather than queueing behind the
    // same review.
    for (let i = 0; i < 10; i += 1) {
      await service.withdraw(user, { amount: "95000000", currency: XLM });
    }
    expect(await ledger.getUserBalance(user.userId, XLM)).toBe(50_000_000n);

    await expect(
      service.approveWithdrawal(held.id, compliance),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("closes a refused withdrawal with a stated reason", async () => {
    const { service } = await harnessWithCeiling();
    const held = await service.withdraw(user, {
      amount: "100000001",
      currency: XLM,
    });
    const rejected = await service.rejectWithdrawal(
      held.id,
      compliance,
      "Source of funds unclear",
    );
    expect(rejected).toMatchObject({
      status: TreasuryStatus.Failed,
      failureReason: "Source of funds unclear",
    });
  });

  it("refuses to close a withdrawal without a reason", async () => {
    const { service } = await harnessWithCeiling();
    const held = await service.withdraw(user, {
      amount: "100000001",
      currency: XLM,
    });
    await expect(
      service.rejectWithdrawal(held.id, compliance, "  "),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
