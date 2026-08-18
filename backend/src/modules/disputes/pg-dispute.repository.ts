/**
 * Postgres-backed dispute persistence (Phase 4).
 *
 * Implements the same {@link DisputeRepository} contract as the in-memory
 * variant, writing to the `dispute_records` table from migration 0007. The full
 * {@link DisputeDTO} is stored as a JSONB snapshot (the reproducible contract of
 * record, Rules.md §6) alongside the columns the queries filter by. Because
 * disputes live in Postgres, a wallet's dispute history and evidence survive
 * logout/login and process restarts.
 *
 * Parameterized queries only (Rules.md §7).
 */
import type pg from "pg";
import type { DisputeDTO } from "@stellartrust/shared";
import type { DisputeRepository } from "./dispute.repository.js";

interface DisputeRow {
  data: DisputeDTO;
}

export class PgDisputeRepository implements DisputeRepository {
  constructor(private readonly pool: pg.Pool) {}

  async save(dispute: DisputeDTO): Promise<void> {
    // Callers build the full next-state snapshot before saving, so a dispute
    // never persists partially updated. `resolved` mirrors resolution != null.
    // `escrow_id`/`contract_id` (migration 0009) are denormalized out of the
    // snapshot so the custody a claim is about is a real foreign key and an
    // indexable column, not a string buried in JSONB.
    await this.pool.query(
      `insert into dispute_records
         (id, order_id, escrow_id, contract_id, opened_by, status, resolved,
          data, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
       on conflict (id) do update
         set escrow_id = excluded.escrow_id,
             contract_id = excluded.contract_id,
             status = excluded.status,
             resolved = excluded.resolved,
             data = excluded.data,
             updated_at = excluded.updated_at`,
      [
        dispute.id,
        dispute.orderId,
        dispute.escrowId,
        dispute.contractId,
        dispute.openedBy,
        dispute.status,
        dispute.resolution !== null,
        JSON.stringify(dispute),
        dispute.createdAt,
        dispute.updatedAt,
      ],
    );
  }

  async find(disputeId: string): Promise<DisputeDTO | undefined> {
    const { rows } = await this.pool.query<DisputeRow>(
      `select data from dispute_records where id = $1`,
      [disputeId],
    );
    return rows[0]?.data;
  }

  async findOpenByOrder(orderId: string): Promise<DisputeDTO | undefined> {
    const { rows } = await this.pool.query<DisputeRow>(
      `select data from dispute_records
       where order_id = $1 and resolved = false
       order by created_at asc
       limit 1`,
      [orderId],
    );
    return rows[0]?.data;
  }

  async listForUser(userId: string): Promise<DisputeDTO[]> {
    const { rows } = await this.pool.query<DisputeRow>(
      `select data from dispute_records
       where opened_by = $1
       order by created_at desc`,
      [userId],
    );
    return rows.map((row) => row.data);
  }

  async listOpen(): Promise<DisputeDTO[]> {
    const { rows } = await this.pool.query<DisputeRow>(
      `select data from dispute_records
       where resolved = false
       order by created_at asc`,
    );
    return rows.map((row) => row.data);
  }
}
