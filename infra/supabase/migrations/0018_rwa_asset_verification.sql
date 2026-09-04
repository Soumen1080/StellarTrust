-- StellarTrust — RWA asset verification + investor protection
-- (plane.md §3.1 and §3.2)
-- Forward-only Postgres/Supabase migration (Rules.md §2).
--
-- Why this exists
-- ───────────────
-- Until now an asset's `valuation_amount` was whatever the issuer typed. There
-- was no document behind it, no review, and no check that the same receivable
-- was not already financed somewhere else. That is finding D7 in plane.md: the
-- fraud surface a financing platform exists to close, and the reason the RWA
-- section read as a marketplace of assertions rather than a product.
--
-- Three things are added.
--
--   verification_status  the workflow. Unverified → UnderReview → Verified |
--                        Rejected, and only a Verified asset may be tokenized.
--                        The gate is in the service; this column is what it
--                        reads, and what survives a restart.
--   documents            supporting evidence, as opaque references only — a
--                        storage key, a type, and a digest. Never the file and
--                        never its contents (Rules.md §3).
--   counterparty         the debtor who actually owes the money. The credit
--                        risk an investor carries is theirs, not the issuer's,
--                        so it is recorded rather than left implicit.
--
-- Backfill: every existing asset becomes `unverified` — the column default —
-- rather than being grandfathered in as verified. Nothing has ever been
-- reviewed, so marking those rows verified would be a lie told by a migration,
-- and the whole point of the workflow is that a valuation is an assertion
-- until someone has looked at the evidence.
--
-- The consequence is deliberate and worth stating: an asset that is ALREADY
-- tokenized now reads `unverified`. Its tokenization is untouched and keeps
-- running — the gate is at `createTokenization`, not at purchase or payout, so
-- no live position is stranded and no investor's holding is affected. The
-- issuer of such an asset submits it for review like any other before they can
-- tokenize it again.

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification workflow
-- ─────────────────────────────────────────────────────────────────────────────

do $$
begin
  if not exists (select 1 from pg_type where typname = 'asset_verification_status') then
    create type asset_verification_status as enum (
      'unverified',    -- Created; evidence not yet submitted for review
      'under_review',  -- Submitted with documents; awaiting a decision
      'verified',      -- Evidence accepted. The only tokenizable state
      'rejected'       -- Evidence refused. The issuer files a fresh asset
    );
  end if;
end$$;

alter table assets
  add column if not exists verification_status asset_verification_status
    not null default 'unverified',
  -- Opaque references only: {docRef, docType, sha256, uploadedAt}. The digest
  -- is what makes a swapped document detectable after approval.
  add column if not exists documents jsonb not null default '[]'::jsonb,
  -- {ref, name, reputationScore}. `ref` is an opaque business identifier, never
  -- PII — the platform needs to recognise that two invoices name the same
  -- debtor without storing who they are.
  add column if not exists counterparty jsonb,
  add column if not exists verified_by_user_id uuid references users(id),
  add column if not exists verified_at timestamptz,
  add column if not exists verification_note text;

-- `documents` must be an array; a bare object here would map to an AssetDTO
-- whose `documents` is not iterable, and the failure would surface at read
-- time in whichever endpoint happened to touch that row first.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'assets_documents_is_array'
  ) then
    alter table assets
      add constraint assets_documents_is_array
      check (jsonb_typeof(documents) = 'array');
  end if;
end$$;

-- A decision must say who made it and when. Enforced at the database because
-- an approval with no reviewer attached is not an audit trail, and the service
-- is not the only thing that can write this table.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'assets_decision_has_reviewer'
  ) then
    alter table assets
      add constraint assets_decision_has_reviewer
      check (
        verification_status not in ('verified', 'rejected')
        or (verified_by_user_id is not null and verified_at is not null)
      );
  end if;
end$$;

-- The review queue reads exactly one status, oldest first.
create index if not exists assets_verification_status_idx
  on assets(verification_status, updated_at)
  where verification_status = 'under_review';

-- The double-pledge lookup joins tokenizations to assets by `asset_ref` across
-- owners. Without this it is a sequential scan on every tokenization attempt.
create index if not exists assets_asset_ref_idx on assets(asset_ref);

-- ─────────────────────────────────────────────────────────────────────────────
-- Cooling-off cancellation: the un-funding half of auto_fund_tokenization
-- ─────────────────────────────────────────────────────────────────────────────
--
-- 0006 added a trigger that moves `active` → `funded` when units_sold reaches
-- total_units. It only ever ran in that direction, because until §3.2 nothing
-- could give units back. A cooling-off cancellation can, and a tokenization
-- left `funded` while units sit unsold is one that can never be bought into
-- again — `purchaseUnits` refuses anything that is not `active`.
--
-- The 0006 body is preserved exactly and the reverse case added, so the
-- funding direction keeps behaving as every existing test asserts.

create or replace function auto_fund_tokenization()
returns trigger
language plpgsql
as $$
begin
  if new.units_sold >= new.total_units and new.status = 'active' then
    new.status := 'funded';
  elsif new.units_sold < new.total_units and new.status = 'funded' then
    -- Units were returned (a cancelled subscription). The position is open for
    -- investment again.
    new.status := 'active';
  end if;
  return new;
end;
$$;
