# StellarTrust — Project Memory

> **Purpose:** Living state file for the whole project. **Read this first** at the
> start of any session, and **update it after any change.** It captures current
> status, what is being worked on, what is complicated, decisions made, and a
> changelog. This is the shared memory for humans and AI agents.
>
> **Update policy:** Every change to the codebase or docs should update the
> relevant section here (Current Focus, Decision Log, Changelog, Complications).

**Last updated:** 2026-07-18

---

## 1. Project Snapshot

- **Name:** StellarTrust
- **What:** AI-powered cross-border escrow, liquidity settlement, and RWA
  tokenization platform on Stellar.
- **Track:** Production (real product for real users).
- **Current phase:** Phase 1 — Identity & Wallet (**application implementation
  complete; production persistence/provider/KMS integration remains**; see §2).
- **Repo state:** All six portions are present: `frontend/`, `backend/`, `ai/`,
  `contracts/`, `shared/`, and `infra/`. Shared, backend, and frontend builds are
  green locally; backend has 24 passing tests. Phase 1 runtime repositories are
  intentionally in-memory behind interfaces, while migration `0003` defines
  the production Postgres contract.

### Canonical docs
- `PRD.md` — product requirements, users, features.
- `Architecture.md` — architecture, flow, structure, stack, data model.
- `Rules.md` — engineering rules, libraries, error handling, AI guardrails.
- `Phases.md` — phased roadmap + acceptance criteria.
- `DESIGN.md` — colors, fonts, typography, UI system.
- `Memory.md` — this file.

---

## 2. Current Focus

- **Currently working on:** Phase 1 — Identity & Wallet. The application-layer
  implementation is complete and validated; production adapters and external
  operational setup remain before this can be called production-ready.
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
  - ✅ `shared`: `npm run build` passes.
  - ✅ `backend`: lint + typecheck + build + **24 tests pass** across four test
    files. Phase 1 acceptance coverage includes valid SEP-10 login, replay and
    wrong-wallet rejection, passing KYC/KYB, queued borderline review, human
    approval, verified profiles, and PII exclusion from audit metadata.
  - ✅ `frontend`: typecheck + optimized production build pass; `/`, `/kyc`,
    and `/admin/kyc` are generated successfully.
  - ✅ `ai`: application and test sources byte-compile.
  - ⚠️ `ai`: pytest is not runnable locally because Python 3.14 lacks the
    pinned native dependency/test environment; CI uses Python 3.12.
  - ⚠️ `contracts`: Rust/cargo remains blocked by Windows Application Control;
    CI runs contract tests.
  - ⚠️ `database`: migration `0003` is authored but cannot run locally because
    Docker/psql are unavailable; database CI applies migrations.
  - ⚠️ **Security action:** a Supabase server secret was previously exposed in
    conversation and must be rotated. Never copy its value into this file,
    source control, frontend variables, logs, or responses.

- **Next up:** rotate the exposed Supabase secret; implement and validate the
  Postgres repositories; select/integrate a production KYC vendor; configure a
  real KMS/HSM signer; then begin Phase 2 — Orders & Smart Escrow.

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
- **Not usable on this dev machine:** Rust/cargo builds and Python native
  (Rust-backed) wheel builds are **blocked by an OS Application Control policy**
  (`os error 4551`). Consequences: `ai` pytest and `contracts` cargo test can't
  run locally — they run in CI instead (Python 3.12 / Rust toolchain).
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

---

## 8. How To Use This File (for AI agents & contributors)

1. **On session start:** read this file + `Rules.md` before acting.
2. **Before coding:** confirm current phase + focus here.
3. **After any change:** update Section 2 (Current Focus), add to Changelog,
   record new decisions (Section 3) and complications (Section 4).
4. **When a file becomes the active work item:** note it in "File(s) in
   progress."
5. Keep entries concise and factual. This file is the project's memory.
