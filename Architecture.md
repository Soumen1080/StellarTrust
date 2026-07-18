# StellarTrust — Architecture

> **Status:** Living document. Update on any structural, stack, or data-model change.
> **Last updated:** 2026-07-18

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
│ KMS / HSM   │◄─┤                            │  │ Redis + BullMQ (jobs, reconciliation,    │
│ (key sign)  │  └────────────────────────────┘  │ webhook processing, notifications)       │
└─────────────┘                                   └──────────────────────────────────────────┘
```

**Key principles**
- The blockchain is **not** the accounting system. The **double-entry ledger** in
  Postgres is the system of record; a reconciliation job asserts ledger ↔ chain.
- AI is **advisory**; humans gate money movement above thresholds.
- All secret keys live in **KMS/HSM**, never in DB or env.
- RWA is a peer module, not part of the escrow happy path.

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
├─ docs/                      # PRD, Architecture, Rules, Phases, Design, Memory
│
├─ frontend/                  # ── Next.js (App Router) + TS + Tailwind ──
│  ├─ src/
│  │  ├─ app/
│  │  │  ├─ (auth)/           # login, register, KYC
│  │  │  ├─ (dashboard)/      # buyer, seller, investor
│  │  │  ├─ escrow/
│  │  │  ├─ disputes/
│  │  │  ├─ rwa/
│  │  │  └─ admin/
│  │  ├─ components/
│  │  ├─ features/            # one folder per portion: kyc, payments,
│  │  │                       #   escrow, disputes, rwa, wallet
│  │  ├─ lib/                 # api client, wallet kit, hooks
│  │  └─ styles/
│  ├─ public/
│  ├─ .env.example
│  ├─ package.json            # frontend deps only
│  └─ tsconfig.json
│
├─ backend/                   # ── Node + Express + TS (modular monolith) ──
│  ├─ src/
│  │  ├─ modules/             # one self-contained folder per portion
│  │  │  ├─ auth/             #   SEP-10, sessions
│  │  │  ├─ kyc/              #   provider adapter + risk aggregation
│  │  │  ├─ payments/         #   orchestration + idempotency
│  │  │  ├─ ledger/           #   double-entry ledger (core)
│  │  │  ├─ liquidity/        #   routing over path payments/pools
│  │  │  ├─ escrow/           #   Soroban orchestration
│  │  │  ├─ disputes/         #   evidence + AI calls + human gate
│  │  │  ├─ rwa/              #   tokenization + investor payouts
│  │  │  └─ stellar/          #   SDK wrappers, anchors, reconciliation
│  │  │
│  │  │   # each module folder contains its own:
│  │  │   #   <module>.routes.ts · <module>.service.ts
│  │  │   #   <module>.repository.ts · <module>.types.ts · <module>.test.ts
│  │  │
│  │  ├─ middleware/          # auth, rate limit, idempotency, errors
│  │  ├─ jobs/                # BullMQ workers, reconciliation
│  │  ├─ db/                  # migrations, schema, queries
│  │  ├─ config/
│  │  └─ index.ts
│  ├─ tests/
│  ├─ .env.example
│  ├─ package.json            # backend deps only
│  └─ tsconfig.json
│
├─ ai/                        # ── Python + FastAPI AI Risk Service ──
│  ├─ app/
│  │  ├─ routers/             # /kyc-score, /dispute-recommend
│  │  ├─ engines/             # ocr, fraud, dispute, scoring
│  │  ├─ schemas/
│  │  └─ main.py
│  ├─ tests/
│  ├─ .env.example
│  └─ pyproject.toml          # AI deps only
│
├─ contracts/                 # ── Soroban (Rust) ──
│  ├─ escrow/                 # lock/release/refund
│  ├─ rwa_token/              # asset tokenization + payout
│  └─ Cargo.toml
│
├─ shared/                    # ── shared contracts of record ──
│  ├─ types/                  # cross-portion TS types (API DTOs)
│  ├─ constants/              # status enums, currency codes
│  ├─ validation/             # shared schemas (Zod)
│  └─ package.json
│
├─ infra/                     # ── docker, ci, deploy manifests, env templates ──
│
└─ README.md
```

**Why separate `package.json` per portion:** `frontend` and `backend` deploy
independently, scale independently, and must not share a dependency tree
(different runtimes/build tooling). `shared/` is the only code both may import,
and it holds contracts only (types/constants/validation) — no runtime logic,
no secrets. `ai/` and `contracts/` use their own language toolchains
(`pyproject.toml`, `Cargo.toml`) and are therefore naturally isolated.

---

## 5. Tech Stack

| Layer | Choice | Rationale |
|---|---|---|
| Frontend | Next.js (App Router) + TypeScript + Tailwind | Modern, typed, fast |
| Wallet | Stellar Wallets Kit (Freighter/xBull) | Multi-wallet, SEP-10 |
| Backend | Node.js + Express + TypeScript | Modular monolith |
| Database | **PostgreSQL via Supabase** | ACID, RLS, auth |
| Cache/Queue | Redis + BullMQ | Jobs, reconciliation, webhooks |
| AI service | Python + FastAPI | ML/OCR ecosystem |
| KYC/liveness | 3rd-party (Sumsub/Onfido/Persona/Veriff) | Compliance; don't build |
| Blockchain | Stellar SDK (JS) + Soroban RPC | Native |
| Contracts | Soroban (Rust) | Trustless escrow + RWA |
| Key mgmt | Cloud KMS / HSM | Secure signing |
| Infra | Docker + single cloud (AWS/Fly/Render) | Simple ops |
| Observability | Structured logs + metrics + tracing | Ops visibility |

---

## 6. Core Data Model (essentials)

- `users`, `businesses`, `kyc_verifications`
- `wallets` (stellar public key, custody_type)
- `orders` (buyer, seller, amount, currency, status)
- `escrows` (order_id, contract_id, state)
- `disputes` (escrow_id, evidence[], ai_recommendation, ai_confidence,
  human_decision, status)
- `ledger_accounts`, `ledger_entries` — **double-entry**; entries per
  transaction sum to zero
- `assets`, `tokenizations`, `token_holdings` — RWA
- `stellar_transactions` (hash, type, status) — reconciliation
- `webhook_events` — idempotency + signature-verified

**Rule:** every money movement writes balanced ledger entries **and** a Stellar
transaction record. A reconciliation job asserts they match.

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
