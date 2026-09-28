import { randomUUID } from "node:crypto";
import { notify, notifyPeople } from "./alerts.js";
import { logAudit } from "./audit.js";
import { saveAttachments, type IncomingFile } from "./attachments.js";
import { CONSENT_POLICY_VERSION, currentNoticeHashes } from "./consent.js";
import { getServiceSql } from "./db.js";
import { DEMO_CEO_ID } from "./meta.js";
import { ceoEmployeeId } from "./org.js";
import { enqueueNotification } from "./outbox.js";
import { parseTaskUpdate } from "./parse.js";
import { recomputeProgress } from "./progress.js";
import { routeAndAlert } from "./routing.js";

export type ReportedStatus = "done" | "pending" | "blocker" | "in_progress";

/**
 * Which channel a status report arrived through. `task_update.channel` has no CHECK
 * constraint, so this union is the only thing keeping the column honest — widen it here
 * (and in semantic/schema.yaml) when a new channel is added, never at a call site.
 */
export type UpdateChannel = "telegram" | "web";

export interface OpenTask {
  id: string;
  title: string;
  status: string;
}

/** The tasks an employee can report on today. */
export async function listOpenTasks(employeeId: string, limit = 10): Promise<OpenTask[]> {
  const sql = getServiceSql();
  const rows = await sql<OpenTask[]>`
    select id, title, status from task
    where employee_id = ${employeeId} and status not in ('done', 'cancelled')
    order by created_at
    limit ${limit}`;
  return [...rows];
}

/**
 * Create a task.
 *
 * `createdBy` is who asked for it — the same person by default, the CEO when this is the
 * first half of an assignment. The audit row is what makes a task created in the
 * dashboard visible in the Activity feed: before it, work could appear on someone's list
 * with no record of where it came from.
 */
export async function createTask(
  employeeId: string,
  title: string,
  isSynthetic = false,
  opts: { correlationId?: string; createdBy?: string } = {},
): Promise<string> {
  const sql = getServiceSql();
  const clean = title.trim().slice(0, 200);
  const rows = await sql<{ id: string }[]>`
    insert into task (employee_id, title, status, is_synthetic)
    values (${employeeId}, ${clean}, 'open', ${isSynthetic})
    returning id`;
  const taskId = rows[0]!.id;

  await logAudit({
    correlationId: opts.correlationId,
    actor: `employee:${opts.createdBy ?? employeeId}`,
    action: "task.created",
    entity: "task",
    entityId: taskId,
    detail: { employeeId, title: clean },
  });
  return taskId;
}

export interface RecordedUpdate {
  taskUpdateId: string;
  correlationId: string;
}

/**
 * Record a status report. The button tap is deterministic ground truth and is written
 * immediately; free text (if any) is stored verbatim in note_raw BEFORE any model is
 * called, so an LLM outage can never lose an employee's update (SPEC-000 R23).
 */
export async function recordTaskUpdate(p: {
  taskId?: string | null;
  employeeId: string;
  status: ReportedStatus;
  noteRaw?: string | null;
  telegramMessageId?: number | null;
  /**
   * Where the report came from. The dashboard is a channel exactly like Telegram, and the
   * end-of-day counts must not care which one a person used — but the record should say.
   */
  channel?: UpdateChannel;
  /**
   * Join this write to the request that caused it. One is minted when absent, which is
   * what every Telegram path does; an HTTP caller passes its own so the audit trail runs
   * from the click to the row.
   */
  correlationId?: string;
}): Promise<RecordedUpdate> {
  const sql = getServiceSql();
  const correlationId = p.correlationId ?? randomUUID();
  const channel: UpdateChannel = p.channel ?? "telegram";

  // Consent is captured at onboarding and, until 2026-09-18, checked by NOTHING afterwards:
  // 6 of 7 active employees had no consent record because they were created by script,
  // and their updates were captured anyway. Under UAE PDPL that is processing without a
  // lawful basis. This does not REFUSE the update — losing an employee's report of a
  // broken chiller to a paperwork gap would be the wrong trade — but it records the gap
  // where it will be seen, once per person per day, so it cannot stay invisible.
  //
  // Since notice 2.0 (consent.ts) the bot and the dashboard refuse input from anyone who has
  // not agreed to the CURRENT notice, so this should now only fire for a path that has no
  // door of its own — which is exactly why it checks the current notice, not any record.
  const consent = await sql<{ ok: boolean }[]>`
    select exists (
      select 1 from consent_record c
      where c.employee_id = ${p.employeeId}
        and c.policy_version = ${CONSENT_POLICY_VERSION}
        and c.notice_hash = any(${currentNoticeHashes()})
    ) or exists (select 1 from employee e where e.id = ${p.employeeId} and e.is_synthetic) as ok`;
  if (!consent[0]?.ok) {
    const already = await sql`
      select 1 from audit_log
      where action = 'consent.missing' and entity_id = ${p.employeeId}
        and created_at > now() - interval '1 day' limit 1`;
    if (already.length === 0) {
      await logAudit({
        correlationId,
        actor: "system",
        action: "consent.missing",
        entity: "employee",
        entityId: p.employeeId,
        detail: { note: "an update was recorded for a person without consent to the current notice", channel, policyVersion: CONSENT_POLICY_VERSION },
      });
    }
  }

  const rows = await sql<{ id: string }[]>`
    insert into task_update (task_id, employee_id, status, note_raw, channel,
                             telegram_message_id, correlation_id, is_synthetic)
    values (${p.taskId ?? null}, ${p.employeeId}, ${p.status}, ${p.noteRaw ?? null},
            ${channel}, ${p.telegramMessageId ?? null}, ${correlationId}, false)
    returning id`;
  const taskUpdateId = rows[0]!.id;

  // Keep the task's own state in step with what was reported. The first report that is
  // not "done" starts the clock (started_at) that the time-vs-progress warning reads; a
  // "done" sets the resolution alongside the status, never one without the other.
  if (p.taskId) {
    const next = p.status === "done" ? "done" : p.status === "blocker" ? "pending" : "in_progress";
    await sql`update task
              set status = ${next},
                  started_at = coalesce(started_at, now()),
                  resolution = case when ${next} = 'done' then 'done' else resolution end,
                  resolved_at = case when ${next} = 'done' then coalesce(resolved_at, now()) else resolved_at end
              where id = ${p.taskId}`;
    await recomputeProgress(p.taskId, correlationId, p.employeeId);

    // "Done" closes a loop for whoever gave the work: the assigner and any watchers are
    // told, in the reporter's words. Who exactly is a table lookup in alerts.ts.
    if (p.status === "done") {
      const t = await sql<{ title: string; display_name: string }[]>`
        select t.title, e.display_name from task t join employee e on e.id = ${p.employeeId}
        where t.id = ${p.taskId}`;
      const row = t[0];
      if (row) {
        await notify(
          { type: "task.done", taskId: p.taskId, employeeId: p.employeeId, taskUpdateId },
          {
            text: `✅ ${row.display_name} finished: ${row.title}` + (p.noteRaw ? `\n\n💬 "${p.noteRaw.slice(0, 300)}"` : ""),
            payload: { taskId: p.taskId, employeeId: p.employeeId },
            correlationId,
          },
        );
      }
    }
  }

  await logAudit({
    correlationId,
    actor: `employee:${p.employeeId}`,
    action: "task_update.recorded",
    entity: "task_update",
    entityId: taskUpdateId,
    detail: { status: p.status, taskId: p.taskId ?? null, hasNote: p.noteRaw != null, channel },
  });
  return { taskUpdateId, correlationId };
}

export interface ProcessedNote {
  needsReview: boolean;
  blockerId?: string;
  category?: string;
  severity?: string;
  summary?: string;
  alerted?: boolean;
}

/**
 * Attach the employee's free text to an already-stored update, then parse it and —
 * if it is a blocker — route it deterministically and alert the resolver (the CEO).
 *
 * Ordering matters: the raw text is persisted first. If the model call fails, the
 * update is flagged needs_review and the words are still on disk.
 */
export async function attachNoteAndProcess(
  taskUpdateId: string,
  noteRaw: string,
  correlationId?: string,
): Promise<ProcessedNote> {
  const sql = getServiceSql();
  await sql`update task_update set note_raw = ${noteRaw} where id = ${taskUpdateId}`;

  const parsed = await parseTaskUpdate(taskUpdateId, correlationId);
  if (parsed.needsReview) {
    // Never a silent delete: a message we could not read still reaches a human.
    await alertNeedsReview(taskUpdateId, noteRaw, correlationId);
    return { needsReview: true };
  }
  if (!parsed.blockerId) {
    return { needsReview: false, summary: parsed.extraction?.summary };
  }

  // Routing must not be able to lose the blocker.
  //
  // The blocker row is already written by `parseTaskUpdate`. If `routeAndAlert` threw — no
  // matching routing rule is the realistic case, and becomes MORE likely the moment the
  // company replaces the catch-all with real rules — the exception propagated, the blocker
  // stayed with `assigned_resolver = NULL` and `sla_due_at = NULL`, and `slaSweep` filters
  // exactly those out. Nobody was ever told, and nothing reported it. Found by audit
  // 2026-09-18.
  //
  // Now the failure is caught, recorded, and escalated to a human by the same path an
  // unreadable message takes — and `sweepUnroutedBlockers` picks up anything that still
  // slips through.
  try {
    const routed = await routeAndAlert(parsed.blockerId, correlationId);
    return {
      needsReview: false,
      blockerId: parsed.blockerId,
      category: parsed.extraction?.category,
      severity: routed.severity,
      summary: parsed.extraction?.summary,
      alerted: routed.alerted,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await logAudit({
      correlationId,
      actor: "system",
      action: "blocker.routing_failed",
      entity: "blocker",
      entityId: parsed.blockerId,
      detail: { reason, category: parsed.extraction?.category ?? null },
    });
    // A problem nobody can route is still a problem somebody must see.
    await alertNeedsReview(
      taskUpdateId,
      `A problem was reported but could not be routed automatically (${reason}). ` +
        `Their words: "${noteRaw}"`,
      correlationId,
    );
    return {
      needsReview: true,
      blockerId: parsed.blockerId,
      category: parsed.extraction?.category,
      summary: parsed.extraction?.summary,
      alerted: false,
    };
  }
}

/**
 * Route an unreadable update to a human instead of dropping it.
 *
 * A low-literacy stress test showed the parser silently returning needs_review for
 * real breakdowns (a leading "boss", pure Hindi, Malayalam). Without this, that state
 * is a silent delete for exactly the employees least able to rephrase — so the raw
 * words go to the CEO for triage, and the employee is told in the bot.
 */
async function alertNeedsReview(
  taskUpdateId: string,
  noteRaw: string,
  correlationId?: string,
): Promise<void> {
  // The real CEO, looked up — not the seeded id (audit 2026-09-18).
  const ceoId = await ceoEmployeeId();

  // Every channel the CEO is reachable on, not only Telegram: with Telegram switched off this
  // used to be dropped at the outbox gate, and an unreadable breakdown report reached nobody.
  // The Telegram row keeps its original key so an update already alerted is never re-sent.
  await notifyPeople({
    recipients: [{ employeeId: ceoId, reason: "needs a human reader" }],
    keyFor: (_id, channel) => (channel === "telegram" ? `needs-review-${taskUpdateId}` : `needs-review-${taskUpdateId}:${channel}`),
    text: `❓ An employee update could not be read automatically and needs a human:\n\n"${noteRaw}"`,
    kind: "needs_review",
    presentation: { title: "An update needs a human reader", url: "/app/#tasks/today", tag: `review-${taskUpdateId}`, urgent: false },
    payload: { taskUpdateId },
    ...(correlationId ? { correlationId } : {}),
  });
  await logAudit({
    correlationId,
    actor: "system",
    action: "task_update.needs_review",
    entity: "task_update",
    entityId: taskUpdateId,
  });
}

// ── CEO views & assignment ──────────────────────────────────────────────────
export interface DirectoryEntry {
  id: string;
  display_name: string;
  department: string | null;
  linked: boolean;
}

export async function listEmployees(limit = 25): Promise<DirectoryEntry[]> {
  const sql = getServiceSql();
  const rows = await sql<
    { id: string; display_name: string; department: string | null; telegram_user_id: string | null }[]
  >`select id, display_name, department, telegram_user_id from employee
      where status <> 'disabled'
      order by is_synthetic, display_name
      limit ${limit}`;
  return rows.map((r) => ({
    id: r.id,
    display_name: r.display_name,
    department: r.department,
    linked: r.telegram_user_id != null,
  }));
}

export interface OpenBlocker {
  id: string;
  category: string | null;
  severity: string | null;
  summary: string | null;
  raised_by_name: string;
  raised_at: Date;
}

/** Open blockers, newest first — the CEO's queue. */
export async function listOpenBlockers(limit = 10): Promise<OpenBlocker[]> {
  const sql = getServiceSql();
  // Two joins to employee would be needed to also show the resolver; here we only
  // need the reporter, aliased explicitly (see semantic/schema.yaml).
  const rows = await sql<OpenBlocker[]>`
    select b.id, b.category, b.severity,
           coalesce(b.affected_asset, b.risk) as summary,
           reporter.display_name as raised_by_name,
           b.raised_at
    from blocker b
    join employee reporter on b.raised_by = reporter.id
    where b.status = 'open'
    order by b.raised_at desc
    limit ${limit}`;
  return [...rows];
}

export interface AssignmentResult {
  taskId: string;
  assignmentId: string;
  correlationId: string;
  delivered: boolean;
  /** How many files were stored and queued alongside the instruction. */
  attachments: number;
}

/**
 * The CEO assigns work to an employee. Creates the task + assignment record and
 * queues the notification through the OUTBOX — business logic never calls Telegram
 * directly, so delivery survives a restart and is exactly-once.
 */
export async function assignTask(p: {
  assignedBy: string;
  assignedTo: string;
  title: string;
  note?: string | null;
  /** Files the CEO sent with the instruction — a spec sheet, a photo of the fault. */
  attachments?: readonly IncomingFile[];
  /** Join this assignment to the request that caused it; one is minted when absent. */
  correlationId?: string;
}): Promise<AssignmentResult> {
  const sql = getServiceSql();
  const correlationId = p.correlationId ?? randomUUID();
  const taskId = await createTask(p.assignedTo, p.title, false, {
    correlationId,
    createdBy: p.assignedBy,
  });

  const rows = await sql<{ id: string }[]>`
    insert into assignment (task_id, assigned_by, assigned_to, note, status, is_synthetic)
    values (${taskId}, ${p.assignedBy}, ${p.assignedTo}, ${p.note ?? null}, 'assigned', false)
    returning id`;
  const assignmentId = rows[0]!.id;

  const files = await saveAttachments({
    files: p.attachments ?? [],
    uploadedBy: p.assignedBy,
    assignmentId,
    taskId,
    correlationId,
  });

  const tg = await sql<{ telegram_user_id: string | null }[]>`
    select telegram_user_id from employee where id = ${p.assignedTo}`;
  const chatId = tg[0]?.telegram_user_id ?? null;
  const giver = await sql<{ display_name: string; access_role: string }[]>`
    select display_name, access_role from employee where id = ${p.assignedBy}`;
  const from =
    giver[0]?.access_role === "ceo" || p.assignedBy === DEMO_CEO_ID ? "the CEO" : (giver[0]?.display_name ?? "your manager");

  // The assignee is told on every channel their rules allow; the outbox key is
  // structural (`task.assigned:<assignment>:<person>:<channel>`), so a retry sends nothing twice.
  const sent = await notify(
    { type: "task.assigned", assignmentId, taskId, assigneeId: p.assignedTo, assignedBy: p.assignedBy },
    {
      // Attachments are Telegram file references, never bytes (attachments.ts), so only the
      // Telegram message can say "sent below". Everywhere else says where the files are
      // rather than promising something that will not arrive.
      text:
        `📌 New task from ${from}:\n\n${p.title}` +
        (p.note ? `\n\n"${p.note}"` : "") +
        (files.length ? `\n\n📎 ${files.length} file(s) attached — delivered in Telegram only.` : ""),
      payload: { assignmentId, taskId },
      ...(files.length
        ? {
            telegram: {
              text:
                `📌 New task from ${from}:\n\n${p.title}` +
                (p.note ? `\n\n"${p.note}"` : "") +
                `\n\n📎 ${files.length} file(s) attached — sent below.`,
            },
          }
        : {}),
      correlationId,
    },
  );
  const enqueued = sent.enqueued > 0;

  // Each file is its own outbox row: one failing attachment must not block the
  // instruction itself, and the idempotency key keeps a retry from double-sending.
  for (const f of files) {
    await enqueueNotification({
      idempotencyKey: `attachment-${f.id}`,
      chatId: chatId == null ? null : Number(chatId),
      channel: "telegram",
      recipientEmployeeId: p.assignedTo,
      reason: "assignee",
      payload: {
        kind: "attachment",
        fileKind: f.kind,
        fileId: f.fileId,
        caption: f.caption ?? p.title,
        assignmentId,
      },
    });
  }

  await logAudit({
    correlationId,
    actor: `employee:${p.assignedBy}`,
    action: "task.assigned",
    entity: "assignment",
    entityId: assignmentId,
    detail: { assignedTo: p.assignedTo, taskId, delivered: enqueued, attachments: files.length },
  });
  return { taskId, assignmentId, correlationId, delivered: enqueued, attachments: files.length };
}
