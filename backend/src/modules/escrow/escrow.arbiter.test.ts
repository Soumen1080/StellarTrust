/**
 * Settlement authority can live outside this server.
 *
 * `ESCROW_ARBITER_ADDRESS` exists so that release and refund can require a key
 * no single compromised process holds — a multi-sig, or a key on separate
 * hardware. The escrow contract enforces that with `arbiter.require_auth()`.
 *
 * The consequence has to be honoured everywhere, not just at the contract
 * boundary: `release`/`refund` become a prepare → sign → submit round trip, the
 * single-call path must refuse them, and dispute auto-settlement must stop and
 * hand the resolution to a human rather than failing silently or — worse —
 * recording a settlement the chain never performed.
 */
import {
  ChainSigningMode,
  ChainTxStatus,
  DisputeResolution,
  EscrowState,
  OrderStatus,
  PaymentTransition,
  type ChainSigningMode as ChainSigningModeType,
} from "@stellartrust/shared";
import { describe, expect, it } from "vitest";
import { InMemoryAuditRepository } from "../audit/audit.repository.js";
import { InMemoryPaymentRepository } from "../payments/payment.repository.js";
import { PaymentService } from "../payments/payment.service.js";
import {
  DeterministicEscrowGateway,
  type ChainReceipt,
  type ChainTransitionInput,
  type EscrowGateway,
  type PreparedTransition,
} from "./escrow.gateway.js";

const buyer = { userId: "buyer-1", roles: ["user"] };
const seller = { userId: "seller-1", roles: ["user"] };
const compliance = { userId: "compliance-1", roles: ["compliance"] };

const ARBITER = "GAXQGZPUJ4H2ORHVJHUOL7YKJKGCHXKZDCPBAJ2RTQMDGAV7MYPPZRAH";

/**
 * A gateway whose arbiter is an account it holds no key for.
 *
 * Mirrors `SorobanRpcEscrowGateway` under an external `ESCROW_ARBITER_ADDRESS`:
 * release and refund move to the wallet path, the single-call path refuses
 * them, and a "signed" envelope is what actually applies the state change.
 */
class ExternalArbiterGateway implements EscrowGateway {
  readonly prepared: PreparedTransition[] = [];

  constructor(private readonly inner: DeterministicEscrowGateway) {}

  async signingMode(
    transition: PaymentTransition,
  ): Promise<ChainSigningModeType> {
    if (
      transition === PaymentTransition.Release ||
      transition === PaymentTransition.Refund
    ) {
      return ChainSigningMode.Wallet;
    }
    return this.inner.signingMode(transition);
  }

  async prepareTransition(
    input: ChainTransitionInput,
  ): Promise<PreparedTransition> {
    if ((await this.signingMode(input.transition)) !== ChainSigningMode.Wallet) {
      throw new Error("not a wallet transition");
    }
    const prepared: PreparedTransition = {
      orderId: input.orderId,
      transition: input.transition,
      unsignedXdr: `unsigned:${input.orderId}:${input.transition}`,
      networkPassphrase: "Test SDF Network ; September 2015",
      // The contract demands the arbiter's authorization, so the arbiter's
      // account is the transaction source and therefore the signer.
      signerAddress: ARBITER,
      contractId: input.contractId ?? "",
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
    this.prepared.push(prepared);
    return prepared;
  }

  async submitSignedTransition(
    input: ChainTransitionInput,
    signedXdr: string,
  ): Promise<ChainReceipt> {
    if (!signedXdr.startsWith("signed:")) {
      throw new Error("envelope is not signed");
    }
    // The arbiter's signature is what the contract accepts, so applying it
    // locally goes through the same arbiter path the deployed contract takes.
    return this.inner.submitTransition({ ...input, arbiter: true });
  }

  async submitTransition(input: ChainTransitionInput): Promise<ChainReceipt> {
    if ((await this.signingMode(input.transition)) === ChainSigningMode.Wallet) {
      throw new Error(
        `The '${input.transition}' transition must be signed by the arbiter account`,
      );
    }
    return this.inner.submitTransition(input);
  }

  getTransaction(hash: string) {
    return this.inner.getTransaction(hash);
  }
  getEscrowState(contractId: string) {
    return this.inner.getEscrowState(contractId);
  }
  getEscrowSnapshot(contractId: string) {
    return this.inner.getEscrowSnapshot(contractId);
  }
}

function setup() {
  const repository = new InMemoryPaymentRepository();
  const inner = new DeterministicEscrowGateway();
  const gateway = new ExternalArbiterGateway(inner);
  const service = new PaymentService(
    repository,
    gateway,
    new InMemoryAuditRepository(),
  );
  return { repository, inner, gateway, service };
}

/** Drive an order to Confirmed, the happy-path release point. */
async function confirmedOrder() {
  const context = setup();
  const created = await context.service.createOrder(buyer.userId, {
    sellerId: seller.userId,
    amount: { amount: "12500", currency: "USDC" },
  });
  const id = created.order.id;
  await context.service.transition(id, PaymentTransition.Accept, seller);
  await context.service.transition(id, PaymentTransition.Deposit, buyer);
  const locked = await context.service.transition(id, PaymentTransition.Lock, buyer);
  await context.service.transition(id, PaymentTransition.Confirm, buyer);
  return { ...context, id, contractId: locked.escrow?.contractId ?? "" };
}

describe("external arbiter changes who signs settlement", () => {
  it("advertises release and refund as wallet-signed", async () => {
    const { service } = setup();
    const capabilities = await service.capabilities();

    expect(capabilities.walletSignedTransitions).toEqual(
      expect.arrayContaining([
        PaymentTransition.Release,
        PaymentTransition.Refund,
      ]),
    );
    expect(capabilities.signingModes[PaymentTransition.Release]).toBe(
      ChainSigningMode.Wallet,
    );
  });

  it("refuses the single-call release and names the route that works", async () => {
    const { service, id } = await confirmedOrder();

    await expect(
      service.transition(id, PaymentTransition.Release, buyer),
    ).rejects.toThrow(/must be signed by your wallet/);
  });

  it("prepares a release for the arbiter's account to sign", async () => {
    const { service, id, contractId } = await confirmedOrder();

    const prepared = await service.prepareTransition(
      id,
      PaymentTransition.Release,
      buyer,
    );

    expect(prepared.signerAddress).toBe(ARBITER);
    expect(prepared.contractId).toBe(contractId);
    expect(prepared.transition).toBe(PaymentTransition.Release);
  });

  it("settles the happy path once the signed envelope comes back", async () => {
    const { service, inner, id, contractId } = await confirmedOrder();
    await service.prepareTransition(id, PaymentTransition.Release, buyer);

    const result = await service.submitSignedTransition(
      id,
      PaymentTransition.Release,
      buyer,
      "signed:release",
    );

    expect("order" in result && result.order.status).toBe(OrderStatus.Released);
    expect(await inner.getEscrowState(contractId)).toBe(EscrowState.Released);
  });

  it("lets compliance drive the settlement it holds the key for", async () => {
    // The buyer asks for a release; the arbiter key is operated by compliance,
    // who must be able to assemble the transaction to carry it to the signers.
    const { service, id } = await confirmedOrder();

    const prepared = await service.prepareTransition(
      id,
      PaymentTransition.Release,
      compliance,
    );

    expect(prepared.signerAddress).toBe(ARBITER);
  });

  it("still refuses a stranger", async () => {
    const { service, id } = await confirmedOrder();
    await expect(
      service.prepareTransition(id, PaymentTransition.Release, {
        userId: "stranger-1",
        roles: ["user"],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("dispute settlement under an external arbiter", () => {
  it("stops and hands the resolution to the key holders", async () => {
    const { service, id } = await confirmedOrder();
    await service.raiseDispute(id, buyer);

    // The dispute record is the authorization; it is not a signing key. An
    // auto-executed settlement here would either fail on-chain or, if the
    // ledger moved first, claim a settlement that never happened.
    await expect(
      service.settleDisputedOrder(id, DisputeResolution.Release, compliance),
    ).rejects.toThrow(/collect the required signatures/);
  });

  it("settles a disputed escrow through prepare and submit", async () => {
    const { service, inner, id, contractId } = await confirmedOrder();
    await service.raiseDispute(id, buyer);

    const prepared = await service.prepareTransition(
      id,
      PaymentTransition.Release,
      compliance,
    );
    expect(prepared.signerAddress).toBe(ARBITER);

    const result = await service.submitSignedTransition(
      id,
      PaymentTransition.Release,
      compliance,
      "signed:release",
    );

    expect("order" in result && result.order.status).toBe(OrderStatus.Released);
    expect(await inner.getEscrowState(contractId)).toBe(EscrowState.Released);
  });

  it("posts the dispute-settlement legs, not the happy-path ones", async () => {
    // Releasing a disputed escrow must not reverse delivery-confirmation
    // entries: on this path they never posted.
    const { service, repository, id } = await confirmedOrder();
    await service.raiseDispute(id, buyer);
    await service.prepareTransition(id, PaymentTransition.Release, compliance);
    await service.submitSignedTransition(
      id,
      PaymentTransition.Release,
      compliance,
      "signed:release",
    );

    const transitions = await repository.listTransitions(id);
    const release = transitions.find(
      (t) => t.transition === PaymentTransition.Release,
    );
    expect(release?.ledgerTransaction.referenceId).toBe(
      `dispute-settle:${id}:release`,
    );
    expect(release?.ledgerTransaction.entries).toHaveLength(2);
    expect(release?.stellarTransaction.status).toBe(ChainTxStatus.Success);
  });

  it("refunds a disputed escrow the same way", async () => {
    const { service, inner, id, contractId } = await confirmedOrder();
    await service.raiseDispute(id, buyer);

    await service.prepareTransition(id, PaymentTransition.Refund, compliance);
    const result = await service.submitSignedTransition(
      id,
      PaymentTransition.Refund,
      compliance,
      "signed:refund",
    );

    expect("order" in result && result.order.status).toBe(OrderStatus.Refunded);
    expect(await inner.getEscrowState(contractId)).toBe(EscrowState.Refunded);
  });
});
