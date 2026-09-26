import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getServiceSql, withContext } from "./db.js";

// These tests attack the RLS boundary rather than assert what the code does:
// they try to read another employee's rows, insert across tenants, and tamper
// with the append-only audit log — and confirm the database refuses.
// They run against the real Postgres (migrated by vitest globalSetup).

const CEO = "00000000-0000-0000-0000-0000000000ce"; // seeded demo CEO
const A = randomUUID();
const B = randomUUID();
const taskA = randomUUID();
const taskB = randomUUID();
const updA = randomUUID();
const updB = randomUUID();
const blockerA = randomUUID();
const corr = randomUUID();

// Distinct, unlikely-to-collide Telegram ids (bigint range).
const base = 8_100_000_000_000;
const tgA = String(base + Math.floor(Math.random() * 1_000_000_000));
const tgB = String(base + 1_000_000_000 + Math.floor(Math.random() * 1_000_000_000));

beforeAll(async () => {
  const sql = getServiceSql(); // BYPASSRLS: sets up cross-employee fixtures
  await sql`insert into employee (id, display_name, telegram_user_id, status, is_synthetic)
            values (${A}, 'RLSTEST-A', ${tgA}, 'active', true),
                   (${B}, 'RLSTEST-B', ${tgB}, 'active', true)`;
  await sql`insert into task (id, employee_id, title, is_synthetic)
            values (${taskA}, ${A}, 'A task', true), (${taskB}, ${B}, 'B task', true)`;
  await sql`insert into task_update (id, task_id, employee_id, status, correlation_id, is_synthetic)
            values (${updA}, ${taskA}, ${A}, 'done', ${corr}, true),
                   (${updB}, ${taskB}, ${B}, 'pending', ${corr}, true)`;
  await sql`insert into blocker (id, raised_by, assigned_resolver, category, severity, correlation_id, is_synthetic)
            values (${blockerA}, ${A}, ${CEO}, 'equipment', 'high', ${corr}, true)`;
});

afterAll(async () => {
  const sql = getServiceSql();
  await sql`delete from blocker where id = ${blockerA}`;
  await sql`delete from task_update where id in (${updA}, ${updB})`;
  await sql`delete from task where id in (${taskA}, ${taskB})`;
  await sql`delete from employee where id in (${A}, ${B})`;
  await closeDb();
});

describe("RLS — employee isolation (app role)", () => {
  it("employee A sees their own task_update, not employee B's", async () => {
    const rows = await withContext({ employeeId: A }, (sql) => sql`select id from task_update`);
    const ids = rows.map((r) => r.id as string);
    expect(ids).toContain(updA);
    expect(ids).not.toContain(updB);
  });

  it("employee A cannot see employee B's employee row", async () => {
    const rows = await withContext({ employeeId: A }, (sql) => sql`select id from employee where id = ${B}`);
    expect(rows.length).toBe(0);
  });

  it("a blocker is visible to the raiser but not to an unrelated employee", async () => {
    const seenByA = await withContext({ employeeId: A }, (sql) => sql`select id from blocker where id = ${blockerA}`);
    const seenByB = await withContext({ employeeId: B }, (sql) => sql`select id from blocker where id = ${blockerA}`);
    expect(seenByA.length).toBe(1);
    expect(seenByB.length).toBe(0);
  });

  it("employee A cannot INSERT a task_update for employee B (WITH CHECK blocks it)", async () => {
    await expect(
      withContext({ employeeId: A }, (sql) =>
        sql`insert into task_update (task_id, employee_id, status, correlation_id, is_synthetic)
            values (${taskB}, ${B}, 'done', ${corr}, true)`),
    ).rejects.toThrow();
  });
});

describe("RLS — CEO sees all; service bypasses", () => {
  it("CEO context sees every employee's task_update", async () => {
    const rows = await withContext({ isCeo: true, employeeId: CEO }, (sql) => sql`select id from task_update`);
    const ids = rows.map((r) => r.id as string);
    expect(ids).toContain(updA);
    expect(ids).toContain(updB);
  });

  it("service role reads across all employees (bypass)", async () => {
    const sql = getServiceSql();
    const rows = await sql`select id from task_update where id in (${updA}, ${updB})`;
    expect(rows.length).toBe(2);
  });
});

describe("audit_log is append-only", () => {
  it("app role can INSERT an audit row but cannot UPDATE one", async () => {
    await withContext({ employeeId: A }, (sql) =>
      sql`insert into audit_log (correlation_id, actor, action) values (${corr}, ${"employee:" + A}, 'test.audit')`);
    await expect(
      withContext({ employeeId: A }, (sql) =>
        sql`update audit_log set action = 'tamper' where correlation_id = ${corr}`),
    ).rejects.toThrow();
  });
});

describe("seed — degenerate routing to the CEO", () => {
  it("every routing rule resolves to the demo CEO", async () => {
    const sql = getServiceSql();
    const rows = await sql`select distinct resolver_employee_id from routing_rule`;
    expect(rows.length).toBe(1);
    expect(rows[0]?.resolver_employee_id).toBe(CEO);
  });
});
