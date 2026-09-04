-- StellarTrust — KYC + reputation persistence (plane.md §4.2) and the
-- verification routing policy the admin console edits.
-- Forward-only Postgres/Supabase migration (Rules.md §2).
--
-- Why this exists
-- ───────────────
-- Two stores were still in memory: KYC verification/review state, and the
-- reputation counters. Both are consulted when money moves — KYC gates an
-- investor purchase (§3.2), reputation scores a counterparty at verification
-- (§3.1) — and both reset on restart. A deploy therefore silently re-opened
-- every closed review and reset every user's track record to neutral.
--
-- The third table here is new: `verification_policies`. Until now the decision
-- of whether a verification passes automatically, goes to the AI advisor, or
-- waits for a human was fixed in environment variables, which means changing
-- it is a redeploy. That is the wrong shape for a policy an operator has to
-- tune against live fraud patterns, so it becomes a row an authorised operator
-- edits — and every edit is audited, because a control that can be loosened
-- without a trace is not a control.

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- §4.2 — KYC review persistence
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `kyc_verifications` already exists (migration 0001) but stores only the
-- aggregate score/decision, not the full response the service reads back. The
-- response is kept as jsonb: it is a provider-shaped document the service
-- round-trips whole, and normalising it would mean a migration every time a
-- provider adds a check.
--
-- **No raw PII.** The stored response carries check *outcomes*, the advisory
-- score, and opaque references — never document values, names, or dates of
-- birth (Rules.md §3). That is a property of what the service puts in, and the
-- comment is here so the next person to widen it knows what they are widening.

create table kyc_verification_records (
  verification_id uuid primary key,
  user_id         uuid not null references users(id) on delete cascade,
  response        jsonb not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index kyc_verification_records_user_idx
  on kyc_verification_records (user_id, created_at desc);

-- `human_kyc_decision` was declared in 0003; `review_status` never was —
-- the review queue lived only in memory, so nothing needed the type.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'review_status') then
    create type review_status as enum ('queued', 'resolved');
  end if;
end;
$$;

create table kyc_reviews (
  id                uuid primary key,
  verification_id   uuid not null references kyc_verification_records(verification_id) on delete cascade,
  user_id           uuid not null references users(id) on delete cascade,
  status            review_status not null default 'queued',
  advisory          jsonb not null,
  provider_checks   jsonb not null,
  resolved_by       uuid references users(id) on delete restrict,
  resolution        human_kyc_decision,
  resolution_reason text,
  created_at        timestamptz not null default now(),
  resolved_at       timestamptz,

  -- A resolved review says who decided, what they decided, and why. Without
  -- this a review could be closed with no record of the decision, which is
  -- precisely what Rules.md §6 requires be auditable.
  constraint kyc_reviews_resolution_is_complete check (
    status <> 'resolved'
    or (resolved_by is not null
        and resolution is not null
        and resolution_reason is not null
        and resolved_at is not null)
  )
);

create index kyc_reviews_queue_idx
  on kyc_reviews (created_at asc)
  where status = 'queued';
create index kyc_reviews_user_idx on kyc_reviews (user_id, created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- §4.2 — Reputation persistence
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Counters only. The score is *derived* from them at read time
-- (`computeScore`), deliberately not stored, so the formula can change without
-- a migration and without every historical score silently meaning something
-- different from the one beside it.

create table reputation_records (
  user_id           uuid primary key references users(id) on delete cascade,
  orders_completed  integer not null default 0 check (orders_completed >= 0),
  disputes_won      integer not null default 0 check (disputes_won >= 0),
  disputes_lost     integer not null default 0 check (disputes_lost >= 0),
  updated_at        timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification routing policy (the admin console's decision surface)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- One row per domain that has a verification decision to make. Two today —
-- KYC onboarding and RWA asset verification — and the table is keyed by domain
-- rather than having a column per domain so adding a third is a row, not a
-- migration.
--
-- `mode` is the operator's headline choice:
--   auto     — decide from the deterministic policy alone; approve without a
--              human when it is confident. Fastest, and the right setting only
--              where the downside of a wrong approval is small.
--   ai       — consult the advisory risk engine, then apply the thresholds.
--              This is the default and matches what the code did before this
--              table existed.
--   human    — every submission queues for a person, whatever the engine says.
--              The setting to reach for during an incident.
--
-- The thresholds below still apply in `auto` and `ai`; `human` short-circuits
-- them. Note that AI remains advisory in every mode (Rules.md §6): `auto` does
-- not mean the model decides, it means the *deterministic policy* decides
-- without queueing.

create type verification_mode as enum ('auto', 'ai', 'human');

create table verification_policies (
  domain              text primary key
                        check (domain in ('kyc', 'rwa_asset')),
  mode                verification_mode not null default 'ai',

  -- Risk at or below which an automatic approval is allowed, and at or above
  -- which an automatic rejection is. Stored in basis points as integers: a
  -- threshold held as a float is a threshold that compares differently
  -- depending on how it was written down.
  approve_max_risk_bps integer not null default 3500
                        check (approve_max_risk_bps between 0 and 10000),
  reject_min_risk_bps  integer not null default 7000
                        check (reject_min_risk_bps between 0 and 10000),
  -- Below this confidence the advisory is not trusted and the case goes to a
  -- human regardless of the score.
  min_confidence_bps   integer not null default 7000
                        check (min_confidence_bps between 0 and 10000),

  -- Above this amount (minor units) a decision always requires a human, even
  -- when every threshold is satisfied. Rules.md §6: no autonomous money
  -- decision above threshold. Zero disables the amount gate.
  human_review_above_amount bigint not null default 0
                        check (human_review_above_amount >= 0),

  updated_by          uuid references users(id) on delete restrict,
  updated_at          timestamptz not null default now(),

  -- An approval band that overlaps the rejection band is not a policy, it is
  -- two contradictory instructions. Refuse it here rather than resolve it
  -- arbitrarily at read time.
  constraint verification_policies_bands_are_ordered
    check (approve_max_risk_bps < reject_min_risk_bps)
);

comment on table verification_policies is
  'How each verification domain routes a decision: automatically, through the '
  'advisory risk engine, or to a human. Edited by an operator through the '
  'admin console; every change is written to the audit log.';

-- Seeded to match the behaviour that was previously compiled in, so applying
-- this migration changes nothing until an operator decides otherwise. The
-- defaults mirror KYC_APPROVE_MAX_RISK=0.35, KYC_REJECT_MIN_RISK=0.7 and
-- KYC_MIN_CONFIDENCE=0.7.
insert into verification_policies (domain, mode) values
  ('kyc', 'ai'),
  ('rwa_asset', 'human')  -- asset verification has always required compliance
on conflict (domain) do nothing;

commit;
