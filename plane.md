# StellarTrust — Industry-Grade Platform Plan

> **Purpose:** Turn StellarTrust from a feature demo into a platform that solves a
> real problem end to end. This file is the working checklist. Mark a box `[x]`
> only when the task is implemented **and** covered by a test that runs in CI.
>
> **Created:** 2026-09-03
> **Status legend:** `[ ]` not started · `[~]` in progress · `[x]` done (tested)
> **Severity:** 🔴 blocker (platform is not real without it) · 🟠 major · 🟡 polish
>
> **Decisions already made** live in §8 with their reasoning. Read it before
> proposing an alternative that was already weighed and set aside.

---

## 0. The diagnosis — why it currently reads as a demo

This plan is written against findings verified in the code on 2026-09-03, not
against impressions. Each is a specific, located defect.

| # | Finding | Where | Why it makes the platform a demo |
|---|---|---|---|
| D1 | **An investor purchase moves no money.** `purchaseUnits` creates a holding row and an audit entry. It never calls `LedgerService`. No debit from the investor, no credit to the issuer. | `rwa.service.ts` `purchaseUnits` | This is the whole point of tokenization — the seller gets cash early. Today units are given away and no one is charged. The issuer receives nothing. |
| D2 | **The payout pays out the wrong number.** On escrow release the *entire order amount* is distributed pro-rata to holders. | `payment.service.ts` `triggerRwaPayout` | Real invoice financing pays investors principal + agreed yield, and the balance goes to the seller. Paying 100% of the invoice to investors means the seller financed nothing and the platform earns nothing. |
| D3 | **Settlement is disconnected from escrow.** `SettlementDTO` has no `orderId`. | `shared/src/types` | A cross-border trade cannot actually be paid for through a corridor. The two headline features never touch. |
| D4 | **Disputes are invisible to RWA.** Zero references to dispute state in the RWA module. | `rwa.service.ts` | A disputed invoice still pays investors in full on release. Investors carry a risk nobody models. |
| D5 | **No maturity, default, or write-off.** A tokenization can never fail. | `TokenizationStatus` | Every real receivable can go late or bad. Without this there is no risk, so no genuine investment product. |
| D6 | ~~**No secondary transfer.** Explicitly refused.~~ **Closed by §3.3** — holders can top up and sell to each other. | `rwa.service.ts` `transferHolding` | Investors cannot exit before maturity. |
| D7 | **Asset valuation is self-asserted.** `valuationAmount` is typed by the issuer with no verification, no document, no lien check. | `AssetDTO` | Anyone can tokenize a $10M invoice that does not exist. This is the fraud surface a real platform exists to close. |
| D8 | **No investor protections at all** — no per-investor cap, no accreditation, no concentration limit, no cooling-off. | RWA module | Regulators require these; their absence is what makes it look like a toy. |

**One-line summary:** the *plumbing* (contracts, ledger, reconciliation, custody
modes) is genuinely well built. The *economics* are missing — nothing charges an
investor, nothing prices risk, and the four domains do not compose.

---

## 1. Domain model corrections (do these first — everything depends on them)

### 1.1 🔴 Make an investor purchase a real financial transaction
- [x] Add `RwaService.purchaseUnits` → `LedgerService.record()` posting:
      debit investor cash clearing, credit issuer proceeds, credit the
      investors' discount as a liability. Posted *before* any units move, so a
      failure hands out no ownership. `recordSubscriptionLedger` in
      `rwa.service.ts`.
- [x] Idempotency: the reference id is
      `rwa-subscription:{tokenizationId}:{investorId}:{units}` — derived from
      what caused the purchase, not a timestamp — so a retried click converges
      on one posting. A lost race recovers the existing id rather than failing.
- [x] Tests: balanced posting asserted via `isBalanced`; the discount split
      checked against exact minor units; separate investors charged separately;
      the audit entry carries the ledger transaction id so the trail leads to
      the money. (4 tests in `rwa.test.ts`.)
- [x] Reject a purchase when the investor's ledger balance is insufficient.
      Unblocked by §4.5: `purchaseUnits` now calls
      `LedgerService.assertSufficientFunds` after every other limit and
      immediately before the posting, so a refusal has moved no money.
- [ ] Make the whole purchase atomic: ledger post + holding row + on-chain
      transfer either all succeed or none do. Ordering now favours safety (money
      first, units second), but a chain failure after the posting still leaves a
      paid-for holding that never got its units — which the RWA reconciliation
      job reports rather than hiding.

### 1.2 🔴 Introduce the financing economics

**Model decided (2026-09-03): discount / factoring.** Investors buy a claim
below face value and are repaid at face value on collection; their yield *is*
the discount. Chosen because invoices are the default asset type and the
working-capital problem the PRD describes, and because a single collection
event maps exactly onto the existing escrow-release trigger — no new scheduler.

**Applies to all four asset types.** Commodity, real estate, and other are
tokenized as a single-maturity claim, which is a real structure (a dated
purchase obligation). The recurring-income alternative is deferred to §8.1 and
must not be described as supported until it is built.

Worked example — a 100,000 USDC invoice at net-90, 80% advance, 4% discount,
1% platform fee:

| Step | Amount | Note |
|---|---|---|
| Financed (80% of face) | 80,000 | what investors subscribe |
| Seller receives at funding | 76,800 | financed less the 4% discount |
| **On collection of 100,000** | | |
| 1 — investors | 83,200 | principal 80,000 + 4% yield |
| 2 — platform | 800 | 1% fee |
| 3 — seller residual | 16,000 | the retained 20% first-loss |
| | **100,000** | balanced |

Add to `TokenizationDTO`:
- [x] `faceValueAmount` / `faceValueCurrency` — what the debtor owes at maturity.
- [x] `advanceRateBps` — share of face value financed (8000 = 80%); the
      remainder is the seller's retained first-loss.
- [x] `discountRateBps` — the investor yield.
- [x] `platformFeeBps` — the platform's take.
- [x] `maturityDate` — when collection is due.
- [x] `collectedAt` — when it actually happened, so late yield accrues against
      the real date rather than read-time `now()`.
- [x] Derive `pricePerUnit` from `faceValue × advanceRate ÷ totalUnits`. The
      route no longer accepts a price at all; the server computes it.
- [x] Validation: `0 < advanceRate ≤ 100%`, maturity in the future at creation,
      rates in range, single currency (enforced by a DB check constraint too),
      and a **payability check** — terms whose advance + yield + fee exceed the
      face value are refused at creation, because such a deal is insolvent by
      construction.
- [x] Tests: 40 tests in `rwa.financing.test.ts` covering exact minor-unit
      arithmetic, the rounding direction, and every rejection path.
- [x] Migration `0016` adds the columns, backfills existing rows at a 100%
      advance with zero yield (economically identical to the old model, so no
      existing tokenization changes value), and adds the range/payability
      constraints.
- [x] Frontend: the tokenize form collects face value, advance %, yield % and
      maturity, and shows a live preview of what the issuer actually receives,
      the derived unit price, and the residual — computed with the same
      round-half-up rule the server uses.

### 1.3 🔴 Fix the payout waterfall
Replace "distribute the whole order amount" with an ordered waterfall:
- [x] The arithmetic: `splitCollection` in `rwa.financing.ts` implements the
      strict priority — investors (principal + accrued yield), then the
      platform fee, then the seller's residual.
- [x] Partial collection pays investors as far as it reaches and leaves the
      platform and seller nothing; the unpaid remainder is reported as
      `shortfall`, which is the input to the default path in §1.4.
- [x] Late payment accrues yield per day past maturity, taken from the seller's
      residual rather than the investors' return — lateness costs the seller.
- [x] `proRataShares` distributes a total across holders with a largest-
      remainder method, so the shares sum to *exactly* the total. A ledger
      transaction whose legs miss the total is rejected outright, so
      "close enough" is not available.
- [x] Tests: full, partial, late, zero-residual, and zero-collection cases, each
      asserting the legs reconstitute the collection exactly.
- [x] **Wired into `PaymentService.triggerRwaPayout`.** `distributePayout` now
      runs the collection through `splitCollection` before anyone is paid: only
      `investorTotal` is distributed pro-rata, and the ledger posts three legs
      (investors, platform fee, seller residual) against one debit of what was
      collected. Legs that round to zero are omitted, since the ledger schema
      rejects a zero-amount entry and a partial collection legitimately leaves
      the platform and seller nothing. Defect D2 is closed.
- [x] The on-chain drift check is handed `investorTotal`, not the gross
      collection: the contract knows unit balances, not the waterfall, so
      asking it to split the full amount would have compared our shares against
      a number they were never computed from and failed every payout as drift.
- [x] Note on the denominator: shares are pro-rata of `totalUnits`, so unsold
      units' share of the investor leg is simply not paid. The ledger credits
      the sum of the per-holder records rather than `investorTotal`, so the
      posting still balances exactly against what was collected.
- [x] Tests: the §1.2 worked example end to end (832,000 / 10,000 / 158,000 on
      a 1,000,000 collection), partial collection paying investors only, the
      repaid transition, and a collection too small to pay anyone. (4 tests in
      `rwa.test.ts`.)

### 1.4 🔴 Complete the tokenization lifecycle
- [x] Statuses `Matured`, `Defaulted`, `WrittenOff`, `Repaid` (plus
      `PayoutHeld` for §2.2) were already declared in the shared enum and the
      Postgres type by migration 0016, but nothing in the backend referenced
      them. They are now reachable states rather than documentation.
- [x] `RwaLifecycleJob` (`rwa.lifecycle.job.ts`) moves `Funded` → `Matured` at
      `maturityDate`, following the `ReconciliationJob` start/stop/run shape and
      registered in `app.ts`/`index.ts`. The clock is injected, so tests pin a
      date instead of waiting on timers.
- [x] Grace window, then `Matured` → `Defaulted`. Configurable via
      `RWA_DEFAULT_GRACE_DAYS` (default 30 — a credit-policy decision, not a
      code one). Entering default emits a `warning` alert with counts only, no
      ids or amounts (Rules.md §3).
- [x] `RwaService.writeOffTokenization` distributes recovery pro-rata and closes
      the position. Recovery is split pro-rata *only* — the waterfall's priority
      exists to pay the platform and seller out of a surplus, and a write-off is
      the case where none exists; charging a fee against recovered principal
      would invert the first-loss structure. Operator-initiated, because judging
      a debt unrecoverable is a credit decision, not a timeout.
- [x] Both transitions are idempotent (they select on status + clock), and a
      position with `collectedAt` set is never matured — the payout owns it.
- [x] Both transitions are published on the event spine as
      `tokenization.matured` / `tokenization.defaulted` (§2.3). These types were
      declared in the event vocabulary from the start — §2.3 named
      `tokenization.matured` as a motivating example — and were published by
      nothing, which left the lifecycle as the one domain that changed state
      silently while every other announced its transitions. Payload carries
      dates, the grace window applied, and the linked order id only: no holder
      identities, no amounts (Rules.md §3). A spine failure is logged, not
      thrown — the status change has already committed, and derailing the sweep
      would strand every remaining position in the run.
- [x] Interaction with §2.2 checked: the sweep selects only `Funded`/`Matured`,
      so a position held under `PayoutHeld` for an open dispute is skipped
      rather than maturing underneath the hold.
- [x] Tests: each transition, the grace boundary held and crossed, idempotency,
      a collected position ignored, the refused paths (write-off before default,
      write-off without the compliance role), both events published with the
      right actor and payload, no PII in the payload, exactly one fact per
      transition across repeated sweeps, and the transition still applying when
      the spine is down. (15 tests in `rwa.lifecycle.test.ts`.)

---

## 2. Cross-domain synchronization (the "make it compose" work)

### 2.1 🔴 Link settlement to escrow orders
- [x] `orderId: string | null` on `SettlementDTO`, plus migration `0017`. The
      column carries a FK to `orders` and a **partial** unique index, so the
      ordinary settlement (no order) is unconstrained while a second attempt to
      fund an already-funded order fails at the database rather than on a read.
- [x] `POST /api/settlement` accepts an optional `orderId`; on completion it
      publishes `settlement.completed`, and the `payments.deposit-on-settlement`
      subscriber drives the order's `Deposit`. The buyer pays the corridor once
      instead of paying the corridor and then the escrow.
- [x] The credited amount must equal the order amount **exactly**, checked
      before the first leg runs — a corridor that has already moved money and
      only then discovers it cannot fund the order has left the user paying for
      nothing. Currency mismatch, non-buyer, unknown order, and already-funded
      are all refused at the same point.
- [ ] One ledger transaction spanning both legs. Not done: the settlement legs
      and the escrow deposit still post as separate transactions. Spanning them
      needs a cross-module transaction boundary that does not exist yet, and
      forcing one through the event handler would make the deposit roll back a
      completed corridor payout. Deferred with §4.2/§4.3, where the transaction
      boundary work belongs.
- [x] Tests: the full corridor-funded order (accepted → deposited with no second
      payment), the link recorded both ways, an ordinary orderless settlement
      untouched, and five refusal paths each asserting no settlement was created.
      (8 tests in `settlement-order.test.ts`.)

### 2.2 🔴 Make disputes gate RWA payouts
- [x] `distributePayout` refuses on **two** independent checks: the durable
      `PayoutHeld` status (survives a restart) and a live `DisputeReader` read
      (catches the window where a dispute was filed but its event has not been
      handled). Either alone leaves a gap through which money reaches investors
      who may have to give it back.
- [x] `dispute.opened` flips a linked `Active`/`Funded` tokenization to
      `PayoutHeld`. Notification is left to §3's holder-comms work; the status is
      what the holder sees and what the payout refuses on.
- [x] Resolved for the buyer (refund) → `Defaulted`, which routes into the §1.4
      write-off/recovery path rather than paying a waterfall on money that went
      back to the buyer.
- [x] Resolved for the seller → the hold lifts to `Funded` and the payout
      resumes. Note the real sequence: resolving for the seller auto-executes the
      release, so the position passes through `Funded` and lands on `Repaid` in
      one go — `Funded` is a state it transits, not one it rests in.
- [x] Tests: all three outcomes plus the acceptance condition — a full
      dispute-and-refund cycle distributing **zero** payouts. (7 tests in
      `cross-domain.test.ts`, wired with real services exactly as `app.ts` does.)

### 2.3 🟠 One event spine across the four domains
- [x] `domain_events` (append-only, unique `dedupe_key`) and
      `domain_event_handled` (unique on `(event_id, handler)`) in migration
      `0017`, with in-memory and Postgres repositories. Both idempotency
      guarantees live in the **database**, not a convention: two API instances
      racing the same publish or handler are settled by a unique index, which is
      what Golden Rule #4 actually asks for.
- [x] Event types and dedupe-key construction are centralised in
      `event.types.ts` — a hand-typed event string is a subscriber that silently
      never fires.
- [x] `PaymentService.triggerRwaPayout` is superseded. Payments publishes
      `order.released`; RWA subscribes. Payments no longer imports RWA to react
      to its own state change. The old direct call is retained only as a
      fallback for constructions built without a bus, and is marked deprecated.
- [x] Handlers claim **before** running, retry with exponential backoff, and a
      handler that exhausts its attempts is recorded and counted in
      `domain_event_handlers_total{result="failed"}` rather than thrown back at
      a publisher whose own work already succeeded. The claim-then-run ordering
      is deliberate: between "possibly skipped, visibly" and "possibly
      duplicated, silently", only the first is safe when the handler moves money.
- [x] A durable re-dispatch loop for events whose handler never ran is **not**
      built — that is a queue, and belongs with the infrastructure work. The
      schema is shaped for it (`domain_events` left-joined against
      `domain_event_handled`).
- [x] Tests: the replay guarantee at both levels — a redelivered event runs a
      handler once (12 tests in `event.test.ts`), and a redelivered
      `order.released` distributes exactly one payout through the real wiring
      (`cross-domain.test.ts`).

### 2.4 🟠 Unified position view
- [x] `GET /api/positions` returns the caller's orders, settlements, disputes,
      and holdings, plus a `links` block keyed by order id. The links are the
      point: which settlement funded which order, which tokenizations that
      order's release pays out. Those are joins the client cannot compute from
      the four list endpoints. Caller-scoped with no compliance variant — a
      single endpoint returning any user's whole financial position would be a
      wider grant than any individual domain intends.
- [x] Frontend `LinkedPositions` on the dashboard renders only orders that
      actually reach into another domain; unlinked ones are already in the
      orders table above, and repeating them would bury the linked ones.
- [x] Tests: 4 in `positions.test.ts` covering the link assembly, an unlinked
      order, and per-order isolation when a user holds several.

---

## 3. Making the RWA section a real tokenization product

### 3.1 🔴 Asset verification before tokenization
- [x] `documents` on `AssetDTO` — opaque references only (`docRef`, `docType`,
      a hex SHA-256, `uploadedAt`). The digest is what makes a document swapped
      after approval detectable. Attachable over several calls before review
      and frozen once a decision lands: adding evidence to an approved asset
      would change what was approved without anyone re-reading it.
- [x] Workflow `Unverified → UnderReview → Verified | Rejected`
      (`AssetVerificationStatus`, migration `0018`). Only `Verified` may be
      tokenized, and the gate is in `createTokenization` rather than at
      purchase — an unverified deal never reaches an investor at all, so there
      is no window in which one can subscribe to something that later proves to
      have no evidence behind it. Submitting requires ≥1 document, and a
      counterparty when the asset is an invoice; deciding requires the
      `compliance` role (the issuer included — self-verification is the gate's
      whole failure mode) and a stated reason on a rejection.
- [x] Double-pledge guard matching `assetRef` **across owners**. That is the
      point: the unique constraint on `(owner_user_id, asset_ref)` cannot see
      the same receivable filed under a second account, which is how the fraud
      is actually done. Checked at verification *and* again at tokenization,
      because a competing pledge can be filed in between. `LIVE_PLEDGE_STATUSES`
      names which statuses constitute an outstanding claim — `Repaid`,
      `Distributed`, `Cancelled` and `WrittenOff` are finished, so the
      receivable is legitimately financeable again.
- [x] Counterparty recorded (`ref`, `name`, advisory `reputationScore`) and
      scored at verification through a narrow `CounterpartyReputationReader`
      port. Advisory only, never a gate: a counterparty with no history scores
      null, and refusing those would exclude exactly the new sellers the
      platform exists to finance. A scoring outage logs and leaves the score
      unset rather than blocking a decision that is otherwise ready.
- [x] Tests: both acceptance conditions (unverified refused, double-pledge
      refused) plus the whole workflow, the review queue, the audit trail
      carrying document *references* and never contents, and the conflicting
      tokenization id withheld from the competing issuer while compliance sees
      it in the audit row. (24 tests in `rwa.verification.test.ts`.)
- [x] Existing assets backfill as `unverified`, not grandfathered as verified —
      nothing has ever been reviewed, and a migration should not assert
      otherwise. An already-tokenized asset therefore reads unverified while
      its tokenization keeps running untouched; the gate is at creation, so no
      live position is stranded.

### 3.2 🟠 Investor protection and compliance
- [x] KYC checked in the RWA path via a narrow `InvestorKycReader` port, at
      `purchaseUnits` rather than trusted from onboarding — the purchase is the
      money-moving step and the only place that can refuse.
- [x] Per-investor concentration limit (`RWA_MAX_CONCENTRATION_BPS`, default
      2500). Compared by cross-multiplication rather than division, so a limit
      like 33.33% applies exactly instead of rounding in the investor's favour.
- [x] Per-investor exposure cap across all tokenizations
      (`RWA_MAX_INVESTOR_EXPOSURE`); zero disables it.
- [x] Minimum ticket (`RWA_MIN_TICKET_AMOUNT`) and unit granularity
      (`RWA_UNIT_GRANULARITY`). All the arithmetic is `bigint`: a cap computed
      in floating point is a cap that rounding can step over.
- [x] Cooling-off window (`RWA_COOLING_OFF_HOURS`, default 24).
      `cancelPurchase` posts a **reversing** ledger transaction rather than
      deleting the original — the ledger is append-only and is the system of
      record (Golden Rule #1), so an unwound subscription is two facts, not the
      absence of one. The two net to zero on every account they touch.
- [x] **Constraint discovered while building it:** the token contract's
      `transfer` calls `from.require_auth()`, so units already delivered to an
      investor can only be moved back by that investor — no custody mode gives
      the platform their key. A cancellation is therefore refused once a
      holding is `Settled`, which under platform custody is immediate. The
      window is genuinely exitable under issuer custody, where delivery waits
      for the issuer's signature. The honest exit for a delivered position is
      §3.3, not a refund this side cannot enforce.
- [x] Every limit runs *before* the ledger posting, so a refused purchase has
      moved no money and left nothing to unwind.
- [x] Limits default to `UNRESTRICTED_INVESTOR_LIMITS` when not wired.
      Deliberate: a construction that forgot to pass them keeps its old
      behaviour and its tests keep meaning what they meant, while `app.ts` — the
      only wiring facing real users — passes the configured ones. Defaulting to
      the strict production numbers would silently change what a dozen existing
      tests assert about arithmetic unrelated to §3.2.
- [x] Tests: each limit at its boundary — exactly at the cap allowed, one over
      refused — plus the non-dividing concentration case, per-investor rather
      than aggregate scoping, the reversal netting to zero, both ends of the
      cooling-off window, and the settled-units refusal.
      (25 tests in `rwa.protection.test.ts`.)
- [x] Insufficient-funds check at purchase, and on the secondary market's
      buyer. Unblocked by §4.5; runs last of the limits, before the posting.

### 3.3 🟠 Secondary market (replaces the D6 refusal)
- [x] An existing holder can add to their position. `purchaseUnits` used to
      refuse outright ("Secondary purchases not yet supported"); it now
      increases the existing row, since the holding is unique on
      `(tokenization, holder)`. A top-up into a *different* address is still
      refused — the row is also unique on `(tokenization, address)` and the
      on-chain balance lives at one account, so allowing it would split a
      position the record claims is one.
- [x] **The ledger reference had to change with it.** It keyed on the units
      being bought, so "buy 10, then buy 10 more" produced the same
      `rwa-subscription:{tok}:{investor}:10` reference — and the conflict path
      would have recovered the first posting and handed over the second 10
      units free. It now keys on the *resulting* total, which keeps each step
      distinct while a retry of any step still converges.
- [x] Concentration is measured on the **resulting** position, not the
      increment. Otherwise an investor walks past the cap in small steps, which
      is the one thing a concentration cap exists to stop.
- [x] `RwaService.transferHolding` — holder-to-holder sale at a price the
      parties agree. Not derived from the financing terms: an invoice near
      maturity is worth more than one just issued, and a disputed one less. The
      platform records the trade; it does not price it.
- [x] Honours the authorization allowlist (checked via `gateway.isAuthorized`
      *before* any money moves, since the contract would reject the transfer
      anyway) and the frozen flag. Also refuses a sale of undelivered units, a
      sale to oneself, and a sale once the position is paying out, held under
      dispute, or collected — units changing hands around a distribution makes
      it ambiguous who the payout belongs to.
- [x] The buyer is subject to the full §3.2 protection set. A secondary market
      that skipped it would be the way around every limit the platform has.
- [x] Ledger posts both legs through a new `rwa_secondary_seller_payable`
      account (migration `0019`), deliberately *not*
      `rwa_issuer_proceeds_payable`: the issuer is not party to the trade, and
      crediting them would overstate what the platform owes them. Cost basis
      moves with the units pro-rata, so the seller's remainder is not
      overstated and the buyer's basis is what they actually paid.
- [x] **On-chain leg is the seller's to sign, and that is the contract's rule
      not a choice.** `transfer` calls `from.require_auth()`, so the platform
      can only move units it is itself the `from` for — which it never is on a
      holder-to-holder trade. Same constraint §3.2 hit on cooling-off. The
      records are the platform's account of the trade and the reconciliation
      job surfaces a chain that has not caught up.
- [x] **Bug found and fixed while building this.** `InMemoryRwaRepository`
      *accumulated* `units_sold` on insert while the 0006 `sync_units_sold`
      trigger *recomputes* it from the surviving rows. Invisible until units
      could move between holders — a secondary trade issues nothing, so the
      sold total must not change, but the in-memory adapter counted the same
      units twice. It also meant the §3.2 cooling-off cancellation would have
      drifted `units_sold` differently under Postgres than in every test. Both
      now recompute (Rules.md §2: a deterministic adapter must behave exactly
      as the real one).
- [x] Tests: both acceptance conditions (unauthorized holder refused, frozen
      token refused) plus top-up arithmetic, the reference-id collision, basis
      apportionment, `units_sold` staying put across a trade, and every
      refusal. (24 tests in `rwa.secondary.test.ts`.)

### 3.4 🟠 Risk surfacing in the UI
- [x] `TokenizationRiskDTO` computed server-side and carried on **both** the
      details response and the *list* response, keyed by id. On the list
      because the marketplace renders every open deal at once, and a detail
      fetch per card is how a risk disclosure ends up quietly dropped for being
      slow. Keyed rather than positional so a client that filters or reorders
      cannot pair a card with another deal's risk.
- [x] Every card shows advance rate, yield, maturity, days remaining, issuer
      reputation, projected yield, and the debtor — plus loud banners for the
      two states that change the decision: disputed and overdue.
      `daysRemaining` is deliberately **signed**; `daysBetween` floors at zero,
      which would erase exactly the overdue case the field exists to surface.
- [x] The dispute read is live rather than inferred from `PayoutHeld`, which is
      only set once the dispute event has been handled — an investor about to
      buy needs to know about a dispute filed a moment ago. A reader outage
      falls back to the durable status rather than failing the marketplace; the
      payout path keeps its own two independent checks (§2.2).
- [x] Risk disclosure before the confirm step: entering an amount opens the
      disclosure and only a second click buys. Blunt about how the money does
      not come back — a disclosure listing only upside is marketing.
- [x] Portfolio carries accrued yield, overdue count, and realized loss per
      position and in total. Accrual stops once a position has paid out (the
      payout record is then the truth, and continuing to accrue double-counts),
      and a loss is realized only on write-off — while open, a shortfall is a
      risk, not a loss.
- [x] **Bug found and fixed while building this.** `writeOffTokenization`
      posted the recovery to the ledger but created **no distribution and no
      payout records**. The ledger knew the platform owed 30,000 and nothing
      recorded which holders it was owed to — so "invested less received"
      reported the *whole* investment as lost even when most of it had come
      back. The pro-rata shares were already computed to split the posting;
      they simply were not written down.
- [x] Tests: 15 in `rwa.risk.test.ts` covering the terms, the signed
      days-remaining, overdue vs. collected-late, the live dispute read and its
      outage fallback, accrual stopping at payout, loss realized only on
      write-off, recovery netted against it, and payouts attributed to the
      position that earned them.

---

## 4. Platform-wide industrial concerns

### 4.1 🔴 Cross-instance idempotency (the standing Golden Rule #4 hole)
- [x] Redis-backed `IdempotencyStore` (`RedisIdempotencyStore`), chosen by
      `createIdempotencyStore` when `REDIS_URL` is set.
- [x] `RedisRateLimitStore` for express-rate-limit, so a 300/minute limit is
      300/minute across instances rather than per-process. It fails **open**
      when Redis is unreachable — the one place in the platform where that is
      right, since the limiter guards against abuse and not against incorrect
      money movement.
- [x] The constraint is announced at boot rather than removed: without
      `REDIS_URL` the in-memory stores are used and the log says
      "SINGLE INSTANCE ONLY". Failing closed would mean an operator who has not
      provisioned Redis cannot run the platform, trading a known limitation for
      an outage.
- [x] **Two bugs found while wiring it.** Every router constructed its *own*
      idempotency store, so a retry was only recognised by the route group that
      first served it; they now take an injected store. And the middleware
      stored every response including failures, which makes a transient 5xx
      permanent for that key — only 2xx is stored now.
- [x] Tests: two store objects over one fake Redis, which is the real topology
      (separate processes, shared backing store). 13 tests in
      `idempotency.redis.test.ts`.

### 4.2 🔴 Remaining persistence gaps
- [x] `PgKycRepository` (migration 0022). KYC gates an investor purchase
      (§3.2), so an in-memory store meant a deploy silently reset every user to
      unverified *and* re-opened every review a compliance officer had closed,
      inviting a second decision on a settled case. `resolveReview` selects on
      `status = 'queued'` rather than read-then-write: two officers opening the
      same case is ordinary, and the predicate is what stops the second
      decision overwriting the first.
- [x] `PgReputationRepository`. Counters only — the score stays derived, so the
      formula can change without a migration and without two historical scores
      meaning different things. The upsert is last-writer-wins and can lose an
      increment under concurrency; deliberate and documented, because
      reputation is advisory and never gates money, and an exact interface
      would be one the in-memory adapter could not mirror (Rules.md §2).

### 4.3 🟠 Money-safety invariants at the database layer
All in migration `0020`. Each is already checked in application code; they are
restated in the database because an application check protects against the code
paths someone thought of, and a database check protects against the ones they
did not — a future migration, a manual fix in a console at 3am, a second
service written against the same tables.
- [x] `units_sold <= total_units` — verified present by a `do $$` block that
      re-establishes it if the repair migrations dropped it, rather than
      trusting a human to remember to grep for it.
- [x] A holding cannot exceed the tokenization's supply, as a trigger, since a
      per-row check cannot see across tables. 0006 already refused
      over-subscription *on insert*; this is the narrower structural claim,
      which a bad UPDATE would otherwise walk straight past.
- [x] Payout records per tokenization cannot exceed the collectible face value.
      DEFERRED, so it fires at COMMIT with the full sum — a check firing on the
      first row of a multi-holder payout would judge the total against a
      partial one. Face value is the right ceiling because `payout_records`
      holds only the *investor* leg, and §1.2's payability check already
      refuses terms whose advance + yield + fee exceed face value.
- [x] `infra/supabase/tests/money_invariants_test.sql`, run in CI against a
      real Postgres. Every block asserts a **refusal** — a test that only
      proved the happy path would prove nothing about a constraint whose whole
      job is to say no — plus one asserting that a payout *within* the ceiling
      is accepted, since a constraint refusing legitimate distributions is a
      failure found only when a real payout cannot be recorded.

### 4.4 🟠 Observability that matches the domain
- [x] `AdminService.businessMetrics` computes total value locked, capital
      deployed, positions by state, default rate, dispute rate, average
      days-to-collect and overdue positions. Two decisions worth keeping:
      amounts are **per currency, never summed** (a cross-currency total needs
      an FX rate the platform does not have, and a number that silently assumes
      1 USD = 1 EUR is worse than no number), and the default rate is computed
      over **resolved positions only** — counting still-running ones as
      successes flatters a young book, and an operator making a credit decision
      on that number is misled by their own dashboard.
- [x] `BusinessMetricsJob` sweeps the same numbers on a schedule and publishes
      them as gauges *and* through the alert sink. Alerts fire on a **crossing**
      and clear on recovery rather than repeating every sweep — a rate above
      threshold for a week is one incident, and re-paging is how an operator
      learns to mute the channel. The default rate is not believed until enough
      positions have resolved (one default out of one is 100% and no evidence).
      Overdue positions get their own warning, as the leading indicator that a
      person can still act on.
- [x] Alerts carry **rates and counts only**, never amounts or identities
      (Rules.md §3) — an alerting pipeline fans out to pagers, chat, and
      third-party incident tools. A test asserts every context value is a
      number and that no id or amount appears in a serialized alert.
- [x] Tests: 12 in `business-metrics.job.test.ts`.

### 4.5 🔴 Per-user ledger accounts — **done**

Discovered while wiring §1.1. Every ledger posting in the platform lands on
*system* accounts (`rwa_investor_cash_clearing`, `escrow_holding`, …). There is
no per-user account, so there is no such thing as "this investor's balance" to
check against — which is why the insufficient-funds check in §1.1 could not be
written.

This is a structural gap, not an RWA one: the same absence means no user has a
statement, and no balance can be proven without scanning transitions.

- [x] Per-user accounts keyed on `owner_ref = user:<id>`, named `user_cash`,
      created on demand per currency (migration `0020`). Typed `liability` and
      constrained to be one: the balance is what the platform *owes* the user,
      so spending debits it, and an account typed `asset` would read with the
      sign inverted — an overdrawn user would look funded.
- [x] `ledger_account_balances`, a **view**. Deliberately not a stored column:
      a stored balance is a second copy of what the entries already say, and
      the two drift the moment a write path forgets to update it — which is the
      class of bug double-entry exists to make impossible.
- [x] Five postings moved off shared clearing accounts onto the user's own:
      subscription, its cooling-off reversal, both sides of a secondary trade,
      and the payout — which now credits **each holder individually** rather
      than a lump to `rwa_payout_payable`. That makes the ledger agree with
      `payout_records` by construction instead of by cross-referencing two
      tables. The write-off recovery does the same.
- [x] Insufficient-funds checks on subscription (§1.1), the secondary market's
      buyer (§3.3), and withdrawal.
- [x] `GET /api/treasury/balances`. Served from treasury rather than the ledger
      router because treasury is what puts money in them.
- [x] Tests: 15 in `user-accounts.test.ts` — a balance reflects postings, an
      overdraw is refused at exactly one minor unit over, a balance in one
      currency cannot fund a purchase in another, and the two address spaces
      (system UUID, user reference) cannot collide.

**Discovered while building it: §4.5 gives users a balance but no way to hold
anything**, which would leave the new check refusing every purchase. So a
**treasury module** was built alongside it (migration `0021`).

- [x] A deposit is a **verification, not an instruction**. The user does not say
      how much to credit them; they say *which transaction* to look at. The
      platform reads it from Horizon and credits exactly what arrived, from
      exactly the wallet they proved at SEP-10. The UI has no amount field,
      deliberately — one would imply the number is theirs to choose, and the
      first thing someone would try is a larger one.
- [x] A transaction can be credited **once**, guarded twice and independently: a
      unique index on `stellar_tx_hash`, and the ledger's own uniqueness on the
      `treasury-deposit:<hash>` reference.
- [x] Withdrawals debit *before* submitting and reverse on failure. That can
      leave a user briefly debited for a payment that never went out; the
      alternative pays a user who never had the balance, and only one of those
      is recoverable. Above a configured ceiling a withdrawal is held for a
      compliance decision (Rules.md §6), and releasing one re-checks the
      balance — the hold may have lasted a while.
- [x] Horizon's 7-decimal strings convert to ledger minor units exactly, and
      precision the ledger cannot represent is **refused rather than rounded**:
      rounding a deposit down is quietly keeping the difference.
- [x] Tests: 28 in `treasury.test.ts`, covering the conversion in both
      directions. Plus `npm run chain:verify-xlm`, which funds two testnet
      accounts, moves real XLM, and asserts the balance deltas to the stroop
      *and* that `decimalStringToBigInt` agrees with what the chain reported —
      the check the unit tests structurally cannot make.
- [x] **Bug found while testing:** the withdrawal ledger reference keyed on
      `Date.now()`, so two identical withdrawals in one millisecond collided
      and the second was refused. It keys on the movement id now; HTTP-level
      retry idempotency is the route middleware's job, not this layer's.

### 4.6 🟡 Frontend quality
- [x] Component tests for the purchase flow, the escrow transition flow, and
      the dispute form. 44 tests where there were none, on vitest + jsdom +
      Testing Library, running in CI before the build so a failing test stops
      the job at the cheap step.

      Each was chosen for a failure mode invisible from the outside:
      - The **purchase flow's disclosure gate** (§3.4) is a two-state
        interaction with no server involvement — collapse the states and the
        flow still "works", every other test still passes, and the disclosure
        is simply gone. The assertions are about *when the purchase call is
        made*, never about markup.
      - **`nextAction`** is the escrow state machine as the UI sees it, and it
        decides whether someone is shown a button that moves money. Offering a
        step to the wrong party renders as a button that always errors — the
        server refuses correctly — which is a confusing way to find a UI bug.
        Table-driven over every (status, viewer) pair, plus the property that
        at most one party is ever offered a step, since two would be a race the
        UI invited. Exported for this: its correctness is independent of how
        the dashboard renders.
      - The **dispute form** trims a pasted order id (an untrimmed one is a 404
        with no visible cause), clears on success so the next dispute is not
        filed against the previous order, and *keeps* the input on failure so a
        retry does not mean retyping.
- [ ] Replace the 12s polling with contract-event streaming over SSE.
- [ ] Break up the dense single-line JSX in `RwaConsole.tsx`,
      `EscrowDashboard.tsx`, `KycOnboarding.tsx`.

---

### 4.7 🟠 Operations console (added 2026-09-04, not in the original plan)

Requested alongside Wave 4/5. It is listed here rather than in §7 because it
turned out to be the natural consumer of §4.4's metrics and the natural home
for a decision §4.2's policy table made editable.

- [x] `/api/admin/*`, guarded at the **router** rather than per-route, so a
      route added later is protected by default rather than by someone
      remembering. Compliance role throughout: these endpoints return the whole
      book and every user's queue.
- [x] The console can change *policy* and decide queued cases; it can never
      post a ledger entry, move units, or submit a transaction. There is no
      route here that does, and that absence is the boundary rather than a
      check. Decisions delegate to the service that owns them, so a case
      decided from the console gets the same validation, audit trail and
      downstream effects as one decided anywhere else.
- [x] **Verification routing became a policy row** (migration `0022`), replacing
      three environment variables. Changing them meant a redeploy, and the
      moment you need a control tightened is the moment you cannot wait for a
      build. Read per submission, so a threshold changed during an incident
      applies to the next application rather than the next deploy.
- [x] `routeVerification` is a pure function and fails closed in one direction
      only: a silent engine, an untrusted answer, an amount above the ceiling,
      or a hard provider failure all route *towards* a human. **`auto` does not
      mean the model decides** — AI stays advisory in every mode (Rules.md §6);
      it means the deterministic policy may conclude without queueing. The UI
      says so above the controls, because a label reading "let the AI approve"
      would describe a system this is not.
- [x] Two conflicting-evidence paths added while rewriting `decideKyc` on top
      of it: an automatic approval is refused when the advisory did not
      recommend one (the failure that lets someone through), and an automatic
      rejection is refused when it did. Both go to a person.
- [x] Every policy edit is audited **with the value it was changed from** — the
      question an auditor asks, and one an entry carrying only the new value
      cannot answer.
- [x] Tests: 40 in `admin.test.ts` (the router's fail-closed behaviour and the
      metrics' arithmetic) plus 10 in `kyc-decision.policy.test.ts` proving a
      policy change actually changes the next KYC outcome — without which the
      table is a settings page that alters nothing, a failure invisible from
      the console itself.

---

## 5. Sequencing

Do them in this order; later work depends on earlier work.

| Wave | Contents | Why first |
|---|---|---|
| **1** | §1.1, §1.2, §1.3 | Without money movement and correct economics, everything above it is decoration. |
| **2** | §1.4, §2.2, §3.1 | Risk and fraud controls — what makes it a real product rather than a marketplace of assertions. |
| **3** | §2.1, §2.3, §2.4 | Composition across domains. |
| **4** | ~~§3.2~~, ~~§3.3~~ (both done early with §3.1 — all three touch `purchaseUnits`, and splitting them would have meant three passes over the same method), §4.1, §4.2, §4.5 | Compliance, liquidity, per-user balances, and the durability gaps. |
| **5** | ~~§3.4~~ (done with §3.3 — the secondary market gave the portfolio a second cost basis to show, so surfacing it separately would have meant revisiting the same panel), §4.3, §4.4, §4.6 | Surfacing and hardening. |

---

## 6. Definition of done (applies to every box)

- [ ] Input validated at the boundary with a shared schema.
- [ ] Money paths post balanced double-entry ledger entries.
- [ ] Money-mutating endpoints are idempotent.
- [ ] Failures fail closed — never a partial money movement.
- [ ] Covered by a test that runs in CI.
- [ ] `docs/Memory.md` updated (status, decision log, changelog).

---

## 7. Explicitly out of scope

- Becoming a licensed money transmitter or securities broker.
- Real fiat rails beyond the anchor interface already defined.
- Mainnet deployment with real user funds.
- Non-Stellar chains.

> These bound the work. Several items above (accreditation, concentration
> limits) approximate regulatory controls so the architecture is *shaped*
> correctly; they are not legal compliance and must not be described as such.

---

## 8. Deferred options — decided against for now, revisit later

Recorded so the reasoning is not lost and so a later contributor does not
re-litigate a settled decision or, worse, assume these are supported.

### 8.1 🟠 Fixed-coupon / income-share financing model

**Status: deferred 2026-09-03.** Wave 1 implements discount financing only
(§1.2). This is the alternative that was considered and set aside.

**What it is.** Investors hold units earning a stated periodic yield (say 6%
annual, paid quarterly) from an asset that produces recurring income, with no
single maturity and no single collection. Exit happens through redemption or a
secondary sale rather than through collection.

**Why it was not chosen first.** Three reasons, in order of weight:
1. It does not map onto the existing escrow-release trigger. Discount financing
   has exactly one collection event, which is the `Release` transition already
   wired up. A coupon needs a recurring distribution scheduler that does not
   exist.
2. Invoices are the default asset type in the UI and the working-capital
   problem the PRD leads with. Discount financing is the correct model for them.
3. It roughly doubles Wave 1 — two waterfalls, two lifecycles, two triggers —
   before any money moves correctly even once.

**Which assets actually want it.** Real estate (rental income) and some
commodity structures (storage/lease yield). Under the current decision these are
tokenized as a single-maturity claim instead, which is a real structure but not
the most natural one for an income-producing property.

**What building it would take, if revisited:**
- [ ] `financingModel: 'discount' | 'coupon'` discriminator on the tokenization,
      with the terms columns becoming model-specific.
- [ ] `couponRateBps` + `couponPeriod` (monthly / quarterly / annual) +
      `nextCouponDate`.
- [ ] A recurring distribution job — the first genuinely scheduled money
      movement in the platform, so it needs its own idempotency story: a coupon
      period must pay exactly once even if the job runs twice.
- [ ] A separate redemption path so investors can exit without a maturity.
- [ ] A second waterfall: income → platform fee → holders pro-rata, with no
      principal repayment leg.
- [ ] UI that distinguishes the two products, since "yield" means a different
      thing in each and conflating them would mislead an investor.
- [ ] Per-model tests, plus tests that a discount tokenization cannot be paid a
      coupon and vice versa.

**Do not** describe the platform as supporting recurring-income assets until
every box above is ticked.

### 8.2 🟡 Restricting asset types to those the model fits

Also considered: refusing `real_estate` and `other` at tokenization until §8.1
exists. Rejected because it removes two options that work in the UI today for a
theoretical benefit — a dated claim on a property is a legitimate structure, not
a misrepresentation, provided the terms are shown honestly (§3.4).

Revisit if user feedback shows people expect rental-income behaviour from a
real-estate tokenization and are surprised by a maturity date.
