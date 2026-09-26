import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getServiceSql } from "./db.js";
import { DEMO_CEO_ID } from "./meta.js";
import {
  acknowledgeBlocker,
  escalateBlocker,
  resolveForCategory,
  routeAndAlert,
  routeBlocker,
  slaMinutesFor,
  slaSweep,
} from "./routing.js";

const CORR = "cccccccc-cccc-cccc-cccc-cccccccccccc";

async function makeBlocker(
  category: string,
  severity: string,
): Promise<string> {
  const sql = getServiceSql();
  const empId = randomUUID();
  const blockerId = randomUUID();
  await sql`insert into employee (id, display_name, status, is_synthetic)
            values (${empId}, 'ROUTETEST', 'active', true)`;
  await sql`insert into blocker (id, raised_by, category, severity, status, correlation_id, is_synthetic)
            values (${blockerId}, ${empId}, ${category}, ${severity}, 'open', ${CORR}, true)`;
  return blockerId;
}

afterEach(async () => {
  const sql = getServiceSql();
  await sql`delete from escalation where blocker_id in (select id from blocker where correlation_id = ${CORR})`;
  await sql`delete from blocker where correlation_id = ${CORR}`;
  await sql`delete from employee where display_name = 'ROUTETEST'`;
  await sql`delete from notification_outbox where idempotency_key like 'blocker.raised:%' or idempotency_key like 'blocker.escalated:%'`;
  await sql`delete from alert where correlation_id = ${CORR}`;
  await sql`delete from audit_log where correlation_id = ${CORR}`;
});
afterAll(async () => {
  await closeDb();
});

describe("slaMinutesFor (deterministic per severity)", () => {
  it("maps each severity to its window", () => {
    expect(slaMinutesFor("critical")).toBe(15);
    expect(slaMinutesFor("high")).toBe(60);
    expect(slaMinutesFor("medium")).toBe(240);
    expect(slaMinutesFor("low")).toBe(1440);
    expect(slaMinutesFor("unknown")).toBe(240); // falls back to medium
  });
});

describe("routeBlocker (table lookup, no model call)", () => {
  it("routes a known category to the CEO and sets the SLA + audit", async () => {
    const id = await makeBlocker("equipment", "high");
    const r = await routeBlocker(id, CORR);
    expect(r.resolverId).toBe(DEMO_CEO_ID);
    expect(r.slaDueAt.getTime()).toBeGreaterThan(Date.now());

    const sql = getServiceSql();
    const b = await sql`select assigned_resolver from blocker where id = ${id}`;
    expect(b[0]?.assigned_resolver).toBe(DEMO_CEO_ID);
    const audit = await sql`select 1 from audit_log where correlation_id = ${CORR} and action = 'blocker.routed'`;
    expect(audit.length).toBe(1);
  });

  it("routes an unknown category to the CEO via the catch-all rule", async () => {
    const id = await makeBlocker("something-unmapped", "low");
    const r = await routeBlocker(id, CORR);
    expect(r.resolverId).toBe(DEMO_CEO_ID); // degenerate: everything → CEO
  });
});

describe("routeAndAlert", () => {
  it("routes and enqueues exactly one alert (idempotent)", async () => {
    const id = await makeBlocker("equipment", "critical");
    const first = await routeAndAlert(id, CORR);
    expect(first.alerted).toBe(true);
    const second = await routeAndAlert(id, CORR);
    expect(second.alerted).toBe(false); // same idempotency key → not re-enqueued

    const sql = getServiceSql();
    // One row per channel for the resolver (the CEO), keyed by event, entity, person,
    // channel. The test CEO has no Telegram link, so the in-app inbox is the one channel.
    const outbox = await sql<{ channel: string }[]>`select channel from notification_outbox
      where idempotency_key like ${`blocker.raised:${id}:${DEMO_CEO_ID}:%`}`;
    expect(outbox.map((r) => r.channel)).toEqual(["inapp"]);
  });
});

describe("escalateBlocker (rule, bounded levels)", () => {
  it("records escalating levels and one alert per level", async () => {
    const id = await makeBlocker("supply", "high");
    await routeBlocker(id, CORR); // rung 1 targets the resolver — unrouted, there is nobody there
    const a = await escalateBlocker(id, "test", CORR);
    expect(a.level).toBe(1);
    expect(a.notified).toBe(1);
    const b = await escalateBlocker(id, "test again", CORR);
    expect(b.level).toBe(2);

    const sql = getServiceSql();
    const esc = await sql`select level from escalation where blocker_id = ${id} order by level`;
    expect(esc.map((e) => e.level)).toEqual([1, 2]);
  });

  it("skips a rung with nobody available and records the skip", async () => {
    // Never routed and the raiser has no manager: rung 1 (resolver + manager) is empty.
    const id = await makeBlocker("supply", "high");
    const a = await escalateBlocker(id, "test", CORR);
    expect(a.level).toBe(2); // fell through to the CEO rung
    const sql = getServiceSql();
    const esc = await sql<{ level: number; escalated_to: string | null }[]>`
      select level, escalated_to from escalation where blocker_id = ${id} order by level`;
    expect(esc.map((e) => e.level)).toEqual([1, 2]);
    expect(esc[0]?.escalated_to).toBeNull();
    expect(esc[1]?.escalated_to).toBe(DEMO_CEO_ID);
  });

  it("stops at the top of the ladder", async () => {
    const id = await makeBlocker("supply", "critical");
    await routeBlocker(id, CORR);
    await escalateBlocker(id, "1", CORR);
    await escalateBlocker(id, "2", CORR);
    await escalateBlocker(id, "3", CORR);
    const r = await escalateBlocker(id, "4", CORR);
    expect(r.exhausted).toBe(true);
    expect(r.notified).toBe(0);
    const sql = getServiceSql();
    const esc = await sql`select 1 from escalation where blocker_id = ${id}`;
    expect(esc.length).toBe(3); // nothing recorded past the last rung
  });
});

describe("acknowledgeBlocker", () => {
  it("moves an open blocker to acknowledged", async () => {
    const id = await makeBlocker("quality", "medium");
    await acknowledgeBlocker(id, CORR);
    const sql = getServiceSql();
    const b = await sql`select status from blocker where id = ${id}`;
    expect(b[0]?.status).toBe("acknowledged");
  });
});

describe("slaSweep (safety net)", () => {
  it("escalates an open, overdue, not-yet-escalated blocker", async () => {
    const id = await makeBlocker("equipment", "high");
    await routeBlocker(id, CORR);
    const sql = getServiceSql();
    await sql`update blocker set sla_due_at = now() - interval '1 minute' where id = ${id}`;

    const r = await slaSweep(CORR);
    expect(r.escalated).toBeGreaterThanOrEqual(1);
    const esc = await sql`select level from escalation where blocker_id = ${id}`;
    expect(esc.length).toBe(1);
  });

  it("climbs one rung per timeout, and only when the timeout has passed", async () => {
    const id = await makeBlocker("equipment", "critical");
    await routeBlocker(id, CORR);
    const sql = getServiceSql();
    await sql`update blocker set sla_due_at = now() - interval '1 minute' where id = ${id}`;
    await slaSweep(CORR); // rung 1
    await slaSweep(CORR); // rung 2 is 30 minutes after rung 1 — not yet
    let esc = await sql<{ level: number }[]>`select level from escalation where blocker_id = ${id} order by level`;
    expect(esc.map((e) => e.level)).toEqual([1]);

    await sql`update escalation set created_at = now() - interval '31 minutes' where blocker_id = ${id}`;
    await slaSweep(CORR); // now rung 2 is due
    esc = await sql<{ level: number }[]>`select level from escalation where blocker_id = ${id} order by level`;
    expect(esc.map((e) => e.level)).toEqual([1, 2]);
  });

  it("leaves an acknowledged blocker alone", async () => {
    const id = await makeBlocker("equipment", "critical");
    await routeBlocker(id, CORR);
    const sql = getServiceSql();
    await sql`update blocker set sla_due_at = now() - interval '1 minute' where id = ${id}`;
    await acknowledgeBlocker(id, CORR, { by: DEMO_CEO_ID });
    await slaSweep(CORR);
    const esc = await sql`select 1 from escalation where blocker_id = ${id}`;
    expect(esc.length).toBe(0);
  });

  it("does not escalate a blocker that is not overdue", async () => {
    const id = await makeBlocker("supply", "low");
    // sla_due_at is NULL (never routed) → not swept
    const r = await slaSweep(CORR);
    const sql = getServiceSql();
    const esc = await sql`select 1 from escalation where blocker_id = ${id}`;
    expect(esc.length).toBe(0);
    expect(r.escalated).toBe(0);
  });
});

/**
 * Routing on the full (category, site, shift) key, most specific first. Until 2026-09-18
 * the query hardcoded `site is null and shift is null`, so every site- or shift-specific
 * rule was invisible — the company's real routing table would not have worked.
 */
describe("resolveForCategory matches site and shift, most specific first", () => {
  const RT = "ROUTETEST-RULE";
  let warehouseNight: string;
  let warehouseAny: string;
  let equipmentAny: string;

  async function resolver(name: string): Promise<string> {
    const id = randomUUID();
    await getServiceSql()`insert into employee (id, display_name, status, is_synthetic) values (${id}, ${`${RT} ${name}`}, 'active', true)`;
    return id;
  }

  beforeAll(async () => {
    warehouseNight = await resolver("warehouse night");
    warehouseAny = await resolver("warehouse any shift");
    equipmentAny = await resolver("equipment anywhere");
    const sql = getServiceSql();
    // Three rules of increasing specificity for the same category, beside the seeded
    // category-only and catch-all rules that route to the CEO.
    await sql`insert into routing_rule (category, site, shift, resolver_employee_id, is_synthetic) values
      ('equipment', 'Warehouse', 'night', ${warehouseNight}, true),
      ('equipment', 'Warehouse', null,    ${warehouseAny},   true)`;
    // The seeded 'equipment' rule (site null, shift null) already exists → CEO. Add a
    // distinct any-site equipment rule ONLY if the seed lacks one, so the test does not
    // depend on seed order.
    const seeded = await sql`select 1 from routing_rule where category = 'equipment' and site is null and shift is null`;
    if (seeded.length === 0) {
      await sql`insert into routing_rule (category, site, shift, resolver_employee_id, is_synthetic) values ('equipment', null, null, ${equipmentAny}, true)`;
    }
  });

  afterAll(async () => {
    const sql = getServiceSql();
    await sql`delete from routing_rule where resolver_employee_id in (select id from employee where display_name like ${`${RT} %`})`;
    await sql`delete from employee where display_name like ${`${RT} %`}`;
  });

  it("a rule naming category, site AND shift beats one naming fewer", async () => {
    expect(await resolveForCategory({ category: "equipment", site: "Warehouse", shift: "night" })).toBe(warehouseNight);
  });

  it("falls back to the site-only rule when the shift does not match", async () => {
    expect(await resolveForCategory({ category: "equipment", site: "Warehouse", shift: "day" })).toBe(warehouseAny);
  });

  it("falls back to the category-only rule for another site", async () => {
    const r = await resolveForCategory({ category: "equipment", site: "Van fleet", shift: "night" });
    expect(r).not.toBe(warehouseNight);
    expect(r).not.toBe(warehouseAny);
    expect(r).not.toBeNull();
  });

  it("compares site and shift case-insensitively and ignores surrounding spaces", async () => {
    expect(await resolveForCategory({ category: "equipment", site: "  warehouse ", shift: "NIGHT" })).toBe(warehouseNight);
  });

  it("a blocker's own raiser site and shift drive the decision end to end", async () => {
    const sql = getServiceSql();
    const emp = randomUUID();
    const b = randomUUID();
    await sql`insert into employee (id, display_name, status, site, shift, is_synthetic)
              values (${emp}, ${`${RT} night worker`}, 'active', 'Warehouse', 'night', true)`;
    await sql`insert into blocker (id, raised_by, category, severity, status, correlation_id, is_synthetic)
              values (${b}, ${emp}, 'equipment', 'high', 'open', ${CORR}, true)`;
    const r = await routeBlocker(b, CORR);
    expect(r.resolverId).toBe(warehouseNight);
    // And the recorded input carries the key that decided it, so replay can re-derive.
    const audit = await sql<{ detail: { input: { site: string; shift: string } } }[]>`
      select detail from audit_log where correlation_id = ${CORR} and action = 'blocker.routed' and entity_id = ${b}`;
    expect(audit[0]?.detail.input).toMatchObject({ site: "Warehouse", shift: "night" });
  });
});
