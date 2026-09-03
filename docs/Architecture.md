# StellarTrust — Architecture

> **Status:** Living document. Update on any structural, stack, or data-model change.
> **Last updated:** 2026-09-03
> **Verified against:** the repository tree, `package.json` files, the route
> tables in `backend/src/modules/*/*.routes.ts`, and
> `infra/supabase/migrations/` as of this date. Sections 3–6 describe what is
> **actually built**, not the target design; anything not yet built is marked
> *planned*.

---

## 1. Architectural Style

- **Full separation of portions.** `frontend/` and `backend/` are **separate,
  independently deployed folders/projects** (own `package.json`, own build, own
  env). `ai/`, `contracts/`, `shared/`, `infra/`, and `docs/` are each their own
  self-contained portion. Portions talk only over defined interfaces (REST APIs
  + shared type contracts), never by reaching into each other's internals.
- **Modular monolith** for the `backend` (Node + Express + TypeScript) with
  clear bounded contexts (one folder per portion). Avoid premature microservices.
- **Separately deployed AI Risk Service** (Python + FastAPI) — the ML/OCR
  ecosystem lives in Python and benefits from isolation and independent scaling.
- **Soroban smart contracts** (Rust) for trustless escrow and RWA tokenization.
- **Classic Stellar** for payments, liquidity, and asset issuance.
- **Anchors + SEP standards** for the fiat on/off ramp.

### Split of responsibilities on Stellar

| Capability | Mechanism |
|---|---|
| Cross-currency settlement | Classic **path payments** (`pathPaymentStrictSend/Receive`) |
| Liquidity | Classic **AMM liquidity pools** + DEX order book |
| Escrow lock/release/refund | **Soroban** contract |
| RWA tokens + transfer rules | **Soroban** (or classic asset + SEP-8 regulated assets) |
| Fiat on/off ramp | **Anchors** (SEP-31 B2B payments, SEP-24/6 deposit/withdraw) |
| Wallet auth | **SEP-10** |
| KYC data exchange with anchor | **SEP-12** |

---

## 2. Platform Flow

```
USER REGISTRATION
   → Email/Phone verification
   → KYC (3rd-party): ID + OCR + face match + liveness + AML/sanctions
   → AI KYC risk aggregation → Decision Engine (Approve/Review/Reject)
   → Verified user + business profile
   → Stellar wallet connect (SEP-10)

TRADE
   → Buyer creates purchase order → Seller accepts
   → Buyer deposits funds → Liquidity/Routing (path payments over pools)
   → Funds locked in Soroban escrow contract
   → Seller ships → uploads delivery evidence

RESOLUTION
   → Buyer confirms delivery?
        YES → Release payment to seller
        NO  → Open dispute (24h evidence window)
              → AI Risk Engine analysis (advisory)
              → Recommendation: Release | Refund | Manual Review
              → Human approves money movement above threshold
   → Stellar settlement completed → recorded in ledger + on-chain

RWA (opt-in, separate module)
   → Seller tokenizes asset (invoice/commodity/real estate)
   → Stellar asset issuance + token management
   → Investors buy fractional tokens → payout on buyer payment
   → Continuous monitoring & compliance
```

---

## 3. System Architecture (Components)

```
┌──────────────────────────── CLIENT (Next.js + TS + Tailwind) ────────────────────────────┐
│ Buyer / Seller / Investor dashboards · Escrow & Dispute UI · RWA UI · Admin console       │
│ Stellar Wallets Kit (Freighter/xBull) — SEP-10 auth + tx signing                          │
└───────────────────────────────────────────┬──────────────────────────────────────────────┘
                                            │ HTTPS REST + webhooks
┌───────────────────────────────────────────▼──────────────────────────────────────────────┐
│ API / BFF (Node + Express + TS)  — authN/Z · rate limiting · idempotency · validation      │
├──────────┬──────────┬──────────┬──────────┬──────────┬───────────────────────────────────┤
│ KYC/AML  │ Payments │ Escrow   │ Liquidity│ Dispute  │ RWA Tokenization                    │
│ module   │ +Ledger  │ (Soroban │ /Routing │ orchestr.│ module                              │
│          │ module   │ orchestr)│ module   │          │                                     │
└────┬─────┴────┬─────┴────┬─────┴────┬─────┴────┬─────┴──────────────┬────────────────────┘
     │          │          │          │          │                    │
     │     ┌────▼──────────▼──────────▼──────────▼────┐               │
     │     │        PostgreSQL (Supabase)             │               │
     │     │  users · businesses · kyc · wallets      │               │
     │     │  orders · escrows · disputes             │               │
     │     │  ledger_accounts · ledger_entries        │               │
     │     │  assets · tokenizations · holdings       │               │
     │     │  stellar_transactions · webhook_events   │               │
     │     └──────────────────────────────────────────┘               │
     │                                                                 │
┌────▼────────┐  ┌───────────────────────────┐  ┌─────────────────────▼───────────────────┐
│ 3rd-party   │  │ Stellar Network            │  │ AI Risk Service (Python + FastAPI)       │
│ KYC provider│  │ Horizon / Soroban RPC      │  │ doc/OCR verify · fraud scoring ·         │
│ (Sumsub/…)  │  │ path payments · AMM pools  │  │ dispute recommendation (ADVISORY ONLY)   │
└─────────────┘  │ Soroban escrow · issuance  │  └──────────────────────────────────────────┘
┌─────────────┐  │ Anchors (SEP-31/24/6/10/12)│  ┌──────────────────────────────────────────┐
│ KMS / HSM   │◄─┤                            │  │ In-process scheduler (reconciliation)    │
│ *planned*   │  └────────────────────────────┘  │ Redis is *planned*, not built            │
└─────────────┘                                   └──────────────────────────────────────────┘
```

**Key principles**
- The blockchain is **not** the accounting system. The **double-entry ledger** in
  Postgres is the system of record; a reconciliation job asserts ledger ↔ chain.
- Every lifecycle mutation is one financial transition linking the order state,
  balanced ledger transaction, Stellar transaction record, actor, and audit
  event. Reconciliation mismatches block subsequent order mutations.
- Every external system sits behind an adapter with **both** a deterministic
  local implementation and a real one, selected by config and refused outside
  development (`ESCROW_GATEWAY`, `RWA_GATEWAY`, `ANCHOR_GATEWAY`,
  `LIQUIDITY_GATEWAY`, `SIGNER_PROVIDER`, `KYC_RISK_ENGINE`).
- AI is **advisory**; humans gate money movement above thresholds.
- All signing goes through the `Signer` boundary. KMS/HSM is the production
  target; today only a local stub and a testnet demo signer are implemented.
- RWA is a peer module, not part of the escrow happy path.

### Who signs what (escrow)

The contract decides this, not the backend. `initialize`, `confirm_delivery`,
and `dispute` call the **acting party's** `require_auth()`, so the server
physically cannot sign them; `release` and `refund` call
`arbiter.require_auth()`, and the arbiter is the server.

```
lock · confirm · dispute                    release · refund
────────────────────────                    ────────────────
POST …/{step}/prepare  → unsigned XDR       POST …/{step}
   wallet signs in the browser                 server signs as arbiter
POST …/{step}/submit   → server submits,       submits, reads contract back
   reads the contract back, then posts
   the ledger entries
```

The party's own account is the transaction source, so one envelope signature
satisfies `require_auth()` — no separate auth-entry signing. The chain call
always settles **before** the ledger moves: a rejected transaction can never
leave the books claiming custody that does not exist.

`GET /api/payments/capabilities` publishes this split at runtime, so the
frontend never hard-codes a signing model and switching
`ESCROW_GATEWAY=deterministic → soroban-rpc` needs no frontend change.

---

## 4. Folder & File Structure

**Separation principle:** Every distinct portion of the system lives in its own
**self-contained top-level folder** with its own dependencies, config, and tests.
`frontend/` and `backend/` are fully separate projects (separate `package.json`,
separate deploy). `ai/` (Python), `contracts/` (Rust), `shared/` (contracts of
record), `infra/`, and `docs/` are likewise independent portions. They
communicate only over defined interfaces (REST APIs, shared type contracts) —
never by reaching into each other's internals.

```
stellartrust/
├─ docs/                      # PRD, Architecture, Rules, Phases, DESIGN, Memory,
│                             #   devlopement (development log / issue register)
│
├─ frontend/                  # ── Next.js (App Router) + TS + Tailwind ──
│  ├─ src/
│  │  ├─ app/                 # route segments (no route groups in use)
│  │  │  ├─ auth/  dashboard/  escrow/  disputes/
│  │  │  ├─ rwa/   settlement/ kyc/     admin/kyc/
│  │  │  ├─ layout.tsx · page.tsx
│  │  │  └─ globals.css       # design tokens live here + tailwind.config.ts
│  │  ├─ components/          # AppShell, Icon, StatusPill, IdentityProvider,
│  │  │                       #   AccountActionLink
│  │  ├─ features/            # one folder per portion: dashboard, disputes,
│  │  │                       #   escrow, kyc, rwa, settlement, wallet
│  │  └─ lib/                 # api.ts (typed client), wallet-auth.ts
│  ├─ tailwind.config.ts      # the canonical design tokens (see DESIGN.md)
│  ├─ package.json            # frontend deps only
│  └─ tsconfig.json
│
├─ backend/                   # ── Node + Express + TS (modular monolith) ──
│  ├─ api/index.ts            # the single serverless entrypoint
│  ├─ src/
│  │  ├─ modules/             # one self-contained folder per bounded context
│  │  │  ├─ auth/             #   SEP-10 challenges, opaque sessions, JWKS
│  │  │  ├─ identity/         #   users, businesses, wallets
│  │  │  ├─ kyc/              #   provider adapter + risk aggregation
│  │  │  ├─ payments/         #   order lifecycle + transition commit
│  │  │  ├─ ledger/           #   double-entry ledger (core)
│  │  │  ├─ escrow/           #   Soroban escrow gateway + address resolution
│  │  │  ├─ settlement/       #   corridors, routing, anchor + liquidity
│  │  │  ├─ disputes/         #   evidence + AI advisory + human gate
│  │  │  ├─ rwa/              #   tokenization + investor payouts
│  │  │  ├─ reputation/       #   advisory 0..1 prior for disputes
│  │  │  ├─ feedback/         #   public product feedback wall
│  │  │  ├─ audit/            #   append-only audit trail
│  │  │  └─ stellar/          #   SDK wrappers, signer, addresses, assets
│  │  │
│  │  │   # a module folder contains the subset it needs of:
│  │  │   #   <module>.routes.ts · <module>.service.ts · <module>.gateway.ts
│  │  │   #   <module>.repository.ts · pg-<module>.repository.ts
│  │  │   #   <module>.types.ts · <module>.test.ts
│  │  │
│  │  ├─ middleware/          # auth, authorization, idempotency, errors,
│  │  │                       #   metrics, requestId
│  │  ├─ jobs/                # reconciliation.job.ts (in-process scheduler)
│  │  ├─ lib/                 # logger, errors, metrics, alerts
│  │  ├─ db/                  # index.ts — pg Pool factory only
│  │  ├─ config/              # index.ts — the single validated env schema
│  │  ├─ app.ts               # composition root (all wiring lives here)
│  │  └─ index.ts             # long-lived server entrypoint
│  ├─ tests/                  # cross-module integration tests
│  ├─ package.json            # backend deps only
│  └─ tsconfig.json
│
├─ ai/                        # ── Python + FastAPI AI Risk Service ──
│  ├─ app/
│  │  ├─ routers/risk.py      # POST /kyc-score, POST /dispute-recommend
│  │  ├─ engines/__init__.py  # aggregate_kyc_risk, recommend_dispute
│  │  │                       #   (weighted-rule placeholders, not ML models)
│  │  ├─ schemas/
│  │  └─ main.py
│  ├─ tests/
│  └─ pyproject.toml          # AI deps only
│
├─ contracts/                 # ── Soroban (Rust) workspace ──
│  ├─ escrow/                 # lock/confirm/dispute/release/refund
│  ├─ rwa_token/              # asset tokenization + payout
│  ├─ scripts/                # deploy-testnet.ps1 (uploads WASM, prints hashes)
│  └─ Cargo.toml
│
├─ shared/                    # ── shared contracts of record ──
│  ├─ src/
│  │  ├─ types/               # cross-portion TS types (API DTOs)
│  │  ├─ constants/           # status enums, currency codes
│  │  ├─ validation/          # shared schemas (Zod)
│  │  └─ errors/              # error CODES only (classes live in backend)
│  ├─ dist/                   # built output; backend/frontend import from here
│  └─ package.json
│
├─ infra/
│  ├─ supabase/migrations/    # 0001–0015, forward-only
│  ├─ supabase/tests/         # SQL assertions (ledger balance, transitions)
│  ├─ docker/                 # backend/frontend/ai Dockerfiles
│  └─ docker-compose.yml
│
├─ .github/workflows/ci.yml
└─ README.md
```

**Notes on the tree**
- `shared/` source lives under `src/` and is consumed from `dist/`. Both
  frontend and backend depend on it as `file:../shared`, so a shared change
  needs `npm run build --prefix shared` before it is visible.
- There is no `liquidity/` module — path-payment and AMM routing live inside
  `settlement/` (`liquidity.gateway.ts`, `routing.service.ts`).
- Migrations live in `infra/`, not `backend/src/db/`, which holds only the
  connection pool.
- `app.ts` is the only place adapters are chosen and wired; modules never
  construct their own dependencies.

**Why separate `package.json` per portion:** `frontend` and `backend` deploy
independently, scale independently, and must not share a dependency tree
(different runtimes/build tooling). `shared/` is the only code both may import,
and it holds contracts only (types/constants/validation) — no runtime logic,
no secrets. `ai/` and `contracts/` use their own language toolchains
(`pyproject.toml`, `Cargo.toml`) and are therefore naturally isolated.

---

## 5. Tech Stack

Versions are the pinned ones in each `package.json` / `Cargo.toml`.

| Layer | Choice | Status | Rationale |
|---|---|---|---|
| Frontend | Next.js 15.5.20 (App Router) + React 19 + TS 5 + Tailwind | built | Modern, typed, fast |
| Wallet | `@creit.tech/stellar-wallets-kit` 2.5.0 | built | Multi-wallet, SEP-10, tx signing |
| Backend | Node.js + Express 5 + TypeScript | built | Modular monolith |
| Database | **PostgreSQL via Supabase**, `pg` 8 with raw parameterized SQL | built | ACID, RLS; no ORM magic |
| AI service | Python 3.12 + FastAPI | built, not deployed | ML/OCR ecosystem |
| Blockchain | `@stellar/stellar-sdk` 16.0.1 (Horizon + Soroban RPC) | built | Native |
| Contracts | Soroban `soroban-sdk` 27.0.2 (Rust) | built; WASM installed on testnet | Trustless escrow + RWA |
| Logging | `pino` + `pino-http` | built | Structured, PII-safe |
| Security | `helmet`, `express-rate-limit`, `jose` (JWKS) | built | Baseline hardening |
| Validation | `zod` 3.23.8 (shared schemas) | built | One schema, both portions |
| Observability | In-process Prometheus registry + `/metrics` + health probes | built | No extra dependency |
| Cache/Queue | Redis | **planned — not installed** | Cross-instance idempotency |
| KYC/liveness | 3rd-party (Sumsub/Onfido/Persona/Veriff) | **planned** — sandbox adapter today | Compliance; don't build |
| Key mgmt | Cloud KMS / HSM | **planned** — `KmsSigner` throws | Secure signing |
| Infra | Docker + Render (backend) / Vercel (frontend) | partial | Simple ops |

> Anything marked *planned* has an interface and a fail-closed factory in place,
> so adopting it is an adapter swap, not a refactor. Do not describe planned
> items as working in a demo or README.

---

## 6. Core Data Model (essentials)

Defined by the forward-only migrations in `infra/supabase/migrations/`:

| Migration | Adds |
|---|---|
| `0001` | Core schema: users, businesses, wallets, orders, escrows, disputes, `ledger_accounts`/`ledger_entries` + balancing trigger, `stellar_transactions`, enums |
| `0002` | Seeds the system ledger accounts |
| `0003` | Phase 1 identity: SEP-10 challenges, hashed sessions, KYC results, review queue, audit indexes, RLS |
| `0004` | Phase 2: `payment_transitions`, chain metadata, `reconciliation_mismatches`, DB-level fail-closed blocking |
| `0005` | Session roles + `users.latest_verification` snapshot |
| `0006` | Phase 5 RWA: assets, tokenizations, token_holdings, payout_distributions, payout_records, RWA ledger accounts, over-sell/auto-fund triggers, RLS |
| `0007` | Durable dispute persistence (`dispute_records`, DTO snapshot) |
| `0008` | On-chain escrow: `escrow_state` gains `pending`, `payment_transition` gains `dispute` |
| `0009` | Links a dispute to the custody it is about |
| `0010` | RWA issuer self-custody, including token-holding status |
| `0011` | Phase 3 durable settlement: `settlements`, `settlement_quotes`, `settlement_transitions`, `settlement_reconciliation_mismatches` |
| `0012` | Dispute parties (both sides of the claim) and the dispute log |
| `0013` | Phase 6 product feedback wall (`product_feedback`) |
| `0014` | **Repair** — re-applies `0011` + `0012` schema where those migrations never ran |
| `0015` | **Repair** — re-applies `0008`, `0009`, `0010` schema where those never ran |

The two repair migrations exist because a deployed database had drifted from the
migration history. They are idempotent: no-ops where the schema already exists.

Key tables:

- `users`, `businesses`, `wallets` (stellar public key, custody_type) — the
  wallet is the **only** sanctioned user-id → Stellar-address mapping, and it
  comes from a completed SEP-10 proof.
- `orders` (buyer, seller, amount, currency, status)
- `escrows` (order_id, contract_id, state) — `pending` means the custody
  contract is deployed but the buyer has not yet signed the lock.
- `payment_transitions` — immutable link between order step, actor, ledger tx,
  and chain tx
- `ledger_accounts`, `ledger_entries` — **double-entry**; entries per
  transaction sum to zero, enforced in the service *and* by a DB trigger
- `stellar_transactions` (hash, type, status) — reconciliation
- `reconciliation_mismatches` — open/resolved drift; open drift blocks the order
- `dispute_records`, `assets`, `tokenizations`, `token_holdings`,
  `payout_distributions`, `payout_records`

Settlement quote/transition persistence landed in `0011`. `webhook_events`
exists in the schema from `0001` but is not yet written by a
signature-verified webhook receiver — that receiver is *planned*.

**Rule:** every money movement writes balanced ledger entries **and** a Stellar
transaction record. A reconciliation job asserts they match — both that the
chain transaction succeeded, and that the escrow contract's own state and
recorded `order_ref` agree with the books.

### Persistence status

Repositories are selected in `app.ts` by `DATABASE_URL` (and never in tests):

| Context | Postgres | In-memory only |
|---|---|---|
| identity, auth, audit, ledger, payments, disputes, rwa, settlement, feedback | ✅ | |
| kyc, reputation | | ⚠️ |
| idempotency stores (all routers) | | ⚠️ per-instance |

The in-memory stores are correct for a single long-lived process and wrong for
a multi-instance deployment — an idempotency key deduped on one instance is
unknown to the next. Redis is the planned fix.

---

## 7. Security Architecture

- Secret keys in KMS/HSM; signing via a dedicated signer boundary.
- Escrow custody via Soroban contract (trustless) — release/refund authorized by
  backend oracle and/or multi-sig.
- PII encrypted at rest; RLS in Postgres; least privilege.
- Idempotency keys on all mutations.
- Webhook signature verification; replay protection.
- Full audit trail for money movement and AI/human decisions.
- Network-exposed endpoints require auth; no unauthenticated money endpoints.

---

## 8. Environments

- **Local:** Stellar testnet, provider sandboxes, docker-compose.
- **Staging:** testnet + sandbox providers, production-like config.
- **Production:** Stellar mainnet, live providers/anchors, KMS/HSM, licensing in
  place before real-money go-live.
