/**
 * The event spine's guarantees (plane.md §2.3).
 *
 * The spine exists so that a replayed event produces no second effect. Every
 * test here is some version of that claim: republished facts, redelivered
 * events, a handler that fails, two handlers on one event. The money-moving
 * subscribers built on top are only as safe as these.
 */
import { describe, expect, it } from "vitest";
import { MetricsRegistry } from "../../lib/metrics.js";
import { EventBus } from "./event.bus.js";
import { InMemoryEventRepository, type DomainEvent } from "./event.repository.js";
import { DomainEventType, EventEntity, dedupeKey } from "./event.types.js";

function fact(overrides: Partial<Omit<DomainEvent, "id" | "occurredAt">> = {}) {
  return {
    eventType: DomainEventType.OrderReleased,
    entity: EventEntity.Order,
    entityId: "order-1",
    actor: "user:buyer-1",
    payload: { amount: "1000" },
    dedupeKey: dedupeKey(DomainEventType.OrderReleased, "order-1"),
    ...overrides,
  };
}

/** A handler that counts its invocations, optionally failing the first N. */
function countingHandler(name: string, failTimes = 0) {
  let calls = 0;
  let failures = 0;
  return {
    name,
    eventType: DomainEventType.OrderReleased,
    async handle(): Promise<void> {
      calls += 1;
      if (failures < failTimes) {
        failures += 1;
        throw new Error("transient");
      }
    },
    get calls() {
      return calls;
    },
  };
}

/** No real waiting: backoff is exercised, the clock is not. */
const noSleep = async (): Promise<void> => {};

describe("domain event repository", () => {
  it("returns the existing event when the same fact is republished", async () => {
    const repo = new InMemoryEventRepository();

    const first = await repo.publish(fact());
    const second = await repo.publish(fact());

    // Same fact, same key — one event, not twins with different ids.
    expect(second.id).toBe(first.id);
    expect(await repo.listForEntity(EventEntity.Order, "order-1")).toHaveLength(1);
  });

  it("treats a different qualifier as a genuinely different fact", async () => {
    const repo = new InMemoryEventRepository();

    // A dispute can be opened, resolved, and opened again on one order.
    await repo.publish(
      fact({
        eventType: DomainEventType.DisputeOpened,
        dedupeKey: dedupeKey(DomainEventType.DisputeOpened, "order-1", "d-1"),
      }),
    );
    await repo.publish(
      fact({
        eventType: DomainEventType.DisputeOpened,
        dedupeKey: dedupeKey(DomainEventType.DisputeOpened, "order-1", "d-2"),
      }),
    );

    expect(await repo.listForEntity(EventEntity.Order, "order-1")).toHaveLength(2);
  });

  it("lets exactly one caller claim an event for a handler", async () => {
    const repo = new InMemoryEventRepository();
    const event = await repo.publish(fact());

    const first = await repo.markHandled(event.id, "handler-a");
    const second = await repo.markHandled(event.id, "handler-a");

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(await repo.wasHandled(event.id, "handler-a")).toBe(true);
  });

  it("scopes the claim to one handler, so others still run", async () => {
    const repo = new InMemoryEventRepository();
    const event = await repo.publish(fact());

    expect(await repo.markHandled(event.id, "handler-a")).toBe(true);
    expect(await repo.markHandled(event.id, "handler-b")).toBe(true);
  });
});

describe("event bus", () => {
  it("runs a subscriber when its event is published", async () => {
    const repo = new InMemoryEventRepository();
    const bus = new EventBus(repo, undefined, { sleep: noSleep });
    const handler = countingHandler("h1");
    bus.subscribe(handler);

    await bus.publish(fact());

    expect(handler.calls).toBe(1);
  });

  it("does not run a subscriber for an unrelated event type", async () => {
    const repo = new InMemoryEventRepository();
    const bus = new EventBus(repo, undefined, { sleep: noSleep });
    const handler = countingHandler("h1");
    bus.subscribe(handler);

    await bus.publish(
      fact({
        eventType: DomainEventType.OrderRefunded,
        dedupeKey: dedupeKey(DomainEventType.OrderRefunded, "order-1"),
      }),
    );

    expect(handler.calls).toBe(0);
  });

  // ── The §2.3 acceptance test ──────────────────────────────────────────────
  it("produces no second effect when an event is replayed", async () => {
    const repo = new InMemoryEventRepository();
    const bus = new EventBus(repo, undefined, { sleep: noSleep });
    const handler = countingHandler("h1");
    bus.subscribe(handler);

    const event = await bus.publish(fact());
    // Every way the same fact can come round again: a publisher retry, and a
    // redelivery of the stored event.
    await bus.publish(fact());
    await bus.dispatch(event);
    await bus.dispatch(event);

    expect(handler.calls).toBe(1);
  });

  it("retries a failing handler and succeeds within its attempts", async () => {
    const repo = new InMemoryEventRepository();
    const bus = new EventBus(repo, undefined, {
      sleep: noSleep,
      maxAttempts: 3,
    });
    const handler = countingHandler("h1", 2); // fails twice, then succeeds
    bus.subscribe(handler);

    await bus.publish(fact());

    expect(handler.calls).toBe(3);
  });

  it("does not fail the publisher when a handler exhausts its retries", async () => {
    const repo = new InMemoryEventRepository();
    const metrics = new MetricsRegistry();
    const bus = new EventBus(repo, metrics, { sleep: noSleep, maxAttempts: 2 });
    bus.subscribe(countingHandler("h1", 99));

    // The publisher's own work already succeeded; a broken subscriber must not
    // roll it back. The fact is durably recorded either way.
    const event = await bus.publish(fact());
    expect(event.id).toBeTruthy();

    // The failure is visible in /metrics rather than swallowed in a log line.
    expect(metrics.render()).toContain("domain_event_handlers_total");
    expect(metrics.render()).toMatch(/handler="h1".*result="failed"|result="failed".*handler="h1"/);
  });

  it("runs each subscriber of an event independently", async () => {
    const repo = new InMemoryEventRepository();
    const bus = new EventBus(repo, undefined, { sleep: noSleep, maxAttempts: 1 });
    const broken = countingHandler("broken", 99);
    const healthy = countingHandler("healthy");
    bus.subscribe(broken);
    bus.subscribe(healthy);

    await bus.publish(fact());

    // One handler failing must not deny the others their event.
    expect(broken.calls).toBe(1);
    expect(healthy.calls).toBe(1);
  });

  it("refuses two handlers with the same name on one event type", async () => {
    const repo = new InMemoryEventRepository();
    const bus = new EventBus(repo, undefined, { sleep: noSleep });
    bus.subscribe(countingHandler("duplicate"));

    // They would share an idempotency claim, so the second would silently
    // never run — a subscriber that looks registered and does nothing.
    expect(() => bus.subscribe(countingHandler("duplicate"))).toThrow(
      /already subscribed/i,
    );
  });

  it("counts published events by type in /metrics", async () => {
    const repo = new InMemoryEventRepository();
    const metrics = new MetricsRegistry();
    const bus = new EventBus(repo, metrics, { sleep: noSleep });

    await bus.publish(fact());

    expect(metrics.render()).toContain('domain_events_total{event_type="order.released"} 1');
  });
});
