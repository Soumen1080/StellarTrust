/**
 * Postgres-backed SEP-10 challenge/session persistence.
 *
 * Implements the same {@link AuthRepository} contract as the in-memory variant,
 * writing to the `sep10_challenges` and `auth_sessions` tables defined in
 * migrations 0003 and 0005. Because sessions live in Postgres, opaque bearer
 * tokens survive process restarts (only their SHA-256 hash is stored).
 *
 * Parameterized queries only (Rules.md §7).
 */
import type pg from "pg";
import { config } from "../../config/index.js";
import type {
  AuthRepository,
  ChallengeRecord,
  SessionRecord,
} from "./auth.repository.js";

/** Postgres timestamptz columns arrive as Date; normalize to ISO strings. */
function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

export class PgAuthRepository implements AuthRepository {
  constructor(private readonly pool: pg.Pool) {}

  /** SEP-10 challenges are network-scoped; derive the passphrase from config. */
  private get networkPassphrase(): string {
    return config.STELLAR_NETWORK === "public"
      ? "Public Global Stellar Network ; September 2015"
      : "Test SDF Network ; September 2015";
  }

  async saveChallenge(record: ChallengeRecord): Promise<void> {
    await this.pool.query(
      `insert into sep10_challenges
         (id, stellar_public_key, transaction_hash, network_passphrase,
          expires_at, consumed_at)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        record.id,
        record.stellarPublicKey,
        record.transactionHash,
        this.networkPassphrase,
        record.expiresAt,
        record.consumedAt,
      ],
    );
  }

  async getChallenge(id: string): Promise<ChallengeRecord | undefined> {
    const { rows } = await this.pool.query(
      `select id, stellar_public_key, transaction_hash, expires_at, consumed_at
       from sep10_challenges
       where id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      stellarPublicKey: row.stellar_public_key,
      transactionHash: row.transaction_hash,
      expiresAt: toIso(row.expires_at) as string,
      consumedAt: toIso(row.consumed_at),
    };
  }

  async consumeChallenge(id: string, consumedAt: string): Promise<boolean> {
    // Atomic single-use guard: only the first caller flips consumed_at.
    const result = await this.pool.query(
      `update sep10_challenges
       set consumed_at = $2
       where id = $1 and consumed_at is null`,
      [id, consumedAt],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async saveSession(record: SessionRecord): Promise<void> {
    await this.pool.query(
      `insert into auth_sessions
         (user_id, wallet_id, token_hash, roles, expires_at, revoked_at)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        record.userId,
        record.walletId,
        record.tokenHash,
        record.roles,
        record.expiresAt,
        record.revokedAt,
      ],
    );
  }

  async findActiveSession(
    tokenHash: string,
    now: string,
  ): Promise<SessionRecord | undefined> {
    const { rows } = await this.pool.query(
      `select user_id, wallet_id, token_hash, roles, expires_at, revoked_at
       from auth_sessions
       where token_hash = $1 and revoked_at is null and expires_at > $2`,
      [tokenHash, now],
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      tokenHash: row.token_hash,
      userId: row.user_id,
      walletId: row.wallet_id,
      roles: Array.isArray(row.roles) ? row.roles : [],
      expiresAt: toIso(row.expires_at) as string,
      revokedAt: toIso(row.revoked_at),
    };
  }
}
