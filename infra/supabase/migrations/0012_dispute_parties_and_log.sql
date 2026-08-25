-- StellarTrust — Phase 4 addendum: dispute parties (both sides of the claim)
-- Forward-only Postgres/Supabase migration (Rules.md §2).
--
-- Rationale:
--   `dispute_records` (0007) recorded only `opened_by`, and the repository
--   listed a user's disputes by that column. So a dispute was visible ONLY to
--   the person who filed it: the counterparty it was filed against could not
--   see the claim, and therefore could not submit evidence inside the window
--   the service was busy enforcing against them. A dispute is between two
--   parties, so both belong on the record.
--
--   Denormalizing buyer/seller out of the order (rather than joining) keeps
--   the "my disputes" query a single indexed lookup, and freezes WHO the
--   parties were when the claim was made — the same reason `contract_id` is
--   captured at open time in 0009.
--
-- The dispute log itself needs no table: `audit_log` (0001) is already the
-- append-only record of every dispute action, and the log endpoint projects
-- it. A second history would be a second thing to disagree with.

begin;

alter table dispute_records
  add column buyer_id  uuid references users(id) on delete restrict,
  add column seller_id uuid references users(id) on delete restrict;

-- Backfill from the order each dispute was filed against.
update dispute_records d
   set buyer_id  = o.buyer_id,
       seller_id = o.seller_id
  from orders o
 where o.id = d.order_id
   and (d.buyer_id is null or d.seller_id is null);

-- Any row that survives the backfill has no order to derive parties from,
-- which should be impossible: order_id is NOT NULL with an FK to orders.
alter table dispute_records
  alter column buyer_id  set not null,
  alter column seller_id set not null;

-- Also mirror the parties into the JSONB snapshot, which is the DTO the API
-- returns. Without this, rows written before this migration would come back
-- missing `buyerId`/`sellerId` and the party check would read as undefined.
update dispute_records
   set data = data
         || jsonb_build_object('buyerId', buyer_id::text)
         || jsonb_build_object('sellerId', seller_id::text)
 where not (data ? 'buyerId') or not (data ? 'sellerId');

-- "Every dispute I am party to", the query behind the disputes list.
create index dispute_records_buyer_idx  on dispute_records(buyer_id, created_at desc);
create index dispute_records_seller_idx on dispute_records(seller_id, created_at desc);

-- The escrow view asks "is there a claim on this order?" per order card.
create index dispute_records_order_created_idx
  on dispute_records(order_id, created_at desc);

commit;
