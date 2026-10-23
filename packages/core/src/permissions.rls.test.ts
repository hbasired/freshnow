import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getServiceSql, withContext, type AppContext } from "./db.js";
import { DEMO_CEO_ID } from "./meta.js";
import { loadViewer } from "./org.js";
import { ACCESS_ROLES, CAPABILITIES, can } from "./permissions.js";

/**
 * The roles as a row-level-security boundary (TASK-057, migration 0025) — against the real
 * throwaway Postgres, never mocked. Two things are checked:
 *
 *   1. The twin: for every role and every capability, Postgres (role_capability through
 *      app_has_capability) answers exactly what the code (permissions.ts) answers.
 *   2. For every role, what it sees AND what it does not, in people, tasks, projects, the audit
 *      log and the Televend mirror.
 *
 * The org under test (names prefixed PERM- so cleanup is by prefix):
 *
 *   CEO
 *   ├─ ADMIN (admin)
 *   ├─ OPS   (ops_head) ─┬─ SUP (supervisor) ── VMO (vmo)
 *   │                    └─ TECH (technician)
 *   ├─ CASH  (cash_auditor)
 *   ├─ WH    (warehouse_keeper)
 *   ├─ LEAD  (lead, kitchen)
 *   └─ COOK  (employee, kitchen)   ← LEAD's department, not LEAD's report
 */

const ids = {
  ADMIN: randomUUID(),
  OPS: randomUUID(),
  SUP: randomUUID(),
  VMO: randomUUID(),
  TECH: randomUUID(),
  CASH: randomUUID(),
  WH: randomUUID(),
  LEAD: randomUUID(),
  COOK: randomUUID(),
};
type Who = keyof typeof ids;
const ctx = {} as Record<Who | "CEO", AppContext>;
const vendId = `PERM-${randomUUID()}`;
let projectId = "";

async function person(id: string, name: string, role: string, dept: string | null, manager: string | null): Promise<void> {
  await getServiceSql()`
    insert into employee (id, display_name, access_role, department, manager_employee_id, status, is_synthetic)
    values (${id}, ${"PERM-" + name}, ${role}, ${dept}, ${manager}, 'active', true)`;
}

beforeAll(async () => {
  const sql = getServiceSql();
  await person(ids.ADMIN, "ADMIN", "admin", null, DEMO_CEO_ID);
  await person(ids.OPS, "OPS", "ops_head", "operations", DEMO_CEO_ID);
  await person(ids.SUP, "SUP", "supervisor", "operations", ids.OPS);
  await person(ids.VMO, "VMO", "vmo", "operations", ids.SUP);
  await person(ids.TECH, "TECH", "technician", "operations", ids.OPS);
  await person(ids.CASH, "CASH", "cash_auditor", "finance", DEMO_CEO_ID);
  await person(ids.WH, "WH", "warehouse_keeper", "warehouse", DEMO_CEO_ID);
  await person(ids.LEAD, "LEAD", "lead", "kitchen", DEMO_CEO_ID);
  await person(ids.COOK, "COOK", "employee", "kitchen", DEMO_CEO_ID);
  for (const [k, id] of Object.entries(ids)) {
    await sql`insert into task (employee_id, title, status, is_synthetic) values (${id}, ${"PERM task " + k}, 'open', true)`;
  }
  // A project led by COOK: visible to the CEO, Admin, and LEAD (COOK is in LEAD's department).
  projectId = (await sql<{ id: string }[]>`
    insert into project (name, lead_employee_id, is_synthetic) values ('PERM project', ${ids.COOK}, true) returning id`)[0]!.id;
  await sql`insert into tv_vend (source, external_id, machine_tv_id, at, payment_type, quantity, raw)
    values ('bridge', ${vendId}, 1, now(), 0, 1, '{}'::jsonb)`;
  await sql`insert into audit_log (correlation_id, actor, action, entity, entity_id)
    values (${randomUUID()}, 'test:permissions', 'perm.test', 'employee', ${ids.COOK})`;

  ctx.CEO = { employeeId: DEMO_CEO_ID, isCeo: true, accessRole: "ceo", department: null };
  for (const [k, id] of Object.entries(ids)) {
    const v = await loadViewer(id);
    ctx[k as Who] = { employeeId: v!.employeeId, isCeo: v!.isCeo, accessRole: v!.accessRole, department: v!.department };
  }
});

afterAll(async () => {
  const sql = getServiceSql();
  const all = Object.values(ids);
  await sql`delete from project where id = ${projectId}`;
  await sql`delete from tv_vend where external_id = ${vendId}`;
  await sql`delete from task where employee_id = any(${all})`;
  await sql`delete from audit_log where actor = 'test:permissions' or (entity = 'employee' and entity_id = any(${all}))`;
  // Children before parents: the reporting line points inside the set.
  await sql`update employee set manager_employee_id = null where id = any(${all})`;
  await sql`delete from employee where id = any(${all})`;
  await closeDb();
});

const names = async (c: AppContext): Promise<string[]> =>
  (await withContext(c, (sql) => sql<{ display_name: string }[]>`
    select display_name from employee where display_name like 'PERM-%' order by display_name`)).map((r) => r.display_name.slice(5));
const tasks = async (c: AppContext): Promise<string[]> =>
  (await withContext(c, (sql) => sql<{ title: string }[]>`
    select title from task where title like 'PERM task %' order by title`)).map((r) => r.title.slice(10));
const count = async (c: AppContext, q: "vend" | "audit" | "project"): Promise<number> =>
  (await withContext(c, (sql) =>
    q === "vend"
      ? sql<{ n: number }[]>`select count(*)::int as n from tv_vend where external_id = ${vendId}`
      : q === "audit"
        ? sql<{ n: number }[]>`select count(*)::int as n from audit_log where actor = 'test:permissions'`
        : sql<{ n: number }[]>`select count(*)::int as n from project where id = ${projectId}`))[0]!.n;

describe("roles and permissions in Postgres (migration 0025)", () => {
  it("answers every capability for every role exactly as permissions.ts does — the twin", async () => {
    const mismatches: string[] = [];
    for (const role of ACCESS_ROLES) {
      const c: AppContext = role === "ceo" ? { employeeId: DEMO_CEO_ID, isCeo: true, accessRole: "ceo" } : { employeeId: ids.COOK, accessRole: role };
      const sqlSays = await withContext(c, (sql) => sql<{ cap: string; ok: boolean }[]>`
        select cap, app_has_capability(cap) as ok from unnest(${CAPABILITIES as unknown as string[]}::text[]) as cap`);
      for (const r of sqlSays) {
        const codeSays = can(role === "ceo" ? { isCeo: true } : { accessRole: role }, r.cap as (typeof CAPABILITIES)[number]);
        if (r.ok !== codeSays) mismatches.push(`${role} ${r.cap}: sql ${r.ok}, code ${codeSays}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("an unknown role or a context with no role has no capability in Postgres either", async () => {
    const none = await withContext({ employeeId: ids.COOK }, (sql) => sql<{ n: number }[]>`
      select count(*)::int as n from unnest(${CAPABILITIES as unknown as string[]}::text[]) as cap where app_has_capability(cap)`);
    expect(none[0]!.n).toBe(0);
  });

  it("the CEO and Admin see every person; the others their own reports, department or self", async () => {
    const everyone = ["ADMIN", "CASH", "COOK", "LEAD", "OPS", "SUP", "TECH", "VMO", "WH"];
    expect(await names(ctx.CEO)).toEqual(everyone);
    expect(await names(ctx.ADMIN)).toEqual(everyone);
    expect(await names(ctx.OPS)).toEqual(["OPS", "SUP", "TECH"]); // direct reports only — not SUP's VMO
    expect(await names(ctx.SUP)).toEqual(["SUP", "VMO"]);
    expect(await names(ctx.LEAD)).toEqual(["COOK", "LEAD"]); // the department, not a report
    for (const k of ["VMO", "TECH", "CASH", "WH", "COOK"] as const) expect(await names(ctx[k]), k).toEqual([k]);
  });

  it("tasks follow the same lines", async () => {
    expect(await tasks(ctx.ADMIN)).toHaveLength(9);
    expect(await tasks(ctx.OPS)).toEqual(["OPS", "SUP", "TECH"]);
    expect(await tasks(ctx.SUP)).toEqual(["SUP", "VMO"]);
    expect(await tasks(ctx.VMO)).toEqual(["VMO"]);
  });

  it("the machines and Televend data: the CEO, Admin, Ops Head and Supervisor — nobody else", async () => {
    const seen: Record<string, number> = {};
    for (const k of ["CEO", ...Object.keys(ids)] as (Who | "CEO")[]) seen[k] = await count(ctx[k], "vend");
    expect(seen).toEqual({ CEO: 1, ADMIN: 1, OPS: 1, SUP: 1, VMO: 0, TECH: 0, CASH: 0, WH: 0, LEAD: 0, COOK: 0 });
  });

  it("the audit log: the CEO and Admin only", async () => {
    expect(await count(ctx.CEO, "audit")).toBe(1);
    expect(await count(ctx.ADMIN, "audit")).toBe(1);
    for (const k of ["OPS", "SUP", "LEAD", "VMO", "COOK"] as const) expect(await count(ctx[k], "audit"), k).toBe(0);
  });

  it("projects: Admin sees any project; others through the people they see", async () => {
    expect(await count(ctx.ADMIN, "project")).toBe(1);
    expect(await count(ctx.LEAD, "project")).toBe(1); // led by COOK, in LEAD's department
    expect(await count(ctx.OPS, "project")).toBe(0);
    expect(await count(ctx.VMO, "project")).toBe(0);
  });

  it("Admin is not the CEO: through the app role Admin changes nobody's row — writes go through checked handlers", async () => {
    // The UPDATE policy on employee still names the CEO alone (0025 leaves it on purpose), so the
    // row is filtered out of Admin's update: nothing changes, and nothing errors.
    const changed = await withContext(ctx.ADMIN, (sql) => sql`
      update employee set access_role = 'manager' where id = ${ids.COOK} returning id`);
    expect(changed).toHaveLength(0);
    const [cook] = await getServiceSql()<{ access_role: string }[]>`select access_role from employee where id = ${ids.COOK}`;
    expect(cook?.access_role).toBe("employee");
  });
});
