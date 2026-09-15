-- StellarTrust — mobile push tokens.
--
-- Identity documents
-- ──────────────────
-- The mobile client captures a real identity document and a liveness selfie and
-- uploads them before submitting a verification. Those bytes live in the
-- Supabase Storage bucket `kyc-documents`, which must exist and must be
-- PRIVATE — that bucket is infrastructure and is not created here, following
-- the same split as `avatars` in migration 0023.
--
-- The distinction from `avatars` is the point. An avatar is public by intent,
-- so its bucket is publicly readable and the schema stores a public URL. A
-- passport photograph is the opposite: the bucket has no public read path, no
-- storage policy grants anon or authenticated any access, and only the service
-- role reaches it. The API mints a short-lived signed URL when a verification
-- provider or a compliance reviewer needs the bytes.
--
-- Nothing about those documents is stored in Postgres — not the bytes, not a
-- URL. The application carries an opaque `storage://` reference on the KYC
-- application itself, which is consistent with the schema's standing decision
-- to keep identity documents out of the database entirely.
--
-- Push tokens
-- ───────────
-- A verification decision, an escrow step, or a completed transfer has to be
-- able to reach a user who does not have the app open. This is the only new
-- table.

begin;

create table device_push_tokens (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  -- Expo push token. Unique so re-registering a device updates its row rather
  -- than accumulating duplicates that would each receive a copy of every
  -- notification.
  token         text not null unique,
  platform      text not null check (platform in ('ios', 'android')),
  -- Set when a send fails permanently — the app was uninstalled, or the user
  -- revoked notification permission. A token kept live after that is a
  -- guaranteed error on every subsequent send.
  revoked_at    timestamptz,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

-- The send path asks "which live tokens does this user have". Partial, because
-- a revoked row is never a send target.
create index device_push_tokens_user_idx
  on device_push_tokens (user_id)
  where revoked_at is null;

comment on table device_push_tokens is
  'Expo push tokens, one row per device. revoked_at is set when a send fails '
  'permanently so dead tokens stop being retried.';

comment on column device_push_tokens.token is
  'Expo push token. Not a secret, but it addresses a specific handset, so it '
  'is never returned by any public endpoint.';

commit;
