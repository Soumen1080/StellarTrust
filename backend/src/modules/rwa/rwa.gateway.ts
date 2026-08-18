/**
 * Phase 5: RWA Gateway
 * Boundary interface to the Soroban RWA token contract.
 * 
 * Architecture: The gateway abstracts blockchain operations behind a clean
 * interface. Local/test uses DeterministicRwaGateway; staging/production
 * must use a KMS-backed Soroban RPC adapter.
 */

import { randomUUID } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import { ChainError } from "../../lib/errors.js";
import { config } from "../../config/index.js";
import { createSigner, type Signer } from "../stellar/signer.js";
import {
  deployFromWasmHash,
  getContractClient,
  isMissingContractError,
  signAndSendChecked,
  unwrapContractResult,
  type ContractResult,
  type ContractTx,
} from "../stellar/soroban.client.js";
import { AssetType } from "./rwa.types.js";

export interface DeployTokenInput {
  issuerAddress: string;
  assetRef: string;
  assetType: AssetType;
  description: string;
  totalUnits: bigint;
  requireAuthorization: boolean;
}

export interface TransferUnitsInput {
  contractId: string;
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
  /**
   * The Stellar account this gateway can actually authorize as.
   *
   * The token contract gates `transfer` with `from.require_auth()` and every
   * admin operation with `issuer.require_auth()`. A server-side gateway can
   * only satisfy those for the one account it holds a key for, so that account
   * is the on-chain issuer and the source of every distributed unit —
   * regardless of which internal user the tokenization is recorded against.
   *
   * Exposed rather than assumed so callers pass the right address instead of
   * having a different one silently substituted, and so both adapters key
   * balances by the same value.
   */
  custodianAddress(): Promise<string>;

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

  /**
   * A stable, structurally valid `G…` account standing in for the server
   * signer. Derived rather than hard-coded so it is a real strkey — the same
   * address-shaped value the Soroban adapter would return, so code paths that
   * validate addresses behave identically under both.
   */
  private readonly custodian = Keypair.fromRawEd25519Seed(
    Buffer.alloc(32, 7),
  ).publicKey();

  async custodianAddress(): Promise<string> {
    return this.custodian;
  }

  async deployToken(input: DeployTokenInput): Promise<string> {
    if (input.totalUnits <= 0n) {
      throw new ChainError("Total units must be positive");
    }
    assertIsCustodian(
      input.issuerAddress,
      this.custodian,
      "issue a tokenization",
    );

    const contractId = `rwa-contract-${randomUUID()}`;
    const balances = new Map<string, bigint>();
    
    // Issuer holds all units initially
    balances.set(input.issuerAddress, input.totalUnits);

    const authorized = new Set<string>();
    // If authorization is required, auto-authorize the issuer
    if (input.requireAuthorization) {
      authorized.add(input.issuerAddress);
    }

    this.contracts.set(contractId, {
      issuer: input.issuerAddress,
      assetRef: input.assetRef,
      assetType: input.assetType,
      description: input.description,
      totalUnits: input.totalUnits,
      requireAuthorization: input.requireAuthorization,
      frozen: false,
      distributed: false,
      balances,
      authorized,
    });

    return contractId;
  }

  async transferUnits(input: TransferUnitsInput): Promise<void> {
    const contract = this.requireContract(input.contractId);

    if (contract.frozen) {
      throw new ChainError("Transfers are frozen on this contract");
    }

    if (input.units <= 0n) {
      throw new ChainError("Transfer amount must be positive");
    }

    // The contract gates `transfer` with `from.require_auth()`. Only the
    // custodian's signature exists here, so any other `from` is a call this
    // adapter must refuse exactly as the deployed contract would.
    assertIsCustodian(input.from, this.custodian, "transfer units");

    // Check authorization if required
    if (contract.requireAuthorization) {
      if (!contract.authorized.has(input.from)) {
        throw new ChainError(`Address ${input.from} is not authorized`);
      }
      if (!contract.authorized.has(input.to)) {
        throw new ChainError(`Address ${input.to} is not authorized`);
      }
    }

    const fromBalance = contract.balances.get(input.from) ?? 0n;
    if (fromBalance < input.units) {
      throw new ChainError(
        `Insufficient balance: ${fromBalance} < ${input.units}`,
      );
    }

    // Execute transfer
    contract.balances.set(input.from, fromBalance - input.units);
    const toBalance = contract.balances.get(input.to) ?? 0n;
    contract.balances.set(input.to, toBalance + input.units);
  }

  async authorizeHolder(input: AuthorizeHolderInput): Promise<void> {
    const contract = this.requireContract(input.contractId);
    
    if (!contract.requireAuthorization) {
      // No-op if authorization not required
      return;
    }

    contract.authorized.add(input.holderAddress);
  }

  async revokeAuthorization(input: AuthorizeHolderInput): Promise<void> {
    const contract = this.requireContract(input.contractId);
    
    if (!contract.requireAuthorization) {
      // No-op if authorization not required
      return;
    }

    contract.authorized.delete(input.holderAddress);
  }

  async freezeToken(contractId: string): Promise<void> {
    const contract = this.requireContract(contractId);
    contract.frozen = true;
  }

  async unfreezeToken(contractId: string): Promise<void> {
    const contract = this.requireContract(contractId);
    contract.frozen = false;
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
 * Refuse a call whose authorizing address is not the one this server can sign
 * for.
 *
 * Substituting the custodian silently — which is what the Soroban adapter used
 * to do — makes the two adapters disagree about who holds units: the local one
 * keys balances by the address it was handed, the on-chain one by the signer.
 * A green test suite then says nothing about the deployed system.
 */
function assertIsCustodian(
  address: string,
  custodian: string,
  action: string,
): void {
  if (address !== custodian) {
    throw new ChainError(
      `Only ${custodian} can ${action} through this gateway; the contract ` +
        `requires ${address}'s own signature, which this server does not hold.`,
    );
  }
}

/**
 * Soroban RPC gateway for the RWA token contract.
 *
 * Submits real Soroban transactions via the {@link Signer} boundary. The
 * server signer is the on-chain **issuer**: it deploys each tokenization's
 * contract instance, holds the initial supply, and authorizes issuer-gated
 * operations (transfer-from-issuer, authorize, freeze, mark_distributed). Read
 * calls are simulated and need no signature.
 *
 * Scope note: the token contract gates `transfer` with `from.require_auth()`.
 * Only the issuer (this signer) can therefore be the `from`. Secondary/resale
 * transfers, where a non-issuer holder is the `from`, require that holder's own
 * signature (client-side wallet) and are not driven by this server-side gateway.
 * Callers are told this via {@link RwaGateway.custodianAddress} and refused if
 * they ask for another address, rather than having one substituted for them.
 *
 * Every write is verified before it is reported as done: the contract's
 * `Result` is unwrapped (a Rust `Err` does not throw on its own) and, for the
 * operations that move or gate property, the resulting state is read back.
 */
export class SorobanRpcRwaGateway implements RwaGateway {
  constructor(private readonly signer: Signer) {}

  async custodianAddress(): Promise<string> {
    return this.signer.getPublicKey();
  }

  private async client(contractId: string): Promise<RwaContractClient> {
    return (await getContractClient(
      contractId,
      this.signer,
    )) as unknown as RwaContractClient;
  }

  /** Deploy a fresh token contract instance and initialize it with the issuer. */
  async deployToken(input: DeployTokenInput): Promise<string> {
    if (input.totalUnits <= 0n) {
      throw new ChainError("Total units must be positive");
    }
    const wasmHash = config.RWA_WASM_HASH;
    if (!wasmHash) {
      throw new ChainError(
        "RWA_WASM_HASH is not configured; cannot deploy RWA token contract",
      );
    }
    const issuer = await this.custodianAddress();
    assertIsCustodian(input.issuerAddress, issuer, "issue a tokenization");

    const contractId = await deployFromWasmHash(wasmHash, this.signer);

    const client = await this.client(contractId);
    await signAndSendChecked(
      "rwa initialize",
      await client.initialize({
        issuer,
        asset_ref: input.assetRef,
        asset_type: { tag: assetTypeTag(input.assetType), values: undefined },
        description: input.description,
        total_units: input.totalUnits,
        require_authorization: input.requireAuthorization,
      }),
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
    if (input.units <= 0n) {
      throw new ChainError("Transfer amount must be positive");
    }
    // The contract gates `transfer` with `from.require_auth()`, so the only
    // `from` this server can authorize is its own account.
    const from = await this.custodianAddress();
    assertIsCustodian(input.from, from, "transfer units");

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
    const client = await this.client(input.contractId);
    await signAndSendChecked(
      "rwa revoke_authorization",
      await client.revoke_authorization({ address: input.holderAddress }),
    );
  }

  async freezeToken(contractId: string): Promise<void> {
    const client = await this.client(contractId);
    await signAndSendChecked("rwa freeze", await client.freeze());
    await this.assertFrozen(contractId, true);
  }

  async unfreezeToken(contractId: string): Promise<void> {
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
export function createRwaGateway(): RwaGateway {
  const gatewayType = config.RWA_GATEWAY ?? "deterministic";

  if (gatewayType === "deterministic") {
    if (config.NODE_ENV === "staging" || config.NODE_ENV === "production") {
      throw new Error(
        "RWA_GATEWAY=deterministic is forbidden outside development/test",
      );
    }
    return new DeterministicRwaGateway();
  }

  if (gatewayType === "soroban-rpc") {
    return new SorobanRpcRwaGateway(createSigner());
  }

  throw new Error(`Unknown RWA_GATEWAY type: ${gatewayType}`);
}
