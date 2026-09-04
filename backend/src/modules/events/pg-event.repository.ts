/**
 * Postgres-backed domain event spine (migration 0017).
 *
 * The in-memory variant satisfies the same contract with a Map, which is fine
 * for one process. This one is where the idempotency guarantees actually hold:
 * `domain_events.dedupe_key` and `domain_event_handled(event_id, handler)` are
 * unique indexes, so two API instances racing the same publish or the same
 * handler are settled by the database rather than by whichever read happened
 * to run first (Golden Rule #4).
 *
 * Both writes use `on conflict do nothing` and infer the outcome from whether
 * a row came back. A check-then-write would reintroduce exactly the race the
 * constraints exist to close.
 *
 * Parameterized queries only (Rules.md §7).
 */
import type pg from "pg";
import type {
  DomainEvent,
  EventRepository,
  HandlerOutcome,
} from "./event.repository.js";

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

interface EventRow {
  id: string;
  event_type: string;
  entity: string;
  entity_id: string;
  actor: string;
  payload: Record<string, unknown>;
  dedupe_key: string;
  occurred_at: Date | string;
}

const COLUMNS = `id, event_type, entity, entity_id, actor, payload,
                 dedupe_key, occurred_at`;

export class PgEventRepository implements EventRepository {
  constructor(private readonly pool: pg.Pool) {}

  private map(row: EventRow): DomainEvent {
    return {
      id: row.id,
      eventType: row.event_type,
      entity: row.entity,
      entityId: row.entity_id,
      actor: row.actor,
      payload: row.payload ?? {},
      dedupeKey: row.dedupe_key,
      occurredAt: toIso(row.occurred_at),
    };
  }

  async publish(
    event: Omit<DomainEvent, "id" | "occurredAt">,
  ): Promise<DomainEvent> {
    const { rows } = await this.pool.query<EventRow>(
      `insert into domain_events
         (event_type, entity, entity_id, actor, payload, dedupe_key)
       values ($1, $2, $3, $4, $5::jsonb, $6)
       on conflict (dedupe_key) do nothing
       returning ${COLUMNS}`,
      [
        event.eventType,
        event.entity,
        event.entityId,
        event.actor,
        JSON.stringify(event.payload ?? {}),
        event.dedupeKey,
      ],
    );

    const inserted = rows[0];
    if (inserted) return this.map(inserted);

    // Lost the race (or this is a deliberate republish). The fact already
    // exists and is the honest answer — a caller retrying after an ambiguous
    // failure wants the original event, not an error.
    const { rows: existing } = await this.pool.query<EventRow>(
      `select ${COLUMNS} from domain_events where dedupe_key = $1`,
      [event.dedupeKey],
    );
    const found = existing[0];
    if (!found) {
      // Only reachable if the row vanished between the two statements, which
      // the append-only rules make impossible. Failing loudly beats inventing
      // an event id that nothing points at.
      throw new Error(
        `Domain event ${event.dedupeKey} could not be published or recovered`,
      );
    }
    return this.map(found);
  }

  async listForEntity(entity: string, entityId: string): Promise<DomainEvent[]> {
    const { rows } = await this.pool.query<EventRow>(
      `select ${COLUMNS} from domain_events
       where entity = $1 and entity_id = $2
       order by occurred_at desc`,
      [entity, entityId],
    );
    return rows.map((row) => this.map(row));
  }

  async listByType(eventType: string, limit = 100): Promise<DomainEvent[]> {
    const { rows } = await this.pool.query<EventRow>(
      `select ${COLUMNS} from domain_events
       where event_type = $1
       order by occurred_at desc
       limit $2`,
      [eventType, limit],
    );
    return rows.map((row) => this.map(row));
  }

  async markHandled(
    eventId: string,
    handler: string,
    outcome: HandlerOutcome = "applied",
  ): Promise<boolean> {
    // The claim and the check are one statement. Whoever inserts the row runs
    // the handler; everyone else gets zero rows and does nothing.
    const { rows } = await this.pool.query<{ id: string }>(
      `insert into domain_event_handled (event_id, handler, outcome)
       values ($1, $2, $3)
       on conflict (event_id, handler) do nothing
       returning id`,
      [eventId, handler, outcome],
    );
    return rows.length > 0;
  }

  async wasHandled(eventId: string, handler: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ exists: boolean }>(
      `select exists(
         select 1 from domain_event_handled
         where event_id = $1 and handler = $2
       ) as exists`,
      [eventId, handler],
    );
    return rows[0]?.exists ?? false;
  }
}
