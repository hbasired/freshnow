import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getServiceSql } from "./db.js";
import { startCount, submitCount } from "./inventory-counts.js";
import { answerHandover, receiveDelivery, startHandover } from "./inventory-ledger.js";
import { inventoryReminders } from "./inventory-notify.js";
import { DEMO_CEO_ID } from "./meta.js";
import { loadViewer, type ViewerOrg } from "./org.js";

/**
 * Who is told what about stock (TASK-060) — the rules as decided, against real Postgres:
 *   a handover waits → whoever must confirm it; less arrived → the giver and the Ops Head;
 *   below the minimum → the keepers and the Ops Head, once a day; a count that differs → a second person,
 *   then the Ops Head; reminders once, after their wait.
 */
const TAG = `NTF-${randomUUID().slice(0, 6)}`;
const KEEP = randomUUID();
const OPS = randomUUID();
const VMO = randomUUID();
const STAFF: string[] = [KEEP, OPS, VMO];
const CUPS = randomUUID();
const ITEMS: string[] = [CUPS];
const sql = () => getServiceSql();
const v: Record<string, ViewerOrg> = {};
const id = () => randomUUID();
const saved = { h: process.env.INVENTORY_HANDOVER_REMIND_MINUTES, c: process.env.INVENTORY_COUNT_REMIND_MINUTES };

/** Who an outbox key prefix reached, in the app's own inbox (every recipient gets that one). */
async function reached(prefix: string): Promise<string[]> {
  const rows = await sql()<{ r: string }[]>`
    select distinct recipient_employee_id as r from notification_outbox where idempotency_key like ${`${prefix}:%`} and channel = 'inapp'`;
  return rows.map((x) => x.r).sort();
}
const textOf = async (prefix: string, to: string) =>
  (await sql()<{ t: string }[]>`select payload->>'text' as t from notification_outbox where idempotency_key like ${`${prefix}:%${to}:%`} and channel = 'inapp'`)[0]?.t ?? "";

beforeAll(async () => {
  for (const [pid, name, role] of [[KEEP, "Keeper", "warehouse_keeper"], [OPS, "Ops", "ops_head"], [VMO, "Driver", "vmo"]] as const) {
    await sql()`insert into employee (id, display_name, status, is_synthetic, access_role, manager_employee_id)
                values (${pid}, ${`${TAG} ${name}`}, 'active', true, ${role}, ${DEMO_CEO_ID})`;
  }
  await sql()`insert into inv_item (id, name, category, unit, step, min_level, sort_order, is_synthetic)
              values (${CUPS}, ${`${TAG} cups`}, 'cups_packaging', 'box', 1, 5, 1, true)`;
  for (const pid of STAFF) v[pid] = (await loadViewer(pid))!;
  await receiveDelivery(v[KEEP]!, { id: id(), lines: [{ itemId: CUPS, qty: 8 }] });
});

afterAll(async () => {
  await sql().begin(async (tx) => {
    const docs = (await tx<{ id: string }[]>`select id from stock_doc where created_by = any(${STAFF}::uuid[])`).map((r) => r.id);
    await tx`delete from audit_log where entity = 'stock_doc' and entity_id = any(${docs})`;
    await tx`select inv_purge_docs(${docs}::uuid[])`;
    await tx`set local freshnow.ledger_purge = 'on'`;
    await tx`delete from count_line where session_id in (select id from count_session where started_by = any(${STAFF}::uuid[]))`;
    await tx`delete from count_session where started_by = any(${STAFF}::uuid[])`;
    await tx`delete from stock_balance where item_id = any(${ITEMS}::uuid[])`;
    await tx`delete from inv_location where employee_id = any(${STAFF}::uuid[])`;
    await tx`delete from inv_item where id = any(${ITEMS}::uuid[])`;
  });
  await sql()`delete from notification_outbox where idempotency_key like ${"stock.%"}`;
  await sql()`delete from audit_log where actor = any(${STAFF.map((s) => `employee:${s}`)}) or action in ('stock.low_alerted', 'stock.handover_reminded', 'stock.count_reminded')`;
  await sql()`delete from employee where id = any(${STAFF}::uuid[])`;
  for (const [k, val] of [["INVENTORY_HANDOVER_REMIND_MINUTES", saved.h], ["INVENTORY_COUNT_REMIND_MINUTES", saved.c]] as const) {
    if (val === undefined) delete process.env[k];
    else process.env[k] = val;
  }
  await closeDb();
});

describe("who is told about stock", () => {
  it("a hand-out: the receiver; a return: the warehouse's keeper — never the person who started it", async () => {
    const out = id();
    await startHandover(v[KEEP]!, { id: out, from: { kind: "warehouse" }, to: { kind: "person", employeeId: VMO }, lines: [{ itemId: CUPS, qty: 2 }] });
    expect(await reached(`stock.handover:${out}`)).toEqual([VMO]);
    expect(await textOf(`stock.handover:${out}`, VMO)).toMatch(/is giving you: .*2 boxes/);
    await answerHandover(v[VMO]!, out, { answer: "accept" });

    const back = id();
    await startHandover(v[VMO]!, { id: back, from: { kind: "person", employeeId: VMO }, to: { kind: "warehouse" }, lines: [{ itemId: CUPS, qty: 1 }] });
    expect(await reached(`stock.handover:${back}`)).toEqual([KEEP]);
    await answerHandover(v[KEEP]!, back, { answer: "accept" });
  });

  it("less arrived: the giver is told, and the Ops Head is asked to settle it", async () => {
    const h = id();
    await startHandover(v[KEEP]!, { id: h, from: { kind: "warehouse" }, to: { kind: "person", employeeId: VMO }, lines: [{ itemId: CUPS, qty: 2 }] });
    await answerHandover(v[VMO]!, h, { answer: "counted", lines: [{ itemId: CUPS, qty: 1 }], reason: "wrong_count" });
    expect(await reached(`stock.short:${h}`)).toEqual([KEEP]);
    expect(await reached(`stock.settle:${h}`)).toEqual([OPS]);
  });

  it("below the minimum: the keeper and the Ops Head, once a day", async () => {
    // The warehouse holds 8 − 2 + 1 − 2 = 5: at the minimum, not below. One more out makes it low.
    const h = id();
    await startHandover(v[KEEP]!, { id: h, from: { kind: "warehouse" }, to: { kind: "person", employeeId: VMO }, lines: [{ itemId: CUPS, qty: 1 }] });
    const key = `stock.low:${CUPS}`;
    expect((await reached(key)).sort()).toEqual([KEEP, OPS].sort());
    expect(await textOf(key, OPS)).toMatch(/4 boxes left in the warehouse — the minimum is 5 boxes/);
    await startHandover(v[KEEP]!, { id: id(), from: { kind: "warehouse" }, to: { kind: "person", employeeId: VMO }, lines: [{ itemId: CUPS, qty: 1 }] });
    const [n] = await sql()<{ n: number }[]>`select count(*)::int as n from audit_log where action = 'stock.low_alerted' and entity_id = ${CUPS}`;
    expect(n!.n).toBe(1);
  });

  it("a count that differs: someone else is asked to count again — never the person who counted", async () => {
    const s = id();
    await startCount(v[KEEP]!, { id: s, kind: "spot" });
    await submitCount(v[KEEP]!, s, { lines: [{ itemId: CUPS, qty: 0 }] });
    const told = await reached(`stock.recount:${s}`);
    expect(told).toContain(OPS);
    expect(told).not.toContain(KEEP);
  });

  it("reminds once: a handover still waiting, and a count after stock went out", async () => {
    process.env.INVENTORY_HANDOVER_REMIND_MINUTES = "30";
    process.env.INVENTORY_COUNT_REMIND_MINUTES = "30";
    const h = id();
    await startHandover(v[KEEP]!, { id: h, from: { kind: "warehouse" }, to: { kind: "person", employeeId: VMO }, lines: [{ itemId: CUPS, qty: 1 }] });
    const later = new Date(Date.now() + 31 * 60_000);
    const r1 = await inventoryReminders({ now: later });
    expect(r1.handovers).toBeGreaterThan(0);
    const [rem] = await sql()<{ n: number }[]>`select count(*)::int as n from audit_log where action = 'stock.handover_reminded' and entity_id = ${h}`;
    expect(rem!.n).toBe(1);
    const r2 = await inventoryReminders({ now: later });
    const [again] = await sql()<{ n: number }[]>`select count(*)::int as n from audit_log where action = 'stock.handover_reminded' and entity_id = ${h}`;
    expect(again!.n).toBe(1);
    expect(r2.counts).toBe(0); // the count reminder went out on the first run, once
    expect(r1.counts).toBeGreaterThan(0);
  });
});
