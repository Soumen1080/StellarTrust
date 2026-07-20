-- StellarTrust — Phase 2: Core Payment + Escrow
-- Forward-only Postgres/Supabase migration.
-- Every order transition is committed in one DB transaction with a balanced
-- ledger transaction and a linked Stellar transaction record.

begin;

create type payment_transition as enum
  ('create','accept','deposit','lock','confirm','release','refund');
create type reconciliation_status as enum ('open','resolved');

alter table orders
  add column reconciliation_blocked boolean not null default false;

alter table stellar_transactions
  add column order_id uuid references orders(id) on delete restrict,
  add column transition payment_transition,
  add column amount bigint check (amount is null or amount > 0),
  add column currency text,
  add column contract_id text,
  add column updated_at timestamptz not null default now(),
  add constraint stellar_payment_metadata_complete check (
    (order_id is null and transition is null and amount is null and currency is null)
    or
    (order_id is not null and transition is not null and amount is not null and currency is not null)
  );

create table payment_transitions (
  id                    uuid primary key default gen_random_uuid(),
  order_id              uuid not null references orders(id) on delete restrict,
  transition            payment_transition not null,
  actor_id               text not null,
  ledger_transaction_id uuid not null unique references ledger_transactions(id) on delete restrict,
  stellar_transaction_id uuid not null unique references stellar_transactions(id) on delete restrict,
  created_at            timestamptz not null default now(),
  unique (order_id, transition)
);

create table reconciliation_mismatches (
  id                    uuid primary key default gen_random_uuid(),
  order_id              uuid not null references orders(id) on delete restrict,
  payment_transition_id uuid not null references payment_transitions(id) on delete restrict,
  reason                text not null,
  status                reconciliation_status not null default 'open',
  detected_at           timestamptz not null default now(),
  resolved_at           timestamptz,
  check (
    (status = 'open' and resolved_at is null)
    or (status = 'resolved' and resolved_at is not null)
  )
);

create unique index reconciliation_one_open_per_transition_idx
  on reconciliation_mismatches(payment_transition_id)
  where status = 'open';
create index payment_transitions_order_idx
  on payment_transitions(order_id, created_at);
create index stellar_transactions_order_idx
  on stellar_transactions(order_id, created_at);
create index reconciliation_open_order_idx
  on reconciliation_mismatches(order_id)
  where status = 'open';

-- Phase 2 supports every shared MVP asset code. These accounts are internal
-- controls; party sub-ledgers can be added without changing transition logic.
insert into ledger_accounts (type, currency, owner_ref, name)
select account_type::ledger_account_type, currency, 'system', account_name
from (values
  ('asset', 'commitment_asset'),
  ('liability', 'commitment_liability'),
  ('asset', 'cash_clearing'),
  ('liability', 'escrow_holding'),
  ('asset', 'contract_custody'),
  ('asset', 'delivery_confirmation_asset'),
  ('liability', 'delivery_confirmation_liability')
) as account_kinds(account_type, account_name)
cross join (values ('USD'),('EUR'),('INR'),('NGN'),('XLM'),('USDC'))
  as currencies(currency)
on conflict (owner_ref, currency, name) do nothing;

-- Deferred cross-table invariant: a payment transition's chain record must
-- point to the same ledger transaction and carry the same order/transition.
create or replace function assert_payment_transition_linked()
returns trigger
language plpgsql
as $$
declare
  chain_record stellar_transactions%rowtype;
begin
  select * into chain_record
  from stellar_transactions
  where id = new.stellar_transaction_id;

  if chain_record.ledger_transaction_id is distinct from new.ledger_transaction_id
     or chain_record.order_id is distinct from new.order_id
     or chain_record.transition is distinct from new.transition then
    raise exception 'Payment transition % is not linked to matching ledger/chain records', new.id
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

create constraint trigger payment_transition_link_check
  after insert or update on payment_transitions
  deferrable initially deferred
  for each row execute function assert_payment_transition_linked();

-- Fail closed: reconciliation sets this flag and no lifecycle state may advance
-- until a human/system resolution clears it.
create or replace function block_unreconciled_order_transition()
returns trigger
language plpgsql
as $$
begin
  if old.reconciliation_blocked and new.status <> old.status then
    raise exception 'Order % is blocked by an unresolved reconciliation mismatch', old.id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger orders_reconciliation_block
  before update of status on orders
  for each row execute function block_unreconciled_order_transition();

create or replace function sync_order_reconciliation_block()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' and new.status = 'open' then
    update orders set reconciliation_blocked = true where id = new.order_id;
  elsif tg_op = 'UPDATE' and new.status = 'resolved' then
    update orders
    set reconciliation_blocked = exists (
      select 1 from reconciliation_mismatches
      where order_id = new.order_id and status = 'open' and id <> new.id
    )
    where id = new.order_id;
  end if;
  return new;
end;
$$;

create trigger reconciliation_block_sync
  after insert or update of status on reconciliation_mismatches
  for each row execute function sync_order_reconciliation_block();

alter table orders enable row level security;
alter table escrows enable row level security;
alter table ledger_accounts enable row level security;
alter table ledger_transactions enable row level security;
alter table ledger_entries enable row level security;
alter table stellar_transactions enable row level security;
alter table payment_transitions enable row level security;
alter table reconciliation_mismatches enable row level security;

commit;
