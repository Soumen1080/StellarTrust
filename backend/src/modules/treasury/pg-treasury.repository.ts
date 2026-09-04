/**
 * Postgres-backed treasury persistence (migration 0021).
 *
 * The unique index on `stellar_tx_hash` is what actually guarantees a Stellar
 * transaction is credited once. This adapter's job is to surface that
 * violation as a {@link ConflictError} rather than a raw driver error, so the
 * service can tell a user "already credited" instead of failing opaquely.
 *
 * Parameterized queries only (Rules.md §7).
 */
import type pg from "pg";
import type { CurrencyCode } from "@stellartrust/shared";
import { ConflictError } from "../../lib/errors.js";
import type {
  CreateMovementInput,
  TreasuryRepository,
} from "./treasury.repository.js";
import {
  TreasuryStatus,
  type TreasuryDirection,
  type TreasuryMovementDTO,
} from "./treasury.types.js";

interface MovementRow {
  id: string;
  user_id: string;
  direction: string;
  status: string;
  amount: string;
  currency: string;
  stellar_tx_hash: string | null;
  counterparty_address: string;
  ledger_transaction_id: string | null;
  failure_reason: string | null;
  created_at: Date | string;
  completed_at: Date | string | null;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toDTO(row: MovementRow): TreasuryMovementDTO {
  return {
    id: row.id,
    userId: row.user_id,
    direction: row.direction as TreasuryDirection,
    status: row.status as TreasuryStatus,
    amount: String(row.amount),
    currency: row.currency as CurrencyCode,
    stellarTxHash: row.stellar_tx_hash,
    counterpartyAddress: row.counterparty_address,
    ledgerTransactionId: row.ledger_transaction_id,
    failureReason: row.failure_reason,
    createdAt: toIso(row.created_at),
    completedAt: row.completed_at ? toIso(row.completed_at) : null,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "23505"
  );
}

const COLUMNS = `id, user_id, direction, status, amount, currency,
  stellar_tx_hash, counterparty_address, ledger_transaction_id,
  failure_reason, created_at, completed_at`;

export class PgTreasuryRepository implements TreasuryRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(input: CreateMovementInput): Promise<TreasuryMovementDTO> {
    try {
      const { rows } = await this.pool.query<MovementRow>(
        `insert into treasury_movements
           (user_id, direction, status, amount, currency, stellar_tx_hash,
            counterparty_address, ledger_transaction_id, completed_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8,
                 case when $3 = 'completed' then now() else null end)
         returning ${COLUMNS}`,
        [
          input.userId,
          input.direction,
          input.status,
          input.amount,
          input.currency,
          input.stellarTxHash,
          input.counterpartyAddress,
          input.ledgerTransactionId,
        ],
      );
      const row = rows[0];
      if (!row) throw new Error("Failed to create treasury movement");
      return toDTO(row);
    } catch (err) {
      if (isUniqueViolation(err)) {
        // The only unique index on this table is the transaction hash.
        throw new ConflictError(
          "This Stellar transaction has already been credited",
        );
      }
      throw err;
    }
  }

  async update(movement: TreasuryMovementDTO): Promise<TreasuryMovementDTO> {
    try {
      const { rows } = await this.pool.query<MovementRow>(
        `update treasury_movements
         set status                = $2,
             stellar_tx_hash       = $3,
             ledger_transaction_id = $4,
             failure_reason        = $5,
             completed_at          = $6
         where id = $1
         returning ${COLUMNS}`,
        [
          movement.id,
          movement.status,
          movement.stellarTxHash,
          movement.ledgerTransactionId,
          movement.failureReason,
          movement.completedAt,
        ],
      );
      const row = rows[0];
      if (!row) throw new ConflictError("Movement no longer exists");
      return toDTO(row);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictError(
          "This Stellar transaction is already recorded against another movement",
        );
      }
      throw err;
    }
  }

  async findById(id: string): Promise<TreasuryMovementDTO | undefined> {
    const { rows } = await this.pool.query<MovementRow>(
      `select ${COLUMNS} from treasury_movements where id = $1`,
      [id],
    );
    return rows[0] ? toDTO(rows[0]) : undefined;
  }

  async findByTxHash(
    txHash: string,
  ): Promise<TreasuryMovementDTO | undefined> {
    const { rows } = await this.pool.query<MovementRow>(
      `select ${COLUMNS} from treasury_movements where stellar_tx_hash = $1`,
      [txHash],
    );
    return rows[0] ? toDTO(rows[0]) : undefined;
  }

  async listForUser(userId: string): Promise<TreasuryMovementDTO[]> {
    const { rows } = await this.pool.query<MovementRow>(
      `select ${COLUMNS} from treasury_movements
       where user_id = $1
       order by created_at desc`,
      [userId],
    );
    return rows.map(toDTO);
  }

  async listAll(filter?: {
    status?: TreasuryStatus;
    direction?: TreasuryDirection;
    limit?: number;
  }): Promise<TreasuryMovementDTO[]> {
    // Built positionally rather than by string concatenation of values: the
    // filters are optional, the values are always parameters.
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter?.status) {
      params.push(filter.status);
      conditions.push(`status = $${params.length}`);
    }
    if (filter?.direction) {
      params.push(filter.direction);
      conditions.push(`direction = $${params.length}`);
    }
    params.push(Math.min(filter?.limit ?? 200, 1000));
    const where = conditions.length ? `where ${conditions.join(" and ")}` : "";

    const { rows } = await this.pool.query<MovementRow>(
      `select ${COLUMNS} from treasury_movements
       ${where}
       order by created_at desc
       limit $${params.length}`,
      params,
    );
    return rows.map(toDTO);
  }
}
