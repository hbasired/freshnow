import { logAudit } from "./audit.js";
import { getServiceSql } from "./db.js";

/**
 * Where a person's browsers are reachable for web push.
 *
 * One row per DEVICE, not per person: a phone and a desktop are two subscriptions, and both
 * should buzz. The `endpoint` is unique because a browser re-subscribing returns the same
 * URL, and two rows would mean the same person gets everything twice.
 *
 * What is stored here is a push-service URL and two keys the payload is encrypted to
 * (RFC 8291) — not an identifier of the device, not a location, nothing that describes the
 * person. The `user_agent` is kept only so somebody can recognise their own devices in a
 * list ("Chrome on Windows") and revoke one; it is never parsed or analysed, and the RLS
 * policy shows these rows to their owner and to nobody else, deliberately including the CEO.
 */

export interface PushSubscriptionInput {
  employeeId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
}

export interface StoredPushSubscription {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Register a device, or refresh one that already exists. Idempotent by endpoint. */
export async function savePushSubscription(p: PushSubscriptionInput, correlationId?: string): Promise<{ created: boolean }> {
  const sql = getServiceSql();
  const rows = await sql<{ id: string }[]>`
    insert into push_subscription (employee_id, endpoint, p256dh, auth, user_agent, last_seen_at)
    values (${p.employeeId}, ${p.endpoint}, ${p.p256dh}, ${p.auth}, ${p.userAgent ?? null}, now())
    on conflict (endpoint) do update
      set employee_id = excluded.employee_id,
          p256dh = excluded.p256dh,
          auth = excluded.auth,
          user_agent = excluded.user_agent,
          last_seen_at = now()
    returning id, (xmax = 0) as created`;
  const created = (rows[0] as unknown as { created: boolean } | undefined)?.created ?? false;
  await logAudit({
    correlationId,
    actor: `employee:${p.employeeId}`,
    action: created ? "push.subscribed" : "push.resubscribed",
    entity: "push_subscription",
    entityId: rows[0]?.id ?? "unknown",
    // No endpoint, no keys: this row says a device was registered, not which device.
    detail: { created },
  });
  return { created };
}

/** Forget a device — the person turned notifications off, or the push service said it is gone. */
export async function deletePushSubscription(p: { employeeId?: string; endpoint: string; reason: string }): Promise<{ deleted: number }> {
  const sql = getServiceSql();
  const rows = p.employeeId
    ? await sql<{ id: string }[]>`delete from push_subscription where endpoint = ${p.endpoint} and employee_id = ${p.employeeId} returning id`
    : await sql<{ id: string }[]>`delete from push_subscription where endpoint = ${p.endpoint} returning id`;
  if (rows.length > 0) {
    await logAudit({
      actor: p.employeeId ? `employee:${p.employeeId}` : "system",
      action: "push.unsubscribed",
      entity: "push_subscription",
      entityId: rows[0]!.id,
      detail: { reason: p.reason },
    }).catch(() => {});
  }
  return { deleted: rows.length };
}

/** Every device to send a given person's notification to. */
export async function pushSubscriptionsFor(employeeId: string): Promise<StoredPushSubscription[]> {
  const sql = getServiceSql();
  const rows = await sql<StoredPushSubscription[]>`
    select id, endpoint, p256dh, auth from push_subscription where employee_id = ${employeeId}`;
  return [...rows];
}

/** The person's own list, for a "these devices get notifications" panel. */
export async function listMyDevices(employeeId: string): Promise<{ id: string; userAgent: string | null; createdAt: string; lastSeenAt: string | null }[]> {
  const sql = getServiceSql();
  const rows = await sql<{ id: string; user_agent: string | null; created_at: Date; last_seen_at: Date | null }[]>`
    select id, user_agent, created_at, last_seen_at from push_subscription
    where employee_id = ${employeeId} order by created_at`;
  return rows.map((r) => ({
    id: r.id,
    userAgent: r.user_agent,
    createdAt: r.created_at.toISOString(),
    lastSeenAt: r.last_seen_at ? r.last_seen_at.toISOString() : null,
  }));
}

/** Note that a push to this device worked, so a stale-device sweep can tell the difference. */
export async function markPushDelivered(endpoint: string): Promise<void> {
  const sql = getServiceSql();
  await sql`update push_subscription set last_seen_at = now() where endpoint = ${endpoint}`;
}

/**
 * Which of these people have at least one device subscribed. A subscription is the opt-in
 * for web push: it exists only because the person tapped "Turn on for this device" and then
 * said yes to the browser's own permission prompt — two explicit acts, which is a clearer
 * "yes" than any preference row. `alerts.ts` sends web push to these people by default and
 * lets a per-event "off" rule silence it.
 */
export async function hasPushDevice(employeeIds: readonly string[]): Promise<Set<string>> {
  if (employeeIds.length === 0) return new Set();
  const sql = getServiceSql();
  const rows = await sql<{ employee_id: string }[]>`
    select distinct employee_id from push_subscription where employee_id = any(${[...employeeIds]})`;
  return new Set(rows.map((r) => r.employee_id));
}
