-- StellarTrust — RWA issuer self-custody
-- Forward-only Postgres/Supabase migration (Rules.md §2).
--
-- Rationale:
--   Until now the platform's signer was always the on-chain issuer: it held
--   every unit and signed every contract operation. That is a custodial model,
--   and it was implicit rather than chosen — the issuer recorded in our tables
--   owned nothing on-chain.
--
--   `RWA_CUSTODY=issuer` makes the issuer's own SEP-10 wallet the on-chain
--   issuer, so they hold their units and sign their own operations. The
--   consequence this column exists for: the platform can no longer deliver
--   purchased units itself. A purchase is recorded and paid for before the
--   issuer signs the transfer, so for a window the holding is a claim rather
--   than a balance.
--
--   Conflating the two would corrupt both payouts (an undelivered holder would
--   take a pro-rata share funded by holders who actually hold units) and
--   reconciliation (an undelivered holding has no on-chain balance to match,
--   and would be reported as drift on every pass).
--
--   Existing rows default to 'settled': every holding written before this
--   migration was delivered inline by the platform signer.

begin;

create type token_holding_status as enum ('pending', 'settled');

alter table token_holdings
  add column if not exists status token_holding_status not null default 'settled';

comment on column token_holdings.status is
  'pending = purchased and reserved, but the issuer has not yet signed the on-chain transfer (issuer custody only); settled = the contract has moved the units.';

-- The reconciliation job and the payout calculation both filter on this, and
-- the outstanding-delivery queue is a hot path for an issuer with a live sale.
create index if not exists token_holdings_pending_idx
  on token_holdings(tokenization_id)
  where status = 'pending';

commit;
