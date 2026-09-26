import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, DEMO_CEO_ID, getServiceSql, seedDemo } from "@freshnow/core";
import { buildServer } from "./server.js";

const app = buildServer(false);
const PRIYA = "d0000000-0000-0000-0000-000000000002"; // has exactly 1 blocker in the seed
const SEED_CORR = "5eed5eed-5eed-5eed-5eed-5eed5eed5eed";
const IDS = [
  "d0000000-0000-0000-0000-000000000001", "d0000000-0000-0000-0000-000000000002",
  "d0000000-0000-0000-0000-000000000003", "d0000000-0000-0000-0000-000000000004",
  "d0000000-0000-0000-0000-000000000005",
];

beforeAll(async () => {
  await seedDemo();
});
afterAll(async () => {
  const sql = getServiceSql();
  await sql`delete from escalation where blocker_id in (select id from blocker where raised_by in ${sql(IDS)})`;
  await sql`delete from blocker where raised_by in ${sql(IDS)}`;
  await sql`delete from task_update where employee_id in ${sql(IDS)}`;
  await sql`delete from task where employee_id in ${sql(IDS)}`;
  await sql`delete from run_trace where correlation_id = ${SEED_CORR}`;
  await sql`delete from audit_log where correlation_id = ${SEED_CORR}`;
  await sql`delete from notification_outbox where idempotency_key like 'blocker-%'`;
  await sql`delete from employee where id in ${sql(IDS)}`;
  await app.close();
  await closeDb();
});

describe("dashboard", () => {
  it("serves the dashboard HTML at /", async () => {
    const r = await app.inject({ method: "GET", url: "/" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/html");
    expect(r.body).toContain("FreshNow");
  });

  it("CEO sees all blockers; an employee sees only their own (RLS)", async () => {
    const ceo = (await app.inject({ method: "GET", url: "/dashboard/blockers?viewer=ceo" })).json() as { raised_by_name: string }[];
    expect(ceo.length).toBeGreaterThanOrEqual(3);

    const priya = (await app.inject({ method: "GET", url: `/dashboard/blockers?viewer=${PRIYA}` })).json() as { raised_by_name: string }[];
    expect(priya.length).toBe(1);
    expect(priya.every((b) => b.raised_by_name.includes("Priya"))).toBe(true);
  });

  it("the week is counted by Postgres under RLS: seven days, zeros kept, an employee's own numbers only", async () => {
    type Day = { day: string; completed: number; pending: number; blocked: number };
    const ceo = (await app.inject({ method: "GET", url: "/dashboard/week?viewer=ceo" })).json() as Day[];
    expect(ceo.length).toBe(7);
    // Ordered, contiguous, ending today (company time).
    for (let i = 1; i < ceo.length; i++) {
      expect(new Date(ceo[i]!.day).getTime() - new Date(ceo[i - 1]!.day).getTime()).toBe(86_400_000);
    }
    expect(ceo.every((d) => typeof d.completed === "number" && typeof d.pending === "number" && typeof d.blocked === "number")).toBe(true);
    const ceoTotal = ceo.reduce((a, d) => a + d.completed + d.pending + d.blocked, 0);

    const priya = (await app.inject({ method: "GET", url: `/dashboard/week?viewer=${PRIYA}` })).json() as Day[];
    expect(priya.length).toBe(7);
    const priyaTotal = priya.reduce((a, d) => a + d.completed + d.pending + d.blocked, 0);
    // The seed gives Priya some of the week's updates and other people the rest.
    expect(priyaTotal).toBeGreaterThan(0);
    expect(priyaTotal).toBeLessThan(ceoTotal);
  });

  it("an employee sees only their own employee row (RLS)", async () => {
    const rows = (await app.inject({ method: "GET", url: `/dashboard/employees?viewer=${PRIYA}` })).json() as { id: string }[];
    expect(rows.length).toBe(1);
    expect(rows[0]?.id).toBe(PRIYA);
  });

  it("an employee sees the work the CEO gave them, with the CEO named — without seeing the CEO's row", async () => {
    // The employee policy hides the CEO's row from Priya. Her assignments must still show
    // up, and still say who gave them; the first real browser sign-in found they did not.
    const sql = getServiceSql();
    const [task] = await sql<{ id: string }[]>`
      insert into task (employee_id, title, status, is_synthetic)
      values (${PRIYA}, 'Dashboard visibility check', 'open', true) returning id`;
    const [a] = await sql<{ id: string }[]>`
      insert into assignment (task_id, assigned_by, assigned_to, status, is_synthetic)
      values (${task!.id}, ${DEMO_CEO_ID}, ${PRIYA}, 'assigned', true) returning id`;
    try {
      const mine = (await app.inject({ method: "GET", url: `/dashboard/assignments?viewer=${PRIYA}` })).json() as {
        id: string;
        assigned_by: string;
        assigned_to: string;
      }[];
      const row = mine.find((r) => r.id === a!.id);
      expect(row).toBeDefined();
      expect(row!.assigned_by).toBe("DEMO CEO");
      expect(row!.assigned_to).toContain("Priya");
      // The name came through a narrow window, not a widened row policy.
      const people = (await app.inject({ method: "GET", url: `/dashboard/employees?viewer=${PRIYA}` })).json() as { id: string }[];
      expect(people.map((p) => p.id)).toEqual([PRIYA]);
    } finally {
      await sql`delete from assignment where id = ${a!.id}`;
      await sql`delete from task where id = ${task!.id}`;
    }
  });
});
