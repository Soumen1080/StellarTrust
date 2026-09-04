/**
 * Postgres-backed KYC verification + review persistence (plane.md §4.2,
 * migration 0022).
 *
 * KYC state used to die on restart. That is not merely inconvenient: KYC gates
 * an investor purchase (§3.2), so a deploy silently reset every user to
 * unverified — and it re-opened every review a compliance officer had already
 * closed, inviting a second decision on a case that had one.
 *
 * The verification response is stored as jsonb rather than normalised. It is a
 * provider-shaped document the service round-trips whole, and a column per
 * check would mean a migration every time a provider adds one. What must
 * *not* be in it is raw PII — the service stores check outcomes, an advisory
 * score, and opaque references only (Rules.md §3).
 *
 * Parameterized queries only (Rules.md §7).
 */
import type pg from "pg";
import type {
  HumanKycDecision,
  KycApplicationResponse,
  KycProviderChecks,
  KycReviewItem,
  KycRiskAdvisory,
  ReviewStatus,
} from "@stellartrust/shared";
import type {
  KycRepository,
  KycVerificationRecord,
} from "./kyc.repository.js";

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

interface VerificationRow {
  verification_id: string;
  user_id: string;
  response: KycApplicationResponse;
}

interface ReviewRow {
  id: string;
  verification_id: string;
  user_id: string;
  status: string;
  advisory: KycRiskAdvisory;
  provider_checks: KycProviderChecks;
  resolved_by: string | null;
  resolution: string | null;
  resolution_reason: string | null;
  created_at: Date | string;
  resolved_at: Date | string | null;
}

function toReviewDTO(row: ReviewRow): KycReviewItem {
  return {
    id: row.id,
    verificationId: row.verification_id,
    userId: row.user_id,
    status: row.status as ReviewStatus,
    advisory: row.advisory,
    providerChecks: row.provider_checks,
    resolvedBy: row.resolved_by,
    resolution: row.resolution as HumanKycDecision | null,
    resolutionReason: row.resolution_reason,
    createdAt: toIso(row.created_at),
    resolvedAt: row.resolved_at ? toIso(row.resolved_at) : null,
  };
}

const REVIEW_COLUMNS = `id, verification_id, user_id, status, advisory,
  provider_checks, resolved_by, resolution, resolution_reason,
  created_at, resolved_at`;

export class PgKycRepository implements KycRepository {
  constructor(private readonly pool: pg.Pool) {}

  async saveVerification(record: KycVerificationRecord): Promise<void> {
    // Upsert: `submit` writes once, but the auto-approval path and a human
    // decision both rewrite the same response, and a save that failed on a
    // second write would strand the verification mid-transition.
    await this.pool.query(
      `insert into kyc_verification_records (verification_id, user_id, response)
       values ($1, $2, $3::jsonb)
       on conflict (verification_id)
       do update set response = excluded.response, updated_at = now()`,
      [
        record.response.verificationId,
        record.userId,
        JSON.stringify(record.response),
      ],
    );
  }

  async getVerification(
    id: string,
  ): Promise<KycVerificationRecord | undefined> {
    const { rows } = await this.pool.query<VerificationRow>(
      `select verification_id, user_id, response
       from kyc_verification_records where verification_id = $1`,
      [id],
    );
    const row = rows[0];
    return row ? { userId: row.user_id, response: row.response } : undefined;
  }

  async updateVerification(
    id: string,
    response: KycApplicationResponse,
  ): Promise<KycVerificationRecord | undefined> {
    const { rows } = await this.pool.query<VerificationRow>(
      `update kyc_verification_records
       set response = $2::jsonb, updated_at = now()
       where verification_id = $1
       returning verification_id, user_id, response`,
      [id, JSON.stringify(response)],
    );
    const row = rows[0];
    return row ? { userId: row.user_id, response: row.response } : undefined;
  }

  async saveReview(review: KycReviewItem): Promise<void> {
    await this.pool.query(
      `insert into kyc_reviews
         (id, verification_id, user_id, status, advisory, provider_checks,
          resolved_by, resolution, resolution_reason, created_at, resolved_at)
       values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11)
       on conflict (id) do nothing`,
      [
        review.id,
        review.verificationId,
        review.userId,
        review.status,
        JSON.stringify(review.advisory),
        JSON.stringify(review.providerChecks),
        review.resolvedBy,
        review.resolution,
        review.resolutionReason,
        review.createdAt,
        review.resolvedAt,
      ],
    );
  }

  async getReview(id: string): Promise<KycReviewItem | undefined> {
    const { rows } = await this.pool.query<ReviewRow>(
      `select ${REVIEW_COLUMNS} from kyc_reviews where id = $1`,
      [id],
    );
    return rows[0] ? toReviewDTO(rows[0]) : undefined;
  }

  async listQueuedReviews(): Promise<KycReviewItem[]> {
    const { rows } = await this.pool.query<ReviewRow>(
      `select ${REVIEW_COLUMNS} from kyc_reviews
       where status = 'queued'
       order by created_at asc`,
    );
    return rows.map(toReviewDTO);
  }

  async resolveReview(
    id: string,
    input: {
      resolvedBy: string;
      resolution: HumanKycDecision;
      reason: string;
      resolvedAt: string;
    },
  ): Promise<KycReviewItem | undefined> {
    // The `status = 'queued'` predicate is the concurrency guard, not a
    // convenience: two officers opening the same case is ordinary, and without
    // it the second decision would silently overwrite the first. The loser of
    // that race gets `undefined`, which the service turns into "already
    // resolved".
    const { rows } = await this.pool.query<ReviewRow>(
      `update kyc_reviews
       set status = 'resolved',
           resolved_by = $2,
           resolution = $3,
           resolution_reason = $4,
           resolved_at = $5
       where id = $1 and status = 'queued'
       returning ${REVIEW_COLUMNS}`,
      [id, input.resolvedBy, input.resolution, input.reason, input.resolvedAt],
    );
    return rows[0] ? toReviewDTO(rows[0]) : undefined;
  }

  /**
   * Every review, newest first — the admin console's queue view (which shows
   * resolved cases too, so an operator can audit what was decided rather than
   * only what is outstanding).
   */
  async listAllReviews(limit = 200): Promise<KycReviewItem[]> {
    const { rows } = await this.pool.query<ReviewRow>(
      `select ${REVIEW_COLUMNS} from kyc_reviews
       order by created_at desc
       limit $1`,
      [Math.min(limit, 1000)],
    );
    return rows.map(toReviewDTO);
  }
}
