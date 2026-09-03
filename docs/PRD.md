# StellarTrust — Product Requirements Document (PRD)

> **Status:** Living document. Update on any scope, feature, or user change.
> **Track:** Production (real product for real users).
> **Last updated:** 2026-09-03
>
> This document describes the **product**, which has not changed. For what is
> actually built and verified, see `Memory.md` §1 and `devlopement.md` §0.

---

## 1. Overview

**StellarTrust** is an AI-powered cross-border escrow, liquidity settlement, and
Real-World Asset (RWA) tokenization platform built on the Stellar network.

It lets businesses and individuals send cross-border payments that settle in
near real-time and at low cost, protects both parties with smart-contract escrow,
resolves disputes with an AI risk engine (advisory, human-supervised), and lets
sellers unlock working capital by tokenizing real-world assets such as trade
invoices.

### One-line pitch
> Fast, secure, transparent global commerce: cross-border payments + escrow +
> AI dispute resolution + asset tokenization, all on Stellar.

---

## 2. Problem Statement

Cross-border B2B and P2P payments suffer from:

- **High fees** from correspondent banking and intermediaries.
- **Slow settlement** (days for international transfers).
- **Currency conversion delays** and poor FX rates.
- **Payment fraud & trust gaps** — buyers falsely claim non-delivery; sellers
  falsely claim shipment. Proof is weak on both sides.
- **Manual dispute resolution** that is slow, expensive, and inconsistent.
- **Cash-flow pressure** — sellers wait 30–90 days for buyer payment while
  capital is locked in unpaid invoices.

---

## 3. Solution — What We Build

Four tightly integrated capabilities on one platform:

### 3.1 Cross-Border Payments
Sender deposits in one currency; recipient receives another currency, settled
via Stellar **path payments** and **AMM liquidity pools**, with fiat on/off
ramps provided by **Anchors** (SEP-31/SEP-24/SEP-6). Near-instant, low-fee.

### 3.2 Secure Escrow Payments
Buyer funds are locked in a **Soroban escrow smart contract** until delivery is
confirmed. On confirmation → release to seller. On dispute → 24-hour evidence
window, then resolution.

### 3.3 AI-Assisted Dispute Resolution
The **AI Risk Engine** analyzes evidence (invoices, tracking, delivery OTP,
courier receipts, images), transaction history, reputation, and fraud signals.
It produces a **risk score + recommendation + explanation** (release / refund /
escalate). **The AI is advisory** — a human approves any money movement above a
configurable threshold.

### 3.4 Real-World Asset (RWA) Tokenization
Sellers can tokenize invoices, commodities, or real estate as Stellar assets.
Investors buy tokens; the seller receives cash immediately. When the buyer pays
through escrow, investors are paid out. Enables fractional ownership and faster
working capital.

> **Note:** RWA is a **separate, opt-in module**, not a step in every escrow
> flow.

---

## 4. Why Stellar

- Purpose-built for fast, low-cost cross-border payments.
- Native **asset issuance**, **trustlines**, **path payments**, **AMM liquidity
  pools**, and a built-in **DEX** — ideal for multi-currency settlement.
- **Anchors + SEP standards** (SEP-6/10/12/24/31) provide a real, standardized
  fiat on/off ramp and KYC exchange.
- **Soroban** smart contracts (Rust/WASM) for custom escrow and tokenization
  logic.
- Low fees and fast finality suit high-volume B2B settlement.

---

## 5. Target Users

| Segment | Description | Primary need |
|---|---|---|
| **SMEs in international trade** | Small/medium businesses importing/exporting | Cheap, fast, trusted cross-border payment |
| **Importers & Exporters** | Cross-border buyers and sellers | Escrow protection + FX settlement |
| **Manufacturers & Suppliers** | Selling goods globally | Payment assurance + working capital |
| **B2B Marketplaces** | Platforms needing built-in payment trust | Escrow + dispute API |
| **Logistics & Trade-Finance firms** | Need verifiable payment/delivery proof | Transparent verification |
| **Asset owners / Investors** | Want liquidity or yield | Tokenize / invest in RWAs |

### Personas

- **Priya — Exporter (Seller).** Ships goods internationally, waits 60 days for
  payment. Wants payment assurance and the option to tokenize invoices for
  instant cash.
- **Daniel — Importer (Buyer).** Buys goods abroad. Wants protection against
  paying for goods that never arrive, and cheap FX.
- **Maria — Compliance Officer.** Reviews KYC and escalated disputes. Needs
  auditable AI recommendations and clear human-override controls.
- **Arjun — Investor.** Buys tokenized invoices for yield. Needs transparent
  ownership and payout tracking.

---

## 6. Features (Functional Requirements)

### 6.1 Identity & Onboarding
- Email/phone verification.
- KYC/KYB via a regulated third-party provider (document + liveness + AML/
  sanctions screening).
- AI KYC **risk aggregation** (combines provider signals into a score).
- KYC decision: **Approve / Review / Reject** (human review on borderline).
- Verified user + business profile creation.
- Stellar wallet connect (Stellar Wallets Kit; Freighter, Albedo, xBull,
  Fordefi, Rabet) with SEP-10 auth.

### 6.2 Payments & Settlement
- Cross-currency payment via path payments.
- Liquidity/routing service (best rate + lowest fee + fastest path).
- Anchor integration (SEP-31/24/6) for fiat deposit/withdraw.
- Internal **double-entry ledger** for every money movement.
- Idempotent payment endpoints; webhook ingestion with signature verification.
- Reconciliation of ledger vs on-chain state.

### 6.3 Escrow
- Buyer creates purchase order; seller accepts.
- Buyer deposits into a Soroban escrow contract — one custody instance per
  order, deployed by the platform and funded by the buyer's own signature.
- States: `Pending → Locked → Released | Refunded | Disputed`.
  (`Pending` = custody contract deployed, buyer has not yet signed the lock.)
- Delivery evidence upload by seller.
- Buyer confirms delivery → release. Or either party opens a dispute.
- Steps the contract gates with a party's own authorization (lock, confirm
  delivery, dispute) are **signed in that party's wallet**, not by the platform.
  Release and refund are signed by the platform as the designated arbiter.

**Implementation status (2026-09-03):** The full escrow lifecycle is implemented
end to end, including the on-chain path: custody deploy, wallet-signed
lock/confirm/dispute, arbiter-signed release/refund, read-back verification
before any ledger posting, and ledger↔chain reconciliation that asserts on-chain
custody state. Postgres-backed when `DATABASE_URL` is set: payments, identity,
auth, audit, ledger, disputes, RWA, settlement, and feedback. Both contract
WASMs are installed on testnet and migrations `0001`–`0015` have been applied to
a deployed database (`0014`/`0015` are repairs for drift found there).
**Still outstanding before real funds:** production signing (`KmsSigner` throws),
cross-instance idempotency (Redis — the stores are in-memory), Postgres
repositories for kyc and reputation, and live anchor/liquidity adapters in place
of the sandbox and deterministic ones.

### 6.4 Dispute Resolution
- 24-hour evidence window for both parties.
- AI Risk Engine analysis → recommendation + confidence + explanation.
- Auto-resolve **only** below a monetary threshold and above a confidence
  threshold; otherwise route to human moderator.
- Full audit log of every decision (AI and human).

### 6.5 RWA Tokenization (opt-in module)
- Tokenize an asset (invoice/commodity/real estate) as a Stellar asset.
- Fractional ownership; investor purchase flow.
- Payout distribution to token holders when buyer pays.
- Ownership/transfer transparency and compliance controls.

### 6.6 Dashboards
- Buyer dashboard: orders, escrow status, disputes, payments.
- Seller dashboard: orders, evidence upload, payouts, tokenization.
- Investor dashboard: holdings, payouts.
- Admin/compliance console: KYC review, dispute review, audit logs.

---

## 7. Non-Functional Requirements

- **Consistency:** ACID for all financial records; ledger must always balance.
- **Security:** Secret keys in KMS/HSM; no keys in DB/env. RLS on data.
- **Auditability:** Immutable audit log for money movements and decisions.
- **Idempotency:** All payment/escrow mutations idempotent.
- **Availability:** Target 99.9% for API; graceful degradation if AI/anchor down.
- **Compliance:** KYC/AML, sanctions screening; money-transmitter/MSB licensing
  tracked (gates real-money go-live).
- **Observability:** Structured logs, metrics, tracing, alerting.
- **Performance:** Payment initiation p95 < 2s (excluding external anchor time).
- **Data protection:** PII encrypted at rest; least-privilege access.

---

## 8. Success Metrics (KPIs)

- Payment settlement time (median) vs traditional baseline.
- Effective fee per transaction.
- Escrow dispute rate and % auto-resolved correctly.
- KYC pass rate and time-to-verify.
- Fraud loss rate.
- RWA: capital advanced to sellers; investor payout accuracy.
- Reconciliation mismatch rate (target: 0 unresolved).

---

## 9. Out of Scope (for now)

- Becoming our own licensed anchor/bank (partner initially).
- Retail consumer payments app.
- Non-Stellar chains.
- Fully autonomous AI money decisions above threshold.

---

## 10. Assumptions & Dependencies

- Access to at least one Stellar anchor (or a controlled anchor) per corridor.
- Third-party KYC provider (Sumsub/Onfido/Persona/Veriff) sandbox → live.
- Cloud KMS/HSM availability.
- Legal/compliance guidance for target corridors and licensing.

---

## 11. Open Questions

- Initial launch corridors (e.g., USD↔INR, USD↔EUR)?
- Anchor partner(s) per corridor?
- Custody: Soroban-contract escrow only, or hybrid custodial for some flows?
- Auto-resolve thresholds (amount + confidence)?
