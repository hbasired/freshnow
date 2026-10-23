import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, currentNoticeHash, DEMO_CEO_ID, getServiceSql, recordConsent } from "@freshnow/core";
import { buildServer } from "./server.js";

/**
 * The new roles over HTTP (TASK-057). Core writes run as the BYPASSRLS service role, so these
 * handlers are the only thing between a role and a power it does not have — every refusal below
 * guards code with no other safety net. The decisions under test (the user's, 2026-10-15): Admin
 * sees everything and manages people, but the CEO's account and the Admin role are the CEO's; Ops
 * Head and Supervisor give work to their reports; the field roles act on their own work only.
 */

const app = buildServer(false);
const run = randomUUID().slice(0, 6);
const PREFIX = `RBAC-${run}-`;
const ADM = randomUUID(); // admin
const ADM2 = randomUUID(); // a second admin, whose role and account are the CEO's to change
const OPS = randomUUID(); // ops head
const OPSR = randomUUID(); // a VMO who reports to OPS
const V = randomUUID(); // a VMO who reports to the CEO
const STR = randomUUID(); // an employee outside OPS's team
const added: string[] = [];

async function seed(id: string, name: string, role: string, manager: string | null): Promise<void> {
  await getServiceSql()`
    insert into employee (id, display_name, status, is_synthetic, access_role, manager_employee_id, department)
    values (${id}, ${PREFIX + name}, 'active', true, ${role}, ${manager}, 'operations')`;
}

beforeAll(async () => {
  await seed(ADM, "Adele", "admin", DEMO_CEO_ID);
  await seed(ADM2, "Aziz", "admin", DEMO_CEO_ID);
  await seed(OPS, "Omar", "ops_head", DEMO_CEO_ID);
  await seed(OPSR, "Osman", "vmo", OPS);
  await seed(V, "Vikram", "vmo", DEMO_CEO_ID);
  await seed(STR, "Sara", "employee", DEMO_CEO_ID);
  for (const id of [ADM, ADM2, OPS, OPSR, V, STR]) await recordConsent({ employeeId: id, noticeHash: currentNoticeHash(), via: "app" });
});

afterAll(async () => {
  const sql = getServiceSql();
  const ids = [ADM, ADM2, OPS, OPSR, V, STR, ...added];
  await sql`delete from project_member where project_id in (select id from project where name like ${PREFIX + "%"})`;
  await sql`delete from project where name like ${PREFIX + "%"}`;
  await sql`delete from task_update where employee_id = any(${ids})`;
  await sql`delete from assignment where assigned_to = any(${ids}) or assigned_by = any(${ids})`;
  await sql`delete from task where employee_id = any(${ids})`;
  await sql`delete from notification_outbox where recipient_employee_id = any(${ids})`;
  await sql`delete from invite_code where employee_id = any(${ids})`;
  await sql`delete from consent_record where employee_id = any(${ids})`;
  await sql`delete from audit_log where actor = any(${ids.map((i) => `employee:${i}`)}) or (entity = 'employee' and entity_id = any(${ids}))`;
  await sql`update employee set manager_employee_id = null where id = any(${ids})`;
  await sql`delete from employee where id = any(${ids})`;
  await app.close();
  await closeDb();
});

const call = (method: "GET" | "POST" | "PATCH", url: string, viewer: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url: `${url}?viewer=${viewer}`, ...(payload ? { payload } : {}) });

interface Me {
  roleLabel: string;
  capabilities: string[];
  grantableRoles: { role: string }[];
  leadingRoles: string[];
}

describe("what the browser is told each role may do (/dashboard/me)", () => {
  it("Admin: everything but making Admins; offers every role but CEO and Admin", async () => {
    const me = (await call("GET", "/dashboard/me", ADM)).json() as Me;
    expect(me.roleLabel).toBe("Admin");
    expect(me.capabilities).toEqual(expect.arrayContaining(["data.read_all", "people.manage", "work.give_to_anyone", "televend.read"]));
    expect(me.capabilities).not.toContain("people.grant_admin");
    expect(me.grantableRoles.map((r) => r.role)).not.toEqual(expect.arrayContaining(["ceo"]));
    expect(me.grantableRoles.map((r) => r.role)).not.toContain("admin");
    expect(me.grantableRoles.map((r) => r.role)).toContain("ops_head");
  });

  it("a VMO: nothing beyond their own work — the stock and cash they are given, their visits (TASK-060, TASK-061)", async () => {
    const me = (await call("GET", "/dashboard/me", V)).json() as Me;
    expect(me.roleLabel).toBe("VMO / driver");
    expect(me.capabilities).toEqual(["inventory.hold", "cash.hold", "visits.record"]);
    expect(me.grantableRoles).toEqual([]);
  });

  it("the Ops Head: their team, the machines; and only roles that lead people may be managers", async () => {
    const me = (await call("GET", "/dashboard/me", OPS)).json() as Me;
    expect(me.capabilities).toEqual(expect.arrayContaining(["work.give_to_reports", "people.view_reports", "televend.read", "projects.create"]));
    expect(me.capabilities).not.toContain("people.manage");
    expect(me.leadingRoles).toEqual(expect.arrayContaining(["ceo", "admin", "ops_head", "supervisor", "manager", "lead"]));
    expect(me.leadingRoles).not.toContain("vmo");
  });
});

describe("Admin manages people — within the CEO's limits", () => {
  it("adds a person with a role Admin may give, and is refused Admin itself", async () => {
    const ok = await call("POST", "/dashboard/people", ADM, { displayName: `${PREFIX}New Driver`, accessRole: "vmo", telegramInvite: false });
    expect(ok.statusCode).toBe(201);
    added.push((ok.json() as { employeeId: string }).employeeId);
    const admin = await call("POST", "/dashboard/people", ADM, { displayName: `${PREFIX}Would Be Admin`, accessRole: "admin", telegramInvite: false });
    expect(admin.statusCode).toBe(403);
    // "ceo" stays a bad request with core's own words, as before TASK-057.
    expect((await call("POST", "/dashboard/people", ADM, { displayName: `${PREFIX}Would Be CEO`, accessRole: "ceo" })).statusCode).toBe(400);
    // A role that does not manage people cannot add anyone.
    expect((await call("POST", "/dashboard/people", OPS, { displayName: `${PREFIX}Nope`, telegramInvite: false })).statusCode).toBe(403);
  });

  it("changes roles, but never the CEO's account, and never to or from Admin — the CEO does those", async () => {
    expect((await call("PATCH", `/dashboard/people/${STR}`, ADM, { accessRole: "supervisor" })).statusCode).toBe(200);
    expect((await call("PATCH", `/dashboard/people/${DEMO_CEO_ID}`, ADM, { department: "nowhere" })).statusCode).toBe(403);
    expect((await call("PATCH", `/dashboard/people/${STR}`, ADM, { accessRole: "admin" })).statusCode).toBe(403);
    expect((await call("PATCH", `/dashboard/people/${ADM2}`, ADM, { accessRole: "employee" })).statusCode).toBe(403);
    expect((await call("PATCH", `/dashboard/people/${STR}`, "ceo", { accessRole: "admin" })).statusCode).toBe(200);
    expect((await call("PATCH", `/dashboard/people/${STR}`, "ceo", { accessRole: "employee" })).statusCode).toBe(200);
    const [row] = await getServiceSql()<{ access_role: string }[]>`select access_role from employee where id = ${STR}`;
    expect(row?.access_role).toBe("employee");
    const [ceo] = await getServiceSql()<{ department: string | null }[]>`select department from employee where id = ${DEMO_CEO_ID}`;
    expect(ceo?.department).not.toBe("nowhere");
  });

  it("cannot change the CEO's or another Admin's email address — inbound email trusts them", async () => {
    const put = (id: string, viewer: string, email: string | null) =>
      app.inject({ method: "PUT", url: `/dashboard/employees/${id}/email?viewer=${viewer}`, payload: { email } });
    expect((await put(DEMO_CEO_ID, ADM, `rbac-${run}-ceo@example.com`)).statusCode).toBe(403);
    expect((await put(ADM2, ADM, `rbac-${run}-adm2@example.com`)).statusCode).toBe(403);
    expect((await put(STR, ADM, `rbac-${run}-sara@example.com`)).statusCode).toBe(200);
    expect((await put(STR, ADM, null)).statusCode).toBe(200);
  });

  it("cannot erase another Admin", async () => {
    expect((await call("POST", `/dashboard/people/${ADM2}/erase`, ADM, { reason: "left" })).statusCode).toBe(403);
    const [row] = await getServiceSql()<{ status: string }[]>`select status from employee where id = ${ADM2}`;
    expect(row?.status).toBe("active");
  });
});

describe("giving work", () => {
  it("the Ops Head gives work to their team, not to anyone else", async () => {
    expect((await call("POST", "/dashboard/assignments", OPS, { assignedTo: OPSR, title: `${PREFIX}restock 793` })).statusCode).toBe(201);
    expect((await call("POST", "/dashboard/assignments", OPS, { assignedTo: STR, title: `${PREFIX}not theirs` })).statusCode).toBe(403);
  });

  it("a VMO gives no work, sees nobody to give it to, and starts no project", async () => {
    expect((await call("POST", "/dashboard/assignments", V, { assignedTo: STR, title: `${PREFIX}nope` })).statusCode).toBe(403);
    expect(((await call("GET", "/dashboard/people/reach", V)).json() as { people: unknown[] }).people).toEqual([]);
    expect((await call("POST", "/dashboard/projects", V, { name: `${PREFIX}vmo project` })).statusCode).toBe(403);
    expect((await call("POST", "/dashboard/projects", OPS, { name: `${PREFIX}ops project`, leadEmployeeId: OPS })).statusCode).toBe(201);
  });

  it("Admin reads the compliance record; the Ops Head does not", async () => {
    expect((await call("GET", "/dashboard/compliance", ADM)).statusCode).toBe(200);
    expect((await call("GET", "/dashboard/compliance", OPS)).statusCode).toBe(403);
  });
});
