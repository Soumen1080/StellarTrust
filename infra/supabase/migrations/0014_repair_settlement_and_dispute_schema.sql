-- StellarTrust — repair: re-apply the settlement (0011) and dispute-party
-- (0012) schema on a database where those two migrations never ran.
-- Forward-only Postgres/Supabase migration (Rules.md §2).
--
-- Why this exists:
--   The deployed Supabase database was migrated by hand, and 0011/0012 were
--   skipped while 0013 was applied. The symptom is an "Internal server error"
--   banner on every settlement page and on the disputes list, because:
--     * `settlements` / `settlement_quotes` did not exist at all, so
--       `GET /api/settlement/orders`, `GET /api/settlement/orders/:id` and
--       `POST /api/settlement/quotes` failed on an undefined table; and
--     * `dispute_records` existed (0007) but without the `buyer_id` /
--       `seller_id` columns 0012 adds, so `listForParty` — the query behind
--       `GET /api/disputes` — failed on an undefined column. The escrow page
--       calls the same endpoint for its per-order claim badges.
--
--   Every statement below is idempotent, so this is safe on a database where
--   0011/0012 already ran (it becomes a no-op) and on one where they only ran
--   in part. Running the originals verbatim would abort on the first
--   already-existing object; this will not.

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- 0011 · Enums
-- ─────────────────────────────────────────────────────────────────────────────
do $$ begin
  create type settlement_status as enum
    ('quoted','deposit_pending','converting','payout_pending','completed','failed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type settlement_transition as enum ('deposit','convert','payout');
exception when duplicate_object then null; end $$;

do $$ begin
  create type payout_rail as enum
    ('upi','imps','neft','sepa_instant','sepa_credit','ach','wire','nip');
exception when duplicate_object then null; end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 0011 · Quotes — the priced offer a settlement request is executed against
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists settlement_quotes (
  id                    uuid primary key,
  user_id               uuid not null references users(id) on delete restrict,
  corridor_id           text not null,
  source_currency       text not null,
  source_amount         bigint not null check (source_amount > 0),
  destination_currency  text not null,
  destination_amount    bigint not null check (destination_amount > 0),
  payout_rail           payout_rail not null,
  payout_fee            bigint not null check (payout_fee >= 0),
  net_destination_amount bigint not null check (net_destination_amount > 0),
  route_type            text not null,
  expires_at            timestamptz not null,
  data                  jsonb not null,
  created_at            timestamptz not null,
  check (net_destination_amount = destination_amount - payout_fee)
);

create index if not exists settlement_quotes_user_idx
  on settlement_quotes(user_id, created_at desc);
create index if not exists settlement_quotes_expiry_idx
  on settlement_quotes(expires_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- 0011 · Settlements — the request, and the same row once it ends
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists settlements (
  id                     uuid primary key,
  user_id                uuid not null references users(id) on delete restrict,
  quote_id               uuid not null unique
                           references settlement_quotes(id) on delete restrict,
  corridor_id            text not null,
  status                 settlement_status not null,
  source_currency        text not null,
  source_amount          bigint not null check (source_amount > 0),
  destination_currency   text not null,
  destination_amount     bigint not null check (destination_amount > 0),
  payout_rail            payout_rail not null,
  payout_country         text not null,
  payout_fee             bigint not null check (payout_fee >= 0),
  payout_net_amount      bigint not null check (payout_net_amount > 0),
  payout_destination_masked text not null,
  payout_destination_fingerprint text not null
    check (payout_destination_fingerprint ~ '^[0-9a-f]{64}$'),
  data                   jsonb not null,
  completed_at           timestamptz,
  failure_reason         text,
  created_at             timestamptz not null,
  updated_at             timestamptz not null,
  check (
    (status = 'completed' and completed_at is not null and failure_reason is null)
    or (status = 'failed' and failure_reason is not null)
    or (status not in ('completed','failed') and completed_at is null
        and failure_reason is null)
  )
);

create index if not exists settlements_user_idx
  on settlements(user_id, created_at desc);
create index if not exists settlements_corridor_idx
  on settlements(corridor_id, created_at desc);
create index if not exists settlements_status_idx
  on settlements(status, created_at desc);
create index if not exists settlements_destination_fingerprint_idx
  on settlements(payout_destination_fingerprint, created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- 0011 · Transitions — one balanced ledger transaction per financial leg
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists settlement_transitions (
  id                     uuid primary key default gen_random_uuid(),
  settlement_id          uuid not null references settlements(id) on delete restrict,
  transition             settlement_transition not null,
  actor_id               text not null,
  ledger_transaction_id  uuid not null unique
                           references ledger_transactions(id) on delete restrict,
  anchor_reference       text,
  anchor_transfer        jsonb,
  stellar_transaction_id uuid references stellar_transactions(id) on delete restrict,
  created_at             timestamptz not null default now(),
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

create index if not exists settlement_transitions_settlement_idx
  on settlement_transitions(settlement_id, created_at);
create index if not exists settlement_transitions_anchor_ref_idx
  on settlement_transitions(anchor_reference);

-- ─────────────────────────────────────────────────────────────────────────────
-- 0011 · Reconciliation — ledger vs anchor vs chain, per leg
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists settlement_reconciliation_mismatches (
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

create unique index if not exists
  settlement_reconciliation_one_open_per_transition_idx
  on settlement_reconciliation_mismatches(settlement_transition_id)
  where status = 'open';
create index if not exists settlement_reconciliation_open_idx
  on settlement_reconciliation_mismatches(settlement_id)
  where status = 'open';

-- ─────────────────────────────────────────────────────────────────────────────
-- 0011 · Chart of accounts for the settlement bounded context
-- ─────────────────────────────────────────────────────────────────────────────
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
alter table settlement_quotes                    enable row level security;
alter table settlements                          enable row level security;
alter table settlement_transitions               enable row level security;
alter table settlement_reconciliation_mismatches enable row level security;

-- ─────────────────────────────────────────────────────────────────────────────
-- 0012 · Dispute parties (both sides of the claim)
-- ─────────────────────────────────────────────────────────────────────────────
alter table dispute_records
  add column if not exists buyer_id  uuid references users(id) on delete restrict,
  add column if not exists seller_id uuid references users(id) on delete restrict;

-- Backfill from the order each dispute was filed against.
update dispute_records d
   set buyer_id  = o.buyer_id,
       seller_id = o.seller_id
  from orders o
 where o.id = d.order_id
   and (d.buyer_id is null or d.seller_id is null);

-- `order_id` is NOT NULL with an FK to `orders`, so the backfill above covers
-- every row and the NOT NULL below is satisfiable. Guarded anyway: a partially
-- repaired database should report the offending rows rather than abort the
-- whole migration on a bare constraint violation.
do $$
declare orphan_count bigint;
begin
  select count(*) into orphan_count
    from dispute_records
   where buyer_id is null or seller_id is null;

  if orphan_count = 0 then
    alter table dispute_records
      alter column buyer_id  set not null,
      alter column seller_id set not null;
  else
    raise warning
      'dispute_records: % row(s) have no derivable buyer_id/seller_id; both columns left nullable. Inspect them, then re-run.',
      orphan_count;
  end if;
end $$;

-- Mirror the parties into the JSONB snapshot, which is the DTO the API returns.
-- Without this, rows written before the repair come back missing
-- `buyerId`/`sellerId` and the party check reads as undefined.
update dispute_records
   set data = data
         || jsonb_build_object('buyerId', buyer_id::text)
         || jsonb_build_object('sellerId', seller_id::text)
 where buyer_id is not null
   and seller_id is not null
   and (not (data ? 'buyerId') or not (data ? 'sellerId'));

-- "Every dispute I am party to", the query behind the disputes list.
create index if not exists dispute_records_buyer_idx
  on dispute_records(buyer_id, created_at desc);
create index if not exists dispute_records_seller_idx
  on dispute_records(seller_id, created_at desc);
-- The escrow view asks "is there a claim on this order?" per order card.
create index if not exists dispute_records_order_created_idx
  on dispute_records(order_id, created_at desc);

commit;
