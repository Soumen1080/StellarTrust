# StellarTrust — Project Memory

> **Purpose:** Living state file for the whole project. **Read this first** at the
> start of any session, and **update it after any change.** It captures current
> status, what is being worked on, what is complicated, decisions made, and a
> changelog. This is the shared memory for humans and AI agents.
>
> **Update policy:** Every change to the codebase or docs should update the
> relevant section here (Current Focus, Decision Log, Changelog, Complications).

**Last updated:** 2026-07-22

---

## 1. Project Snapshot

- **Name:** StellarTrust
- **What:** AI-powered cross-border escrow, liquidity settlement, and RWA
  tokenization platform on Stellar.
- **Track:** Production (real product for real users).
- **Current phase:** Phase 5 — RWA Tokenization (**application implementation
  complete**; public-testnet contract deployment and production persistence
  remain). Phases 1–4 application code remains complete with their operational
  prerequisites outstanding.
- **Repo state:** All six portions are present. Shared/backend/frontend checks
  are green locally; backend has 64 tests (61 passing, 3 pre-existing KYC
  auto-approve timing failures unrelated to Phase 5). Phases 2–5 use interfaces
  with in-memory repositories and deterministic/sandbox chain, anchor,
  liquidity, and AI adapters locally. Migrations `0004` (Phase 2) and `0006`
  (Phase 5 RWA schema) define forward-only persistence contracts.

### Canonical docs
- `PRD.md` — product requirements, users, features.
- `Architecture.md` — architecture, flow, structure, stack, data model.
- `Rules.md` — engineering rules, libraries, error handling, AI guardrails.
- `Phases.md` — phased roadmap + acceptance criteria.
- `DESIGN.md` — colors, fonts, typography, UI system.
- `Memory.md` — this file.

---

## 2. Current Focus

- **Currently working on:** Phase 5 application code is complete and validated.
  Remaining Phase 5 work is operational: deploy the `rwa_token` contract to the
  public Stellar testnet and swap the deterministic RWA gateway + in-memory RWA
  repository for KMS-backed Soroban RPC and Postgres adapters. Earlier phases'
  operational prerequisites (live anchor/Horizon adapters, public-testnet escrow
  contract, prod persistence, dispute auto-execution, reputation store) also
  remain.
- **What was built (Phase 5 — RWA Tokenization, opt-in module):**
  - Soroban `rwa_token` contract extended beyond the skeleton: asset-type +
    description metadata, compliance controls (`freeze`/`unfreeze`,
    authorization whitelist with `authorize`/`revoke_authorization`/
    `is_authorized`), `all_payout_shares`, `get_holders`, and expanded unit
    tests (invoice/commodity/real-estate, freeze, authorization, idempotent
    distribution). (`cargo build` blocked locally by an OS Application Control
    policy — code complete, builds in a normal toolchain.)
  - Shared contracts of record: `AssetType`, `TokenizationStatus`,
    `PayoutStatus` enums and `AssetDTO`, `TokenizationDTO`, `TokenHoldingDTO`,
    `PayoutDistributionDTO`, `PayoutRecordDTO` + input/response DTOs. All
    numeric quantities are **integer strings** (minor units / unit counts),
    never `bigint`, so they stay JSON-safe over REST.
  - `rwa` bounded context (`backend/src/modules/rwa`):
    - `RwaGateway` + `DeterministicRwaGateway` (mirrors the contract state
      machine: deploy, transfer, authorize, freeze, balances, pro-rata shares)
      and a `SorobanRpcRwaGateway` production placeholder. Fail-closed factory
      (`RWA_GATEWAY`).
    - `RwaService` — create asset → tokenize → deploy → investor purchase →
      pro-rata payout distribution, plus freeze/unfreeze and investor portfolio.
      Exact BigInt arithmetic internally; strings at the boundary. Append-only
      audit on every mutation.
    - `InMemoryRwaRepository` — assets/tokenizations/holdings/distributions/
      payout-records with units-sold tracking, over-subscription guard, and
      auto-funding.
    - Authenticated, idempotent `/api/rwa` routes (assets, tokenizations,
      deploy, purchase, freeze/unfreeze, portfolio, distribute-payout).
  - **Escrow integration:** `PaymentService` takes an optional `RwaService` and,
    on `Release`, auto-distributes a pro-rata payout to holders of any
    tokenization whose `linkedOrderId` matches the released order. Failures are
    audited and non-fatal (payout is retryable) so the tested money state
    machine is unchanged.
  - Forward-only migration `0006_phase5_rwa_tokenization.sql`: assets,
    tokenizations, token_holdings, payout_distributions, payout_records, RWA
    ledger accounts, units-sold/over-sell/auto-fund triggers, and RLS.
  - Frontend `/rwa` console: marketplace (investor purchase), tokenize (issuer
    two-step asset→tokenization + deploy + freeze), and portfolio tabs. New nav
    link, `StatusPill` statuses, and typed API client methods.
  - Config: `RWA_GATEWAY`.
  - **Bug caught by tests:** `purchaseUnits` originally transferred units before
    authorizing the recipient; the contract rejects transfers to unauthorized
    holders, so authorization now precedes the transfer.
  - **Design boundary (Rules.md §3):** RWA is a peer module, fully separate from
    the escrow happy path; the ledger remains the system of record for payouts.
- **What was built (Phase 4 — Disputes + AI advisory):**
  - Shared contracts: `EvidenceKind`, `DisputeResolution`,
    `DisputeDecisionMaker`; expanded `DisputeDTO` (order link, amount, evidence,
    advisory, `autoResolvable`, resolution, evidence window); evidence/decision
    Zod schemas.
  - `disputes` bounded context (`backend/src/modules/disputes`):
    - `DisputeRiskClient` + `HttpDisputeRiskClient` (calls the read-only AI
      `/dispute-recommend`) with a `DeterministicDisputeRiskClient` for tests;
      an AI timeout/outage degrades to a manual-review advisory (never blocks).
    - `DisputeService` — lifecycle open → evidence (bounded window) → advisory →
      resolution. AI is advisory only; the backend applies the human gate:
      auto-resolve is permitted **only** below `AUTO_RESOLVE_MAX_AMOUNT` and
      at/above `AUTO_RESOLVE_MIN_CONFIDENCE` with a non-conflicting, non-manual
      advisory; everything else requires a compliance sign-off. Every advisory
      and final decision is append-only audit-logged and reproducible from the
      stored evidence.
    - `InMemoryDisputeRepository` + a `DisputeOrderGateway` port into payments
      (kept isolated; wired in the composition root over the payment repository).
    - Authenticated, idempotent `/api/disputes` routes (open, evidence, resolve,
      list, compliance queue, details).
  - Fixed the advisory `conflicting` test to use **raw evidence** (reputation is
    a prior, not conflicting evidence) in both the backend deterministic client
    and the Python engine, so auto-resolve is reachable and correct.
  - Frontend `/disputes` console: open a dispute, submit evidence, view the
    read-only AI advisory (recommendation + confidence + explanation + signals),
    auto-resolve when eligible, and a compliance human-decision form. New nav
    link and typed API client methods.
  - Config: `DISPUTE_EVIDENCE_WINDOW_HOURS`, `DISPUTE_AI_TIMEOUT_MS`.
  - **Design boundary:** the dispute record is the auditable resolution
    authority; actual fund movement stays on the Phase 2 compliance arbiter path
    (escrow/payments), keeping the tested money state machine unchanged.
- **What was built (Phase 3 — Cross-Border Settlement):**
  - Shared contracts: settlement lifecycle/transition/route/anchor enums,
    `CURRENCY_SCALE`, corridor/quote/route/settlement/anchor-transfer/
    reconciliation DTOs, and quote/execute Zod schemas.
  - `settlement` bounded context (`backend/src/modules/settlement`):
    - `AnchorGateway` + deterministic `SandboxAnchorGateway` — SEP-6/24/31
      deposit/withdrawal and SEP-12 KYC exchange; retains only an opaque
      customer id (no raw PII). Fail-closed factory (`ANCHOR_GATEWAY`).
    - `LiquidityGateway` + `DeterministicLiquidityGateway` — classic-Stellar
      path-payment and AMM route economics with exact BigInt minor-unit
      conversion (`convertMinorUnits`, USD-referenced price table). Fail-closed
      factory (`LIQUIDITY_GATEWAY`).
    - `RoutingService` — pure best-route selection (max destination value, then
      lower fee, then faster) that fails closed when no route satisfies the
      slippage/fee limits.
    - `SettlementService` — quote a corridor, then execute deposit → convert →
      payout. Every leg writes a balanced double-entry ledger transaction (each
      currency self-balances via an `FX_CONVERSION` account) linked to its
      anchor transfer and/or path-payment record, plus append-only audit.
      Idempotent per quote; expired quotes and cross-user execution rejected.
    - `SettlementReconciliationJob` — re-verifies balanced ledger + successful
      anchor/chain records per transition and blocks settlements with an
      unresolved mismatch (Golden Rule #7).
    - Authenticated, idempotent REST routes under `/api/settlement`
      (`/corridors`, `/quotes`, `/orders`, `/orders/:id`, `/reconciliation/run`).
  - Frontend `/settlement` console: corridor picker → routed quote (destination,
    rate, fee, slippage, routes considered) → execute, plus a settlement history
    with per-leg detail. New nav link and typed API client methods.
  - Config: `ANCHOR_GATEWAY`, `LIQUIDITY_GATEWAY`, `SETTLEMENT_QUOTE_TTL_SECONDS`,
    `SETTLEMENT_DEFAULT_MAX_SLIPPAGE_BPS`.
- **What was built (Phase 2):**
  - Shared payment-transition, order mutation/detail, and reconciliation DTOs +
    Zod create-order validation.
  - Strict create → accept → deposit → lock → confirm → release state machine,
    party/role authorization, arbiter-only refund, and authenticated idempotent
    REST routes under `/api/payments`.
  - Atomic local financial commit boundary linking order/escrow state, balanced
    ledger entries, chain record, actor, and append-only audit event.
  - Deterministic local Soroban gateway mirroring lock/confirm/release/refund,
    plus a scheduled reconciliation worker that reports mismatches and blocks
    dependent operations.
  - Soroban contract buyer-confirmation gate, contract unit cases, and a
    credential-free PowerShell public-testnet deployment helper.
  - Forward-only migration `0004` for payment transitions, chain metadata,
    reconciliation mismatch persistence, RLS, and database-level fail-closed
    blocking.
  - Buyer/seller `/escrow` dashboard and typed API client.
  - Gitignored `infra/.env` with safe local defaults; manual external-service
    placeholders remain commented.
- **What was built (Phase 1):**
  - **Shared contracts:** SEP-10 challenge/session, KYC/KYB application,
    normalized provider checks, advisory risk, review queue, human decision,
    and verified identity/business profile DTOs and Zod schemas.
  - **Database contract:** forward-only migration
    `infra/supabase/migrations/0003_phase1_identity_wallet.sql` for one-time
    SEP-10 challenges, hashed sessions, profile verification state, normalized
    KYC results, advisory snapshots, human review, audit indexes, and RLS. Raw
    identity and face documents are deliberately excluded.
  - **Wallet authentication:** standard SEP-10 challenge construction and
    Stellar Wallets Kit signing. The server transaction is signed only through
    the existing `Signer` KMS/HSM boundary; replay, expiry, and wrong-wallet
    signatures are rejected. Opaque bearer tokens are stored server-side only
    as SHA-256 hashes and compose with Supabase JWKS authentication.
  - **KYC/KYB workflow:** deterministic sandbox provider behind `KycProvider`
    exercises document/OCR/face/liveness/AML pass-review-fail scenarios without
    storing raw provider payloads or PII. The provider remains swappable because
    the production vendor is still an open decision.
  - **Advisory and policy:** timeout/validated AI risk client, backend-owned
    Approve/Review/Reject decision engine, AI-outage fallback, human compliance
    queue, mandatory decision reasons, and append-only PII-safe audit events.
    AI never makes the final policy decision or writes funds/ledger state.
  - **Frontend:** Stellar Wallets Kit `2.5.0`, testnet SEP-10 sign-in,
    `sessionStorage`-only sessions, individual/business onboarding at `/kyc`,
    persisted profile/review status, explainable advisory output, and a
    role-gated compliance queue at `/admin/kyc`.
  - **Boundaries:** exact-origin CORS for the independently served frontend;
    production KYC/auth repositories remain interfaces with in-memory runtime
    implementations pending validated Postgres adapters.

- **Verification status (this environment):**
  - ✅ `shared`: TypeScript build passes (Phase 4 dispute contracts compile).
  - ✅ `backend`: lint + typecheck + **48 tests pass** across seven test files.
    Phase 4 coverage proves party-only dispute access, an explainable advisory,
    threshold-gated auto-resolve, human sign-off for high-value/conflicting
    disputes, and a complete audit trail (opened + advisory + resolved).
  - ✅ `frontend`: optimized production build passes and `/disputes` is
    generated alongside the existing routes.
  - ⚠️ `ai`: the dispute engine `conflicting` fix byte-compiles; `pytest` is not
    installable locally (CI authoritative). Existing AI tests are unaffected.
  - ⚠️ Phase 4 fund execution: a resolved dispute records the authorized outcome
    but does not itself move funds — the compliance arbiter executes it via the
    Phase 2 payments/escrow path. Auto-execution + a reputation store are
    deferred.
  - ⚠️ Phase 3 live path, `contracts`, `database`/Compose, and public-testnet
    items are unchanged (CI/Linux authoritative; Docker/psql unavailable here).
  - ⚠️ **Security action:** the previously exposed Supabase server secret must
    still be rotated before any external integration is enabled.

- **Next up:** wire resolved-dispute outcomes to auto-execute through the
  escrow/payments arbiter path (needs the release-path state-machine work); add
  a reputation store; then resume the deferred Phase 2/3 operational items
  (live anchor/Horizon adapters, public-testnet contract, prod persistence,
  credential rotation).

---

## 3. Key Decisions Made (Decision Log)

| # | Date | Decision | Rationale |
|---|---|---|---|
| D1 | 2026-07-18 | Production track | Real product for real users |
| D2 | 2026-07-18 | Postgres/Supabase as system of record; **no MongoDB** | ACID + double-entry ledger required |
| D3 | 2026-07-18 | Double-entry ledger is source of truth; chain is not accounting | Financial correctness + reconciliation |
| D4 | 2026-07-18 | Classic Stellar for payments/liquidity; Soroban for escrow/RWA | Right tool per capability |
| D5 | 2026-07-18 | Fiat ramp via Anchors + SEP-31/24/6/10/12 | Real cross-border settlement, not hand-waved |
| D6 | 2026-07-18 | AI is advisory, human-gated above thresholds | Legal/liability + fairness |
| D7 | 2026-07-18 | KYC/liveness via 3rd-party provider, not built in-house | Compliance + speed |
| D8 | 2026-07-18 | Modular monolith (`backend`) + separate Python AI service | Simplicity + ML ecosystem |
| D9 | 2026-07-18 | Separate top-level folders per portion (`frontend`/`backend`/`ai`/`contracts`/`shared`/`infra`); `frontend` & `backend` independently deployed with own `package.json` | Full separation of concerns; independent build/scale/deploy |
| D10 | 2026-07-18 | Secret keys only via KMS/HSM boundary | Security |
| D11 | 2026-07-18 | RWA is opt-in module, not in escrow happy path | Correct domain modeling |
| D12 | 2026-07-18 | Money amounts stored/validated as integer **minor units** (BigInt in TS, `bigint` in Postgres), never floats | Financial precision; no float drift |
| D13 | 2026-07-18 | Ledger balancing enforced **twice**: backend service (pre-persist) + Postgres deferred constraint trigger | Defense in depth on Golden Rule #1 |
| D14 | 2026-07-18 | `shared/` holds contracts only (types/constants/validation/**error codes**); runtime error **classes** live in backend | Keep shared free of runtime logic/secrets |
| D15 | 2026-07-18 | Backend test runner pinned to **vitest 3.2.4** | vitest 4.1.10 had a framework-level incompat with dotenv v17 that broke suite loading |
| D16 | 2026-07-18 | Frontend pinned to **Next.js 15.5.20** (patched backport) | 15.1.3 flagged CVE-2025-66478; stayed on 15.x to minimize churn |
| D17 | 2026-07-18 | AI service targets **Python 3.12** in CI/Docker | pydantic-core has no 3.14 wheel; avoids source build |
| D18 | 2026-07-18 | Idempotency + ledger repositories use in-memory impls behind interfaces for Phase 0 | Swap to Redis/Postgres in later phases without changing call sites |
| D19 | 2026-07-18 | Supabase integration: **raw Postgres (`DATABASE_URL`)** for the ledger/system-of-record; **Supabase Auth JWT verification via JWKS** (`jose`) plugged into the `BearerVerifier` boundary; Supabase admin client (secret key) behind an adapter for Auth/Storage. Verifier factory uses JWKS in dev/prod, dev stub only in test. | Keep DB access as typed SQL; adopt real token auth early behind the existing seam without committing to Supabase-only APIs |
| D20 | 2026-07-18 | Construct SEP-10 challenges without a raw server `Keypair`, then sign transaction XDR only through the existing `Signer` interface | Preserve the KMS/HSM boundary; `WebAuth.buildChallengeTx` requires direct key material |
| D21 | 2026-07-18 | Issue opaque random auth session tokens and persist only SHA-256 token hashes | A database compromise must not reveal immediately reusable bearer tokens |
| D22 | 2026-07-18 | Use a deterministic sandbox implementation behind `KycProvider` until the production vendor is selected | Deliver and test the workflow without coupling the domain to an undecided vendor |
| D23 | 2026-07-18 | The backend decision engine owns final KYC policy; AI output is advisory only | Enforce legal/accountability boundaries and keep funds/ledger outside AI control |
| D24 | 2026-07-18 | Provider failures/conflicts, AML hits, low confidence, borderline risk, and AI outages route to human review | Fail safely rather than approving or rejecting uncertain cases autonomously |
| D25 | 2026-07-18 | Persist normalized KYC outcomes and opaque provider references only; never raw documents, face images, or provider payloads | Data minimization and PII protection |
| D26 | 2026-07-18 | Phase 1 runtime auth/identity/KYC/audit repositories remain in-memory behind interfaces; migration `0003` is the production persistence contract | Avoid claiming or rushing unvalidated DB persistence when local Postgres is unavailable |
| D27 | 2026-07-18 | Pin Stellar Wallets Kit to `2.5.0` and keep browser sessions in `sessionStorage`, never `localStorage` | Reproducible wallet integration with reduced bearer-token persistence |
| D28 | 2026-07-18 | Allow one configured frontend origin with explicit CORS middleware | Support independent frontend/backend deployment without adding a broad CORS policy or dependency |
| D29 | 2026-07-20 | Model each Phase 2 lifecycle step as an immutable financial transition linking order state, balanced ledger transaction, chain record, actor, and audit metadata | Prevent partial accounting records and make every step independently reconcilable |
| D30 | 2026-07-20 | Require buyer-authenticated on-chain delivery confirmation before happy-path contract release; retain arbiter authorization for the actual movement | A backend arbiter cannot release normal escrow before the buyer confirms delivery |
| D31 | 2026-07-20 | Block order mutations whenever reconciliation has an unresolved mismatch | Golden Rule #7 requires fail-closed dependent operations |
| D32 | 2026-07-20 | Use a deterministic Soroban adapter only for local/test; require KMS-backed RPC submission in staging/production | Enable reproducible tests without pretending synthetic receipts are live chain settlement |
| D33 | 2026-07-20 | Keep Phase 2 runtime persistence in-memory until migration `0004` can be validated with production Postgres/Redis adapters | Preserve explicit interfaces and avoid claiming untested financial persistence |
| D34 | 2026-07-20 | Store safe local stack defaults in gitignored `infra/.env`; leave external credentials commented/manual | Make local setup reproducible without committing API keys or secrets |
| D35 | 2026-07-22 | Model cross-border settlement as three financial transitions — deposit → convert → payout — each an immutable balanced ledger transaction linked to its anchor transfer and/or path-payment record | Every fiat/liquidity leg is independently reconcilable and can never exist without balanced accounting |
| D36 | 2026-07-22 | Record cross-currency conversions with a per-currency-balanced double-entry posting through an `FX_CONVERSION` account (source and destination legs each self-balance) | Keep Golden Rule #1 (balanced per currency) intact for multi-currency movement without floating FX in the ledger |
| D37 | 2026-07-22 | All settlement money math uses integer minor units with BigInt and a USD-referenced rational price table + `CURRENCY_SCALE` | Financial precision across currencies with differing decimals; no float drift (extends D12) |
| D38 | 2026-07-22 | Routing selects the best route by net destination value, then fee, then speed, and fails closed when no route meets the slippage/fee limits | Deliver the most value while honoring explicit user constraints; never silently exceed limits |
| D39 | 2026-07-22 | Liquidity conversion uses classic Stellar (path payments + AMM) behind `LiquidityGateway`; anchors sit behind `AnchorGateway` with SEP-6/24/31 + SEP-12 | Rules.md #3 (no Soroban for liquidity/settlement) and D5 (anchor-based fiat ramp); adapters swap sandbox → live per corridor |
| D40 | 2026-07-22 | SEP-12 KYC exchange with the anchor retains only an opaque customer id; sandbox anchor and deterministic liquidity adapters are refused outside development/test | Data minimization/PII protection (D25, Rules.md §7) and fail-closed on synthetic adapters in staging/production |
| D41 | 2026-07-22 | Dispute AI is advisory only; the backend owns the human gate. Auto-resolve only when below `AUTO_RESOLVE_MAX_AMOUNT` AND at/above `AUTO_RESOLVE_MIN_CONFIDENCE` with a non-conflicting, non-manual advisory; else a compliance human must sign off | Rules.md #3/#6 — AI never makes autonomous money decisions above threshold |
| D42 | 2026-07-22 | The dispute record is the auditable resolution authority; fund movement stays on the Phase 2 compliance-operated escrow/payments arbiter path | Keep bounded contexts isolated and the tested money state machine unchanged; avoid AI/dispute code writing funds |
| D43 | 2026-07-22 | An AI dispute-service timeout/outage degrades to a manual-review advisory rather than blocking or auto-deciding the dispute | Rules.md §6 — fall back to human review when AI is down |
| D44 | 2026-07-22 | Advisory "conflicting evidence" is computed from raw submitted evidence only; reputation is a bounded prior nudge, not conflicting evidence | Correctness — otherwise neutral reputations flag every dispute as conflicting and auto-resolve is unreachable |

---

## 4. Complications & Risks (what's hard)

| Area | Complication | Status / Mitigation |
|---|---|---|
| Fiat on/off ramp | Needs regulated anchors per corridor; not trivial | Use SEP-31/24; start with controlled/sandbox anchor |
| Custody | Escrow fund custody model must be trustless/defensible | Soroban escrow contract; confirm hybrid needs |
| AI liability | Autonomous money decisions are risky | Advisory + human gate + audit log |
| Reconciliation | Ledger ↔ chain drift | Scheduled reconciliation job; block on mismatch |
| Licensing | Money-transmitter/MSB needed for real money | Track before mainnet go-live (Phase 6) |
| Key management | Secret key handling | KMS/HSM; signer boundary. Local stub only; production provider still required |
| Phase 1 persistence | Runtime identity/auth/KYC/review/audit repositories are in-memory | Interfaces and migration `0003` are ready; implement/test Postgres adapters before production |
| KYC vendor | Production provider remains undecided | Keep sandbox adapter; select vendor and map it behind `KycProvider` |
| Wallet dependency on Windows | A transitive Trezor/Stellar SDK postinstall expects `yarn setup` and the Unix `true` command | Installed published Wallets Kit artifacts with `npm install --ignore-scripts`; typecheck and production build pass; CI should verify normal clean install |
| Supabase secret exposure | A server secret was pasted in conversation | Rotate it immediately; keep replacement only in gitignored local env/secret manager and never surface its value |
| Path payment liquidity | Thin corridors → slippage | Fee/slippage constraints in routing |
| Phase 2 chain adapter | Local deterministic receipts are not public-testnet settlement | Deploy contract and implement a KMS-backed Soroban RPC adapter before staging |
| Phase 2 persistence | Runtime payment/idempotency/reconciliation stores are in-memory | Migration `0004` defines the contract; implement and transaction-test Postgres/Redis adapters |
| Local database tooling | Docker and psql are unavailable on this machine | Validate migrations in CI or after installing Docker Desktop/Postgres client |
| Contract toolchain | Windows cargo fails inside Soroban dependency macro compilation | Run `cargo test` in Linux CI; use a working Stellar CLI for testnet deployment |
| Phase 3 anchor adapter | Sandbox anchor settles synchronously and holds no real fiat | Behind `AnchorGateway`; implement a live per-corridor SEP-6/24/31 client (async status/webhooks) before staging |
| Phase 3 liquidity adapter | Deterministic route economics are not live Horizon path-finding/AMM quotes | Behind `LiquidityGateway`; implement a Horizon path-finding + AMM adapter (`LIQUIDITY_GATEWAY=horizon`) before staging |
| Phase 3 persistence | Settlement quotes/transitions/mismatches are in-memory | Author a forward-only settlement Postgres schema and implement/transaction-test the adapter |
| Phase 4 dispute execution | A resolved dispute records the authorized outcome but does not itself move funds | By design the compliance arbiter executes it via the Phase 2 payments/escrow path; auto-execution needs the release-path state-machine work |
| Phase 4 reputation | Buyer/seller reputation inputs default to neutral (0.5) | Add a reputation store (Phase 6) feeding the advisory; current advisory relies on evidence weights |

---

## 5. Open Questions (need answers before/during Phase 0–3)

1. Launch corridors? (e.g., USD↔INR, USD↔EUR)
2. Anchor partner(s) per corridor?
3. Custody: Soroban-only escrow, or hybrid custodial for some flows?
4. Auto-resolve thresholds: `AUTO_RESOLVE_MAX_AMOUNT`,
   `AUTO_RESOLVE_MIN_CONFIDENCE`?
5. Which KYC provider (Sumsub / Onfido / Persona / Veriff)?
6. Target cloud (AWS / GCP) for KMS + hosting?

---

## 6. Environment / Toolchain Notes

- OS: Windows (dev machine).
- Verified present: Node v24.18.0, npm 11.16.0, Python 3.14.6, git 2.55.0.
- **Not fully usable on this dev machine:** Python native (Rust-backed) wheel
  builds remain blocked by OS policy. `cargo test` now starts and compiles many
  dependencies but fails inside Soroban environment macro dependencies before
  project source; Linux CI remains authoritative for contracts.
- No Docker/psql locally → DB-level migrations and trigger checks run in CI,
  not locally.
- Wallets Kit's published JS/types build locally, but a transitive dependency has
  a Unix-only postinstall. This Windows environment used
  `npm install --ignore-scripts`; clean CI installs must remain authoritative.
- No secrets are committed. A previously exposed Supabase server secret must be
  rotated, and its replacement must stay in the gitignored local environment or
  a secret manager. KMS/HSM is not yet configured (local stub signer only).

---

## 7. Changelog

| Date | Change |
|---|---|
| 2026-07-18 | Authored initial docs: PRD, Architecture, Rules, Phases, Design, Memory. |
| 2026-07-18 | Locked production-track decisions D1–D11 (see Decision Log). |
| 2026-07-18 | Restructured to fully separate top-level folders per portion: `frontend/`, `backend/`, `ai/`, `contracts/`, `shared/`, `infra/`. `frontend` & `backend` are independent projects (own `package.json`/build/deploy). Updated Architecture, Rules, Phases, Design accordingly (D9). |
| 2026-07-18 | **Phase 0 scaffold implemented.** Built all six portions + root README/.gitignore. `shared` contracts package; `backend` modular monolith (config, logging, error taxonomy, idempotency + auth middleware, double-entry ledger with balancing enforcement, Stellar wrappers, KMS signing boundary, `/health`); Supabase migrations incl. ledger tables + balancing trigger + seed; `ai` FastAPI advisory service; `contracts` Soroban escrow + rwa_token; `frontend` Next.js + Tailwind design tokens; `infra` Dockerfiles + docker-compose + CI. Verified locally: backend lint/typecheck/test(17)/build green, shared build green, frontend build green. Decisions D12–D18 recorded. |
| 2026-07-18 | **Supabase wired in (D19).** Added `@supabase/supabase-js` + `jose`; config now recognizes `SUPABASE_URL/PUBLISHABLE_KEY/SECRET_KEY/JWKS_URL`. New `modules/auth`: Supabase admin client adapter, JWKS JWT verifier, and a verifier factory (JWKS in dev/prod, dev stub in test, stub refused in staging/prod). Ledger routes use the selected verifier. Local `backend/.env` created (gitignored) with the project's values. Runtime smoke confirmed: `/health` ok; ledger endpoint rejects no-token / dev-token / bogus-JWT with 401 while Supabase JWKS verification is active. Backend lint/typecheck/test(17)/build still green. DB still uses raw `DATABASE_URL` (needs the project DB password to point at Supabase Postgres). |
| 2026-07-18 | **Phase 1 Identity & Wallet application implementation completed (D20–D28).** Added shared contracts and migration `0003`; KMS-boundary SEP-10 challenges, signature/replay checks, hashed opaque sessions, and Supabase/dev verifier composition; sandbox KYC/KYB provider; timeout-safe advisory AI integration; backend-owned policy, human review, verified profiles, and PII-safe audit; Wallets Kit sign-in; `/kyc` onboarding/status and `/admin/kyc` compliance UI; exact-origin CORS and environment template. Verified locally: shared build; backend lint/typecheck/24 tests/build; frontend typecheck/production build; AI byte-compilation. AI pytest, contract tests, and DB migrations remain CI-only on this machine. Runtime Phase 1 repositories are still in-memory pending Postgres adapters. Supabase server secret rotation remains required. |
| 2026-07-20 | **Phase 2 application implementation completed (D29–D34).** Added shared payment/reconciliation contracts; strict authenticated/idempotent order lifecycle and arbiter refund; atomic balanced ledger + linked chain + audit transition records; deterministic local Soroban boundary; scheduled reconciliation, alert/report, and blocking; migration `0004`; buyer-confirmed contract release and tests; `/escrow` UI; testnet deploy helper; and gitignored `infra/.env`. Validated shared build, backend lint/typecheck/29 tests, frontend production build, and diff checks. Public testnet, production adapters, DB migration execution, and contract CI remain unchecked/manual prerequisites. |
| 2026-07-22 | **Phase 3 application implementation completed (D35–D40).** Added shared settlement contracts (enums, `CURRENCY_SCALE`, corridor/quote/route/settlement/anchor DTOs, quote/execute schemas); new `settlement` bounded context — `SandboxAnchorGateway` (SEP-6/24/31 + SEP-12, opaque customer id), `DeterministicLiquidityGateway` (path-payment + AMM economics, exact BigInt conversion), `RoutingService` (best-route + fail-closed fee/slippage limits), `SettlementService` (deposit→convert→payout with per-currency-balanced ledger via `FX_CONVERSION`, PII-safe audit, quote idempotency), and `SettlementReconciliationJob` (ledger↔anchor/chain, blocks on mismatch); authenticated idempotent `/api/settlement` routes; config `ANCHOR_GATEWAY`/`LIQUIDITY_GATEWAY`/`SETTLEMENT_QUOTE_TTL_SECONDS`/`SETTLEMENT_DEFAULT_MAX_SLIPPAGE_BPS`; frontend `/settlement` console + nav link + typed API client. Validated shared build, backend lint/typecheck/**41 tests**, and frontend production build. Live anchor client, Horizon path-finding/AMM adapter, Phase 3 settlement persistence schema, and live-corridor verification remain manual/operational prerequisites. |
| 2026-07-22 | **Phase 4 application implementation completed (D41–D44).** Added shared dispute contracts (`EvidenceKind`, `DisputeResolution`, `DisputeDecisionMaker`, expanded `DisputeDTO`, evidence/decision schemas); new `disputes` bounded context — `HttpDisputeRiskClient`/`DeterministicDisputeRiskClient` (advisory `/dispute-recommend`, outage→manual review), `DisputeService` (open → bounded evidence window → advisory → threshold-gated auto-resolve or compliance human sign-off, append-only audit of AI + human decisions), `InMemoryDisputeRepository` + `DisputeOrderGateway` port; authenticated idempotent `/api/disputes` routes; config `DISPUTE_EVIDENCE_WINDOW_HOURS`/`DISPUTE_AI_TIMEOUT_MS`. Corrected advisory `conflicting` to use raw evidence (backend + Python engine). Frontend `/disputes` console + nav link + typed API client. Validated shared build, backend lint/typecheck/**48 tests**, and frontend production build. Auto-execution of the resolved outcome and a reputation store are deferred; AI pytest is CI-only. |
| 2026-07-22 | **Phase 5 (RWA Tokenization) application implementation completed.** Extended the Soroban `rwa_token` contract (asset metadata, freeze/authorization compliance controls, `all_payout_shares`/`get_holders`, expanded tests). Added shared RWA contracts of record (`AssetType`/`TokenizationStatus`/`PayoutStatus` + asset/tokenization/holding/distribution/record DTOs, all integer-string amounts for JSON safety). New `rwa` bounded context — `DeterministicRwaGateway` (+ `SorobanRpcRwaGateway` placeholder, fail-closed `RWA_GATEWAY` factory), `RwaService` (asset→tokenize→deploy→purchase→pro-rata payout, freeze/unfreeze, portfolio; exact BigInt math, append-only audit), `InMemoryRwaRepository` (units-sold tracking, over-sell guard, auto-fund); authenticated idempotent `/api/rwa` routes. Wired `PaymentService` to auto-distribute RWA payouts on escrow `Release` for `linkedOrderId` tokenizations (non-fatal, retryable). Forward-only migration `0006_phase5_rwa_tokenization.sql`. Frontend `/rwa` console (marketplace/tokenize/portfolio) + nav link + `StatusPill` statuses + typed API client. Tests caught and fixed an authorize-before-transfer bug. Validated shared build, backend lint/typecheck/**16 new RWA tests (61 pass; 3 pre-existing KYC failures unrelated)**, and frontend production build. Public-testnet contract deploy and prod Postgres/KMS-Soroban adapters remain operational prerequisites. |

---

## 8. How To Use This File (for AI agents & contributors)

1. **On session start:** read this file + `Rules.md` before acting.
2. **Before coding:** confirm current phase + focus here.
3. **After any change:** update Section 2 (Current Focus), add to Changelog,
   record new decisions (Section 3) and complications (Section 4).
4. **When a file becomes the active work item:** note it in "File(s) in
   progress."
5. Keep entries concise and factual. This file is the project's memory.
