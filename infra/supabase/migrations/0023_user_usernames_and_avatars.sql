-- StellarTrust — public usernames and profile avatars.
-- Forward-only Postgres/Supabase migration (Rules.md §2).
--
-- Why this exists
-- ───────────────
-- Every person in the system is currently rendered as a UUID. Opening an escrow
-- order means pasting the counterparty's raw `users.id`, and the admin console's
-- KYC and treasury queues identify an applicant only by a truncated id. Neither
-- surface can name the human it is talking about.
--
-- `users.display_name` already exists (migration 0003) but cannot serve here: it
-- is nullable, unconstrained, non-unique, and no user-facing code path has ever
-- written it — only seeded demo accounts have one. A handle that appears next to
-- money movements has to be unique and well-formed, so it is a new column with
-- the constraints that requirement implies.
--
-- Immutability
-- ────────────
-- `username_set_at` records the single permitted claim. Every account is born
-- with a generated handle and may replace it exactly once; after that the value
-- is fixed. This is deliberate: the username is displayed against historical
-- transactions, and a handle that can change hands would make settled records
-- misleading — @alice on last month's order would silently become someone else.
-- Correcting a handle after the fact is an operator action, not a self-service
-- one.
--
-- Avatars
-- ───────
-- `avatar_url` holds a URL, never image bytes. The file itself lives in the
-- Supabase Storage bucket `avatars`, which must exist and be publicly readable
-- before uploads work — that bucket is infrastructure and is not created here.
-- This is the system's first stored binary; it is admissible only because an
-- avatar is user-chosen and public by intent, unlike the identity documents the
-- schema deliberately keeps out of Postgres.

begin;

alter table users
  add column username        text,
  add column username_set_at timestamptz,
  add column avatar_url      text;

-- Lower-case is canonical. The application stores handles already folded, and
-- this constraint is what makes that an invariant rather than a convention.
alter table users add constraint users_username_format
  check (username is null or username ~ '^[a-z0-9_]{3,20}$');

-- Backfill before the not-null constraint below. Derived from the id so the
-- result is deterministic (re-running produces identical handles) and unique
-- without a collision loop: the uuid's first block is unique across the table,
-- and `user_` keeps the handle inside the format constraint even though a uuid
-- may begin with a digit.
update users
   set username = 'user_' || substring(replace(id::text, '-', '') from 1 for 12)
 where username is null;

-- Deferred until after the backfill: existing rows have no handle until the
-- statement above runs.
alter table users alter column username set not null;

-- Case-insensitive uniqueness — @Soumen and @soumen are the same person, so the
-- second must not be claimable. Also the lookup index for "is this handle free?".
create unique index users_username_lower_idx on users (lower(username));

comment on column users.username is
  'Unique, lower-case, human-readable handle shown against this user''s '
  'transactions in the admin console and to their transaction counterparties. '
  'Generated at account creation; the user may replace it exactly once.';

comment on column users.username_set_at is
  'When the user claimed their own username. Null means the handle is still the '
  'generated one and a claim is available. Non-null makes the username '
  'permanent — see the immutability note at the top of this migration.';

comment on column users.avatar_url is
  'Public URL of the profile picture in the Supabase Storage `avatars` bucket. '
  'Null renders as initials. Never image bytes — only a reference.';

commit;
