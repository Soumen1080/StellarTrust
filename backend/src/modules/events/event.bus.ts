/**
 * Publish/subscribe over the domain event spine (plane.md §2.3).
 *
 * The repository stores facts; this decides who runs when one is published.
 * Handlers register against an event type and are invoked in registration
 * order, each guarded by its own idempotency claim so one handler failing
 * neither blocks nor re-runs the others.
 *
 * ## What "retried with backoff" means here, and what it does not
 *
 * A handler that throws is retried in-process a small number of times with
 * exponential backoff, because most failures at this boundary are transient (a
 * lost connection, a contended row). A handler that still fails is recorded as
 * `failed` and surfaced on `/metrics`; it is not retried forever, and it does
 * not fail the publisher.
 *
 * That last point is deliberate and worth being explicit about: publishing is
 * decoupled *on purpose*. An escrow release must not roll back because a payout
 * subscriber was briefly unavailable — the release genuinely happened, and the
 * event is durably recorded for a later replay. This is the same trade the old
 * direct call made with its try/catch, except the fact now survives the failure
 * instead of being lost with the log line.
 *
 * A durable retry loop that re-dispatches unhandled events after the process
 * dies is a queue, and belongs with the rest of the infrastructure work; the
 * spine is shaped so that adding one is a matter of scanning
 * `domain_events` left-joined against `domain_event_handled`.
 */
import { logger } from "../../lib/logger.js";
import type { MetricsRegistry } from "../../lib/metrics.js";
import type { DomainEvent, EventRepository } from "./event.repository.js";

/** A subscriber. Must tolerate being called with an event it does not care about. */
export interface EventHandler {
  /** Stable name; the idempotency key's second half. Renaming replays history. */
  name: string;
  /** Event type this handler runs on. */
  eventType: string;
  handle(event: DomainEvent): Promise<void>;
}

export interface EventBusOptions {
  /** Attempts per handler, including the first. */
  maxAttempts?: number;
  /** Base delay for exponential backoff, in milliseconds. */
  baseDelayMs?: number;
  /** Injectable for tests, which must not actually wait. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class EventBus {
  private readonly handlers = new Map<string, EventHandler[]>();
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly repository: EventRepository,
    private readonly metrics?: MetricsRegistry,
    options: EventBusOptions = {},
  ) {
    this.maxAttempts = options.maxAttempts ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 50;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Register a subscriber. Order of registration is order of invocation. */
  subscribe(handler: EventHandler): void {
    const existing = this.handlers.get(handler.eventType) ?? [];
    // A duplicate name on the same type would share an idempotency claim, so
    // the second registration would silently never run.
    if (existing.some((h) => h.name === handler.name)) {
      throw new Error(
        `Handler ${handler.name} is already subscribed to ${handler.eventType}`,
      );
    }
    existing.push(handler);
    this.handlers.set(handler.eventType, existing);
  }

  /**
   * Record a fact and run its subscribers.
   *
   * Returns the stored event — the existing one if this dedupe key was already
   * published, which is what makes a publisher's retry safe. Subscribers still
   * run on a republish, because the *handler* claim (not the publish) is what
   * decides whether work happens twice; a handler that already ran is skipped
   * by its claim, and one that never ran on the first publish gets its chance.
   */
  async publish(
    event: Omit<DomainEvent, "id" | "occurredAt">,
  ): Promise<DomainEvent> {
    const stored = await this.repository.publish(event);
    this.metrics?.domainEventsTotal.inc({ event_type: stored.eventType });
    await this.dispatch(stored);
    return stored;
  }

  /** Run every subscriber for an event that is already stored. */
  async dispatch(event: DomainEvent): Promise<void> {
    for (const handler of this.handlers.get(event.eventType) ?? []) {
      await this.runHandler(handler, event);
    }
  }

  /**
   * Invoke one handler at most once, ever.
   *
   * The claim is taken *before* the handler runs. That direction matters: a
   * crash between claim and completion leaves the event marked handled and the
   * work undone, which is recoverable by an operator replaying a named handler.
   * The reverse — run first, claim after — risks running a payout twice, and
   * between "possibly skipped, visibly" and "possibly duplicated, silently"
   * only the first is safe when the handler moves money.
   */
  private async runHandler(
    handler: EventHandler,
    event: DomainEvent,
  ): Promise<void> {
    const claimed = await this.repository.markHandled(
      event.id,
      handler.name,
      "applied",
    );
    if (!claimed) {
      logger.debug(
        { eventId: event.id, handler: handler.name },
        "domain event already handled; skipping",
      );
      this.metrics?.domainEventHandlersTotal.inc({
        handler: handler.name,
        result: "skipped",
      });
      return;
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        await handler.handle(event);
        this.metrics?.domainEventHandlersTotal.inc({
          handler: handler.name,
          result: "applied",
        });
        return;
      } catch (err) {
        lastError = err;
        if (attempt < this.maxAttempts) {
          // 50ms, 100ms, 200ms … enough to clear a contended row or a dropped
          // connection without holding the publisher for long.
          await this.sleep(this.baseDelayMs * 2 ** (attempt - 1));
        }
      }
    }

    // Out of attempts. The event stays claimed, so nothing re-runs on its own;
    // the failure is a metric and a log line an operator can act on, not an
    // exception thrown back at a publisher whose own work already succeeded.
    this.metrics?.domainEventHandlersTotal.inc({
      handler: handler.name,
      result: "failed",
    });
    logger.error(
      {
        err: lastError,
        eventId: event.id,
        eventType: event.eventType,
        handler: handler.name,
      },
      "domain event handler failed after retries",
    );
  }
}
