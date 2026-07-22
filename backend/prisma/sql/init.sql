-- StellarTrust — Supabase/Postgres DDL generated from prisma/schema.prisma.
-- Applied via the pg driver because Device Guard blocks Prisma's native schema
-- engine on this Windows host. Idempotent: safe to re-run.
--
-- Enum type names and table/column names match what Prisma expects, so a future
-- `prisma db pull` from WSL/CI reconciles cleanly.

-- ── Enums ────────────────────────────────────────────────────────────────────
DO $$ BEGIN CREATE TYPE "CustodyType" AS ENUM ('self','contract'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "KycStatus" AS ENUM ('pending','under_review','verified','rejected'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "ReviewStatus" AS ENUM ('queued','resolved'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "HumanKycDecision" AS ENUM ('approve','reject'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "CurrencyCode" AS ENUM ('USD','EUR','INR','NGN','XLM','USDC'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "LedgerAccountType" AS ENUM ('asset','liability','equity','revenue','expense'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "EntryDirection" AS ENUM ('debit','credit'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "ChainTxStatus" AS ENUM ('pending','submitted','success','failed'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "OrderStatus" AS ENUM ('created','accepted','deposited','locked','confirmed','released','refunded','disputed','cancelled'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "EscrowState" AS ENUM ('locked','released','refunded','disputed'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "PaymentTransitionType" AS ENUM ('create','accept','deposit','lock','confirm','release','refund'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "DisputeStatus" AS ENUM ('open','evidence_window','under_review','resolved'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "DisputeResolution" AS ENUM ('release','refund'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "DisputeDecisionMaker" AS ENUM ('auto_policy','human'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "EvidenceKind" AS ENUM ('invoice','tracking','otp','courier','image'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "SettlementStatus" AS ENUM ('quoted','deposit_pending','converting','payout_pending','completed','failed'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "SettlementTransitionType" AS ENUM ('deposit','convert','payout'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "AnchorProtocol" AS ENUM ('sep6','sep24','sep31'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "AnchorTransferStatus" AS ENUM ('pending','completed','failed'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "AnchorTransferKind" AS ENUM ('deposit','withdrawal'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "AssetType" AS ENUM ('invoice','commodity','real_estate','other'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "TokenizationStatus" AS ENUM ('draft','active','funded','distributing','distributed','frozen','cancelled'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "PayoutStatus" AS ENUM ('pending','processing','completed','failed'); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── Identity & Auth ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               text NOT NULL UNIQUE,
  display_name        text,
  kyc_status          "KycStatus" NOT NULL DEFAULT 'pending',
  latest_verification jsonb,
  verified_at         timestamptz(6),
  created_at          timestamptz(6) NOT NULL DEFAULT now(),
  updated_at          timestamptz(6) NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS businesses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  legal_name    text NOT NULL,
  country       text NOT NULL,
  created_at    timestamptz(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS businesses_owner_user_id_idx ON businesses(owner_user_id);

CREATE TABLE IF NOT EXISTS wallets (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stellar_public_key text NOT NULL UNIQUE,
  custody_type       "CustodyType" NOT NULL DEFAULT 'self',
  created_at         timestamptz(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wallets_user_id_idx ON wallets(user_id);

CREATE TABLE IF NOT EXISTS sep10_challenges (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stellar_public_key text NOT NULL,
  transaction_hash   text NOT NULL,
  network_passphrase text NOT NULL,
  expires_at         timestamptz(6) NOT NULL,
  consumed_at        timestamptz(6),
  created_at         timestamptz(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sep10_challenges_stellar_public_key_idx ON sep10_challenges(stellar_public_key);
CREATE INDEX IF NOT EXISTS sep10_challenges_expires_at_idx ON sep10_challenges(expires_at);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_id  uuid NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  roles      text[] NOT NULL DEFAULT '{}',
  expires_at timestamptz(6) NOT NULL,
  revoked_at timestamptz(6),
  created_at timestamptz(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_sessions_user_id_idx ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS auth_sessions_expires_at_idx ON auth_sessions(expires_at);

-- ── KYC / KYB ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kyc_verifications (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_reference text NOT NULL,
  status             "KycStatus" NOT NULL,
  checks             jsonb NOT NULL,
  advisory           jsonb NOT NULL,
  submitted_at       timestamptz(6) NOT NULL,
  auto_approve_at    timestamptz(6),
  created_at         timestamptz(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kyc_verifications_user_id_idx ON kyc_verifications(user_id);
CREATE INDEX IF NOT EXISTS kyc_verifications_status_idx ON kyc_verifications(status);

CREATE TABLE IF NOT EXISTS kyc_reviews (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  verification_id   uuid NOT NULL REFERENCES kyc_verifications(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status            "ReviewStatus" NOT NULL DEFAULT 'queued',
  advisory          jsonb NOT NULL,
  provider_checks   jsonb NOT NULL,
  resolved_by       text,
  resolution        "HumanKycDecision",
  resolution_reason text,
  created_at        timestamptz(6) NOT NULL DEFAULT now(),
  resolved_at       timestamptz(6)
);
CREATE INDEX IF NOT EXISTS kyc_reviews_verification_id_idx ON kyc_reviews(verification_id);
CREATE INDEX IF NOT EXISTS kyc_reviews_user_id_idx ON kyc_reviews(user_id);
CREATE INDEX IF NOT EXISTS kyc_reviews_status_idx ON kyc_reviews(status);

-- ── Ledger (double-entry) ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ledger_accounts (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type      "LedgerAccountType" NOT NULL,
  currency  "CurrencyCode" NOT NULL,
  owner_ref text,
  name      text NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_accounts_type_idx ON ledger_accounts(type);

CREATE TABLE IF NOT EXISTS ledger_transactions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_id text NOT NULL UNIQUE,
  description  text NOT NULL,
  created_at   timestamptz(6) NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid NOT NULL REFERENCES ledger_transactions(id) ON DELETE CASCADE,
  account_id     uuid NOT NULL REFERENCES ledger_accounts(id),
  direction      "EntryDirection" NOT NULL,
  amount         bigint NOT NULL,
  currency       "CurrencyCode" NOT NULL,
  created_at     timestamptz(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_entries_transaction_id_idx ON ledger_entries(transaction_id);
CREATE INDEX IF NOT EXISTS ledger_entries_account_id_idx ON ledger_entries(account_id);

-- ── Stellar / chain records ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stellar_transactions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hash                  text,
  type                  text NOT NULL,
  status                "ChainTxStatus" NOT NULL DEFAULT 'pending',
  ledger_transaction_id uuid REFERENCES ledger_transactions(id),
  created_at            timestamptz(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stellar_transactions_ledger_transaction_id_idx ON stellar_transactions(ledger_transaction_id);
CREATE INDEX IF NOT EXISTS stellar_transactions_hash_idx ON stellar_transactions(hash);

-- ── Payments / Escrow ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id   uuid NOT NULL REFERENCES users(id),
  seller_id  uuid NOT NULL REFERENCES users(id),
  amount     bigint NOT NULL,
  currency   "CurrencyCode" NOT NULL,
  status     "OrderStatus" NOT NULL DEFAULT 'created',
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  updated_at timestamptz(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_buyer_id_idx ON orders(buyer_id);
CREATE INDEX IF NOT EXISTS orders_seller_id_idx ON orders(seller_id);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status);

CREATE TABLE IF NOT EXISTS escrows (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  contract_id text,
  state       "EscrowState" NOT NULL DEFAULT 'locked',
  created_at  timestamptz(6) NOT NULL DEFAULT now(),
  updated_at  timestamptz(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS escrows_contract_id_idx ON escrows(contract_id);

CREATE TABLE IF NOT EXISTS payment_transitions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id              uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  transition            "PaymentTransitionType" NOT NULL,
  actor_id              uuid NOT NULL REFERENCES users(id),
  ledger_transaction_id uuid NOT NULL UNIQUE REFERENCES ledger_transactions(id),
  stellar_transaction_id uuid NOT NULL UNIQUE REFERENCES stellar_transactions(id),
  created_at            timestamptz(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payment_transitions_order_id_idx ON payment_transitions(order_id);
CREATE INDEX IF NOT EXISTS payment_transitions_actor_id_idx ON payment_transitions(actor_id);

CREATE TABLE IF NOT EXISTS reconciliation_mismatches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  transition_id uuid NOT NULL REFERENCES payment_transitions(id) ON DELETE CASCADE,
  reason        text NOT NULL,
  resolved_at   timestamptz(6),
  created_at    timestamptz(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reconciliation_mismatches_order_id_idx ON reconciliation_mismatches(order_id);
CREATE INDEX IF NOT EXISTS reconciliation_mismatches_transition_id_idx ON reconciliation_mismatches(transition_id);
CREATE INDEX IF NOT EXISTS reconciliation_mismatches_resolved_at_idx ON reconciliation_mismatches(resolved_at);

-- ── Disputes ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS disputes (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                  uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  escrow_id                 uuid REFERENCES escrows(id),
  status                    "DisputeStatus" NOT NULL DEFAULT 'evidence_window',
  amount                    bigint NOT NULL,
  currency                  "CurrencyCode" NOT NULL,
  opened_by                 uuid NOT NULL REFERENCES users(id),
  reason                    text NOT NULL,
  advisory                  jsonb,
  auto_resolvable           boolean NOT NULL DEFAULT false,
  resolution_outcome        "DisputeResolution",
  resolution_decided_by     "DisputeDecisionMaker",
  resolution_actor          text,
  resolution_reason         text,
  resolution_decided_at     timestamptz(6),
  evidence_window_closes_at timestamptz(6) NOT NULL,
  created_at                timestamptz(6) NOT NULL DEFAULT now(),
  updated_at                timestamptz(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS disputes_order_id_idx ON disputes(order_id);
CREATE INDEX IF NOT EXISTS disputes_opened_by_idx ON disputes(opened_by);
CREATE INDEX IF NOT EXISTS disputes_status_idx ON disputes(status);

CREATE TABLE IF NOT EXISTS dispute_evidence (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id   uuid NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  kind         "EvidenceKind" NOT NULL,
  supports     "DisputeResolution" NOT NULL,
  weight       double precision NOT NULL,
  reference    text NOT NULL,
  description  text,
  submitted_by uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dispute_evidence_dispute_id_idx ON dispute_evidence(dispute_id);
CREATE INDEX IF NOT EXISTS dispute_evidence_submitted_by_idx ON dispute_evidence(submitted_by);

-- ── Cross-border settlement ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settlement_quotes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  corridor_id       text NOT NULL,
  source_amount     bigint NOT NULL,
  source_currency   "CurrencyCode" NOT NULL,
  route             jsonb NOT NULL,
  considered_routes jsonb NOT NULL,
  max_slippage_bps  integer NOT NULL,
  max_fee_amount    bigint,
  expires_at        timestamptz(6) NOT NULL,
  created_at        timestamptz(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS settlement_quotes_corridor_id_idx ON settlement_quotes(corridor_id);
CREATE INDEX IF NOT EXISTS settlement_quotes_expires_at_idx ON settlement_quotes(expires_at);

CREATE TABLE IF NOT EXISTS settlements (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES users(id),
  quote_id             uuid NOT NULL UNIQUE REFERENCES settlement_quotes(id),
  corridor_id          text NOT NULL,
  status               "SettlementStatus" NOT NULL DEFAULT 'quoted',
  source_amount        bigint NOT NULL,
  source_currency      "CurrencyCode" NOT NULL,
  destination_amount   bigint NOT NULL,
  destination_currency "CurrencyCode" NOT NULL,
  route                jsonb NOT NULL,
  destination_reference text NOT NULL,
  created_at           timestamptz(6) NOT NULL DEFAULT now(),
  updated_at           timestamptz(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS settlements_user_id_idx ON settlements(user_id);
CREATE INDEX IF NOT EXISTS settlements_corridor_id_idx ON settlements(corridor_id);
CREATE INDEX IF NOT EXISTS settlements_status_idx ON settlements(status);

CREATE TABLE IF NOT EXISTS anchor_transfers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        "AnchorTransferKind" NOT NULL,
  protocol    "AnchorProtocol" NOT NULL,
  status      "AnchorTransferStatus" NOT NULL DEFAULT 'pending',
  amount      bigint NOT NULL,
  currency    "CurrencyCode" NOT NULL,
  reference   text NOT NULL,
  customer_id text NOT NULL,
  created_at  timestamptz(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS anchor_transfers_status_idx ON anchor_transfers(status);

CREATE TABLE IF NOT EXISTS settlement_transitions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_id         uuid NOT NULL REFERENCES settlements(id) ON DELETE CASCADE,
  transition            "SettlementTransitionType" NOT NULL,
  ledger_transaction_id uuid NOT NULL UNIQUE REFERENCES ledger_transactions(id),
  anchor_transfer_id    uuid UNIQUE REFERENCES anchor_transfers(id),
  stellar_transaction_id uuid UNIQUE REFERENCES stellar_transactions(id),
  created_at            timestamptz(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS settlement_transitions_settlement_id_idx ON settlement_transitions(settlement_id);

CREATE TABLE IF NOT EXISTS settlement_reconciliation_mismatches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_id uuid NOT NULL REFERENCES settlements(id) ON DELETE CASCADE,
  transition_id uuid NOT NULL REFERENCES settlement_transitions(id) ON DELETE CASCADE,
  reason        text NOT NULL,
  resolved_at   timestamptz(6),
  created_at    timestamptz(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS settlement_recon_mismatches_settlement_id_idx ON settlement_reconciliation_mismatches(settlement_id);
CREATE INDEX IF NOT EXISTS settlement_recon_mismatches_transition_id_idx ON settlement_reconciliation_mismatches(transition_id);
CREATE INDEX IF NOT EXISTS settlement_recon_mismatches_resolved_at_idx ON settlement_reconciliation_mismatches(resolved_at);

-- ── RWA tokenization ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS assets (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asset_type         "AssetType" NOT NULL,
  asset_ref          text NOT NULL,
  description        text NOT NULL,
  valuation_amount   bigint NOT NULL,
  valuation_currency "CurrencyCode" NOT NULL,
  metadata           jsonb,
  created_at         timestamptz(6) NOT NULL DEFAULT now(),
  updated_at         timestamptz(6) NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, asset_ref)
);
CREATE INDEX IF NOT EXISTS assets_owner_user_id_idx ON assets(owner_user_id);

CREATE TABLE IF NOT EXISTS tokenizations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id               uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  issuer_user_id         uuid NOT NULL REFERENCES users(id),
  contract_id            text,
  contract_deployed_at   timestamptz(6),
  total_units            bigint NOT NULL,
  units_sold             bigint NOT NULL DEFAULT 0,
  price_per_unit_amount  bigint NOT NULL,
  price_per_unit_currency "CurrencyCode" NOT NULL,
  require_authorization  boolean NOT NULL DEFAULT false,
  frozen                 boolean NOT NULL DEFAULT false,
  linked_order_id        uuid REFERENCES orders(id),
  status                 "TokenizationStatus" NOT NULL DEFAULT 'draft',
  created_at             timestamptz(6) NOT NULL DEFAULT now(),
  updated_at             timestamptz(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tokenizations_asset_id_idx ON tokenizations(asset_id);
CREATE INDEX IF NOT EXISTS tokenizations_issuer_user_id_idx ON tokenizations(issuer_user_id);
CREATE INDEX IF NOT EXISTS tokenizations_linked_order_id_idx ON tokenizations(linked_order_id);
CREATE INDEX IF NOT EXISTS tokenizations_status_idx ON tokenizations(status);

CREATE TABLE IF NOT EXISTS token_holdings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tokenization_id   uuid NOT NULL REFERENCES tokenizations(id) ON DELETE CASCADE,
  holder_user_id    uuid NOT NULL REFERENCES users(id),
  holder_address    text NOT NULL,
  units             bigint NOT NULL,
  purchase_amount   bigint NOT NULL,
  purchase_currency "CurrencyCode" NOT NULL,
  purchased_at      timestamptz(6) NOT NULL,
  authorized        boolean NOT NULL DEFAULT true,
  updated_at        timestamptz(6) NOT NULL DEFAULT now(),
  UNIQUE (tokenization_id, holder_user_id)
);
CREATE INDEX IF NOT EXISTS token_holdings_tokenization_id_idx ON token_holdings(tokenization_id);
CREATE INDEX IF NOT EXISTS token_holdings_holder_user_id_idx ON token_holdings(holder_user_id);

CREATE TABLE IF NOT EXISTS payout_distributions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tokenization_id       uuid NOT NULL REFERENCES tokenizations(id) ON DELETE CASCADE,
  triggered_by_order_id uuid REFERENCES orders(id),
  triggered_by_transition text,
  total_amount          bigint NOT NULL,
  total_currency        "CurrencyCode" NOT NULL,
  status                "PayoutStatus" NOT NULL DEFAULT 'pending',
  ledger_transaction_id uuid UNIQUE REFERENCES ledger_transactions(id),
  initiated_at          timestamptz(6) NOT NULL DEFAULT now(),
  completed_at          timestamptz(6)
);
CREATE INDEX IF NOT EXISTS payout_distributions_tokenization_id_idx ON payout_distributions(tokenization_id);
CREATE INDEX IF NOT EXISTS payout_distributions_triggered_by_order_id_idx ON payout_distributions(triggered_by_order_id);
CREATE INDEX IF NOT EXISTS payout_distributions_status_idx ON payout_distributions(status);

CREATE TABLE IF NOT EXISTS payout_records (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  distribution_id uuid NOT NULL REFERENCES payout_distributions(id) ON DELETE CASCADE,
  holder_user_id  uuid NOT NULL REFERENCES users(id),
  units_held      bigint NOT NULL,
  share_amount    bigint NOT NULL,
  share_currency  "CurrencyCode" NOT NULL,
  ledger_entry_id uuid UNIQUE REFERENCES ledger_entries(id),
  created_at      timestamptz(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payout_records_distribution_id_idx ON payout_records(distribution_id);
CREATE INDEX IF NOT EXISTS payout_records_holder_user_id_idx ON payout_records(holder_user_id);

-- ── Reputation ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reputations (
  user_id          uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  orders_completed integer NOT NULL DEFAULT 0,
  disputes_won     integer NOT NULL DEFAULT 0,
  disputes_lost    integer NOT NULL DEFAULT 0,
  updated_at       timestamptz(6) NOT NULL DEFAULT now()
);

-- ── Audit (append-only) ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor      text NOT NULL,
  action     text NOT NULL,
  entity     text NOT NULL,
  entity_id  text,
  metadata   jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_events_entity_entity_id_idx ON audit_events(entity, entity_id);
CREATE INDEX IF NOT EXISTS audit_events_created_at_idx ON audit_events(created_at);
