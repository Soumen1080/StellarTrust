import { createHash, randomUUID } from "node:crypto";
import {
  ChainTxStatus,
  EscrowState,
  PaymentTransition,
  type CurrencyCode,
} from "@stellartrust/shared";
import { ChainError } from "../../lib/errors.js";

export interface ChainTransitionInput {
  orderId: string;
  transition: PaymentTransition;
  amount: string;
  currency: CurrencyCode;
  buyerId: string;
  sellerId: string;
  contractId: string | null;
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

export interface EscrowGateway {
  submitTransition(input: ChainTransitionInput): Promise<ChainReceipt>;
  getTransaction(hash: string): Promise<ChainReceipt | undefined>;
  getEscrowState(contractId: string): Promise<EscrowState | undefined>;
}

interface ContractSnapshot {
  state: EscrowState;
  orderId: string;
  deliveryConfirmed: boolean;
}

/**
 * Deterministic local/test adapter for the Soroban boundary. It enforces the
 * same lock/release/refund state machine as the Rust contract without holding
 * any signing key. Staging/production must replace this adapter with a KMS-
 * backed testnet/mainnet submitter.
 */
export class DeterministicEscrowGateway implements EscrowGateway {
  private readonly transactions = new Map<string, ChainReceipt>();
  private readonly contracts = new Map<string, ContractSnapshot>();

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
      if (input.transition === PaymentTransition.Release) {
        if (
          contract.state !== EscrowState.Locked ||
          !contract.deliveryConfirmed
        ) {
          throw new ChainError(
            "Release requires locked escrow and buyer confirmation",
          );
        }
        contract.state = EscrowState.Released;
      }
      if (input.transition === PaymentTransition.Refund) {
        if (contract.state !== EscrowState.Locked) {
          throw new ChainError("Only locked escrow can be refunded");
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

  async getTransaction(hash: string): Promise<ChainReceipt | undefined> {
    return this.transactions.get(hash);
  }

  async getEscrowState(contractId: string): Promise<EscrowState | undefined> {
    return this.contracts.get(contractId)?.state;
  }
}
