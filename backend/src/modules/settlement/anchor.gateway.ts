/**
 * Anchor boundary (Phase 3 — Cross-Border Settlement).
 *
 * Wraps the regulated fiat on/off ramp behind an interface (Rules.md §2) so a
 * controlled sandbox anchor can be swapped for a live SEP-6/24/31 anchor per
 * corridor without touching the settlement service. The anchor is the ONLY way
 * fiat enters/leaves; the double-entry ledger — not the anchor — is the system
 * of record (Rules.md #1). SEP-12 customer KYC is exchanged with the anchor
 * before any transfer; only an opaque customer id is retained (no raw PII).
 */
import { createHash, randomUUID } from "node:crypto";
import {
  AnchorKycStatus,
  AnchorProtocol,
  AnchorTransferStatus,
  type AnchorTransferDTO,
  type CurrencyCode,
} from "@stellartrust/shared";
import { config } from "../../config/index.js";
import { ExternalServiceError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";

export interface AnchorTransferInput {
  kind: "deposit" | "withdrawal";
  protocol: AnchorProtocol;
  amount: string;
  currency: CurrencyCode;
  customerId: string;
}

export interface AnchorKycRegistration {
  customerId: string;
  status: AnchorKycStatus;
}

export interface AnchorGateway {
  /**
   * SEP-12 KYC exchange: register/resolve a customer with the anchor. Accepts an
   * opaque application reference (never raw documents/PII) and returns the
   * anchor-side customer id used to authorize transfers on this corridor.
   */
  registerCustomer(applicationRef: string): Promise<AnchorKycRegistration>;
  /** Initiate a deposit (source funds in) or withdrawal (destination payout). */
  submitTransfer(input: AnchorTransferInput): Promise<AnchorTransferDTO>;
  getTransfer(reference: string): Promise<AnchorTransferDTO | undefined>;
}

/**
 * Deterministic controlled/sandbox anchor. Mirrors the SEP-6/24/31 deposit and
 * withdrawal lifecycle and the SEP-12 KYC exchange without moving real fiat or
 * holding any signing key. Staging/production must replace this adapter with a
 * validated live anchor client per corridor.
 */
export class SandboxAnchorGateway implements AnchorGateway {
  private readonly transfers = new Map<string, AnchorTransferDTO>();

  async registerCustomer(
    applicationRef: string,
  ): Promise<AnchorKycRegistration> {
    // Deterministic, PII-free customer id derived from the opaque reference.
    const customerId = `anchor-cust-${createHash("sha256")
      .update(applicationRef)
      .digest("hex")
      .slice(0, 24)}`;
    return { customerId, status: AnchorKycStatus.Accepted };
  }

  async submitTransfer(
    input: AnchorTransferInput,
  ): Promise<AnchorTransferDTO> {
    const reference = `anchor-${input.kind}-${randomUUID()}`;
    const transfer: AnchorTransferDTO = {
      id: randomUUID(),
      kind: input.kind,
      protocol: input.protocol,
      // The controlled sandbox settles synchronously; a live anchor would begin
      // Pending and complete asynchronously via SEP status polling/webhooks.
      status: AnchorTransferStatus.Completed,
      amount: input.amount,
      currency: input.currency,
      reference,
      customerId: input.customerId,
      createdAt: new Date().toISOString(),
    };
    this.transfers.set(reference, transfer);
    return transfer;
  }

  async getTransfer(reference: string): Promise<AnchorTransferDTO | undefined> {
    return this.transfers.get(reference);
  }
}

/** Fail closed rather than pretending a live anchor exists outside local/test. */
export function createAnchorGateway(): AnchorGateway {
  if (config.ANCHOR_GATEWAY === "sandbox") {
    if (config.NODE_ENV === "staging" || config.NODE_ENV === "production") {
      logger.error(
        "ANCHOR_GATEWAY=sandbox is forbidden outside development/test",
      );
      throw new ExternalServiceError(
        "Anchor gateway is not configured for this environment",
      );
    }
    return new SandboxAnchorGateway();
  }
  throw new ExternalServiceError(
    "ANCHOR_GATEWAY=live requires a validated per-corridor anchor client",
  );
}
