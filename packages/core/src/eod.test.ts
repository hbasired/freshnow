import { companyToday } from "./time.js";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb, getServiceSql } from "./db.js";
import { formatEodReport, generateEodReport } from "./eod.js";
import { assignTask, createTask, recordTaskUpdate } from "./updates.js";

async function makeEmployee(name: string): Promise<string> {
  const sql = getServiceSql();
  const rows = await sql<{ id: string }[]>`
    insert into employee (display_name, status, is_synthetic)
    values (${name}, 'active', true) returning id`;
  return rows[0]!.id;
}

// The company day, exactly as the code computes it. `new Date().toISOString()` is the UTC date,
// which differs from Dubai between 00:00 and 04:00 — every test here failed at 00:35 Dubai.
const today = companyToday();

afterAll(async () => {
  const sql = getServiceSql();
  const mine = `select id from employee where display_name like 'EOD-%'`;
  await sql`delete from notification_outbox where idempotency_key like 'needs-review-%' or idempotency_key like 'task.%'`;
  await sql.unsafe(`delete from assignment where assigned_to in (${mine}) or assigned_by in (${mine})`);
  await sql.unsafe(`delete from daily_report where employee_id in (${mine})`);
  await sql.unsafe(`delete from blocker where raised_by in (${mine})`);
  await sql.unsafe(`delete from task_update where employee_id in (${mine})`);
  await sql.unsafe(`delete from task where employee_id in (${mine})`);
  await sql.unsafe(`delete from employee where id in (${mine})`);
  await closeDb();
});

describe("end-of-day report", () => {
  it("counts what was actually reported, in SQL", async () => {
    const who = await makeEmployee("EOD-counts");
    const t1 = await createTask(who, "EOD task one", true);
    const t2 = await createTask(who, "EOD task two", true);
    const t3 = await createTask(who, "EOD task three", true);

    await recordTaskUpdate({ taskId: t1, employeeId: who, status: "done" });
    await recordTaskUpdate({ taskId: t2, employeeId: who, status: "done" });
    await recordTaskUpdate({ taskId: t3, employeeId: who, status: "pending" });

    const r = await generateEodReport(who, today);

    // The numbers come from Postgres over every row — not from a model reading them.
    expect(r.completed).toBe(2);
    expect(r.pending).toBe(1);
    expect(r.reportsMade).toBe(3);
    // Two tasks were reported done, so only the third is still open.
    expect(r.detail.openTasks.map((t) => t.title)).toEqual(["EOD task three"]);
  });

  it("stores the report and replaces it when the day is regenerated", async () => {
    const who = await makeEmployee("EOD-rerun");
    const t = await createTask(who, "EOD rerun task", true);
    await recordTaskUpdate({ taskId: t, employeeId: who, status: "pending" });

    await generateEodReport(who, today);
    await recordTaskUpdate({ taskId: t, employeeId: who, status: "done" });
    const second = await generateEodReport(who, today);

    const sql = getServiceSql();
    const rows = await sql<{ completed: number; pending: number }[]>`
      select completed, pending from daily_report
      where employee_id = ${who} and report_date = ${today}::date`;
    // Regenerating replaces the day rather than adding a second row for it.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.completed).toBe(second.completed);
    expect(second.completed).toBe(1);
  });

  it("says plainly when someone reported nothing, rather than inventing a day", async () => {
    const who = await makeEmployee("EOD-silent");
    const r = await generateEodReport(who, today);

    expect(r.completed).toBe(0);
    expect(r.reportsMade).toBe(0);
    expect(r.summary).toContain("did not report");
    // No model call is needed to say nothing happened, so this path cannot fabricate.
    expect(formatEodReport(r)).toContain("EOD-silent");
  });
});

describe("end-of-day counting rules", () => {
  it("counts work items, not messages, when someone reports repeatedly", async () => {
    const who = await makeEmployee("EOD-chatty");
    const t = await createTask(who, "EOD chatty task", true);

    // Three messages about the SAME job. The CEO has one pending item, not three.
    await recordTaskUpdate({ taskId: t, employeeId: who, status: "pending" });
    await recordTaskUpdate({ taskId: t, employeeId: who, status: "pending" });
    await recordTaskUpdate({ taskId: t, employeeId: who, status: "pending" });

    const r = await generateEodReport(who, today);
    expect(r.pending).toBe(1);
    expect(r.reportsMade).toBe(3);
  });

  it("counts a blocker that was detected inside an ordinary message", async () => {
    const who = await makeEmployee("EOD-hidden");
    const t = await createTask(who, "EOD hidden blocker task", true);
    const rec = await recordTaskUpdate({
      taskId: t,
      employeeId: who,
      status: "pending",
      noteRaw: "chiller not cooling",
    });

    // The parser found a real problem even though the reported status was 'pending'.
    const sql = getServiceSql();
    await sql`insert into blocker (task_update_id, raised_by, category, severity, status, is_synthetic)
              values (${rec.taskUpdateId}, ${who}, 'equipment', 'high', 'open', true)`;

    const r = await generateEodReport(who, today);
    // Counting the button tap instead reported zero blockers on a day one escalated.
    expect(r.blockers).toBe(1);
    expect(r.detail.blockers).toHaveLength(1);
  });
});

describe("end-of-day context", () => {
  it("names open tasks the person said nothing about today", async () => {
    const who = await makeEmployee("EOD-silent-task");
    const spoken = await createTask(who, "EOD task they mentioned", true);
    await createTask(who, "EOD task they ignored", true);

    await recordTaskUpdate({ taskId: spoken, employeeId: who, status: "pending" });

    const r = await generateEodReport(who, today);

    // The most useful line in the report: work nobody mentions is how things quietly
    // stall, and it is invisible in any view built only from what people DID say.
    expect(r.detail.silent.map((t) => t.title)).toEqual(["EOD task they ignored"]);
    expect(r.detail.openTasks).toHaveLength(2);
  });

  it("separates work carried over from earlier days, with its age", async () => {
    const who = await makeEmployee("EOD-carry");
    const sql = getServiceSql();
    const [old] = await sql<{ id: string }[]>`
      insert into task (employee_id, title, status, is_synthetic, created_at)
      values (${who}, 'EOD old task', 'open', true, now() - interval '4 days') returning id`;
    await createTask(who, "EOD task from today", true);

    const r = await generateEodReport(who, today);

    expect(r.detail.carriedOver.map((t) => t.title)).toEqual(["EOD old task"]);
    expect(r.detail.carriedOver[0]!.age_days).toBe(4);
    expect(old).toBeDefined();
  });

  it("records what the person added before the report was written", async () => {
    const who = await makeEmployee("EOD-note");
    const t = await createTask(who, "EOD addendum task", true);
    await recordTaskUpdate({ taskId: t, employeeId: who, status: "pending" });

    const note = "The replacement part only arrives Sunday, so Monday is blocked too.";
    const r = await generateEodReport(who, today, note);

    // Stored verbatim — context that exists only in someone's head is otherwise lost.
    expect(r.detail.addendum).toBe(note);
    expect(formatEodReport(r)).toContain("arrives Sunday");
  });

  it("lists work handed to them that day", async () => {
    const ceo = await makeEmployee("EOD-giver");
    const who = await makeEmployee("EOD-receiver");
    await assignTask({ assignedBy: ceo, assignedTo: who, title: "EOD assigned job" });

    const r = await generateEodReport(who, today);
    expect(r.detail.assignedToday.map((a) => a.title)).toContain("EOD assigned job");
  });
});
