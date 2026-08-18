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
import {
  fromTokenAmount,
  resolveToken,
  toTokenAmount,
  tokenBindingByContractId,
} from "../stellar/asset.js";
import {
  deployFromWasmHash,
  getContractClient,
  getTransactionStatus,
  getUnsignedContractClient,
  isMissingContractError,
  signAndSendChecked,
  submitSignedTransaction,
  toUnsignedTransaction,
  type ContractResult,
  type ContractTx,
} from "../stellar/soroban.client.js";
import type { WalletAddressResolver } from "../identity/wallet.resolver.js";

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

/**
 * What a custody instance says it holds, expressed in ledger terms.
 *
 * The contract records a token *address* and an `i128` in that token's own
 * scale; the books record a currency and minor units. Converting here is what
 * lets reconciliation compare value at all — comparing only custody *state*
 * proves an escrow is "locked" while saying nothing about whether it locked
 * the right amount, or the right asset.
 */
export interface CustodyValue {
  /** Ledger minor units, or null when the token is not one we can express. */
  amount: string | null;
  /** Ledger currency the token maps to; null when the token is unrecognised. */
  currency: CurrencyCode | null;
  /** The `C…` token contract the custody instance actually holds. */
  tokenContractId: string | null;
}

/** On-chain custody state, read back for reconciliation. */
export interface EscrowSnapshot {
  state: EscrowState;
  /** The order this custody instance was initialized for, per the contract. */
  orderId: string | null;
  deliveryConfirmed: boolean;
  /** What the contract holds. `null` before `initialize` has run. */
  value: CustodyValue | null;
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
  /**
   * Who must sign this transition in the current deployment.
   *
   * Asynchronous because the answer depends on the signer's own address: when
   * `ESCROW_ARBITER_ADDRESS` names an account this server holds no key for (a
   * multi-sig, say), `release` and `refund` stop being server-signable and
   * join the prepare → sign → submit path.
   */
  signingMode(transition: PaymentTransition): Promise<ChainSigningMode>;
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

/**
 * Transitions the contract gates with `arbiter.require_auth()`.
 *
 * Who signs them depends on configuration, not on the transition: with the
 * default arbiter (this server) they are a single server-signed call; with an
 * external arbiter they take the same prepare → sign → submit route the
 * counterparty-signed transitions do.
 */
const ARBITER_SIGNED: readonly PaymentTransition[] = [
  PaymentTransition.Release,
  PaymentTransition.Refund,
];

/**
 * Does this transition have a chain counterpart at all?
 *
 * `create`, `accept`, and `deposit` are ledger bookkeeping. They still get a
 * chain-record row (with a synthetic hash) so every transition has a unique
 * key, but there is nothing on Stellar to look up — which reconciliation has
 * to know, or it flags every healthy order as "chain transaction not found".
 */
export function touchesChain(transition: PaymentTransition): boolean {
  return (
    WALLET_SIGNED.includes(transition) || ARBITER_SIGNED.includes(transition)
  );
}

interface ContractSnapshot {
  state: EscrowState;
  orderId: string;
  deliveryConfirmed: boolean;
  /** Ledger minor units locked at `initialize`, mirroring the contract. */
  amount: string;
  currency: CurrencyCode;
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
  async signingMode(transition: PaymentTransition): Promise<ChainSigningMode> {
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
        // The contract stores what it was funded with, and never changes it.
        // Recording it here is what lets the value checks below run against
        // this adapter too, rather than only against a live network.
        amount: input.amount,
        currency: input.currency,
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
      // Custody holds a fixed amount of a fixed asset. A transition claiming
      // different terms is settling against the wrong custody, and the
      // deployed contract would move its own `amount`, not the caller's.
      if (
        contract.amount !== input.amount ||
        contract.currency !== input.currency
      ) {
        throw new ChainError(
          `Escrow contract holds ${contract.amount} ${contract.currency} but ` +
            `the transition claims ${input.amount} ${input.currency}`,
        );
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
          value: {
            amount: contract.amount,
            currency: contract.currency,
            // No token contract exists in this adapter; the currency is the
            // whole of what it can attest to.
            tokenContractId: null,
          },
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
    private readonly addresses: WalletAddressResolver,
  ) {}

  async signingMode(transition: PaymentTransition): Promise<ChainSigningMode> {
    if (WALLET_SIGNED.includes(transition)) return ChainSigningMode.Wallet;
    if (ARBITER_SIGNED.includes(transition)) {
      // The contract wants the arbiter's signature. Whether this server can
      // produce it is a deployment question, not a property of the transition.
      return (await this.hasExternalArbiter())
        ? ChainSigningMode.Wallet
        : ChainSigningMode.Server;
    }
    return ChainSigningMode.None;
  }

  /** The account the contract will accept `release`/`refund` from. */
  private async arbiterAddress(): Promise<string> {
    return config.ESCROW_ARBITER_ADDRESS ?? (await this.signer.getPublicKey());
  }

  /**
   * Is settlement authority held by an account this server has no key for?
   *
   * That is the whole point of pointing `ESCROW_ARBITER_ADDRESS` at a separate
   * account: a multi-sig or a hardware-held key means no single compromised
   * server can move custodied funds. The cost is that release and refund
   * become a prepare → sign → submit round trip, exactly like the transitions
   * the buyer authorizes.
   *
   * Cached: the signer's address is fixed for the process, and this is
   * consulted on every capability lookup.
   */
  private externalArbiter: boolean | undefined;
  private async hasExternalArbiter(): Promise<boolean> {
    if (this.externalArbiter === undefined) {
      const configured = config.ESCROW_ARBITER_ADDRESS;
      this.externalArbiter =
        configured !== undefined &&
        configured !== (await this.signer.getPublicKey());
    }
    return this.externalArbiter;
  }

  // ── Wallet-signed transitions ─────────────────────────────────────────────

  async prepareTransition(
    input: ChainTransitionInput,
  ): Promise<PreparedTransition> {
    if ((await this.signingMode(input.transition)) !== ChainSigningMode.Wallet) {
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
        // The arbiter may also raise a dispute, to freeze a deal for review
        // when neither counterparty cooperates. With an external arbiter that
        // is a signature this server cannot produce either, so it takes the
        // same route.
        if (input.arbiter === true) {
          const by = await this.arbiterAddress();
          const client = (await getUnsignedContractClient(
            contractId,
            by,
          )) as unknown as EscrowContractClient;
          const tx = await client.dispute({ by });
          return { ...toUnsignedTransaction(tx, by), signerAddress: by };
        }
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
      case PaymentTransition.Release:
      case PaymentTransition.Refund: {
        // Settlement under an external arbiter. The arbiter's account is the
        // transaction source, so `arbiter.require_auth()` is satisfied by the
        // envelope signature — and for a multi-sig account, by however many
        // signatures its thresholds demand. Collecting them is the operator's
        // business; Stellar rejects the submission until they are present.
        const arbiter = await this.arbiterAddress();
        const client = (await getUnsignedContractClient(
          contractId,
          arbiter,
        )) as unknown as EscrowContractClient;
        const tx =
          input.transition === PaymentTransition.Release
            ? await client.release()
            : await client.refund();
        return {
          ...toUnsignedTransaction(tx, arbiter),
          signerAddress: arbiter,
        };
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

    if (!ARBITER_SIGNED.includes(input.transition) && !arbiterDispute) {
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

    // Settlement authority may live outside this server. Signing here would
    // produce an envelope the contract rejects, after the fee was paid.
    if (await this.hasExternalArbiter()) {
      throw new ChainError(
        `The '${input.transition}' transition must be signed by the arbiter ` +
          `account (${await this.arbiterAddress()}), which this server holds ` +
          "no key for. Use the prepare/submit endpoints.",
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
    const hash = await signAndSendChecked(
      `escrow ${input.transition}`,
      tx as ContractTx<ContractResult<void>>,
    );
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
      // Read as the server's own account rather than the configured arbiter:
      // simulation needs a source account that exists on the network, and the
      // arbiter may be an account this deployment never funded.
      client = (await getUnsignedContractClient(
        contractId,
        await this.signer.getPublicKey(),
      )) as unknown as EscrowContractClient;
    } catch (err) {
      // Only a genuinely unknown contract is "nothing to compare against". An
      // RPC failure is not evidence about custody, and swallowing it here is
      // what makes a reconciliation run report `matched` during an outage.
      if (isMissingContractError(err)) return undefined;
      throw new ChainError(
        `Could not read escrow contract ${contractId} from the network`,
        err,
      );
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
        value: null,
      };
    }

    const escrow = result.unwrap();
    const state = escrowStateFromTag(escrow.state.tag);
    if (!state) return undefined;
    return {
      state,
      orderId: escrow.order_ref,
      deliveryConfirmed: escrow.delivery_confirmed,
      value: toCustodyValue(escrow.token, escrow.amount),
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
    assertCustodyValueMatches(contractId, snapshot.value, {
      amount: input.amount,
      currency: input.currency,
    });
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

/**
 * Express what a custody instance holds in ledger terms.
 *
 * A token this deployment has no binding for yields a value with a known
 * contract id but no amount — deliberately: reporting "unknown" is what lets
 * callers treat "custody holds something we did not configure" as the finding
 * it is, rather than silently skipping the value check.
 */
export function toCustodyValue(
  tokenContractId: string,
  rawAmount: bigint,
): CustodyValue {
  const binding = tokenBindingByContractId(tokenContractId);
  if (!binding) return { amount: null, currency: null, tokenContractId };
  try {
    return {
      amount: fromTokenAmount(rawAmount, binding),
      currency: binding.currency,
      tokenContractId,
    };
  } catch {
    // An on-chain amount carrying precision the ledger cannot express. Not
    // representable is not the same as zero — report it as unknown.
    return { amount: null, currency: binding.currency, tokenContractId };
  }
}

/**
 * Assert custody holds exactly what a transition claims it does.
 *
 * State alone says an escrow is "locked"; it says nothing about whether it
 * locked the right amount of the right asset. A contract funded with the wrong
 * token, or with less than the order is worth, would otherwise settle cleanly.
 */
export function assertCustodyValueMatches(
  contractId: string,
  value: CustodyValue | null,
  expected: { amount: string; currency: CurrencyCode },
): void {
  // No value yet: the instance is deployed but not funded (the deploy→lock
  // gap). The state check covers that case.
  if (!value) return;

  if (value.amount === null || value.currency === null) {
    throw new ChainError(
      `Escrow contract ${contractId} holds token ` +
        `${value.tokenContractId ?? "unknown"}, which this deployment cannot ` +
        "express in ledger units; refusing to settle against custody we " +
        "cannot value",
    );
  }
  if (value.currency !== expected.currency || value.amount !== expected.amount) {
    throw new ChainError(
      `Escrow contract ${contractId} holds ${value.amount} ${value.currency} ` +
        `but the order is ${expected.amount} ${expected.currency}`,
    );
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
  // The contract also exposes `state()`, a narrower view of what `get()`
  // already returns. Every read here needs the amount and order ref too, so
  // declaring `state()` would be a surface we never call.
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
  addresses: WalletAddressResolver,
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
