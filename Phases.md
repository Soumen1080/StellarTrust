# StellarTrust — Delivery Phases

> **Status:** Living document. Update as phases progress or scope changes.
> **Last updated:** 2026-07-20
> **Track:** Production.

Each phase lists **deliverables** and **acceptance criteria** (done = criteria
met + build/tests pass + Memory.md updated).

---

## Phase 0 — Foundations (before any feature)

**Goal:** A safe skeleton that enforces the golden rules from day one.

**Deliverables**
- Repo scaffold with **separate top-level folders per portion**
  (`frontend`, `backend`, `ai`, `contracts`, `shared`, `infra`) — `frontend` and
  `backend` each have their own `package.json`/build/deploy.
- CI pipeline (lint, typecheck, test, build).
- Supabase project + initial schema **including the double-entry ledger**.
- Stellar testnet setup + SDK wrappers; Soroban toolchain.
- KMS/HSM signing boundary (stub allowed locally, real in staging/prod).
- Shared error taxonomy, logging, config, idempotency middleware.

**Acceptance criteria**
- Ledger can record a balanced entry pair; unbalanced writes are rejected.
- CI green on an empty end-to-end request.
- No secret keys anywhere in repo/env; signing goes through the boundary.

---

## Phase 1 — Identity & Wallet

**Goal:** Verified users with connected Stellar wallets.

**Deliverables**
- SEP-10 wallet authentication.
- Wallet connect via Stellar Wallets Kit (Freighter/xBull).
- KYC provider integration (sandbox): ID + OCR + face + liveness + AML.
- AI KYC **risk aggregation** endpoint (advisory) + decision engine
  (Approve/Review/Reject) with human review queue.
- Verified user + business profile creation.

**Acceptance criteria**
- A user can register, pass sandbox KYC, and connect a wallet.
- Borderline KYC routes to human review; decisions are audit-logged.
- No PII leaks in logs.

---

## Phase 2 — Core Payment + Escrow (heart of MVP)

**Status:** Application implementation complete; production adapters and live
Stellar testnet deployment remain manual/operational prerequisites.

**Goal:** Buyer→seller escrow happy path, fully ledgered.

**Deliverables**
- [x] Soroban **escrow contract** implements lock/release/refund, buyer-authenticated
  delivery confirmation, arbiter authorization, and unit tests.
- [ ] Deploy the contract and run the smoke flow on public Stellar testnet
  (requires a manually funded testnet identity and Stellar CLI; use
  `contracts/scripts/deploy-testnet.ps1`).
- [x] Order lifecycle: create → accept → deposit → lock → confirm → release,
  with party/role authorization and an arbiter-only refund path.
- [x] Double-entry ledger wired into every lifecycle step through one atomic
  financial-transition commit boundary.
- [x] Authenticated, idempotent payment/escrow endpoints.
- [x] Scheduled reconciliation job (ledger ↔ chain), unresolved-mismatch report,
  alert logging, and fail-closed order blocking.
- [x] Buyer/seller escrow dashboard at `/escrow`.
- [x] Forward-only Phase 2 Postgres schema contract in migration `0004`.
- [ ] Replace local in-memory/deterministic adapters with validated Postgres,
  Redis, KMS/HSM, and Soroban RPC adapters for staging/production.

**Acceptance criteria**
- [x] Contract code requires buyer confirmation before happy-path release and
  requires arbiter authorization for release/refund; automated unit coverage is
  present.
- [ ] Verify real funds lock and release against the deployed public testnet
  contract (manual credentials/funding required).
- [x] Every local/application transition produces balanced ledger entries and a
  linked chain transaction record.
- [x] Automated happy-path reconciliation reports zero unresolved mismatches
  (six lifecycle records checked).
- [ ] Verify the same zero-mismatch result against testnet + production-style
  Postgres/Redis adapters.

---

## Phase 3 — Cross-Border Settlement

**Status:** Application implementation complete (sandbox anchor + deterministic
liquidity behind interfaces). Live anchor per corridor, Horizon path-finding/AMM
adapter, and production persistence remain manual/operational prerequisites.

**Goal:** Multi-currency settlement with a real fiat ramp.

**Deliverables**
- [x] Path payments for cross-currency conversion (classic Stellar liquidity
  behind `LiquidityGateway`; deterministic local adapter, Horizon adapter
  pending for staging/prod).
- [x] AMM liquidity pool integration (modeled as a second routed mechanism
  alongside path payments with its own fee/slippage economics).
- [x] **Anchor integration** (SEP-31/24/6) — controlled/sandbox anchor per
  corridor behind `AnchorGateway`; SEP-12 KYC exchange retains only an opaque
  customer id (no raw PII).
- [x] Routing service: best rate + lowest fee + fastest path, with slippage/fee
  constraints (fail closed when no route satisfies the limits).
- [ ] Replace the sandbox anchor and deterministic liquidity adapters with a
  live per-corridor anchor client and a Horizon path-finding + AMM adapter for
  staging/production.
- [ ] Forward-only Postgres schema for settlement quotes/transitions and
  settlement reconciliation persistence.

**Acceptance criteria**
- [x] USD→X and X→USD test corridor settles end-to-end via anchor + path
  payment (deposit → convert → payout), each leg producing a balanced ledger
  transaction linked to its anchor/chain record (settlement tests green).
- [x] Routing picks the best available path and respects fee/slippage limits
  (unit-tested: path payment chosen over AMM on net output; rejects when
  slippage/fee limits exclude every route).
- [x] Deposits/withdrawals reconcile against the ledger (settlement
  reconciliation reports zero unresolved mismatches for the happy path).
- [ ] Verify the same corridors end-to-end against a live sandbox anchor +
  Horizon testnet liquidity (requires anchor credentials + funded testnet).

---

## Phase 4 — Disputes + AI (advisory)

**Status:** Application implementation complete (AI advisory engine + backend
human-gated dispute workflow + audit). The dispute record is the auditable
resolution authority; the actual fund movement stays on the Phase 2
compliance-operated escrow/payments arbiter path.

**Goal:** Fair, auditable dispute resolution with human oversight.

**Deliverables**
- [x] Evidence upload (invoice, tracking, OTP, courier, images) + bounded review
  window (`DISPUTE_EVIDENCE_WINDOW_HOURS`, default 24h). Evidence stores only
  opaque references, never raw content/PII.
- [x] AI Risk Engine: recommendation + confidence + explanation + signals
  (existing AI `/dispute-recommend`; backend `HttpDisputeRiskClient` with a
  deterministic test adapter; AI outage degrades to human review).
- [x] Human approval gate above thresholds; auto-resolve only below amount /
  above confidence thresholds (`AUTO_RESOLVE_MAX_AMOUNT`,
  `AUTO_RESOLVE_MIN_CONFIDENCE`) with a non-conflicting, non-manual advisory.
- [x] Reputation + fraud-signal inputs; full append-only decision audit (AI
  advisory and human/auto decision both logged and reproducible).
- [ ] Wire the recorded resolution to execute the escrow release/refund
  automatically (currently the compliance arbiter executes it via the Phase 2
  payments path); requires the release-path state-machine work.
- [ ] Reputation store (Phase 6) — reputations currently default to neutral.

**Acceptance criteria**
- [x] A dispute produces an explainable AI recommendation (recommendation +
  confidence + explanation + signals; reproducible from stored evidence).
- [x] High-value/low-confidence (or conflicting) disputes require human
  sign-off — auto-resolve is refused and only a compliance reviewer can decide.
- [x] Every decision (AI advisory + human/auto resolution) is audit-logged and
  reproducible (dispute tests assert the audit trail).

---

## Phase 5 — RWA Tokenization (opt-in module)

**Goal:** Sellers unlock working capital; investors get transparent ownership.

**Deliverables**
- Soroban `rwa_token` contract (issuance + payout distribution).
- Tokenize invoice/commodity/real estate; fractional ownership.
- Investor purchase flow; payout to holders when buyer pays through escrow.
- Ownership/transfer transparency + compliance controls.

**Acceptance criteria**
- An invoice can be tokenized, sold fractionally, and pays holders on buyer
  payment — all reconciled in the ledger.
- Tokenization is fully separate from the escrow happy path.

---

## Phase 6 — Hardening & Mainnet Vision

**Goal:** Production readiness and scale.

**Deliverables**
- Full reconciliation, monitoring, alerting, tracing.
- Security audit of Soroban contracts.
- Real anchor partnerships; multi-currency + stablecoin pools.
- Compliance/licensing (money-transmitter/MSB) completed for launch corridors.
- Mainnet deployment; bank/payment-provider integrations.

**Acceptance criteria**
- Independent security audit passed on contracts.
- Licensing in place for real-money go-live in target corridors.
- SLOs met (availability, settlement time, reconciliation = 0 unresolved).

---

## Cross-Phase Definition of Done
- Build + relevant tests pass.
- Golden rules (Rules.md) upheld.
- `Memory.md` updated (status + decisions + changelog).
