import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getServiceSql, withContext } from "./db.js";
import { cancelCount, startCount } from "./inventory-counts.js";
import { PLACE, answerHandover, receiveDelivery, reverseDocument, startHandover } from "./inventory-ledger.js";
import { inventoryDay } from "./inventory-read.js";
import { DEMO_CEO_ID } from "./meta.js";
import { loadViewer, type ViewerOrg } from "./org.js";
import { exportPersonData } from "./compliance-evidence.js";
import { eraseEmployee } from "./retention.js";
import { localDate } from "./time.js";
import {
  SHORT_WEIGHT_SHARE,
  cancelOrder,
  createOrder,
  isLight,
  listOrders,
  listSuppliers,
  noteGramsFor,
  orderDetail,
  parseKg,
  saveSupplier,
  setOrderReady,
  startReturn,
  updateOrder,
  validateOrder,
} from "./warehouse.js";
import { itemTracking, moveReport, moveReportCsv, reorderSuggestions, saveReorderRule, stockAt, supplierReport } from "./warehouse-reports.js";

/**
 * Warehouse documents (TASK-086) against real Postgres. What they must guarantee — from Televend's guide and the plan, not from
 * reading the code:
 *   - a receipt is planned (draft → ready), received against what was expected, and only then moves stock — through the ledger,
 *     once, however often the app retries; what came short leaves a backorder or is closed short, as the receiver chooses;
 *   - every line received is a lot with its kilograms; a delivery lighter than its note beyond the tolerance is told to the
 *     approvers;
 *   - a return to the supplier never sends back more than came in, less what went back already, and is told to the approvers;
 *   - a done document never changes; its stock is undone by an approver's reversal;
 *   - reorder rules suggest — forecast below the minimum, order up to the maximum in whole packs — and never order anything;
 *   - the reports are the ledger summed, and show nothing to someone counting the warehouse.
 */

const TAG = `WH-${randomUUID().slice(0, 6)}`;
const KEEP = randomUUID(); // warehouse keeper — runs the warehouse
const LEAVER = randomUUID(); // a second keeper, erased at the end
const OPS = randomUUID(); // Ops Head — approves
const SUPV = randomUUID(); // supervisor — sees all stock, runs nothing
const VMO = randomUUID(); // holds stock
const EMP = randomUUID(); // no stock at all
const STAFF = [KEEP, OPS, SUPV, VMO, EMP, LEAVER];
const ORANGES = randomUUID();
const STRAWS = randomUUID();
const FORMULA = randomUUID(); // a name a spreadsheet would run as a formula
const ITEMS = [ORANGES, STRAWS, FORMULA];
const v: Record<string, ViewerOrg> = {};
const sql = () => getServiceSql();
const id = () => randomUUID();
const today = localDate(new Date());
const supplierIds: string[] = [];

async function refusal(p: Promise<unknown>): Promise<{ status: number; code: string; message: string }> {
  try {
    await p;
  } catch (err) {
    const e = err as { status?: number; code?: string; message: string };
    return { status: e.status ?? 0, code: e.code ?? "", message: e.message };
  }
  throw new Error("expected a refusal, but it was accepted");
}
async function qtyAt(placeId: string, itemId: string): Promise<number> {
  const [r] = await sql()<{ q: string }[]>`select qty::text as q from stock_balance where location_id = ${placeId} and item_id = ${itemId}`;
  return r ? Number(r.q) : 0;
}
const inWarehouse = (itemId: string) => qtyAt(PLACE.warehouse, itemId);

beforeAll(async () => {
  const s = sql();
  const people: [string, string, string][] = [
    [KEEP, "Keeper", "warehouse_keeper"],
    [OPS, "Ops Head", "ops_head"],
    [SUPV, "Supervisor", "supervisor"],
    [VMO, "Driver", "vmo"],
    [EMP, "Office", "employee"],
    [LEAVER, "Leaver", "warehouse_keeper"],
  ];
  for (const [pid, name, role] of people) {
    await s`insert into employee (id, display_name, status, is_synthetic, access_role, manager_employee_id)
            values (${pid}, ${`${TAG} ${name}`}, 'active', true, ${role}, ${DEMO_CEO_ID})`;
  }
  await s`insert into inv_item (id, name, category, unit, step, count_tolerance, sort_order, is_synthetic) values
          (${ORANGES}, ${`${TAG} oranges`}, 'oranges', 'carton', 1, 0, 1, true),
          (${STRAWS}, ${`${TAG} straws`}, 'cups_packaging', 'box', 0.5, 0, 2, true),
          (${FORMULA}, ${`=${TAG} formula`}, 'other', 'piece', 1, 0, 3, true)`;
  for (const pid of STAFF) v[pid] = (await loadViewer(pid))!;
});

afterAll(async () => {
  await sql().begin(async (tx) => {
    const orders = (await tx<{ id: string }[]>`select id from wh_order where created_by = any(${STAFF}::uuid[])`).map((r) => r.id);
    const docs = (await tx<{ id: string }[]>`select id from stock_doc where created_by = any(${STAFF}::uuid[])`).map((r) => r.id);
    await tx`delete from audit_log where entity in ('wh_order', 'stock_doc') and entity_id = any(${[...orders, ...docs]})`;
    // The documents and every stock document of these people in one purge (wh_purge_orders' p_docs).
    await tx`select wh_purge_orders(${orders}::uuid[], ${docs}::uuid[])`;
    await tx`set local freshnow.ledger_purge = 'on'`;
    await tx`delete from reorder_rule where item_id = any(${ITEMS}::uuid[])`;
    await tx`delete from count_line where session_id in (select id from count_session where started_by = any(${STAFF}::uuid[]))`;
    await tx`delete from count_session where started_by = any(${STAFF}::uuid[])`;
    await tx`delete from stock_balance where item_id = any(${ITEMS}::uuid[])`;
    await tx`delete from inv_location where employee_id = any(${STAFF}::uuid[])`;
    await tx`delete from inv_item where id = any(${ITEMS}::uuid[])`;
    await tx`delete from supplier where id = any(${supplierIds}::uuid[])`;
    await tx`delete from wh_number where year = ${Number(today.slice(0, 4))} and not exists (select 1 from wh_order)`;
  });
  await sql()`delete from notification_outbox where idempotency_key like ${"wh.%"} or idempotency_key like ${"stock.%"}`;
  await sql()`delete from audit_log where actor = any(${STAFF.map((s) => `employee:${s}`)})`;
  await sql()`delete from employee where id = any(${STAFF}::uuid[])`;
  await closeDb();
});

let FVC = "";
let AWIR = "";

describe("suppliers", () => {
  it("are kept by the warehouse, read by whoever sees all stock, refused to the rest", async () => {
    const a = await saveSupplier(v[KEEP]!, { name: `${TAG} Fresh Fruit Co`, code: `F${TAG.slice(3, 9).toUpperCase()}`, leadDays: 1 });
    const b = await saveSupplier(v[KEEP]!, { name: `${TAG} Al Awir Market`, leadDays: 2 });
    supplierIds.push(a.id, b.id);
    FVC = a.id;
    AWIR = b.id;
    expect(a.created).toBe(true);
    expect((await refusal(saveSupplier(v[KEEP]!, { name: `${TAG} fresh fruit co` }))).code).toBe("supplier_taken");
    expect((await refusal(saveSupplier(v[KEEP]!, { name: `${TAG} other`, code: "no spaces" }))).code).toBe("bad_code");
    expect((await refusal(saveSupplier(v[SUPV]!, { name: `${TAG} by a supervisor` }))).status).toBe(403);
    expect((await listSuppliers(v[SUPV]!)).some((s) => s.id === FVC)).toBe(true);
    expect((await refusal(listSuppliers(v[VMO]!))).status).toBe(403);
  });
});

describe("a planned receipt", () => {
  const R1 = id();
  const R2 = id();
  const DOC1 = id();
  const BACK = id();
  const req = () => ({
    id: R1,
    kind: "receipt" as const,
    supplierId: FVC,
    scheduledOn: today,
    sourceRef: "DN-1001",
    vehicle: "hn 897",
    lines: [{ itemId: ORANGES, qty: 20, kg: "360", variety: "Valencia", bestBefore: "2026-12-01" }, { itemId: STRAWS, qty: "2.5" }],
  });

  it("is numbered in order, created once however often it is sent, and moves no stock while planned", async () => {
    const first = await createOrder(v[KEEP]!, req());
    expect(first).toMatchObject({ state: "draft", replay: false });
    expect(first.number).toMatch(new RegExp(`^IN-${today.slice(0, 4)}-\\d{4}$`));
    expect(await createOrder(v[KEEP]!, req())).toEqual({ ...first, replay: true });
    expect((await refusal(createOrder(v[KEEP]!, { ...req(), sourceRef: "DN-other" }))).code).toBe("id_reused");
    const second = await createOrder(v[KEEP]!, { id: R2, kind: "receipt", supplierId: AWIR, lines: [{ itemId: ORANGES, qty: 5 }], ready: true });
    expect(Number(second.number.slice(-4))).toBe(Number(first.number.slice(-4)) + 1);
    expect(second.state).toBe("ready");
    expect(await inWarehouse(ORANGES)).toBe(0);
    const card = (await orderDetail(v[SUPV]!, R1))!;
    expect(card).toMatchObject({ kind: "receipt", state: "draft", vehicle: "HN 897", sourceRef: "DN-1001", totals: { lines: 2, expectedKg: 360, doneKg: null } });
    expect(card.lines.find((l) => l.itemId === ORANGES)).toMatchObject({ expected: 20, done: null, expectedKg: 360, variety: "Valencia", bestBefore: "2026-12-01" });
  });

  it("is changed freely as a draft; once ready only its header — the lines need it back as a draft", async () => {
    await updateOrder(v[KEEP]!, R1, { lines: [{ itemId: ORANGES, qty: 20, kg: "360", variety: "Valencia", bestBefore: "2026-12-01" }, { itemId: STRAWS, qty: 3 }] });
    expect((await orderDetail(v[KEEP]!, R1))!.lines.find((l) => l.itemId === STRAWS)!.expected).toBe(3);
    expect(await setOrderReady(v[KEEP]!, R1, true)).toMatchObject({ state: "ready", replay: false });
    expect(await setOrderReady(v[KEEP]!, R1, true)).toMatchObject({ state: "ready", replay: true });
    expect((await refusal(updateOrder(v[KEEP]!, R1, { lines: [{ itemId: ORANGES, qty: 1 }] }))).code).toBe("not_draft");
    await updateOrder(v[KEEP]!, R1, { priority: "urgent", note: "Gate 2" });
    expect((await orderDetail(v[KEEP]!, R1))!).toMatchObject({ priority: "urgent", note: "Gate 2" });
    // The step of the item still holds: half a box of straws, never a quarter.
    expect((await refusal(createOrder(v[KEEP]!, { id: id(), kind: "receipt", supplierId: FVC, lines: [{ itemId: STRAWS, qty: "0.25" }] }))).code).toBe("bad_step");
    expect((await refusal(createOrder(v[SUPV]!, { id: id(), kind: "receipt", supplierId: FVC, lines: [{ itemId: STRAWS, qty: 1 }] }))).status).toBe(403);
  });

  it("is received against what was expected: every line once, something must have come", async () => {
    expect((await refusal(validateOrder(v[KEEP]!, R1, { stockDocId: id(), lines: [{ itemId: ORANGES, qty: 18 }] }))).code).toBe("every_line");
    expect(
      (await refusal(validateOrder(v[KEEP]!, R1, { stockDocId: id(), lines: [{ itemId: ORANGES, qty: 0 }, { itemId: STRAWS, qty: 0 }] }))).code,
    ).toBe("nothing_done");
    expect(await inWarehouse(ORANGES)).toBe(0);
  });

  it("posts the delivery through the ledger once, makes a lot of each line, and leaves a backorder for what did not come", async () => {
    const done = await validateOrder(v[KEEP]!, R1, {
      stockDocId: DOC1,
      backorder: true,
      backorderId: BACK,
      lines: [{ itemId: ORANGES, qty: 18, kg: "310" }, { itemId: STRAWS, qty: 3 }],
    });
    expect(done).toMatchObject({ state: "done", replay: false, stockDocId: DOC1, backorder: { id: BACK, state: "ready" } });
    // 18 of 20 cartons: the note's 360 kg for 20 is 324 kg for the 18 that came; 310 kg is below 324 × (1 − 2 %) = 317.52, so
    // it is light too. (342.5 kg would not be: the two missing cartons are short once, in cartons.)
    expect(SHORT_WEIGHT_SHARE).toBe(0.02);
    expect(done.short).toEqual([
      { itemId: ORANGES, name: `${TAG} oranges`, unit: "carton", expected: 20, done: 18, expectedKg: 360, expectedKgForDone: 324, doneKg: 310, weightShort: true },
    ]);
    expect(await inWarehouse(ORANGES)).toBe(18);
    expect(await inWarehouse(STRAWS)).toBe(3);
    const [doc] = await sql()<{ kind: string; from_location_id: string; to_location_id: string; supplier: string; invoice_no: string }[]>`
      select kind, from_location_id, to_location_id, supplier, invoice_no from stock_doc where id = ${DOC1}`;
    expect(doc).toEqual({ kind: "receipt", from_location_id: PLACE.suppliers, to_location_id: PLACE.warehouse, supplier: `${TAG} Fresh Fruit Co`, invoice_no: "DN-1001" });
    // The app retrying is answered as done; nothing is posted twice.
    expect(await validateOrder(v[KEEP]!, R1, { stockDocId: DOC1, lines: [] })).toMatchObject({ state: "done", replay: true, backorder: { id: BACK } });
    expect(await inWarehouse(ORANGES)).toBe(18);
    expect((await refusal(validateOrder(v[KEEP]!, R1, { stockDocId: id(), lines: [] }))).code).toBe("already_done");
    const card = (await orderDetail(v[KEEP]!, R1))!;
    expect(card).toMatchObject({ state: "done", short: true, closedShort: false, stockDocState: "posted", backorders: [{ id: BACK, state: "ready" }], totals: { doneKg: 310 } });
    const oranges = card.lines.find((l) => l.itemId === ORANGES)!;
    expect(oranges).toMatchObject({ done: 18, doneKg: 310, expectedKgForDone: 324, lot: `${card.number}-1`, returnable: 18 });
    const back = (await orderDetail(v[KEEP]!, BACK))!;
    expect(back).toMatchObject({ state: "ready", backorderOf: { id: R1, number: card.number } });
    expect(back.lines.map((l) => [l.itemId, l.expected])).toEqual([[ORANGES, 2]]);
    const [lot] = await sql()<{ qty: string; weight_g: string; variety: string; best_before: string; received_on: string }[]>`
      select qty::text as qty, weight_g::text as weight_g, variety, best_before::text as best_before, received_on::text as received_on
        from inv_lot where order_id = ${R1} and item_id = ${ORANGES}`;
    expect(lot).toEqual({ qty: "18.000", weight_g: "310000", variety: "Valencia", best_before: "2026-12-01", received_on: today });
  });

  it("tells the approvers a delivery came short, while the driver may still be at the door", async () => {
    const told = await sql()<{ employee_id: string; payload: { text?: string } }[]>`
      select o.recipient_employee_id as employee_id, o.payload from notification_outbox o where o.idempotency_key like ${`wh.short:${R1}:%`}`;
    expect(told.length).toBeGreaterThan(0);
    expect(told.every((t) => t.employee_id === OPS)).toBe(true);
    expect(JSON.stringify(told[0]!.payload)).toContain("18 of 20 cartons");
    // The weight is held to the note's for the 18 that came, not the 20 expected.
    expect(JSON.stringify(told[0]!.payload)).toContain("310 kg on the scale against 324 kg by the note (−4.3 %)");
  });

  it("is never changed once done — not through core, not through the table", async () => {
    expect((await refusal(updateOrder(v[KEEP]!, R1, { note: "changed" }))).code).toBe("closed");
    expect((await refusal(cancelOrder(v[KEEP]!, R1))).code).toBe("already_done");
    await expect(sql()`update wh_order set note = 'rewritten' where id = ${R1}`).rejects.toThrow(/never changed/);
    await expect(sql()`update wh_order_line set done_qty = 20 where order_id = ${R1} and item_id = ${ORANGES}`).rejects.toThrow(/not changed/);
    await expect(sql()`update inv_lot set qty = 20 where order_id = ${R1}`).rejects.toThrow(/never changed/);
  });

  it("closes short when the rest will not come, and a cancelled one never receives", async () => {
    const r = await validateOrder(v[KEEP]!, R2, { stockDocId: id(), backorder: false, lines: [{ itemId: ORANGES, qty: 3 }] });
    expect(r.backorder).toBeNull();
    expect((await orderDetail(v[KEEP]!, R2))!).toMatchObject({ state: "done", closedShort: true, backorders: [] });
    expect(await inWarehouse(ORANGES)).toBe(21);
    const c = id();
    await createOrder(v[KEEP]!, { id: c, kind: "receipt", supplierId: AWIR, lines: [{ itemId: ORANGES, qty: 1 }] });
    expect(await cancelOrder(v[KEEP]!, c, { note: "Not coming" })).toMatchObject({ state: "cancelled", replay: false });
    expect((await refusal(validateOrder(v[KEEP]!, c, { stockDocId: id(), lines: [{ itemId: ORANGES, qty: 1 }] }))).code).toBe("closed");
  });
});

describe("a return to the supplier", () => {
  let receipt = "";
  const RET = id();
  const RETDOC = id();

  it("never sends back more than came in that delivery", async () => {
    const [r] = await sql()<{ id: string }[]>`select id from wh_order where created_by = ${KEEP} and kind = 'receipt' and supplier_id = ${FVC} and state = 'done'`;
    receipt = r!.id;
    expect((await refusal(startReturn(v[KEEP]!, receipt, { id: id(), reason: "quality", lines: [{ itemId: ORANGES, qty: 19 }] }))).code).toBe("more_than_received");
    expect((await refusal(startReturn(v[KEEP]!, receipt, { id: id(), reason: "other", lines: [{ itemId: ORANGES, qty: 1 }] }))).code).toBe("note_needed");
    expect((await refusal(startReturn(v[KEEP]!, receipt, { id: id(), reason: "quality", lines: [{ itemId: FORMULA, qty: 1 }] }))).code).toBe("not_in_delivery");
    const made = await startReturn(v[KEEP]!, receipt, { id: RET, reason: "quality", note: "Not good orange", lines: [{ itemId: ORANGES, qty: 2, kg: "38" }] });
    expect(made.state).toBe("ready");
    expect(made.number).toMatch(/^RET-\d{4}-\d{4}$/);
    // What is planned to go back counts already: 16 of the 18 may still go.
    expect((await orderDetail(v[KEEP]!, receipt))!.lines.find((l) => l.itemId === ORANGES)!.returnable).toBe(16);
    expect((await orderDetail(v[KEEP]!, RET))!.lines[0]!).toMatchObject({ expected: 2, available: 21 });
  });

  it("posts a 'supplier_return' from the warehouse to Suppliers, and tells the approvers", async () => {
    expect((await refusal(validateOrder(v[KEEP]!, RET, { stockDocId: id(), lines: [{ itemId: ORANGES, qty: 3 }] }))).code).toBe("more_than_planned");
    // Lighter than planned (30 kg of 38): a return is never "short" — that is a delivery's word.
    const done = await validateOrder(v[KEEP]!, RET, { stockDocId: RETDOC, lines: [{ itemId: ORANGES, qty: 2, kg: "30" }] });
    expect(done).toMatchObject({ state: "done", backorder: null, short: [] });
    expect((await orderDetail(v[KEEP]!, RET))!).toMatchObject({ state: "done", short: false, lines: [{ done: 2, doneKg: 30 }] });
    expect(await inWarehouse(ORANGES)).toBe(19);
    const [doc] = await sql()<{ kind: string; reason: string; from_location_id: string; to_location_id: string }[]>`
      select kind, reason, from_location_id, to_location_id from stock_doc where id = ${RETDOC}`;
    expect(doc).toEqual({ kind: "supplier_return", reason: "quality", from_location_id: PLACE.warehouse, to_location_id: PLACE.suppliers });
    const told = await sql()<{ employee_id: string }[]>`
      select recipient_employee_id as employee_id from notification_outbox where idempotency_key like ${`wh.return:${RET}:%`}`;
    expect(told.length).toBeGreaterThan(0);
    expect(told.every((t) => t.employee_id === OPS)).toBe(true);
    expect((await orderDetail(v[KEEP]!, receipt))!).toMatchObject({ returns: [{ id: RET, state: "done" }] });
    expect((await refusal(startReturn(v[KEEP]!, receipt, { id: id(), reason: "excess", lines: [{ itemId: ORANGES, qty: 17 }] }))).code).toBe("more_than_received");
  });

  it("is counted on the day sheet, so the warehouse's columns still add up to its closing stock", async () => {
    const day = await inventoryDay(v[OPS]!, today);
    const row = day.warehouse.find((r) => r.itemId === ORANGES)!;
    expect(row).toMatchObject({ opening: 0, received: 21, returned: 2, closing: 19 });
    expect(row.opening + row.received - row.givenOut + row.cameBack + row.takenBack - row.used - row.damaged - row.returned + row.adjusted + row.reversed).toBe(row.closing);
  });

  it("is undone by an approver's reversal, like any stock document", async () => {
    await reverseDocument(v[OPS]!, RETDOC, { id: id(), reason: "entered_by_mistake" });
    expect(await inWarehouse(ORANGES)).toBe(21);
    expect((await orderDetail(v[KEEP]!, RET))!.stockDocState).toBe("reversed");
  });
});

describe("reorder rules", () => {
  it("are checked against the item, the place and the supplier", async () => {
    const W = { kind: "warehouse" } as const;
    expect((await refusal(saveReorderRule(v[KEEP]!, { itemId: ORANGES, place: W, min: 10, max: 5 }))).code).toBe("bad_range");
    expect((await refusal(saveReorderRule(v[KEEP]!, { itemId: STRAWS, place: W, min: "0.25", max: 5 }))).code).toBe("bad_step");
    expect((await refusal(saveReorderRule(v[KEEP]!, { itemId: ORANGES, place: { kind: "person", employeeId: EMP }, min: 1, max: 2 }))).code).toBe("not_a_holder");
    expect((await refusal(saveReorderRule(v[KEEP]!, { itemId: ORANGES, place: { kind: "person", employeeId: VMO }, min: 1, max: 2, supplierId: FVC }))).code).toBe("bad_supplier");
    expect((await refusal(saveReorderRule(v[SUPV]!, { itemId: ORANGES, place: W, min: 1, max: 2 }))).status).toBe(403);
  });

  it("suggest the forecast's shortfall up to the maximum, in whole packs — counting what is already coming", async () => {
    // After the hand-out below, the warehouse holds 20 cartons and 2 more are coming (the backorder): forecast 22. Minimum 25,
    // maximum 40, packs of 4: 40 − 22 = 18 → 5 packs → 20 cartons (forecast then 42: above the maximum by less than one pack).
    await saveReorderRule(v[KEEP]!, { itemId: ORANGES, place: { kind: "warehouse" }, min: 25, max: 40, multiple: 4, supplierId: FVC });
    expect((await refusal(saveReorderRule(v[KEEP]!, { itemId: ORANGES, place: { kind: "warehouse" }, min: 1, max: 2 }))).code).toBe("rule_exists");
    // The driver holds nothing and one carton is on its way to them: forecast 1, minimum 2, maximum 5 → 4 cartons.
    await saveReorderRule(v[KEEP]!, { itemId: ORANGES, place: { kind: "person", employeeId: VMO }, min: 2, max: 5 });
    await startHandover(v[KEEP]!, { id: id(), from: { kind: "warehouse" }, to: { kind: "person", employeeId: VMO }, lines: [{ itemId: ORANGES, qty: 1 }] });
    const s = await reorderSuggestions(v[SUPV]!);
    expect(s.hidden).toBe(false);
    const wh = s.warehouse.find((x) => x.rule.item.id === ORANGES)!;
    expect(wh).toMatchObject({ onHand: 20, incoming: 2, forecast: 22, suggest: 20, leadDays: 1, rule: { min: 25, max: 40, multiple: 4, supplier: { id: FVC } } });
    const p = s.people.find((x) => x.rule.item.id === ORANGES && x.rule.place.employeeId === VMO)!;
    expect(p).toMatchObject({ onHand: 0, incoming: 1, forecast: 1, suggest: 4, rule: { multiple: 1, place: { kind: "person", name: `${TAG} Driver` } } });
  });

  it("hide the warehouse's suggestions from someone counting it — they would tell its figures", async () => {
    const COUNT = id();
    await startCount(v[KEEP]!, { id: COUNT, kind: "spot" });
    try {
      const s = await reorderSuggestions(v[KEEP]!);
      expect(s.hidden).toBe(true);
      expect(s.warehouse).toEqual([]);
      expect((await refusal(stockAt(v[KEEP]!, null))).code).toBe("counting_now");
      expect((await reorderSuggestions(v[SUPV]!)).hidden).toBe(false);
    } finally {
      await cancelCount(v[KEEP]!, COUNT);
    }
  });
});

describe("the reports", () => {
  it("stock now is every real place's balance; stock at the end of yesterday had none of today's", async () => {
    const now = await stockAt(v[SUPV]!, null);
    const o = now.items.find((i) => i.id === ORANGES)!;
    expect(o).toMatchObject({ warehouse: 20, withPeople: 0, inTransit: 1, total: 21 });
    expect(o.warehouse).toBe(await inWarehouse(ORANGES));
    const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    expect((await stockAt(v[SUPV]!, yesterday)).items.find((i) => i.id === ORANGES)).toBeUndefined();
    expect((await refusal(stockAt(v[VMO]!, null))).status).toBe(403);
  });

  it("lists every move of an item, with the document that posted it and the totals in and out of the warehouse", async () => {
    const r = await moveReport(v[SUPV]!, { from: today, to: today, itemId: ORANGES });
    const received = r.rows.filter((m) => m.kind === "receipt");
    expect(received.map((m) => m.qty).sort()).toEqual([18, 3]);
    expect(received.every((m) => m.order !== null && m.order.number.startsWith("IN-"))).toBe(true);
    expect(r.rows.some((m) => m.kind === "supplier_return" && m.order?.number.startsWith("RET-"))).toBe(true);
    // In: 18 + 3 received + 2 back by the reversal = 23; out: 2 returned + 1 handed out = 3.
    expect(r.totals.find((t) => t.id === ORANGES)).toMatchObject({ into: 23, outOf: 3 });
    const page = await moveReport(v[SUPV]!, { from: today, to: today, itemId: ORANGES, limit: 2 });
    expect(page.rows.length).toBe(2);
    expect(page.more).toBe(true);
    const next = await moveReport(v[SUPV]!, { from: today, to: today, itemId: ORANGES, limit: 2, cursor: page.cursor });
    expect(next.rows.every((m) => m.id < page.rows[1]!.id)).toBe(true);
    expect((await refusal(moveReport(v[SUPV]!, { from: today, to: "2020-01-01" }))).code).toBe("bad_range");
  });

  it("writes the moves as a CSV a spreadsheet opens safely", async () => {
    await receiveDelivery(v[KEEP]!, { id: id(), supplier: "Shop", lines: [{ itemId: FORMULA, qty: 1 }] });
    const { csv, rows, more } = await moveReportCsv(v[SUPV]!, { from: today, to: today, itemId: FORMULA });
    expect(rows).toBe(1);
    expect(more).toBe(0);
    // UTF-8 with a byte-order mark, which Excel needs to read the names right (trim() would hide it, so it is checked first).
    expect(csv.startsWith("\uFEFFTime (Dubai),")).toBe(true);
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe("Time (Dubai),Kind,Reason,Item,Amount,Unit,From,To,By,Supplier,Document,Move");
    // A name starting with "=" is written as text, never as a formula a spreadsheet would run.
    expect(lines[1]).toContain(`'=${TAG} formula`);
    expect(lines[1]).toContain("Delivery in");
  });

  it("tracks one item: where it is now, its lots, its moves", async () => {
    const t = (await itemTracking(v[SUPV]!, ORANGES, { from: today, to: today }))!;
    expect(t.now.map((n) => [n.place.kind, n.qty])).toEqual([
      ["warehouse", 20],
      ["in_transit", 1],
    ]);
    expect(t.lots).toEqual(
      expect.arrayContaining([expect.objectContaining({ qty: 18, kg: 310, variety: "Valencia", supplier: `${TAG} Fresh Fruit Co`, receivedOn: today })]),
    );
    expect(t.moves.length).toBeGreaterThanOrEqual(5);
    expect(await itemTracking(v[SUPV]!, randomUUID(), { from: today, to: today })).toBeNull();
  });

  it("counts each supplier's deliveries — never a person", async () => {
    const { lightShare, rows } = await supplierReport(v[SUPV]!, { from: today, to: today });
    expect(lightShare).toBe(SHORT_WEIGHT_SHARE);
    const fvc = rows.find((r) => r.supplier.id === FVC)!;
    // One receipt, scheduled for today and done today; 1 of its 2 lines complete; 310 kg on the scale against the note's 324 kg
    // for the 18 cartons that came (360 kg for 20) — one light line; one return; the backorder still open, not overdue (due today).
    expect(fvc).toMatchObject({ receipts: 1, scheduled: 1, onTime: 1, lines: 2, linesComplete: 1, kgExpected: 324, kgReceived: 310, linesLight: 1, returns: 1, returnLines: 1, open: 1, overdue: 0 });
    const awir = rows.find((r) => r.supplier.id === AWIR)!;
    expect(awir).toMatchObject({ receipts: 1, scheduled: 0, lines: 1, linesComplete: 0, kgExpected: null, open: 0 });
  });

  it("lists the documents by kind, state and supplier, newest first, page by page", async () => {
    const open = await listOrders(v[SUPV]!, { state: "open", supplierId: FVC });
    expect(open.orders.map((o) => o.state)).toEqual(["ready"]);
    const all = await listOrders(v[SUPV]!, { supplierId: FVC });
    expect(all.orders.map((o) => o.kind).sort()).toEqual(["receipt", "receipt", "supplier_return"]);
    const page = await listOrders(v[SUPV]!, { supplierId: FVC, limit: 2 });
    expect(page.more).toBe(true);
    const rest = await listOrders(v[SUPV]!, { supplierId: FVC, limit: 2, cursor: page.cursor });
    expect([...page.orders, ...rest.orders].map((o) => o.id).sort()).toEqual(all.orders.map((o) => o.id).sort());
    expect((await listOrders(v[SUPV]!, { search: "DN-1001" })).orders.length).toBeGreaterThanOrEqual(1);
    expect((await refusal(listOrders(v[VMO]!))).status).toBe(403);
  });
});

describe("row security", () => {
  it("shows the documents only to who sees all stock, and lets no one write them except through core", async () => {
    const seen = (who: string) =>
      withContext(v[who]!, (tx) => tx<{ n: number }[]>`select count(*)::int as n from wh_order where created_by = ${KEEP}`, { readOnly: true });
    expect((await seen(VMO))[0]!.n).toBe(0);
    expect((await seen(SUPV))[0]!.n).toBeGreaterThan(0);
    await expect(withContext(v[KEEP]!, (tx) => tx`insert into supplier (name) values (${`${TAG} by the app role`})`)).rejects.toThrow(/permission denied/);
  });
});

describe("erasure", () => {
  it("removes a person's words from the documents they made, and keeps the documents", async () => {
    const O = id();
    await createOrder(v[LEAVER]!, { id: O, kind: "receipt", supplierId: AWIR, note: "Call the driver at the gate", lines: [{ itemId: STRAWS, qty: 1, note: "dented box" }] });
    await cancelOrder(v[LEAVER]!, O, { note: "Wrong supplier, said the driver" });
    // Before: their own download carries the document with the words they typed.
    const out = (await exportPersonData({ employeeId: LEAVER, requestedBy: LEAVER })) as Record<string, Record<string, unknown>[]>;
    expect(out.warehouseDocuments!.find((d) => d.your_note === "Call the driver at the gate")).toMatchObject({
      kind: "receipt", state: "cancelled", your_cancel_note: "Wrong supplier, said the driver",
    });
    expect(String(out.warehouseDocuments!.find((d) => d.your_note === "Call the driver at the gate")!.lines)).toContain("(dented box)");
    await eraseEmployee({ employeeId: LEAVER, by: DEMO_CEO_ID, reason: "left" });
    const [o] = await sql()<{ note: string; cancel_note: string; state: string; number: string }[]>`select note, cancel_note, state, number from wh_order where id = ${O}`;
    expect(o).toMatchObject({ note: "[erased]", cancel_note: "[erased]", state: "cancelled" });
    const [l] = await sql()<{ note: string; expected_qty: string }[]>`select note, expected_qty::text as expected_qty from wh_order_line where order_id = ${O}`;
    expect(l).toEqual({ note: "[erased]", expected_qty: "1.000" });
    // Only ever removed: the words are not rewritten through the table either.
    await expect(sql()`update wh_order set cancel_note = 'something else' where id = ${O}`).rejects.toThrow(/never changed/);
  });
});

describe("kilograms", () => {
  it("are read as whole grams, never rounded past three decimals", () => {
    expect(parseKg("18.5")).toBe(18_500);
    // Held to the note's weight for what came: 8 of 10 cartons of a 180 kg note should weigh 144 kg.
    expect(noteGramsFor(10_000, 8_000, 180_000)).toBe(144_000);
    expect(isLight(10_000, 8_000, 180_000, 150_500)).toBe(false);
    expect(isLight(10_000, 8_000, 180_000, 141_120)).toBe(false);
    expect(isLight(10_000, 8_000, 180_000, 141_119)).toBe(true);
    expect(isLight(10_000, 10_000, 180_000, 176_399)).toBe(true);
    expect(isLight(10_000, 0, 180_000, 0)).toBe(false);
    expect(isLight(10_000, 8_000, null, 150_500)).toBe(false);
    expect(parseKg(0.001)).toBe(1);
    expect(parseKg(null)).toBeNull();
    expect(() => parseKg("1.2345")).toThrow(/three decimals/);
    expect(() => parseKg("0")).toThrow(/more than zero/);
    expect(parseKg("0", "weight", true)).toBe(0);
  });
});
