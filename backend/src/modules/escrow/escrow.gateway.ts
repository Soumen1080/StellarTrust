/**
 * Soroban boundary for the escrow contract.
 *
 * Two adapters implement one interface:
 *   - {@link DeterministicEscrowGateway} — in-memory, no keys, no network. It
 *     mirrors the Rust state machine exactly (including the rule that an
 *     arbiter may only settle an unconfirmed escrow once it is Disputed) so a
 *     green test suite means something about the deployed contract.
 *   - {@link SorobanRpcEscrowGateway} — real transactions against a deployed
 *     contract.
 *
 * Signing is split by who the contract demands authorization from. `release`
 * and `refund` call `arbiter.require_auth()`, and the arbiter is the server, so
 * those are one server-signed call. `initialize`, `confirm_delivery`, and
 * `dispute` demand a *counterparty's* signature, which the server cannot
 * produce: those go through prepare → wallet sign → submit, with the party's
 * own account as the transaction source so a single envelope signature
 * satisfies the contract's `require_auth()`.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  ChainSigningMode,
  ChainTxStatus,
  EscrowState,
  PaymentTransition,
  type CurrencyCode,
} from "@stellartrust/shared";
import { ChainError, ConflictError } from "../../lib/errors.js";
import { config } from "../../config/index.js";
import { logger } from "../../lib/logger.js";
import { createSigner, type Signer } from "../stellar/signer.js";
import { networkPassphrase } from "../stellar/stellar.client.js";
import { resolveToken, toTokenAmount } from "../stellar/asset.js";
import {
  deployFromWasmHash,
  getContractClient,
  getTransactionStatus,
  getUnsignedContractClient,
  submitSignedTransaction,
  toUnsignedTransaction,
  type ContractResult,
  type ContractTx,
} from "../stellar/soroban.client.js";
import type { EscrowAddressResolver } from "./escrow.addresses.js";

export interface ChainTransitionInput {
  orderId: string;
  transition: PaymentTransition;
  amount: string;
  currency: CurrencyCode;
  buyerId: string;
  sellerId: string;
  contractId: string | null;
  /**
   * Arbiter authority (compliance/dispute resolution). When true, a release may
   * settle an escrow the buyer never confirmed — but only after the escrow has
   * been moved to `Disputed`, which is exactly what the contract requires.
   */
  arbiter?: boolean;
  /** Party acting, for wallet-signed transitions. Defaults to the buyer. */
  actorUserId?: string;
}

export interface ChainReceipt {
  hash: string;
  type: string;
  status: ChainTxStatus;
  contractId: string | null;
  orderId: string;
  transition: PaymentTransition;
  amount: string;
  currency: CurrencyCode;
}

/** What the chain can tell us about a transaction we previously submitted. */
export interface ChainTxObservation {
  hash: string;
  status: ChainTxStatus;
  /**
   * Order/transition attribution, present only for adapters that keep their own
   * receipts. A public ledger does not record our internal ids, so the
   * Soroban adapter leaves these unset and reconciliation falls back to
   * asserting escrow *state* — see {@link EscrowGateway.getEscrowSnapshot}.
   */
  orderId?: string;
  transition?: PaymentTransition;
}

/** On-chain custody state, read back for reconciliation. */
export interface EscrowSnapshot {
  state: EscrowState;
  /** The order this custody instance was initialized for, per the contract. */
  orderId: string | null;
  deliveryConfirmed: boolean;
}

/** An unsigned transaction handed to a party's wallet. */
export interface PreparedTransition {
  orderId: string;
  transition: PaymentTransition;
  unsignedXdr: string;
  networkPassphrase: string;
  signerAddress: string;
  contractId: string;
  expiresAt: string;
}

export interface EscrowGateway {
  /** Who must sign this transition in the current deployment. */
  signingMode(transition: PaymentTransition): ChainSigningMode;
  /** Execute a server-signable transition end to end. */
  submitTransition(input: ChainTransitionInput): Promise<ChainReceipt>;
  /**
   * Deploy custody if needed and build the unsigned transaction the acting
   * party must sign. Returns the contract id so the caller can persist it
   * before the round trip — an abandoned signature then costs one idle
   * contract, not one per retry.
   */
  prepareTransition(input: ChainTransitionInput): Promise<PreparedTransition>;
  /** Submit a wallet-signed envelope and report the settled outcome. */
  submitSignedTransition(
    input: ChainTransitionInput,
    signedXdr: string,
  ): Promise<ChainReceipt>;
  getTransaction(hash: string): Promise<ChainTxObservation | undefined>;
  getEscrowState(contractId: string): Promise<EscrowState | undefined>;
  getEscrowSnapshot(contractId: string): Promise<EscrowSnapshot | undefined>;
}

/** Transitions the escrow contract gates with a counterparty's own signature. */
const WALLET_SIGNED: readonly PaymentTransition[] = [
  PaymentTransition.Lock,
  PaymentTransition.Confirm,
  PaymentTransition.Dispute,
];

/** Transitions the arbiter (this server) signs. */
const SERVER_SIGNED: readonly PaymentTransition[] = [
  PaymentTransition.Release,
  PaymentTransition.Refund,
];

/** Bookkeeping-only transitions with no chain counterpart. */
function touchesChain(transition: PaymentTransition): boolean {
  return (
    WALLET_SIGNED.includes(transition) || SERVER_SIGNED.includes(transition)
  );
}

interface ContractSnapshot {
  state: EscrowState;
  orderId: string;
  deliveryConfirmed: boolean;
}

/**
 * Deterministic local/test adapter. Enforces the same lock/confirm/dispute/
 * release/refund state machine as the Rust contract without holding a signing
 * key or touching the network.
 */
export class DeterministicEscrowGateway implements EscrowGateway {
  private readonly transactions = new Map<string, ChainReceipt>();
  private readonly contracts = new Map<string, ContractSnapshot>();

  /**
   * Everything is server-driven here: there is no wallet and no `require_auth`
   * to satisfy, so tests and local development keep the single-call flow.
   */
  signingMode(transition: PaymentTransition): ChainSigningMode {
    return touchesChain(transition)
      ? ChainSigningMode.Server
      : ChainSigningMode.None;
  }

  async prepareTransition(): Promise<PreparedTransition> {
    throw new ChainError(
      "The deterministic escrow gateway signs server-side; there is nothing " +
        "for a wallet to sign.",
    );
  }

  async submitSignedTransition(): Promise<ChainReceipt> {
    throw new ChainError(
      "The deterministic escrow gateway does not accept signed envelopes.",
    );
  }

  async submitTransition(input: ChainTransitionInput): Promise<ChainReceipt> {
    let contractId = input.contractId;

    if (input.transition === PaymentTransition.Lock) {
      if (contractId) throw new ChainError("Escrow is already locked");
      contractId = `contract-${randomUUID()}`;
      this.contracts.set(contractId, {
        orderId: input.orderId,
        state: EscrowState.Locked,
        deliveryConfirmed: false,
      });
    }

    if (
      input.transition === PaymentTransition.Confirm ||
      input.transition === PaymentTransition.Dispute ||
      input.transition === PaymentTransition.Release ||
      input.transition === PaymentTransition.Refund
    ) {
      if (!contractId) throw new ChainError("Escrow contract is not locked");
      const contract = this.contracts.get(contractId);
      if (!contract || contract.orderId !== input.orderId) {
        throw new ChainError("Escrow contract could not be verified");
      }
      if (input.transition === PaymentTransition.Confirm) {
        if (contract.state !== EscrowState.Locked || contract.deliveryConfirmed) {
          throw new ChainError("Only locked escrow can be confirmed once");
        }
        contract.deliveryConfirmed = true;
      }
      if (input.transition === PaymentTransition.Dispute) {
        // Contract: `dispute` requires State::Locked.
        if (contract.state !== EscrowState.Locked) {
          throw new ChainError("Only locked escrow can be disputed");
        }
        contract.state = EscrowState.Disputed;
      }
      if (input.transition === PaymentTransition.Release) {
        // Contract: release requires `Disputed`, or `Locked` with the buyer's
        // on-chain confirmation. Arbiter authority alone is NOT sufficient —
        // the arbiter must first move the escrow to Disputed. Accepting a bare
        // `arbiter: true` here would let this adapter green-light a call the
        // deployed contract rejects with InvalidState.
        const settleable =
          contract.state === EscrowState.Disputed ||
          (contract.state === EscrowState.Locked && contract.deliveryConfirmed);
        if (!settleable) {
          throw new ChainError(
            "Release requires buyer confirmation, or a disputed escrow",
          );
        }
        contract.state = EscrowState.Released;
      }
      if (input.transition === PaymentTransition.Refund) {
        // Contract: refund accepts Locked or Disputed.
        if (
          contract.state !== EscrowState.Locked &&
          contract.state !== EscrowState.Disputed
        ) {
          throw new ChainError("Only a locked or disputed escrow can be refunded");
        }
        contract.state = EscrowState.Refunded;
      }
    }

    const digest = createHash("sha256")
      .update(`${input.orderId}:${input.transition}:${randomUUID()}`)
      .digest("hex");
    const receipt: ChainReceipt = {
      hash: digest,
      type: `escrow_${input.transition}`,
      status: ChainTxStatus.Success,
      contractId,
      orderId: input.orderId,
      transition: input.transition,
      amount: input.amount,
      currency: input.currency,
    };
    this.transactions.set(receipt.hash, receipt);
    return receipt;
  }

  async getTransaction(hash: string): Promise<ChainTxObservation | undefined> {
    const receipt = this.transactions.get(hash);
    return receipt
      ? {
          hash: receipt.hash,
          status: receipt.status,
          orderId: receipt.orderId,
          transition: receipt.transition,
        }
      : undefined;
  }

  async getEscrowState(contractId: string): Promise<EscrowState | undefined> {
    return this.contracts.get(contractId)?.state;
  }

  async getEscrowSnapshot(
    contractId: string,
  ): Promise<EscrowSnapshot | undefined> {
    const contract = this.contracts.get(contractId);
    return contract
      ? {
          state: contract.state,
          orderId: contract.orderId,
          deliveryConfirmed: contract.deliveryConfirmed,
        }
      : undefined;
  }
}

/**
 * Soroban RPC gateway for the escrow contract.
 *
 * The server signer is the on-chain **arbiter**: it deploys each order's
 * custody instance and signs `release`/`refund`. Buyer- and seller-authorized
 * transitions are assembled here but signed in the party's wallet.
 */
export class SorobanRpcEscrowGateway implements EscrowGateway {
  constructor(
    private readonly signer: Signer,
    private readonly addresses: EscrowAddressResolver,
  ) {}

  signingMode(transition: PaymentTransition): ChainSigningMode {
    if (WALLET_SIGNED.includes(transition)) return ChainSigningMode.Wallet;
    if (SERVER_SIGNED.includes(transition)) return ChainSigningMode.Server;
    return ChainSigningMode.None;
  }

  /** The account the contract will accept `release`/`refund` from. */
  private async arbiterAddress(): Promise<string> {
    return config.ESCROW_ARBITER_ADDRESS ?? (await this.signer.getPublicKey());
  }

  // ── Wallet-signed transitions ─────────────────────────────────────────────

  async prepareTransition(
    input: ChainTransitionInput,
  ): Promise<PreparedTransition> {
    if (!WALLET_SIGNED.includes(input.transition)) {
      throw new ChainError(
        `The '${input.transition}' transition is signed by the server, not a wallet`,
      );
    }

    const contractId =
      input.transition === PaymentTransition.Lock
        ? (input.contractId ?? (await this.deployCustody()))
        : this.requireContractId(input);

    const { xdr, signerAddress } = await this.buildWalletTransaction(
      contractId,
      input,
    );

    return {
      orderId: input.orderId,
      transition: input.transition,
      unsignedXdr: xdr,
      networkPassphrase: networkPassphrase(),
      signerAddress,
      contractId,
      expiresAt: new Date(
        Date.now() + config.ESCROW_PREPARED_TX_TTL_SECONDS * 1_000,
      ).toISOString(),
    };
  }

  private async buildWalletTransaction(
    contractId: string,
    input: ChainTransitionInput,
  ): Promise<{ xdr: string; signerAddress: string }> {
    switch (input.transition) {
      case PaymentTransition.Lock: {
        const buyer = await this.addresses.resolve(input.buyerId, "buyer");
        const seller = await this.addresses.resolve(input.sellerId, "seller");
        const token = resolveToken(input.currency);
        const client = (await getUnsignedContractClient(
          contractId,
          buyer,
        )) as unknown as EscrowContractClient;
        const tx = await client.initialize({
          buyer,
          seller,
          arbiter: await this.arbiterAddress(),
          token_id: token.contractId,
          amount: toTokenAmount(input.amount, token),
          order_ref: input.orderId,
        });
        return { ...toUnsignedTransaction(tx, buyer), signerAddress: buyer };
      }
      case PaymentTransition.Confirm: {
        const buyer = await this.addresses.resolve(input.buyerId, "buyer");
        const client = (await getUnsignedContractClient(
          contractId,
          buyer,
        )) as unknown as EscrowContractClient;
        const tx = await client.confirm_delivery();
        return { ...toUnsignedTransaction(tx, buyer), signerAddress: buyer };
      }
      case PaymentTransition.Dispute: {
        // Either counterparty may raise a dispute over their own deal; the
        // contract checks the caller is a party, so `by` must be whoever signs.
        const actorUserId = input.actorUserId ?? input.buyerId;
        const role = actorUserId === input.sellerId ? "seller" : "buyer";
        const by = await this.addresses.resolve(actorUserId, role);
        const client = (await getUnsignedContractClient(
          contractId,
          by,
        )) as unknown as EscrowContractClient;
        const tx = await client.dispute({ by });
        return { ...toUnsignedTransaction(tx, by), signerAddress: by };
      }
      default:
        throw new ChainError(
          `No wallet transaction is defined for '${input.transition}'`,
        );
    }
  }

  async submitSignedTransition(
    input: ChainTransitionInput,
    signedXdr: string,
  ): Promise<ChainReceipt> {
    const contractId = this.requireContractId(input);
    const submitted = await submitSignedTransaction(signedXdr);
    if (submitted.status !== ChainTxStatus.Success) {
      throw new ChainError(
        `The escrow ${input.transition} transaction did not succeed on-chain ` +
          `(status ${submitted.status}, hash ${submitted.hash})`,
      );
    }
    // Read custody back rather than trusting the submitted envelope: the only
    // thing that authorizes a ledger posting is the state the contract is
    // actually in now.
    await this.assertPostState(contractId, input);
    return this.receipt(input, contractId, submitted.hash);
  }

  // ── Server-signed transitions ─────────────────────────────────────────────

  async submitTransition(input: ChainTransitionInput): Promise<ChainReceipt> {
    // An arbiter-raised dispute is the one exception to the wallet rule: the
    // contract names the arbiter as a party precisely so compliance can freeze
    // a deal without a signature from whoever it is ruling against.
    const arbiterDispute =
      input.transition === PaymentTransition.Dispute && input.arbiter === true;

    if (!SERVER_SIGNED.includes(input.transition) && !arbiterDispute) {
      if (!touchesChain(input.transition)) {
        // Create/accept/deposit are ledger bookkeeping with no chain step; the
        // receipt records that fact rather than inventing a transaction.
        return this.receipt(input, input.contractId, offChainHash(input));
      }
      throw new ChainError(
        `The '${input.transition}' transition must be signed by the acting ` +
          "party's wallet. Use the prepare/submit endpoints.",
      );
    }

    const contractId = this.requireContractId(input);
    const client = (await getContractClient(
      contractId,
      this.signer,
    )) as unknown as EscrowContractClient;

    const tx = arbiterDispute
      ? await client.dispute({ by: await this.arbiterAddress() })
      : input.transition === PaymentTransition.Release
        ? await client.release()
        : await client.refund();
    const sent = await tx.signAndSend();
    const hash = sent.sendTransactionResponse?.hash;
    if (!hash) {
      throw new ChainError(
        `The escrow ${input.transition} transaction was not accepted by the network`,
      );
    }
    await this.assertPostState(contractId, input);
    return this.receipt(input, contractId, hash);
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  async getTransaction(hash: string): Promise<ChainTxObservation | undefined> {
    try {
      const status = await getTransactionStatus(hash);
      return status ? { hash, status } : undefined;
    } catch (err) {
      // An RPC outage is not evidence that a transaction is missing; saying so
      // would make reconciliation raise false mismatches and block orders.
      throw new ChainError(`Could not look up transaction ${hash}`, err);
    }
  }

  async getEscrowState(contractId: string): Promise<EscrowState | undefined> {
    return (await this.getEscrowSnapshot(contractId))?.state;
  }

  async getEscrowSnapshot(
    contractId: string,
  ): Promise<EscrowSnapshot | undefined> {
    let client: EscrowContractClient;
    try {
      client = (await getUnsignedContractClient(
        contractId,
        await this.arbiterAddress(),
      )) as unknown as EscrowContractClient;
    } catch {
      // Unknown/undeployed contract id.
      return undefined;
    }

    // Simulation failures (RPC down, bad contract) throw and must propagate: an
    // outage is not evidence about custody, and swallowing it here would make
    // reconciliation raise false mismatches and block healthy orders.
    const result = (await client.get()).result;

    if (result.isErr()) {
      // The contract itself answered — `NotInitialized`, i.e. an instance that
      // has been deployed but whose buyer has not signed the lock yet. That is
      // the deploy→lock gap, not a fault.
      logger.debug(
        { contractId, error: result.unwrapErr().message },
        "escrow contract has not been initialized yet",
      );
      return {
        state: EscrowState.Pending,
        orderId: null,
        deliveryConfirmed: false,
      };
    }

    const escrow = result.unwrap();
    const state = escrowStateFromTag(escrow.state.tag);
    if (!state) return undefined;
    return {
      state,
      orderId: escrow.order_ref,
      deliveryConfirmed: escrow.delivery_confirmed,
    };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async deployCustody(): Promise<string> {
    const wasmHash = config.ESCROW_WASM_HASH;
    if (!wasmHash) {
      throw new ChainError(
        "ESCROW_WASM_HASH is not configured; cannot deploy an escrow contract",
      );
    }
    return deployFromWasmHash(wasmHash, this.signer);
  }

  private requireContractId(input: ChainTransitionInput): string {
    if (!input.contractId) {
      throw new ConflictError(
        `Order ${input.orderId} has no escrow contract yet; lock it first`,
      );
    }
    return input.contractId;
  }

  /**
   * Assert the contract really is in the state this transition claims, and
   * that the instance belongs to this order. Without the order check a
   * mis-recorded contract id would let one order's ledger entries be settled
   * against another order's custody.
   */
  private async assertPostState(
    contractId: string,
    input: ChainTransitionInput,
  ): Promise<void> {
    const snapshot = await this.getEscrowSnapshot(contractId);
    if (!snapshot) {
      throw new ChainError(
        `Escrow contract ${contractId} could not be read back after submission`,
      );
    }
    if (snapshot.orderId !== null && snapshot.orderId !== input.orderId) {
      throw new ChainError(
        `Escrow contract ${contractId} belongs to order ${snapshot.orderId}, ` +
          `not ${input.orderId}`,
      );
    }
    const expected = expectedStateAfter(input.transition);
    if (expected && snapshot.state !== expected) {
      throw new ChainError(
        `Escrow contract ${contractId} is ${snapshot.state} after ` +
          `${input.transition}; expected ${expected}`,
      );
    }
    if (
      input.transition === PaymentTransition.Confirm &&
      !snapshot.deliveryConfirmed
    ) {
      throw new ChainError(
        `Escrow contract ${contractId} did not record the delivery confirmation`,
      );
    }
  }

  private receipt(
    input: ChainTransitionInput,
    contractId: string | null,
    hash: string,
  ): ChainReceipt {
    return {
      hash,
      type: `escrow_${input.transition}`,
      status: ChainTxStatus.Success,
      contractId,
      orderId: input.orderId,
      transition: input.transition,
      amount: input.amount,
      currency: input.currency,
    };
  }
}

/** The custody state a completed transition must leave the contract in. */
function expectedStateAfter(
  transition: PaymentTransition,
): EscrowState | undefined {
  switch (transition) {
    case PaymentTransition.Lock:
    case PaymentTransition.Confirm:
      return EscrowState.Locked;
    case PaymentTransition.Dispute:
      return EscrowState.Disputed;
    case PaymentTransition.Release:
      return EscrowState.Released;
    case PaymentTransition.Refund:
      return EscrowState.Refunded;
    default:
      return undefined;
  }
}

/**
 * Stable synthetic hash for ledger-only transitions, so every recorded
 * transition still has a unique chain-record key without implying a
 * transaction exists on Stellar.
 */
function offChainHash(input: ChainTransitionInput): string {
  return createHash("sha256")
    .update(`offchain:${input.orderId}:${input.transition}`)
    .digest("hex");
}

/** Map the escrow contract's `State` enum variant tag to the shared EscrowState. */
function escrowStateFromTag(tag: string): EscrowState | undefined {
  switch (tag) {
    case "Locked":
      return EscrowState.Locked;
    case "Released":
      return EscrowState.Released;
    case "Refunded":
      return EscrowState.Refunded;
    case "Disputed":
      return EscrowState.Disputed;
    default:
      return undefined;
  }
}

/**
 * Structural view of the spec-generated client for the escrow contract.
 * `contract.Client` builds these methods from the on-chain spec; this types the
 * exact surface the gateway invokes. Names mirror the Rust contract.
 */
interface EscrowContractClient {
  initialize(args: {
    buyer: string;
    seller: string;
    arbiter: string;
    token_id: string;
    amount: bigint;
    order_ref: string;
  }): Promise<ContractTx<ContractResult<void>>>;
  confirm_delivery(): Promise<ContractTx<ContractResult<void>>>;
  release(): Promise<ContractTx<ContractResult<void>>>;
  refund(): Promise<ContractTx<ContractResult<void>>>;
  dispute(args: { by: string }): Promise<ContractTx<ContractResult<void>>>;
  state(): Promise<ContractTx<ContractResult<{ tag: string; values: undefined }>>>;
  get(): Promise<ContractTx<ContractResult<EscrowContractState>>>;
}

interface EscrowContractState {
  buyer: string;
  seller: string;
  arbiter: string;
  token: string;
  amount: bigint;
  state: { tag: string; values: undefined };
  delivery_confirmed: boolean;
  order_ref: string;
}

/** Fail closed rather than running a synthetic chain adapter outside local/test. */
export function createEscrowGateway(
  addresses: EscrowAddressResolver,
): EscrowGateway {
  if (config.ESCROW_GATEWAY === "deterministic") {
    if (config.NODE_ENV === "staging" || config.NODE_ENV === "production") {
      throw new Error(
        "ESCROW_GATEWAY=deterministic is forbidden outside development/test",
      );
    }
    return new DeterministicEscrowGateway();
  }
  return new SorobanRpcEscrowGateway(createSigner(), addresses);
}
