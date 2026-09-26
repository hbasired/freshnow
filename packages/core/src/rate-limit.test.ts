import { afterAll, describe, expect, it } from "vitest";
import { closeDb, getServiceSql } from "./db.js";
import { checkRateLimit, LIMITS } from "./rate-limit.js";
import { logAudit } from "./audit.js";

async function makeEmployee(name: string): Promise<string> {
  const sql = getServiceSql();
  const rows = await sql<{ id: string }[]>`
    insert into employee (display_name, status, is_synthetic)
    values (${name}, 'active', true) returning id`;
  return rows[0]!.id;
}

afterAll(async () => {
  const sql = getServiceSql();
  const mine = `select id from employee where display_name like 'RL-%'`;
  await sql.unsafe(`delete from employee where id in (${mine})`);
  await closeDb();
});

describe("per-person caps on expensive work", () => {
  it("allows ordinary use without complaint", async () => {
    const who = await makeEmployee("RL-normal");
    for (let i = 0; i < 3; i++) {
      await logAudit({ actor: `employee:${who}`, action: "document.planned", entity: "document" });
    }
    const d = await checkRateLimit({ key: "document", employeeId: who });
    // A busy morning must never meet an abuse ceiling.
    expect(d.allowed).toBe(true);
    expect(d.used).toBe(3);
  });

  it("refuses once the window is full, and says when to retry", async () => {
    const who = await makeEmployee("RL-flood");
    const max = LIMITS.document!.max;
    for (let i = 0; i < max; i++) {
      await logAudit({ actor: `employee:${who}`, action: "document.planned", entity: "document" });
    }
    const d = await checkRateLimit({ key: "document", employeeId: who });
    expect(d.allowed).toBe(false);
    expect(d.used).toBe(max);
    expect(d.retryAfterMinutes).toBeGreaterThan(0);
    // Being refused must never imply the work was thrown away.
    expect(d.message).toMatch(/nothing you sent was lost/i);
  });

  it("counts blocked and flagged documents too, so refusals are not free", async () => {
    const who = await makeEmployee("RL-blocked");
    for (let i = 0; i < LIMITS.document!.max; i++) {
      await logAudit({ actor: `employee:${who}`, action: "document.blocked", entity: "document" });
    }
    // Otherwise sending malformed files forever would cost the attacker nothing.
    expect((await checkRateLimit({ key: "document", employeeId: who })).allowed).toBe(false);
  });

  it("counts each person separately", async () => {
    const a = await makeEmployee("RL-a");
    const b = await makeEmployee("RL-b");
    for (let i = 0; i < LIMITS.document!.max; i++) {
      await logAudit({ actor: `employee:${a}`, action: "document.planned", entity: "document" });
    }
    expect((await checkRateLimit({ key: "document", employeeId: a })).allowed).toBe(false);
    expect((await checkRateLimit({ key: "document", employeeId: b })).allowed).toBe(true);
  });

  it("records a refusal in the audit trail", async () => {
    const who = await makeEmployee("RL-audit");
    for (let i = 0; i < LIMITS.document!.max; i++) {
      await logAudit({ actor: `employee:${who}`, action: "document.planned", entity: "document" });
    }
    await checkRateLimit({ key: "document", employeeId: who });

    const sql = getServiceSql();
    const rows = await sql<{ n: number }[]>`
      select count(*)::int as n from audit_log
      where actor = ${`employee:${who}`} and action = 'security.rate_limited'`;
    // Hitting a limit is a security event, not merely a UX one.
    expect(rows[0]!.n).toBeGreaterThanOrEqual(1);
  });
});
