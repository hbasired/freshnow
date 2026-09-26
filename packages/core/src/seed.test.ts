import { afterAll, describe, expect, it } from "vitest";
import { closeDb, getServiceSql } from "./db.js";
import { seedDemo } from "./seed.js";

const SEED_CORR = "5eed5eed-5eed-5eed-5eed-5eed5eed5eed";
const IDS = [
  "d0000000-0000-0000-0000-000000000001",
  "d0000000-0000-0000-0000-000000000002",
  "d0000000-0000-0000-0000-000000000003",
  "d0000000-0000-0000-0000-000000000004",
  "d0000000-0000-0000-0000-000000000005",
];

afterAll(async () => {
  const sql = getServiceSql();
  await sql`delete from escalation where blocker_id in (select id from blocker where raised_by in ${sql(IDS)})`;
  await sql`delete from blocker where raised_by in ${sql(IDS)}`;
  await sql`delete from task_update where employee_id in ${sql(IDS)}`;
  await sql`delete from task where employee_id in ${sql(IDS)}`;
  await sql`delete from run_trace where correlation_id = ${SEED_CORR}`;
  await sql`delete from audit_log where correlation_id = ${SEED_CORR}`;
  await sql`delete from notification_outbox where idempotency_key like 'blocker.raised:%' or idempotency_key like 'blocker.escalated:%'`;
  await sql`delete from employee where id in ${sql(IDS)}`;
  await closeDb();
});

describe("seedDemo", () => {
  it("is idempotent and labels every row synthetic", async () => {
    const a = await seedDemo();
    const b = await seedDemo();
    expect(b).toEqual(a); // re-running produces the same counts, no duplication

    const sql = getServiceSql();
    const emp = await sql<{ n: number; syn: boolean }[]>`
      select count(*)::int as n, bool_and(is_synthetic) as syn from employee where id in ${sql(IDS)}`;
    expect(emp[0]?.n).toBe(a.employees);
    expect(emp[0]?.syn).toBe(true);

    const blk = await sql<{ syn: boolean }[]>`
      select bool_and(is_synthetic) as syn from blocker where correlation_id = ${SEED_CORR}`;
    expect(blk[0]?.syn).toBe(true);
  });
});
