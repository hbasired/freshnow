import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getServiceSql, withContext, type AppContext } from "./db.js";
import { canAssignTo, listAssignable, listOpenBlockersFor, loadViewer, updateOrg, type ViewerOrg } from "./org.js";
import { DEMO_CEO_ID } from "./meta.js";

/**
 * The org chart as an RLS boundary. These tests attack the boundary: for every role, what
 * must be visible AND what must not. A wrong predicate here leaks one employee's data to
 * a colleague, which is why each branch has a negative assertion, not only a positive one.
 *
 * The org under test (all names prefixed ORG- so cleanup is by prefix):
 *
 *   CEO
 *   ├─ MGR  (manager, production)     ─┬─ R1 (production)
 *   │                                  └─ R2 (delivery)   ← reports to MGR, different dept
 *   ├─ LEAD (lead, production)        ─── L1 (production) ← reports to LEAD
 *   ├─ P    (employee, production)                        ← same dept as LEAD, not a report
 *   └─ X    (employee, delivery)                          ← unrelated to everyone
 */

const ids = { MGR: randomUUID(), R1: randomUUID(), R2: randomUUID(), LEAD: randomUUID(), L1: randomUUID(), P: randomUUID(), X: randomUUID() };
const task: Record<string, string> = {};
const ctx: Record<string, AppContext> = {};

async function person(id: string, name: string, role: string, dept: string, manager: string | null) {
  await getServiceSql()`
    insert into employee (id, display_name, access_role, department, manager_employee_id, status, is_synthetic)
    values (${id}, ${"ORG-" + name}, ${role}, ${dept}, ${manager}, 'active', true)`;
}

beforeAll(async () => {
  const sql = getServiceSql();
  await person(ids.MGR, "Mgr", "manager", "production", DEMO_CEO_ID);
  await person(ids.LEAD, "Lead", "lead", "production", DEMO_CEO_ID);
  await person(ids.R1, "R1", "employee", "production", ids.MGR);
  await person(ids.R2, "R2", "employee", "delivery", ids.MGR);
  await person(ids.L1, "L1", "employee", "production", ids.LEAD);
  await person(ids.P, "P", "employee", "production", DEMO_CEO_ID);
  await person(ids.X, "X", "employee", "delivery", DEMO_CEO_ID);

  for (const [k, id] of Object.entries(ids)) {
    const [t] = await sql<{ id: string }[]>`
      insert into task (employee_id, title, status, is_synthetic) values (${id}, ${"ORG task " + k}, 'open', true) returning id`;
    task[k] = t!.id;
    await sql`insert into task_update (task_id, employee_id, status, is_synthetic) values (${t!.id}, ${id}, 'pending', true)`;
    await sql`insert into daily_report (employee_id, report_date, is_synthetic) values (${id}, current_date, true)`;
  }
  // A blocker raised by R1, routed to MGR; an assignment from MGR to R1.
  await sql`insert into blocker (raised_by, assigned_resolver, severity, status, is_synthetic) values (${ids.R1}, ${ids.MGR}, 'high', 'open', true)`;
  // Two more for the bot's queue: one from X (delivery, reports to the CEO) routed to MGR —
  // MGR must see it but may not read X's row — and one from P (production, CEO's report)
  // routed to nobody, which only the production LEAD and the CEO should see.
  await sql`insert into blocker (raised_by, assigned_resolver, severity, status, affected_asset, is_synthetic) values (${ids.X}, ${ids.MGR}, 'low', 'open', 'ORG van 9', true)`;
  await sql`insert into blocker (raised_by, severity, status, affected_asset, is_synthetic) values (${ids.P}, 'medium', 'open', 'ORG press 2', true)`;
  await sql`insert into assignment (task_id, assigned_by, assigned_to, status, is_synthetic) values (${task.R1!}, ${ids.MGR}, ${ids.R1}, 'assigned', true)`;

  for (const [k, id] of Object.entries(ids)) {
    const v = await loadViewer(id);
    ctx[k] = { employeeId: v!.employeeId, isCeo: v!.isCeo, accessRole: v!.accessRole, department: v!.department };
  }
});

afterAll(async () => {
  const sql = getServiceSql();
  const all = Object.values(ids);
  await sql`delete from assignment where assigned_to = any(${all}) or assigned_by = any(${all})`;
  await sql`delete from blocker where raised_by = any(${all})`;
  await sql`delete from daily_report where employee_id = any(${all})`;
  await sql`delete from task_update where employee_id = any(${all})`;
  await sql`delete from task where employee_id = any(${all})`;
  await sql`delete from audit_log where entity = 'employee' and entity_id = any(${all})`;
  await sql`delete from employee where id = any(${all})`;
  await closeDb();
});

/** Which of the org's people can this viewer see in `employee`? */
async function visibleNames(c: AppContext): Promise<string[]> {
  const rows = await withContext(c, (sql) => sql<{ display_name: string }[]>`
    select display_name from employee where display_name like 'ORG-%' order by display_name`);
  return rows.map((r) => r.display_name.replace("ORG-", ""));
}
async function visibleTasks(c: AppContext): Promise<string[]> {
  const rows = await withContext(c, (sql) => sql<{ title: string }[]>`
    select title from task where title like 'ORG task %' order by title`);
  return rows.map((r) => r.title.replace("ORG task ", ""));
}

describe("who sees whom (employee, task, task_update, daily_report)", () => {
  it("an employee sees only themselves", async () => {
    expect(await visibleNames(ctx.X!)).toEqual(["X"]);
    expect(await visibleTasks(ctx.X!)).toEqual(["X"]);
  });

  it("a manager sees their direct reports across departments, and nobody else", async () => {
    expect(await visibleNames(ctx.MGR!)).toEqual(["Mgr", "R1", "R2"]);
    expect(await visibleTasks(ctx.MGR!)).toEqual(["MGR", "R1", "R2"]);
    // Negative: P is in the same department as MGR but is not a report — a manager is not a lead.
    expect(await visibleNames(ctx.MGR!)).not.toContain("P");
  });

  it("a lead sees their reports and their whole department, but not another department", async () => {
    const seen = await visibleNames(ctx.LEAD!);
    expect(seen).toEqual(["L1", "Lead", "Mgr", "P", "R1"]); // production: LEAD, L1, MGR, P, R1
    expect(seen).not.toContain("R2"); // delivery
    expect(seen).not.toContain("X"); // delivery
  });

  it("a report cannot see their manager, or a sibling report", async () => {
    expect(await visibleNames(ctx.R1!)).toEqual(["R1"]);
    expect(await visibleTasks(ctx.R1!)).toEqual(["R1"]);
  });

  it("the same predicate governs task_update and daily_report", async () => {
    const mgrUpdates = await withContext(ctx.MGR!, (sql) => sql<{ n: number }[]>`
      select count(*)::int as n from task_update where employee_id = any(${Object.values(ids)})`);
    expect(mgrUpdates[0]?.n).toBe(3); // MGR, R1, R2
    const leadReports = await withContext(ctx.LEAD!, (sql) => sql<{ n: number }[]>`
      select count(*)::int as n from daily_report where employee_id = any(${Object.values(ids)})`);
    expect(leadReports[0]?.n).toBe(5);
    const xReports = await withContext(ctx.X!, (sql) => sql<{ n: number }[]>`
      select count(*)::int as n from daily_report where employee_id = any(${Object.values(ids)})`);
    expect(xReports[0]?.n).toBe(1);
  });

  it("the CEO still sees everyone", async () => {
    const ceo: AppContext = { employeeId: DEMO_CEO_ID, isCeo: true, accessRole: "ceo", department: null };
    expect((await visibleNames(ceo)).length).toBe(7);
  });

  it("a context with no role is treated as the most restrictive one", async () => {
    // Forgetting to pass the role can only hide rows, never reveal them.
    expect(await visibleNames({ employeeId: ids.LEAD })).toEqual(["Lead"]);
  });
});

describe("blockers and assignments", () => {
  it("a manager sees a report's blocker; the resolver sees it; an unrelated employee does not", async () => {
    const count = (c: AppContext) =>
      withContext(c, (sql) => sql<{ n: number }[]>`select count(*)::int as n from blocker where raised_by = ${ids.R1}`);
    expect((await count(ctx.MGR!))[0]?.n).toBe(1);
    expect((await count(ctx.LEAD!))[0]?.n).toBe(1); // R1 is in production
    expect((await count(ctx.R1!))[0]?.n).toBe(1);
    expect((await count(ctx.X!))[0]?.n).toBe(0);
    expect((await count(ctx.P!))[0]?.n).toBe(0);
  });

  it("an assignment is visible to the giver, the receiver, and anyone who may see the receiver", async () => {
    const count = (c: AppContext) =>
      withContext(c, (sql) => sql<{ n: number }[]>`select count(*)::int as n from assignment where assigned_to = ${ids.R1}`);
    expect((await count(ctx.MGR!))[0]?.n).toBe(1);
    expect((await count(ctx.R1!))[0]?.n).toBe(1);
    expect((await count(ctx.LEAD!))[0]?.n).toBe(1);
    expect((await count(ctx.R2!))[0]?.n).toBe(0);
  });
});

describe("the bot's two lists — the same rule, shaped for a keyboard", () => {
  const viewer = async (id: string): Promise<ViewerOrg> => (await loadViewer(id))!;
  const names = (rows: { display_name: string }[]) => rows.map((r) => r.display_name.replace("ORG-", "")).sort();

  it("listAssignable: CEO everyone but self; manager their reports; lead reports + department; employee nobody", async () => {
    const ceo = await listAssignable(await viewer(DEMO_CEO_ID), 500);
    expect(ceo.some((p) => p.id === DEMO_CEO_ID)).toBe(false);
    expect(names(ceo.filter((p) => p.display_name.startsWith("ORG-")))).toEqual(["L1", "Lead", "Mgr", "P", "R1", "R2", "X"]);

    expect(names(await listAssignable(await viewer(ids.MGR)))).toEqual(["R1", "R2"]);
    // LEAD: own report L1, plus production (MGR, R1, P) — not R2 or X in delivery, not self.
    expect(names(await listAssignable(await viewer(ids.LEAD)))).toEqual(["L1", "Mgr", "P", "R1"]);
    expect(await listAssignable(await viewer(ids.R1))).toEqual([]);
  });

  it("listOpenBlockersFor: a manager's queue is their team plus what was routed to them, with a stranger's name withheld", async () => {
    const mine = (rows: { summary: string | null; raised_by_name: string }[]) =>
      rows.filter((r) => r.raised_by_name.startsWith("ORG-") || (r.summary ?? "").startsWith("ORG"));

    const mgr = mine(await listOpenBlockersFor(await viewer(ids.MGR), 500));
    expect(mgr.map((b) => b.raised_by_name).sort()).toEqual(["ORG-R1", "someone outside your team"]);
    expect(mgr.find((b) => b.summary === "ORG van 9")?.raised_by_name).toBe("someone outside your team");

    const lead = mine(await listOpenBlockersFor(await viewer(ids.LEAD), 500));
    expect(lead.map((b) => b.raised_by_name).sort()).toEqual(["ORG-P", "ORG-R1"]); // production only; X's is delivery

    expect(mine(await listOpenBlockersFor(await viewer(DEMO_CEO_ID), 500)).length).toBe(3);
    expect(await listOpenBlockersFor(await viewer(ids.R1), 500)).toEqual([]); // employees get no queue at all
  });
});

describe("canAssignTo — the write-side twin of the policy", () => {
  it("manager → own report yes, non-report no; lead → department yes, other department no; employee → self only", async () => {
    const mgr = (await loadViewer(ids.MGR))!;
    const lead = (await loadViewer(ids.LEAD))!;
    const x = (await loadViewer(ids.X))!;
    expect(await canAssignTo(mgr, ids.R1)).toBe(true);
    expect(await canAssignTo(mgr, ids.R2)).toBe(true);
    expect(await canAssignTo(mgr, ids.P)).toBe(false);
    expect(await canAssignTo(lead, ids.P)).toBe(true);
    expect(await canAssignTo(lead, ids.X)).toBe(false);
    expect(await canAssignTo(x, ids.X)).toBe(true);
    expect(await canAssignTo(x, ids.P)).toBe(false);
  });
});

describe("the reporting line cannot loop", () => {
  it("refuses a manager change that would form a cycle, and self-management", async () => {
    // MGR reports to the CEO; making the CEO... no. Make R1 the manager of MGR: MGR → R1 → MGR.
    await expect(updateOrg({ employeeId: ids.MGR, managerEmployeeId: ids.R1, by: DEMO_CEO_ID })).rejects.toThrow(/cycle/);
    await expect(updateOrg({ employeeId: ids.X, managerEmployeeId: ids.X, by: DEMO_CEO_ID })).rejects.toThrow(/own manager/);
    // The rejected writes changed nothing.
    const [row] = await getServiceSql()<{ manager_employee_id: string }[]>`
      select manager_employee_id from employee where id = ${ids.MGR}`;
    expect(row?.manager_employee_id).toBe(DEMO_CEO_ID);
  });

  it("records an org change with before and after", async () => {
    await updateOrg({ employeeId: ids.X, accessRole: "manager", by: DEMO_CEO_ID });
    const [audit] = await getServiceSql()<{ detail: { before: { access_role: string }; after: { access_role: string } } }[]>`
      select detail from audit_log where action = 'employee.org_updated' and entity_id = ${ids.X} order by created_at desc limit 1`;
    expect(audit?.detail.before.access_role).toBe("employee");
    expect(audit?.detail.after.access_role).toBe("manager");
  });
});
