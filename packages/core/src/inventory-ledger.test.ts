import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getServiceSql } from "./db.js";
import {
  PLACE,
  answerHandover,
  cancelHandover,
  parseQty,
  receiveDelivery,
  recordUse,
  reverseDocument,
  settleHandover,
  startHandover,
  type LineIn,
} from "./inventory-ledger.js";
import { inventoryDay, inventoryHome, inventoryMovements } from "./inventory-read.js";
import { exportPersonData } from "./compliance-evidence.js";
import { eraseEmployee, retentionSweep } from "./retention.js";
import { DEMO_CEO_ID } from "./meta.js";
import { loadViewer, type ViewerOrg } from "./org.js";

/**
 * The stock ledger (TASK-060), against real Postgres. What it must guarantee, from the plan (§2) and
 * D218 — not from reading the code:
 *   - every move adds to one place exactly what it takes from another: each place's balance equals its
 *     moves, every item sums to zero over all places, and no real place is ever below zero;
 *   - stock reaches a person only when they confirm it, and nobody confirms their own handover;
 *   - the same request twice posts once; a move is never changed or deleted; mistakes are reversed.
 */

const TAG = `INV-${randomUUID().slice(0, 6)}`;
const KEEP = randomUUID(); // warehouse keeper
const KEEP2 = randomUUID(); // a second keeper
const OPS = randomUUID(); // Ops Head — approves
const VMO1 = randomUUID();
const VMO2 = randomUUID();
const CASH = randomUUID(); // cash auditor — no stock
const EMP = randomUUID(); // plain employee — no stock
const GONE = randomUUID(); // a driver who leaves holding stock
const MOVED = randomUUID(); // a driver whose role changes to one without stock
const STAFF: string[] = [KEEP, KEEP2, OPS, VMO1, VMO2, CASH, EMP, GONE, MOVED];
const ORANGES = randomUUID();
const STRAWS = randomUUID();
const GLOVES = randomUUID();
const LAST = randomUUID();
// Items of the TASK-060 review's tests, each starting from nothing.
const RV1 = randomUUID();
const RV2 = randomUUID();
const RV3 = randomUUID();
const RV4 = randomUUID();
const ITEMS: string[] = [ORANGES, STRAWS, GLOVES, LAST, RV1, RV2, RV3, RV4];
const MACHINE_ASSET = 990_801;
const sql = () => getServiceSql();
const v: Record<string, ViewerOrg> = {};
const id = () => randomUUID();
const line = (itemId: string, qty: number | string): LineIn => ({ itemId, qty });
const W = { kind: "warehouse" } as const;
const P = (employeeId: string) => ({ kind: "person", employeeId }) as const;

async function qtyAt(placeId: string, itemId: string): Promise<number> {
  const [r] = await sql()<{ q: string }[]>`select qty::text as q from stock_balance where location_id = ${placeId} and item_id = ${itemId}`;
  return r ? Number(r.q) : 0;
}
async function personPlaceId(employeeId: string): Promise<string> {
  const [r] = await sql()<{ id: string }[]>`select id from inv_location where kind = 'person' and employee_id = ${employeeId}`;
  return r?.id ?? "00000000-0000-0000-0000-000000000000";
}
const held = async (employeeId: string, itemId: string) => qtyAt(await personPlaceId(employeeId), itemId);
const inWarehouse = (itemId: string) => qtyAt(PLACE.warehouse, itemId);
const inTransit = (itemId: string) => qtyAt(PLACE.inTransit, itemId);

async function refusal(p: Promise<unknown>): Promise<{ status: number; code: string; message: string }> {
  try {
    await p;
  } catch (err) {
    const e = err as { status?: number; code?: string; message: string };
    return { status: e.status ?? 0, code: e.code ?? "", message: e.message };
  }
  throw new Error("expected a refusal, but it was accepted");
}

beforeAll(async () => {
  const s = sql();
  const people: [string, string, string][] = [
    [KEEP, "Keeper", "warehouse_keeper"],
    [KEEP2, "Keeper Two", "warehouse_keeper"],
    [OPS, "Ops Head", "ops_head"],
    [VMO1, "Driver One", "vmo"],
    [VMO2, "Driver Two", "vmo"],
    [CASH, "Cash Auditor", "cash_auditor"],
    [EMP, "Office", "employee"],
    [GONE, "Leaver", "vmo"],
    [MOVED, "Moved On", "vmo"],
  ];
  for (const [pid, name, role] of people) {
    await s`insert into employee (id, display_name, status, is_synthetic, access_role, manager_employee_id)
            values (${pid}, ${`${TAG} ${name}`}, 'active', true, ${role}, ${DEMO_CEO_ID})`;
  }
  await s`insert into inv_item (id, name, category, unit, step, count_tolerance, sort_order, is_synthetic) values
          (${ORANGES}, ${`${TAG} oranges`}, 'oranges', 'carton', 1, 0, 1, true),
          (${STRAWS}, ${`${TAG} straws`}, 'cups_packaging', 'box', 0.5, 0.5, 2, true),
          (${GLOVES}, ${`${TAG} gloves`}, 'consumable', 'box', 1, 0, 3, true),
          (${LAST}, ${`${TAG} last carton`}, 'oranges', 'carton', 1, 0, 4, true),
          (${RV1}, ${`${TAG} review one`}, 'other', 'box', 1, 0, 5, true),
          (${RV2}, ${`${TAG} review two`}, 'other', 'box', 1, 0, 6, true),
          (${RV3}, ${`${TAG} review three`}, 'other', 'box', 1, 0, 7, true),
          (${RV4}, ${`${TAG} review four`}, 'other', 'box', 1, 0, 8, true)`;
  await s`insert into machine (asset_no, label, is_synthetic) values (${MACHINE_ASSET}, ${`${TAG} machine`}, true)`;
  for (const pid of STAFF) v[pid] = (await loadViewer(pid))!;
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
  await sql()`delete from machine where asset_no = ${MACHINE_ASSET}`;
  await sql()`delete from notification_outbox where idempotency_key like ${"stock.%"}`;
  await sql()`delete from audit_log where actor = any(${STAFF.map((s) => `employee:${s}`)}) or action in (${"stock.low_alerted"}, ${"stock.handover_reminded"}, ${"stock.count_reminded"})`;
  await sql()`delete from employee where id = any(${STAFF}::uuid[])`;
  await closeDb();
});

describe("a delivery", () => {
  const D1 = id();
  it("comes from the supplier into the warehouse — once, however often it is sent", async () => {
    const req = { id: D1, supplier: "FVC", invoiceNo: "INV-1", lines: [line(ORANGES, 20), line(STRAWS, "2.5"), line(GLOVES, 6)] };
    expect(await receiveDelivery(v[KEEP]!, req)).toEqual({ docId: D1, state: "posted", replay: false });
    expect(await receiveDelivery(v[KEEP]!, req)).toEqual({ docId: D1, state: "posted", replay: true });
    expect(await inWarehouse(ORANGES)).toBe(20);
    expect(await inWarehouse(STRAWS)).toBe(2.5);
    const [n] = await sql()<{ n: number }[]>`select count(*)::int as n from stock_move where doc_id = ${D1}`;
    expect(n!.n).toBe(3);
  });

  it("refuses the same id for a different delivery, an amount between steps, and anyone who does not run the warehouse", async () => {
    expect((await refusal(receiveDelivery(v[KEEP]!, { id: D1, lines: [line(ORANGES, 21)] }))).code).toBe("id_reused");
    expect((await refusal(receiveDelivery(v[KEEP]!, { id: id(), lines: [line(STRAWS, "1.25")] }))).code).toBe("bad_step");
    expect((await refusal(receiveDelivery(v[KEEP]!, { id: id(), lines: [line(ORANGES, 1), line(ORANGES, 2)] }))).code).toBe("duplicate_item");
    expect((await refusal(receiveDelivery(v[KEEP]!, { id: id(), lines: [line(ORANGES, 0)] }))).code).toBe("bad_qty");
    expect((await refusal(receiveDelivery(v[VMO1]!, { id: id(), lines: [line(ORANGES, 1)] }))).status).toBe(403);
    expect((await refusal(receiveDelivery(v[CASH]!, { id: id(), lines: [line(ORANGES, 1)] }))).status).toBe(403);
    expect(await inWarehouse(ORANGES)).toBe(20);
  });
});

describe("giving stock out", () => {
  it("takes it out of the warehouse at once; the person has it only when THEY confirm", async () => {
    const H = id();
    expect((await startHandover(v[KEEP]!, { id: H, from: W, to: P(VMO1), lines: [line(ORANGES, 4)] })).state).toBe("waiting");
    expect(await inWarehouse(ORANGES)).toBe(16);
    expect(await inTransit(ORANGES)).toBe(4);
    expect(await held(VMO1, ORANGES)).toBe(0);

    expect((await refusal(answerHandover(v[KEEP]!, H, { answer: "accept" }))).status).toBe(403); // the giver
    expect((await refusal(answerHandover(v[VMO2]!, H, { answer: "accept" }))).status).toBe(403); // someone else
    expect((await answerHandover(v[VMO1]!, H, { answer: "accept" })).state).toBe("accepted");
    expect(await held(VMO1, ORANGES)).toBe(4);
    expect(await inTransit(ORANGES)).toBe(0);

    expect((await answerHandover(v[VMO1]!, H, { answer: "accept" })).replay).toBe(true);
    expect((await refusal(answerHandover(v[VMO1]!, H, { answer: "refuse", reason: "damaged" }))).code).toBe("already_answered");
    expect(await held(VMO1, ORANGES)).toBe(4);
  });

  it("never to oneself, and only to someone whose role holds stock", async () => {
    expect((await refusal(startHandover(v[KEEP]!, { id: id(), from: W, to: P(KEEP), lines: [line(ORANGES, 1)] }))).code).toBe("self_handover");
    expect((await refusal(startHandover(v[KEEP]!, { id: id(), from: W, to: P(EMP), lines: [line(ORANGES, 1)] }))).code).toBe("not_a_holder");
    expect((await refusal(startHandover(v[KEEP]!, { id: id(), from: W, to: P(CASH), lines: [line(ORANGES, 1)] }))).code).toBe("not_a_holder");
    expect((await refusal(startHandover(v[VMO2]!, { id: id(), from: W, to: P(VMO1), lines: [line(ORANGES, 1)] }))).status).toBe(403);
    expect(await inWarehouse(ORANGES)).toBe(16);
  });

  it("says in words when there is not enough, and moves nothing", async () => {
    const r = await refusal(startHandover(v[KEEP]!, { id: id(), from: W, to: P(VMO1), lines: [line(GLOVES, 2), line(ORANGES, 99)] }));
    expect(r.code).toBe("not_enough");
    expect(r.message).toMatch(/oranges: the warehouse has 16 cartons, this needs 99 cartons/);
    expect(await inWarehouse(GLOVES)).toBe(6);
  });

  it("refused or cancelled, it goes back where it was", async () => {
    const R = id();
    await startHandover(v[KEEP]!, { id: R, from: W, to: P(VMO1), lines: [line(ORANGES, 1)] });
    expect((await refusal(answerHandover(v[VMO1]!, R, { answer: "refuse" }))).code).toBe("reason_needed");
    expect((await answerHandover(v[VMO1]!, R, { answer: "refuse", reason: "damaged", note: "box wet" })).state).toBe("refused");
    expect(await inWarehouse(ORANGES)).toBe(16);

    const C = id();
    await startHandover(v[KEEP]!, { id: C, from: W, to: P(VMO1), lines: [line(ORANGES, 1)] });
    expect((await refusal(cancelHandover(v[VMO1]!, C))).status).toBe(403);
    expect((await cancelHandover(v[KEEP]!, C)).state).toBe("cancelled");
    expect(await inWarehouse(ORANGES)).toBe(16);
    expect((await refusal(answerHandover(v[VMO1]!, C, { answer: "accept" }))).code).toBe("already_answered");
  });
});

describe("less arrived than was sent", () => {
  it("the receiver takes what they counted; the rest waits in transit until an approver who was not part of it settles it", async () => {
    const H = id();
    await startHandover(v[KEEP]!, { id: H, from: W, to: P(VMO2), lines: [line(ORANGES, 3), line(STRAWS, 1)] });
    expect((await refusal(answerHandover(v[VMO2]!, H, { answer: "counted", lines: [line(ORANGES, 2), line(STRAWS, 1)] }))).code).toBe("reason_needed");
    expect((await refusal(answerHandover(v[VMO2]!, H, { answer: "counted", lines: [line(ORANGES, 2)], reason: "wrong_count" }))).code).toBe("count_every_item");
    expect((await refusal(answerHandover(v[VMO2]!, H, { answer: "counted", lines: [line(ORANGES, 4), line(STRAWS, 1)], reason: "wrong_count" }))).code).toBe("more_than_sent");
    const r = await answerHandover(v[VMO2]!, H, { answer: "counted", lines: [line(ORANGES, 2), line(STRAWS, 1)], reason: "wrong_count" });
    expect(r.state).toBe("part_accepted");
    expect(await held(VMO2, ORANGES)).toBe(2);
    expect(await held(VMO2, STRAWS)).toBe(1);
    expect(await inTransit(ORANGES)).toBe(1);

    expect((await refusal(settleHandover(v[KEEP]!, H, { lines: [{ itemId: ORANGES, outcome: "back" }] }))).status).toBe(403); // no approval
    expect((await refusal(settleHandover(v[OPS]!, H, { lines: [] }))).code).toBe("settle_every_item");
    expect((await settleHandover(v[OPS]!, H, { lines: [{ itemId: ORANGES, outcome: "back" }], note: "keeper found it" })).state).toBe("settled");
    expect(await inTransit(ORANGES)).toBe(0);
    expect(await inWarehouse(ORANGES)).toBe(14); // 16 − 3 sent + 1 back
  });

  it("written off with a reason when it is gone", async () => {
    const H = id();
    await startHandover(v[KEEP]!, { id: H, from: W, to: P(VMO2), lines: [line(ORANGES, 1)] });
    await answerHandover(v[VMO2]!, H, { answer: "counted", lines: [line(ORANGES, 0)], reason: "not_received" });
    const before = await qtyAt(PLACE.adjustments, ORANGES);
    expect((await refusal(settleHandover(v[OPS]!, H, { lines: [{ itemId: ORANGES, outcome: "write_off" }] }))).code).toBe("reason_needed");
    await settleHandover(v[OPS]!, H, { lines: [{ itemId: ORANGES, outcome: "write_off", reason: "unexplained" }] });
    expect(await qtyAt(PLACE.adjustments, ORANGES)).toBe(before + 1);
    expect(await inWarehouse(ORANGES)).toBe(13);
    expect(await inTransit(ORANGES)).toBe(0);
  });

  it("an approver who gave the stock does not settle it", async () => {
    const H = id();
    await startHandover(v[OPS]!, { id: H, from: W, to: P(VMO1), lines: [line(ORANGES, 1)] });
    await answerHandover(v[VMO1]!, H, { answer: "counted", lines: [line(ORANGES, 0)], reason: "not_received" });
    expect((await refusal(settleHandover(v[OPS]!, H, { lines: [{ itemId: ORANGES, outcome: "back" }] }))).code).toBe("party_settles");
    // The CEO, who was not part of it, settles it.
    const ceo = (await loadViewer(DEMO_CEO_ID))!;
    await settleHandover(ceo, H, { lines: [{ itemId: ORANGES, outcome: "back" }] });
    expect(await inWarehouse(ORANGES)).toBe(13);
  });
});

describe("giving stock back", () => {
  it("the person starts it; someone at the warehouse who is not them confirms", async () => {
    const H = id();
    const r = await startHandover(v[VMO1]!, { id: H, from: P(VMO1), to: W, lines: [line(ORANGES, 2)] });
    expect(r.state).toBe("waiting");
    expect(await held(VMO1, ORANGES)).toBe(2);
    expect((await refusal(answerHandover(v[VMO1]!, H, { answer: "accept" }))).status).toBe(403);
    expect((await refusal(answerHandover(v[VMO2]!, H, { answer: "accept" }))).status).toBe(403);
    await answerHandover(v[KEEP2]!, H, { answer: "accept" });
    expect(await inWarehouse(ORANGES)).toBe(15);
  });

  it("or the warehouse takes it back at the desk, and the person confirms", async () => {
    const H = id();
    await startHandover(v[KEEP]!, { id: H, from: P(VMO1), to: W, lines: [line(ORANGES, 1)] });
    expect((await refusal(answerHandover(v[KEEP2]!, H, { answer: "accept" }))).status).toBe(403); // the person confirms, not the warehouse
    await answerHandover(v[VMO1]!, H, { answer: "accept" });
    expect(await held(VMO1, ORANGES)).toBe(1);
    expect(await inWarehouse(ORANGES)).toBe(16);
  });

  it("never more than the person holds", async () => {
    const r = await refusal(startHandover(v[VMO1]!, { id: id(), from: P(VMO1), to: W, lines: [line(ORANGES, 5)] }));
    expect(r.code).toBe("not_enough");
    expect(r.message).toMatch(/you have 1 carton, this needs 5 cartons/);
  });

  it("person to person: only from one's own stock, and the receiver confirms", async () => {
    expect((await refusal(startHandover(v[KEEP]!, { id: id(), from: P(VMO1), to: P(VMO2), lines: [line(ORANGES, 1)] }))).status).toBe(403);
    const H = id();
    await startHandover(v[VMO1]!, { id: H, from: P(VMO1), to: P(VMO2), lines: [line(ORANGES, 1)] });
    await answerHandover(v[VMO2]!, H, { answer: "accept" });
    expect(await held(VMO1, ORANGES)).toBe(0);
    expect(await held(VMO2, ORANGES)).toBe(3);
  });
});

describe("used and damaged", () => {
  it("from one's own stock into a machine, or from the warehouse, each with a reason", async () => {
    const U = id();
    await recordUse(v[VMO2]!, { id: U, kind: "use", from: "mine", reason: "machine_refill", machineAssetNo: MACHINE_ASSET, lines: [line(ORANGES, 1)] });
    expect(await held(VMO2, ORANGES)).toBe(2);
    const [d] = await sql()<{ machine_id: string | null }[]>`select machine_id from stock_doc where id = ${U}`;
    expect(d!.machine_id).not.toBeNull();
    await recordUse(v[KEEP]!, { id: id(), kind: "damage", from: "warehouse", reason: "spoiled", lines: [line(ORANGES, 1)] });
    expect(await inWarehouse(ORANGES)).toBe(15);
    expect(await qtyAt(PLACE.damaged, ORANGES)).toBeGreaterThanOrEqual(1);
  });

  it("refuses the wrong reason, 'other' without a word, the warehouse's stock to someone who does not run it, and more than there is", async () => {
    expect((await refusal(recordUse(v[KEEP]!, { id: id(), kind: "damage", from: "warehouse", reason: "machine_refill" as never, lines: [line(GLOVES, 1)] }))).code).toBe("bad_reason");
    expect((await refusal(recordUse(v[KEEP]!, { id: id(), kind: "use", from: "warehouse", reason: "other", lines: [line(GLOVES, 1)] }))).code).toBe("note_needed");
    expect((await refusal(recordUse(v[VMO1]!, { id: id(), kind: "damage", from: "warehouse", reason: "broken", lines: [line(GLOVES, 1)] }))).status).toBe(403);
    expect((await refusal(recordUse(v[VMO1]!, { id: id(), kind: "use", from: "mine", reason: "shift_use", lines: [line(GLOVES, 1)] }))).code).toBe("not_enough");
    expect((await refusal(recordUse(v[VMO1]!, { id: id(), kind: "use", from: "mine", reason: "shift_use", machineAssetNo: MACHINE_ASSET, lines: [line(GLOVES, 1)] }))).code).toBe("bad_machine");
  });
});

describe("a mistake", () => {
  it("is reversed, never edited: the original stays, marked, and the opposite moves are added — once", async () => {
    const D = id();
    await receiveDelivery(v[KEEP]!, { id: D, lines: [line(GLOVES, 5)] });
    expect(await inWarehouse(GLOVES)).toBe(11);
    expect((await refusal(reverseDocument(v[KEEP]!, D, { id: id(), reason: "duplicate" }))).status).toBe(403);
    const R = id();
    expect((await reverseDocument(v[OPS]!, D, { id: R, reason: "duplicate" })).state).toBe("posted");
    expect(await inWarehouse(GLOVES)).toBe(6);
    expect((await reverseDocument(v[OPS]!, D, { id: R, reason: "duplicate" })).replay).toBe(true);
    expect((await refusal(reverseDocument(v[OPS]!, D, { id: id(), reason: "duplicate" }))).code).toBe("already_reversed");
    expect((await refusal(reverseDocument(v[OPS]!, R, { id: id(), reason: "duplicate" }))).code).toBe("not_reversible");
    const [orig] = await sql()<{ state: string }[]>`select state from stock_doc where id = ${D}`;
    expect(orig!.state).toBe("reversed");
    expect(await inWarehouse(GLOVES)).toBe(6);
  });

  it("is not reversed once its stock has moved on, and a handover is never reversed", async () => {
    const D = id();
    await receiveDelivery(v[KEEP]!, { id: D, lines: [line(LAST, 2)] });
    const H = id();
    await startHandover(v[KEEP]!, { id: H, from: W, to: P(VMO1), lines: [line(LAST, 2)] });
    expect((await refusal(reverseDocument(v[OPS]!, D, { id: id(), reason: "wrong_quantity" }))).code).toBe("not_enough");
    expect((await refusal(reverseDocument(v[OPS]!, H, { id: id(), reason: "wrong_quantity" }))).code).toBe("not_reversible");
    await cancelHandover(v[KEEP]!, H);
    await reverseDocument(v[OPS]!, D, { id: id(), reason: "wrong_quantity" });
    expect(await inWarehouse(LAST)).toBe(0);
  });
});

describe("the ledger's own guarantees", () => {
  it("a move is never changed or deleted, a document's content never changes, and the balance is never written by hand", async () => {
    const [m] = await sql()<{ id: string; doc_id: string }[]>`select id::text, doc_id from stock_move where item_id = ${ORANGES} limit 1`;
    await expect(sql()`update stock_move set qty = 1 where id = ${m!.id}`).rejects.toThrow(/never changed/);
    await expect(sql()`delete from stock_move where id = ${m!.id}`).rejects.toThrow(/never deleted/);
    await expect(sql()`update stock_doc set recorded_at = now() - interval '1 day' where id = ${m!.doc_id}`).rejects.toThrow(/never changed/);
    await expect(sql()`delete from stock_doc_line where doc_id = ${m!.doc_id}`).rejects.toThrow(/never deleted/);
    await expect(sql()`update stock_balance set qty = 999 where location_id = ${PLACE.warehouse} and item_id = ${ORANGES}`).rejects.toThrow(/kept by the ledger/);
    await expect(sql()`insert into stock_balance (location_id, item_id, qty, is_virtual) values (${PLACE.warehouse}, ${LAST}, 5, false)
                       on conflict (location_id, item_id) do update set qty = 5`).rejects.toThrow(/kept by the ledger/);
  });

  it("a posted document's state only moves forward", async () => {
    const [d] = await sql()<{ id: string }[]>`select id from stock_doc where kind = 'receipt' and state = 'posted' and created_by = ${KEEP} limit 1`;
    await expect(sql()`update stock_doc set state = 'waiting' where id = ${d!.id}`).rejects.toThrow(/cannot go from posted to waiting/);
  });

  it("refuses a move that would take a real place below zero even when written straight to the table", async () => {
    const doc = id();
    await sql()`insert into stock_doc (id, kind, from_location_id, to_location_id, state, created_by, reason, request_hash, is_synthetic)
                values (${doc}, 'use', ${PLACE.warehouse}, ${PLACE.used}, 'posted', ${KEEP}, 'other', ${"0".repeat(64)}, true)`;
    await expect(sql()`insert into stock_move (doc_id, item_id, from_location_id, to_location_id, qty, step, posted_by, is_synthetic)
                       values (${doc}, ${GLOVES}, ${PLACE.warehouse}, ${PLACE.used}, 9999, 'post', ${KEEP}, true)`).rejects.toThrow(/stock_balance_never_negative/);
  });

  it("gives the app role nothing but SELECT on every stock table", async () => {
    const tables = ["inv_item", "inv_location", "stock_doc", "stock_doc_line", "stock_move", "stock_balance", "count_session", "count_line"];
    for (const t of tables) {
      const [r] = await sql()<{ sel: boolean; ins: boolean; upd: boolean; del: boolean }[]>`
        select has_table_privilege('freshnow_app', ${t}, 'SELECT') as sel, has_table_privilege('freshnow_app', ${t}, 'INSERT') as ins,
               has_table_privilege('freshnow_app', ${t}, 'UPDATE') as upd, has_table_privilege('freshnow_app', ${t}, 'DELETE') as del`;
      expect({ t, ...r }).toEqual({ t, sel: true, ins: false, upd: false, del: false });
    }
  });

  it("lets only one of two hand-outs of the last carton through", async () => {
    await receiveDelivery(v[KEEP]!, { id: id(), lines: [line(LAST, 1)] });
    const out = await Promise.allSettled([
      startHandover(v[KEEP]!, { id: id(), from: W, to: P(VMO1), lines: [line(LAST, 1)] }),
      startHandover(v[KEEP2]!, { id: id(), from: W, to: P(VMO2), lines: [line(LAST, 1)] }),
    ]);
    expect(out.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const lost = out.find((o) => o.status === "rejected") as PromiseRejectedResult;
    expect((lost.reason as { code: string }).code).toBe("not_enough");
    expect(await inWarehouse(LAST)).toBe(0);
    expect(await inTransit(LAST)).toBe(1);
  });
});

describe("whatever happens, the books balance", () => {
  // A seeded generator: the same sequence every run, so a failure can be replayed.
  function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("after 80 random postings each place's balance equals its moves, each item sums to zero, and nothing real is below zero", async () => {
    const r = rng(60_017);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
    const holders = [VMO1, VMO2];
    const items = [ORANGES, STRAWS, GLOVES];
    // Each open handover with who started it (who may cancel) and who must confirm it.
    const waiting: { id: string; creator: string; confirmer: string }[] = [];
    let refusedForStock = 0;
    for (let i = 0; i < 80; i++) {
      const op = pick(["receive", "give", "give", "answer", "answer", "return", "use", "damage"]);
      const item = pick(items);
      const qty = item === STRAWS ? pick(["0.5", "1", "1.5"]) : String(1 + Math.floor(r() * 3));
      try {
        if (op === "receive") await receiveDelivery(v[KEEP]!, { id: id(), lines: [line(item, qty)] });
        else if (op === "give") {
          const to = pick(holders);
          const by = pick([KEEP, KEEP2]);
          const h = id();
          await startHandover(v[by]!, { id: h, from: W, to: P(to), lines: [line(item, qty)] });
          waiting.push({ id: h, creator: by, confirmer: to });
        } else if (op === "return") {
          const who = pick(holders);
          const h = id();
          await startHandover(v[who]!, { id: h, from: P(who), to: W, lines: [line(item, qty)] });
          waiting.push({ id: h, creator: who, confirmer: KEEP2 });
        } else if (op === "answer" && waiting.length > 0) {
          const h = waiting.splice(Math.floor(r() * waiting.length), 1)[0]!;
          const how = pick(["accept", "accept", "refuse", "cancel"]);
          if (how === "accept") await answerHandover(v[h.confirmer]!, h.id, { answer: "accept" });
          else if (how === "refuse") await answerHandover(v[h.confirmer]!, h.id, { answer: "refuse", reason: "wrong_items" });
          else await cancelHandover(v[h.creator]!, h.id);
        } else if (op === "use") await recordUse(v[pick(holders)]!, { id: id(), kind: "use", from: "mine", reason: "shift_use", lines: [line(item, qty)] });
        else if (op === "damage") await recordUse(v[KEEP]!, { id: id(), kind: "damage", from: "warehouse", reason: "broken", lines: [line(item, qty)] });
      } catch (err) {
        // Running out is the only refusal a valid sequence may meet; anything else is a defect.
        if ((err as { code?: string }).code !== "not_enough") throw err;
        refusedForStock++;
      }
    }
    // The balance of every place equals what its moves brought in minus what they took out.
    const drift = await sql()<{ location_id: string; item_id: string; balance: string; moves: string }[]>`
      with flows as (
        select to_location_id as place, item_id, qty from stock_move where item_id = any(${items}::uuid[])
        union all
        select from_location_id, item_id, -qty from stock_move where item_id = any(${items}::uuid[]))
      select b.location_id, b.item_id, b.qty::text as balance, coalesce(sum(f.qty), 0)::text as moves
        from stock_balance b left join flows f on f.place = b.location_id and f.item_id = b.item_id
       where b.item_id = any(${items}::uuid[])
       group by b.location_id, b.item_id, b.qty
      having b.qty <> coalesce(sum(f.qty), 0)`;
    expect(drift).toEqual([]);
    // Double entry: every item sums to zero over all places, virtual ones included.
    const sums = await sql()<{ item_id: string; total: string }[]>`
      select item_id, sum(qty)::text as total from stock_balance where item_id = any(${items}::uuid[]) group by item_id`;
    for (const s of sums) expect(Number(s.total), s.item_id).toBe(0);
    // And nothing real is below zero.
    const [neg] = await sql()<{ n: number }[]>`select count(*)::int as n from stock_balance where not is_virtual and qty < 0`;
    expect(neg!.n).toBe(0);
    // Some of the 80 ran out of stock and were refused — the generator does reach the edge.
    expect(refusedForStock).toBeGreaterThan(0);
  });

  it("the day's sheet adds up: opening + in − out = closing, and closing is what the warehouse holds", async () => {
    const day = await inventoryDay(v[OPS]!, new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(new Date()));
    for (const it of day.warehouse.filter((w) => ITEMS.includes(w.itemId))) {
      const computed = it.opening + it.received - it.givenOut + it.cameBack + it.takenBack - it.used - it.damaged + it.adjusted + it.reversed;
      expect(Math.round(computed * 1000) / 1000, it.name).toBe(it.closing);
      expect(it.closing, it.name).toBe(await inWarehouse(it.itemId));
    }
    for (const p of day.people.filter((x) => x.employeeId === VMO1 || x.employeeId === VMO2)) {
      for (const it of p.items) {
        const computed = it.opening + it.received - it.gaveOut + it.cameBack - it.used - it.damaged + it.reversed;
        expect(Math.round(computed * 1000) / 1000, `${p.name} ${it.name}`).toBe(it.closing);
        expect(it.closing).toBe(await held(p.employeeId, it.itemId));
      }
    }
  });

  it("each person's home screen shows what they hold, and what waits for them — nobody else's", async () => {
    const h = id();
    await receiveDelivery(v[KEEP]!, { id: id(), lines: [line(GLOVES, 1)] });
    await startHandover(v[KEEP]!, { id: h, from: W, to: P(VMO1), lines: [line(GLOVES, 1)] });
    const home1 = await inventoryHome(v[VMO1]!);
    expect(home1.waitingForMe.map((d) => d.id)).toContain(h);
    expect(home1.items).toEqual([]); // a driver does not see the warehouse
    const home2 = await inventoryHome(v[VMO2]!);
    expect(home2.waitingForMe.map((d) => d.id)).not.toContain(h);
    expect([...home2.pending, ...home2.sentByMe].map((d) => d.id)).not.toContain(h);
    const keeper = await inventoryHome(v[KEEP]!);
    expect(keeper.sentByMe.map((d) => d.id)).toContain(h);
    expect(keeper.items.find((i) => i.id === GLOVES)).toBeDefined();
    await expect(inventoryHome(v[CASH]!)).rejects.toThrow(/not part of your role/);
  });
});

describe("the words on stock records follow the person's other words (migration 0034)", () => {
  const saved = process.env.RETENTION_DAYS;
  afterAll(() => {
    if (saved === undefined) delete process.env.RETENTION_DAYS;
    else process.env.RETENTION_DAYS = saved;
  });

  it("a note is never rewritten — only removed", async () => {
    const U = id();
    await recordUse(v[KEEP]!, { id: U, kind: "use", from: "warehouse", reason: "other", note: "gloves for the new cleaner", lines: [line(GLOVES, 1)] });
    await expect(sql()`update stock_doc set note = 'something else' where id = ${U}`).rejects.toThrow(/only ever removed/);
    await sql()`update stock_doc set note = '[erased]' where id = ${U}`;
    const [d] = await sql()<{ note: string }[]>`select note from stock_doc where id = ${U}`;
    expect(d!.note).toBe("[erased]");
  });

  it("the retention sweep removes old words and keeps the record; recent words stay", async () => {
    process.env.RETENTION_DAYS = "90";
    const OLD = id();
    await sql()`insert into stock_doc (id, kind, from_location_id, to_location_id, state, created_by, reason, note, recorded_at, request_hash, is_synthetic)
                values (${OLD}, 'use', ${PLACE.warehouse}, ${PLACE.used}, 'posted', ${KEEP}, 'other', 'old words about Ali',
                        now() - interval '120 days', ${"0".repeat(64)}, true)`;
    const NEW = id();
    await recordUse(v[KEEP]!, { id: NEW, kind: "use", from: "warehouse", reason: "other", note: "new words", lines: [line(GLOVES, 1)] });
    await retentionSweep();
    const rows = await sql()<{ id: string; note: string; kind: string }[]>`select id, note, kind from stock_doc where id in (${OLD}, ${NEW})`;
    expect(rows.find((r) => r.id === OLD)).toMatchObject({ kind: "use", note: expect.stringMatching(/^\[redacted/) });
    expect(rows.find((r) => r.id === NEW)!.note).toBe("new words");
  });

  it("erasing a person removes the words they typed; the records and the moves stay", async () => {
    const H = id();
    await startHandover(v[KEEP]!, { id: H, from: W, to: P(VMO2), lines: [line(GLOVES, 1)], note: "keeper's note" });
    await answerHandover(v[VMO2]!, H, { answer: "counted", lines: [line(GLOVES, 0)], reason: "not_received", note: "Ali has it, not me" });
    await eraseEmployee({ employeeId: VMO2, by: DEMO_CEO_ID, reason: "request" });
    const [d] = await sql()<{ note: string; answer_note: string; state: string }[]>`select note, answer_note, state from stock_doc where id = ${H}`;
    expect(d).toMatchObject({ note: "keeper's note", answer_note: "[erased]", state: "part_accepted" });
    const [m] = await sql()<{ n: number }[]>`select count(*)::int as n from stock_move where doc_id = ${H}`;
    expect(m!.n).toBeGreaterThan(0);
  });

  it("a person's own data download lists what they hold and their stock documents, with only their own words", async () => {
    const out = (await exportPersonData({ employeeId: VMO1, requestedBy: VMO1 })) as Record<string, Record<string, unknown>[]>;
    expect(Array.isArray(out.stockHeld)).toBe(true);
    expect(out.stockDocuments!.length).toBeGreaterThan(0);
    for (const d of out.stockDocuments!) expect(Object.keys(d)).toEqual(expect.arrayContaining(["kind", "state", "lines", "your_note"]));
    await sql()`delete from audit_log where action = 'data.exported' and entity_id = ${VMO1}`;
  });
});

describe("the TASK-060 review's findings, fixed", () => {
  const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(new Date());

  it("reads a JSON number as it was sent: more than three decimals is refused, never rounded", () => {
    expect(parseQty(2.5)).toBe(2500);
    expect(parseQty(1.005)).toBe(1005);
    expect(() => parseQty(2.4996)).toThrow(/at most three decimals/);
    expect(() => parseQty(0.0004, "count", true)).toThrow(/at most three decimals/);
    expect(() => parseQty("2.4996")).toThrow(/at most three decimals/);
  });

  it("answers a repeat of a delivery already posted as a replay, even after its item was switched off", async () => {
    const D = id();
    const req = { id: D, lines: [line(RV1, 3)] };
    await receiveDelivery(v[KEEP]!, req);
    await sql()`update inv_item set active = false where id = ${RV1}`;
    try {
      expect((await receiveDelivery(v[KEEP]!, req)).replay).toBe(true);
      expect((await refusal(receiveDelivery(v[KEEP]!, { id: D, lines: [line(RV1, 4)] }))).code).toBe("id_reused");
    } finally {
      await sql()`update inv_item set active = true where id = ${RV1}`;
    }
    expect(await inWarehouse(RV1)).toBe(3);
  });

  it("takes stock back from someone who has left: another person at the warehouse confirms it, never the one taking it", async () => {
    await receiveDelivery(v[KEEP]!, { id: id(), lines: [line(RV2, 2)] });
    const out = id();
    await startHandover(v[KEEP]!, { id: out, from: W, to: P(GONE), lines: [line(RV2, 2)] });
    await answerHandover(v[GONE]!, out, { answer: "accept" });
    await sql()`update employee set status = 'disabled' where id = ${GONE}`;
    const back = id();
    await startHandover(v[KEEP]!, { id: back, from: P(GONE), to: W, lines: [line(RV2, 2)] });
    const [d] = await sql()<{ confirm_side: string; confirm_by: string | null }[]>`select confirm_side, confirm_by from stock_doc where id = ${back}`;
    expect(d).toEqual({ confirm_side: "warehouse", confirm_by: null });
    expect((await refusal(answerHandover(v[KEEP]!, back, { answer: "accept" }))).status).toBe(403);
    await answerHandover(v[KEEP2]!, back, { answer: "accept" });
    expect(await held(GONE, RV2)).toBe(0);
    expect(await inWarehouse(RV2)).toBe(2);
  });

  it("a receiver whose role no longer holds stock may refuse a handover, but not take it in", async () => {
    await receiveDelivery(v[KEEP]!, { id: id(), lines: [line(RV3, 1)] });
    const H = id();
    await startHandover(v[KEEP]!, { id: H, from: W, to: P(MOVED), lines: [line(RV3, 1)] });
    await sql()`update employee set access_role = 'cash_auditor' where id = ${MOVED}`;
    const now = (await loadViewer(MOVED))!;
    expect((await refusal(answerHandover(now, H, { answer: "accept" }))).code).toBe("not_a_holder");
    await answerHandover(now, H, { answer: "refuse", reason: "not_received" });
    expect(await inWarehouse(RV3)).toBe(1);
  });

  it("the day's sheet adds up for a person whose entry was undone", async () => {
    await receiveDelivery(v[KEEP]!, { id: id(), lines: [line(RV4, 5)] });
    const H = id();
    await startHandover(v[KEEP]!, { id: H, from: W, to: P(VMO1), lines: [line(RV4, 5)] });
    await answerHandover(v[VMO1]!, H, { answer: "accept" });
    const U = id();
    await recordUse(v[VMO1]!, { id: U, kind: "use", from: "mine", reason: "shift_use", lines: [line(RV4, 4)] });
    await reverseDocument(v[OPS]!, U, { id: id(), reason: "entered_by_mistake" });
    const day = await inventoryDay(v[OPS]!, today());
    const row = day.people.find((p) => p.employeeId === VMO1)!.items.find((i) => i.itemId === RV4)!;
    expect(row).toMatchObject({ received: 5, used: 4, reversed: 4, closing: 5 });
    expect(row.opening + row.received - row.gaveOut + row.cameBack - row.used - row.damaged + row.reversed).toBe(row.closing);
  });

  it("pages Movements without skipping a document recorded in the same millisecond as the last one shown", async () => {
    const A = id();
    const B = id();
    for (const [docId, at] of [
      [A, "2020-01-02T10:00:00.123456Z"],
      [B, "2020-01-02T10:00:00.123200Z"],
    ] as const) {
      await sql()`insert into stock_doc (id, kind, from_location_id, to_location_id, state, created_by, recorded_at, request_hash, is_synthetic)
                  values (${docId}, 'receipt', ${PLACE.suppliers}, ${PLACE.warehouse}, 'posted', ${KEEP}, ${at}::text::timestamptz, ${"0".repeat(64)}, true)`;
    }
    // As stored: six decimals, the second 256 µs earlier (bound as timestamptz they would be cut to milliseconds, G202).
    const stored = await sql()<{ at: string }[]>`
      select to_char(recorded_at at time zone 'UTC', 'SS.US') as at from stock_doc where id in (${A}, ${B}) order by recorded_at desc`;
    expect(stored.map((r) => r.at)).toEqual(["00.123456", "00.123200"]);
    const seen: string[] = [];
    let before: string | undefined;
    for (let page = 0; page < 3; page++) {
      const r = await inventoryMovements(v[OPS]!, { from: "2020-01-02", to: "2020-01-02", limit: 1, ...(before ? { before } : {}) });
      seen.push(...r.docs.map((d) => d.id));
      if (!r.more) break;
      before = r.cursor!;
    }
    expect(seen).toEqual([A, B]);
  });
});
