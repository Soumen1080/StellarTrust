/** Append-only audit persistence boundary (Rules.md #6). */
import { randomUUID } from "node:crypto";

export interface AuditEvent {
  id: string;
  actor: string;
  action: string;
  entity: string;
  entityId: string | null;
  /** Safe metadata only: no PII, document values, tokens, or secrets. */
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AuditRepository {
  append(
    event: Omit<AuditEvent, "id" | "createdAt">,
  ): Promise<AuditEvent>;
  listForEntity(entity: string, entityId: string): Promise<AuditEvent[]>;
  /**
   * The most recent events across every entity, newest first.
   *
   * The admin console's trail view. Deliberately capped by the caller rather
   * than paginated: an operator reads the tail of an audit log to see what
   * just happened, and an unbounded read of an append-only table that only
   * ever grows is a query that gets slower every day it runs.
   */
  listRecent(limit: number): Promise<AuditEvent[]>;
}

export class InMemoryAuditRepository implements AuditRepository {
  private readonly events: AuditEvent[] = [];

  async append(
    event: Omit<AuditEvent, "id" | "createdAt">,
  ): Promise<AuditEvent> {
    const persisted: AuditEvent = {
      ...event,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.events.push(persisted);
    return persisted;
  }

  async listForEntity(
    entity: string,
    entityId: string,
  ): Promise<AuditEvent[]> {
    return this.events.filter(
      (event) => event.entity === entity && event.entityId === entityId,
    );
  }

  async listRecent(limit: number): Promise<AuditEvent[]> {
    // The array is append-ordered, so the tail is the newest.
    return this.events.slice(-limit).reverse();
  }
}
