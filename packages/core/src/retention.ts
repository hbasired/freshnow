import { logAudit } from "./audit.js";
import { getServiceSql } from "./db.js";

/**
 * Retention and erasure — UAE PDPL (Federal Decree-Law No. 45 of 2021).
 *
 * Two obligations, two functions:
 *
 *   * RETENTION — personal data is not kept longer than its purpose needs. Here the
 *     personal data is an employee's own free text (`task_update.note_raw`, the parsed
 *     copy, and any note on an assignment). The COUNTS and STATUSES are operational
 *     records and are kept; the WORDS are what gets aged out.
 *
 *   * ERASURE — a person leaves, or withdraws consent, and their data must stop being
 *     personal. CLAUDE.md: "Erasure = anonymise, not delete." Deleting rows would break
 *     every foreign key and, worse, make the audit log point at nothing (which is exactly
 *     what the reset script did and why replay was broken — TASK-036). Anonymising keeps
 *     the shape of the history and removes the person from it.
 *
 * ── What is deliberately NOT here ────────────────────────────────────────────
 * Neither function is scheduled by default. `RETENTION_DAYS` must be set for the sweep to
 * do anything, because the right number is a decision for FreshNow's data controller, not
 * a default a developer picked (see docs/WHAT-WE-NEED-FROM-FRESHNOW.md §3). Until it is
 * set, the sweep runs, finds itself disabled, and says so — rather than silently ageing
 * out records to a made-up window or silently never ageing anything.
 *
 * Both are audited, once per run, with counts — never with the content they removed.
 */

export interface RetentionResult {
  enabled: boolean;
  days: number | null;
  notesAged: number;
}

const REDACTED = "[redacted — retention window elapsed]";
const ANON_NAME = "Former employee";

/** The configured window, or null when the company has not decided one. */
export function retentionDays(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.RETENTION_DAYS;
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 30 ? n : null;
}

/**
 * Age out the free text of updates older than the window. Statuses, counts, blockers,
 * escalations and the audit trail are untouched — they are the operational record, and
 * they contain no words a person typed.
 */
export async function retentionSweep(correlationId?: string): Promise<RetentionResult> {
  const days = retentionDays();
  if (days === null) return { enabled: false, days: null, notesAged: 0 };

  const sql = getServiceSql();
  const aged = await sql<{ id: string }[]>`
    update task_update
       set note_raw = ${REDACTED},
           note_parsed = case when note_parsed is null then null
                              else jsonb_build_object('redacted', true, 'is_blocker', note_parsed->'is_blocker') end
     where submitted_at < now() - make_interval(days => ${days})
       and note_raw is not null
       and note_raw <> ${REDACTED}
     returning id`;

  // The replay trace keeps a copy of the same words (parse_update's input, and the extraction
  // made from them). Found by the 30 Sep audit: without this the sweep aged the original and
  // left the copy for ever. Judged by the trace's own age, so rows from before this fix are
  // caught too. A trace aged here can no longer be replayed — the retention window wins.
  const tracesAged = await sql`
    update run_trace
       set input = jsonb_set(input, '{noteRaw}', to_jsonb(${REDACTED}::text)),
           output = jsonb_build_object('redacted', true, 'is_blocker', output->'is_blocker')
     where step = 'parse_update'
       and created_at < now() - make_interval(days => ${days})
       and input ? 'noteRaw'
       and input->>'noteRaw' is distinct from ${REDACTED}`;

  // An emailed reply is the same kind of words as a typed one (migration 0020).
  const emailsAged = await sql`
    update email_message
       set body_text = ${REDACTED}
     where direction = 'in'
       and created_at < now() - make_interval(days => ${days})
       and body_text is not null
       and body_text <> ${REDACTED}`;

  if (aged.length > 0 || tracesAged.count > 0 || emailsAged.count > 0) {
    await logAudit({
      correlationId,
      actor: "system",
      action: "retention.notes_aged",
      entity: "task_update",
      entityId: "sweep",
      detail: { days, count: aged.length, traces: tracesAged.count, emails: emailsAged.count },
    });
  }
  return { enabled: true, days, notesAged: aged.length };
}

export interface ErasureResult {
  employeeId: string;
  notesRedacted: number;
  assignmentNotesRedacted: number;
}

/**
 * Anonymise one person. The employee row stays (every foreign key in the system points
 * at it) but nothing on it or under it identifies them any more: name, Telegram link,
 * dashboard login, and every word they ever typed. Their tasks, counts, blockers and the
 * audit rows about them remain, as the record of work that happened.
 *
 * Idempotent: erasing twice changes nothing the second time.
 */
export async function eraseEmployee(p: {
  employeeId: string;
  by: string;
  reason: "left" | "consent_withdrawn" | "request";
  correlationId?: string;
}): Promise<ErasureResult> {
  const sql = getServiceSql();

  const exists = await sql`select 1 from employee where id = ${p.employeeId}`;
  if (!exists[0]) throw new Error(`employee ${p.employeeId} not found`);

  const notes = await sql<{ id: string }[]>`
    update task_update
       set note_raw = case when note_raw is null then null else '[erased]' end,
           note_parsed = case when note_parsed is null then null
                              else jsonb_build_object('erased', true, 'is_blocker', note_parsed->'is_blocker') end
     where employee_id = ${p.employeeId} and coalesce(note_raw, '') <> '[erased]'
     returning id`;

  // …and every copy of those words in the replay trace (see retentionSweep).
  await sql`
    update run_trace
       set input = jsonb_set(input, '{noteRaw}', '"[erased]"'::jsonb),
           output = jsonb_build_object('erased', true, 'is_blocker', output->'is_blocker')
     where step = 'parse_update'
       and input->>'taskUpdateId' in (select id::text from task_update where employee_id = ${p.employeeId})
       and input->>'noteRaw' is distinct from '[erased]'`;

  // Their emails: the words, and the address that identifies them (migration 0020).
  await sql`
    update email_message
       set body_text = case when body_text is null then null else '[erased]' end,
           subject = case when direction = 'in' then '[erased]' else subject end,
           from_address = case when direction = 'in' then '[erased]' else from_address end,
           to_address = case when direction = 'out' then '[erased]' else to_address end
     where employee_id = ${p.employeeId}`;

  const assignmentNotes = await sql<{ id: string }[]>`
    update assignment set note = '[erased]'
     where (assigned_to = ${p.employeeId} or assigned_by = ${p.employeeId})
       and note is not null and note <> '[erased]'
     returning id`;

  // Identity last, so the updates above still found the rows by id — they do not depend
  // on the name, but the order makes the function readable as "content, then identity".
  await sql`
    update employee
       set display_name = ${ANON_NAME},
           telegram_user_id = null,
           auth_user_id = null,
           email = null,
           status = 'disabled'
     where id = ${p.employeeId}`;

  // A withdrawn consent is a fact worth keeping as a fact: the record says consent was
  // given and then withdrawn, which is the honest history. Nothing is deleted.
  await logAudit({
    correlationId: p.correlationId,
    actor: `employee:${p.by}`,
    action: "employee.erased",
    entity: "employee",
    entityId: p.employeeId,
    detail: {
      reason: p.reason,
      notesRedacted: notes.length,
      assignmentNotesRedacted: assignmentNotes.length,
      note: "anonymised, not deleted — operational history and audit rows are kept",
    },
  });

  return { employeeId: p.employeeId, notesRedacted: notes.length, assignmentNotesRedacted: assignmentNotes.length };
}
