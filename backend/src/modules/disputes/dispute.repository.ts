/**
 * Dispute persistence boundary (Phase 4).
 *
 * In-memory store behind an interface (staging/production swaps a Postgres
 * adapter). The dispute record is the auditable authority for a resolution;
 * fund movement remains the compliance-operated escrow/payments arbiter path.
 */
import type {
  DisputeDTO,
  DisputeResolution,
  EscrowDTO,
  OrderDTO,
} from "@stellartrust/shared";

/**
 * Narrow port into the payments bounded context so disputes can validate the
 * order and read its amount/parties without a direct table/module dependency
 * (Rules.md §2: cross-module calls go through service interfaces).
 */
export interface DisputeOrderGateway {
  getOrder(orderId: string): Promise<OrderDTO | undefined>;
  /**
   * The custody instance the order's funds sit in, so a dispute can name the
   * contract it is about rather than being a purely off-chain record.
   */
  getEscrow(orderId: string): Promise<EscrowDTO | undefined>;
}

/**
 * Port for moving the escrow contract itself into `Disputed`.
 *
 * Opening a dispute in the database and freezing the funds on-chain are two
 * different acts, and only the second one binds. The contract's `release`
 * accepts `Disputed` or a buyer confirmation and nothing else, so an escrow
 * that was never moved to `Disputed` on-chain cannot be settled by the arbiter
 * when the dispute resolves — the claim would be adjudicated and then stall.
 *
 * Best-effort by design: where the contract demands the party's own signature
 * the server cannot produce it, and the dispute record still stands.
 */
export interface DisputeChainGateway {
  markDisputed(input: { orderId: string; actorUserId: string }): Promise<void>;
}

/**
 * Port to execute a resolved dispute's fund movement through the Phase 2
 * arbiter escrow/payments path (Phase 6). Keeps disputes decoupled from the
 * payment service internals; the composition root supplies the adapter.
 */
export interface DisputeSettlementGateway {
  settle(input: {
    orderId: string;
    outcome: DisputeResolution;
    disputeId: string;
  }): Promise<void>;
}

export interface DisputeRepository {
  save(dispute: DisputeDTO): Promise<void>;
  find(disputeId: string): Promise<DisputeDTO | undefined>;
  findOpenByOrder(orderId: string): Promise<DisputeDTO | undefined>;
  /**
   * Every dispute the user is a party to — as buyer OR seller, not merely the
   * one who opened it. Listing by opener alone hid a claim from the person it
   * was filed against, who then could not answer it inside the evidence window.
   */
  listForParty(userId: string): Promise<DisputeDTO[]>;
  /**
   * Every record, newest first — the admin console's platform-wide view
   * (plane.md admin panel).
   *
   * Separate from the user-scoped list rather than a filter on it. The
   * caller-scoped read is the one every ordinary endpoint uses, and making
   * "no user" mean "everyone" would turn a forgotten argument into a data
   * leak. The routes that reach this are behind the compliance role.
   */
  listAllDisputes(limit?: number): Promise<DisputeDTO[]>;
  listOpen(): Promise<DisputeDTO[]>;
}

export class InMemoryDisputeRepository implements DisputeRepository {
  private readonly disputes = new Map<string, DisputeDTO>();

  async save(dispute: DisputeDTO): Promise<void> {
    // Upsert. Callers construct the full next-state snapshot before saving so a
    // dispute never persists in a partially-updated state.
    this.disputes.set(dispute.id, dispute);
  }

  async find(disputeId: string): Promise<DisputeDTO | undefined> {
    return this.disputes.get(disputeId);
  }

  async findOpenByOrder(orderId: string): Promise<DisputeDTO | undefined> {
    return [...this.disputes.values()].find(
      (dispute) =>
        dispute.orderId === orderId && dispute.resolution === null,
    );
  }

  async listForParty(userId: string): Promise<DisputeDTO[]> {
    return [...this.disputes.values()]
      .filter(
        (dispute) =>
          dispute.buyerId === userId || dispute.sellerId === userId,
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async listAllDisputes(limit = 500): Promise<DisputeDTO[]> {
    return [...this.disputes.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  async listOpen(): Promise<DisputeDTO[]> {
    return [...this.disputes.values()]
      .filter((dispute) => dispute.resolution === null)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
}
