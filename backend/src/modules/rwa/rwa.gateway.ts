/**
 * Phase 5: RWA Gateway
 * Boundary interface to the Soroban RWA token contract.
 * 
 * Architecture: The gateway abstracts blockchain operations behind a clean
 * interface. Local/test uses DeterministicRwaGateway; staging/production
 * must use a KMS-backed Soroban RPC adapter.
 */

import { randomUUID } from "node:crypto";
import { ChainError } from "../../lib/errors.js";
import { config } from "../../config/index.js";
import type { AssetType } from "./rwa.types.js";

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

/**
 * Gateway interface for RWA token contract operations.
 */
export interface RwaGateway {
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

  async deployToken(input: DeployTokenInput): Promise<string> {
    if (input.totalUnits <= 0n) {
      throw new ChainError("Total units must be positive");
    }

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

  private requireContract(contractId: string): ContractState {
    const contract = this.contracts.get(contractId);
    if (!contract) {
      throw new ChainError(`RWA contract ${contractId} not found`);
    }
    return contract;
  }

  /**
   * Test helper: get all holder addresses with non-zero balances.
   */
  async getHolders(contractId: string): Promise<string[]> {
    const contract = this.requireContract(contractId);
    return Array.from(contract.balances.entries())
      .filter(([_, balance]) => balance > 0n)
      .map(([address, _]) => address);
  }
}

/**
 * Soroban RPC gateway for staging/production.
 * Requires KMS/HSM for signing and Soroban RPC endpoint.
 * 
 * This is a placeholder for the production implementation.
 */
export class SorobanRpcRwaGateway implements RwaGateway {
  constructor(
    _rpcUrl: string,
    _networkPassphrase: string,
    _signerService: unknown, // KMS/HSM signing service
  ) {}

  async deployToken(_input: DeployTokenInput): Promise<string> {
    throw new Error(
      "SorobanRpcRwaGateway.deployToken: Production implementation required. " +
      "Must use stellar-sdk to build deploy transaction, sign via KMS, and submit to Soroban RPC.",
    );
  }

  async transferUnits(_input: TransferUnitsInput): Promise<void> {
    throw new Error(
      "SorobanRpcRwaGateway.transferUnits: Production implementation required.",
    );
  }

  async authorizeHolder(_input: AuthorizeHolderInput): Promise<void> {
    throw new Error(
      "SorobanRpcRwaGateway.authorizeHolder: Production implementation required.",
    );
  }

  async revokeAuthorization(_input: AuthorizeHolderInput): Promise<void> {
    throw new Error(
      "SorobanRpcRwaGateway.revokeAuthorization: Production implementation required.",
    );
  }

  async freezeToken(_contractId: string): Promise<void> {
    throw new Error(
      "SorobanRpcRwaGateway.freezeToken: Production implementation required.",
    );
  }

  async unfreezeToken(_contractId: string): Promise<void> {
    throw new Error(
      "SorobanRpcRwaGateway.unfreezeToken: Production implementation required.",
    );
  }

  async getBalance(_contractId: string, _holderAddress: string): Promise<bigint> {
    throw new Error(
      "SorobanRpcRwaGateway.getBalance: Production implementation required.",
    );
  }

  async getPayoutShares(_input: PayoutSharesInput): Promise<PayoutShare[]> {
    throw new Error(
      "SorobanRpcRwaGateway.getPayoutShares: Production implementation required.",
    );
  }

  async markDistributed(_contractId: string): Promise<void> {
    throw new Error(
      "SorobanRpcRwaGateway.markDistributed: Production implementation required.",
    );
  }

  async isAuthorized(_contractId: string, _address: string): Promise<boolean> {
    throw new Error(
      "SorobanRpcRwaGateway.isAuthorized: Production implementation required.",
    );
  }

  async getContractMeta(_contractId: string): Promise<{
    issuer: string;
    assetRef: string;
    totalUnits: bigint;
    frozen: boolean;
    distributed: boolean;
  } | undefined> {
    throw new Error(
      "SorobanRpcRwaGateway.getContractMeta: Production implementation required.",
    );
  }
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
    throw new Error(
      "RWA_GATEWAY=soroban-rpc requires the KMS-backed production adapter. " +
      "SorobanRpcRwaGateway implementation is incomplete.",
    );
  }

  throw new Error(`Unknown RWA_GATEWAY type: ${gatewayType}`);
}
