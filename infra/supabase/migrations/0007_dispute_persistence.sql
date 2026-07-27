-- StellarTrust — Phase 4 addendum: durable dispute persistence
-- Forward-only Postgres/Supabase migration (Rules.md §2).
--
-- Rationale:
--   The Phase 0 `disputes` table (0001) predates the Phase 4 DisputeDTO and
--   cannot round-trip it: it has no columns for order_id, opened_by, amount,
--   reason, the evidence window, the evidence set, the AI advisory signals, or
--   the resolution sub-record — and its `escrow_id` is NOT NULL with an FK to
--   `escrows`, whereas a dispute is opened against an ORDER before any escrow
--   exists (DisputeService sets escrowId = null on open).
--
--   Rather than lossily normalize a fast-moving Phase 4 contract, store the full
--   DisputeDTO as a JSONB snapshot alongside the columns the repository queries
--   by. The DTO is a reproducible contract of record (Rules.md §6), so a
--   snapshot is the authoritative, tamper-checkable representation. The legacy
--   `disputes`/`dispute_evidence` tables are left untouched (unused by app code).

begin;

create table dispute_records (
  id          uuid primary key,
  order_id    uuid not null references orders(id) on delete restrict,
  opened_by   uuid not null references users(id) on delete restrict,
  status      dispute_status not null,
  -- Denormalized flag driving the "open queue" and "open dispute per order"
  -- lookups. Mirrors (data->'resolution') being null.
  resolved    boolean not null default false,
  -- Full DisputeDTO snapshot (evidence, advisory, resolution, windows).
  data        jsonb not null,
  created_at  timestamptz not null,
  updated_at  timestamptz not null
);

create index dispute_records_order_idx on dispute_records(order_id);
create index dispute_records_opened_by_idx on dispute_records(opened_by, created_at desc);
-- Partial index for the compliance open-queue and the one-open-per-order guard.
create index dispute_records_open_idx
  on dispute_records(order_id, created_at)
  where resolved = false;

-- Deny-by-default RLS (the backend uses a privileged role; matches 0003/0004).
alter table dispute_records enable row level security;

commit;
