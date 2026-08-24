-- StellarTrust — Phase 3 addendum: durable cross-border settlement persistence
-- Forward-only Postgres/Supabase migration (Rules.md §2).
--
-- Rationale:
--   Settlement was the last money-moving module with no tables at all: quotes,
--   settlement requests, legs, and reconciliation mismatches lived in a Map and
--   died with the process. That makes a completed payout unprovable after a
--   restart, and it makes the quote→execute idempotency guard (one settlement
--   per quote) a per-instance promise rather than a database one.
--
--   Shape mirrors migration 0007 (disputes): the full DTO is stored as a JSONB
--   snapshot — the reproducible contract of record (Rules.md §6) — alongside
--   the columns the repository filters, joins, and enforces uniqueness on.
--
-- Privacy:
--   No beneficiary handle is ever stored. A payout keeps its rail, destination
--   country, a masked display string, and a SHA-256 fingerprint of the
--   normalized handle. The fingerprint supports duplicate detection and
--   support lookups; it cannot be reversed into an account number, IBAN, or
--   UPI ID (Rules.md §7, D25).

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- Enums
-- ─────────────────────────────────────────────────────────────────────────────
create type settlement_status as enum
  ('quoted','deposit_pending','converting','payout_pending','completed','failed');

create type settlement_transition as enum ('deposit','convert','payout');

-- Local fiat delivery schemes, country-wise. Extend per launch corridor.
create type payout_rail as enum
  ('upi','imps','neft','sepa_instant','sepa_credit','ach','wire','nip');

-- ─────────────────────────────────────────────────────────────────────────────
-- Quotes — the priced offer a settlement request is executed against
-- ─────────────────────────────────────────────────────────────────────────────
create table settlement_quotes (
  id                    uuid primary key,
  -- A quote fixes a rate for one requester; execution checks this column.
  user_id               uuid not null references users(id) on delete restrict,
  corridor_id           text not null,
  source_currency       text not null,
  source_amount         bigint not null check (source_amount > 0),
  destination_currency  text not null,
  -- Converted amount before the local rail fee.
  destination_amount    bigint not null check (destination_amount > 0),
  payout_rail           payout_rail not null,
  payout_fee            bigint not null check (payout_fee >= 0),
  -- What the beneficiary actually receives: destination_amount - payout_fee.
  net_destination_amount bigint not null check (net_destination_amount > 0),
  route_type            text not null,
  expires_at            timestamptz not null,
  -- Full SettlementQuoteDTO (every considered route, constraints, timings).
  data                  jsonb not null,
  created_at            timestamptz not null,
  check (net_destination_amount = destination_amount - payout_fee)
);

create index settlement_quotes_user_idx
  on settlement_quotes(user_id, created_at desc);
-- Expired quotes are swept in bulk; they are worthless once past expiry.
create index settlement_quotes_expiry_idx on settlement_quotes(expires_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- Settlements — the request, and the same row once it completes or fails
-- ─────────────────────────────────────────────────────────────────────────────
create table settlements (
  id                     uuid primary key,
  user_id                uuid not null references users(id) on delete restrict,
  -- One settlement per quote: this is the idempotency guard for execution,
  -- enforced by the database rather than by a single process's memory.
  quote_id               uuid not null unique
                           references settlement_quotes(id) on delete restrict,
  corridor_id            text not null,
  status                 settlement_status not null,
  source_currency        text not null,
  source_amount          bigint not null check (source_amount > 0),
  destination_currency   text not null,
  destination_amount     bigint not null check (destination_amount > 0),

  -- ── Local delivery leg ───────────────────────────────────────────────────
  payout_rail            payout_rail not null,
  -- ISO-3166 country, or 'EU' for the SEPA region.
  payout_country         text not null,
  payout_fee             bigint not null check (payout_fee >= 0),
  payout_net_amount      bigint not null check (payout_net_amount > 0),
  -- Masked handle for display, e.g. '••••4321 · HDFC0001234'. Never raw.
  payout_destination_masked text not null,
  -- SHA-256 (hex) of the normalized handle: 64 lowercase hex characters.
  payout_destination_fingerprint text not null
    check (payout_destination_fingerprint ~ '^[0-9a-f]{64}$'),

  -- Full SettlementDTO snapshot (route, hops, payout, timestamps).
  data                   jsonb not null,
  -- Set once the settlement reaches a terminal state, in either direction.
  completed_at           timestamptz,
  failure_reason         text,
  created_at             timestamptz not null,
  updated_at             timestamptz not null,

  -- A terminal state must be explained: completed carries a timestamp, failed
  -- carries a reason. Anything in flight carries neither.
  check (
    (status = 'completed' and completed_at is not null and failure_reason is null)
    or (status = 'failed' and failure_reason is not null)
    or (status not in ('completed','failed') and completed_at is null
        and failure_reason is null)
  )
);

create index settlements_user_idx on settlements(user_id, created_at desc);
create index settlements_corridor_idx on settlements(corridor_id, created_at desc);
create index settlements_status_idx on settlements(status, created_at desc);
-- "Where else did this beneficiary get paid?" — answered without ever holding
-- the account number that would otherwise be needed to ask it.
create index settlements_destination_fingerprint_idx
  on settlements(payout_destination_fingerprint, created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- Transitions — one balanced ledger transaction per financial leg
-- ─────────────────────────────────────────────────────────────────────────────
create table settlement_transitions (
  id                     uuid primary key default gen_random_uuid(),
  settlement_id          uuid not null references settlements(id) on delete restrict,
  transition             settlement_transition not null,
  actor_id               text not null,
  -- The leg IS its ledger transaction; one-to-one, and never reusable.
  ledger_transaction_id  uuid not null unique
                           references ledger_transactions(id) on delete restrict,
  -- Anchor legs (deposit/payout) carry a transfer; the convert leg carries a
  -- chain record. The check below enforces exactly one of the two.
  anchor_reference       text,
  anchor_transfer        jsonb,
  stellar_transaction_id uuid references stellar_transactions(id) on delete restrict,
  created_at             timestamptz not null default now(),
  -- A leg happens once per settlement.
  unique (settlement_id, transition),
  check (
    (transition in ('deposit','payout')
      and anchor_reference is not null and anchor_transfer is not null
      and stellar_transaction_id is null)
    or
    (transition = 'convert'
      and anchor_reference is null and anchor_transfer is null
      and stellar_transaction_id is not null)
  )
);

create index settlement_transitions_settlement_idx
  on settlement_transitions(settlement_id, created_at);
create index settlement_transitions_anchor_ref_idx
  on settlement_transitions(anchor_reference);

-- ─────────────────────────────────────────────────────────────────────────────
-- Reconciliation — ledger vs anchor vs chain, per leg
-- ─────────────────────────────────────────────────────────────────────────────
create table settlement_reconciliation_mismatches (
  id                       uuid primary key,
  settlement_id            uuid not null references settlements(id) on delete restrict,
  settlement_transition_id uuid not null
                             references settlement_transitions(id) on delete restrict,
  reason                   text not null,
  status                   reconciliation_status not null default 'open',
  detected_at              timestamptz not null default now(),
  resolved_at              timestamptz,
  check (
    (status = 'open' and resolved_at is null)
    or (status = 'resolved' and resolved_at is not null)
  )
);

-- At most one OPEN mismatch per leg: re-running reconciliation must not pile up
-- duplicates of a problem that is still the same problem.
create unique index settlement_reconciliation_one_open_per_transition_idx
  on settlement_reconciliation_mismatches(settlement_transition_id)
  where status = 'open';
create index settlement_reconciliation_open_idx
  on settlement_reconciliation_mismatches(settlement_id)
  where status = 'open';

-- ─────────────────────────────────────────────────────────────────────────────
-- Chart of accounts for the settlement bounded context
-- ─────────────────────────────────────────────────────────────────────────────
-- These are new names on purpose. The settlement service previously posted
-- against the synthetic ids that map to `rwa_payout_payable` and
-- `rwa_payout_reserve`; resolved against the real chart, FX conversions would
-- have landed in the RWA payout accounts.
insert into ledger_accounts (type, currency, owner_ref, name)
select account_type::ledger_account_type, currency, 'system', account_name
from (values
  ('asset',     'settlement_source_anchor_clearing'),
  ('liability', 'settlement_user_source_liability'),
  ('asset',     'settlement_fx_conversion'),
  ('liability', 'settlement_user_dest_liability'),
  ('asset',     'settlement_dest_anchor_clearing'),
  ('revenue',   'settlement_liquidity_fee_revenue'),
  ('revenue',   'settlement_payout_fee_revenue')
) as account_kinds(account_type, account_name)
cross join (values ('USD'),('EUR'),('INR'),('NGN'),('XLM'),('USDC'))
  as currencies(currency)
on conflict (owner_ref, currency, name) do nothing;

-- Deny-by-default RLS (the backend uses a privileged role; matches 0003/0004).
alter table settlement_quotes enable row level security;
alter table settlements enable row level security;
alter table settlement_transitions enable row level security;
alter table settlement_reconciliation_mismatches enable row level security;

commit;
