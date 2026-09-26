import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, DEMO_CEO_ID, getServiceSql } from "@freshnow/core";
import { buildServer } from "./server.js";

/**
 * Creating work over HTTP.
 *
 * Two things are being proved here, and only one of them is the happy path:
 *
 *  1. A dashboard action lands in the same tables, with the same audit trail and the same
 *     queued Telegram message, as the equivalent tap in the bot.
 *  2. Somebody who should not be able to do it, cannot. Core writes run as the BYPASSRLS
 *     service role, so Postgres will not stop them — only the handler will, and an
 *     unchecked handler fails silently and permanently. Every refusal below is a test of
 *     code that has no other safety net.
 */

const app = buildServer(false);
const A = randomUUID(); // an ordinary employee
const B = randomUUID(); // a colleague, to be assigned work and not to be impersonated
const M = randomUUID(); // a manager
const R = randomUUID(); // one of M's reports
const L = randomUUID(); // a leaver, to be anonymised
const X = randomUUID(); // a former CEO row — the one thing erasure must refuse
const PREFIX = "WORK-";

async function seedPerson(
  id: string,
  name: string,
  role = "employee",
  manager: string | null = null,
  telegram: number | null = null,
): Promise<void> {
  await getServiceSql()`
    insert into employee (id, display_name, status, is_synthetic, access_role, manager_employee_id, department, telegram_user_id)
    values (${id}, ${PREFIX + name}, 'active', true, ${role}, ${manager}, 'production', ${telegram})`;
}

beforeAll(async () => {
  await seedPerson(A, "Aisha");
  // Bilal is linked to Telegram; the others are not, which is what makes the
  // "linked person gets a Telegram row, unlinked people do not" assertions mean something.
  await seedPerson(B, "Bilal", "employee", null, 9_800_000_000_001);
  await seedPerson(M, "Maryam", "manager");
  await seedPerson(R, "Rahim", "employee", M);
  await seedPerson(L, "Layla", "employee", M, 9_800_000_000_002);
  // Disabled so that no CEO lookup (`status = 'active'`) in a parallel test file picks it up.
  await seedPerson(X, "Xavier", "ceo");
  await getServiceSql()`update employee set status = 'disabled' where id = ${X}`;
});

afterAll(async () => {
  const sql = getServiceSql();
  const ids = [A, B, M, R, L, X];
  // Children first — nothing in this schema cascades.
  await sql`delete from attachment where uploaded_by in ${sql(ids)}`;
  await sql`delete from escalation where blocker_id in (select id from blocker where raised_by in ${sql(ids)})`;
  await sql`delete from blocker where raised_by in ${sql(ids)}`;
  await sql`delete from task_update where employee_id in ${sql(ids)}`;
  await sql`delete from assignment where assigned_to in ${sql(ids)} or assigned_by in ${sql(ids)}`;
  await sql`delete from task where employee_id in ${sql(ids)}`;
  // By recipient, not by a subquery over assignments — those rows are already gone by here.
  await sql`delete from notification_outbox where recipient_employee_id in ${sql(ids)}`;
  await sql`delete from audit_log where actor in ${sql(ids.map((i) => `employee:${i}`))}`;
  await sql`delete from audit_log where entity = 'employee' and entity_id = any(${ids})`;
  await sql`delete from employee where id in ${sql(ids)}`;
  await app.close();
  await closeDb();
});

const post = (url: string, payload?: object) =>
  app.inject({ method: "POST", url, ...(payload ? { payload } : {}) });

describe("POST /dashboard/tasks", () => {
  it("lets a person add a task for themselves, and records who created it", async () => {
    const r = await post(`/dashboard/tasks?viewer=${A}`, { title: "Check the chiller in van 2" });
    expect(r.statusCode).toBe(201);
    const { taskId, employeeId } = r.json() as { taskId: string; employeeId: string };
    expect(employeeId).toBe(A);

    const sql = getServiceSql();
    const [task] = await sql<{ employee_id: string; status: string }[]>`
      select employee_id, status from task where id = ${taskId}`;
    expect(task).toMatchObject({ employee_id: A, status: "open" });

    // Without this audit row, work created in the dashboard appears on someone's list
    // with no record of where it came from.
    const [audit] = await sql<{ actor: string }[]>`
      select actor from audit_log where action = 'task.created' and entity_id = ${taskId}`;
    expect(audit?.actor).toBe(`employee:${A}`);
  });

  it("refuses to let one employee put a task on a colleague's list", async () => {
    const r = await post(`/dashboard/tasks?viewer=${A}`, { title: "Do my paperwork", employeeId: B });
    expect(r.statusCode).toBe(403);
    expect((r.json() as { error: { correlationId?: string } }).error.correlationId).toBeTruthy();

    const none = await getServiceSql()<{ n: number }[]>`
      select count(*)::int as n from task where employee_id = ${B}`;
    expect(none[0]?.n).toBe(0);
  });

  it("lets the CEO create a task for somebody else", async () => {
    const r = await post(`/dashboard/tasks?viewer=ceo`, { title: "Restock Deira machines", employeeId: B });
    expect(r.statusCode).toBe(201);
    const [audit] = await getServiceSql()<{ actor: string }[]>`
      select actor from audit_log
      where action = 'task.created' and entity_id = ${(r.json() as { taskId: string }).taskId}`;
    expect(audit?.actor).toBe(`employee:${DEMO_CEO_ID}`);
  });

  it("rejects a body that does not parse, with the shared error shape", async () => {
    const r = await post(`/dashboard/tasks?viewer=${A}`, { title: "no" });
    expect(r.statusCode).toBe(400);
    expect((r.json() as { error: { code: string } }).error.code).toBe("validation_error");
  });
});

describe("POST /dashboard/assignments", () => {
  it("queues exactly one Telegram message for the assignment", async () => {
    const r = await post(`/dashboard/assignments?viewer=ceo`, {
      assignedTo: B,
      title: "Collect the service report",
      note: "Before the afternoon run",
    });
    expect(r.statusCode).toBe(201);
    const { assignmentId, taskId, queued } = r.json() as {
      assignmentId: string;
      taskId: string;
      queued: boolean;
    };
    expect(queued).toBe(true);

    const sql = getServiceSql();
    const rows = await sql<{ idempotency_key: string; status: string }[]>`
      select idempotency_key, status from notification_outbox
      where idempotency_key like ${`task.assigned:${assignmentId}:%:telegram`}`;
    expect(rows.length).toBe(1);

    // And exactly one row per channel for the assignee — nobody else is told.
    const all = await sql<{ channel: string; recipient_employee_id: string; reason: string }[]>`
      select channel, recipient_employee_id, reason from notification_outbox
      where idempotency_key like ${`task.assigned:${assignmentId}:%`} order by channel`;
    expect(all).toEqual([
      { channel: "inapp", recipient_employee_id: B, reason: "assignee" },
      { channel: "telegram", recipient_employee_id: B, reason: "assignee" },
    ]);

    const [assignment] = await sql<{ assigned_by: string; task_id: string }[]>`
      select assigned_by, task_id from assignment where id = ${assignmentId}`;
    expect(assignment).toMatchObject({ assigned_by: DEMO_CEO_ID, task_id: taskId });
  });

  it("refuses an employee assigning work to somebody else", async () => {
    const r = await post(`/dashboard/assignments?viewer=${A}`, { assignedTo: B, title: "Do this for me" });
    expect(r.statusCode).toBe(403);
  });
});

describe("POST /dashboard/task-updates", () => {
  it("records a browser report as channel 'web' and moves the task", async () => {
    const created = await post(`/dashboard/tasks?viewer=${A}`, { title: "Wipe down the filler" });
    const { taskId } = created.json() as { taskId: string };

    const r = await post(`/dashboard/task-updates?viewer=${A}`, { taskId, status: "done" });
    expect(r.statusCode).toBe(201);

    const sql = getServiceSql();
    const [update] = await sql<{ channel: string; status: string }[]>`
      select channel, status from task_update where id = ${(r.json() as { taskUpdateId: string }).taskUpdateId}`;
    // The channel is the only thing that should differ from a tap in the bot.
    expect(update).toMatchObject({ channel: "web", status: "done" });

    const [task] = await sql<{ status: string }[]>`select status from task where id = ${taskId}`;
    expect(task?.status).toBe("done");
  });

  it("refuses a report on a colleague's task", async () => {
    const theirs = await post(`/dashboard/tasks?viewer=ceo`, { title: "Bilal's own job", employeeId: B });
    const { taskId } = theirs.json() as { taskId: string };

    const r = await post(`/dashboard/task-updates?viewer=${A}`, { taskId, status: "done" });
    expect(r.statusCode).toBe(403);

    const none = await getServiceSql()<{ n: number }[]>`
      select count(*)::int as n from task_update where task_id = ${taskId}`;
    expect(none[0]?.n).toBe(0);
  });
});

describe("POST /dashboard/blockers/:id/ack", () => {
  it("acknowledges as the person who tapped, and refuses an unrelated employee", async () => {
    const sql = getServiceSql();
    const [blocker] = await sql<{ id: string }[]>`
      insert into blocker (raised_by, assigned_resolver, severity, status, category, is_synthetic)
      values (${B}, ${DEMO_CEO_ID}, 'high', 'open', 'equipment', true)
      returning id`;

    const refused = await post(`/dashboard/blockers/${blocker!.id}/ack?viewer=${A}`);
    expect(refused.statusCode).toBe(403);

    const ok = await post(`/dashboard/blockers/${blocker!.id}/ack?viewer=ceo`);
    expect(ok.statusCode).toBe(200);

    const [row] = await sql<{ status: string }[]>`select status from blocker where id = ${blocker!.id}`;
    expect(row?.status).toBe("acknowledged");

    // "Who said they were on it" is the question the audit log exists to answer.
    const [audit] = await sql<{ actor: string }[]>`
      select actor from audit_log where action = 'blocker.acknowledged' and entity_id = ${blocker!.id}`;
    expect(audit?.actor).toBe(`employee:${DEMO_CEO_ID}`);

    await sql`delete from audit_log where entity_id = ${blocker!.id}`;
    await sql`delete from blocker where id = ${blocker!.id}`;
  });
});

describe("managers and leads (the org model)", () => {
  it("a manager can assign to their own report, and not to somebody else", async () => {
    const ok = await post(`/dashboard/assignments?viewer=${M}`, { assignedTo: R, title: "Check the filler seals" });
    expect(ok.statusCode).toBe(201);
    const [row] = await getServiceSql()<{ assigned_by: string }[]>`
      select assigned_by from assignment where id = ${(ok.json() as { assignmentId: string }).assignmentId}`;
    expect(row?.assigned_by).toBe(M);

    const no = await post(`/dashboard/assignments?viewer=${M}`, { assignedTo: A, title: "Not my team" });
    expect(no.statusCode).toBe(403);
  });

  it("a manager can acknowledge a blocker raised by their report", async () => {
    const sql = getServiceSql();
    const [b] = await sql<{ id: string }[]>`
      insert into blocker (raised_by, assigned_resolver, severity, status, category, is_synthetic)
      values (${R}, ${DEMO_CEO_ID}, 'high', 'open', 'equipment', true) returning id`;
    const r = await post(`/dashboard/blockers/${b!.id}/ack?viewer=${M}`);
    expect(r.statusCode).toBe(200);
    await sql`delete from audit_log where entity_id = ${b!.id}`;
    await sql`delete from blocker where id = ${b!.id}`;
  });

  it("only the CEO changes roles and reporting lines, and a loop is refused", async () => {
    const denied = await app.inject({ method: "PATCH", url: `/dashboard/people/${A}?viewer=${M}`, payload: { accessRole: "manager" } });
    expect(denied.statusCode).toBe(403);

    const ok = await app.inject({ method: "PATCH", url: `/dashboard/people/${A}?viewer=ceo`, payload: { accessRole: "lead", department: "delivery" } });
    expect(ok.statusCode).toBe(200);
    const [row] = await getServiceSql()<{ access_role: string; department: string }[]>`
      select access_role, department from employee where id = ${A}`;
    expect(row).toMatchObject({ access_role: "lead", department: "delivery" });

    // R reports to M; making M report to R would loop.
    const loop = await app.inject({ method: "PATCH", url: `/dashboard/people/${M}?viewer=ceo`, payload: { managerEmployeeId: R } });
    expect(loop.statusCode).toBe(409);
  });

  it("the org fields reach the browser through /dashboard/me", async () => {
    const r = await app.inject({ method: "GET", url: `/dashboard/me?viewer=${M}` });
    expect(r.json()).toMatchObject({ employeeId: M, isCeo: false, accessRole: "manager", department: "production" });
  });
});

describe("POST /dashboard/people/:id/erase", () => {
  it("only the CEO, never themselves, never a CEO row, and never somebody who does not exist", async () => {
    const asManager = await post(`/dashboard/people/${L}/erase?viewer=${M}`, { reason: "left" });
    expect(asManager.statusCode).toBe(403);

    const self = await post(`/dashboard/people/${DEMO_CEO_ID}/erase?viewer=ceo`, { reason: "left" });
    expect(self.statusCode).toBe(403);

    const ceoRow = await post(`/dashboard/people/${X}/erase?viewer=ceo`, { reason: "left" });
    expect(ceoRow.statusCode).toBe(409);

    const nobody = await post(`/dashboard/people/${randomUUID()}/erase?viewer=ceo`, { reason: "left" });
    expect(nobody.statusCode).toBe(404);

    const badReason = await post(`/dashboard/people/${L}/erase?viewer=ceo`, { reason: "fired" });
    expect(badReason.statusCode).toBe(400);

    // None of the refusals touched the person.
    const [row] = await getServiceSql()<{ display_name: string; status: string }[]>`
      select display_name, status from employee where id = ${L}`;
    expect(row).toMatchObject({ display_name: `${PREFIX}Layla`, status: "active" });
  });

  it("anonymises the person, keeps their work, and records who did it and why — never the words", async () => {
    const sql = getServiceSql();
    // Something to erase: a note in Layla's own words, on a task that must survive. The
    // note is written straight to the table — over HTTP it would go to the model to parse.
    const created = await post(`/dashboard/tasks?viewer=${L}`, { title: "Clean the filler heads" });
    const { taskId } = created.json() as { taskId: string };
    await post(`/dashboard/task-updates?viewer=${L}`, { taskId, status: "done" });
    await sql`update task_update set note_raw = 'heads 1-3 cleaned, head 4 seal worn' where employee_id = ${L}`;

    const r = await post(`/dashboard/people/${L}/erase?viewer=ceo`, { reason: "consent_withdrawn" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ employeeId: L, erased: true, notesRedacted: 1 });

    const [person] = await sql<{ display_name: string; telegram_user_id: string | null; status: string }[]>`
      select display_name, telegram_user_id, status from employee where id = ${L}`;
    expect(person).toEqual({ display_name: "Former employee", telegram_user_id: null, status: "disabled" });

    // The task and the update still exist — anonymised, not deleted — and the words are gone.
    const [task] = await sql<{ status: string }[]>`select status from task where id = ${taskId}`;
    expect(task?.status).toBe("done");
    const notes = await sql<{ note_raw: string | null }[]>`select note_raw from task_update where employee_id = ${L}`;
    expect(notes.length).toBe(1);
    expect(notes[0]?.note_raw).toBe("[erased]");

    const [audit] = await sql<{ actor: string; correlation_id: string | null; detail: Record<string, unknown> }[]>`
      select actor, correlation_id, detail from audit_log
      where action = 'employee.erased' and entity_id = ${L} order by created_at desc limit 1`;
    expect(audit?.actor).toBe(`employee:${DEMO_CEO_ID}`);
    expect(audit?.correlation_id).toBeTruthy();
    expect(audit?.detail).toMatchObject({ reason: "consent_withdrawn", notesRedacted: 1 });
    expect(JSON.stringify(audit?.detail)).not.toContain("seal worn");

    // A second erasure is a no-op, not an error.
    const again = await post(`/dashboard/people/${L}/erase?viewer=ceo`, { reason: "left" });
    expect(again.statusCode).toBe(200);
    expect((again.json() as { notesRedacted: number }).notesRedacted).toBe(0);
  });
});
