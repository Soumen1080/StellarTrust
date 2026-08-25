-- StellarTrust — Phase 6: product feedback wall
-- Forward-only Postgres/Supabase migration (Rules.md §2).
--
-- Rationale:
--   Submission-and-publish are two different privacy domains for the same row.
--   A submitter hands over a name, an email, a wallet address, a message and a
--   1..5 rating; the wall shows the name, the message and the rating to anyone.
--   Keeping both in one table means the projection is the only thing standing
--   between contact PII and a public endpoint, so the split is made explicit
--   here (column comments) and again in the type system: `FeedbackDTO` has no
--   field an email or wallet could be assigned to.
--
-- Privacy (Rules.md §7):
--   `email` and `wallet_address` are contact PII. No route selects them; the
--   repository's public reader lists columns explicitly rather than `select *`
--   so a future column cannot silently join the public payload.

begin;

create table product_feedback (
  id              uuid primary key,
  -- Nullable: feedback may outlive the account that left it, and deleting a
  -- user must not silently rewrite the public wall. `set null` keeps the
  -- message and rating (which are not PII) while dropping the link.
  user_id         uuid references users(id) on delete set null,

  -- ── Published ────────────────────────────────────────────────────────────
  display_name    text not null check (length(btrim(display_name)) between 2 and 80),
  message         text not null check (length(btrim(message)) between 10 and 1000),
  rating          smallint not null check (rating between 1 and 5),

  -- ── Never published ──────────────────────────────────────────────────────
  email           text not null check (position('@' in email) > 1),
  wallet_address  text not null check (wallet_address ~ '^G[A-Z2-7]{55}$'),

  created_at      timestamptz not null default now()
);

comment on column product_feedback.email is
  'Contact PII. Never returned by any API route — see FeedbackDTO, which has no email field.';
comment on column product_feedback.wallet_address is
  'Contact PII. Ties the entry to a real testnet participant; never published.';
comment on column product_feedback.display_name is
  'Published on the public wall alongside message and rating.';

-- The wall reads newest-first and nothing else; one index covers it.
create index product_feedback_created_idx on product_feedback (created_at desc);

-- One published opinion per account. Partial, so entries whose user was deleted
-- (user_id -> null) do not collide with each other.
create unique index product_feedback_one_per_user_idx
  on product_feedback (user_id)
  where user_id is not null;

commit;
