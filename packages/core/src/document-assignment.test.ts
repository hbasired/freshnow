import { afterAll, describe, expect, it } from "vitest";
import { closeDb, getServiceSql } from "./db.js";
import { assignTask } from "./updates.js";
import { planDocumentTasks } from "./documents.js";
import type { ContextPerson } from "./context.js";

/**
 * What the CEO actually asked for on 2026-09-08: a document full of jobs must become
 * one tracked assignment PER JOB, routed to the named person, each with its own message
 * — not one task called "Assign tasks from PDF" with the raw file stapled to it.
 *
 * These tests cover the step the unit tests could not: that acting on a plan produces
 * separate rows and separate deliveries, and that the file is not forwarded unless asked.
 */

async function makeEmployee(name: string, telegramUserId?: number): Promise<string> {
  const sql = getServiceSql();
  const rows = await sql<{ id: string }[]>`
    insert into employee (display_name, telegram_user_id, status, is_synthetic)
    values (${name}, ${telegramUserId ?? null}, 'active', true) returning id`;
  return rows[0]!.id;
}

afterAll(async () => {
  const sql = getServiceSql();
  const mine = `select id from employee where display_name like 'DOCA-%'`;
  await sql`delete from notification_outbox
              where idempotency_key like 'task.assigned:%' or idempotency_key like 'attachment-%'`;
  await sql.unsafe(`delete from attachment where uploaded_by in (${mine})`);
  await sql.unsafe(`delete from assignment where assigned_to in (${mine})`);
  await sql.unsafe(`delete from task_update where employee_id in (${mine})`);
  await sql.unsafe(`delete from task where employee_id in (${mine})`);
  await sql.unsafe(`delete from employee where id in (${mine})`);
  await closeDb();
});

describe("acting on a document plan", () => {
  it("creates one tracked assignment and one message per job, not one per document", async () => {
    const ceo = await makeEmployee("DOCA-ceo");
    const worker = await makeEmployee("DOCA-worker", 900000001);

    const people: ContextPerson[] = [
      { id: worker, display_name: "DOCA-worker", department: "production" },
    ];
    const plan = await planDocumentTasks({
      text: `Assign DOCA-worker the following tasks:
1. Service the bottling line before Friday.
2. Restock the Marina vending machine.
3. Report the chiller temperatures for last week.`,
      colleagues: people,
    });

    expect(plan.tasks.length).toBeGreaterThanOrEqual(3);

    const created: string[] = [];
    for (const t of plan.tasks) {
      if (!t.assignee) continue;
      const res = await assignTask({
        assignedBy: ceo,
        assignedTo: t.assignee.id,
        title: t.title,
        note: t.detail,
      });
      created.push(res.assignmentId);
    }

    // One assignment per job — the whole point. The old behaviour produced exactly 1.
    expect(created.length).toBe(plan.tasks.length);

    const sql = getServiceSql();
    const tasks = await sql<{ title: string }[]>`
      select title from task where employee_id = ${worker} order by created_at`;
    expect(tasks.length).toBe(plan.tasks.length);
    // Each row is a real job title, never the instruction wrapper.
    expect(tasks.every((t) => !/^assign\b/i.test(t.title))).toBe(true);

    // One delivery per assignment, each separately idempotent, so the employee gets a
    // message they can report against for every job.
    const queued = await sql<{ n: number }[]>`
      select count(*)::int as n from notification_outbox
      where channel = 'telegram'
        and split_part(idempotency_key, ':', 2) = any(${created})
        and idempotency_key like 'task.assigned:%'`;
    expect(queued[0]!.n).toBe(created.length);
  });

  it("does not forward the document unless it was asked for", async () => {
    const ceo = await makeEmployee("DOCA-ceo2");
    const worker = await makeEmployee("DOCA-worker2", 900000002);

    // The default path: tasks are created, the file is NOT passed along.
    const res = await assignTask({
      assignedBy: ceo,
      assignedTo: worker,
      title: "Service the bottling line",
    });
    expect(res.attachments).toBe(0);

    const sql = getServiceSql();
    const files = await sql<{ n: number }[]>`
      select count(*)::int as n from attachment where assignment_id = ${res.assignmentId}`;
    expect(files[0]!.n).toBe(0);
    // And nothing was queued to push a file at anybody.
    const pushes = await sql<{ n: number }[]>`
      select count(*)::int as n from notification_outbox
      where idempotency_key like 'attachment-%' and payload->>'assignmentId' = ${res.assignmentId}`;
    expect(pushes[0]!.n).toBe(0);
  });

  it("still forwards the file when the CEO explicitly opts in", async () => {
    const ceo = await makeEmployee("DOCA-ceo3");
    const worker = await makeEmployee("DOCA-worker3", 900000003);

    const res = await assignTask({
      assignedBy: ceo,
      assignedTo: worker,
      title: "Service the bottling line",
      attachments: [{ fileId: "doca-file", fileName: "spec.pdf", kind: "document" }],
    });

    expect(res.attachments).toBe(1);
    const sql = getServiceSql();
    const files = await sql<{ file_name: string }[]>`
      select file_name from attachment where assignment_id = ${res.assignmentId}`;
    expect(files[0]!.file_name).toBe("spec.pdf");
  });

  it("routes a mixed document to the right person for each job", async () => {
    const ceo = await makeEmployee("DOCA-ceo4");
    const a = await makeEmployee("DOCA-Rashid", 900000004);
    const b = await makeEmployee("DOCA-Priya", 900000005);

    const plan = await planDocumentTasks({
      text: `Jobs for this week:
- DOCA-Rashid: fix the van 2 chiller.
- DOCA-Priya: restock the Marina machine.`,
      colleagues: [
        { id: a, display_name: "DOCA-Rashid", department: "delivery" },
        { id: b, display_name: "DOCA-Priya", department: "warehouse" },
      ],
    });

    for (const t of plan.tasks) {
      if (!t.assignee) continue;
      await assignTask({ assignedBy: ceo, assignedTo: t.assignee.id, title: t.title });
    }

    const sql = getServiceSql();
    // Each person got their OWN job, and only their own.
    const rashid = await sql<{ title: string }[]>`select title from task where employee_id = ${a}`;
    const priya = await sql<{ title: string }[]>`select title from task where employee_id = ${b}`;
    expect(rashid).toHaveLength(1);
    expect(priya).toHaveLength(1);
    expect(rashid[0]!.title.toLowerCase()).toContain("chiller");
    expect(priya[0]!.title.toLowerCase()).toContain("marina");
  });
});
