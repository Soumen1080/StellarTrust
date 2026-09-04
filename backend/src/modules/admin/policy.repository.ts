/**
 * Verification-policy persistence (migration 0022).
 *
 * Small, but it is the store an operator's control surface reads and writes,
 * so a missing row must never be a failure: it falls back to the compiled
 * default, which is the behaviour the platform had before the table existed.
 * An admin console that cannot load because nobody has saved a policy yet is
 * an admin console that is useless exactly when it is first needed.
 */
import type pg from "pg";
import {
  DEFAULT_POLICIES,
  type UpdateVerificationPolicyInput,
  type VerificationDomain,
  type VerificationMode,
  type VerificationPolicy,
} from "./verification-policy.js";

export interface PolicyRepository {
  get(domain: VerificationDomain): Promise<VerificationPolicy>;
  list(): Promise<VerificationPolicy[]>;
  update(
    domain: VerificationDomain,
    input: UpdateVerificationPolicyInput,
    updatedBy: string,
  ): Promise<VerificationPolicy>;
}

export class InMemoryPolicyRepository implements PolicyRepository {
  private readonly policies = new Map<string, VerificationPolicy>();

  async get(domain: VerificationDomain): Promise<VerificationPolicy> {
    return this.policies.get(domain) ?? DEFAULT_POLICIES[domain];
  }

  async list(): Promise<VerificationPolicy[]> {
    return (Object.keys(DEFAULT_POLICIES) as VerificationDomain[]).map(
      (domain) => this.policies.get(domain) ?? DEFAULT_POLICIES[domain],
    );
  }

  async update(
    domain: VerificationDomain,
    input: UpdateVerificationPolicyInput,
    updatedBy: string,
  ): Promise<VerificationPolicy> {
    const current = await this.get(domain);
    const updated: VerificationPolicy = {
      ...current,
      ...input,
      domain,
      updatedBy,
      updatedAt: new Date().toISOString(),
    };
    this.policies.set(domain, updated);
    return updated;
  }
}

interface PolicyRow {
  domain: string;
  mode: string;
  approve_max_risk_bps: number;
  reject_min_risk_bps: number;
  min_confidence_bps: number;
  human_review_above_amount: string;
  updated_by: string | null;
  updated_at: Date | string;
}

function toDTO(row: PolicyRow): VerificationPolicy {
  return {
    domain: row.domain as VerificationDomain,
    mode: row.mode as VerificationMode,
    approveMaxRiskBps: Number(row.approve_max_risk_bps),
    rejectMinRiskBps: Number(row.reject_min_risk_bps),
    minConfidenceBps: Number(row.min_confidence_bps),
    humanReviewAboveAmount: String(row.human_review_above_amount),
    updatedBy: row.updated_by,
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : row.updated_at,
  };
}

const COLUMNS = `domain, mode, approve_max_risk_bps, reject_min_risk_bps,
  min_confidence_bps, human_review_above_amount, updated_by, updated_at`;

export class PgPolicyRepository implements PolicyRepository {
  constructor(private readonly pool: pg.Pool) {}

  async get(domain: VerificationDomain): Promise<VerificationPolicy> {
    const { rows } = await this.pool.query<PolicyRow>(
      `select ${COLUMNS} from verification_policies where domain = $1`,
      [domain],
    );
    return rows[0] ? toDTO(rows[0]) : DEFAULT_POLICIES[domain];
  }

  async list(): Promise<VerificationPolicy[]> {
    const { rows } = await this.pool.query<PolicyRow>(
      `select ${COLUMNS} from verification_policies order by domain asc`,
    );
    const stored = new Map(rows.map((row) => [row.domain, toDTO(row)]));
    // Every known domain appears, stored or not. A console that only lists
    // configured domains hides the one an operator most needs to configure.
    return (Object.keys(DEFAULT_POLICIES) as VerificationDomain[]).map(
      (domain) => stored.get(domain) ?? DEFAULT_POLICIES[domain],
    );
  }

  async update(
    domain: VerificationDomain,
    input: UpdateVerificationPolicyInput,
    updatedBy: string,
  ): Promise<VerificationPolicy> {
    const current = await this.get(domain);
    const merged = { ...current, ...input };
    const { rows } = await this.pool.query<PolicyRow>(
      `insert into verification_policies
         (domain, mode, approve_max_risk_bps, reject_min_risk_bps,
          min_confidence_bps, human_review_above_amount, updated_by, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, now())
       on conflict (domain) do update set
         mode                      = excluded.mode,
         approve_max_risk_bps      = excluded.approve_max_risk_bps,
         reject_min_risk_bps       = excluded.reject_min_risk_bps,
         min_confidence_bps        = excluded.min_confidence_bps,
         human_review_above_amount = excluded.human_review_above_amount,
         updated_by                = excluded.updated_by,
         updated_at                = now()
       returning ${COLUMNS}`,
      [
        domain,
        merged.mode,
        merged.approveMaxRiskBps,
        merged.rejectMinRiskBps,
        merged.minConfidenceBps,
        merged.humanReviewAboveAmount,
        updatedBy,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error("Failed to persist the verification policy");
    return toDTO(row);
  }
}
