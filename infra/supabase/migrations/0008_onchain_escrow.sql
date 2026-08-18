-- StellarTrust — on-chain escrow wiring
-- Forward-only Postgres/Supabase migration (Rules.md §2).
--
-- Rationale:
--   Locking an escrow on Soroban is a two-step round trip, not one server call.
--   The escrow contract gates `initialize` with `buyer.require_auth()`, so the
--   server deploys the custody instance and then hands the buyer an unsigned
--   transaction to sign in their wallet. Between those steps a real contract
--   exists on-chain holding no funds — a state the four-value `escrow_state`
--   enum could not express, which previously forced the contract id to be
--   discarded and re-deployed on every retry (leaking a contract per attempt).
--
--   `dispute` joins `payment_transition` for the same reason: the contract's
--   `release` accepts only `Disputed` or `delivery_confirmed`, so moving a
--   locked escrow to `Disputed` is a real, recorded, on-chain step — the only
--   route by which an arbiter can settle a deal the buyer never confirmed.
--
-- Note: `alter type ... add value` is committed separately from its first use
-- (Postgres refuses to use a new enum label in the transaction that added it),
-- so these statements intentionally run outside an explicit transaction block.

alter type escrow_state add value if not exists 'pending' before 'locked';

alter type payment_transition add value if not exists 'dispute';

-- Escrow custody instances are now deployed before they are funded, so the
-- default no longer describes a newly inserted row.
alter table escrows alter column state set default 'pending';

comment on column escrows.state is
  'pending = custody contract deployed, funds not yet locked; locked/released/refunded/disputed mirror the on-chain State enum.';

comment on column escrows.contract_id is
  'Soroban contract id of the per-order custody instance. Set at deploy time, before the buyer signs the lock, so a retry reuses the instance instead of leaking a new one.';
