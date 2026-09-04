-- StellarTrust — domain event spine + settlement/order linkage
-- (plane.md §2.1 and §2.3)
-- Forward-only Postgres/Supabase migration (Rules.md §2).
--
-- Why this exists
-- ───────────────
-- The four domains (payments, settlement, disputes, RWA) each worked, and
-- composed only where somebody had hard-wired one into another. The single
-- example was `PaymentService.triggerRwaPayout`, a direct call from payments
-- into the RWA service: payments had to import RWA, know its interface, and
-- swallow its failures so a payout error could not roll back a release. Every
-- further link would have added another such edge, and the coupling only ever
-- ran one way.
--
-- Two tables replace that.
--
--   domain_events        the append-only spine. Every cross-domain fact is
--                        published here once, by the module that owns it.
--   domain_event_handled the idempotency ledger. One row per (event, handler)
--                        that has run to completion, so a replay — a retry, a
--                        restart mid-dispatch, a re-delivered event — finds the
--                        row and does nothing a second time.
--
-- Idempotency is a table rather than a convention because Golden Rule #4 wants
-- it provable across instances: two API servers dispatching the same event must
-- not both run the handler, and a unique constraint is the only thing that
-- settles that race honestly.
--
-- The settlement↔order link is here too because it is the same kind of gap: a
-- settlement that funded an escrow order had no column pointing at the order,
-- so the buyer paid the corridor and then paid the escrow again.

-- ─────────────────────────────────────────────────────────────────────────────
-- The event spine
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists domain_events (
  id           uuid primary key default gen_random_uuid(),

  -- Dotted name of what happened, past tense: order.released,
  -- dispute.opened, settlement.completed, tokenization.matured.
  event_type   text not null,

  -- What the event is about. `entity` is the aggregate kind ('order',
  -- 'dispute', 'settlement', 'tokenization'); `entity_id` the row.
  entity       text not null,
  entity_id    text not null,

  -- Who caused it: 'user:<id>' or 'system:<component>', matching audit_log.
  actor        text not null,

  -- Safe payload only — no PII, tokens, or secrets (Rules.md §3). Amounts and
  -- opaque ids are fine; names, addresses, and documents are not.
  payload      jsonb not null default '{}'::jsonb,

  -- Supplied by the publisher and unique: the natural key of the fact, e.g.
  -- 'order.released:<orderId>'. A publisher that retries after a failed commit
  -- collides here instead of publishing the same fact twice.
  dedupe_key   text not null,

  occurred_at  timestamptz not null default now(),

  constraint domain_events_type_not_blank check (length(trim(event_type)) > 0),
  constraint domain_events_entity_not_blank check (length(trim(entity)) > 0)
);

-- The publish-side idempotency guarantee.
create unique index if not exists domain_events_dedupe_key_idx
  on domain_events(dedupe_key);

-- Reading an aggregate's history, which is how a position view assembles the
-- story of one order across four domains.
create index if not exists domain_events_entity_idx
  on domain_events(entity, entity_id, occurred_at desc);

-- Dispatch scans by type.
create index if not exists domain_events_type_idx
  on domain_events(event_type, occurred_at desc);

-- Append-only, exactly like audit_log: an event is a record of something that
-- already happened, and rewriting history is how a reconciliation becomes a
-- fiction.
drop rule if exists domain_events_no_update on domain_events;
create rule domain_events_no_update as
  on update to domain_events do instead nothing;

drop rule if exists domain_events_no_delete on domain_events;
create rule domain_events_no_delete as
  on delete to domain_events do instead nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- The consume-side idempotency ledger
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists domain_event_handled (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references domain_events(id) on delete cascade,

  -- Stable name of the subscriber, e.g. 'rwa.payout-on-release'. Renaming one
  -- deliberately re-runs its history, which is occasionally what you want.
  handler     text not null,

  handled_at  timestamptz not null default now(),

  -- What the handler did, for operators reading a replay after the fact.
  outcome     text not null default 'applied',

  constraint domain_event_handled_outcome
    check (outcome in ('applied', 'skipped', 'failed'))
);

-- The whole point: one completed run per (event, handler), enforced by the
-- database rather than by a well-behaved caller.
create unique index if not exists domain_event_handled_unique_idx
  on domain_event_handled(event_id, handler);

create index if not exists domain_event_handled_handler_idx
  on domain_event_handled(handler, handled_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- Settlement → escrow order linkage (plane.md §2.1)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- A cross-border settlement could fund an escrow order, but nothing recorded
-- that it had: the corridor delivered the money and the order still sat
-- awaiting a deposit, so the buyer paid twice. This column is the link, and the
-- partial unique index below is what stops two settlements from both claiming
-- to have funded the same order.

alter table settlements
  add column if not exists order_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'settlements_order_id_fkey'
  ) then
    alter table settlements
      add constraint settlements_order_id_fkey
      foreign key (order_id) references orders(id);
  end if;
end$$;

create index if not exists settlements_order_idx
  on settlements(order_id)
  where order_id is not null;

-- At most one settlement may fund a given order. Partial, so the ordinary case
-- — a settlement with no order at all — is unconstrained, while a second
-- attempt to fund an already-funded order fails at the database.
create unique index if not exists settlements_one_per_order_idx
  on settlements(order_id)
  where order_id is not null;
