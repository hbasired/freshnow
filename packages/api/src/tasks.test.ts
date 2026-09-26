import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, DEMO_CEO_ID, getServiceSql } from "@freshnow/core";
import { buildServer } from "./server.js";

/** The task-depth routes: steps, progress, relations, resolution — and who may touch them. */

const app = buildServer(false);
const OWNER = randomUUID();
const MGR = randomUUID();
const STRANGER = randomUUID();

beforeAll(async () => {
  const sql = getServiceSql();
  await sql`insert into employee (id, display_name, status, is_synthetic, access_role, department) values
    (${MGR}, 'TSK-Mgr', 'active', true, 'manager', 'production'),
    (${STRANGER}, 'TSK-Stranger', 'active', true, 'employee', 'delivery')`;
  await sql`insert into employee (id, display_name, status, is_synthetic, access_role, department, manager_employee_id) values
    (${OWNER}, 'TSK-Owner', 'active', true, 'employee', 'production', ${MGR})`;
});

afterAll(async () => {
  const sql = getServiceSql();
  const ids = [OWNER, MGR, STRANGER];
  await sql`delete from blocker where raised_by = any(${ids})`;
  await sql`delete from task_update where employee_id = any(${ids})`;
  await sql`delete from task where employee_id = any(${ids})`; // steps, relations, history cascade
  await sql`delete from audit_log where actor = any(${ids.map((i) => `employee:${i}`)})`;
  await sql`delete from employee where id = any(${ids})`;
  await app.close();
  await closeDb();
});

const call = (method: "GET" | "POST" | "PATCH", url: string, payload?: object) =>
  app.inject({ method, url, ...(payload ? { payload } : {}) });

async function newTask(title: string): Promise<string> {
  const r = await call("POST", `/dashboard/tasks?viewer=${OWNER}`, { title });
  return (r.json() as { taskId: string }).taskId;
}

describe("steps and progress", () => {
  it("the owner adds steps and ticks one; the detail shows a counted percentage", async () => {
    const t = await newTask("TSK checklist");
    for (const title of ["drain", "swap filter", "restart", "log temperature"]) {
      expect((await call("POST", `/dashboard/tasks/${t}/steps?viewer=${OWNER}`, { title })).statusCode).toBe(201);
    }
    const detail = (await call("GET", `/dashboard/tasks/${t}?viewer=${OWNER}`)).json() as {
      task: { progress_pct: number; progress_source: string; behind: boolean };
      steps: { id: string; done: boolean }[];
    };
    expect(detail.steps.length).toBe(4);
    expect(detail.task).toMatchObject({ progress_pct: 0, progress_source: "counted", behind: false });

    const tick = await call("PATCH", `/dashboard/steps/${detail.steps[0]!.id}?viewer=${OWNER}`, { done: true });
    expect(tick.statusCode).toBe(200);
    const after = (await call("GET", `/dashboard/tasks/${t}?viewer=${OWNER}`)).json() as { task: { progress_pct: number } };
    expect(after.task.progress_pct).toBe(25);
  });

  it("a manager may tick a report's step; a stranger cannot even see the task", async () => {
    const t = await newTask("TSK manager ticks");
    const step = (await call("POST", `/dashboard/tasks/${t}/steps?viewer=${OWNER}`, { title: "only step" })).json() as { id: string };
    expect((await call("PATCH", `/dashboard/steps/${step.id}?viewer=${MGR}`, { done: true })).statusCode).toBe(200);
    expect((await call("GET", `/dashboard/tasks/${t}?viewer=${STRANGER}`)).statusCode).toBe(403);
    expect((await call("PATCH", `/dashboard/steps/${step.id}?viewer=${STRANGER}`, { done: false })).statusCode).toBe(403);
  });

  it("a self-reported percentage without a note is refused by validation; with one it is labelled", async () => {
    const t = await newTask("TSK self report");
    expect((await call("POST", `/dashboard/tasks/${t}/progress?viewer=${OWNER}`, { pct: 70, note: "" })).statusCode).toBe(400);
    expect((await call("POST", `/dashboard/tasks/${t}/progress?viewer=${OWNER}`, { pct: 70, note: "two of three vans" })).statusCode).toBe(200);
    const d = (await call("GET", `/dashboard/tasks/${t}?viewer=${MGR}`)).json() as {
      task: { progress_pct: number; progress_source: string; progress_note: string };
      history: { source: string; note: string | null }[];
    };
    expect(d.task).toMatchObject({ progress_pct: 70, progress_source: "self_reported", progress_note: "two of three vans" });
    expect(d.history[0]).toMatchObject({ source: "self_reported", note: "two of three vans" });
  });

  it("flags a task as behind when the clock has run further than the work", async () => {
    const t = await newTask("TSK behind");
    // Started two days ago, due in one day: 67% of the time gone, 0% of the work.
    const sql = getServiceSql();
    await sql`update task set started_at = now() - interval '2 days', due_at = now() + interval '1 day' where id = ${t}`;
    const d = (await call("GET", `/dashboard/tasks/${t}?viewer=${OWNER}`)).json() as {
      task: { elapsed_pct: number; progress_pct: number; behind: boolean; behind_threshold: number };
    };
    expect(d.task.elapsed_pct).toBeGreaterThanOrEqual(60);
    expect(d.task.behind).toBe(true);
    expect(d.task.behind_threshold).toBe(30);
  });
});

describe("relations, closing, resolving", () => {
  it("links two tasks both ways, refuses a loop with 409, and closes a task with a reason", async () => {
    const a = await newTask("TSK rel a");
    const b = await newTask("TSK rel b");
    expect((await call("POST", `/dashboard/tasks/${a}/relations?viewer=${OWNER}`, { toTaskId: b, kind: "blocks" })).statusCode).toBe(201);
    const db = (await call("GET", `/dashboard/tasks/${b}?viewer=${OWNER}`)).json() as { relations: { kind: string; to_task_id: string }[] };
    expect(db.relations).toEqual([expect.objectContaining({ kind: "blocked_by", to_task_id: a })]);
    expect((await call("POST", `/dashboard/tasks/${b}/relations?viewer=${OWNER}`, { toTaskId: a, kind: "blocks" })).statusCode).toBe(409);

    const closed = await call("POST", `/dashboard/tasks/${a}/close?viewer=${OWNER}`, { resolution: "wont_do" });
    expect(closed.statusCode).toBe(200);
    const d = (await call("GET", `/dashboard/tasks/${a}?viewer=${OWNER}`)).json() as { task: { status: string; resolution: string } };
    expect(d.task).toMatchObject({ status: "cancelled", resolution: "wont_do" });
  });

  it("resolving a blocker needs a note and the right person", async () => {
    const t = await newTask("TSK blocker");
    const sql = getServiceSql();
    const [u] = await sql<{ id: string }[]>`insert into task_update (task_id, employee_id, status, is_synthetic) values (${t}, ${OWNER}, 'blocker', true) returning id`;
    const [b] = await sql<{ id: string }[]>`insert into blocker (task_update_id, raised_by, assigned_resolver, severity, status, category, is_synthetic)
      values (${u!.id}, ${OWNER}, ${DEMO_CEO_ID}, 'high', 'open', 'equipment', true) returning id`;
    expect((await call("POST", `/dashboard/blockers/${b!.id}/resolve?viewer=${STRANGER}`, { note: "fixed it" })).statusCode).toBe(403);
    expect((await call("POST", `/dashboard/blockers/${b!.id}/resolve?viewer=${MGR}`, { note: "" })).statusCode).toBe(400);
    expect((await call("POST", `/dashboard/blockers/${b!.id}/resolve?viewer=${MGR}`, { note: "Relay replaced, chiller back on" })).statusCode).toBe(200);
    const d = (await call("GET", `/dashboard/tasks/${t}?viewer=${OWNER}`)).json() as { blockers: { status: string; resolution_note: string; resolved_by_name: string }[] };
    expect(d.blockers[0]).toMatchObject({ status: "resolved", resolution_note: "Relay replaced, chiller back on", resolved_by_name: "TSK-Mgr" });
  });
});
