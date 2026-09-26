import { logAudit } from "./audit.js";
import { getServiceSql } from "./db.js";
import { liveChannels, type Channel } from "./channels.js";
import { DEMO_CEO_ID } from "./meta.js";
import { canAssignTo, loadViewer } from "./org.js";
import { enqueueNotification, type OutboxChannel } from "./outbox.js";
import { hasPushDevice } from "./push.js";

/**
 * Who is told what, through which channel, and why.
 *
 * Every recipient here is a table lookup — the symbolic targets of an escalation level,
 * the watchers of a task, the person a blocker was routed to, a person's own notification
 * rules — and every enqueued row carries the rule that chose it. Nothing in this file asks
 * a model anything. That is what makes "who was told, and why" a query rather than a guess,
 * and it is the same decomposition PagerDuty and Opsgenie settled on: an escalation policy
 * of ordered levels with timeouts, per-person notification rules, alias de-duplication, and
 * a three-state acknowledgement (triggered → acknowledged → resolved).
 */

export type AlertEvent =
  | { type: "blocker.raised"; blockerId: string }
  | { type: "blocker.escalated"; blockerId: string; level: number }
  | { type: "blocker.resolved"; blockerId: string; resolvedBy: string }
  | { type: "task.assigned"; assignmentId: string; taskId: string; assigneeId: string; assignedBy: string }
  | {
      type: "task.done";
      taskId: string;
      employeeId: string;
      /**
       * The task_update that reported it. Part of the idempotency key: a task can be done,
       * reopened and done again, and each of those is a message somebody should get. Keyed
       * on the task alone, the second "done" was silently swallowed (audit 2026-09-18).
       */
      taskUpdateId?: string;
    };

export type AlertEventType = AlertEvent["type"];
export const ALERT_EVENT_TYPES: readonly AlertEventType[] = [
  "blocker.raised",
  "blocker.escalated",
  "blocker.resolved",
  "task.assigned",
  "task.done",
];

export interface AlertRecipient {
  employeeId: string;
  channel: OutboxChannel;
  /** The matched rule in plain words — "resolver", "watcher", "escalation level 2 → ceo". */
  reason: string;
  /** The row that produced the rule (an escalation_target or notification_pref id), if any. */
  ruleId: string | null;
  delayMinutes: number;
}

/** A person plus the rule that put them on the list, before channels are applied. */
interface Candidate {
  employeeId: string;
  reason: string;
  ruleId: string | null;
}

/**
 * Channels a message may go out on — see `channels.ts`. Kept as a re-export so the one
 * place that decides "is this channel live?" is the same one the dashboard's toggle reads
 * and the outbox checks. It used to be an environment-variable read here, which meant the
 * company could not see or change it.
 */
export { liveChannels as availableChannels } from "./channels.js";

/** The entity part of an idempotency key: `<event>:<entity>:<employee>:<channel>`. */
export function eventEntityKey(event: AlertEvent): string {
  switch (event.type) {
    case "blocker.raised":
    case "blocker.resolved":
      return event.blockerId;
    case "blocker.escalated":
      return `${event.blockerId}#${event.level}`;
    case "task.assigned":
      return event.assignmentId;
    case "task.done":
      return event.taskUpdateId ? `${event.taskId}#${event.taskUpdateId}` : event.taskId;
  }
}

// ── The "who" rules ─────────────────────────────────────────────────────────────

async function blockerFacts(blockerId: string): Promise<{
  raised_by: string;
  assigned_resolver: string | null;
  task_id: string | null;
  manager_id: string | null;
  department: string | null;
} | null> {
  const sql = getServiceSql();
  const rows = await sql<
    { raised_by: string; assigned_resolver: string | null; task_id: string | null; manager_id: string | null; department: string | null }[]
  >`select b.raised_by, b.assigned_resolver, u.task_id,
           raiser.manager_employee_id as manager_id, raiser.department
      from blocker b
      join employee raiser on raiser.id = b.raised_by
      left join task_update u on u.id = b.task_update_id
      where b.id = ${blockerId}`;
  return rows[0] ?? null;
}

async function taskWatchers(taskId: string | null, except: readonly string[]): Promise<Candidate[]> {
  if (!taskId) return [];
  const sql = getServiceSql();
  const rows = await sql<{ employee_id: string; reason: string; id: string }[]>`
    select id, employee_id, reason from task_watcher where task_id = ${taskId} order by created_at limit 50`;
  return rows
    .filter((r) => !except.includes(r.employee_id))
    .map((r) => ({ employeeId: r.employee_id, reason: `${r.reason} of the task`, ruleId: r.id }));
}

export interface EscalationLevelRow {
  levelId: string;
  levelNo: number;
  timeoutMinutes: number;
  targets: { id: string; type: string; employeeId: string | null }[];
}

/** The default policy's ladder, ordered, bounded by the CHECK on level_no (10). */
export async function loadEscalationLadder(): Promise<EscalationLevelRow[]> {
  const sql = getServiceSql();
  const rows = await sql<
    { level_id: string; level_no: number; timeout_minutes: number; target_id: string | null; target_type: string | null; target_employee_id: string | null }[]
  >`select l.id as level_id, l.level_no, l.timeout_minutes,
           t.id as target_id, t.target_type, t.target_employee_id
      from escalation_policy p
      join escalation_level l on l.policy_id = p.id
      left join escalation_target t on t.level_id = l.id
      where p.is_default
      order by l.level_no, t.position, t.target_type`;
  const out: EscalationLevelRow[] = [];
  for (const r of rows) {
    let lvl = out[out.length - 1];
    if (!lvl || lvl.levelId !== r.level_id) {
      lvl = { levelId: r.level_id, levelNo: r.level_no, timeoutMinutes: r.timeout_minutes, targets: [] };
      out.push(lvl);
    }
    if (r.target_id && r.target_type) {
      lvl.targets.push({ id: r.target_id, type: r.target_type, employeeId: r.target_employee_id });
    }
  }
  return out;
}

/** Resolve one symbolic target to concrete people, for one blocker. Bounded by the query limits. */
async function resolveTarget(
  target: { id: string; type: string; employeeId: string | null },
  b: NonNullable<Awaited<ReturnType<typeof blockerFacts>>>,
  levelNo: number,
): Promise<Candidate[]> {
  const sql = getServiceSql();
  const tag = `escalation level ${levelNo} → ${target.type.replace(/_/g, " ")}`;
  switch (target.type) {
    case "resolver":
      return b.assigned_resolver ? [{ employeeId: b.assigned_resolver, reason: tag, ruleId: target.id }] : [];
    case "manager_of_raiser":
      return b.manager_id ? [{ employeeId: b.manager_id, reason: tag, ruleId: target.id }] : [];
    case "department_lead": {
      if (!b.department) return [];
      const rows = await sql<{ id: string }[]>`
        select id from employee
        where access_role = 'lead' and status = 'active'
          and lower(trim(department)) = lower(trim(${b.department}))
        order by display_name limit 5`;
      return rows.map((r) => ({ employeeId: r.id, reason: tag, ruleId: target.id }));
    }
    case "ceo": {
      // Look the CEO up, the same way `department_lead` above does. This used to return
      // DEMO_CEO_ID unconditionally, so on a real org chart the top two rungs of the ladder
      // resolved to an employee who does not exist and the escalation exhausted telling
      // NOBODY — recorded, but wrong. Found by audit 2026-09-18.
      const rows = await sql<{ id: string }[]>`
        select id from employee
        where access_role = 'ceo' and status = 'active'
        order by (id = ${DEMO_CEO_ID}) desc, created_at
        limit 3`;
      if (rows.length > 0) return rows.map((r) => ({ employeeId: r.id, reason: tag, ruleId: target.id }));
      // No CEO row at all: fall back to the seeded id rather than silently telling nobody.
      return [{ employeeId: DEMO_CEO_ID, reason: tag, ruleId: target.id }];
    }
    case "employee":
      return target.employeeId ? [{ employeeId: target.employeeId, reason: tag, ruleId: target.id }] : [];
    default:
      return [];
  }
}

async function candidatesFor(event: AlertEvent): Promise<Candidate[]> {
  const sql = getServiceSql();
  switch (event.type) {
    case "blocker.raised": {
      const b = await blockerFacts(event.blockerId);
      if (!b) return [];
      const out: Candidate[] = [];
      if (b.assigned_resolver) out.push({ employeeId: b.assigned_resolver, reason: "resolver", ruleId: null });
      out.push(...(await taskWatchers(b.task_id, [b.raised_by])));
      return out;
    }
    case "blocker.escalated": {
      const b = await blockerFacts(event.blockerId);
      if (!b) return [];
      const ladder = await loadEscalationLadder();
      const level = ladder.find((l) => l.levelNo === event.level);
      if (!level) return [];
      const out: Candidate[] = [];
      for (const t of level.targets) out.push(...(await resolveTarget(t, b, level.levelNo)));
      return out;
    }
    case "blocker.resolved": {
      const b = await blockerFacts(event.blockerId);
      if (!b) return [];
      const out: Candidate[] = [];
      if (b.raised_by !== event.resolvedBy) out.push({ employeeId: b.raised_by, reason: "raised it", ruleId: null });
      if (b.assigned_resolver && b.assigned_resolver !== event.resolvedBy && b.assigned_resolver !== b.raised_by) {
        out.push({ employeeId: b.assigned_resolver, reason: "resolver", ruleId: null });
      }
      return out;
    }
    case "task.assigned":
      return [{ employeeId: event.assigneeId, reason: "assignee", ruleId: null }];
    case "task.done": {
      const rows = await sql<{ assigned_by: string | null }[]>`
        select assigned_by from assignment where task_id = ${event.taskId}
        order by created_at desc limit 1`;
      const out: Candidate[] = [];
      const by = rows[0]?.assigned_by;
      if (by && by !== event.employeeId) out.push({ employeeId: by, reason: "assigned it", ruleId: null });
      out.push(...(await taskWatchers(event.taskId, [event.employeeId, ...(by ? [by] : [])])));
      return out;
    }
  }
}

// ── The "how" rules: a person's own channel preferences ───────────────────────

interface PrefRow {
  id: string;
  employee_id: string;
  channel: string;
  mode: string;
  delay_minutes: number;
}

/**
 * Turn people into (person, channel) pairs. Defaults when a person has said nothing:
 * Telegram immediately (if they are linked), the in-app inbox always, and web push
 * immediately if they have turned it on for at least one device. A "digest" rule is
 * honoured as "not now": digests are not built, and sending immediately anyway would make
 * the preference a lie.
 *
 * Why a subscribed device counts as opting in to web push, when email still needs a rule:
 * a subscription only exists because the person tapped "Turn on for this device" AND said
 * yes to the browser's own permission prompt. Requiring a third, per-event rule on top of
 * that meant web push could be switched on by the company, enabled on the phone, and still
 * never send anything — which is what TASK-043 shipped (the preferences card only ever
 * offered Telegram). An email address, by contrast, can be stored by somebody else, so
 * email stays opt-in per event.
 */
export async function resolveAlertRecipients(event: AlertEvent): Promise<AlertRecipient[]> {
  const candidates = await candidatesFor(event);
  // One entry per person: the first rule that named them wins (level targets are ordered).
  const byPerson = new Map<string, Candidate>();
  for (const c of candidates) if (!byPerson.has(c.employeeId)) byPerson.set(c.employeeId, c);
  if (byPerson.size === 0) return [];

  const ids = [...byPerson.keys()];
  const sql = getServiceSql();
  const people = await sql<{ id: string; status: string; telegram_user_id: string | null }[]>`
    select id, status, telegram_user_id from employee where id = any(${ids})`;
  const prefs = await sql<PrefRow[]>`
    select id, employee_id, channel, mode, delay_minutes from notification_pref
    where employee_id = any(${ids}) and event_type = ${event.type}`;
  const channels = await liveChannels();
  const withDevice = channels.includes("webpush") ? await hasPushDevice(ids) : new Set<string>();

  const personById = new Map(people.map((p) => [p.id, p]));
  const out: AlertRecipient[] = [];
  // Walk in rule order, not row order: the first rule that named a person is the one
  // recorded as the reason, and the audit row reads top-down like the policy does.
  for (const id of ids) {
    const p = personById.get(id);
    if (!p || p.status === "disabled") continue;
    const c = byPerson.get(p.id)!;
    const mine = prefs.filter((r) => r.employee_id === p.id);
    for (const channel of channels) {
      if (channel === "inapp") {
        out.push({ employeeId: p.id, channel, reason: c.reason, ruleId: c.ruleId, delayMinutes: 0 });
        continue;
      }
      const pref = mine.find((r) => r.channel === channel);
      if (channel === "telegram") {
        if (p.telegram_user_id == null) continue;
        if (pref && pref.mode !== "immediate") continue;
        out.push({ employeeId: p.id, channel, reason: c.reason, ruleId: pref?.id ?? c.ruleId, delayMinutes: pref?.delay_minutes ?? 0 });
        continue;
      }
      if (channel === "webpush") {
        // No rule: on if they have a device. A rule: it decides ("off" silences one event).
        if (pref ? pref.mode !== "immediate" : !withDevice.has(p.id)) continue;
        out.push({ employeeId: p.id, channel, reason: c.reason, ruleId: pref?.id ?? c.ruleId, delayMinutes: pref?.delay_minutes ?? 0 });
        continue;
      }
      // Email (and chat) are opt-in: no rule, no row.
      if (pref && pref.mode === "immediate") {
        out.push({ employeeId: p.id, channel, reason: c.reason, ruleId: pref.id, delayMinutes: pref.delay_minutes });
      }
    }
  }
  return out;
}

// ── How a message looks outside Telegram ───────────────────────────────────────

/**
 * What a phone banner needs that a Telegram message does not: a short title, where tapping
 * it should land, a tag so repeats of the same problem replace one banner instead of
 * stacking, and whether it is urgent (stays on screen, asks the push service to deliver
 * now rather than when the phone next wakes).
 *
 * Deterministic and derived from the event alone — never from the text, and never from a
 * model. The words stay the ones `message.text` already carries.
 *
 * `url` is always inside /app/ (the service worker's scope). `?task=` makes the dashboard
 * open that task's panel on arrival; the hash picks the tab.
 */
export interface Presentation {
  title: string;
  url: string;
  tag: string;
  urgent: boolean;
}

export function presentationOf(event: AlertEvent): Presentation {
  switch (event.type) {
    case "blocker.raised":
      return { title: "Problem for you to resolve", url: "/app/#tasks/alerts", tag: `blocker-${event.blockerId}`, urgent: true };
    case "blocker.escalated":
      return { title: `Escalated — level ${event.level}`, url: "/app/#tasks/alerts", tag: `blocker-${event.blockerId}`, urgent: true };
    case "blocker.resolved":
      return { title: "Problem resolved", url: "/app/#tasks/alerts", tag: `blocker-${event.blockerId}`, urgent: false };
    case "task.assigned":
      return { title: "New task for you", url: `/app/?task=${event.taskId}#tasks/mine`, tag: `task-${event.taskId}`, urgent: false };
    case "task.done":
      return { title: "Task finished", url: `/app/?task=${event.taskId}#tasks/assign`, tag: `task-${event.taskId}`, urgent: false };
  }
}

// ── Sending ─────────────────────────────────────────────────────────────────────

export interface NotifyResult {
  recipients: AlertRecipient[];
  enqueued: number;
}

/**
 * Resolve the recipients of an event and write one outbox row per (person, channel).
 * The idempotency key is structural — `<event>:<entity>:<person>:<channel>` — so the same
 * event processed twice sends nothing twice, and the audit row lists every recipient with
 * the rule that chose them.
 */
export async function notify(
  event: AlertEvent,
  message: {
    text: string;
    payload?: Record<string, unknown>;
    /** Telegram-only extras (an inline keyboard). Other channels get the text alone. */
    telegram?: Record<string, unknown>;
    isSynthetic?: boolean;
    correlationId?: string;
  },
): Promise<NotifyResult> {
  const recipients = await resolveAlertRecipients(event);
  if (recipients.length === 0) {
    await logAudit({
      correlationId: message.correlationId,
      actor: "system",
      action: "alert.no_recipient",
      entity: event.type.split(".")[0] ?? "event",
      entityId: eventEntityKey(event),
      detail: { event },
    });
    return { recipients, enqueued: 0 };
  }

  const sql = getServiceSql();
  const chatIds = await sql<{ id: string; telegram_user_id: string | null }[]>`
    select id, telegram_user_id from employee where id = any(${[...new Set(recipients.map((r) => r.employeeId))]})`;
  const chatOf = new Map(chatIds.map((r) => [r.id, r.telegram_user_id == null ? null : Number(r.telegram_user_id)]));

  let enqueued = 0;
  const entity = eventEntityKey(event);
  const shown = presentationOf(event);
  for (const r of recipients) {
    const base = { text: message.text, kind: event.type, ...shown, ...(message.payload ?? {}) };
    const payload = r.channel === "telegram" ? { ...base, ...(message.telegram ?? {}) } : base;
    const res = await enqueueNotification({
      idempotencyKey: `${event.type}:${entity}:${r.employeeId}:${r.channel}`,
      chatId: r.channel === "telegram" ? (chatOf.get(r.employeeId) ?? null) : null,
      payload,
      channel: r.channel,
      recipientEmployeeId: r.employeeId,
      reason: r.reason,
      delayMinutes: r.delayMinutes,
      isSynthetic: message.isSynthetic ?? false,
      correlationId: message.correlationId,
    });
    if (res.enqueued) enqueued++;
  }
  await logAudit({
    correlationId: message.correlationId,
    actor: "system",
    action: "alert.enqueued",
    entity: event.type.split(".")[0] ?? "event",
    entityId: entity,
    detail: {
      event,
      enqueued,
      recipients: recipients.map((r) => ({ employeeId: r.employeeId, channel: r.channel, reason: r.reason, ruleId: r.ruleId, delayMinutes: r.delayMinutes })),
    },
  });
  return { recipients, enqueued };
}

/**
 * Tell named people something that is not one of the five alert events — an update nobody
 * could read, project news. These used to be queued on Telegram (and sometimes the inbox)
 * directly, so with Telegram switched off they reached nobody's phone. Same defaults as
 * `resolveAlertRecipients` with no rule: the inbox always, Telegram if linked, web push if
 * the person has a device. Email is left out on purpose: it is opt-in per event, and these
 * have no event a person could have opted in to.
 *
 * `keyFor` builds each row's idempotency key, so a caller whose rows already exist in the
 * outbox under an older key shape can keep it and never send the same thing twice.
 */
export async function notifyPeople(p: {
  recipients: readonly { employeeId: string; reason: string }[];
  keyFor: (employeeId: string, channel: OutboxChannel) => string;
  text: string;
  kind: string;
  presentation: Presentation;
  payload?: Record<string, unknown>;
  isSynthetic?: boolean;
  correlationId?: string;
}): Promise<{ enqueued: number }> {
  const byPerson = new Map<string, string>();
  for (const r of p.recipients) if (!byPerson.has(r.employeeId)) byPerson.set(r.employeeId, r.reason);
  if (byPerson.size === 0) return { enqueued: 0 };
  const ids = [...byPerson.keys()];

  const sql = getServiceSql();
  const people = await sql<{ id: string; status: string; telegram_user_id: string | null }[]>`
    select id, status, telegram_user_id from employee where id = any(${ids})`;
  const channels = await liveChannels();
  const withDevice = channels.includes("webpush") ? await hasPushDevice(ids) : new Set<string>();

  let enqueued = 0;
  for (const person of people) {
    if (person.status === "disabled") continue;
    const reason = byPerson.get(person.id)!;
    for (const channel of channels) {
      if (channel === "telegram" && person.telegram_user_id == null) continue;
      if (channel === "webpush" && !withDevice.has(person.id)) continue;
      if (channel === "email" || channel === "chat") continue;
      const res = await enqueueNotification({
        idempotencyKey: p.keyFor(person.id, channel),
        chatId: channel === "telegram" ? Number(person.telegram_user_id) : null,
        payload: { text: p.text, kind: p.kind, ...p.presentation, ...(p.payload ?? {}) },
        channel,
        recipientEmployeeId: person.id,
        reason,
        isSynthetic: p.isSynthetic ?? false,
        correlationId: p.correlationId,
      });
      if (res.enqueued) enqueued++;
    }
  }
  return { enqueued };
}

// ── Alerts: one open alert per problem ───────────────────────────────────────────

/**
 * The alias that means "the same problem". Same person, same category, same named asset,
 * while the earlier alert is still open → one alert, counted. Without a named asset there
 * is no safe way to say two reports are the same, so each blocker is its own alert: the
 * failure mode is a second message, never a silent one.
 */
export function blockerAlias(b: { id: string; raised_by: string; category: string | null; affected_asset: string | null }): string {
  const asset = b.affected_asset?.trim().toLowerCase().replace(/\s+/g, " ");
  if (!asset) return `blocker:${b.id}`;
  return `blocker:${b.raised_by}:${(b.category ?? "-").toLowerCase()}:${asset}`;
}

export interface OpenAlertResult {
  alertId: string;
  count: number;
  /** False when an open alert with the same alias absorbed this one. */
  isNew: boolean;
}

/** Open an alert, or fold this occurrence into the open alert with the same alias. */
export async function openAlert(p: {
  alias: string;
  kind: string;
  entity: string;
  entityId: string;
  employeeId: string | null;
  correlationId?: string;
  isSynthetic?: boolean;
}): Promise<OpenAlertResult> {
  const sql = getServiceSql();
  const rows = await sql<{ id: string; count: number; inserted: boolean }[]>`
    insert into alert (alias, kind, entity, entity_id, employee_id, correlation_id, is_synthetic)
    values (${p.alias}, ${p.kind}, ${p.entity}, ${p.entityId}, ${p.employeeId}, ${p.correlationId ?? null}, ${p.isSynthetic ?? false})
    on conflict (alias) where state <> 'resolved'
    do update set
      -- The same blocker processed twice is a retry, not a second report.
      count = case when alert.entity_id = excluded.entity_id then alert.count else alert.count + 1 end,
      last_seen = now()
    returning id, count, (xmax = 0) as inserted`;
  const r = rows[0]!;
  if (!r.inserted) {
    await logAudit({
      correlationId: p.correlationId,
      actor: "system",
      action: "alert.deduplicated",
      entity: "alert",
      entityId: r.id,
      detail: { alias: p.alias, count: r.count, folded: { entity: p.entity, entityId: p.entityId } },
    });
  }
  return { alertId: r.id, count: r.count, isNew: r.inserted };
}

/** Acknowledge the alert a blocker belongs to, and every open blocker folded into it. */
export async function acknowledgeAlertOfBlocker(blockerId: string, by: string | null, correlationId?: string): Promise<void> {
  const sql = getServiceSql();
  const rows = await sql<{ id: string }[]>`
    update alert set state = 'acknowledged', acked_by = ${by}, acked_at = now()
    where id = (select alert_id from blocker where id = ${blockerId}) and state = 'triggered'
    returning id`;
  const alertId = rows[0]?.id;
  if (!alertId) return;
  await sql`update blocker set status = 'acknowledged' where alert_id = ${alertId} and status = 'open'`;
  await logAudit({
    correlationId,
    actor: by ? `employee:${by}` : "system",
    action: "alert.acknowledged",
    entity: "alert",
    entityId: alertId,
    detail: { viaBlocker: blockerId },
  });
}

/** Resolve the alert once no blocker folded into it is still live. */
export async function resolveAlertOfBlocker(blockerId: string, correlationId?: string): Promise<void> {
  const sql = getServiceSql();
  const rows = await sql<{ id: string }[]>`
    update alert a set state = 'resolved', resolved_at = now()
    where a.id = (select alert_id from blocker where id = ${blockerId})
      and a.state <> 'resolved'
      and not exists (select 1 from blocker b where b.alert_id = a.id and b.status in ('open', 'acknowledged'))
    returning a.id`;
  if (!rows[0]) return;
  await logAudit({
    correlationId,
    actor: "system",
    action: "alert.resolved",
    entity: "alert",
    entityId: rows[0].id,
    detail: { viaBlocker: blockerId },
  });
}

// ── Permissions and small writes used by the API and the bot ─────────────────────

/**
 * May this person acknowledge this blocker? The CEO, the person it was routed to, or
 * someone who manages the person who raised it. One rule for the bot and the dashboard.
 */
export async function mayAcknowledgeBlocker(actorId: string, blockerId: string): Promise<boolean> {
  const viewer = await loadViewer(actorId);
  if (!viewer) return false;
  if (viewer.isCeo) return true;
  const b = await blockerFacts(blockerId);
  if (!b) return false;
  if (b.assigned_resolver === actorId) return true;
  return b.raised_by !== actorId && (await canAssignTo(viewer, b.raised_by));
}

export async function addTaskWatcher(p: {
  taskId: string;
  employeeId: string;
  reason?: "assignee" | "manager" | "raised_by" | "watcher";
}): Promise<{ added: boolean }> {
  const sql = getServiceSql();
  const rows = await sql`
    insert into task_watcher (task_id, employee_id, reason)
    values (${p.taskId}, ${p.employeeId}, ${p.reason ?? "watcher"})
    on conflict (task_id, employee_id) do nothing
    returning id`;
  return { added: rows.length > 0 };
}

export async function removeTaskWatcher(p: { taskId: string; employeeId: string }): Promise<void> {
  const sql = getServiceSql();
  await sql`delete from task_watcher where task_id = ${p.taskId} and employee_id = ${p.employeeId}`;
}

export const PREF_MODES = ["immediate", "digest", "off"] as const;
export type PrefMode = (typeof PREF_MODES)[number];

/** A person's own rule for one event on one channel. Upsert; the row is theirs alone. */
export async function setNotificationPref(p: {
  employeeId: string;
  eventType: AlertEventType;
  /** Every channel a person can hold a preference for — not `inapp`, which is not optional. */
  channel: Exclude<Channel, "inapp">;
  mode: PrefMode;
  delayMinutes?: number;
  correlationId?: string;
}): Promise<void> {
  const delay = Math.max(0, Math.min(1440, Math.trunc(p.delayMinutes ?? 0)));
  const sql = getServiceSql();
  await sql`
    insert into notification_pref (employee_id, event_type, channel, mode, delay_minutes)
    values (${p.employeeId}, ${p.eventType}, ${p.channel}, ${p.mode}, ${delay})
    on conflict (employee_id, event_type, channel)
    do update set mode = excluded.mode, delay_minutes = excluded.delay_minutes, updated_at = now()`;
  await logAudit({
    correlationId: p.correlationId,
    actor: `employee:${p.employeeId}`,
    action: "notification_pref.set",
    entity: "employee",
    entityId: p.employeeId,
    detail: { eventType: p.eventType, channel: p.channel, mode: p.mode, delayMinutes: delay },
  });
}

/** Mark in-app notifications read. Only the recipient's own rows move. */
export async function markNotificationsRead(p: { employeeId: string; ids?: readonly string[] }): Promise<{ marked: number }> {
  const sql = getServiceSql();
  const rows = p.ids
    ? await sql`update notification_outbox set read_at = now()
                where recipient_employee_id = ${p.employeeId} and channel = 'inapp' and read_at is null
                  and id = any(${[...p.ids]}) returning id`
    : await sql`update notification_outbox set read_at = now()
                where recipient_employee_id = ${p.employeeId} and channel = 'inapp' and read_at is null
                returning id`;
  return { marked: rows.length };
}
