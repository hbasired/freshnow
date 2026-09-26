import { logAudit } from "./audit.js";
import { numericSanityGate } from "./query/gates.js";
import { getServiceSql } from "./db.js";
import { llmComplete } from "./llm/client.js";
import { companyToday } from "./time.js";
import { z } from "zod";

/**
 * End-of-day report, per employee.
 *
 * Every NUMBER is computed by Postgres over every row. The model receives those
 * already-final counts plus the person's own words and writes only the narrative —
 * it never counts, sums, or infers a total (CLAUDE.md rule 2). If the model is
 * unavailable the report is still generated, just without the prose.
 */

export interface EodTaskLine {
  task_title: string | null;
  status: string;
  note_raw: string | null;
  summary: string | null;
  submitted_at: Date;
}

export interface EodBlockerLine {
  category: string | null;
  severity: string | null;
  status: string;
  affected_asset: string | null;
  note_raw: string | null;
}

/** An open piece of work, with the context that makes it meaningful at end of day. */
export interface EodOpenTask {
  title: string;
  status: string;
  /** How many days since it was raised. 0 = today. */
  age_days: number;
  /** When they last said anything about it — null means never. */
  last_reported_at: Date | null;
  last_note: string | null;
  /** True when it was open all day and they did not mention it today. */
  silent_today: boolean;
}

export interface EodAssignment {
  title: string;
  assigned_by: string;
  status: string;
}

export interface EodReport {
  employeeId: string;
  displayName: string;
  reportDate: string;
  completed: number;
  pending: number;
  blockers: number;
  reportsMade: number;
  summary: string;
  detail: {
    updates: EodTaskLine[];
    blockers: EodBlockerLine[];
    /** Every still-open task, with age and last contact. */
    openTasks: EodOpenTask[];
    /** Open work raised before today — the carry-over the CEO asks about. */
    carriedOver: EodOpenTask[];
    /**
     * Open tasks this person said NOTHING about today. The most useful line in the
     * report: a task nobody mentions is how work quietly stalls, and it is invisible in
     * any view built only from what people did say.
     */
    silent: EodOpenTask[];
    /** Blockers still open, including ones raised on earlier days. */
    openBlockers: EodBlockerLine[];
    /** Work handed to them today. */
    assignedToday: EodAssignment[];
    /** Anything the person added themselves before the report was written. */
    addendum: string | null;
  };
  /** Yesterday's counts, so movement is visible rather than just today's snapshot. */
  previous: { completed: number; pending: number; blockers: number } | null;
}

const narrationSchema = z.object({ summary: z.string().max(900) });

/**
 * Build (and store) one person's report for a date. `date` is YYYY-MM-DD, default today.
 *
 * `addendum` is anything the person wanted on the record before it was written — the
 * context that exists only in someone's head and would otherwise be lost, like "the part
 * arrives Sunday so Monday is blocked". It is stored verbatim and given to the narrator
 * as fact.
 */
export async function generateEodReport(
  employeeId: string,
  date?: string,
  addendum?: string | null,
): Promise<EodReport> {
  const sql = getServiceSql();
  // Company time, not UTC: between 20:00 and midnight in Dubai the UTC date is still
  // YESTERDAY, so an end-of-day report run at 20:30 would summarise the wrong day.
  const day = date ?? companyToday();

  const who = await sql<{ display_name: string; is_synthetic: boolean }[]>`
    select display_name, is_synthetic from employee where id = ${employeeId}`;
  if (!who[0]) throw new Error(`employee ${employeeId} not found`);

  // ── Counts: computed in SQL, over every row ────────────────────────────────
  //
  // Counted per WORK ITEM, not per message. Someone who reports three times on one
  // chiller has one pending item, not three — counting messages made the CEO's summary
  // say "five pending items" when there were two. A general update with no task is its
  // own item, hence the coalesce onto the update's own id.
  const counts = await sql<{ completed: number; pending: number; reports_made: number }[]>`
    select
      count(distinct coalesce(u.task_id::text, u.id::text))
        filter (where u.status = 'done')::int                     as completed,
      count(distinct coalesce(u.task_id::text, u.id::text))
        filter (where u.status in ('pending','in_progress','blocker'))::int as pending,
      count(*)::int                                               as reports_made
    from task_update u
    where u.employee_id = ${employeeId}
      and u.submitted_at >= ${day}::date
      and u.submitted_at <  (${day}::date + interval '1 day')`;

  // Blockers are counted from the blocker table, not from the reported status. A
  // problem detected inside a "pending" message is still a blocker, and counting the
  // button tap instead reported zero blockers on a day one was raised and escalated.
  const blockerCount = await sql<{ n: number }[]>`
    select count(*)::int as n from blocker
    where raised_by = ${employeeId}
      and raised_at >= ${day}::date
      and raised_at <  (${day}::date + interval '1 day')`;

  const c = {
    ...(counts[0] ?? { completed: 0, pending: 0, reports_made: 0 }),
    blockers: blockerCount[0]?.n ?? 0,
  };

  const updates = await sql<EodTaskLine[]>`
    select t.title as task_title, u.status, u.note_raw,
           u.note_parsed->>'summary' as summary, u.submitted_at
    from task_update u left join task t on t.id = u.task_id
    where u.employee_id = ${employeeId}
      and u.submitted_at >= ${day}::date
      and u.submitted_at <  (${day}::date + interval '1 day')
    order by u.submitted_at`;

  const blockers = await sql<EodBlockerLine[]>`
    select b.category, b.severity, b.status, b.affected_asset, u.note_raw
    from blocker b left join task_update u on u.id = b.task_update_id
    where b.raised_by = ${employeeId}
      and b.raised_at >= ${day}::date
      and b.raised_at <  (${day}::date + interval '1 day')
    order by b.raised_at`;

  // Open work, with the context that makes it actionable: how old it is, when it was
  // last mentioned, and whether it was mentioned AT ALL today.
  const openTasks = await sql<EodOpenTask[]>`
    select t.title, t.status,
           greatest(0, (${day}::date - t.created_at::date))::int as age_days,
           (select max(u.submitted_at) from task_update u where u.task_id = t.id)
             as last_reported_at,
           (select u.note_raw from task_update u
             where u.task_id = t.id and u.note_raw is not null
             order by u.submitted_at desc limit 1) as last_note,
           not exists (
             select 1 from task_update u
             where u.task_id = t.id
               and u.submitted_at >= ${day}::date
               and u.submitted_at <  (${day}::date + interval '1 day')
           ) as silent_today
    from task t
    where t.employee_id = ${employeeId}
      and t.status not in ('done','cancelled')
      and t.created_at < (${day}::date + interval '1 day')
    order by t.created_at`;

  // Blockers still open, whenever they were raised — a problem from Tuesday that is
  // still open on Thursday belongs in Thursday's report.
  const openBlockers = await sql<EodBlockerLine[]>`
    select b.category, b.severity, b.status, b.affected_asset, u.note_raw
    from blocker b left join task_update u on u.id = b.task_update_id
    where b.raised_by = ${employeeId} and b.status in ('open','acknowledged')
    order by b.raised_at`;

  const assignedToday = await sql<EodAssignment[]>`
    select t.title, giver.display_name as assigned_by, a.status
    from assignment a
    join employee giver on giver.id = a.assigned_by
    left join task t on t.id = a.task_id
    where a.assigned_to = ${employeeId}
      and a.created_at >= ${day}::date
      and a.created_at <  (${day}::date + interval '1 day')
    order by a.created_at`;

  // Yesterday, so the report shows movement rather than an isolated snapshot.
  const prev = await sql<{ completed: number; pending: number; blockers: number }[]>`
    select completed, pending, blockers from daily_report
    where employee_id = ${employeeId} and report_date = (${day}::date - 1)`;

  const detail = {
    updates: [...updates],
    blockers: [...blockers],
    openTasks: [...openTasks],
    carriedOver: openTasks.filter((t) => t.age_days >= 1),
    silent: openTasks.filter((t) => t.silent_today),
    openBlockers: [...openBlockers],
    assignedToday: [...assignedToday],
    addendum: addendum ?? null,
  };

  // ── Narrative: the model sees the FINAL numbers and only phrases them ───────
  let summary = "";
  let gate: { passed: boolean; missing: string[] } = { passed: true, missing: [] };
  if (c.reports_made === 0) {
    summary = `${who[0].display_name} did not report anything on ${day}.`;
  } else {
    const facts =
      `Person: ${who[0].display_name}\nDate: ${day}\n` +
      `Counts (already computed over every row — do not recount, do not add up the ` +
      `lines below): tasks completed=${c.completed}, tasks still pending=${c.pending}, ` +
      `problems raised=${c.blockers}, messages sent=${c.reports_made}\n` +
      (prev[0]
        ? `Yesterday for comparison: completed=${prev[0].completed}, pending=${prev[0].pending}, blockers=${prev[0].blockers}\n`
        : "") +
      `\nWhat they reported today, in their own words:\n` +
      (detail.updates
        .map(
          (u) =>
            `- [${u.status}] ${u.task_title ?? "general"}: ` +
            (u.note_raw ? `"${u.note_raw}"` : "(status only)"),
        )
        .join("\n") || "  (nothing)") +
      (detail.assignedToday.length
        ? `\n\nGiven to them today:\n` +
          detail.assignedToday.map((a) => `- ${a.title} (from ${a.assigned_by})`).join("\n")
        : "") +
      (detail.carriedOver.length
        ? `\n\nCarried over from earlier days (age in days):\n` +
          detail.carriedOver
            .map((t) => `- ${t.title} — ${t.age_days}d old, last mentioned ${t.last_reported_at ? "before today" : "never"}`)
            .join("\n")
        : "") +
      (detail.silent.length
        ? `\n\nOpen but NOT mentioned by them today — say so plainly, this is the part a ` +
          `CEO cannot see anywhere else:\n` +
          detail.silent.map((t) => `- ${t.title} (${t.age_days}d old)`).join("\n")
        : "") +
      (detail.openBlockers.length
        ? `\n\nProblems still open (including from earlier days):\n` +
          detail.openBlockers
            .map(
              (b) =>
                `- ${b.severity} ${b.category}${b.affected_asset ? ` (${b.affected_asset})` : ""} [${b.status}]`,
            )
            .join("\n")
        : "") +
      (detail.addendum
        ? `\n\nThe person added this themselves before the report was written — treat it as ` +
          `fact and include it:\n"${detail.addendum}"`
        : "");

    try {
      const out = await llmComplete({
        messages: [
          {
            role: "system",
            content:
              "Write a short end-of-day summary for a CEO about ONE employee, in 3-5 sentences. " +
              "Use ONLY the facts given. Do not recount or invent any number — the counts are final. " +
              "Order: what was completed, then what is outstanding and how long it has been waiting, " +
              "then anything OPEN BUT NOT MENTIONED today (name those explicitly — the CEO cannot see " +
              "them any other way), then any problem and whether it is still open. " +
              "If work has been carried over for several days, say how many. " +
              "Do not pad, do not praise, do not speculate about why. " +
              'Plain English. Return JSON {"summary":"..."}.',
          },
          { role: "user", content: facts },
        ],
        schema: narrationSchema,
        operation: "eod_summary",
        maxTokens: 1200,
      });
      // The numeric-sanity gate, exactly as CLAUDE.md specifies for anything that states
      // numbers and has a query result behind it. This narrative reaches the CEO and is
      // asked to state derived quantities ("say how many days it was carried over"); the
      // prompt's "do not recount" is an instruction, not a check. Until 2026-09-18 the gate
      // ran only on the question box — the audit found this summary bypassing it.
      //
      // The rows are the facts the model was handed: the counts, the detail, and the date.
      // A failed gate does not fail the report; it re-derives — the counts sentence below is
      // computed, not narrated, and the failure is audited with the numbers that were not
      // in the facts.
      gate = numericSanityGate(out.summary, [c, detail, { day }]);
      if (gate.passed) {
        summary = out.summary;
      } else {
        summary =
          `${who[0].display_name} on ${day}: ${c.completed} completed, ${c.pending} pending, ` +
          `${c.blockers} blocker(s) from ${c.reports_made} report(s). ` +
          `(The written summary stated a number not in the facts and was withheld — the counts above are from the database.)`;
        await logAudit({
          actor: "system",
          action: "eod.gate_failed",
          entity: "employee",
          entityId: employeeId,
          detail: { day, missing: gate.missing, withheld: out.summary.slice(0, 500) },
        });
      }
    } catch {
      // The report is still useful without prose — the numbers are the point.
      summary =
        `${who[0].display_name} on ${day}: ${c.completed} completed, ${c.pending} pending, ` +
        `${c.blockers} blocker(s) from ${c.reports_made} report(s). ` +
        `(Narrative unavailable — the counts above are from the database.)`;
    }
  }

  await sql`
    insert into daily_report
      (employee_id, report_date, completed, pending, blockers, reports_made,
       summary, detail, is_synthetic)
    values (${employeeId}, ${day}::date, ${c.completed}, ${c.pending}, ${c.blockers},
            ${c.reports_made}, ${summary}, ${sql.json(detail as never)}, ${who[0].is_synthetic})
    on conflict (employee_id, report_date) do update
      set completed = excluded.completed, pending = excluded.pending,
          blockers = excluded.blockers, reports_made = excluded.reports_made,
          summary = excluded.summary, detail = excluded.detail,
          generated_at = now()`;

  await logAudit({
    actor: "system",
    action: "eod.generated",
    entity: "employee",
    entityId: employeeId,
    detail: {
      date: day,
      // Every gate decision is recorded with its run (CLAUDE.md "auditable").
      gateNumericSanity: gate.passed,
      completed: c.completed,
      pending: c.pending,
      blockers: c.blockers,
      silent: detail.silent.length,
      carriedOver: detail.carriedOver.length,
      hadAddendum: detail.addendum != null,
    },
  });

  return {
    previous: prev[0] ?? null,
    employeeId,
    displayName: who[0].display_name,
    reportDate: day,
    completed: c.completed,
    pending: c.pending,
    blockers: c.blockers,
    reportsMade: c.reports_made,
    summary,
    detail,
  };
}

/** Generate reports for everyone active. Used by the scheduled EOD job and by /eod. */
export async function generateAllEodReports(date?: string): Promise<EodReport[]> {
  const sql = getServiceSql();
  const people = await sql<{ id: string }[]>`
    select id from employee where status = 'active' order by is_synthetic, display_name`;
  const out: EodReport[] = [];
  for (const p of people) out.push(await generateEodReport(p.id, date));
  return out;
}

/** Format one report for Telegram. */
export function formatEodReport(r: EodReport): string {
  const move = r.previous
    ? ` _(yesterday ${r.previous.completed}/${r.previous.pending}/${r.previous.blockers})_`
    : "";
  const lines = [
    `📊 *${r.displayName}* — ${r.reportDate}`,
    "",
    `✅ ${r.completed} completed · ⏳ ${r.pending} pending · 🚫 ${r.blockers} blocker(s)${move}`,
    "",
    r.summary,
  ];

  if (r.detail.assignedToday.length) {
    lines.push(
      "",
      "*Given to them today:*",
      ...r.detail.assignedToday.map((a) => `• ${a.title} — from ${a.assigned_by}`),
    );
  }

  // Carry-over first, because age is what turns a pending task into a problem.
  if (r.detail.carriedOver.length) {
    lines.push(
      "",
      "*Carried over:*",
      ...r.detail.carriedOver.map((t) => `• ${t.title} — ${t.age_days}d`),
    );
  }

  // The line the CEO cannot get anywhere else.
  if (r.detail.silent.length) {
    lines.push(
      "",
      "*⚠️ Open but not mentioned today:*",
      ...r.detail.silent.map((t) => `• ${t.title} (${t.age_days}d)`),
    );
  }

  if (r.detail.openBlockers.length) {
    lines.push(
      "",
      "*Still blocked:*",
      ...r.detail.openBlockers.map(
        (b) => `• ${b.severity ?? "?"} ${b.category ?? "?"}${b.affected_asset ? ` — ${b.affected_asset}` : ""}`,
      ),
    );
  }

  if (r.detail.addendum) {
    lines.push("", `*They added:* "${r.detail.addendum}"`);
  }

  return lines.join("\n");
}
