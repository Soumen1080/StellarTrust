/**
 * Treasury persistence boundary.
 *
 * The one thing this store must guarantee is that a Stellar transaction hash
 * can be claimed **once**. That is not a convention — it is a unique index in
 * Postgres (migration 0021) and a map key here, because two requests racing
 * the same hash is exactly how a deposit gets credited twice, and the only
 * component that can settle a race between two API instances is the database.
 */
import { randomUUID } from "node:crypto";
import { ConflictError } from "../../lib/errors.js";
import {
  TreasuryStatus,
  type TreasuryDirection,
  type TreasuryMovementDTO,
} from "./treasury.types.js";

export interface CreateMovementInput {
  userId: string;
  direction: TreasuryDirection;
  status: TreasuryStatus;
  amount: string;
  currency: string;
  stellarTxHash: string | null;
  counterpartyAddress: string;
  ledgerTransactionId: string | null;
}

export interface TreasuryRepository {
  /**
   * Record a movement. Throws {@link ConflictError} when its transaction hash
   * has already been claimed — which is the deposit double-credit guard, so it
   * must be a real uniqueness failure and never a silent overwrite.
   */
  create(input: CreateMovementInput): Promise<TreasuryMovementDTO>;
  update(movement: TreasuryMovementDTO): Promise<TreasuryMovementDTO>;
  findById(id: string): Promise<TreasuryMovementDTO | undefined>;
  findByTxHash(txHash: string): Promise<TreasuryMovementDTO | undefined>;
  listForUser(userId: string): Promise<TreasuryMovementDTO[]>;
  /** Every movement, newest first. Compliance/admin read (plane.md admin panel). */
  listAll(filter?: {
    status?: TreasuryStatus;
    direction?: TreasuryDirection;
    limit?: number;
  }): Promise<TreasuryMovementDTO[]>;
}

export class InMemoryTreasuryRepository implements TreasuryRepository {
  private readonly movements = new Map<string, TreasuryMovementDTO>();
  private readonly byTxHash = new Map<string, string>();

  async create(input: CreateMovementInput): Promise<TreasuryMovementDTO> {
    if (input.stellarTxHash && this.byTxHash.has(input.stellarTxHash)) {
      throw new ConflictError(
        "This Stellar transaction has already been credited",
      );
    }
    const now = new Date().toISOString();
    const movement: TreasuryMovementDTO = {
      id: randomUUID(),
      userId: input.userId,
      direction: input.direction,
      status: input.status,
      amount: input.amount,
      currency: input.currency as TreasuryMovementDTO["currency"],
      stellarTxHash: input.stellarTxHash,
      counterpartyAddress: input.counterpartyAddress,
      ledgerTransactionId: input.ledgerTransactionId,
      failureReason: null,
      createdAt: now,
      completedAt: input.status === TreasuryStatus.Completed ? now : null,
    };
    this.movements.set(movement.id, movement);
    if (movement.stellarTxHash) {
      this.byTxHash.set(movement.stellarTxHash, movement.id);
    }
    return movement;
  }

  async update(movement: TreasuryMovementDTO): Promise<TreasuryMovementDTO> {
    const existing = this.movements.get(movement.id);
    if (!existing) throw new ConflictError("Movement no longer exists");
    // A hash assigned after the fact (a withdrawal, once submitted) still has
    // to claim the uniqueness slot, or a resubmission could record two
    // movements for one payment.
    if (movement.stellarTxHash && movement.stellarTxHash !== existing.stellarTxHash) {
      const claimed = this.byTxHash.get(movement.stellarTxHash);
      if (claimed && claimed !== movement.id) {
        throw new ConflictError(
          "This Stellar transaction is already recorded against another movement",
        );
      }
      this.byTxHash.set(movement.stellarTxHash, movement.id);
    }
    this.movements.set(movement.id, movement);
    return movement;
  }

  async findById(id: string): Promise<TreasuryMovementDTO | undefined> {
    return this.movements.get(id);
  }

  async findByTxHash(txHash: string): Promise<TreasuryMovementDTO | undefined> {
    const id = this.byTxHash.get(txHash);
    return id ? this.movements.get(id) : undefined;
  }

  async listForUser(userId: string): Promise<TreasuryMovementDTO[]> {
    return [...this.movements.values()]
      .filter((movement) => movement.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async listAll(filter?: {
    status?: TreasuryStatus;
    direction?: TreasuryDirection;
    limit?: number;
  }): Promise<TreasuryMovementDTO[]> {
    let rows = [...this.movements.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
    if (filter?.status) {
      rows = rows.filter((movement) => movement.status === filter.status);
    }
    if (filter?.direction) {
      rows = rows.filter((movement) => movement.direction === filter.direction);
    }
    return filter?.limit ? rows.slice(0, filter.limit) : rows;
  }
}
