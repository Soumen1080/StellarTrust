/**
 * Postgres-backed, append-only audit persistence (Rules.md #6).
 *
 * Implements the same {@link AuditRepository} contract as the in-memory variant,
 * writing to the `audit_log` table from migration 0001. That table is protected
 * by `audit_log_no_update` / `audit_log_no_delete` rules, so history is
 * tamper-evident and, crucially, survives logout/login and restarts — a wallet
 * sees its full activity trail on returning.
 *
 * Only safe metadata is stored (no PII, tokens, or secrets); callers are
 * responsible for that, matching the in-memory contract.
 *
 * Parameterized queries only (Rules.md §7).
 */
import type pg from "pg";
import type { AuditEvent, AuditRepository } from "./audit.repository.js";

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

interface AuditRow {
  id: string;
  actor: string;
  action: string;
  entity: string;
  entity_id: string | null;
  metadata: Record<string, unknown>;
  created_at: Date | string;
}

export class PgAuditRepository implements AuditRepository {
  constructor(private readonly pool: pg.Pool) {}

  private map(row: AuditRow): AuditEvent {
    return {
      id: row.id,
      actor: row.actor,
      action: row.action,
      entity: row.entity,
      entityId: row.entity_id,
      metadata: row.metadata ?? {},
      createdAt: toIso(row.created_at),
    };
  }

  async append(
    event: Omit<AuditEvent, "id" | "createdAt">,
  ): Promise<AuditEvent> {
    const { rows } = await this.pool.query<AuditRow>(
      `insert into audit_log (actor, action, entity, entity_id, metadata)
       values ($1, $2, $3, $4, $5::jsonb)
       returning id, actor, action, entity, entity_id, metadata, created_at`,
      [
        event.actor,
        event.action,
        event.entity,
        event.entityId,
        JSON.stringify(event.metadata ?? {}),
      ],
    );
    const row = rows[0];
    if (!row) throw new Error("Failed to append audit event");
    return this.map(row);
  }

  async listForEntity(
    entity: string,
    entityId: string,
  ): Promise<AuditEvent[]> {
    const { rows } = await this.pool.query<AuditRow>(
      `select id, actor, action, entity, entity_id, metadata, created_at
       from audit_log
       where entity = $1 and entity_id = $2
       order by created_at asc`,
      [entity, entityId],
    );
    return rows.map((row) => this.map(row));
  }

  async listRecent(limit: number): Promise<AuditEvent[]> {
    const { rows } = await this.pool.query<AuditRow>(
      `select id, actor, action, entity, entity_id, metadata, created_at
       from audit_log
       order by created_at desc
       limit $1`,
      [Math.min(Math.max(limit, 1), 1000)],
    );
    return rows.map((row) => this.map(row));
  }
}
