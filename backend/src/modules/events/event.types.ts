/**
 * The vocabulary of the event spine (plane.md §2.3).
 *
 * Publishers and subscribers agree on these strings and nothing else — that
 * agreement is the entire interface between two domains now, in place of one
 * importing the other's service class. A typo in a hand-written event type is a
 * subscriber that silently never fires, so the names live here as constants and
 * the dedupe keys are built by functions rather than by string concatenation at
 * each call site.
 */

/** Cross-domain facts. Past tense: these describe what already happened. */
export const DomainEventType = {
  /** Escrow released to the seller — the collection event for a linked RWA. */
  OrderReleased: "order.released",
  /** Escrow refunded to the buyer. */
  OrderRefunded: "order.refunded",
  /** A dispute was opened against an order. */
  DisputeOpened: "dispute.opened",
  /** A dispute reached a resolution (`payload.outcome` says which way). */
  DisputeResolved: "dispute.resolved",
  /** A cross-border settlement completed and delivered funds. */
  SettlementCompleted: "settlement.completed",
  /** A tokenization passed its maturity date uncollected. */
  TokenizationMatured: "tokenization.matured",
  /** A tokenization passed the grace window uncollected. */
  TokenizationDefaulted: "tokenization.defaulted",
} as const;
export type DomainEventType =
  (typeof DomainEventType)[keyof typeof DomainEventType];

/** Aggregate kinds an event can be about. */
export const EventEntity = {
  Order: "order",
  Dispute: "dispute",
  Settlement: "settlement",
  Tokenization: "tokenization",
} as const;
export type EventEntity = (typeof EventEntity)[keyof typeof EventEntity];

/**
 * The natural key of a fact.
 *
 * Derived from *what happened* rather than from a clock or a fresh uuid, so a
 * publisher retrying after an ambiguous failure produces the same key and
 * collides with its own earlier publish instead of recording the fact twice.
 *
 * `qualifier` distinguishes facts that can legitimately recur for one entity —
 * a dispute may be opened, resolved, and opened again on the same order — and
 * is omitted where the fact happens at most once.
 */
export function dedupeKey(
  eventType: DomainEventType,
  entityId: string,
  qualifier?: string,
): string {
  return qualifier
    ? `${eventType}:${entityId}:${qualifier}`
    : `${eventType}:${entityId}`;
}

/** Stable handler names. Renaming one deliberately replays its history. */
export const HandlerName = {
  /** Distributes an RWA payout when a linked escrow order is released. */
  RwaPayoutOnRelease: "rwa.payout-on-release",
  /** Holds an RWA payout while a dispute is open on the linked order. */
  RwaHoldOnDispute: "rwa.hold-on-dispute",
  /** Resumes or defaults an RWA position once a dispute resolves. */
  RwaResumeOnDisputeResolved: "rwa.resume-on-dispute-resolved",
  /** Drives an escrow order's deposit when its funding settlement completes. */
  OrderDepositOnSettlement: "payments.deposit-on-settlement",
} as const;
export type HandlerName = (typeof HandlerName)[keyof typeof HandlerName];
