/**
 * Postgres-backed reputation persistence (plane.md §4.2, migration 0022).
 *
 * Reputation was in memory, so every deploy reset every user's track record to
 * the neutral prior. That is worse than it sounds: reputation is an advisory
 * input to dispute risk and to counterparty scoring at asset verification
 * (§3.1), so a restart quietly discarded exactly the history those signals are
 * built from — and the seller who had completed fifty clean orders read the
 * same as one who had completed none.
 *
 * Only counters are stored. The score is derived from them at read time by
 * `computeScore`, so the formula can change without a migration and without
 * two historical scores meaning different things.
 *
 * Parameterized queries only (Rules.md §7).
 */
import type pg from "pg";
import type {
  ReputationRecord,
  ReputationRepository,
} from "./reputation.repository.js";

interface ReputationRow {
  user_id: string;
  orders_completed: number;
  disputes_won: number;
  disputes_lost: number;
  updated_at: Date | string;
}

function toRecord(row: ReputationRow): ReputationRecord {
  return {
    userId: row.user_id,
    ordersCompleted: Number(row.orders_completed),
    disputesWon: Number(row.disputes_won),
    disputesLost: Number(row.disputes_lost),
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : row.updated_at,
  };
}

export class PgReputationRepository implements ReputationRepository {
  constructor(private readonly pool: pg.Pool) {}

  async get(userId: string): Promise<ReputationRecord | undefined> {
    const { rows } = await this.pool.query<ReputationRow>(
      `select user_id, orders_completed, disputes_won, disputes_lost, updated_at
       from reputation_records where user_id = $1`,
      [userId],
    );
    return rows[0] ? toRecord(rows[0]) : undefined;
  }

  async save(record: ReputationRecord): Promise<void> {
    // Upsert with the caller's values rather than an increment.
    //
    // The service reads, adjusts, and saves — so this is a last-writer-wins
    // update, and two events landing at once can lose one increment. That is a
    // real limitation and it is the right trade here: reputation is an
    // *advisory* prior (Rules.md §6), never a gate on money, and an occasional
    // lost count moves a smoothed score by a fraction of a percent. Making it
    // exact would mean an `orders_completed = orders_completed + $2` interface
    // the in-memory adapter cannot mirror, and Rules.md §2 requires the two to
    // behave alike.
    await this.pool.query(
      `insert into reputation_records
         (user_id, orders_completed, disputes_won, disputes_lost, updated_at)
       values ($1, $2, $3, $4, $5)
       on conflict (user_id) do update set
         orders_completed = excluded.orders_completed,
         disputes_won     = excluded.disputes_won,
         disputes_lost    = excluded.disputes_lost,
         updated_at       = excluded.updated_at`,
      [
        record.userId,
        record.ordersCompleted,
        record.disputesWon,
        record.disputesLost,
        record.updatedAt,
      ],
    );
  }

  /** Every record, for the admin console's counterparty view. */
  async listAll(limit = 200): Promise<ReputationRecord[]> {
    const { rows } = await this.pool.query<ReputationRow>(
      `select user_id, orders_completed, disputes_won, disputes_lost, updated_at
       from reputation_records
       order by updated_at desc
       limit $1`,
      [Math.min(limit, 1000)],
    );
    return rows.map(toRecord);
  }
}
