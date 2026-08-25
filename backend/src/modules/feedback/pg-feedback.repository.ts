/**
 * Postgres-backed feedback persistence (Phase 6, migration 0013).
 *
 * Every read lists its columns explicitly. `select *` would work today and
 * would start leaking on the day someone adds a column to `product_feedback`
 * — which, for a table that deliberately stores contact PII next to public
 * text, is the one failure mode worth designing against (Rules.md §7).
 *
 * Parameterized queries only (Rules.md §7).
 */
import type pg from "pg";
import type {
  FeedbackRecord,
  FeedbackRepository,
} from "./feedback.repository.js";

/** Postgres timestamptz columns arrive as Date; normalize to ISO strings. */
function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

interface FeedbackRow {
  id: string;
  user_id: string | null;
  display_name: string;
  message: string;
  rating: number;
  email: string;
  wallet_address: string;
  created_at: Date | string;
}

function toRecord(row: FeedbackRow): FeedbackRecord {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.display_name,
    message: row.message,
    // smallint arrives as a JS number, but a driver/type-parser change would
    // make it a string and silently break the average. Coerce at the boundary.
    rating: Number(row.rating),
    email: row.email,
    walletAddress: row.wallet_address,
    createdAt: toIso(row.created_at),
  };
}

const COLUMNS =
  "id, user_id, display_name, message, rating, email, wallet_address, created_at";

export class PgFeedbackRepository implements FeedbackRepository {
  constructor(private readonly pool: pg.Pool) {}

  async list(limit: number): Promise<FeedbackRecord[]> {
    const { rows } = await this.pool.query<FeedbackRow>(
      `select ${COLUMNS} from product_feedback order by created_at desc limit $1`,
      [limit],
    );
    return rows.map(toRecord);
  }

  async listRatings(): Promise<number[]> {
    const { rows } = await this.pool.query<{ rating: number }>(
      "select rating from product_feedback",
    );
    return rows.map((row) => Number(row.rating));
  }

  async findByUser(userId: string): Promise<FeedbackRecord | undefined> {
    const { rows } = await this.pool.query<FeedbackRow>(
      `select ${COLUMNS} from product_feedback where user_id = $1 limit 1`,
      [userId],
    );
    return rows[0] ? toRecord(rows[0]) : undefined;
  }

  async save(record: FeedbackRecord): Promise<void> {
    await this.pool.query(
      `insert into product_feedback
         (id, user_id, display_name, message, rating, email, wallet_address, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        record.id,
        record.userId,
        record.name,
        record.message,
        record.rating,
        record.email,
        record.walletAddress,
        record.createdAt,
      ],
    );
  }
}
