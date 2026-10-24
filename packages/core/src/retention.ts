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

  // A voice note's transcript is the person's words too: the notice promises "your own words, typed or
  // spoken" are removed (review 2026-10-17, todays-fixes#4).
  const voiceAged = await sql`
    update voice_asset
       set transcript_raw = ${REDACTED}
     where created_at < now() - make_interval(days => ${days})
       and transcript_raw is not null
       and transcript_raw <> ${REDACTED}`;

  // The words typed on stock records (TASK-060, migration 0034): the records stay as the company's
  // stock record; the words go with the person's other words, each judged by when it was written.
  const stockAged = await sql`
    update stock_doc set
      note = case when note is not null and not inv_is_redaction(note) and recorded_at < now() - make_interval(days => ${days})
                  then ${REDACTED} else note end,
      answer_note = case when answer_note is not null and not inv_is_redaction(answer_note) and answered_at < now() - make_interval(days => ${days})
                         then ${REDACTED} else answer_note end,
      settle_note = case when settle_note is not null and not inv_is_redaction(settle_note) and settled_at < now() - make_interval(days => ${days})
                         then ${REDACTED} else settle_note end
     where (note is not null and not inv_is_redaction(note) and recorded_at < now() - make_interval(days => ${days}))
        or (answer_note is not null and not inv_is_redaction(answer_note) and answered_at < now() - make_interval(days => ${days}))
        or (settle_note is not null and not inv_is_redaction(settle_note) and settled_at < now() - make_interval(days => ${days}))`;
  const countsAged = await sql`
    update count_session set
      decision_note = case when decision_note is not null and not inv_is_redaction(decision_note) and decided_at < now() - make_interval(days => ${days})
                           then ${REDACTED} else decision_note end,
      recount_waived_reason = case when recount_waived_reason is not null and not inv_is_redaction(recount_waived_reason)
                                        and submitted_at < now() - make_interval(days => ${days})
                                   then ${REDACTED} else recount_waived_reason end
     where (decision_note is not null and not inv_is_redaction(decision_note) and decided_at < now() - make_interval(days => ${days}))
        or (recount_waived_reason is not null and not inv_is_redaction(recount_waived_reason) and submitted_at < now() - make_interval(days => ${days}))`;

  // The words on cash records (TASK-061, 0035): the amounts stay as the company's financial record; the
  // words — a note on an entry, the auditor's question, the person's answer — go with their other words.
  const cashAged = await sql`
    update cash_doc set note = ${REDACTED}
     where note is not null and not inv_is_redaction(note) and recorded_at < now() - make_interval(days => ${days})`;
  const shiftsAged = await sql`
    update shift set
      audit_note = case when audit_note is not null and not inv_is_redaction(audit_note) and audited_at < now() - make_interval(days => ${days})
                        then ${REDACTED} else audit_note end,
      answer_note = case when answer_note is not null and not inv_is_redaction(answer_note) and answered_at < now() - make_interval(days => ${days})
                         then ${REDACTED} else answer_note end
     where (audit_note is not null and not inv_is_redaction(audit_note) and audited_at < now() - make_interval(days => ${days}))
        or (answer_note is not null and not inv_is_redaction(answer_note) and answered_at < now() - make_interval(days => ${days}))`;

  const cashWords = cashAged.count + shiftsAged.count;

  // The words on visits and plans (TASK-061 part 2, 0036): a visit's note, a plan's note and a stop's
  // instructions go with the person's other words; which machine was visited, by whom and when, stays.
  const visitsAged = await sql`
    update visit set note = ${REDACTED}
     where note is not null and not inv_is_redaction(note) and started_at < now() - make_interval(days => ${days})`;
  const plansAged = await sql`
    update route_plan set note = ${REDACTED}
     where note is not null and not inv_is_redaction(note) and updated_at < now() - make_interval(days => ${days})`;
  const stopsAged = await sql`
    update route_stop s set instructions = ${REDACTED}
      from route_plan p
     where p.id = s.plan_id and s.instructions is not null and not inv_is_redaction(s.instructions)
       and p.updated_at < now() - make_interval(days => ${days})`;
  // Why a machine's category was corrected (TASK-070, 0037): the correction stays, the words go.
  const categoryAged = await sql`
    update machine set category_note = ${REDACTED}
     where category_note is not null and not inv_is_redaction(category_note) and category_set_at < now() - make_interval(days => ${days})`;
  const routeWords = visitsAged.count + plansAged.count + stopsAged.count;
  // The words on warehouse documents (TASK-086, 0042): a document's note, why it was cancelled, a line's note. The document —
  // supplier, items, amounts, kilograms, lots — stays as the company's stock record.
  const ordersAged = await sql`
    update wh_order set
      note = case when note is not null and not inv_is_redaction(note) and created_at < now() - make_interval(days => ${days})
                  then ${REDACTED} else note end,
      cancel_note = case when cancel_note is not null and not inv_is_redaction(cancel_note) and cancelled_at < now() - make_interval(days => ${days})
                         then ${REDACTED} else cancel_note end
     where (note is not null and not inv_is_redaction(note) and created_at < now() - make_interval(days => ${days}))
        or (cancel_note is not null and not inv_is_redaction(cancel_note) and cancelled_at < now() - make_interval(days => ${days}))`;
  const orderLinesAged = await sql`
    update wh_order_line l set note = ${REDACTED}
      from wh_order o
     where o.id = l.order_id and l.note is not null and not inv_is_redaction(l.note) and o.created_at < now() - make_interval(days => ${days})`;
  const warehouseWords = ordersAged.count + orderLinesAged.count;
  if (
    aged.length > 0 || tracesAged.count > 0 || emailsAged.count > 0 || voiceAged.count > 0 || stockAged.count > 0 || countsAged.count > 0 || cashWords > 0 ||
    routeWords > 0 || categoryAged.count > 0 || warehouseWords > 0
  ) {
    await logAudit({
      correlationId,
      actor: "system",
      action: "retention.notes_aged",
      entity: "task_update",
      entityId: "sweep",
      detail: {
        days,
        count: aged.length,
        traces: tracesAged.count,
        emails: emailsAged.count,
        voice: voiceAged.count,
        stock: stockAged.count,
        counts: countsAged.count,
        cash: cashWords,
        routes: routeWords,
        categories: categoryAged.count,
        warehouse: warehouseWords,
      },
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

  // Their voice notes' transcripts — spoken words are words (review todays-fixes#4).
  await sql`update voice_asset set transcript_raw = '[erased]' where employee_id = ${p.employeeId} and transcript_raw is not null`;

  // The words they typed on stock records (0034); the records themselves stay, pointing at the
  // anonymised person, as the company's stock record.
  await sql`update stock_doc set note = '[erased]' where created_by = ${p.employeeId} and note is not null and note <> '[erased]'`;
  await sql`update stock_doc set answer_note = '[erased]' where answered_by = ${p.employeeId} and answer_note is not null and answer_note <> '[erased]'`;
  await sql`update stock_doc set settle_note = '[erased]' where settled_by = ${p.employeeId} and settle_note is not null and settle_note <> '[erased]'`;
  await sql`update count_session set decision_note = '[erased]' where decided_by = ${p.employeeId} and decision_note is not null and decision_note <> '[erased]'`;
  // And on warehouse documents (0042): the notes on documents they made, why they cancelled one, their lines' notes.
  await sql`update wh_order set note = '[erased]' where created_by = ${p.employeeId} and note is not null and note <> '[erased]'`;
  await sql`update wh_order set cancel_note = '[erased]' where cancelled_by = ${p.employeeId} and cancel_note is not null and cancel_note <> '[erased]'`;
  await sql`update wh_order_line l set note = '[erased]' from wh_order o
             where o.id = l.order_id and o.created_by = ${p.employeeId} and l.note is not null and l.note <> '[erased]'`;
  await sql`update count_session set recount_waived_reason = '[erased]'
             where recount_waived_by = ${p.employeeId} and recount_waived_reason is not null and recount_waived_reason <> '[erased]'`;

  // The words on their cash records (0035): their notes and answers, the auditor's questions and undo
  // notes about their shifts, and — for an auditor — the questions they wrote. The amounts stay, pointing
  // at the anonymised person, as the company's financial record.
  await sql`
    update cash_doc set note = '[erased]'
     where (created_by = ${p.employeeId} or shift_id in (select id from shift where employee_id = ${p.employeeId}))
       and note is not null and note <> '[erased]'`;
  await sql`
    update shift set audit_note = case when audit_note is null then null else '[erased]' end,
                     answer_note = case when answer_note is null then null else '[erased]' end
     where employee_id = ${p.employeeId}
       and ((audit_note is not null and audit_note <> '[erased]') or (answer_note is not null and answer_note <> '[erased]'))`;
  await sql`update shift set audit_note = '[erased]' where audited_by = ${p.employeeId} and audit_note is not null and audit_note <> '[erased]'`;

  // The words on their visits, and the plan notes and stop instructions they wrote (0036, 0039: by who wrote the words,
  // not who made the plan). Who visited which machine and when stays, pointing at the anonymised person.
  await sql`update visit set note = '[erased]' where employee_id = ${p.employeeId} and note is not null and note <> '[erased]'`;
  // Why they corrected a machine's category (0037): the correction stays, pointing at the anonymised person.
  await sql`update machine set category_note = '[erased]' where category_set_by = ${p.employeeId} and category_note is not null and category_note <> '[erased]'`;
  await sql`update route_plan set note = '[erased]' where note_by = ${p.employeeId} and note is not null and note <> '[erased]'`;
  await sql`update route_stop set instructions = '[erased]' where instructions_by = ${p.employeeId} and instructions is not null and instructions <> '[erased]'`;

  const assignmentNotes = await sql<{ id: string }[]>`
    update assignment set note = '[erased]'
     where (assigned_to = ${p.employeeId} or assigned_by = ${p.employeeId})
       and note is not null and note <> '[erased]'
     returning id`;

  // Phone sign-in (TASK-058): an erased person signs in nowhere again. Their sessions end, unused
  // set-up codes are voided, personal phones are switched off, and the hashes of their PIN and phone
  // secrets are overwritten — nothing derived from what they chose is kept. The rows stay, pointing at
  // the anonymised person, as the security record.
  await sql`update app_session set revoked_at = coalesce(revoked_at, now()), revoke_reason = coalesce(revoke_reason, 'person erased')
             where employee_id = ${p.employeeId}`;
  await sql`update app_setup_code set voided_at = now() where employee_id = ${p.employeeId} and used_at is null and voided_at is null`;
  const phoneSignIns = await sql`
    update app_credential
       set revoked_at = coalesce(revoked_at, now()),
           pin_hash = 'scrypt$erased',
           secret_hash = md5(random()::text || id::text) || md5(random()::text || clock_timestamp()::text)
     where employee_id = ${p.employeeId}`;
  await sql`update device set revoked_at = coalesce(revoked_at, now()), revoke_reason = coalesce(revoke_reason, 'its person was erased')
             where bound_employee_id = ${p.employeeId}`;

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
      phoneSignInsEnded: phoneSignIns.count,
      note: "anonymised, not deleted — operational history and audit rows are kept",
    },
  });

  return { employeeId: p.employeeId, notesRedacted: notes.length, assignmentNotesRedacted: assignmentNotes.length };
}
