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
    yourActions: await sql`
      select created_at, action, entity from audit_log
      where actor = ${`employee:${id}`} order by created_at desc limit ${MAX}`,
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
