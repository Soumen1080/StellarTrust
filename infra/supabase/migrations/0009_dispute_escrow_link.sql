-- StellarTrust — link disputes to the custody they are about
-- Forward-only Postgres/Supabase migration (Rules.md §2).
--
-- Rationale:
--   `dispute_records` (0007) recorded which ORDER was disputed but nothing
--   about where the money sat. That left two disconnected systems: a dispute
--   row in Postgres, and an escrow contract on Soroban that had never been
--   told a claim existed. The gap has teeth — the escrow contract's `release`
--   accepts only `Disputed` or a buyer confirmation, so a dispute that never
--   moved custody to `Disputed` resolves into a settlement the chain refuses.
--
--   These columns record, at open time, which custody instance the claim is
--   against. They are denormalized out of the DTO snapshot in `data` for the
--   same reason `order_id` already is: so an operator can ask "what is disputed
--   about contract C…?" without scanning JSONB, and so the escrow reference is
--   a real foreign key rather than a string nobody validates.
--
--   Both are nullable: a dispute can be opened against an order whose funds
--   were never locked, and that is a legitimate state, not a missing value.

begin;

alter table dispute_records
  add column if not exists escrow_id uuid references escrows(id) on delete restrict;

-- The Soroban contract id (`C…`), copied from the escrow at open time. Kept
-- even if the escrow row is later amended, so the audit trail says which
-- contract the claim was made against.
alter table dispute_records
  add column if not exists contract_id text;

comment on column dispute_records.escrow_id is
  'Custody instance this dispute is about, captured when the dispute was opened. Null when the order had no escrow yet.';

comment on column dispute_records.contract_id is
  'Soroban contract id of that custody instance at open time.';

create index if not exists dispute_records_contract_idx
  on dispute_records(contract_id)
  where contract_id is not null;

commit;
