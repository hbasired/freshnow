import { getServiceSql } from "./db.js";
import { logAudit } from "./audit.js";

/**
 * Per-person caps on the expensive things.
 *
 * Reading a document costs a file download, a PDF parse and a model call with a large
 * prompt. On one shared-vCPU box every one of those competes with Postgres. Without a
 * cap, a person holding down "send" — malicious, confused, or just a stuck client
 * retrying — can exhaust the daily model budget and starve the database, and no other
 * guardrail in this system would notice, because every individual request is legitimate.
 *
 * Counted from `audit_log` rather than a new table or an in-memory counter:
 *   - the audit log is already append-only, already indexed on created_at, and already
 *     records exactly these actions, so there is nothing to keep in sync;
 *   - an in-memory counter resets on every restart, which is precisely when a retry
 *     storm is most likely.
 *
 * Limits are per rolling window, not per calendar hour, so they cannot be reset by
 * waiting for the top of the hour.
 */

export interface RateLimit {
  /** Actions counted against this limit. */
  actions: string[];
  max: number;
  windowMinutes: number;
  /** Shown to the person when they hit it. */
  label: string;
}

/**
 * Deliberately generous: these are abuse ceilings, not productivity limits. A real CEO
 * assigning a busy morning's work must never meet one.
 */
export const LIMITS: Record<string, RateLimit> = {
  document: {
    actions: ["document.planned", "document.blocked", "document.flagged", "security.malware_blocked", "security.scan_failed"],
    max: 20,
    windowMinutes: 60,
    label: "documents",
  },
  assignment: {
    actions: ["task.assigned"],
    max: 100,
    windowMinutes: 60,
    label: "assignments",
  },
  invite: {
    actions: ["invite.created"],
    max: 20,
    windowMinutes: 60,
    label: "invite codes",
  },
};

export interface RateDecision {
  allowed: boolean;
  used: number;
  max: number;
  /** Minutes until the oldest counted action falls out of the window. */
  retryAfterMinutes: number;
  message: string;
}

/**
 * Check a limit WITHOUT consuming it. The action itself writes the audit row that counts,
 * so there is no separate increment to get out of step with reality — the thing being
 * measured and the record of it are the same event.
 */
export async function checkRateLimit(p: {
  key: keyof typeof LIMITS;
  employeeId: string;
}): Promise<RateDecision> {
  const limit = LIMITS[p.key];
  if (!limit) throw new Error(`unknown rate limit: ${p.key}`);

  const sql = getServiceSql();
  const rows = await sql<{ n: number; oldest: Date | null }[]>`
    select count(*)::int as n, min(created_at) as oldest
    from audit_log
    where actor = ${`employee:${p.employeeId}`}
      and action = any(${limit.actions})
      and created_at > now() - (${limit.windowMinutes} * interval '1 minute')`;

  const used = rows[0]?.n ?? 0;
  const allowed = used < limit.max;

  let retryAfterMinutes = 0;
  if (!allowed && rows[0]?.oldest) {
    const elapsed = (Date.now() - rows[0].oldest.getTime()) / 60_000;
    retryAfterMinutes = Math.max(1, Math.ceil(limit.windowMinutes - elapsed));
  }

  if (!allowed) {
    // A limit being hit is a security-relevant event, not just a UX one.
    await logAudit({
      actor: `employee:${p.employeeId}`,
      action: "security.rate_limited",
      entity: "employee",
      entityId: p.employeeId,
      detail: { limit: p.key, used, max: limit.max, windowMinutes: limit.windowMinutes },
    });
  }

  return {
    allowed,
    used,
    max: limit.max,
    retryAfterMinutes,
    message: allowed
      ? ""
      : `You have sent ${used} ${limit.label} in the last ${limit.windowMinutes} minutes, ` +
        `which is the limit. Try again in about ${retryAfterMinutes} minute(s).\n\n` +
        `Nothing you sent was lost.`,
  };
}
