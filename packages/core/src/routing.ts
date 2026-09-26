import { acknowledgeAlertOfBlocker, blockerAlias, loadEscalationLadder, notify, openAlert } from "./alerts.js";
import { logAudit } from "./audit.js";
import { recordTrace } from "./trace.js";
import { getServiceSql } from "./db.js";

// SLA windows per severity (minutes). ASSUMED placeholders until the company supplies
// real SLAs (question A9). Since migration 0011 the live values are the `sla_policy`
// table, seeded from these; this map is the fallback when a row is missing, so routing
// can never fail for want of a number.
const SLA_MINUTES: Record<string, number> = {
  critical: 15,
  high: 60,
  medium: 240,
  low: 1440,
};

/** The fallback window (synchronous; the table wins at routing time). */
export function slaMinutesFor(severity: string): number {
  return SLA_MINUTES[severity] ?? SLA_MINUTES.medium!;
}

/** The live window: the `sla_policy` row for the severity, else the fallback above. */
export async function loadSlaMinutes(severity: string): Promise<number> {
  const sql = getServiceSql();
  const rows = await sql<{ minutes: number }[]>`select minutes from sla_policy where severity = ${severity}`;
  return rows[0]?.minutes ?? slaMinutesFor(severity);
}

export interface RoutingKey {
  category: string | null;
  site?: string | null;
  shift?: string | null;
}

/**
 * Pure routing lookup (no side effects) — used by routeBlocker and by replay.
 *
 * Matches `routing_rule` on (category, site, shift), MOST SPECIFIC FIRST: a rule that names
 * all three beats one that names two, which beats one that names one, which beats the
 * catch-all. A NULL in a rule column means "any". Ties within a specificity level cannot
 * happen — migration 0014's unique index forbids two rules with the same three values.
 *
 * Until 2026-09-18 this hardcoded `site is null and shift is null`, so every site- or
 * shift-specific rule the company entered would have been INVISIBLE, and the doc-comment
 * claimed the opposite. If the company had replaced the catch-all with site-specific rules,
 * nothing would have matched and every blocker would have failed routing. (Audit, I1.)
 *
 * Site and shift are compared case-insensitively and trimmed, like department in the org
 * model, because they are typed by people.
 */
export async function resolveForCategory(key: RoutingKey | string | null): Promise<string | null> {
  const k: RoutingKey = typeof key === "string" || key === null ? { category: key } : key;
  const sql = getServiceSql();
  const rules = await sql<{ resolver_employee_id: string }[]>`
    select resolver_employee_id from routing_rule
    where (category is null or category = ${k.category})
      and (site  is null or lower(trim(site))  = lower(trim(${k.site ?? ""})))
      and (shift is null or lower(trim(shift)) = lower(trim(${k.shift ?? ""})))
    order by (category is not null)::int + (site is not null)::int + (shift is not null)::int desc
    limit 1`;
  return rules[0]?.resolver_employee_id ?? null;
}

export interface RouteResult {
  resolverId: string;
  severity: string;
  slaDueAt: Date;
}

/**
 * Deterministic routing: look up routing_rule by (category, site, shift), most
 * specific first, and set the blocker's resolver + SLA. NO model call — the answer
 * is a table row, reproducible and auditable (SPEC-000 R4/R6/R20). In the demo every
 * rule resolves to the CEO.
 */
export async function routeBlocker(
  blockerId: string,
  correlationId?: string,
): Promise<RouteResult> {
  const sql = getServiceSql();
  // `site` and `shift` are read even though `resolveForCategory` does not yet match on them
  // (see the note there): they are part of the INPUT to this decision, and a replay that
  // cannot see the inputs cannot re-derive the output. Recording them now means the trace
  // stays valid when routing learns to use them.
  const brows = await sql<
    { category: string | null; severity: string | null; site: string | null; shift: string | null }[]
  >`select b.category, b.severity, e.site, e.shift
      from blocker b join employee e on e.id = b.raised_by
      where b.id = ${blockerId}`;
  const b = brows[0];
  if (!b) throw new Error(`blocker ${blockerId} not found`);
  const severity = b.severity ?? "medium";

  const resolverId = await resolveForCategory({ category: b.category, site: b.site, shift: b.shift });
  if (!resolverId) throw new Error(`no routing rule matched blocker ${blockerId}`);

  const slaMin = await loadSlaMinutes(severity);
  const updated = await sql<{ sla_due_at: Date }[]>`
    update blocker
    set assigned_resolver = ${resolverId}, sla_due_at = now() + make_interval(mins => ${slaMin})
    where id = ${blockerId}
    returning sla_due_at`;

  // The audit detail carries the INPUTS as well as the outputs. Replay re-derives from
  // `input` and never re-reads the blocker row, because that row is mutable (and, for 90%
  // of historical runs, deleted) — which is why replay used to report divergence for
  // almost every real run. See `replay.ts`.
  const input = { category: b.category, severity, site: b.site, shift: b.shift };
  await logAudit({
    correlationId,
    actor: "system",
    action: "blocker.routed",
    entity: "blocker",
    entityId: blockerId,
    detail: { input, resolverId, severity, slaMinutes: slaMin },
  });
  await recordTrace({
    correlationId,
    step: "route_blocker",
    input,
    output: { resolverId, slaMinutes: slaMin },
  });
  return { resolverId, severity, slaDueAt: updated[0]!.sla_due_at };
}

export interface RouteAndAlertResult extends RouteResult {
  alerted: boolean;
  /** True when an open alert for the same problem absorbed this one and nobody was paged. */
  deduplicated: boolean;
  alertCount: number;
}

interface BlockerCard {
  id: string; raised_by: string; category: string | null; severity: string | null;
  affected_asset: string | null; risk: string | null; is_synthetic: boolean;
  raised_by_name: string; department: string | null; site: string | null;
  note_raw: string | null; summary: string | null; task_title: string | null;
}

async function loadBlockerCard(blockerId: string): Promise<BlockerCard> {
  const sql = getServiceSql();
  // An alert that says only "high / other" is not actionable. The reader needs WHO
  // reported it, WHAT THEY ACTUALLY SAID, and which task it came from — so join the
  // raiser and the originating update rather than reading the blocker row alone.
  const rows = await sql<BlockerCard[]>`
    select b.id, b.raised_by, b.category, b.severity, b.affected_asset, b.risk, b.is_synthetic,
           raiser.display_name as raised_by_name, raiser.department, raiser.site,
           u.note_raw, u.note_parsed->>'summary' as summary, t.title as task_title
      from blocker b
      join employee raiser      on raiser.id = b.raised_by
      left join task_update u   on u.id = b.task_update_id
      left join task t          on t.id = u.task_id
      where b.id = ${blockerId}`;
  const b = rows[0];
  if (!b) throw new Error(`blocker ${blockerId} not found`);
  return b;
}

function blockerText(b: BlockerCard): string {
  const where = [b.department, b.site].filter(Boolean).join(" · ");
  return (
    `⚠️ ${String(b.severity ?? "").toUpperCase()} · ${b.category}` +
    (b.affected_asset ? ` — ${b.affected_asset}` : "") +
    `\n\n👤 ${b.raised_by_name}${where ? ` (${where})` : ""}` +
    (b.task_title ? `\n📋 Task: ${b.task_title}` : "") +
    // Their own words come first: the reader should read the person, not a paraphrase.
    (b.note_raw ? `\n\n💬 "${b.note_raw}"` : "") +
    (b.summary && b.summary !== b.note_raw ? `\n\n📝 ${b.summary}` : "") +
    (b.risk ? `\n⚠️ Risk: ${b.risk}` : "")
  );
}

/** The one-tap keyboard. Nothing is sent on anyone's behalf without an explicit tap. */
function ackKeyboard(blockerId: string): Record<string, unknown> {
  return { reply_markup: { inline_keyboard: [[{ text: "✅ Acknowledge", callback_data: `ack:${blockerId}` }]] } };
}

/**
 * Route the blocker, open (or fold into) its alert, and page the recipients the rules
 * name — the resolver and any watchers of the task, each on the channels they chose.
 * A repeat of the same problem (same person, category and asset, earlier alert still
 * open) is counted on the existing alert and pages nobody.
 */
export async function routeAndAlert(
  blockerId: string,
  correlationId?: string,
): Promise<RouteAndAlertResult> {
  const route = await routeBlocker(blockerId, correlationId);
  const b = await loadBlockerCard(blockerId);

  const alert = await openAlert({
    alias: blockerAlias(b),
    kind: "blocker",
    entity: "blocker",
    entityId: blockerId,
    employeeId: b.raised_by,
    correlationId,
    isSynthetic: b.is_synthetic,
  });
  const sql = getServiceSql();
  await sql`update blocker set alert_id = ${alert.alertId} where id = ${blockerId}`;

  if (!alert.isNew) {
    return { ...route, alerted: false, deduplicated: true, alertCount: alert.count };
  }

  const res = await notify(
    { type: "blocker.raised", blockerId },
    {
      text: blockerText(b),
      payload: { blockerId, alertId: alert.alertId },
      telegram: ackKeyboard(blockerId),
      isSynthetic: b.is_synthetic,
      correlationId,
    },
  );
  await logAudit({
    correlationId,
    actor: "system",
    action: "blocker.alert_enqueued",
    entity: "blocker",
    entityId: blockerId,
    detail: { recipients: res.recipients.length, enqueued: res.enqueued },
  });
  return { ...route, alerted: res.enqueued > 0, deduplicated: false, alertCount: alert.count };
}

export interface EscalationResult {
  /** The ladder rung that fired (the last one tried, when the ladder ran out). */
  level: number;
  /** People paged at that rung, after channel rules. */
  notified: number;
  /** True when no rung above the current one exists — nobody else to tell. */
  exhausted: boolean;
}

/**
 * Escalate a blocker to the next rung of the default ladder. Each rung names its
 * targets symbolically (resolver, the raiser's manager, the department lead, the CEO)
 * and they are resolved to people now, so the ladder survives staff changes. A rung
 * with nobody available is recorded as skipped and the next one is tried in the same
 * call — skipped, not dropped. Bounded by the ladder's length (≤ 10 by CHECK).
 *
 * A rule, not a model call; idempotent per rung through the outbox keys.
 */
export async function escalateBlocker(
  blockerId: string,
  reason: string,
  correlationId?: string,
): Promise<EscalationResult> {
  const sql = getServiceSql();
  const ladder = await loadEscalationLadder();
  const lvl = await sql<{ next: number }[]>`
    select coalesce(max(level), 0) + 1 as next from escalation where blocker_id = ${blockerId}`;
  let level = lvl[0]?.next ?? 1;
  const isSynthetic = (await sql<{ s: boolean }[]>`select is_synthetic as s from blocker where id = ${blockerId}`)[0]?.s ?? false;

  // Folded reports do not climb their own ladder — the alert they belong to does.
  const folded = await sql<{ id: string }[]>`
    select b.id from blocker b join alert a on a.id = b.alert_id
    where b.id = ${blockerId} and a.entity_id <> b.id::text`;
  if (folded[0]) return { level: level - 1, notified: 0, exhausted: true };

  const b = await loadBlockerCard(blockerId);
  while (level <= ladder.length) {
    const rung = ladder.find((l) => l.levelNo === level);
    if (!rung) {
      level++;
      continue;
    }
    const res = await notify(
      { type: "blocker.escalated", blockerId, level },
      {
        text: `🔺 Escalation L${level}: ${reason}\n\n${blockerText(b)}`,
        payload: { blockerId, level },
        telegram: ackKeyboard(blockerId),
        isSynthetic,
        correlationId,
      },
    );
    const people = [...new Set(res.recipients.map((r) => r.employeeId))];
    if (people.length === 0) {
      // Recorded so the next sweep does not retry this rung forever.
      await sql`insert into escalation (blocker_id, level, escalated_to, reason, is_synthetic, correlation_id)
                values (${blockerId}, ${level}, null, ${`${reason} (no available target — skipped)`}, ${isSynthetic}, ${correlationId ?? null})`;
      await logAudit({
        correlationId,
        actor: "system",
        action: "blocker.escalation_skipped",
        entity: "blocker",
        entityId: blockerId,
        detail: { level, reason: "no available target" },
      });
      level++;
      continue;
    }
    for (const to of people) {
      await sql`insert into escalation (blocker_id, level, escalated_to, reason, is_synthetic, correlation_id)
                values (${blockerId}, ${level}, ${to}, ${reason}, ${isSynthetic}, ${correlationId ?? null})`;
    }
    await logAudit({
      correlationId,
      actor: "system",
      action: "blocker.escalated",
      entity: "blocker",
      entityId: blockerId,
      detail: { level, reason, escalatedTo: people, recipients: res.recipients.map((r) => ({ employeeId: r.employeeId, channel: r.channel, reason: r.reason })) },
    });
    return { level, notified: people.length, exhausted: false };
  }
  return { level: Math.min(level, ladder.length + 1) - 1, notified: 0, exhausted: true };
}

/**
 * Acknowledge a blocker (stops its escalation). Also acknowledges the alert it belongs
 * to, and with it every other open report of the same problem.
 *
 * `opts.by` is the person who tapped — in the bot or in the dashboard. Without it the
 * audit row said "system" for an action a human took, which makes the one question the
 * log exists to answer ("who said they were on it?") unanswerable.
 */
export async function acknowledgeBlocker(
  blockerId: string,
  correlationId?: string,
  opts: { by?: string } = {},
): Promise<void> {
  const sql = getServiceSql();
  await sql`update blocker set status = 'acknowledged' where id = ${blockerId} and status = 'open'`;
  await logAudit({
    correlationId,
    actor: opts.by ? `employee:${opts.by}` : "system",
    action: "blocker.acknowledged",
    entity: "blocker",
    entityId: blockerId,
  });
  await acknowledgeAlertOfBlocker(blockerId, opts.by ?? null, correlationId);
}

export interface UnroutedSweepResult {
  found: number;
  routed: number;
  stillUnrouted: number;
}

/**
 * Find blockers that were never routed, and try again.
 *
 * `slaSweep` filters on `sla_due_at is not null`, so a blocker that failed routing has no
 * due date and is invisible to it — it would sit open forever with nobody told. The call
 * site now catches routing failures and alerts a human, but this is the net below that:
 * anything that reached the database unrouted, by any path, gets another attempt and is
 * counted if it still cannot be placed.
 *
 * Bounded, and it never gives up silently — a blocker that still cannot be routed is
 * reported in the return value and left for the operator rather than quietly retried
 * forever.
 */
export async function sweepUnroutedBlockers(correlationId?: string): Promise<UnroutedSweepResult> {
  const sql = getServiceSql();
  const rows = await sql<{ id: string }[]>`
    select id from blocker
    where status = 'open' and assigned_resolver is null and sla_due_at is null
    order by raised_at
    limit 50`;

  let routed = 0;
  for (const row of rows) {
    try {
      await routeAndAlert(row.id, correlationId);
      routed++;
      await logAudit({
        correlationId,
        actor: "system",
        action: "blocker.rerouted",
        entity: "blocker",
        entityId: row.id,
        detail: { note: "was unrouted; the reconciliation sweep placed it" },
      });
    } catch (err) {
      await logAudit({
        correlationId,
        actor: "system",
        action: "blocker.still_unroutable",
        entity: "blocker",
        entityId: row.id,
        detail: { reason: err instanceof Error ? err.message : String(err) },
      });
    }
  }
  return { found: rows.length, routed, stillUnrouted: rows.length - routed };
}

/**
 * The live escalation mechanism: every open blocker past its SLA climbs the ladder one
 * rung at a time. Rung 1 fires `timeout_minutes` after the SLA ran out; each later rung
 * fires `timeout_minutes` after the previous one. A blocker at the top of the ladder is
 * left alone — there is nobody further to tell, and the audit log already says so.
 */
export async function slaSweep(correlationId?: string): Promise<{ escalated: number }> {
  const sql = getServiceSql();
  const ladder = await loadEscalationLadder();
  if (ladder.length === 0) return { escalated: 0 };
  const top = ladder[ladder.length - 1]!.levelNo;

  const rows = await sql<{ id: string; sla_due_at: Date; level: number | null; last_at: Date | null }[]>`
    select b.id, b.sla_due_at, e.level, e.last_at
    from blocker b
    left join lateral (
      select max(level) as level, max(created_at) as last_at from escalation where blocker_id = b.id
    ) e on true
    where b.status = 'open' and b.sla_due_at is not null and b.sla_due_at < now()
      and coalesce(e.level, 0) < ${top}
    order by b.sla_due_at
    limit 200`;

  let escalated = 0;
  const now = Date.now();
  for (const row of rows) {
    const nextNo = (row.level ?? 0) + 1;
    const rung = ladder.find((l) => l.levelNo === nextNo);
    if (!rung) continue;
    const since = row.level ? row.last_at! : row.sla_due_at;
    if (now < since.getTime() + rung.timeoutMinutes * 60_000) continue;
    const r = await escalateBlocker(row.id, `SLA breach (sweep, L${nextNo})`, correlationId);
    if (r.notified > 0) escalated++;
  }
  return { escalated };
}
