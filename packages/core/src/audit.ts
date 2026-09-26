import { getServiceSql } from "./db.js";

export interface AuditEntry {
  correlationId?: string;
  actor: string;
  action: string;
  entity?: string;
  entityId?: string;
  detail?: Record<string, unknown>;
}

/**
 * Append a row to the append-only audit_log via the service role. Every
 * consequential state change should call this with the run's correlationId, so a
 * decision can be traced end-to-end (SPEC-000 R9/R11). The app role cannot UPDATE
 * or DELETE these rows.
 */
export async function logAudit(entry: AuditEntry): Promise<void> {
  const sql = getServiceSql();
  // sql.json() encodes once → a real jsonb object. (JSON.stringify + ::jsonb
  // double-encodes into a jsonb string — see gotcha G13.)
  const detail = entry.detail === undefined ? null : sql.json(entry.detail as never);
  await sql`
    insert into audit_log (correlation_id, actor, action, entity, entity_id, detail)
    values (${entry.correlationId ?? null}, ${entry.actor}, ${entry.action},
            ${entry.entity ?? null}, ${entry.entityId ?? null}, ${detail})`;
}
