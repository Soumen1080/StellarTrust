/**
 * Postgres-backed identity repository.
 *
 * Implements the {@link IdentityRepository} contract against the schema from
 * migrations 0001/0003/0005 (`users`, `wallets`, `businesses`, plus the
 * `users.latest_verification` JSONB snapshot). Because identities live in
 * Postgres, the same wallet resolves to the same user id across restarts, so
 * opaque sessions persisted by {@link PgAuthRepository} remain valid and
 * `/api/auth/me` keeps working.
 *
 * Parameterized queries only (Rules.md §7).
 */
import type pg from "pg";
import {
  KycStatus,
  type BusinessProfile,
  type IdentityProfileResponse,
  type KycApplicationResponse,
  type PublicUserRef,
  type UserProfile,
  type WalletRef,
} from "@stellartrust/shared";
import { ConflictError } from "../../lib/errors.js";
import {
  generateUsername,
  type DevelopmentDemoAccount,
  type IdentityRepository,
} from "./identity.repository.js";

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

/** Deterministic placeholder email until KYC onboarding supplies a real one. */
function pendingEmail(stellarPublicKey: string): string {
  return `wallet-${stellarPublicKey.slice(0, 12)}@pending.stellartrust.local`;
}

/**
 * Every column {@link PgIdentityRepository.mapUser} reads, as one fragment.
 *
 * Written once and interpolated into each query rather than repeated: these
 * clauses are the sole source of the user shape, and a column missing from just
 * one of them produces a `UserProfile` that is silently incomplete on one code
 * path only — the kind of bug that shows up as a blank username long after the
 * query that caused it. Contains no user input.
 */
const USER_COLUMNS =
  "id, email, display_name, username, username_set_at, avatar_url, " +
  "kyc_status, created_at, latest_verification";

/** Postgres unique-violation SQLSTATE. */
const PG_UNIQUE_VIOLATION = "23505";

interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  username: string;
  username_set_at: Date | string | null;
  avatar_url: string | null;
  kyc_status: KycStatus;
  created_at: Date | string;
  latest_verification: KycApplicationResponse | null;
}

interface WalletRow {
  id: string;
  user_id: string;
  stellar_public_key: string;
  custody_type: "self" | "contract";
}

interface BusinessRow {
  id: string;
  owner_user_id: string;
  legal_name: string;
  country: string;
  created_at: Date | string;
}

export class PgIdentityRepository implements IdentityRepository {
  private readonly demoAccounts: Map<string, DevelopmentDemoAccount>;

  constructor(
    private readonly pool: pg.Pool,
    demoAccounts: readonly DevelopmentDemoAccount[] = [],
  ) {
    this.demoAccounts = new Map(
      demoAccounts.map((account) => [account.stellarPublicKey, account]),
    );
  }

  private mapUser(row: UserRow): UserProfile {
    return {
      id: row.id,
      email: row.email,
      ...(row.display_name ? { displayName: row.display_name } : {}),
      username: row.username,
      ...(row.username_set_at
        ? { usernameSetAt: toIso(row.username_set_at) }
        : {}),
      ...(row.avatar_url ? { avatarUrl: row.avatar_url } : {}),
      kycStatus: row.kyc_status,
      createdAt: toIso(row.created_at),
    };
  }

  private mapWallet(row: WalletRow): WalletRef {
    return {
      id: row.id,
      userId: row.user_id,
      stellarPublicKey: row.stellar_public_key,
      custodyType: row.custody_type,
    };
  }

  async upsertWalletIdentity(stellarPublicKey: string): Promise<{
    user: UserProfile;
    wallet: WalletRef;
  }> {
    const existing = await this.findByWallet(stellarPublicKey);
    if (existing) return existing;

    // First sight of this wallet: create the user + wallet atomically. Demo
    // accounts are seeded verified with their display name; everyone else
    // starts pending. ON CONFLICT handles a concurrent insert race.
    const demo = this.demoAccounts.get(stellarPublicKey);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const userInsert = await client.query<UserRow>(
        `insert into users (email, display_name, username, kyc_status, verified_at)
         values ($1, $2, $3, $4, $5)
         returning ${USER_COLUMNS}`,
        [
          pendingEmail(stellarPublicKey),
          demo?.displayName ?? null,
          // Generated, not chosen: the account needs a handle from the moment it
          // exists so nothing has to render a missing one. `username_set_at`
          // stays null, leaving the user their one claim.
          generateUsername(stellarPublicKey),
          demo ? KycStatus.Verified : KycStatus.Pending,
          demo ? new Date().toISOString() : null,
        ],
      );
      const userRow = userInsert.rows[0];
      if (!userRow) throw new Error("Failed to create identity user");
      const walletInsert = await client.query<WalletRow>(
        `insert into wallets (user_id, stellar_public_key, custody_type)
         values ($1, $2, 'self')
         on conflict (stellar_public_key) do nothing
         returning id, user_id, stellar_public_key, custody_type`,
        [userRow.id, stellarPublicKey],
      );

      const walletRow = walletInsert.rows[0];
      if (!walletRow) {
        // Lost the race: another request created the wallet. Roll back our
        // orphan user and return the winner.
        await client.query("rollback");
        const winner = await this.findByWallet(stellarPublicKey);
        if (winner) return winner;
        throw new Error("Wallet identity index is inconsistent");
      }

      await client.query("commit");
      return {
        user: this.mapUser(userRow),
        wallet: this.mapWallet(walletRow),
      };
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async findPrimaryWallet(userId: string): Promise<WalletRef | undefined> {
    // Oldest wallet wins: that is the SEP-10 key the identity was created from,
    // so the mapping stays stable if a user later links additional wallets.
    const { rows } = await this.pool.query<WalletRow>(
      `select id, user_id, stellar_public_key, custody_type
         from wallets
        where user_id = $1
        order by created_at asc, id asc
        limit 1`,
      [userId],
    );
    const row = rows[0];
    return row ? this.mapWallet(row) : undefined;
  }

  private async findByWallet(stellarPublicKey: string): Promise<
    | {
        user: UserProfile;
        wallet: WalletRef;
      }
    | undefined
  > {
    const { rows } = await this.pool.query(
      `select
         w.id as wallet_id, w.user_id, w.stellar_public_key, w.custody_type,
         u.id as user_id2, u.email, u.display_name, u.username,
         u.username_set_at, u.avatar_url, u.kyc_status,
         u.created_at, u.latest_verification
       from wallets w
       join users u on u.id = w.user_id
       where w.stellar_public_key = $1`,
      [stellarPublicKey],
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      user: this.mapUser({
        id: row.user_id,
        email: row.email,
        display_name: row.display_name,
        username: row.username,
        username_set_at: row.username_set_at,
        avatar_url: row.avatar_url,
        kyc_status: row.kyc_status,
        created_at: row.created_at,
        latest_verification: row.latest_verification,
      }),
      wallet: this.mapWallet({
        id: row.wallet_id,
        user_id: row.user_id,
        stellar_public_key: row.stellar_public_key,
        custody_type: row.custody_type,
      }),
    };
  }

  async updateUserProfile(
    userId: string,
    input: { email: string; legalName: string; kycStatus: KycStatus },
  ): Promise<UserProfile> {
    // `legalName` is not part of the users row (kept on businesses); mirror the
    // in-memory repository which only updates email + KYC status here.
    const { rows } = await this.pool.query<UserRow>(
      `update users
       set email = $2, kyc_status = $3, updated_at = now()
       where id = $1
       returning ${USER_COLUMNS}`,
      [userId, input.email, input.kycStatus],
    );
    const row = rows[0];
    if (!row) throw new Error(`Identity ${userId} was not found`);
    return this.mapUser(row);
  }

  async setUserKycStatus(
    userId: string,
    status: KycStatus,
  ): Promise<UserProfile> {
    const { rows } = await this.pool.query<UserRow>(
      `update users
       set kyc_status = $2, updated_at = now()
       where id = $1
       returning ${USER_COLUMNS}`,
      [userId, status],
    );
    const row = rows[0];
    if (!row) throw new Error(`Identity ${userId} was not found`);
    return this.mapUser(row);
  }

  async upsertBusiness(
    userId: string,
    input: { legalName: string; country: string },
  ): Promise<BusinessProfile> {
    // One business per owner (matches the in-memory contract): update in place
    // if present, otherwise insert.
    const existing = await this.pool.query<BusinessRow>(
      `select id, owner_user_id, legal_name, country, created_at
       from businesses where owner_user_id = $1
       order by created_at asc limit 1`,
      [userId],
    );

    if (existing.rows[0]) {
      const { rows } = await this.pool.query<BusinessRow>(
        `update businesses
         set legal_name = $2, country = $3
         where id = $1
         returning id, owner_user_id, legal_name, country, created_at`,
        [existing.rows[0].id, input.legalName, input.country],
      );
      const updated = rows[0];
      if (!updated) throw new Error(`Business for ${userId} was not found`);
      return this.mapBusiness(updated);
    }

    const { rows } = await this.pool.query<BusinessRow>(
      `insert into businesses (owner_user_id, legal_name, country)
       values ($1, $2, $3)
       returning id, owner_user_id, legal_name, country, created_at`,
      [userId, input.legalName, input.country],
    );
    const inserted = rows[0];
    if (!inserted) throw new Error("Failed to create business profile");
    return this.mapBusiness(inserted);
  }

  private mapBusiness(row: BusinessRow): BusinessProfile {
    return {
      id: row.id,
      ownerUserId: row.owner_user_id,
      legalName: row.legal_name,
      country: row.country,
      createdAt: toIso(row.created_at),
    };
  }

  async setUsername(userId: string, username: string): Promise<UserProfile> {
    let rows: UserRow[];
    try {
      // `username_set_at is null` in the WHERE clause is what enforces the
      // one-claim rule, and it does so atomically: two concurrent requests
      // cannot both pass it, because the second sees the first's write. A
      // read-then-write check here would have a race between the two.
      ({ rows } = await this.pool.query<UserRow>(
        `update users
         set username = $2, username_set_at = now(), updated_at = now()
         where id = $1 and username_set_at is null
         returning ${USER_COLUMNS}`,
        [userId, username],
      ));
    } catch (err) {
      if ((err as { code?: string }).code === PG_UNIQUE_VIOLATION) {
        throw new ConflictError("That username is already taken");
      }
      throw err;
    }

    const row = rows[0];
    if (row) return this.mapUser(row);

    // No row updated: either the user does not exist, or they have already
    // claimed a handle. Distinguish the two so the caller can report the real
    // reason rather than a generic failure.
    const existing = await this.pool.query<{ username_set_at: Date | null }>(
      `select username_set_at from users where id = $1`,
      [userId],
    );
    if (!existing.rows[0]) throw new Error(`Identity ${userId} was not found`);
    throw new ConflictError(
      "Your username has already been set and cannot be changed",
    );
  }

  async setAvatarUrl(
    userId: string,
    avatarUrl: string | null,
  ): Promise<UserProfile> {
    const { rows } = await this.pool.query<UserRow>(
      `update users
       set avatar_url = $2, updated_at = now()
       where id = $1
       returning ${USER_COLUMNS}`,
      [userId, avatarUrl],
    );
    const row = rows[0];
    if (!row) throw new Error(`Identity ${userId} was not found`);
    return this.mapUser(row);
  }

  async findPublicRef(userId: string): Promise<PublicUserRef | undefined> {
    // Selects only the three public columns rather than reusing USER_COLUMNS:
    // this result crosses an account boundary, so the query itself should not
    // read the email or KYC state it must not disclose.
    const { rows } = await this.pool.query<{
      id: string;
      username: string;
      avatar_url: string | null;
    }>(`select id, username, avatar_url from users where id = $1`, [userId]);
    const row = rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      username: row.username,
      ...(row.avatar_url ? { avatarUrl: row.avatar_url } : {}),
    };
  }

  async setLatestVerification(
    userId: string,
    verification: KycApplicationResponse,
  ): Promise<void> {
    const result = await this.pool.query(
      `update users set latest_verification = $2 where id = $1`,
      [userId, JSON.stringify(verification)],
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new Error(`Identity ${userId} was not found`);
    }
  }

  async getProfile(
    userId: string,
  ): Promise<IdentityProfileResponse | undefined> {
    const userResult = await this.pool.query<UserRow>(
      `select ${USER_COLUMNS} from users where id = $1`,
      [userId],
    );
    const userRow = userResult.rows[0];
    if (!userRow) return undefined;

    const [businessResult, walletsResult] = await Promise.all([
      this.pool.query<BusinessRow>(
        `select id, owner_user_id, legal_name, country, created_at
         from businesses where owner_user_id = $1
         order by created_at asc limit 1`,
        [userId],
      ),
      this.pool.query<WalletRow>(
        `select id, user_id, stellar_public_key, custody_type
         from wallets where user_id = $1
         order by created_at asc`,
        [userId],
      ),
    ]);

    return {
      user: this.mapUser(userRow),
      business: businessResult.rows[0]
        ? this.mapBusiness(businessResult.rows[0])
        : null,
      wallets: walletsResult.rows.map((row) => this.mapWallet(row)),
      latestVerification: userRow.latest_verification ?? null,
    };
  }
}
