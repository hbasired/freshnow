import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, getServiceSql, withContext } from "./db.js";
import { DEMO_CEO_ID } from "./meta.js";
import {
  addMilestone,
  addProjectMember,
  addProjectUpdate,
  addRequirement,
  canContributeToProject,
  canManageProject,
  createProject,
  projectSweep,
  raiseProjectIssue,
  resolveProjectIssue,
  setMilestoneStatus,
  setProjectHealth,
  setTaskProject,
} from "./projects.js";
import { loadViewer } from "./org.js";
import { recomputeProgress } from "./progress.js";

/**
 * A project's numbers must come from its rows. These tests check the arithmetic against
 * hand-counted fixtures, the refusals that stop a project reporting itself green, and who
 * may see what.
 */
const TAG = "PRJTEST";
const today = () => new Date().toISOString().slice(0, 10);
const daysFrom = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

async function person(name: string, role = "employee", manager: string | null = null): Promise<string> {
  const id = randomUUID();
  await getServiceSql()`
    insert into employee (id, display_name, status, access_role, manager_employee_id, department, is_synthetic)
    values (${id}, ${`${TAG} ${name}`}, 'active', ${role}, ${manager}, 'production', true)`;
  return id;
}

async function task(owner: string, projectId: string | null, milestoneId: string | null, status = "open"): Promise<string> {
  const rows = await getServiceSql()<{ id: string }[]>`
    insert into task (employee_id, title, status, project_id, milestone_id, is_synthetic)
    values (${owner}, ${`${TAG} task`}, ${status}, ${projectId}, ${milestoneId}, true)
    returning id`;
  const id = rows[0]!.id;
  // The same call every real write path makes, so the stored percentage matches the status
  // instead of being whatever a raw INSERT left behind.
  await recomputeProgress(id);
  return id;
}

const viewerOf = async (id: string) => (await loadViewer(id))!;

afterEach(async () => {
  const sql = getServiceSql();
  const tag = `${TAG} %`;
  await sql`delete from notification_outbox where recipient_employee_id in (select id from employee where display_name like ${tag})`;
  await sql`delete from task where title = ${`${TAG} task`}`;
  // project children cascade with the project
  await sql`delete from project where name like ${tag}`;
  await sql`delete from employee where display_name like ${tag}`;
  await sql`delete from audit_log where actor like ${"employee:%"} and entity = 'project'`;
});
afterAll(async () => {
  await closeDb();
});

describe("progress is computed from the rows, never typed", () => {
  it("with no milestones, a project's percentage is the average of its tasks' own percentages", async () => {
    const lead = await person("lead", "manager");
    const { projectId } = await createProject({ name: `${TAG} juice line`, by: lead, leadEmployeeId: lead });
    await task(lead, projectId, null, "done"); // 100 by status
    await task(lead, projectId, null, "in_progress"); // 50
    await task(lead, projectId, null, "open"); // 0

    const sql = getServiceSql();
    const rows = await sql<{ progress_pct: number; progress_source: string; tasks_total: number; tasks_done: number }[]>`
      select progress_pct, progress_source, tasks_total, tasks_done from project_progress where project_id = ${projectId}`;
    expect(rows[0]).toMatchObject({ progress_pct: 50, progress_source: "tasks", tasks_total: 3, tasks_done: 1 });
  });

  it("with milestones, the percentage is weighted by their weights and says so", async () => {
    const lead = await person("lead", "manager");
    const { projectId } = await createProject({ name: `${TAG} bottling`, by: lead, leadEmployeeId: lead });
    const big = await addMilestone({ projectId, name: "Install", weight: 3, by: lead });
    const small = await addMilestone({ projectId, name: "Sign off", weight: 1, by: lead });
    await setMilestoneStatus({ milestoneId: big.id, status: "done", by: lead });

    const sql = getServiceSql();
    const rows = await sql<{ progress_pct: number; progress_source: string; milestones_done: number }[]>`
      select progress_pct, progress_source, milestones_done from project_progress where project_id = ${projectId}`;
    // 3 of 4 weight done — not "one of two milestones".
    expect(rows[0]).toMatchObject({ progress_pct: 75, progress_source: "milestones", milestones_done: 1 });
    expect(small.id).toBeTruthy();
  });

  it("schedule_elapsed_pct is NULL without dates, and a project behind its plan is flagged", async () => {
    const lead = await person("lead", "manager");
    const noDates = await createProject({ name: `${TAG} undated`, by: lead, leadEmployeeId: lead });
    const dated = await createProject({
      name: `${TAG} dated`, by: lead, leadEmployeeId: lead,
      startDate: daysFrom(-9), targetDate: daysFrom(1),
    });
    await task(lead, dated.projectId, null, "open"); // 0% done, 90% of the time gone

    const sql = getServiceSql();
    const a = await sql<{ schedule_elapsed_pct: number | null }[]>`
      select schedule_elapsed_pct from project_progress where project_id = ${noDates.projectId}`;
    expect(a[0]?.schedule_elapsed_pct).toBeNull(); // an unknown is not zero

    const b = await sql<{ schedule_elapsed_pct: number; progress_pct: number }[]>`
      select schedule_elapsed_pct, progress_pct from project_progress where project_id = ${dated.projectId}`;
    expect(b[0]!.schedule_elapsed_pct).toBeGreaterThanOrEqual(85);
    expect(b[0]!.schedule_elapsed_pct - b[0]!.progress_pct).toBeGreaterThan(30); // what "behind" means
  });

  it("a reported percentage is stored beside the computed one, not instead of it", async () => {
    const lead = await person("lead", "manager");
    const { projectId } = await createProject({ name: `${TAG} claims`, by: lead, leadEmployeeId: lead });
    await task(lead, projectId, null, "open"); // computed 0

    const r = await addProjectUpdate({ projectId, narrative: "Nearly there", pctReported: 90, by: lead });
    expect(r.computedPct).toBe(0);

    const sql = getServiceSql();
    const stored = await sql<{ pct_reported: number }[]>`
      select pct_reported from project_update where id = ${r.id}`;
    expect(stored[0]?.pct_reported).toBe(90);
    const computed = await sql<{ progress_pct: number }[]>`
      select progress_pct from project_progress where project_id = ${projectId}`;
    expect(computed[0]?.progress_pct).toBe(0); // the claim did not move the computed number
    const audit = await sql<{ detail: { pctReported: number; computedPct: number } }[]>`
      select detail from audit_log where action = 'project.update_added' and entity_id = ${projectId}`;
    expect(audit[0]?.detail).toMatchObject({ pctReported: 90, computedPct: 0 });
  });
});

describe("the refusals that stop a project reporting itself green", () => {
  it("a milestone with unfinished work under it cannot be ticked without saying so", async () => {
    const lead = await person("lead", "manager");
    const { projectId } = await createProject({ name: `${TAG} gate`, by: lead, leadEmployeeId: lead });
    const m = await addMilestone({ projectId, name: "Ready", by: lead });
    await task(lead, projectId, m.id, "open");

    await expect(setMilestoneStatus({ milestoneId: m.id, status: "done", by: lead })).rejects.toThrow(/not finished/);
    // Forcing works, and records that it was forced and how much was open at the time.
    await setMilestoneStatus({ milestoneId: m.id, status: "done", by: lead, force: true });
    const sql = getServiceSql();
    const audit = await sql<{ detail: { forced: boolean; openTasksAtTheTime: number } }[]>`
      select detail from audit_log where action = 'project.milestone_status' and entity_id = ${projectId}`;
    expect(audit[0]?.detail).toMatchObject({ forced: true, openTasksAtTheTime: 1 });
  });

  it("health needs a reason, and turning red tells the project", async () => {
    const lead = await person("lead", "manager");
    const member = await person("member");
    const { projectId } = await createProject({ name: `${TAG} red`, by: lead, leadEmployeeId: lead });
    await addProjectMember({ projectId, employeeId: member });

    await expect(setProjectHealth({ projectId, health: "red", note: "x", by: lead })).rejects.toThrow(/why/i);
    await setProjectHealth({ projectId, health: "red", note: "Supplier slipped two weeks", by: lead });

    const sql = getServiceSql();
    const told = await sql<{ recipient_employee_id: string; reason: string }[]>`
      select recipient_employee_id, reason from notification_outbox
      where recipient_employee_id = ${member} and payload->>'kind' = 'project'`;
    expect(told[0]?.reason).toBe("member of the project");
  });

  it("an update and an issue both need words, and a resolved issue cannot be resolved twice", async () => {
    const lead = await person("lead", "manager");
    const { projectId } = await createProject({ name: `${TAG} words`, by: lead, leadEmployeeId: lead });
    await expect(addProjectUpdate({ projectId, narrative: "  ", by: lead })).rejects.toThrow();
    await expect(raiseProjectIssue({ projectId, title: "x", by: lead })).rejects.toThrow();

    const i = await raiseProjectIssue({ projectId, title: "Supplier may be late", kind: "risk", severity: "high", by: lead });
    await expect(resolveProjectIssue({ issueId: i.id, status: "resolved", note: "Supplier confirmed the date", by: lead })).resolves.toBeUndefined();
    await expect(resolveProjectIssue({ issueId: i.id, status: "resolved", note: "again", by: lead })).rejects.toThrow(/already resolved/);
  });

  it("a task cannot be filed under a milestone belonging to another project", async () => {
    const lead = await person("lead", "manager");
    const a = await createProject({ name: `${TAG} one`, by: lead, leadEmployeeId: lead });
    const b = await createProject({ name: `${TAG} two`, by: lead, leadEmployeeId: lead });
    const m = await addMilestone({ projectId: b.projectId, name: "Elsewhere", by: lead });
    const t = await task(lead, null, null);
    await expect(setTaskProject({ taskId: t, projectId: a.projectId, milestoneId: m.id, by: lead }))
      .rejects.toThrow(/different project/);
  });
});

describe("who may see and change a project", () => {
  it("members and the people who can see its lead; not a stranger", async () => {
    const boss = await person("boss", "manager");
    const lead = await person("lead", "employee", boss);
    const member = await person("member");
    const stranger = await person("stranger");
    const { projectId } = await createProject({ name: `${TAG} visible`, by: lead, leadEmployeeId: lead });
    await addProjectMember({ projectId, employeeId: member });

    const sees = async (who: string) =>
      (await withContext(await viewerOf(who), (sql) => sql`select 1 from project where id = ${projectId}`)).length;
    expect(await sees(lead)).toBe(1);
    expect(await sees(member)).toBe(1);
    expect(await sees(boss)).toBe(1); // can see the lead, so can see their project
    expect(await sees(stranger)).toBe(0);
    expect(
      (await withContext({ employeeId: DEMO_CEO_ID, isCeo: true }, (sql) => sql`select 1 from project where id = ${projectId}`)).length,
    ).toBe(1);
  });

  it("the lead and their manager may change the plan; an ordinary member may only contribute", async () => {
    const boss = await person("boss", "manager");
    const lead = await person("lead", "employee", boss);
    const member = await person("member");
    const stranger = await person("stranger");
    const { projectId } = await createProject({ name: `${TAG} rights`, by: lead, leadEmployeeId: lead });
    await addProjectMember({ projectId, employeeId: member });

    expect(await canManageProject(await viewerOf(lead), projectId)).toBe(true);
    expect(await canManageProject(await viewerOf(boss), projectId)).toBe(true);
    expect(await canManageProject(await viewerOf(member), projectId)).toBe(false);
    expect(await canContributeToProject(await viewerOf(member), projectId)).toBe(true);
    expect(await canContributeToProject(await viewerOf(stranger), projectId)).toBe(false);
  });

  it("a project's updates and issues are hidden from a stranger", async () => {
    const lead = await person("lead", "manager");
    const stranger = await person("stranger");
    const { projectId } = await createProject({ name: `${TAG} private`, by: lead, leadEmployeeId: lead });
    await addProjectUpdate({ projectId, narrative: "Week one went well", by: lead });
    await raiseProjectIssue({ projectId, title: "A risk worth knowing", by: lead });
    await addRequirement({ projectId, text: "Must fill 500 bottles an hour", priority: "must", by: lead });

    const asStranger = await viewerOf(stranger);
    for (const table of ["project_update", "project_issue", "project_requirement"] as const) {
      const rows = await withContext(asStranger, (sql) => sql.unsafe(`select 1 from ${table} where project_id = '${projectId}'`));
      expect(rows.length).toBe(0);
    }
    const asLead = await viewerOf(lead);
    const mine = await withContext(asLead, (sql) => sql`select 1 from project_update where project_id = ${projectId}`);
    expect(mine.length).toBe(1);
  });
});

describe("the sweeps", () => {
  it("tells the project about an overdue milestone, once per day", async () => {
    const lead = await person("lead", "manager");
    const { projectId } = await createProject({ name: `${TAG} late`, by: lead, leadEmployeeId: lead });
    const sql = getServiceSql();
    await sql`update project set status = 'active' where id = ${projectId}`;
    const m = await addMilestone({ projectId, name: "Was due", dueDate: daysFrom(-2), by: lead });
    await task(lead, projectId, m.id, "open");

    const first = await projectSweep();
    expect(first.milestonesOverdue).toBeGreaterThanOrEqual(1);
    const told = await sql<{ n: number }[]>`
      select count(*)::int as n from notification_outbox
      where idempotency_key like ${`project.milestone_overdue:${m.id}:${today()}%`}`;
    expect(told[0]!.n).toBeGreaterThan(0);

    // Running it again the same day tells nobody twice.
    const before = told[0]!.n;
    await projectSweep();
    const after = await sql<{ n: number }[]>`
      select count(*)::int as n from notification_outbox
      where idempotency_key like ${`project.milestone_overdue:${m.id}:${today()}%`}`;
    expect(after[0]!.n).toBe(before);
  });

  it("flags an active project with no status update", async () => {
    const lead = await person("lead", "manager");
    const { projectId } = await createProject({ name: `${TAG} quiet`, by: lead, leadEmployeeId: lead });
    const sql = getServiceSql();
    await sql`update project set status = 'active' where id = ${projectId}`;
    const r = await projectSweep();
    expect(r.projectsStale).toBeGreaterThanOrEqual(1);
    const told = await sql<{ n: number }[]>`
      select count(*)::int as n from notification_outbox
      where idempotency_key like ${`project.stale:${projectId}:${today()}%`}`;
    expect(told[0]!.n).toBeGreaterThan(0);
  });
});

describe("flow metrics", () => {
  it("counts WIP, throughput and cycle-time percentiles for a project's own work", async () => {
    const lead = await person("lead", "manager");
    const { projectId } = await createProject({ name: `${TAG} flow`, by: lead, leadEmployeeId: lead });
    const sql = getServiceSql();
    await task(lead, projectId, null, "in_progress");
    await task(lead, projectId, null, "in_progress");
    await task(lead, projectId, null, "open");
    const d1 = await task(lead, projectId, null, "done");
    const d2 = await task(lead, projectId, null, "done");
    // Two finished items, two and six days long.
    await sql`update task set started_at = now() - interval '2 days', resolved_at = now() where id = ${d1}`;
    await sql`update task set started_at = now() - interval '6 days', resolved_at = now() where id = ${d2}`;

    const rows = await sql<
      { wip: number; open_total: number; throughput_7d: number; cycle_p50_days: string; finished_total: number }[]
    >`select wip, open_total, throughput_7d, cycle_p50_days, finished_total from flow_metrics where project_id = ${projectId}`;
    expect(rows[0]).toMatchObject({ wip: 2, open_total: 3, throughput_7d: 2, finished_total: 2 });
    expect(Number(rows[0]!.cycle_p50_days)).toBeCloseTo(4, 0); // the median of 2 and 6
  });
});
