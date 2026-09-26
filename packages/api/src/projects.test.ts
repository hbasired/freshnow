import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getServiceSql } from "@freshnow/core";
import { buildServer } from "./server.js";

/**
 * The project portal over HTTP: who may start a project, who may change its plan, who may
 * only contribute, and who cannot see it at all — plus the two refusals that matter
 * (ticking a milestone over open work, and filing a task under someone else's milestone).
 */
const app = buildServer(false);
const LEAD = randomUUID();
const BOSS = randomUUID();
const MEMBER = randomUUID();
const STRANGER = randomUUID();

beforeAll(async () => {
  const sql = getServiceSql();
  await sql`insert into employee (id, display_name, status, is_synthetic, access_role, department) values
    (${BOSS}, 'PRJ-Boss', 'active', true, 'manager', 'production'),
    (${MEMBER}, 'PRJ-Member', 'active', true, 'employee', 'production'),
    (${STRANGER}, 'PRJ-Stranger', 'active', true, 'employee', 'delivery')`;
  await sql`insert into employee (id, display_name, status, is_synthetic, access_role, department, manager_employee_id) values
    (${LEAD}, 'PRJ-Lead', 'active', true, 'manager', 'production', ${BOSS})`;
});

afterAll(async () => {
  const sql = getServiceSql();
  const ids = [LEAD, BOSS, MEMBER, STRANGER];
  await sql`delete from notification_outbox where recipient_employee_id = any(${ids})`;
  await sql`delete from task where employee_id = any(${ids})`;
  await sql`delete from project where name like 'PRJ %'`; // children cascade
  await sql`delete from audit_log where actor = any(${ids.map((i) => `employee:${i}`)})`;
  await sql`delete from employee where id = any(${ids})`;
  await app.close();
  await closeDb();
});

const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) =>
  app.inject({ method, url, ...(payload ? { payload } : {}) });

async function newProject(name: string): Promise<string> {
  const r = await call("POST", `/dashboard/projects?viewer=${LEAD}`, { name, leadEmployeeId: LEAD });
  return (r.json() as { projectId: string }).projectId;
}

describe("starting and shaping a project", () => {
  it("a manager may start one; an ordinary employee may not", async () => {
    expect((await call("POST", `/dashboard/projects?viewer=${STRANGER}`, { name: "PRJ not allowed" })).statusCode).toBe(403);
    const r = await call("POST", `/dashboard/projects?viewer=${LEAD}`, {
      name: "PRJ bottling line",
      purpose: "Fill 500 bottles an hour without a second shift",
      leadEmployeeId: LEAD,
      startDate: "2026-09-01",
      targetDate: "2026-12-01",
    });
    expect(r.statusCode).toBe(201);

    const id = (r.json() as { projectId: string }).projectId;
    const d = (await call("GET", `/dashboard/projects/${id}?viewer=${LEAD}`)).json() as {
      project: { name: string; purpose: string; lead_name: string };
      progress: { progress_pct: number; progress_source: string; schedule_elapsed_pct: number | null };
      members: { name: string; role: string }[];
      may: { manage: boolean; contribute: boolean };
    };
    expect(d.project).toMatchObject({ name: "PRJ bottling line", lead_name: "PRJ-Lead" });
    expect(d.progress).toMatchObject({ progress_pct: 0, progress_source: "tasks" });
    // Whoever is named on it is a member from the start, and the lead who created it is
    // recorded as the lead, not demoted to an ordinary member by their own creation.
    expect(d.members.map((m) => m.role)).toEqual(["lead"]);
    expect(d.may).toEqual({ manage: true, contribute: true });
  });

  it("validation refuses a nameless project and a malformed date", async () => {
    expect((await call("POST", `/dashboard/projects?viewer=${LEAD}`, { name: "no" })).statusCode).toBe(400);
    expect((await call("POST", `/dashboard/projects?viewer=${LEAD}`, { name: "PRJ dates", targetDate: "01-12-2026" })).statusCode).toBe(400);
  });

  it("the plan — requirements with MoSCoW and acceptance, milestones with weights — reads back in order", async () => {
    const id = await newProject("PRJ plan");
    for (const [text, priority] of [["Fill 500 bottles an hour", "must"], ["Quiet enough for the night shift", "could"], ["No new floor space", "wont"]] as const) {
      expect((await call("POST", `/dashboard/projects/${id}/requirements?viewer=${LEAD}`, { text, priority, acceptance: "Measured over one shift" })).statusCode).toBe(201);
    }
    await call("POST", `/dashboard/projects/${id}/milestones?viewer=${LEAD}`, { name: "Installed", weight: 3, dueDate: "2026-10-01" });
    await call("POST", `/dashboard/projects/${id}/milestones?viewer=${LEAD}`, { name: "Signed off", weight: 1 });

    const d = (await call("GET", `/dashboard/projects/${id}?viewer=${LEAD}`)).json() as {
      requirements: { text: string; priority: string; acceptance: string }[];
      milestones: { name: string; weight: number; tasks_total: number }[];
    };
    // must first, then could, then wont — the order you review them in.
    expect(d.requirements.map((r) => r.priority)).toEqual(["must", "could", "wont"]);
    expect(d.requirements[0]?.acceptance).toBe("Measured over one shift");
    expect(d.milestones.map((m) => m.name)).toEqual(["Installed", "Signed off"]);
  });
});

describe("the refusals", () => {
  it("ticking a milestone over open work is a 409 that says how much is open, until it is forced", async () => {
    const id = await newProject("PRJ gate");
    const m = (await call("POST", `/dashboard/projects/${id}/milestones?viewer=${LEAD}`, { name: "Ready" })).json() as { id: string };
    const t = (await call("POST", `/dashboard/tasks?viewer=${LEAD}`, { title: "PRJ unfinished work" })).json() as { taskId: string };
    expect((await call("PATCH", `/dashboard/tasks/${t.taskId}/project?viewer=${LEAD}`, { projectId: id, milestoneId: m.id })).statusCode).toBe(200);

    const refused = await call("PATCH", `/dashboard/milestones/${m.id}?viewer=${LEAD}`, { status: "done" });
    expect(refused.statusCode).toBe(409);
    expect((refused.json() as { error: { message: string } }).error.message).toMatch(/1 task\(s\)/);

    const forced = await call("PATCH", `/dashboard/milestones/${m.id}?viewer=${LEAD}`, { status: "done", force: true });
    expect(forced.statusCode).toBe(200);
  });

  it("a task cannot be filed under a milestone from another project", async () => {
    const a = await newProject("PRJ alpha");
    const b = await newProject("PRJ beta");
    const m = (await call("POST", `/dashboard/projects/${b}/milestones?viewer=${LEAD}`, { name: "Elsewhere" })).json() as { id: string };
    const t = (await call("POST", `/dashboard/tasks?viewer=${LEAD}`, { title: "PRJ wandering task" })).json() as { taskId: string };
    const r = await call("PATCH", `/dashboard/tasks/${t.taskId}/project?viewer=${LEAD}`, { projectId: a, milestoneId: m.id });
    expect(r.statusCode).toBe(400);
    expect((r.json() as { error: { message: string } }).error.message).toMatch(/different project/);
  });

  it("health needs a reason", async () => {
    const id = await newProject("PRJ health");
    expect((await call("POST", `/dashboard/projects/${id}/health?viewer=${LEAD}`, { health: "red", note: "x" })).statusCode).toBe(400);
    expect((await call("POST", `/dashboard/projects/${id}/health?viewer=${LEAD}`, { health: "red", note: "Supplier slipped two weeks" })).statusCode).toBe(200);
  });
});

describe("who may do what", () => {
  it("a member may post an update and raise an issue but not change the plan", async () => {
    const id = await newProject("PRJ rights");
    await call("POST", `/dashboard/projects/${id}/members?viewer=${LEAD}`, { employeeId: MEMBER });

    expect((await call("POST", `/dashboard/projects/${id}/updates?viewer=${MEMBER}`, { narrative: "Frame delivered" })).statusCode).toBe(201);
    expect((await call("POST", `/dashboard/projects/${id}/issues?viewer=${MEMBER}`, { title: "Pump may not arrive in time", kind: "risk" })).statusCode).toBe(201);
    expect((await call("POST", `/dashboard/projects/${id}/milestones?viewer=${MEMBER}`, { name: "Sneaky" })).statusCode).toBe(403);
    expect((await call("PATCH", `/dashboard/projects/${id}?viewer=${MEMBER}`, { name: "PRJ renamed" })).statusCode).toBe(403);

    const d = (await call("GET", `/dashboard/projects/${id}?viewer=${MEMBER}`)).json() as { may: { manage: boolean; contribute: boolean } };
    expect(d.may).toEqual({ manage: false, contribute: true });
  });

  it("the lead's manager may change the plan; a stranger cannot see the project at all", async () => {
    const id = await newProject("PRJ visibility");
    expect((await call("POST", `/dashboard/projects/${id}/milestones?viewer=${BOSS}`, { name: "Boss added this" })).statusCode).toBe(201);

    expect((await call("GET", `/dashboard/projects/${id}?viewer=${STRANGER}`)).statusCode).toBe(403);
    expect((await call("POST", `/dashboard/projects/${id}/updates?viewer=${STRANGER}`, { narrative: "I should not be here" })).statusCode).toBe(403);

    const list = (await call("GET", `/dashboard/projects?viewer=${STRANGER}`)).json() as { name: string }[];
    expect(list.some((p) => p.name === "PRJ visibility")).toBe(false);
    const mine = (await call("GET", `/dashboard/projects?viewer=${LEAD}`)).json() as { name: string }[];
    expect(mine.some((p) => p.name === "PRJ visibility")).toBe(true);
  });
});

describe("progress the page shows", () => {
  it("a reported percentage comes back beside the computed one, and never replaces it", async () => {
    const id = await newProject("PRJ claims");
    const t = (await call("POST", `/dashboard/tasks?viewer=${LEAD}`, { title: "PRJ the only task" })).json() as { taskId: string };
    await call("PATCH", `/dashboard/tasks/${t.taskId}/project?viewer=${LEAD}`, { projectId: id });

    const r = await call("POST", `/dashboard/projects/${id}/updates?viewer=${LEAD}`, { narrative: "Nearly done honestly", pctReported: 95 });
    expect(r.statusCode).toBe(201);
    expect((r.json() as { computedPct: number }).computedPct).toBe(0);

    const d = (await call("GET", `/dashboard/projects/${id}?viewer=${LEAD}`)).json() as {
      progress: { progress_pct: number };
      updates: { pct_reported: number; narrative: string }[];
    };
    expect(d.progress.progress_pct).toBe(0);
    expect(d.updates[0]).toMatchObject({ pct_reported: 95, narrative: "Nearly done honestly" });
  });

  it("a project past most of its time with no work done is flagged behind", async () => {
    const r = await call("POST", `/dashboard/projects?viewer=${LEAD}`, {
      name: "PRJ late", leadEmployeeId: LEAD,
      startDate: new Date(Date.now() - 9 * 86_400_000).toISOString().slice(0, 10),
      targetDate: new Date(Date.now() + 1 * 86_400_000).toISOString().slice(0, 10),
    });
    const id = (r.json() as { projectId: string }).projectId;
    const t = (await call("POST", `/dashboard/tasks?viewer=${LEAD}`, { title: "PRJ not started" })).json() as { taskId: string };
    await call("PATCH", `/dashboard/tasks/${t.taskId}/project?viewer=${LEAD}`, { projectId: id });

    const list = (await call("GET", `/dashboard/projects?viewer=${LEAD}`)).json() as { name: string; behind: boolean }[];
    expect(list.find((p) => p.name === "PRJ late")?.behind).toBe(true);
    expect(list.find((p) => p.name === "PRJ claims")?.behind).toBe(false); // no dates, no opinion
  });
});
