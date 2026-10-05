import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, DEMO_CEO_ID, getServiceSql } from "@freshnow/core";
import { buildServer } from "./server.js";

/**
 * The email pages (TASK-053): who may see and change what, the allow-list at the door, and a
 * proposal applied once — by the CEO or its sender, never by anyone else.
 */

const app = buildServer(false);
const run = randomUUID().slice(0, 8);
const ids = { mgr: randomUUID(), emp: randomUUID(), other: randomUUID() };
const MAIL = (w: string) => `api-${run}-${w}@example.com`;
const saved = process.env.EMAIL_ALLOWLIST;
let proposalId = "";

beforeAll(async () => {
  process.env.EMAIL_ALLOWLIST = [MAIL("mgr"), MAIL("emp")].join(",");
  const sql = getServiceSql();
  await sql`insert into employee (id, display_name, access_role, manager_employee_id, status, is_synthetic) values
    (${ids.mgr}, ${`API-${run} Mgr`}, 'manager', ${DEMO_CEO_ID}, 'active', true),
    (${ids.emp}, ${`API-${run} Emp`}, 'employee', ${ids.mgr}, 'active', true),
    (${ids.other}, ${`API-${run} Other`}, 'employee', ${DEMO_CEO_ID}, 'active', true)`;
  const [m] = await sql<{ id: string }[]>`
    insert into email_message (direction, message_id, from_address, to_address, subject, employee_id, status, is_synthetic)
    values ('in', ${`api-${run}@mail.example.com`}, ${MAIL("mgr")}, 'ops+freshnow@example.com', 'Work', ${ids.mgr}, 'processed', true) returning id`;
  const tasks = [{ title: `API-${run} restock`, detail: null, assigneeId: ids.emp, assigneeName: "Emp", namedAs: "Emp", matchedBy: "name", candidates: [] }];
  proposalId = (await sql<{ id: string }[]>`
    insert into email_proposal (email_message_id, proposed_by, tasks, is_synthetic) values (${m!.id}, ${ids.mgr}, ${sql.json(tasks as never)}, true) returning id`)[0]!.id;
});

afterAll(async () => {
  if (saved === undefined) delete process.env.EMAIL_ALLOWLIST;
  else process.env.EMAIL_ALLOWLIST = saved;
  const sql = getServiceSql();
  const all = Object.values(ids);
  await sql`delete from email_proposal where proposed_by = any(${all})`;
  await sql`delete from email_message where employee_id = any(${all})`;
  await sql`delete from notification_outbox where recipient_employee_id = any(${all})`;
  await sql`delete from assignment where assigned_to = any(${all}) or assigned_by = any(${all})`;
  await sql`delete from task where employee_id = any(${all})`;
  await sql`delete from employee where id = any(${all})`;
  await app.close();
  await closeDb();
});

const as = (viewer: string, method: "GET" | "PUT" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url: `${url}${url.includes("?") ? "&" : "?"}viewer=${viewer}`, ...(payload !== undefined ? { payload: payload as object } : {}) });

describe("the email page and addresses", () => {
  it("are the CEO's: an employee and a manager are refused", async () => {
    expect((await as("ceo", "GET", "/dashboard/email")).statusCode).toBe(200);
    expect((await as(ids.emp, "GET", "/dashboard/email")).statusCode).toBe(403);
    expect((await as(ids.mgr, "PUT", `/dashboard/employees/${ids.emp}/email`, { email: MAIL("emp") })).statusCode).toBe(403);
  });

  it("an address is stored only when it is on the allow-list, and only once", async () => {
    const ok = await as("ceo", "PUT", `/dashboard/employees/${ids.emp}/email`, { email: ` ${MAIL("emp").toUpperCase()} ` });
    expect(ok.json()).toEqual({ email: MAIL("emp") });
    const off = await as("ceo", "PUT", `/dashboard/employees/${ids.other}/email`, { email: MAIL("nope") });
    expect(off.statusCode).toBe(400);
    expect(off.json().error.message).toMatch(/EMAIL_ALLOWLIST/);
    const dup = await as("ceo", "PUT", `/dashboard/employees/${ids.mgr}/email`, { email: MAIL("emp") });
    expect(dup.statusCode).toBe(400);
    expect(dup.json().error.message).toMatch(/someone else/);
    const page = (await as("ceo", "GET", "/dashboard/email")).json() as { people: { id: string; email: string | null }[]; allowlist: string[] };
    expect(page.people.find((p) => p.id === ids.emp)?.email).toBe(MAIL("emp"));
    expect(page.allowlist).toEqual([MAIL("mgr"), MAIL("emp")]);
  });

  it("/health says whether email works, without naming any address", async () => {
    const h = (await app.inject({ method: "GET", url: "/health" })).json() as { email: Record<string, unknown> };
    expect(h.email).toHaveProperty("sending");
    expect(JSON.stringify(h)).not.toContain("@example.com");
  });
});

describe("a proposal from email", () => {
  it("is offered to its sender (and the CEO), not to an employee", async () => {
    const mine = (await as(ids.mgr, "GET", "/dashboard/email/proposals")).json() as { proposals: { id: string }[] };
    expect(mine.proposals.map((p) => p.id)).toContain(proposalId);
    expect((await as(ids.emp, "GET", "/dashboard/email/proposals")).json()).toEqual({ proposals: [] });
  });

  it("someone else cannot apply it; its sender can, once — a second tap assigns nothing", async () => {
    const body = { tasks: [{ title: `API-${run} restock`, assignedTo: ids.emp }] };
    expect((await as(ids.other, "POST", `/dashboard/email/proposals/${proposalId}/apply`, body)).statusCode).toBe(403);
    const first = await as(ids.mgr, "POST", `/dashboard/email/proposals/${proposalId}/apply`, body);
    expect(first.statusCode).toBe(201);
    expect((await as(ids.mgr, "POST", `/dashboard/email/proposals/${proposalId}/apply`, body)).statusCode).toBe(404); // no longer pending
    const n = (await getServiceSql()<{ n: number }[]>`select count(*)::int as n from assignment where assigned_to = ${ids.emp}`)[0]!.n;
    expect(n).toBe(1);
  });

  it("a manager cannot route emailed work to someone outside their team", async () => {
    const sql = getServiceSql();
    const [m] = await sql<{ id: string }[]>`
      insert into email_message (direction, message_id, from_address, to_address, employee_id, status, is_synthetic)
      values ('in', ${`api2-${run}@mail.example.com`}, ${MAIL("mgr")}, 'x', ${ids.mgr}, 'processed', true) returning id`;
    const [p] = await sql<{ id: string }[]>`
      insert into email_proposal (email_message_id, proposed_by, tasks, is_synthetic) values (${m!.id}, ${ids.mgr}, ${sql.json([] as never)}, true) returning id`;
    const r = await as(ids.mgr, "POST", `/dashboard/email/proposals/${p!.id}/apply`, { tasks: [{ title: "x task", assignedTo: ids.other }] });
    expect(r.statusCode).toBe(403);
  });
});
