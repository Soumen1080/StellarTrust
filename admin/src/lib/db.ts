/**
 * Direct Postgres access for the admin console.
 *
 * This app queries the platform database itself rather than calling the public
 * API. That is the whole point of the split: with the console reading Postgres
 * directly, there is no `/api/admin` on the public backend for anyone to find,
 * probe, or exploit.
 *
 * Every query below is read-only except the four write helpers at the bottom,
 * which are the only mutations the console performs. Parameterized throughout
 * (Rules.md §7) — the console handles operator input, and operator input is
 * still input.
 */
import pg from "pg";
import { config } from "../config.js";

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (pool) return pool;
  pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    // Hosted Postgres (Supabase, Neon, Render) requires TLS; a local one
    // refuses it. `rejectUnauthorized: false` accepts their managed chain,
    // which is what these providers document.
    ssl: config.DATABASE_URL.includes("localhost")
      ? undefined
      : { rejectUnauthorized: false },
    // Small: this console serves one operator, not the public. A large pool
    // would take connections the platform needs to serve actual users.
    max: 4,
    connectionTimeoutMillis: 10_000,
  });
  return pool;
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  const current = pool;
  pool = undefined;
  await current.end().catch(() => undefined);
}

// ── Reads ───────────────────────────────────────────────────────────────────

export interface TokenizationRow {
  id: string;
  status: string;
  face_value_amount: string;
  face_value_currency: string;
  total_units: string;
  units_sold: string;
  price_per_unit_amount: string;
  maturity_date: string | null;
  collected_at: string | null;
  created_at: string;
}

export async function listTokenizations(limit = 500): Promise<TokenizationRow[]> {
  const { rows } = await getPool().query<TokenizationRow>(
    `select id, status::text, face_value_amount, face_value_currency,
            total_units, units_sold, price_per_unit_amount,
            maturity_date, collected_at, created_at
     from tokenizations
     order by created_at desc
     limit $1`,
    [Math.min(limit, 1000)],
  );
  return rows;
}

export interface OrderRow {
  id: string;
  status: string;
  amount: string;
  currency: string;
  created_at: string;
}

export async function listOrders(limit = 500): Promise<OrderRow[]> {
  const { rows } = await getPool().query<OrderRow>(
    `select id, status::text, amount, currency, created_at
     from orders
     order by created_at desc
     limit $1`,
    [Math.min(limit, 1000)],
  );
  return rows;
}

export interface DisputeRow {
  id: string;
  status: string;
  order_id: string;
  created_at: string;
}

export async function listDisputes(limit = 500): Promise<DisputeRow[]> {
  const { rows } = await getPool().query<DisputeRow>(
    `select id, (data->>'status') as status,
            (data->>'orderId') as order_id, created_at
     from dispute_records
     order by created_at desc
     limit $1`,
    [Math.min(limit, 1000)],
  );
  return rows;
}

export interface TreasuryRow {
  id: string;
  user_id: string;
  direction: string;
  status: string;
  amount: string;
  currency: string;
  stellar_tx_hash: string | null;
  counterparty_address: string;
  failure_reason: string | null;
  created_at: string;
}

export async function listTreasuryMovements(limit = 200): Promise<TreasuryRow[]> {
  const { rows } = await getPool().query<TreasuryRow>(
    `select id, user_id, direction::text, status::text, amount, currency,
            stellar_tx_hash, counterparty_address, failure_reason, created_at
     from treasury_movements
     order by created_at desc
     limit $1`,
    [Math.min(limit, 1000)],
  );
  return rows;
}

export interface AuditRow {
  id: string;
  actor: string;
  action: string;
  entity: string;
  entity_id: string | null;
  created_at: string;
}

export async function listAudit(limit = 100): Promise<AuditRow[]> {
  // Metadata is deliberately not selected. The console shows *what happened*,
  // and audit metadata is the field most likely to accumulate something
  // sensitive over time. Not rendering it means a future careless `append`
  // cannot leak through this screen.
  const { rows } = await getPool().query<AuditRow>(
    `select id, actor, action, entity, entity_id, created_at
     from audit_log
     order by created_at desc
     limit $1`,
    [Math.min(limit, 1000)],
  );
  return rows;
}

export interface KycReviewRow {
  id: string;
  user_id: string;
  status: string;
  risk_score: number | null;
  confidence: number | null;
  created_at: string;
}

export async function listKycReviews(limit = 200): Promise<KycReviewRow[]> {
  const { rows } = await getPool().query<KycReviewRow>(
    `select id, user_id, status::text,
            (advisory->>'riskScore')::numeric as risk_score,
            (advisory->>'confidence')::numeric as confidence,
            created_at
     from kyc_reviews
     where status = 'queued'
     order by created_at asc
     limit $1`,
    [Math.min(limit, 1000)],
  );
  return rows;
}

export interface AssetReviewRow {
  id: string;
  asset_type: string;
  asset_ref: string;
  description: string;
  valuation_amount: string;
  valuation_currency: string;
  created_at: string;
}

export async function listAssetReviews(limit = 200): Promise<AssetReviewRow[]> {
  const { rows } = await getPool().query<AssetReviewRow>(
    `select id, asset_type::text, asset_ref, description,
            valuation_amount, valuation_currency, created_at
     from assets
     where verification_status = 'under_review'
     order by created_at asc
     limit $1`,
    [Math.min(limit, 1000)],
  );
  return rows;
}

export interface PolicyRow {
  domain: string;
  mode: string;
  approve_max_risk_bps: number;
  reject_min_risk_bps: number;
  min_confidence_bps: number;
  human_review_above_amount: string;
  updated_at: string;
}

export async function listPolicies(): Promise<PolicyRow[]> {
  const { rows } = await getPool().query<PolicyRow>(
    `select domain, mode::text, approve_max_risk_bps, reject_min_risk_bps,
            min_confidence_bps, human_review_above_amount, updated_at
     from verification_policies
     order by domain asc`,
  );
  return rows;
}

// ── Writes ──────────────────────────────────────────────────────────────────
//
// The only four mutations the console performs. Each writes an audit row in
// the same transaction as the change, so a decision can never be recorded
// without its trail — or a trail without its decision.

async function withAudit<T>(
  action: string,
  entity: string,
  entityId: string,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const result = await work(client);
    await client.query(
      `insert into audit_log (actor, action, entity, entity_id, metadata)
       values ($1, $2, $3, $4, '{}'::jsonb)`,
      ["admin-console", action, entity, entityId],
    );
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function updatePolicy(
  domain: string,
  input: {
    mode: string;
    approveMaxRiskBps: number;
    rejectMinRiskBps: number;
    minConfidenceBps: number;
    humanReviewAboveAmount: string;
  },
): Promise<void> {
  await withAudit(
    "admin.verification_policy_updated",
    "verification_policy",
    domain,
    async (client) => {
      await client.query(
        `update verification_policies
         set mode = $2::verification_mode,
             approve_max_risk_bps = $3,
             reject_min_risk_bps = $4,
             min_confidence_bps = $5,
             human_review_above_amount = $6,
             updated_at = now()
         where domain = $1`,
        [
          domain,
          input.mode,
          input.approveMaxRiskBps,
          input.rejectMinRiskBps,
          input.minConfidenceBps,
          input.humanReviewAboveAmount,
        ],
      );
    },
  );
}

export async function decideKycReview(
  reviewId: string,
  decision: "approve" | "reject",
  reason: string,
  /**
   * Recorded as `resolved_by`. Required by migration 0022's
   * `kyc_reviews_resolution_is_complete`, which will not let a review be
   * resolved without naming who resolved it — the same reasoning as the asset
   * reviewer above.
   */
  reviewerUserId: string,
): Promise<boolean> {
  return withAudit(
    `kyc.human_${decision}`,
    "kyc_review",
    reviewId,
    async (client) => {
      // `status = 'queued'` is the concurrency guard, not a convenience: two
      // operators opening the same case is ordinary, and without it the
      // second decision silently overwrites the first.
      const { rows } = await client.query<{ user_id: string }>(
        `update kyc_reviews
         set status = 'resolved', resolution = $2::human_kyc_decision,
             resolution_reason = $3, resolved_by = $4, resolved_at = now()
         where id = $1 and status = 'queued'
         returning user_id`,
        [reviewId, decision, reason, reviewerUserId],
      );
      const row = rows[0];
      if (!row) return false;

      await client.query(
        `update users set kyc_status = $2::kyc_status, updated_at = now()
         where id = $1`,
        [row.user_id, decision === "approve" ? "verified" : "rejected"],
      );
      return true;
    },
  );
}

export async function decideAssetReview(
  assetId: string,
  decision: "verify" | "reject",
  note: string | null,
  /**
   * The user id recorded as the reviewer.
   *
   * Migration 0018's `assets_decision_has_reviewer` requires both this and
   * `verified_at` on *any* decision — a rejection as much as an approval,
   * because "who rejected this deal, and when" is exactly the question an
   * issuer will ask. The console signs in with a password rather than a
   * wallet, so it has no user id of its own; the operator's is supplied by
   * configuration (`ADMIN_REVIEWER_USER_ID`).
   */
  reviewerUserId: string,
): Promise<boolean> {
  return withAudit(
    `rwa.asset_${decision}`,
    "asset",
    assetId,
    async (client) => {
      const { rowCount } = await client.query(
        `update assets
         set verification_status = $2::asset_verification_status,
             verification_note = $3,
             verified_by_user_id = $4,
             verified_at = now()
         where id = $1 and verification_status = 'under_review'`,
        [
          assetId,
          decision === "verify" ? "verified" : "rejected",
          note,
          reviewerUserId,
        ],
      );
      return (rowCount ?? 0) > 0;
    },
  );
}

/**
 * Refuse a held withdrawal.
 *
 * Deliberately the *only* withdrawal action here. Approving one submits a real
 * Stellar payment, which needs the signing key — and putting that key in a
 * separately deployed console would mean two systems able to move funds
 * instead of one. Approval stays on the backend, where the key already lives;
 * this console can stop a withdrawal but never send one.
 */
export async function rejectWithdrawal(
  movementId: string,
  reason: string,
): Promise<boolean> {
  return withAudit(
    "treasury.withdrawal_rejected",
    "treasury_movement",
    movementId,
    async (client) => {
      const { rowCount } = await client.query(
        `update treasury_movements
         set status = 'failed', failure_reason = $2, completed_at = now()
         where id = $1 and status = 'pending' and direction = 'withdrawal'`,
        [movementId, reason],
      );
      return (rowCount ?? 0) > 0;
    },
  );
}
