import { afterAll, describe, expect, it } from "vitest";
import { closeDb, getServiceSql } from "./db.js";
import { DEMO_CEO_ID } from "./meta.js";
import {
  assignTask,
  createTask,
  listOpenBlockers,
  listOpenTasks,
  recordTaskUpdate,
} from "./updates.js";

async function makeEmployee(name: string, telegramUserId?: number): Promise<string> {
  const sql = getServiceSql();
  const rows = await sql<{ id: string }[]>`
    insert into employee (display_name, telegram_user_id, status, is_synthetic)
    values (${name}, ${telegramUserId ?? null}, 'active', true)
    returning id`;
  return rows[0]!.id;
}

afterAll(async () => {
  // Leave the shared test DB as we found it. In particular, pending outbox rows
  // created here would otherwise be picked up by the outbox-relay test's batch.
  const sql = getServiceSql();
  const mine = `select id from employee
                where display_name like 'UPD-%'
                   or display_name like 'ASSIGN-%'
                   or display_name like 'BLK-%'`;
  await sql`delete from notification_outbox where idempotency_key like 'task.assigned:%' or idempotency_key like 'task.done:%'`;
  // Children before parents (FKs), then the employees themselves.
  await sql.unsafe(`delete from assignment where assigned_to in (${mine})`);
  await sql.unsafe(`delete from blocker where raised_by in (${mine})`);
  await sql.unsafe(`delete from task_update where employee_id in (${mine})`);
  await sql.unsafe(`delete from task where employee_id in (${mine})`);
  await sql.unsafe(`delete from employee where id in (${mine})`);
  await closeDb();
});

describe("daily task capture", () => {
  it("lists only the requesting employee's open tasks", async () => {
    const a = await makeEmployee("UPD-A");
    const b = await makeEmployee("UPD-B");
    const mine = await createTask(a, "A task one", true);
    await createTask(b, "B task", true);

    const tasks = await listOpenTasks(a);
    expect(tasks.map((t) => t.id)).toEqual([mine]);
  });

  it("records the button tap as ground truth and advances the task", async () => {
    const emp = await makeEmployee("UPD-C");
    const taskId = await createTask(emp, "Restock Deira machines", true);
    const rec = await recordTaskUpdate({ taskId, employeeId: emp, status: "done" });

    const sql = getServiceSql();
    const upd = await sql`
      select status, note_raw, correlation_id, channel
      from task_update where id = ${rec.taskUpdateId}`;
    expect(upd[0]?.status).toBe("done");
    // No text yet: the tap alone is the deterministic status.
    expect(upd[0]?.note_raw).toBeNull();
    expect(upd[0]?.correlation_id).toBe(rec.correlationId);
    expect(upd[0]?.channel).toBe("telegram");

    const task = await sql`select status from task where id = ${taskId}`;
    expect(task[0]?.status).toBe("done");
  });

  it("puts the task back to pending when a blocker is reported", async () => {
    const emp = await makeEmployee("UPD-D");
    const taskId = await createTask(emp, "Load van 2", true);
    await recordTaskUpdate({ taskId, employeeId: emp, status: "blocker" });

    const sql = getServiceSql();
    const task = await sql`select status from task where id = ${taskId}`;
    expect(task[0]?.status).toBe("pending");
  });

  it("writes an audit row under the run's correlation id", async () => {
    const emp = await makeEmployee("UPD-E");
    const taskId = await createTask(emp, "Chiller temperature check", true);
    const rec = await recordTaskUpdate({ taskId, employeeId: emp, status: "pending" });

    const sql = getServiceSql();
    const audit = await sql`
      select action from audit_log where correlation_id = ${rec.correlationId}`;
    expect(audit.map((r) => r.action)).toContain("task_update.recorded");
  });
});

describe("CEO blocker queue", () => {
  it("lists open blockers with the reporter's name (aliased join)", async () => {
    const emp = await makeEmployee("BLK-REPORTER");
    const sql = getServiceSql();
    await sql`
      insert into blocker (raised_by, category, severity, status, affected_asset, is_synthetic)
      values (${emp}, 'equipment', 'high', 'open', 'van 2 chiller', true)`;

    const found = (await listOpenBlockers(50)).find((b) => b.raised_by_name === "BLK-REPORTER");
    expect(found).toBeDefined();
    expect(found?.severity).toBe("high");
    expect(found?.category).toBe("equipment");
  });
});

describe("CEO assigns work to an employee", () => {
  it("creates the task, the assignment, and queues exactly one outbox message", async () => {
    const to = await makeEmployee("ASSIGN-TARGET", 9_500_000_000_001);
    const res = await assignTask({
      assignedBy: DEMO_CEO_ID,
      assignedTo: to,
      title: "Count chiller stock",
      note: "before 3pm",
    });
    expect(res.delivered).toBe(true);

    const sql = getServiceSql();
    const task = await sql`select employee_id, title, status from task where id = ${res.taskId}`;
    expect(task[0]?.employee_id).toBe(to);
    expect(task[0]?.title).toBe("Count chiller stock");

    const asg = await sql`
      select assigned_by, assigned_to, status from assignment where id = ${res.assignmentId}`;
    expect(asg[0]).toMatchObject({
      assigned_by: DEMO_CEO_ID,
      assigned_to: to,
      status: "assigned",
    });

    // Delivery goes through the outbox — business logic never calls Telegram directly.
    const out = await sql`
      select chat_id, status from notification_outbox
      where idempotency_key = ${`task.assigned:${res.assignmentId}:${to}:telegram`}`;
    expect(out.length).toBe(1);
    expect(Number(out[0]?.chat_id)).toBe(9_500_000_000_001);
    expect(out[0]?.status).toBe("pending");

    // The assigned task shows up in the employee's own list, closing the loop.
    const tasks = await listOpenTasks(to);
    expect(tasks.map((t) => t.id)).toContain(res.taskId);
  });

  it("still records the assignment when the employee has no Telegram link yet", async () => {
    const to = await makeEmployee("ASSIGN-UNLINKED");
    const res = await assignTask({ assignedBy: DEMO_CEO_ID, assignedTo: to, title: "Stocktake" });
    expect(res.delivered).toBe(true); // the in-app inbox row is enough to count as delivered
    const sql = getServiceSql();
    // No Telegram row for someone who cannot receive one — an in-app row instead.
    const out = await sql<{ channel: string }[]>`
      select channel from notification_outbox
      where idempotency_key like ${`task.assigned:${res.assignmentId}:%`}`;
    expect(out.map((r) => r.channel)).toEqual(["inapp"]);
  });
});
