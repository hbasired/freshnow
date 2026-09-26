import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, getServiceSql } from "./db.js";
import { DEMO_CEO_ID } from "./meta.js";
import { replayRun } from "./replay.js";
import { routeBlocker } from "./routing.js";

const CORR = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const CORR2 = "ffffffff-ffff-ffff-ffff-ffffffffffff";

async function makeBlocker(corr: string, category = "equipment"): Promise<string> {
  const sql = getServiceSql();
  const empId = randomUUID();
  const blockerId = randomUUID();
  await sql`insert into employee (id, display_name, status, is_synthetic) values (${empId}, 'REPLAYTEST', 'active', true)`;
  await sql`insert into blocker (id, raised_by, category, severity, status, correlation_id, is_synthetic)
            values (${blockerId}, ${empId}, ${category}, 'high', 'open', ${corr}, true)`;
  return blockerId;
}

afterEach(async () => {
  const sql = getServiceSql();
  for (const c of [CORR, CORR2]) {
    await sql`delete from blocker where correlation_id = ${c}`;
    await sql`delete from audit_log where correlation_id = ${c}`;
    await sql`delete from run_trace where correlation_id = ${c}`;
  }
  await sql`delete from employee where display_name = 'REPLAYTEST'`;
  await sql`delete from notification_outbox where idempotency_key like 'blocker.raised:%'`;
});
afterAll(async () => {
  await closeDb();
});

describe("replayRun", () => {
  it("re-derives the same routing decision — no divergence", async () => {
    const blockerId = await makeBlocker(CORR);
    await routeBlocker(blockerId, CORR); // records audit 'blocker.routed' with resolverId = CEO

    const report = await replayRun(CORR);
    expect(report.checks.length).toBe(1);
    expect(report.checks[0]?.original).toBe(DEMO_CEO_ID);
    expect(report.checks[0]?.rederived).toBe(DEMO_CEO_ID);
    expect(report.diverged).toBe(false);
  });

  it("reports divergence when the recorded decision differs from re-derivation", async () => {
    const blockerId = await makeBlocker(CORR2);
    const sql = getServiceSql();
    const bogus = randomUUID();
    // A past decision that routed elsewhere, as if the routing table changed since. The
    // recorded INPUT is what replay re-derives from — that is the whole point.
    await sql`insert into audit_log (correlation_id, actor, action, entity, entity_id, detail)
              values (${CORR2}, 'system', 'blocker.routed', 'blocker', ${blockerId},
                      ${sql.json({ resolverId: bogus, input: { category: "equipment", severity: "high", site: null, shift: null } } as never)})`;

    const report = await replayRun(CORR2);
    expect(report.found).toBe(true);
    expect(report.diverged).toBe(true);
    expect(report.checks[0]?.original).toBe(bogus);
    expect(report.checks[0]?.rederived).toBe(DEMO_CEO_ID);
    expect(report.checks[0]?.matches).toBe(false);
  });

  /**
   * The three behaviours an audit on 2026-09-18 found wrong. Each one made replay report
   * something reassuring that was not true, which is worse than reporting nothing.
   */
  it("says a run does not exist, instead of reporting it as clean", async () => {
    const report = await replayRun("11111111-1111-4111-8111-111111111111");
    // This used to return {steps: 0, checks: [], diverged: false} — indistinguishable from
    // "replayed fine". `found` is the difference.
    expect(report.found).toBe(false);
    expect(report.diverged).toBe(false);
    expect(report.checks).toEqual([]);
  });

  it("re-derives from the RECORDED input, not from the live row", async () => {
    const blockerId = await makeBlocker(CORR);
    await routeBlocker(blockerId, CORR);
    const sql = getServiceSql();

    // Change the blocker's category AFTER the decision, then delete the row outright —
    // the reset script does exactly this, and it is why 90% of real runs used to report
    // divergence. A replay must be unaffected by both.
    await sql`update blocker set category = 'quality' where id = ${blockerId}`;
    await sql`delete from blocker where id = ${blockerId}`;

    const report = await replayRun(CORR);
    expect(report.found).toBe(true);
    expect(report.checks.length).toBe(1);
    expect(report.checks[0]?.input?.category).toBe("equipment"); // as recorded, not as changed
    expect(report.checks[0]?.rederived).toBe(DEMO_CEO_ID);
    expect(report.diverged).toBe(false);
  });

  it("counts a run with no recorded inputs as unreplayable, not as diverged", async () => {
    const blockerId = await makeBlocker(CORR2);
    const sql = getServiceSql();
    await sql`insert into audit_log (correlation_id, actor, action, entity, entity_id, detail)
              values (${CORR2}, 'system', 'blocker.routed', 'blocker', ${blockerId}, ${sql.json({ resolverId: DEMO_CEO_ID } as never)})`;

    const report = await replayRun(CORR2);
    expect(report.found).toBe(true);
    expect(report.unreplayable).toBe(1);
    // Unknown is not the same as wrong: an un-run check must not colour the verdict.
    expect(report.diverged).toBe(false);
    expect(report.checks[0]?.unreplayable).toMatch(/predates input recording/);
  });

  it("writes the replay spine: a routed run leaves a run_trace row with its inputs", async () => {
    const blockerId = await makeBlocker(CORR);
    await routeBlocker(blockerId, CORR);
    const sql = getServiceSql();
    const trace = await sql<{ step: string; input: { category: string }; output: { resolverId: string } }[]>`
      select step, input, output from run_trace where correlation_id = ${CORR}`;
    // Before 2026-09-18 nothing but seed.ts ever wrote here.
    expect(trace.map((t) => t.step)).toContain("route_blocker");
    const routed = trace.find((t) => t.step === "route_blocker")!;
    expect(routed.input.category).toBe("equipment");
    expect(routed.output.resolverId).toBe(DEMO_CEO_ID);
    expect((await replayRun(CORR)).steps).toBeGreaterThan(0);
  });
});
