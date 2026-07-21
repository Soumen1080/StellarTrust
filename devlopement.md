# StellarTrust — Development Log, Issue Register & Production Plan

> **Purpose:** This is the working development file. It records the **real,
> verified state** of the codebase, every **issue / problem / structural gap**
> found during the audit, the **current build strategy** (frontend + backend
> first), the **temporary development shortcuts** we are intentionally using,
> and the **plan to reach a production-level platform**.
>
> **Read this together with:** `Memory.md` (project memory), `Rules.md`
> (golden rules), `Phases.md` (roadmap), `Architecture.md` (target design).
>
> **Last updated:** 2026-07-22
> **Audit basis:** full read of `frontend/`, `backend/`, `ai/`, `contracts/`,
> `shared/`, `infra/`, root config, and all root docs.

---

## 0. TL;DR — Where we actually are

| Layer | Code exists | Builds/tests | Works in a live demo | Blocker |
|---|---|---|---|---|
| Frontend (Next.js) | ✅ | ✅ builds | ⚠️ loads, but every real action fails | depends on backend auth |
| Backend (Express) | ✅ | ✅ 29 tests pass | ❌ **500 on first auth call** | signer + persistence |
| Auth (SEP-10) | ✅ | ✅ unit | ❌ **HTTP 500 in prod** | no KMS signer configured |
| Persistence (DB) | ❌ interfaces only | n/a | ❌ in-memory, resets every request | Postgres adapters not written |
| Escrow contract | ✅ Rust code | ⚠️ CI-only | ❌ not deployed | testnet deploy not done |
| AI service | ✅ FastAPI | ⚠️ CI-only | ❌ not deployed | not hosted, not wired |

**One-line status:** The code is well-architected and passes local checks, but
**nothing works end-to-end in a deployed environment** because (1) wallet auth
needs a signing key that is not configured, (2) all data lives in memory and
disappears between serverless invocations, and (3) the contract and AI service
are not deployed.

**Current decision (this phase):** Get **frontend + backend working properly
first**. Temporarily **stub out the Soroban contract and the AI engine**, and
**auto-verify KYC after 10 seconds** so the product flow can be exercised
smoothly during development. Contract deployment and real AI come back later.

---

## 1. Current Build Strategy (this phase)

We are deliberately narrowing scope to unblock development:

1. **Frontend + Backend are the priority.** Make the full user journey work in a
   deployed environment: connect → authenticate → KYC → create order → escrow
   lifecycle → dashboard.
2. **Smart-contract deployment is deferred.** Keep the deterministic escrow
   gateway as the runtime path for now (it already mirrors the contract state
   machine). Real Soroban deployment returns in a later step.
3. **AI engine is deferred / stubbed.** The KYC risk client and dispute engine
   fall back to a deterministic local decision. No external AI service call is
   required to complete a flow.
4. **KYC auto-verifies after ~10 seconds** (temporary dev shortcut). When a user
   submits verification, the system shows a short "verifying" state and then
   marks the profile **Verified** automatically, so downstream flows (escrow,
   dashboard) are reachable without a manual compliance step. See §6 for the
   exact design and the guardrails that keep this out of production.

> These are **development shortcuts**, tracked here so they are never mistaken
> for production behavior. Each has a matching "must reverse before production"
> entry in §7.

---

## 2. Issue Register (everything found in the audit)

Severity: 🔴 blocker · 🟠 major · 🟡 minor / hygiene

### A. Deployment & runtime architecture

- 🔴 **A1 — Wallet auth returns HTTP 500 in production.**
  `Sep10Service.createChallenge()` calls `signer.getPublicKey()` and
  `signer.signTransactionXdr()`. In staging/production with
  `SIGNER_PROVIDER=local-stub`, `createSigner()` returns `UnavailableSigner`,
  which throws `ExternalServiceError`. Since auth gates the whole app, the
  entire product is unusable when deployed. This is the top blocker.
  *(File: `backend/src/modules/stellar/signer.ts`, `.../auth/sep10.service.ts`.)*

- 🔴 **A2 — Everything is in-memory; nothing persists.**
  `app.ts` wires `InMemoryIdentityRepository`, `InMemoryAuthRepository`,
  `InMemoryKycRepository`, `InMemoryPaymentRepository`,
  `InMemoryAuditRepository`, and an in-memory idempotency store. On a serverless
  host (Vercel), each cold start / instance gets a fresh empty store, so:
  sessions vanish, orders disappear, and a challenge issued by one instance can
  be verified by another that never saw it. No flow can be trusted across
  requests.

- 🟠 **A3 — Backend deployed as serverless, but it expects a long-lived process.**
  `backend/src/index.ts` starts the `ReconciliationJob` scheduler and handles
  `SIGINT/SIGTERM`. The serverless entrypoints (`api/index.ts`,
  `backend/api/index.ts`) only call `createApp()` — the reconciliation scheduler
  **never starts** in the deployed path. A scheduler + in-memory job state does
  not fit the serverless model; it needs a persistent worker.

- 🟠 **A4 — Two conflicting serverless entrypoints.**
  Both `./api/index.ts` (imports `../backend/src/app.js`) and
  `./backend/api/index.ts` (imports `../src/app.js`) exist and export
  `createApp()`. The root `vercel.json` rewrites `/(.*) → /api`. It is ambiguous
  which project/entrypoint actually deploys the backend, and the root workspace
  builds both `shared` and `backend`. This needs one clear deployment topology.

- 🟡 **A5 — Hardcoded environment values in source.**
  `config/index.ts` defaults `FRONTEND_ORIGINS` to a specific personal Vercel
  URL, and `frontend/src/lib/api.ts` defaults production API base to
  `https://stellar-trust-backend.vercel.app`. These belong in env vars, not code.

### B. Security

- 🔴 **B1 — Previously exposed Supabase secret must be rotated.**
  Flagged repeatedly in `Memory.md`. Until rotated and moved to a secret
  manager, any Supabase integration is compromised. Do not enable Supabase until
  this is done.

- 🟠 **B2 — No real signing boundary.** `KmsSigner` is a stub that throws. There
  is no AWS/GCP KMS implementation, so there is no compliant way to sign in a
  real environment (ties into A1).

- 🟡 **B3 — Network-exposed endpoints are correct on auth, but rate limiting is
  a single global limiter.** Money/auth endpoints should have their own stricter
  limits (Rules.md §7). Minor for now, real before production.

### C. Persistence & data model

- 🔴 **C1 — Postgres repositories are unimplemented.** Migrations `0001`–`0004`
  define the schema (ledger, identity, KYC, payments, reconciliation, RLS,
  balancing trigger), but **no repository actually talks to Postgres**. Every
  `*Repository` is an `InMemory*` class. The system of record does not exist at
  runtime.

- 🟠 **C2 — No Redis-backed idempotency / job state.** `InMemoryIdempotencyStore`
  cannot dedupe across instances, so the "all mutations idempotent" golden rule
  is not actually enforced in a deployed multi-instance environment.

- 🟠 **C3 — Migrations never validated locally.** No Docker/psql on the dev
  machine, so `0001`–`0004` have only ever been read, not run. CI is claimed as
  authoritative but the DB path is unproven end-to-end.

### D. Smart contracts (deferred this phase)

- 🟠 **D1 — Contract not deployed to testnet.** `Phases.md` Phase 2 leaves the
  deploy + smoke-flow checkbox unchecked. No public contract ID exists.

- 🟠 **D2 — No `SorobanRpcEscrowGateway`.** Only `DeterministicEscrowGateway`
  exists, and `createEscrowGateway()` throws if `ESCROW_GATEWAY=soroban-rpc`.
  There is no real chain path.

- 🟡 **D3 — Contract tests are Windows-blocked.** `cargo test` fails inside
  Soroban macro deps on this machine; only CI/Linux can validate them.

### E. AI service (deferred this phase)

- 🟠 **E1 — AI service is not deployed and not wired.** `HttpKycRiskClient`
  points at `AI_SERVICE_URL` (default `localhost:8000`). In a deployed backend
  this call fails and (correctly) falls back to human review — but with
  auto-verify (§6) we bypass this entirely for now.

- 🟡 **E2 — Engines are placeholder heuristics.** `aggregate_kyc_risk` and
  `recommend_dispute` are simple weighted rules, explicitly labeled as
  placeholders. Fine for now; real models are a later phase.

### F. Frontend

- 🟠 **F1 — Frontend cannot complete any flow because backend auth fails (A1).**
  UI loads, health check passes, CORS is correct, but wallet sign-in dies at the
  SEP-10 challenge. Everything downstream (KYC, escrow, dashboard) is gated on a
  session it can never obtain in the deployed environment.

- 🟡 **F2 — Very dense single-line JSX.** `KycOnboarding.tsx` (and others) pack
  entire forms onto single lines. It builds, but it is hard to maintain and
  review. Candidate for cleanup during the frontend pass.

- 🟡 **F3 — Session in `sessionStorage` only.** Intentional (D27) but means a
  page refresh in a new tab logs the user out. Acceptable; noted.

### G. Repository structure & planning hygiene

- 🟠 **G1 — Scratch/junk file in repo root: `awsedrfgyhuji.md`.** Contains a
  previous agent's ad-hoc "verdict" notes. Its content is folded into this file
  (§3) and it should be deleted.

- 🟡 **G2 — Docs claim "Phase 2 complete" while the deployed product is
  non-functional.** `README.md` / `PRD.md` / `Memory.md` describe application
  completeness accurately, but a casual reader would assume a working product.
  This file is the corrective "ground truth" record.

- 🟡 **G3 — `frontend/` is not in the root npm workspace** (`package.json`
  workspaces = `shared`, `backend` only). Intentional per the separation
  principle, but it means there is no single root command to build the whole
  product; deployment topology must be explicit (see A4).

- 🟡 **G4 — Empty/near-empty dirs** (`backend/scripts/`) and duplicated
  `api/index.ts` files add noise. Clean up as part of the structure pass.

### H. Cross-cutting correctness

- 🟠 **H1 — Golden rules partially unenforceable at runtime.** Rules require
  idempotency, ledger-as-source-of-truth, reconciliation blocking, and audit
  logging. All are implemented **in code**, but because persistence is in-memory
  and the scheduler doesn't run in serverless, they are not actually guaranteed
  in the deployed environment.

---

## 3. Prior review notes (folded in from `awsedrfgyhuji.md`)

A previous review reached the same core conclusion and listed the remaining
work. Summarized (the original scratch file should be deleted):

- Do **not** present the current deployment as a working product demo — only as
  a UI/infra preview. The page loads and `/health` works, but a live SEP-10
  request returns **HTTP 500**.
- To make it real: implement the KMS signer + SEP-10 config; provision Postgres
  and implement real repositories (replace all `InMemory*`); provision Redis for
  idempotency/job state; deploy + wire the Soroban contract and replace the
  deterministic gateway; host the backend on a **persistent** runtime (Railway /
  Render / Fly.io / ECS / Cloud Run) so the reconciliation scheduler can run;
  deploy the AI service and set `AI_SERVICE_URL`; move all secrets into the host
  secret manager and rotate the exposed Supabase secret.
- Validation already passing: backend lint/typecheck/build, 29/29 backend tests,
  frontend build, 9/9 contract tests (CI), AI compile + Ruff. Failing/missing:
  live SEP-10, live DB persistence, live Soroban.

---

## 4. Root-cause analysis of the "demo doesn't work"

The failure is not one bug; it is three structural gaps stacked on top of each
other, in dependency order:

1. **Auth can't sign** (A1/B2) → no session token is ever issued.
2. Even if it could, **state doesn't persist** (A2/C1/C2) → sessions/orders
   evaporate between serverless requests.
3. Even with persistence, **the chain and AI dependencies aren't deployed**
   (D1/D2/E1) → money/escrow steps can't reach a real backend.

Fixing them out of order gives no visible progress. The plan in §5 fixes them in
the order that yields a working flow the earliest, while honoring the "frontend
+ backend first" decision.

---

## 5. Plan to production-level (structured, phased)

### Stage 1 — Make frontend + backend work end-to-end (current focus)

Goal: a real, clickable flow in a deployed environment, using stubs for chain +
AI and the 10-second KYC shortcut.

1. **Choose a persistent backend host** (Railway / Render / Fly.io). Serverless
   is the wrong shape for this backend (A3). Frontend stays on Vercel.
2. **Fix deployment topology** (A4): keep exactly one backend entrypoint. Remove
   the redundant one. Document the deploy in `infra/`.
3. **Provision Postgres + Redis** and implement the real repositories to replace
   every `InMemory*` (C1/C2). Start with auth + identity + KYC + payments +
   ledger + audit. Validate migrations `0001`–`0004` against the real DB (C3).
4. **Make auth work without KMS, safely** (A1). Options, in order of preference
   for this dev phase:
   - **(chosen)** Introduce a **testnet-only demo signer** that loads a Stellar
     secret from the host secret manager (not from code/repo), used *only* when
     `STELLAR_NETWORK=testnet` and an explicit `DEMO_MODE=true` flag is set.
     Keeps SEP-10 real, unblocks the flow, and is fenced off from production.
   - Alternative: implement the real `KmsSigner` now (bigger lift; this is the
     production path in Stage 3 regardless).
5. **Implement the 10-second auto-verify KYC** (see §6).
6. **Keep the deterministic escrow gateway** as the runtime path (already
   correct for dev), and **skip the external AI call** (deterministic fallback).
7. **Environment hygiene** (A5): move hardcoded origins/URLs to env vars.
8. **Repo cleanup** (G1/G4): delete `awsedrfgyhuji.md`, remove the duplicate
   entrypoint and empty dirs.

**Exit criteria for Stage 1:** From the deployed frontend a user can connect a
testnet wallet, sign in (SEP-10), submit KYC and become Verified after ~10s,
create and accept an order, run the escrow lifecycle through the deterministic
gateway, and see it all on the dashboard — and the data survives a backend
restart (because it's in Postgres/Redis now).

### Stage 2 — Reconciliation & correctness on the persistent runtime

- Run the reconciliation scheduler as a real worker (A3).
- Enforce idempotency via Redis across instances (C2).
- Prove balanced-ledger + zero-mismatch reconciliation against real Postgres.

### Stage 3 — Real signing, real chain

- Implement `KmsSigner` (AWS/GCP KMS) and retire the demo signer (B2/A1).
- Implement `SorobanRpcEscrowGateway`; deploy the escrow contract to testnet;
  store the contract ID in validated config; run the real lock→release flow
  (D1/D2).

### Stage 4 — Real AI + disputes

- Deploy the FastAPI AI service; wire `HttpKycRiskClient`/dispute engine; remove
  the auto-verify shortcut (E1/E2, and reverse §6).

### Stage 5 — Hardening for mainnet

- Rotate/secret-manage all credentials (B1), per-route rate limits (B3), RLS
  validation, security audit of contracts, observability, licensing — per
  `Phases.md` Phase 6.

---

## 6. Temporary design: KYC auto-verify after 10 seconds

**Intent:** during development, submitting KYC should smoothly lead to a
Verified profile without a manual compliance approval or a working AI service,
so escrow/dashboard flows are reachable.

**Guardrails (must hold):**
- Only active when `NODE_ENV !== "production"` **and** an explicit flag
  `KYC_AUTO_APPROVE=true` is set. Production must never auto-approve.
- Audit log records that approval was automatic and development-only.
- The decision engine and human-review queue remain in the code path so the
  shortcut can be removed by flipping one flag.

**Recommended implementation (persistence-friendly):**
- Add config: `KYC_AUTO_APPROVE` (bool) and `KYC_AUTO_APPROVE_DELAY_MS`
  (default `10000`).
- On `KycService.submit`, when auto-approve is on: set status to
  `UnderReview`, and stamp `autoApproveAt = now + delay` on the verification
  record. Do **not** rely on `setTimeout` (it won't survive a serverless/worker
  restart).
- On any read of identity/verification (`/api/auth/me`, KYC status), if
  `autoApproveAt` has passed and status is still `UnderReview`, transition it to
  `Verified` (and update the profile + audit). This is stateless and correct
  even across restarts.
- Frontend: after submit, show a "Verifying… (~10s)" state and poll
  `/api/auth/me` (or the verification) every ~2s until `Verified`, then route to
  `/dashboard`. `KycOnboarding.tsx` already refreshes the profile on submit; it
  needs a short poll loop.

**Reversal:** set `KYC_AUTO_APPROVE=false`. The real path (provider → AI risk →
decision engine → human review) is already implemented and takes over.

> **Note:** this requires the persistence work in Stage 1 to be meaningful; with
> in-memory stores the polled read may hit a different instance. Auto-verify and
> Postgres go in together.

---

## 7. Development shortcuts currently in effect (must reverse before production)

| # | Shortcut | Reverse by | Tracked issue |
|---|---|---|---|
| S1 | Deterministic escrow gateway instead of real Soroban | Implement `SorobanRpcEscrowGateway`, deploy contract | D1/D2 |
| S2 | AI risk/dispute call skipped (deterministic fallback) | Deploy AI service, wire client | E1 |
| S3 | KYC auto-verify after 10s | `KYC_AUTO_APPROVE=false`; real provider+AI+human path | §6 |
| S4 | Testnet demo signer (secret in host secret manager) instead of KMS | Implement `KmsSigner`, remove demo signer | A1/B2 |
| S5 | (until Stage 1 done) in-memory stores | Postgres/Redis repositories | A2/C1/C2 |

---

## 8. Immediate next actions (ordered)

1. Delete `awsedrfgyhuji.md` and resolve the duplicate backend entrypoint (A4/G1).
2. Move hardcoded origins/API URLs to env vars (A5).
3. Decide backend host (persistent, not serverless) and document it in `infra/`.
4. Provision Postgres + Redis; implement real repositories; validate migrations.
5. Add the testnet demo signer behind `DEMO_MODE` + testnet guard (unblock auth).
6. Implement KYC auto-verify (§6) with config flags + polling frontend.
7. End-to-end test the full flow on the deployed environment; confirm data
   survives a restart.
8. Update `Memory.md` (Current Focus + Changelog) to match this reality.

---

## 9. Changelog (this file)

| Date | Change |
|---|---|
| 2026-07-22 | Created development log. Full codebase audit: catalogued 25+ issues across deployment, security, persistence, contracts, AI, frontend, and repo hygiene. Root-caused the "demo doesn't work" (auth signer + in-memory state + undeployed chain/AI). Recorded current strategy (frontend+backend first; stub contract+AI; 10s KYC auto-verify) and a 5-stage plan to production. Folded in and marked for deletion the `awsedrfgyhuji.md` scratch notes. |


---

## 10. Implementation Log — Stage 1, batch 1 (2026-07-22)

This batch delivers the **code-only** parts of Stage 1 that unblock the
frontend + backend flow and are testable without provisioning infrastructure:
the **testnet demo signer**, the **10-second KYC auto-verify**, and **config
hygiene**. The persistence swap (Postgres/Redis) and host migration are the next
batch and require you to provision those services.

### 10.1 What changed (file by file)

**Shared contracts (`shared/`)**
- `src/types/index.ts`
  - Added optional `autoApproveAt?: string | null` to `KycApplicationResponse`
    (the ISO time at which a development submission auto-verifies).
  - Added new `KycStatusResponse { status, verification }` DTO for the polling
    endpoint.

**Backend config (`backend/src/config/index.ts`)**
- Added dev/demo flags, all env-driven and validated:
  - `DEMO_MODE` (bool) — unlocks the stable testnet demo signer.
  - `DEMO_SIGNER_SECRET` (Stellar `S…` seed, optional, testnet only) — provided
    via the host secret manager, never committed.
  - `KYC_AUTO_APPROVE` (bool) — enables the 10s auto-verify shortcut.
  - `KYC_AUTO_APPROVE_DELAY_MS` (default `10000`).
- Removed the hardcoded personal Vercel URL from the `FRONTEND_ORIGINS`
  default; it is now purely env-driven and defaults to empty (issue A5).

**Signer boundary (`backend/src/modules/stellar/signer.ts`)**
- Added `DemoEnvSigner`: loads a Stellar secret seed from the environment so the
  server's SEP-10 signing key is **stable across serverless instances /
  restarts** (the old `LocalStubSigner` generates a new random key per process,
  which breaks SEP-10 when the challenge and verify calls hit different
  instances). Fixes the immediate cause behind A1 for deployed **testnet demos**.
- `createSigner()` now returns `DemoEnvSigner` when `DEMO_MODE=true`,
  `DEMO_SIGNER_SECRET` is set, and `STELLAR_NETWORK=testnet` — even in
  staging/production `NODE_ENV`. On the public network it refuses (returns
  `UnavailableSigner`). Local dev still uses `LocalStubSigner`; real production
  still requires `KmsSigner` (unchanged).

**KYC service (`backend/src/modules/kyc/kyc.service.ts`)**
- Added `KycServiceOptions { autoApprove, autoApproveDelayMs }` (constructor arg,
  optional/defaulted so existing tests are unaffected).
- `submit()`: when auto-approve is on, it **skips the external AI call** entirely
  (no 3s timeout wait, no dependency on a deployed AI service), sets status to
  `under_review`, and stamps `autoApproveAt = now + delay`. The real
  provider → AI → decision-engine → human-review path is fully preserved in the
  `else` branch and audit logging is unchanged in meaning (audit action still
  reflects the **policy** decision, not the advisory).
- Added `getStatus(userId)` and a private `maybeAutoApprove(userId)` that
  **resolves the timer lazily on read** — no `setTimeout`, so it survives
  process/instance restarts. When the stamped time has passed it flips the
  verification + profile to `verified` and writes a `kyc.auto_verified` audit
  event tagged development-only.

**KYC routes (`backend/src/modules/kyc/kyc.routes.ts`)**
- Added `GET /api/kyc/status` (authenticated) → returns `KycStatusResponse` and
  triggers `maybeAutoApprove`. This is what the frontend polls.

**App wiring (`backend/src/app.ts`)**
- Passes `{ autoApprove: config.KYC_AUTO_APPROVE && !config.isProduction,
  autoApproveDelayMs: config.KYC_AUTO_APPROVE_DELAY_MS }` into `KycService`.
  **Auto-approve can never be active in production**, regardless of the flag.

**Frontend API client (`frontend/src/lib/api.ts`)**
- Added `api.kycStatus(accessToken)` → `GET /api/kyc/status`.

**Frontend onboarding (`frontend/src/features/kyc/KycOnboarding.tsx`)**
- After a submission that is pending auto-verify, it polls `api.kycStatus` every
  2s; when `verified` it refreshes the identity and routes to `/dashboard`.
- Added a "Verifying automatically… redirecting when complete" indicator on the
  result panel while the timer is pending.

**Env template (`backend/.env.example`)**
- Documented `DEMO_MODE`, `DEMO_SIGNER_SECRET`, `KYC_AUTO_APPROVE`,
  `KYC_AUTO_APPROVE_DELAY_MS`, and the now-empty `FRONTEND_ORIGINS` default.

**Repo hygiene**
- Deleted the scratch file `awsedrfgyhuji.md` (content preserved in §3).

### 10.2 Verification performed

- `shared`: `tsc` build passes.
- `backend`: `typecheck` passes; `vitest run` → **29/29 tests pass** (fixed a
  transient failure where the decision audit action had to keep reflecting the
  policy decision, not the advisory decision).
- `frontend`: `tsc --noEmit` passes against the rebuilt shared types.
- Runtime boot: backend starts with `KYC_AUTO_APPROVE=true`; `/health` → 200.
- Auto-verify end-to-end (in-memory smoke, then removed): `submit` →
  `under_review` with `autoApproveAt`; immediate read stays `under_review`;
  after the delay a read returns `verified`. **SMOKE PASS.**

### 10.3 How to run the smooth dev flow now

Backend (`backend/.env` or `.env.local`):
```
NODE_ENV=development
KYC_AUTO_APPROVE=true
KYC_AUTO_APPROVE_DELAY_MS=10000
```
Then connect a testnet wallet on the frontend, sign in (works locally via the
stub signer), submit KYC → it shows "Verifying…" and lands on `/dashboard`
after ~10s. No AI service or contract deployment required.

For a **deployed testnet demo** (single persistent instance recommended):
```
DEMO_MODE=true
STELLAR_NETWORK=testnet
DEMO_SIGNER_SECRET=<testnet S… seed, funded, from the host secret manager>
KYC_AUTO_APPROVE=true
```
> Caveat still open: with in-memory stores, a multi-instance deployment can lose
> the SEP-10 challenge / session / order between requests. This batch does not
> fix persistence — that is the next batch (Postgres/Redis + real repositories),
> which needs you to provision the databases. Until then, run the deployed demo
> on a **single** persistent instance.

### 10.4 Updated shortcut status (from §7)

| # | Shortcut | Status after this batch |
|---|---|---|
| S3 | KYC auto-verify after 10s | ✅ implemented (flag-gated, prod-safe, stateless) |
| S4 | Testnet demo signer instead of KMS | ✅ implemented (`DEMO_MODE`, testnet-guarded) |
| S1 | Deterministic escrow gateway | unchanged (still the dev path) |
| S2 | AI call skipped | ✅ now explicitly bypassed when auto-approve is on |
| S5 | In-memory stores | ⏳ next batch (needs Postgres/Redis provisioning) |

### 10.5 Next batch (blocked on your input)

1. **Provision Postgres + Redis** (or confirm Supabase + rotate the exposed
   secret). Then I implement the real repositories to replace all `InMemory*`
   and validate migrations `0001`–`0004`.
2. **Confirm the backend host** (Railway / Render / Fly.io recommended — the
   reconciliation scheduler needs a persistent process; Vercel serverless does
   not fit). Frontend stays on Vercel.
3. Resolve the duplicate serverless entrypoint (`api/index.ts` vs
   `backend/api/index.ts`) once the host is chosen, to avoid breaking your
   current deploy.

### 10.6 Changelog

| Date | Change |
|---|---|
| 2026-07-22 | Stage 1 batch 1 implemented: testnet `DemoEnvSigner` (DEMO_MODE), 10s KYC auto-verify (config-gated, stateless resolve-on-read, `GET /api/kyc/status`, frontend polling), shared `autoApproveAt` + `KycStatusResponse`, config hygiene (removed hardcoded origin). Backend 29/29 tests, frontend typecheck, and an auto-verify smoke all pass. Deleted `awsedrfgyhuji.md`. |
