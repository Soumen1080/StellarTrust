-- StellarTrust — Phase 1: Identity & Wallet
-- Forward-only Postgres/Supabase migration.
--
-- Security model:
--   * SEP-10 challenges are one-time and expire.
--   * Session bearer tokens are NEVER stored; only SHA-256 hashes are stored.
--   * Raw identity documents/face images are not stored in Postgres. Provider
--     references and normalized checks are retained for auditability.
--   * Client-facing tables use deny-by-default RLS. The backend remains the
--     authoritative policy boundary and uses a server role / direct connection.

begin;

create type applicant_type as enum ('individual', 'business');
create type provider_check_status as enum ('pass', 'review', 'fail');
create type kyc_review_status as enum ('queued', 'resolved');
create type human_kyc_decision as enum ('approve', 'reject');

-- ── Identity/profile linkage ─────────────────────────────────────────────────
alter table users
  add column auth_subject text unique,
  add column display_name text,
  add column verified_at timestamptz;

alter table businesses
  add column registration_number text,
  add column verification_id uuid references kyc_verifications(id) on delete set null;

alter table wallets
  add column verified_at timestamptz,
  add column last_authenticated_at timestamptz;

-- ── SEP-10 challenge + session lifecycle ─────────────────────────────────────
create table sep10_challenges (
  id                 uuid primary key default gen_random_uuid(),
  stellar_public_key text not null,
  transaction_hash   text not null unique,
  network_passphrase text not null,
  expires_at         timestamptz not null,
  consumed_at        timestamptz,
  created_at         timestamptz not null default now(),
  check (expires_at > created_at)
);

create index sep10_challenges_account_idx
  on sep10_challenges(stellar_public_key, created_at desc);

create table auth_sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  wallet_id   uuid not null references wallets(id) on delete cascade,
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now(),
  check (expires_at > created_at)
);

create index auth_sessions_active_idx
  on auth_sessions(token_hash, expires_at)
  where revoked_at is null;

-- ── Provider checks + AI advisory snapshot ───────────────────────────────────
alter table kyc_verifications
  add column applicant_type applicant_type not null default 'individual',
  add column provider_checks jsonb not null default '{}'::jsonb,
  add column ai_confidence numeric(5,4)
    check (ai_confidence is null or (ai_confidence >= 0 and ai_confidence <= 1)),
  add column ai_explanation text,
  add column ai_signals jsonb not null default '[]'::jsonb,
  add column submitted_at timestamptz not null default now(),
  add column decided_at timestamptz;

create table kyc_review_queue (
  id                   uuid primary key default gen_random_uuid(),
  verification_id      uuid not null unique references kyc_verifications(id) on delete restrict,
  user_id               uuid not null references users(id) on delete restrict,
  status                kyc_review_status not null default 'queued',
  provider_checks       jsonb not null,
  advisory_snapshot     jsonb not null,
  resolved_by           uuid references users(id) on delete set null,
  resolution            human_kyc_decision,
  resolution_reason     text,
  created_at            timestamptz not null default now(),
  resolved_at           timestamptz,
  check (
    (status = 'queued' and resolution is null and resolved_at is null)
    or
    (status = 'resolved' and resolution is not null and resolved_at is not null)
  )
);

create index kyc_review_queue_status_idx
  on kyc_review_queue(status, created_at);

-- Provider events remain idempotent and signature-verified. Add direct linkage
-- without retaining a raw provider payload (PII stays with the provider).
alter table webhook_events
  add column verification_id uuid references kyc_verifications(id) on delete set null;

-- ── Audit integrity ───────────────────────────────────────────────────────────
-- Existing audit_log update/delete rules enforce append-only behavior. Add
-- indexes used by compliance investigations and reproducibility queries.
create index audit_log_entity_idx on audit_log(entity, entity_id, created_at);
create index audit_log_actor_idx on audit_log(actor, created_at);

-- ── Row-level security (deny by default) ─────────────────────────────────────
-- Direct Postgres/backend access uses a privileged role. Supabase client access
-- receives no broad policies; only a user can read their own basic profile,
-- wallets, and verification state. KYC review/audit remain backend/admin-only.
alter table users enable row level security;
alter table businesses enable row level security;
alter table wallets enable row level security;
alter table kyc_verifications enable row level security;
alter table kyc_review_queue enable row level security;
alter table auth_sessions enable row level security;
alter table sep10_challenges enable row level security;
alter table audit_log enable row level security;

-- Supabase exposes auth.uid(); plain Postgres CI does not. Create self-read
-- policies only when that function exists. RLS remains enabled/deny-by-default
-- everywhere else.
do $$
begin
  if to_regprocedure('auth.uid()') is not null then
    execute 'create policy users_read_self on users for select using (auth.uid() = id)';
    execute 'create policy businesses_read_own on businesses for select using (owner_user_id = auth.uid())';
    execute 'create policy wallets_read_own on wallets for select using (user_id = auth.uid())';
    execute 'create policy kyc_verifications_read_own on kyc_verifications for select using (user_id = auth.uid())';
  end if;
end $$;

commit;
