/**
 * Phase 5: RWA Gateway
 * Boundary interface to the Soroban RWA token contract.
 *
 * Architecture: The gateway abstracts blockchain operations behind a clean
 * interface. Local/test uses DeterministicRwaGateway; staging/production
 * must use a KMS-backed Soroban RPC adapter.
 *
 * ── Custody ───────────────────────────────────────────────────────────────
 * The token contract gates `transfer` with `from.require_auth()` and every
 * admin operation with `issuer.require_auth()`. Whoever is named issuer must
 * therefore sign, which makes custody a deployment choice with teeth:
 *
 *   platform — the server signer is the on-chain issuer. It holds the whole
 *     supply and signs everything. Simple, and entirely custodial: the issuer
 *     owns nothing on-chain.
 *   issuer   — the issuer's own SEP-10 wallet is the on-chain issuer. They
 *     hold their units. The platform cannot move them, freeze the token, or
 *     set the payout guard on their behalf; those become prepare → sign →
 *     submit, exactly as escrow does for buyer-authorized transitions.
 *
 * Both adapters implement both modes, so the local suite exercises the same
 * state machine the deployed contract enforces.
 */

import { createHash, randomUUID } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import {
  ChainSigningMode,
  ChainTxStatus,
  RwaCustodyMode,
  RwaTransition,
} from "@stellartrust/shared";
import { ChainError } from "../../lib/errors.js";
import { config } from "../../config/index.js";
import { createSigner, type Signer } from "../stellar/signer.js";
import { networkPassphrase } from "../stellar/stellar.client.js";
import type { WalletAddressResolver } from "../identity/wallet.resolver.js";
import {
  deployFromWasmHash,
  getContractClient,
  getUnsignedContractClient,
  isMissingContractError,
  signAndSendChecked,
  submitSignedTransaction,
  toUnsignedTransaction,
  unwrapContractResult,
  type ContractResult,
  type ContractTx,
} from "../stellar/soroban.client.js";
import { AssetType } from "./rwa.types.js";

/** Operations the contract gates with `issuer.require_auth()` (or `from`). */
const ISSUER_SIGNED: readonly RwaTransition[] = [
  RwaTransition.Deploy,
  RwaTransition.Transfer,
  RwaTransition.Authorize,
  RwaTransition.Revoke,
  RwaTransition.Freeze,
  RwaTransition.Unfreeze,
  RwaTransition.Distribute,
];

/** Terms for a tokenization that does not exist on-chain yet. */
export interface DeployTerms {
  assetRef: string;
  assetType: AssetType;
  description: string;
  totalUnits: bigint;
  requireAuthorization: boolean;
}

/**
 * One issuer-authorized contract operation, in the shape both the server-signed
 * and the wallet-signed paths need.
 */
export interface RwaOperationInput {
  transition: RwaTransition;
  /** Whose tokenization this is; resolves to the on-chain issuer address. */
  issuerUserId: string;
  /** Existing contract, or null for a {@link RwaTransition.Deploy}. */
  contractId: string | null;
  /** Deploy only. */
  deploy?: DeployTerms;
  /** Transfer only. */
  transfer?: { to: string; units: bigint };
  /** Authorize / revoke only. */
  holderAddress?: string;
}

/** An unsigned contract transaction awaiting the issuer's wallet signature. */
export interface PreparedRwaOperation {
  transition: RwaTransition;
  unsignedXdr: string;
  networkPassphrase: string;
  signerAddress: string;
  contractId: string;
  expiresAt: string;
}

/** What a completed operation tells the caller. */
export interface RwaOperationReceipt {
  contractId: string;
  hash: string;
}

export interface DeployTokenInput extends DeployTerms {
  /** Whose tokenization this is; resolves to the on-chain issuer address. */
  issuerUserId: string;
  /** The address the caller believes will be issuer, asserted not assumed. */
  issuerAddress: string;
}

export interface TransferUnitsInput {
  contractId: string;
  issuerUserId: string;
  from: string;
  to: string;
  units: bigint;
}

export interface AuthorizeHolderInput {
  contractId: string;
  holderAddress: string;
}

export interface PayoutSharesInput {
  contractId: string;
  payoutAmount: bigint;
}

export interface PayoutShare {
  holderAddress: string;
  shareAmount: bigint;
}

/** A holder's on-chain unit balance, read back from the token contract. */
export interface HolderBalance {
  holderAddress: string;
  units: bigint;
}

/**
 * Gateway interface for RWA token contract operations.
 */
export interface RwaGateway {
  /** Which custody model this deployment runs. */
  custody(): RwaCustodyMode;

  /**
   * Who signs this operation here — the server, or the issuer's wallet.
   *
   * Every operation in {@link RwaTransition} is `issuer.require_auth()`-gated
   * by the contract; what changes with `RWA_CUSTODY` is whether the platform
   * is that issuer.
   */
  signingMode(transition: RwaTransition): Promise<ChainSigningMode>;

  /**
   * The Stellar account the contract will demand authorization from for this
   * tokenization.
   *
   * Under platform custody that is the server signer for everyone; under
   * issuer custody it is the issuer's own SEP-10-proven wallet. Exposed rather
   * than assumed so callers pass the right address instead of having a
   * different one silently substituted, and so both adapters key balances by
   * the same value.
   */
  issuerAddress(issuerUserId: string): Promise<string>;

  /**
   * Build the unsigned transaction the issuer must sign. Only valid for
   * operations {@link signingMode} reports as wallet-signed.
   *
   * For a deploy the contract is created first and its id returned, so an
   * abandoned signature costs one idle contract rather than one per retry —
   * the same bargain the escrow lock makes.
   */
  prepareOperation(input: RwaOperationInput): Promise<PreparedRwaOperation>;

  /** Submit an issuer-signed envelope and report the settled outcome. */
  submitSignedOperation(
    input: RwaOperationInput,
    signedXdr: string,
  ): Promise<RwaOperationReceipt>;

  /**
   * Deploy a new RWA token contract to the blockchain.
   * Returns the deployed contract ID.
   */
  deployToken(input: DeployTokenInput): Promise<string>;

  /**
   * Transfer units from one address to another.
   */
  transferUnits(input: TransferUnitsInput): Promise<void>;

  /**
   * Authorize a holder address for transfers (when authorization is required).
   */
  authorizeHolder(input: AuthorizeHolderInput): Promise<void>;

  /**
   * Revoke authorization from a holder address.
   */
  revokeAuthorization(input: AuthorizeHolderInput): Promise<void>;

  /**
   * Freeze all transfers on a token contract.
   */
  freezeToken(contractId: string): Promise<void>;

  /**
   * Unfreeze transfers on a token contract.
   */
  unfreezeToken(contractId: string): Promise<void>;

  /**
   * Get balance of units for a holder.
   */
  getBalance(contractId: string, holderAddress: string): Promise<bigint>;

  /**
   * Every non-zero holder and what they hold, straight from the contract.
   *
   * The authority on who owns units is the token contract, not our holdings
   * table: a holder can transfer units directly on-chain without the backend
   * ever seeing it. Payout shares computed from stale records would pay the
   * wrong people, so this is what those records are checked against.
   */
  getHolderBalances(contractId: string): Promise<HolderBalance[]>;

  /**
   * Calculate payout shares for all holders.
   */
  getPayoutShares(input: PayoutSharesInput): Promise<PayoutShare[]>;

  /**
   * Mark the payout as distributed (idempotency guard).
   */
  markDistributed(contractId: string): Promise<void>;

  /**
   * Check if an address is authorized.
   */
  isAuthorized(contractId: string, address: string): Promise<boolean>;

  /**
   * Get contract metadata.
   */
  getContractMeta(contractId: string): Promise<{
    issuer: string;
    assetRef: string;
    totalUnits: bigint;
    frozen: boolean;
    distributed: boolean;
  } | undefined>;
}

interface ContractState {
  issuer: string;
  assetRef: string;
  assetType: AssetType;
  description: string;
  totalUnits: bigint;
  requireAuthorization: boolean;
  frozen: boolean;
  distributed: boolean;
  balances: Map<string, bigint>;
  authorized: Set<string>;
}

/**
 * Deterministic local/test adapter for the RWA token contract boundary.
 * Enforces the same state machine as the Rust Soroban contract without
 * holding any signing keys or making network calls.
 * 
 * Staging/production must replace this adapter with a KMS-backed
 * testnet/mainnet Soroban RPC submitter.
 */
export class DeterministicRwaGateway implements RwaGateway {
  private readonly contracts = new Map<string, ContractState>();
  /** Envelopes handed out by `prepareOperation`, keyed by their fake XDR. */
  private readonly pending = new Map<string, RwaOperationInput>();

  /**
   * A stable, structurally valid `G…` account standing in for the server
   * signer. Derived rather than hard-coded so it is a real strkey — the same
   * address-shaped value the Soroban adapter would return, so code paths that
   * validate addresses behave identically under both.
   */
  private readonly platformIssuer = Keypair.fromRawEd25519Seed(
    Buffer.alloc(32, 7),
  ).publicKey();

  /**
   * @param custodyMode - which custody model to simulate. Defaults to
   *   `platform`, so existing callers and tests are unaffected.
   * @param addresses - required for `issuer` custody: the on-chain issuer is
   *   then a real user's wallet, and only the identity store can say which.
   */
  constructor(
    private readonly custodyMode: RwaCustodyMode = RwaCustodyMode.Platform,
    private readonly addresses?: WalletAddressResolver,
  ) {}

  custody(): RwaCustodyMode {
    return this.custodyMode;
  }

  async signingMode(transition: RwaTransition): Promise<ChainSigningMode> {
    if (!ISSUER_SIGNED.includes(transition)) return ChainSigningMode.None;
    return this.custodyMode === RwaCustodyMode.Issuer
      ? ChainSigningMode.Wallet
      : ChainSigningMode.Server;
  }

  async issuerAddress(issuerUserId: string): Promise<string> {
    if (this.custodyMode === RwaCustodyMode.Platform) {
      return this.platformIssuer;
    }
    if (!this.addresses) {
      throw new ChainError(
        "Issuer custody needs a wallet resolver to find the issuer's account",
      );
    }
    return this.addresses.resolve(issuerUserId, "issuer");
  }

  async prepareOperation(
    input: RwaOperationInput,
  ): Promise<PreparedRwaOperation> {
    if ((await this.signingMode(input.transition)) !== ChainSigningMode.Wallet) {
      throw new ChainError(
        `The '${input.transition}' operation is signed by the server here`,
      );
    }
    const issuer = await this.issuerAddress(input.issuerUserId);
    // A deploy creates the instance up front, so a retry reuses it rather than
    // leaking a contract per abandoned signature.
    const contractId =
      input.transition === RwaTransition.Deploy
        ? (input.contractId ?? (await this.createInstance(input, issuer)))
        : requireContractId(input);

    const unsignedXdr = `rwa-unsigned:${createHash("sha256")
      .update(`${contractId}:${input.transition}:${randomUUID()}`)
      .digest("hex")}`;
    this.pending.set(unsignedXdr, { ...input, contractId });

    return {
      transition: input.transition,
      unsignedXdr,
      networkPassphrase: networkPassphrase(),
      signerAddress: issuer,
      contractId,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
  }

  async submitSignedOperation(
    input: RwaOperationInput,
    signedXdr: string,
  ): Promise<RwaOperationReceipt> {
    const unsigned = signedXdr.replace(/^signed:/, "");
    const prepared = this.pending.get(unsigned);
    if (!prepared || !signedXdr.startsWith("signed:")) {
      throw new ChainError(
        "This envelope was not prepared by the gateway, or is not signed",
      );
    }
    if (prepared.transition !== input.transition) {
      throw new ChainError(
        `Envelope authorizes '${prepared.transition}', not '${input.transition}'`,
      );
    }
    this.pending.delete(unsigned);

    const contractId = requireContractId(prepared);
    const issuer = await this.issuerAddress(prepared.issuerUserId);
    await this.applyOperation(prepared, contractId, issuer);

    return {
      contractId,
      hash: createHash("sha256").update(signedXdr).digest("hex"),
    };
  }

  /** Create (but do not initialize) an instance, mirroring a Soroban deploy. */
  private async createInstance(
    input: RwaOperationInput,
    _issuer: string,
  ): Promise<string> {
    if (!input.deploy) throw new ChainError("Deploy terms are required");
    return `rwa-contract-${randomUUID()}`;
  }

  /**
   * Apply the state change the signed envelope authorizes.
   *
   * Each branch goes through the same public method the server-signed path
   * uses, so the two custody models cannot drift apart in what they enforce.
   */
  private async applyOperation(
    input: RwaOperationInput,
    contractId: string,
    issuer: string,
  ): Promise<void> {
    switch (input.transition) {
      case RwaTransition.Deploy: {
        if (!input.deploy) throw new ChainError("Deploy terms are required");
        this.initialize(contractId, issuer, input.deploy);
        return;
      }
      case RwaTransition.Transfer: {
        if (!input.transfer) throw new ChainError("Transfer terms are required");
        this.applyTransfer(contractId, issuer, input.transfer);
        return;
      }
      case RwaTransition.Authorize:
        this.requireContract(contractId).authorized.add(
          requireHolder(input),
        );
        return;
      case RwaTransition.Revoke:
        this.requireContract(contractId).authorized.delete(
          requireHolder(input),
        );
        return;
      case RwaTransition.Freeze:
        this.requireContract(contractId).frozen = true;
        return;
      case RwaTransition.Unfreeze:
        this.requireContract(contractId).frozen = false;
        return;
      case RwaTransition.Distribute:
        await this.markDistributed(contractId);
        return;
    }
  }

  async deployToken(input: DeployTokenInput): Promise<string> {
    await this.assertServerSigned(RwaTransition.Deploy);
    if (input.totalUnits <= 0n) {
      throw new ChainError("Total units must be positive");
    }
    const issuer = await this.issuerAddress(input.issuerUserId);
    assertIsIssuer(input.issuerAddress, issuer, "issue a tokenization");

    const contractId = `rwa-contract-${randomUUID()}`;
    this.initialize(contractId, issuer, input);
    return contractId;
  }

  /** Mirror the contract's `initialize`: mint the whole supply to the issuer. */
  private initialize(
    contractId: string,
    issuer: string,
    terms: DeployTerms,
  ): void {
    if (this.contracts.has(contractId)) {
      throw new ChainError("Contract is already initialized");
    }
    if (terms.totalUnits <= 0n) {
      throw new ChainError("Total units must be positive");
    }
    const balances = new Map<string, bigint>([[issuer, terms.totalUnits]]);
    // The contract auto-authorizes the issuer when authorization is required.
    const authorized = new Set<string>(
      terms.requireAuthorization ? [issuer] : [],
    );

    this.contracts.set(contractId, {
      issuer,
      assetRef: terms.assetRef,
      assetType: terms.assetType,
      description: terms.description,
      totalUnits: terms.totalUnits,
      requireAuthorization: terms.requireAuthorization,
      frozen: false,
      distributed: false,
      balances,
      authorized,
    });
  }

  async transferUnits(input: TransferUnitsInput): Promise<void> {
    await this.assertServerSigned(RwaTransition.Transfer);
    // The contract gates `transfer` with `from.require_auth()`, so the only
    // `from` this adapter can stand behind is the on-chain issuer's account.
    const issuer = await this.issuerAddress(input.issuerUserId);
    assertIsIssuer(input.from, issuer, "transfer units");
    this.applyTransfer(input.contractId, issuer, input);
  }

  /** Mirror the contract's `transfer`, including its refusals. */
  private applyTransfer(
    contractId: string,
    from: string,
    move: { to: string; units: bigint },
  ): void {
    const contract = this.requireContract(contractId);

    if (contract.frozen) {
      throw new ChainError("Transfers are frozen on this contract");
    }
    if (move.units <= 0n) {
      throw new ChainError("Transfer amount must be positive");
    }
    if (contract.requireAuthorization) {
      if (!contract.authorized.has(from)) {
        throw new ChainError(`Address ${from} is not authorized`);
      }
      if (!contract.authorized.has(move.to)) {
        throw new ChainError(`Address ${move.to} is not authorized`);
      }
    }

    const fromBalance = contract.balances.get(from) ?? 0n;
    if (fromBalance < move.units) {
      throw new ChainError(
        `Insufficient balance: ${fromBalance} < ${move.units}`,
      );
    }
    contract.balances.set(from, fromBalance - move.units);
    contract.balances.set(
      move.to,
      (contract.balances.get(move.to) ?? 0n) + move.units,
    );
  }

  async authorizeHolder(input: AuthorizeHolderInput): Promise<void> {
    await this.assertServerSigned(RwaTransition.Authorize);
    const contract = this.requireContract(input.contractId);

    if (!contract.requireAuthorization) {
      // No-op if authorization not required
      return;
    }

    contract.authorized.add(input.holderAddress);
  }

  async revokeAuthorization(input: AuthorizeHolderInput): Promise<void> {
    await this.assertServerSigned(RwaTransition.Revoke);
    const contract = this.requireContract(input.contractId);

    if (!contract.requireAuthorization) {
      // No-op if authorization not required
      return;
    }

    contract.authorized.delete(input.holderAddress);
  }

  async freezeToken(contractId: string): Promise<void> {
    await this.assertServerSigned(RwaTransition.Freeze);
    const contract = this.requireContract(contractId);
    contract.frozen = true;
  }

  async unfreezeToken(contractId: string): Promise<void> {
    await this.assertServerSigned(RwaTransition.Unfreeze);
    const contract = this.requireContract(contractId);
    contract.frozen = false;
  }

  /**
   * Refuse a server-signed call the issuer is supposed to authorize.
   *
   * Without this, switching to issuer custody would leave the single-call
   * methods silently operating on a contract whose issuer this server is not —
   * which the deployed contract would reject, but only after the books had
   * already recorded the change.
   */
  private async assertServerSigned(transition: RwaTransition): Promise<void> {
    if ((await this.signingMode(transition)) === ChainSigningMode.Wallet) {
      throw new ChainError(
        `The '${transition}' operation must be signed by the issuer's wallet ` +
          "under issuer custody. Use the prepare/submit endpoints.",
      );
    }
  }

  async getBalance(contractId: string, holderAddress: string): Promise<bigint> {
    const contract = this.requireContract(contractId);
    return contract.balances.get(holderAddress) ?? 0n;
  }

  async getPayoutShares(input: PayoutSharesInput): Promise<PayoutShare[]> {
    const contract = this.requireContract(input.contractId);

    if (input.payoutAmount < 0n) {
      throw new ChainError("Payout amount cannot be negative");
    }

    const shares: PayoutShare[] = [];
    
    for (const [holderAddress, units] of contract.balances.entries()) {
      if (units > 0n) {
        const shareAmount = (input.payoutAmount * units) / contract.totalUnits;
        shares.push({ holderAddress, shareAmount });
      }
    }

    return shares;
  }

  async markDistributed(contractId: string): Promise<void> {
    const contract = this.requireContract(contractId);
    
    if (contract.distributed) {
      throw new ChainError("Payout has already been distributed");
    }

    contract.distributed = true;
  }

  async isAuthorized(contractId: string, address: string): Promise<boolean> {
    const contract = this.requireContract(contractId);
    
    if (!contract.requireAuthorization) {
      return true; // Everyone authorized if not required
    }

    return contract.authorized.has(address);
  }

  async getContractMeta(contractId: string): Promise<{
    issuer: string;
    assetRef: string;
    totalUnits: bigint;
    frozen: boolean;
    distributed: boolean;
  } | undefined> {
    const contract = this.contracts.get(contractId);
    if (!contract) {
      return undefined;
    }

    return {
      issuer: contract.issuer,
      assetRef: contract.assetRef,
      totalUnits: contract.totalUnits,
      frozen: contract.frozen,
      distributed: contract.distributed,
    };
  }

  async getHolderBalances(contractId: string): Promise<HolderBalance[]> {
    const contract = this.requireContract(contractId);
    return Array.from(contract.balances.entries())
      .filter(([, units]) => units > 0n)
      .map(([holderAddress, units]) => ({ holderAddress, units }));
  }

  private requireContract(contractId: string): ContractState {
    const contract = this.contracts.get(contractId);
    if (!contract) {
      throw new ChainError(`RWA contract ${contractId} not found`);
    }
    return contract;
  }
}

/**
 * Refuse a call whose authorizing address is not the on-chain issuer.
 *
 * Substituting the issuer silently — which is what the Soroban adapter used to
 * do — makes the two adapters disagree about who holds units: the local one
 * keys balances by the address it was handed, the on-chain one by the signer.
 * A green test suite then says nothing about the deployed system.
 */
function assertIsIssuer(
  address: string,
  issuer: string,
  action: string,
): void {
  if (address !== issuer) {
    throw new ChainError(
      `Only ${issuer} can ${action} on this tokenization; the contract ` +
        `requires ${address}'s own signature, which this server does not hold.`,
    );
  }
}

function requireContractId(input: RwaOperationInput): string {
  if (!input.contractId) {
    throw new ChainError(
      `The '${input.transition}' operation needs a deployed token contract`,
    );
  }
  return input.contractId;
}

function requireHolder(input: RwaOperationInput): string {
  if (!input.holderAddress) {
    throw new ChainError(
      `The '${input.transition}' operation needs a holder address`,
    );
  }
  return input.holderAddress;
}

/**
 * Soroban RPC gateway for the RWA token contract.
 *
 * Submits real Soroban transactions via the {@link Signer} boundary. Read
 * calls are simulated and need no signature.
 *
 * Who signs the writes depends on `RWA_CUSTODY`:
 *
 *   platform — the server signer is the on-chain issuer. It deploys each
 *     tokenization, holds the initial supply, and authorizes every
 *     issuer-gated operation in a single call.
 *   issuer   — the issuer's own SEP-10 wallet is the on-chain issuer. The
 *     server still pays to deploy the instance (that needs no contract
 *     authorization), but `initialize`, `transfer`, `authorize`, `freeze`,
 *     and `mark_distributed` are assembled here and signed in the issuer's
 *     wallet, with their account as the transaction source so a single
 *     envelope signature satisfies `require_auth()`.
 *
 * Callers are told which via {@link RwaGateway.signingMode} and refused if
 * they ask for an address this server cannot sign for, rather than having one
 * substituted for them.
 *
 * Scope note: the contract gates `transfer` with `from.require_auth()`, so a
 * secondary/resale transfer between two investors needs the *seller's*
 * signature and is not driven from here under either custody model.
 *
 * Every write is verified before it is reported as done: the contract's
 * `Result` is unwrapped (a Rust `Err` does not throw on its own) and, for the
 * operations that move or gate property, the resulting state is read back.
 */
export class SorobanRpcRwaGateway implements RwaGateway {
  constructor(
    private readonly signer: Signer,
    private readonly addresses: WalletAddressResolver,
    private readonly custodyMode: RwaCustodyMode = config.RWA_CUSTODY,
  ) {}

  custody(): RwaCustodyMode {
    return this.custodyMode;
  }

  async signingMode(transition: RwaTransition): Promise<ChainSigningMode> {
    if (!ISSUER_SIGNED.includes(transition)) return ChainSigningMode.None;
    return this.custodyMode === RwaCustodyMode.Issuer
      ? ChainSigningMode.Wallet
      : ChainSigningMode.Server;
  }

  async issuerAddress(issuerUserId: string): Promise<string> {
    return this.custodyMode === RwaCustodyMode.Issuer
      ? this.addresses.resolve(issuerUserId, "issuer")
      : this.signer.getPublicKey();
  }

  private async client(contractId: string): Promise<RwaContractClient> {
    return (await getContractClient(
      contractId,
      this.signer,
    )) as unknown as RwaContractClient;
  }

  /** A spec-aware client whose source is an account we hold no key for. */
  private async unsignedClient(
    contractId: string,
    sourceAddress: string,
  ): Promise<RwaContractClient> {
    return (await getUnsignedContractClient(
      contractId,
      sourceAddress,
    )) as unknown as RwaContractClient;
  }

  // ── Wallet-signed operations (issuer custody) ─────────────────────────────

  async prepareOperation(
    input: RwaOperationInput,
  ): Promise<PreparedRwaOperation> {
    if ((await this.signingMode(input.transition)) !== ChainSigningMode.Wallet) {
      throw new ChainError(
        `The '${input.transition}' operation is signed by the server here`,
      );
    }
    const issuer = await this.issuerAddress(input.issuerUserId);
    // Deploying costs a transaction but needs no contract authorization, so the
    // server can do it. Doing it up front means an abandoned signature costs
    // one idle contract rather than one per retry.
    const contractId =
      input.transition === RwaTransition.Deploy
        ? (input.contractId ?? (await this.deployInstance()))
        : requireContractId(input);

    const client = await this.unsignedClient(contractId, issuer);
    const tx = await this.buildOperation(client, input, issuer);
    const unsigned = toUnsignedTransaction(tx, issuer);

    return {
      transition: input.transition,
      unsignedXdr: unsigned.xdr,
      networkPassphrase: unsigned.networkPassphrase,
      signerAddress: issuer,
      contractId,
      expiresAt: new Date(
        Date.now() + config.ESCROW_PREPARED_TX_TTL_SECONDS * 1_000,
      ).toISOString(),
    };
  }

  /** The contract call each operation maps to. Names mirror the Rust. */
  private async buildOperation(
    client: RwaContractClient,
    input: RwaOperationInput,
    issuer: string,
  ): Promise<ContractTx<ContractResult<void>>> {
    switch (input.transition) {
      case RwaTransition.Deploy: {
        if (!input.deploy) throw new ChainError("Deploy terms are required");
        return client.initialize({
          issuer,
          asset_ref: input.deploy.assetRef,
          asset_type: {
            tag: assetTypeTag(input.deploy.assetType),
            values: undefined,
          },
          description: input.deploy.description,
          total_units: input.deploy.totalUnits,
          require_authorization: input.deploy.requireAuthorization,
        });
      }
      case RwaTransition.Transfer: {
        if (!input.transfer) throw new ChainError("Transfer terms are required");
        return client.transfer({
          from: issuer,
          to: input.transfer.to,
          units: input.transfer.units,
        });
      }
      case RwaTransition.Authorize:
        return client.authorize({ address: requireHolder(input) });
      case RwaTransition.Revoke:
        return client.revoke_authorization({ address: requireHolder(input) });
      case RwaTransition.Freeze:
        return client.freeze();
      case RwaTransition.Unfreeze:
        return client.unfreeze();
      case RwaTransition.Distribute:
        return client.mark_distributed();
      default:
        throw new ChainError(
          `No contract call is defined for '${input.transition}'`,
        );
    }
  }

  async submitSignedOperation(
    input: RwaOperationInput,
    signedXdr: string,
  ): Promise<RwaOperationReceipt> {
    const contractId = requireContractId(input);
    const submitted = await submitSignedTransaction(signedXdr);
    if (submitted.status !== ChainTxStatus.Success) {
      throw new ChainError(
        `The RWA ${input.transition} transaction did not succeed on-chain ` +
          `(status ${submitted.status}, hash ${submitted.hash})`,
      );
    }
    // Read the contract back rather than trusting the envelope: the only thing
    // that authorizes a records change is the state the contract is in now.
    await this.assertOperationApplied(input, contractId);
    return { contractId, hash: submitted.hash };
  }

  /** Confirm the signed operation actually took effect on the contract. */
  private async assertOperationApplied(
    input: RwaOperationInput,
    contractId: string,
  ): Promise<void> {
    switch (input.transition) {
      case RwaTransition.Deploy: {
        const meta = await this.getContractMeta(contractId);
        const issuer = await this.issuerAddress(input.issuerUserId);
        if (
          !meta ||
          meta.issuer !== issuer ||
          meta.totalUnits !== input.deploy?.totalUnits
        ) {
          throw new ChainError(
            `RWA contract ${contractId} did not initialize with the terms ` +
              "this tokenization records",
          );
        }
        return;
      }
      case RwaTransition.Transfer: {
        if (!input.transfer) return;
        const held = await this.getBalance(contractId, input.transfer.to);
        if (held < input.transfer.units) {
          throw new ChainError(
            `RWA contract ${contractId} shows ${held} units at ` +
              `${input.transfer.to} after a transfer of ${input.transfer.units}`,
          );
        }
        return;
      }
      case RwaTransition.Authorize:
      case RwaTransition.Revoke: {
        const expected = input.transition === RwaTransition.Authorize;
        const actual = await this.isAuthorized(
          contractId,
          requireHolder(input),
        );
        if (actual !== expected) {
          throw new ChainError(
            `RWA contract ${contractId} did not apply the authorization change`,
          );
        }
        return;
      }
      case RwaTransition.Freeze:
      case RwaTransition.Unfreeze:
        await this.assertFrozen(
          contractId,
          input.transition === RwaTransition.Freeze,
        );
        return;
      case RwaTransition.Distribute: {
        const meta = await this.getContractMeta(contractId);
        if (!meta?.distributed) {
          throw new ChainError(
            `RWA contract ${contractId} did not record the payout guard`,
          );
        }
        return;
      }
    }
  }

  /**
   * Refuse a server-signed call the issuer is supposed to authorize.
   *
   * Under issuer custody the server is not the contract's issuer, so these
   * calls would be rejected on-chain — but only after the books had recorded
   * the change and the fee had been paid.
   */
  private async assertServerSigned(transition: RwaTransition): Promise<void> {
    if ((await this.signingMode(transition)) === ChainSigningMode.Wallet) {
      throw new ChainError(
        `The '${transition}' operation must be signed by the issuer's wallet ` +
          "under issuer custody. Use the prepare/submit endpoints.",
      );
    }
  }

  /** Create an uninitialized instance from the configured WASM hash. */
  private async deployInstance(): Promise<string> {
    const wasmHash = config.RWA_WASM_HASH;
    if (!wasmHash) {
      throw new ChainError(
        "RWA_WASM_HASH is not configured; cannot deploy RWA token contract",
      );
    }
    return deployFromWasmHash(wasmHash, this.signer);
  }

  // ── Server-signed operations (platform custody) ───────────────────────────

  /** Deploy a fresh token contract instance and initialize it with the issuer. */
  async deployToken(input: DeployTokenInput): Promise<string> {
    await this.assertServerSigned(RwaTransition.Deploy);
    if (input.totalUnits <= 0n) {
      throw new ChainError("Total units must be positive");
    }
    const issuer = await this.issuerAddress(input.issuerUserId);
    assertIsIssuer(input.issuerAddress, issuer, "issue a tokenization");

    const contractId = await this.deployInstance();

    const client = await this.client(contractId);
    await signAndSendChecked(
      "rwa initialize",
      await this.buildOperation(
        client,
        { transition: RwaTransition.Deploy, issuerUserId: input.issuerUserId, contractId, deploy: input },
        issuer,
      ),
    );

    // Read the tokenization back. A deploy that initialized with different
    // terms than we asked for is not a tokenization we can pay out against.
    const meta = await this.getContractMeta(contractId);
    if (!meta) {
      throw new ChainError(
        `RWA contract ${contractId} could not be read back after deployment`,
      );
    }
    if (meta.issuer !== issuer || meta.totalUnits !== input.totalUnits) {
      throw new ChainError(
        `RWA contract ${contractId} initialized as ${meta.totalUnits} units ` +
          `held by ${meta.issuer}; expected ${input.totalUnits} held by ${issuer}`,
      );
    }
    return contractId;
  }

  async transferUnits(input: TransferUnitsInput): Promise<void> {
    await this.assertServerSigned(RwaTransition.Transfer);
    if (input.units <= 0n) {
      throw new ChainError("Transfer amount must be positive");
    }
    // The contract gates `transfer` with `from.require_auth()`, so the only
    // `from` this server can authorize is its own account.
    const from = await this.issuerAddress(input.issuerUserId);
    assertIsIssuer(input.from, from, "transfer units");

    const client = await this.client(input.contractId);
    const before = await this.getBalance(input.contractId, input.to);
    await signAndSendChecked(
      "rwa transfer",
      await client.transfer({ from, to: input.to, units: input.units }),
    );

    // Units are property. Recording a purchase the contract did not actually
    // execute would leave a holder owed units nobody holds.
    const after = await this.getBalance(input.contractId, input.to);
    if (after - before !== input.units) {
      throw new ChainError(
        `RWA transfer of ${input.units} units to ${input.to} moved ` +
          `${after - before} units on-chain`,
      );
    }
  }

  async authorizeHolder(input: AuthorizeHolderInput): Promise<void> {
    await this.assertServerSigned(RwaTransition.Authorize);
    const client = await this.client(input.contractId);
    await signAndSendChecked(
      "rwa authorize",
      await client.authorize({ address: input.holderAddress }),
    );
    // `authorize` is a silent no-op when the contract does not require
    // authorization, so an unauthorized answer here is a real refusal.
    if (!(await this.isAuthorized(input.contractId, input.holderAddress))) {
      throw new ChainError(
        `RWA contract ${input.contractId} did not authorize ${input.holderAddress}`,
      );
    }
  }

  async revokeAuthorization(input: AuthorizeHolderInput): Promise<void> {
    await this.assertServerSigned(RwaTransition.Revoke);
    const client = await this.client(input.contractId);
    await signAndSendChecked(
      "rwa revoke_authorization",
      await client.revoke_authorization({ address: input.holderAddress }),
    );
  }

  async freezeToken(contractId: string): Promise<void> {
    await this.assertServerSigned(RwaTransition.Freeze);
    const client = await this.client(contractId);
    await signAndSendChecked("rwa freeze", await client.freeze());
    await this.assertFrozen(contractId, true);
  }

  async unfreezeToken(contractId: string): Promise<void> {
    await this.assertServerSigned(RwaTransition.Unfreeze);
    const client = await this.client(contractId);
    await signAndSendChecked("rwa unfreeze", await client.unfreeze());
    await this.assertFrozen(contractId, false);
  }

  /** Freezing is a compliance control; confirm the contract actually applied it. */
  private async assertFrozen(
    contractId: string,
    expected: boolean,
  ): Promise<void> {
    const meta = await this.getContractMeta(contractId);
    if (!meta || meta.frozen !== expected) {
      throw new ChainError(
        `RWA contract ${contractId} is ${meta ? `frozen=${meta.frozen}` : "unreadable"} ` +
          `after the ${expected ? "freeze" : "unfreeze"}`,
      );
    }
  }

  async getBalance(contractId: string, holderAddress: string): Promise<bigint> {
    const client = await this.client(contractId);
    const tx = await client.balance_of({ holder: holderAddress });
    return unwrapContractResult<bigint>("rwa balance_of", tx.result);
  }

  async getHolderBalances(contractId: string): Promise<HolderBalance[]> {
    const client = await this.client(contractId);
    const holdersTx = await client.get_holders();
    const holders = unwrapContractResult<string[]>(
      "rwa get_holders",
      holdersTx.result,
    );
    // Balances are read individually rather than inferred from payout shares:
    // a share is a rounded quotient, and unit counts must be exact.
    return Promise.all(
      holders.map(async (holderAddress) => ({
        holderAddress,
        units: await this.getBalance(contractId, holderAddress),
      })),
    );
  }

  async getPayoutShares(input: PayoutSharesInput): Promise<PayoutShare[]> {
    if (input.payoutAmount < 0n) {
      throw new ChainError("Payout amount cannot be negative");
    }
    const client = await this.client(input.contractId);
    const tx = await client.all_payout_shares({ payout: input.payoutAmount });
    return unwrapContractResult<Array<readonly [string, bigint]>>(
      "rwa all_payout_shares",
      tx.result,
    ).map(([holderAddress, shareAmount]) => ({ holderAddress, shareAmount }));
  }

  async markDistributed(contractId: string): Promise<void> {
    await this.assertServerSigned(RwaTransition.Distribute);
    const client = await this.client(contractId);
    await signAndSendChecked(
      "rwa mark_distributed",
      await client.mark_distributed(),
    );
  }

  async isAuthorized(contractId: string, address: string): Promise<boolean> {
    const client = await this.client(contractId);
    const tx = await client.is_authorized({ address });
    return unwrapContractResult<boolean>("rwa is_authorized", tx.result);
  }

  async getContractMeta(contractId: string): Promise<
    | {
        issuer: string;
        assetRef: string;
        totalUnits: bigint;
        frozen: boolean;
        distributed: boolean;
      }
    | undefined
  > {
    let client: RwaContractClient;
    try {
      client = await this.client(contractId);
    } catch (err) {
      // Only a genuinely unknown contract maps to "not found". An RPC failure
      // must propagate: callers treat `undefined` as "this tokenization does
      // not exist on-chain", and an outage is not evidence of that.
      if (isMissingContractError(err)) return undefined;
      throw new ChainError(
        `Could not read RWA contract ${contractId} from the network`,
        err,
      );
    }
    const tx = await client.get_meta();
    const meta = unwrapContractResult<RwaContractMeta>(
      "rwa get_meta",
      tx.result,
    );
    return {
      issuer: meta.issuer,
      assetRef: meta.asset_ref,
      totalUnits: meta.total_units,
      frozen: meta.frozen,
      distributed: meta.distributed,
    };
  }
}

/** Map the shared {@link AssetType} to the contract enum's Rust variant tag. */
function assetTypeTag(assetType: AssetType): string {
  switch (assetType) {
    case AssetType.Invoice:
      return "Invoice";
    case AssetType.Commodity:
      return "Commodity";
    case AssetType.RealEstate:
      return "RealEstate";
    case AssetType.Other:
    default:
      return "Other";
  }
}

/**
 * Structural view of the spec-generated client for the RWA token contract.
 * `contract.Client` builds these methods dynamically from the on-chain spec;
 * this interface types the exact surface the gateway invokes. Method and
 * argument names mirror the Rust contract (snake_case). Methods declared
 * `Result<…, Error>` in Rust resolve to a {@link ContractResult}.
 */
interface RwaContractClient {
  initialize(args: {
    issuer: string;
    asset_ref: string;
    asset_type: { tag: string; values: undefined };
    description: string;
    total_units: bigint;
    require_authorization: boolean;
  }): Promise<ContractTx<ContractResult<void>>>;
  transfer(args: {
    from: string;
    to: string;
    units: bigint;
  }): Promise<ContractTx<ContractResult<void>>>;
  balance_of(args: { holder: string }): Promise<ContractTx<ContractResult<bigint>>>;
  authorize(args: { address: string }): Promise<ContractTx<ContractResult<void>>>;
  revoke_authorization(args: {
    address: string;
  }): Promise<ContractTx<ContractResult<void>>>;
  freeze(): Promise<ContractTx<ContractResult<void>>>;
  unfreeze(): Promise<ContractTx<ContractResult<void>>>;
  is_authorized(args: {
    address: string;
  }): Promise<ContractTx<ContractResult<boolean>>>;
  get_holders(): Promise<ContractTx<ContractResult<string[]>>>;
  mark_distributed(): Promise<ContractTx<ContractResult<void>>>;
  all_payout_shares(args: {
    payout: bigint;
  }): Promise<ContractTx<ContractResult<Array<readonly [string, bigint]>>>>;
  get_meta(): Promise<ContractTx<ContractResult<RwaContractMeta>>>;
}

interface RwaContractMeta {
  issuer: string;
  asset_ref: string;
  asset_type: unknown;
  description: string;
  total_units: bigint;
  distributed: boolean;
  frozen: boolean;
  require_authorization: boolean;
}

/**
 * Factory function to create the appropriate gateway based on configuration.
 * Fails closed rather than running a synthetic chain adapter outside local/test.
 */
export function createRwaGateway(
  addresses: WalletAddressResolver,
): RwaGateway {
  const gatewayType = config.RWA_GATEWAY ?? "deterministic";

  if (gatewayType === "deterministic") {
    if (config.NODE_ENV === "staging" || config.NODE_ENV === "production") {
      throw new Error(
        "RWA_GATEWAY=deterministic is forbidden outside development/test",
      );
    }
    return new DeterministicRwaGateway(config.RWA_CUSTODY, addresses);
  }

  if (gatewayType === "soroban-rpc") {
    return new SorobanRpcRwaGateway(createSigner(), addresses, config.RWA_CUSTODY);
  }

  throw new Error(`Unknown RWA_GATEWAY type: ${gatewayType}`);
}
