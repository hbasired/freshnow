import { antivirusStatus } from "./antivirus.js";
import { logAudit } from "./audit.js";
import { evaluatePolicy, registry, type PolicyReport, type Registry } from "./compliance.js";
import { CONSENT_POLICY_VERSION, currentNoticeHashes } from "./consent.js";
import { getServiceSql } from "./db.js";
import { retentionDays } from "./retention.js";

/**
 * Rule R8 — compliance you can show, not assert.
 *
 * Every number here is SQL over the system's own records: who has agreed to which notice, which
 * outside services received data and how often (the AI-call log and the outbox are the transfer
 * record), how many identifiers were stripped from prompts, when words were aged out, who was
 * erased, who asked for their data. No model is involved and nothing is estimated.
 *
 * Also here: the once-a-day snapshot of those counts in the append-only audit log (so "what was
 * true on 3 October" survives later changes), and the personal-data export behind "Download my
 * data" — the PDPL's rights to information and to a copy in a machine-readable form
 * (Art. 13–14 [believed — article numbers from search summaries, 2026-09-30]).
 */

export interface ComplianceEvidence {
  generatedAt: string;
  days: number;
  policy: PolicyReport;
  registry: Pick<Registry, "reviewed_on" | "hosting" | "hosting_countries_allowed" | "retention_days" | "services"> | null;
  consent: { version: string; people: number; current: number; older: number; none: number };
  ai: { provider: string; calls: number; ok: number; redacted: number }[];
  channels: { channel: string; sent: number; held: number }[];
  retention: { days: number | null; lastAgedAt: string | null; notesAged: number };
  rights: { erasures: number; withdrawals: number; exports: number };
  lastSnapshotAt: string | null;
  /** TASK-051: the defences an auditor (or the CEO) would ask about, from the same records. */
  security: {
    antivirus: { configured: boolean; reachable: boolean };
    lastBackup: { at: string; encrypted: boolean } | null;
    lastRestoreTest: { at: string; ok: boolean } | null;
    malwareBlocked: number;
    scanFailures: number;
    signInThrottled: number;
  };
}

export async function complianceEvidence(opts: { days?: number; requestHost?: string | null; viaCloudflare?: boolean } = {}): Promise<ComplianceEvidence> {
  const days = opts.days ?? 30;
  const sql = getServiceSql();
  const reg = registry();

  // Everyone who can use the system: a Telegram account or a sign-in is linked.
  const [consent] = await sql<{ people: number; current: number; older: number }[]>`
    with users as (
      select e.id from employee e
      where e.status = 'active' and (e.telegram_user_id is not null or e.auth_user_id is not null)
    )
    select count(*)::int as people,
           count(*) filter (where exists (select 1 from consent_record c where c.employee_id = u.id
                              and c.policy_version = ${CONSENT_POLICY_VERSION} and c.notice_hash = any(${currentNoticeHashes()})))::int as current,
           count(*) filter (where exists (select 1 from consent_record c where c.employee_id = u.id)
                            and not exists (select 1 from consent_record c where c.employee_id = u.id
                              and c.policy_version = ${CONSENT_POLICY_VERSION} and c.notice_hash = any(${currentNoticeHashes()})))::int as older
    from users u`;

  const ai = await sql<{ provider: string; calls: number; ok: number; redacted: number }[]>`
    select coalesce(provider, 'unknown') as provider, count(*)::int as calls,
           count(*) filter (where success)::int as ok, coalesce(sum(redacted), 0)::int as redacted
    from llm_call where created_at >= now() - make_interval(days => ${days})
    group by 1 order by 1`;

  // `inapp` never leaves the database; everything else is a transfer to that channel's service.
  const channels = await sql<{ channel: string; sent: number; held: number }[]>`
    select channel, count(*) filter (where status = 'sent')::int as sent,
           count(*) filter (where status = 'pending')::int as held
    from notification_outbox
    where created_at >= now() - make_interval(days => ${days}) and channel <> 'inapp'
    group by 1 order by 1`;

  const [audit] = await sql<{ last_aged: Date | null; aged: number; erasures: number; withdrawals: number; exports: number; last_snapshot: Date | null }[]>`
    select max(created_at) filter (where action = 'retention.notes_aged') as last_aged,
           coalesce(sum((detail->>'count')::int) filter (where action = 'retention.notes_aged'
                        and created_at >= now() - make_interval(days => ${days})), 0)::int as aged,
           count(*) filter (where action = 'employee.erased' and created_at >= now() - make_interval(days => ${days}))::int as erasures,
           count(*) filter (where action = 'consent.withdrawn' and created_at >= now() - make_interval(days => ${days}))::int as withdrawals,
           count(*) filter (where action = 'data.exported' and created_at >= now() - make_interval(days => ${days}))::int as exports,
           max(created_at) filter (where action = 'compliance.snapshot') as last_snapshot
    from audit_log
    where action in ('retention.notes_aged', 'employee.erased', 'consent.withdrawn', 'data.exported', 'compliance.snapshot')`;

  const [sec] = await sql<{ backup_at: Date | null; backup_encrypted: boolean | null; test_at: Date | null; test_ok: boolean | null; malware: number; scan_failed: number; throttled: number }[]>`
    select b.created_at as backup_at, (b.detail->>'encrypted')::boolean as backup_encrypted,
           t.created_at as test_at, (t.detail->>'ok')::boolean as test_ok,
           (select count(*)::int from audit_log where action = 'security.malware_blocked' and created_at >= now() - make_interval(days => ${days})) as malware,
           (select count(*)::int from audit_log where action = 'security.scan_failed' and created_at >= now() - make_interval(days => ${days})) as scan_failed,
           (select count(*)::int from audit_log where action = 'security.signin_throttled' and created_at >= now() - make_interval(days => ${days})) as throttled
    from (select 1) one
    left join lateral (select created_at, detail from audit_log where action = 'security.backup' order by created_at desc limit 1) b on true
    left join lateral (select created_at, detail from audit_log where action = 'security.restore_test' order by created_at desc limit 1) t on true`;
  const av = await antivirusStatus();

  const c = consent ?? { people: 0, current: 0, older: 0 };
  return {
    generatedAt: new Date().toISOString(),
    days,
    policy: evaluatePolicy({ registry: reg, ...(opts.requestHost !== undefined ? { requestHost: opts.requestHost } : {}), ...(opts.viaCloudflare ? { viaCloudflare: true } : {}) }),
    registry: "error" in reg ? null : (({ reviewed_on, hosting, hosting_countries_allowed, retention_days, services }) => ({ reviewed_on, hosting, hosting_countries_allowed, retention_days, services }))(reg.registry),
    consent: { version: CONSENT_POLICY_VERSION, people: c.people, current: c.current, older: c.older, none: c.people - c.current - c.older },
    ai,
    channels,
    retention: { days: retentionDays(), lastAgedAt: audit?.last_aged?.toISOString() ?? null, notesAged: audit?.aged ?? 0 },
    rights: { erasures: audit?.erasures ?? 0, withdrawals: audit?.withdrawals ?? 0, exports: audit?.exports ?? 0 },
    lastSnapshotAt: audit?.last_snapshot?.toISOString() ?? null,
    security: {
      antivirus: { configured: av.configured, reachable: av.reachable },
      lastBackup: sec?.backup_at ? { at: sec.backup_at.toISOString(), encrypted: sec.backup_encrypted === true } : null,
      lastRestoreTest: sec?.test_at ? { at: sec.test_at.toISOString(), ok: sec.test_ok === true } : null,
      malwareBlocked: sec?.malware ?? 0,
      scanFailures: sec?.scan_failed ?? 0,
      signInThrottled: sec?.throttled ?? 0,
    },
  };
}

/**
 * Once per company day, the counts above go into the audit log — append-only, so the record of
 * what was true on a given day cannot be edited afterwards. Counts only; never a person's data.
 * Safe to call as often as the worker likes: the second call on the same Dubai day does nothing.
 */
export async function recordComplianceSnapshot(correlationId?: string): Promise<{ recorded: boolean }> {
  const sql = getServiceSql();
  const [today] = await sql<{ done: boolean }[]>`
    select exists (
      select 1 from audit_log
      where action = 'compliance.snapshot'
        and (created_at at time zone 'Asia/Dubai')::date = (now() at time zone 'Asia/Dubai')::date
    ) as done`;
  if (today?.done) return { recorded: false };
  const e = await complianceEvidence({ days: 1 });
  await logAudit({
    correlationId,
    actor: "system",
    action: "compliance.snapshot",
    entity: "compliance",
    entityId: e.generatedAt.slice(0, 10),
    detail: {
      production: e.policy.production,
      blocking: e.policy.findings.filter((f) => f.level === "block").map((f) => f.rule + (f.service ? `:${f.service}` : "")),
      warnings: e.policy.findings.filter((f) => f.level === "warn").length,
      reachable: e.policy.reachable,
      consent: e.consent,
      ai: e.ai,
      channels: e.channels,
      retentionDays: e.retention.days,
      security: e.security,
    },
  });
  return { recorded: true };
}

/**
 * Everything the system holds about one person, as JSON they can keep — their profile, consent
 * records, tasks, their own words, problems raised, assignments to and from them, progress they
 * reported, their inbox, their devices, their end-of-day reports and the audit entries of what
 * they did. Bounded (MAX per section) so one request can never read without limit.
 *
 * Push keys are left out on purpose: they are secrets that let a server write to the device, and
 * a copy of them in a download is a leak waiting to happen. The endpoint's host is kept.
 */
const MAX = 5000;

export async function exportPersonData(p: { employeeId: string; requestedBy: string; correlationId?: string }): Promise<Record<string, unknown>> {
  const sql = getServiceSql();
  const id = p.employeeId;
  // Someone else asking (the CEO or an Admin, for the person): phone sign-in TIMES stay out — they are
  // an attendance record by another name, and notice 3.0 promises they are not used as one (D216,
  // TASK-058 review #8). The person's own download keeps them: that is their right of access.
  const own = p.requestedBy === id;
  const [person] = await sql`
    select e.id, e.display_name, e.email, e.telegram_user_id::text as telegram_user_id, e.department, e.role_title, e.site, e.shift,
           e.language, e.status, e.access_role, employee_display_name(e.manager_employee_id) as manager, e.created_at
    from employee e where e.id = ${id}`;
  if (!person) throw new Error("No such person");

  const out = {
    about: {
      what: "Everything FreshNow's operations system holds about you, as of the time below.",
      generatedAt: new Date().toISOString(),
      noticeVersion: CONSENT_POLICY_VERSION,
      limits: `Each section holds at most ${MAX} entries, newest first. Push-notification keys are secrets and are not included.`,
      questions: "To correct anything here, or to have it removed, ask the CEO.",
    },
    person,
    consent: await sql`select policy_version, notice_hash, consented_at from consent_record where employee_id = ${id} order by consented_at desc limit ${MAX}`,
    tasks: await sql`
      select id, title, details, status, resolution, priority, due_at, progress_pct, progress_source,
             progress_band_low, progress_band_high, progress_note, created_at, resolved_at
      from task where employee_id = ${id} order by created_at desc limit ${MAX}`,
    updates: await sql`
      select u.submitted_at, u.status, u.channel, u.note_raw as your_words, u.note_parsed->>'summary' as read_as, t.title as task
      from task_update u left join task t on t.id = u.task_id
      where u.employee_id = ${id} order by u.submitted_at desc limit ${MAX}`,
    problemsRaised: await sql`
      select raised_at, category, severity, status, affected_asset, resolved_at, resolution_note
      from blocker where raised_by = ${id} order by raised_at desc limit ${MAX}`,
    assignments: await sql`
      select a.created_at, a.status, a.note, t.title as task,
             employee_display_name(a.assigned_by) as assigned_by, employee_display_name(a.assigned_to) as assigned_to
      from assignment a left join task t on t.id = a.task_id
      where a.assigned_to = ${id} or a.assigned_by = ${id} order by a.created_at desc limit ${MAX}`,
    progressReported: await sql`
      select created_at, pct, band_low, band_high, source, note from progress_event
      where employee_id = ${id} order by created_at desc limit ${MAX}`,
    inbox: await sql`
      select created_at, read_at, payload->>'title' as title, payload->>'text' as text, reason
      from notification_outbox where recipient_employee_id = ${id} and channel = 'inapp'
      order by created_at desc limit ${MAX}`,
    devices: await sql`
      select user_agent, split_part(split_part(endpoint, '://', 2), '/', 1) as push_service, created_at, last_seen_at
      from push_subscription where employee_id = ${id} order by created_at desc limit ${MAX}`,
    endOfDayReports: await sql`
      select report_date, completed, pending, blockers, reports_made, summary from daily_report
      where employee_id = ${id} order by report_date desc limit ${MAX}`,
    // What they sent (the record, not the pictures: those are fetched one by one through the app).
    photosAndVideos: await sql`
      select id, kind, bytes, captured_at, uploaded_at, retention_class, retention_until from media_object
      where uploaded_by = ${id} order by uploaded_at desc limit ${MAX}`,
    // The phones they can sign in on, and their sign-ins (TASK-058). Never the hashes; the times only
    // in their own download.
    phoneSignIn: own
      ? await sql`
          select d.label as phone, d.kind, c.created_at as set_up_at, c.pin_set_at, c.last_signed_in_at,
                 c.failed_count as wrong_pins_in_a_row, c.disabled_at, c.disabled_reason, c.revoked_at
            from app_credential c join device d on d.id = c.device_id
           where c.employee_id = ${id} order by c.created_at desc limit ${MAX}`
      : await sql`
          select d.label as phone, d.kind, c.created_at as set_up_at, c.failed_count as wrong_pins_in_a_row,
                 c.disabled_at, c.disabled_reason, c.revoked_at
            from app_credential c join device d on d.id = c.device_id
           where c.employee_id = ${id} order by c.created_at desc limit ${MAX}`,
    // A count of sessions for someone else's download was a usage meter — and a wrong one: every token
    // refresh is a row (review 2026-10-17, todays-fixes#3). The notice promises no attendance tracking
    // from sign-ins, so sessions are the person's own to see.
    phoneSessions: own
      ? await sql`
          select d.label as phone, s.created_at, s.expires_at, s.revoked_at, s.revoke_reason
            from app_session s join device d on d.id = s.device_id
           where s.employee_id = ${id} order by s.created_at desc limit ${MAX}`
      : "Shown only in the person's own download.",
    // Stock (TASK-060): what they hold now, and every stock document they made, confirmed or that moved
    // their stock — with the words THEY typed on it (not other people's).
    stockHeld: await sql`
      select i.name as item, i.unit, b.qty::text as qty
        from stock_balance b join inv_location l on l.id = b.location_id join inv_item i on i.id = b.item_id
       where l.kind = 'person' and l.employee_id = ${id} and b.qty <> 0 order by i.sort_order`,
    stockDocuments: await sql`
      select d.recorded_at, d.kind, d.state, d.reason,
             (select string_agg(i.name || ' ' || dl.qty::text || ' ' || i.unit, ', ' order by i.sort_order)
                from stock_doc_line dl join inv_item i on i.id = dl.item_id where dl.doc_id = d.id) as lines,
             case when d.created_by = ${id} then d.note end as your_note,
             case when d.answered_by = ${id} then d.answer_note end as your_answer,
             case when d.settled_by = ${id} then d.settle_note end as your_settlement_note
        from stock_doc d
        left join inv_location lf on lf.id = d.from_location_id
        left join inv_location lt on lt.id = d.to_location_id
       where d.created_by = ${id} or d.confirm_by = ${id} or d.answered_by = ${id} or d.settled_by = ${id}
          or lf.employee_id = ${id} or lt.employee_id = ${id}
       order by d.recorded_at desc limit ${MAX}`,
    // Cash (TASK-061): what they hold now (fils), their shifts with the auditor's check — the question to
    // them is theirs to see, as the notice says — and their answer, every entry in their shifts with the
    // words they typed, and the checks they made as an auditor, with their own words.
    cashHeldFils: await sql`
      select b.fils::text as fils from cash_balance b join cash_account a on a.id = b.account_id
       where a.kind = 'person' and a.employee_id = ${id}`,
    cashShifts: await sql`
      select business_date::text, started_at, ended_at, state, vehicle, audit_outcome, audit_note as question_to_you, answer_note as your_answer
        from shift where employee_id = ${id} order by started_at desc limit ${MAX}`,
    cashEntries: await sql`
      select d.recorded_at, d.kind, d.state, d.amount_fils::text as amount_fils, m.asset_no as machine, d.expense_kind, d.litres::text as litres,
             d.reason, case when d.created_by = ${id} then d.note end as your_note
        from cash_doc d join shift s on s.id = d.shift_id left join machine m on m.id = d.machine_id
       where s.employee_id = ${id} or d.created_by = ${id}
       order by d.recorded_at desc limit ${MAX}`,
    cashChecksYouMade: await sql`
      select business_date::text, audit_outcome, audited_at, audit_note as your_note
        from shift where audited_by = ${id} order by audited_at desc limit ${MAX}`,
    // Routes (TASK-061 part 2): the team plans they were on, and their visits — which machine, when, how the
    // visit was started, what they ticked, the kinds of proof they added, and their own note.
    routePlans: await sql`
      select p.business_date::text, p.shift_window, p.name as team, p.state
        from route_plan p join route_plan_member m on m.plan_id = p.id
       where m.employee_id = ${id} order by p.business_date desc limit ${MAX}`,
    // The words they wrote on plans as a planner (0039): a plan's note, a stop's instructions.
    routeWordsYouWrote: await sql`
      select p.business_date::text, p.shift_window, p.name as team, null::int as machine, p.note as your_words
        from route_plan p where p.note_by = ${id}
      union all
      select p.business_date::text, p.shift_window, p.name, m.asset_no, s.instructions
        from route_stop s join route_plan p on p.id = s.plan_id join machine m on m.id = s.machine_id
       where s.instructions_by = ${id}
       order by 1 desc limit ${MAX}`,
    // The machine categories they corrected (TASK-070), with their own reason.
    machineCategoriesSet: await sql`
      select m.asset_no as machine, m.category_override as category, m.category_note as your_reason, m.category_set_at as at
        from machine m where m.category_set_by = ${id} order by m.category_set_at desc limit ${MAX}`,
    visits: await sql`
      select v.started_at, v.ended_at, v.started_how, m.asset_no as machine, m.label as machine_name, v.tasks_done,
             (select string_agg(e.kind, ', ' order by e.added_at) from visit_evidence e where e.visit_id = v.id and e.removed_at is null) as proof,
             v.note as your_note
        from visit v join machine m on m.id = v.machine_id
       where v.employee_id = ${id} order by v.started_at desc limit ${MAX}`,
    // Wrong PINs and a sign-in switched off are written by the phone (actor device:…), naming the person in
    // the detail — theirs to see too, as the notice says they are kept (review todays-fixes#5).
    yourActions: await sql`
      select created_at, action, entity from audit_log
      where (actor = ${`employee:${id}`} and (${own} or action not in ('app.signed_in', 'app.signed_out')))
         or (${own} and action in ('app.sign_in_failed', 'app.credential_disabled') and detail->>'employeeId' = ${id})
      order by created_at desc limit ${MAX}`,
  };

  await logAudit({
    correlationId: p.correlationId,
    actor: `employee:${p.requestedBy}`,
    action: "data.exported",
    entity: "employee",
    entityId: id,
    detail: { self: p.requestedBy === id },
  });
  return out;
}
