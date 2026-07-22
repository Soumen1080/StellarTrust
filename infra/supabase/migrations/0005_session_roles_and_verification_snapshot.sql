-- StellarTrust — Phase 1 addendum: persistent auth sessions & profile snapshot
-- Forward-only Postgres/Supabase migration (Rules.md §2).
--
-- Rationale:
--   * auth_sessions previously carried no role information, so a Postgres-backed
--     session verifier could not reconstruct the caller's roles after restart.
--   * The identity profile endpoint (/api/auth/me) surfaces the caller's latest
--     KYC verification. Persisting a denormalized JSONB snapshot on `users`
--     lets a Postgres identity repository return it without lossy re-mapping of
--     the normalized kyc_verifications columns (which cannot represent the
--     development-only autoApproveAt field).

begin;

-- Roles granted for the session, mirrored from the SEP-10 verification step.
-- Defaults to the baseline 'user' role for any pre-existing rows.
alter table auth_sessions
  add column roles text[] not null default array['user'];

-- Denormalized latest KYC verification DTO for the profile endpoint. Nullable;
-- no PII beyond what the profile already exposes to the owning user.
alter table users
  add column latest_verification jsonb;

commit;
