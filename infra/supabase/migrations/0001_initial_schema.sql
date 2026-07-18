-- StellarTrust — initial schema (Phase 0)
-- Postgres / Supabase. Forward-only migration (Rules.md §2).
--
-- Golden Rule #1: the double-entry ledger is the system of record. Every money
-- movement writes a balanced set of ledger_entries (debits == credits per
-- currency) AND a stellar_transactions record. The balancing invariant is
-- enforced at the DATABASE level here (a deferred constraint trigger) so an
-- unbalanced write can never be committed — even if application code is wrong.

begin;

create extension if not exists "pgcrypto";  -- gen_random_uuid()

-- ─────────────────────────────────────────────────────────────────────────────
-- Enums (mirror @stellartrust/shared constants)
-- ─────────────────────────────────────────────────────────────────────────────
create type kyc_status       as enum ('pending', 'under_review', 'verified', 'rejected');
create type kyc_decision      as enum ('approve', 'review', 'reject');
create type order_status      as enum ('created','accepted','deposited','locked','confirmed','released','refunded','disputed','cancelled');
create type escrow_state      as enum ('locked','released','refunded','disputed');
create type dispute_status    as enum ('open','evidence_window','under_review','resolved');
create type ai_recommendation as enum ('release','refund','manual_review');
create type entry_direction   as enum ('debit','credit');
create type ledger_account_type as enum ('asset','liability','equity','revenue','expense');
create type chain_tx_status   as enum ('pending','submitted','success','failed');
create type custody_type      as enum ('self','contract');

-- ─────────────────────────────────────────────────────────────────────────────
-- Identity
-- ─────────────────────────────────────────────────────────────────────────────
create table users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  kyc_status    kyc_status not null default 'pending',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table businesses (
  id            uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete restrict,
  legal_name    text not null,
  country       text not null,
  created_at    timestamptz not null default now()
);

create table kyc_verifications (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  provider      text not null,
  provider_ref  text,
  -- AI risk aggregation is advisory (Rules.md §6): store score + decision only,
  -- never raw PII from the provider payload.
  risk_score    numeric(5,4) check (risk_score >= 0 and risk_score <= 1),
  decision      kyc_decision,
  status        kyc_status not null default 'pending',
  created_at    timestamptz not null default now()
);

create table wallets (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references users(id) on delete cascade,
  stellar_public_key text not null unique,
  custody_type       custody_type not null default 'self',
  created_at         timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Double-entry ledger (core — system of record)
-- ─────────────────────────────────────────────────────────────────────────────
create table ledger_accounts (
  id         uuid primary key default gen_random_uuid(),
  type       ledger_account_type not null,
  currency   text not null,
  owner_ref  text,                    -- e.g. user:<id>, business:<id>, or a system account
  name       text not null,
  created_at timestamptz not null default now(),
  unique (owner_ref, currency, name)
);

create table ledger_transactions (
  id           uuid primary key default gen_random_uuid(),
  reference_id text not null unique,   -- idempotency / correlation; prevents double-posting
  description  text not null,
  created_at   timestamptz not null default now()
);

create table ledger_entries (
  id             uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references ledger_transactions(id) on delete cascade,
  account_id     uuid not null references ledger_accounts(id) on delete restrict,
  direction      entry_direction not null,
  -- Integer minor units. bigint holds ± 9.2e18 minor units — ample for MVP.
  amount         bigint not null check (amount > 0),
  currency       text not null,
  created_at     timestamptz not null default now()
);

create index ledger_entries_transaction_id_idx on ledger_entries(transaction_id);
create index ledger_entries_account_id_idx      on ledger_entries(account_id);

-- ── Balancing invariant enforced by the database ─────────────────────────────
-- A transaction is balanced iff, for every currency, sum(debits) == sum(credits)
-- and there is at least one debit and one credit. Checked at COMMIT time via a
-- DEFERRED constraint trigger, so multi-row inserts within one tx are allowed to
-- be assembled first and validated as a whole.
create or replace function assert_ledger_transaction_balanced()
returns trigger
language plpgsql
as $$
declare
  unbalanced_count int;
  side_count int;
begin
  -- Any currency where debits <> credits?
  select count(*) into unbalanced_count
  from (
    select currency,
           sum(case when direction = 'debit'  then amount else 0 end) as debits,
           sum(case when direction = 'credit' then amount else 0 end) as credits
    from ledger_entries
    where transaction_id = coalesce(new.transaction_id, old.transaction_id)
    group by currency
  ) totals
  where totals.debits <> totals.credits;

  -- Must have at least one debit and one credit overall.
  select count(distinct direction) into side_count
  from ledger_entries
  where transaction_id = coalesce(new.transaction_id, old.transaction_id);

  if unbalanced_count > 0 or side_count < 2 then
    raise exception 'Unbalanced ledger transaction % (debits must equal credits per currency, with both sides present)',
      coalesce(new.transaction_id, old.transaction_id)
      using errcode = 'check_violation';
  end if;

  return null;
end;
$$;

create constraint trigger ledger_balance_check
  after insert or update or delete on ledger_entries
  deferrable initially deferred
  for each row
  execute function assert_ledger_transaction_balanced();

-- ─────────────────────────────────────────────────────────────────────────────
-- Orders / Escrow
-- ─────────────────────────────────────────────────────────────────────────────
create table orders (
  id         uuid primary key default gen_random_uuid(),
  buyer_id   uuid not null references users(id)  on delete restrict,
  seller_id  uuid not null references users(id)  on delete restrict,
  amount     bigint not null check (amount > 0),
  currency   text not null,
  status     order_status not null default 'created',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (buyer_id <> seller_id)
);

create table escrows (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null unique references orders(id) on delete restrict,
  contract_id text,
  state       escrow_state not null default 'locked',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Disputes + AI advisory
-- ─────────────────────────────────────────────────────────────────────────────
create table disputes (
  id                 uuid primary key default gen_random_uuid(),
  escrow_id          uuid not null references escrows(id) on delete restrict,
  status             dispute_status not null default 'open',
  ai_recommendation  ai_recommendation,
  ai_confidence      numeric(5,4) check (ai_confidence >= 0 and ai_confidence <= 1),
  ai_explanation     text,
  human_decision     ai_recommendation,   -- human gate (Rules.md #3)
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table dispute_evidence (
  id          uuid primary key default gen_random_uuid(),
  dispute_id  uuid not null references disputes(id) on delete cascade,
  kind        text not null,        -- invoice | tracking | otp | courier | image
  uri         text not null,        -- storage reference; never inline PII
  submitted_by uuid references users(id) on delete set null,
  created_at  timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- RWA (opt-in module — peer, not in escrow happy path)
-- ─────────────────────────────────────────────────────────────────────────────
create table assets (
  id          uuid primary key default gen_random_uuid(),
  issuer_id   uuid not null references users(id) on delete restrict,
  kind        text not null,        -- invoice | commodity | real_estate
  face_value  bigint not null check (face_value > 0),
  currency    text not null,
  created_at  timestamptz not null default now()
);

create table tokenizations (
  id            uuid primary key default gen_random_uuid(),
  asset_id      uuid not null references assets(id) on delete restrict,
  stellar_asset_code text not null,
  total_units   bigint not null check (total_units > 0),
  created_at    timestamptz not null default now()
);

create table token_holdings (
  id             uuid primary key default gen_random_uuid(),
  tokenization_id uuid not null references tokenizations(id) on delete restrict,
  investor_id    uuid not null references users(id) on delete restrict,
  units          bigint not null check (units > 0),
  created_at     timestamptz not null default now(),
  unique (tokenization_id, investor_id)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Chain reconciliation + webhooks
-- ─────────────────────────────────────────────────────────────────────────────
create table stellar_transactions (
  id                     uuid primary key default gen_random_uuid(),
  hash                   text unique,
  type                   text not null,
  status                 chain_tx_status not null default 'pending',
  ledger_transaction_id  uuid references ledger_transactions(id) on delete set null,
  created_at             timestamptz not null default now()
);

create table webhook_events (
  id           uuid primary key default gen_random_uuid(),
  source       text not null,
  external_id  text not null,        -- provider event id (idempotency)
  signature_verified boolean not null default false,
  payload_ref  text,                 -- storage reference; do not inline raw PII
  processed_at timestamptz,
  created_at   timestamptz not null default now(),
  unique (source, external_id)       -- replay protection (Rules.md §7)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Audit log (append-only — Rules.md #6)
-- ─────────────────────────────────────────────────────────────────────────────
create table audit_log (
  id         uuid primary key default gen_random_uuid(),
  actor      text not null,          -- user:<id> | system | ai
  action     text not null,
  entity     text not null,
  entity_id  text,
  metadata   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Enforce append-only on the audit log.
create rule audit_log_no_update as on update to audit_log do instead nothing;
create rule audit_log_no_delete as on delete to audit_log do instead nothing;

commit;
