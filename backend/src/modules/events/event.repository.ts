/**
 * The domain event spine (plane.md §2.3).
 *
 * Four domains — payments, settlement, disputes, RWA — each owned their own
 * state and composed only where somebody had wired one directly into another.
 * The single such wire was `PaymentService.triggerRwaPayout`: payments imported
 * the RWA service, called it inline, and swallowed its failures so a payout
 * error could not roll back an escrow release. That works exactly once. Every
 * additional link would have added another import, another try/catch, and
 * another one-way dependency between modules that should not know each other.
 *
 * A published fact replaces the call. The module that owns a state change
 * publishes it once; whoever cares subscribes. Payments no longer knows RWA
 * exists.
 *
 * ## Idempotency is the whole design
 *
 * Two things can happen twice and must not have effect twice:
 *
 *   publishing — a service that retries after a failed commit republishes the
 *     same fact. `dedupeKey` is the fact's natural key ('order.released:<id>'),
 *     unique in the database, so the second publish collides and returns the
 *     original event rather than creating a twin.
 *
 *   handling — a dispatcher that crashes mid-run, or two API instances racing
 *     the same event, would otherwise run a handler twice. `markHandled` writes
 *     one row per (event, handler) under a unique constraint; the winner runs
 *     the handler, the loser is told it was already done.
 *
 * Both guarantees live in the database (migration 0017), not in a convention
 * this code hopes callers follow — that is Golden Rule #4, which asks for
 * idempotency that holds across instances rather than within one process.
 */
import { randomUUID } from "node:crypto";

/** A published cross-domain fact. Append-only; never updated or deleted. */
export interface DomainEvent {
  id: string;
  /** Dotted, past tense: `order.released`, `dispute.opened`. */
  eventType: string;
  /** Aggregate kind: `order`, `dispute`, `settlement`, `tokenization`. */
  entity: string;
  entityId: string;
  /** `user:<id>` or `system:<component>`, matching the audit log. */
  actor: string;
  /** Safe payload only — no PII, tokens, or secrets (Rules.md §3). */
  payload: Record<string, unknown>;
  /** The fact's natural key. Unique: the publish-side idempotency guarantee. */
  dedupeKey: string;
  occurredAt: string;
}

/** What a handler did with an event, for operators reading a replay. */
export type HandlerOutcome = "applied" | "skipped" | "failed";

export interface EventRepository {
  /**
   * Publish a fact, or return the one already published under this dedupe key.
   *
   * Never throws on a duplicate: republishing is the expected behaviour of a
   * caller retrying after an ambiguous failure, and the honest answer is the
   * event that already exists.
   */
  publish(
    event: Omit<DomainEvent, "id" | "occurredAt">,
  ): Promise<DomainEvent>;

  /** Events for one aggregate, newest first. */
  listForEntity(entity: string, entityId: string): Promise<DomainEvent[]>;

  /** Events of a type, newest first. */
  listByType(eventType: string, limit?: number): Promise<DomainEvent[]>;

  /**
   * Claim an event for a handler.
   *
   * @returns true if this caller won the claim and should run the handler;
   *   false if it was already handled. The check and the write are one atomic
   *   operation — a `has it run?` read followed by a separate write is exactly
   *   the race this exists to close.
   */
  markHandled(
    eventId: string,
    handler: string,
    outcome?: HandlerOutcome,
  ): Promise<boolean>;

  /** Whether a handler has already completed this event. */
  wasHandled(eventId: string, handler: string): Promise<boolean>;
}

export class InMemoryEventRepository implements EventRepository {
  private readonly events: DomainEvent[] = [];
  private readonly byDedupeKey = new Map<string, DomainEvent>();
  /** `${eventId}::${handler}` for every completed run. */
  private readonly handled = new Map<string, HandlerOutcome>();

  async publish(
    event: Omit<DomainEvent, "id" | "occurredAt">,
  ): Promise<DomainEvent> {
    const existing = this.byDedupeKey.get(event.dedupeKey);
    if (existing) return existing;

    const persisted: DomainEvent = {
      ...event,
      payload: event.payload ?? {},
      id: randomUUID(),
      occurredAt: new Date().toISOString(),
    };
    this.events.push(persisted);
    this.byDedupeKey.set(persisted.dedupeKey, persisted);
    return persisted;
  }

  async listForEntity(entity: string, entityId: string): Promise<DomainEvent[]> {
    return this.events
      .filter((e) => e.entity === entity && e.entityId === entityId)
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  }

  async listByType(eventType: string, limit = 100): Promise<DomainEvent[]> {
    return this.events
      .filter((e) => e.eventType === eventType)
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .slice(0, limit);
  }

  async markHandled(
    eventId: string,
    handler: string,
    outcome: HandlerOutcome = "applied",
  ): Promise<boolean> {
    const key = `${eventId}::${handler}`;
    if (this.handled.has(key)) return false;
    this.handled.set(key, outcome);
    return true;
  }

  async wasHandled(eventId: string, handler: string): Promise<boolean> {
    return this.handled.has(`${eventId}::${handler}`);
  }
}
