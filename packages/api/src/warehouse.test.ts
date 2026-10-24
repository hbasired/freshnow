import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, DEMO_CEO_ID, getServiceSql } from "@freshnow/core";
import { buildServer } from "./server.js";

/**
 * The warehouse documents over HTTP (TASK-086): the routes carry core's answers, refuse malformed requests before core sees them,
 * refuse in words who may not, and hand the movements over as a CSV file. What the documents guarantee is tested in core
 * (warehouse.test.ts); here, that the API keeps it.
 */
const app = buildServer(false);
const TAG = `WHAPI-${randomUUID().slice(0, 6)}`;
const KEEP = randomUUID();
const SUP = randomUUID();
const VMO = randomUUID();
const STAFF = [KEEP, SUP, VMO];
const ITEM = randomUUID();
const sql = () => getServiceSql();
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(new Date());
let SUPPLIER = "";

const call = (method: "GET" | "POST" | "PUT", url: string, viewer: string, payload?: unknown) =>
  app.inject({ method, url: `${url}${url.includes("?") ? "&" : "?"}viewer=${viewer}`, ...(payload === undefined ? {} : { payload: payload as object }) });

beforeAll(async () => {
  for (const [pid, name, role] of [
    [KEEP, "Keeper", "warehouse_keeper"],
    [SUP, "Supervisor", "supervisor"],
    [VMO, "Driver", "vmo"],
  ] as const) {
    await sql()`insert into employee (id, display_name, status, is_synthetic, access_role, manager_employee_id)
                values (${pid}, ${`${TAG} ${name}`}, 'active', true, ${role}, ${DEMO_CEO_ID})`;
  }
  await sql()`insert into inv_item (id, name, category, unit, step, count_tolerance, sort_order, is_synthetic)
              values (${ITEM}, ${`${TAG} oranges`}, 'oranges', 'carton', 1, 0, 1, true)`;
});

afterAll(async () => {
  await sql().begin(async (tx) => {
    const orders = (await tx<{ id: string }[]>`select id from wh_order where created_by = any(${STAFF}::uuid[])`).map((r) => r.id);
    const docs = (await tx<{ id: string }[]>`select id from stock_doc where created_by = any(${STAFF}::uuid[])`).map((r) => r.id);
    await tx`select wh_purge_orders(${orders}::uuid[], ${docs}::uuid[])`;
    await tx`set local freshnow.ledger_purge = 'on'`;
    await tx`delete from reorder_rule where item_id = ${ITEM}`;
    await tx`delete from stock_balance where item_id = ${ITEM}`;
    await tx`delete from inv_location where employee_id = any(${STAFF}::uuid[])`;
    await tx`delete from inv_item where id = ${ITEM}`;
    await tx`delete from supplier where name like ${`${TAG}%`}`;
  });
  await sql()`delete from notification_outbox where idempotency_key like ${"wh.%"} or idempotency_key like ${"stock.%"}`;
  await sql()`delete from audit_log where actor = any(${STAFF.map((s) => `employee:${s}`)})`;
  await sql()`delete from employee where id = any(${STAFF}::uuid[])`;
  await app.close();
  await closeDb();
});

describe("the warehouse API", () => {
  it("keeps suppliers: the warehouse adds, a supervisor reads, a driver is refused", async () => {
    const add = await call("POST", "/dashboard/warehouse/suppliers", KEEP, { name: `${TAG} Fruit Co`, leadDays: 1 });
    expect(add.statusCode).toBe(200);
    SUPPLIER = (add.json() as { id: string }).id;
    expect((await call("POST", "/dashboard/warehouse/suppliers", KEEP, { name: "" })).statusCode).toBe(400);
    expect((await call("POST", "/dashboard/warehouse/suppliers", SUP, { name: `${TAG} other` })).statusCode).toBe(403);
    const list = await call("GET", "/dashboard/warehouse/suppliers", SUP);
    expect((list.json() as { id: string }[]).some((s) => s.id === SUPPLIER)).toBe(true);
    const driver = await call("GET", "/dashboard/warehouse/suppliers", VMO);
    expect(driver.statusCode).toBe(403);
    expect(driver.json()).toMatchObject({ error: { code: "not_allowed" } });
  });

  it("plans a receipt, receives it with a backorder, and the stock is in the warehouse", async () => {
    const id = randomUUID();
    const made = await call("POST", "/dashboard/warehouse/orders", KEEP, {
      id, kind: "receipt", supplierId: SUPPLIER, scheduledOn: today, sourceRef: "DN-7", ready: true, lines: [{ itemId: ITEM, qty: 10, kg: "180" }],
    });
    expect(made.statusCode).toBe(200);
    expect(made.json()).toMatchObject({ id, state: "ready", replay: false });
    // The same request again creates nothing new.
    const again = await call("POST", "/dashboard/warehouse/orders", KEEP, {
      id, kind: "receipt", supplierId: SUPPLIER, scheduledOn: today, sourceRef: "DN-7", ready: true, lines: [{ itemId: ITEM, qty: 10, kg: "180" }],
    });
    expect(again.json()).toMatchObject({ id, replay: true });
    const back = randomUUID();
    const done = await call("POST", `/dashboard/warehouse/orders/${id}/validate`, KEEP, {
      stockDocId: randomUUID(), backorder: true, backorderId: back, lines: [{ itemId: ITEM, qty: 8, kg: "150.5" }],
    });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ state: "done", backorder: { id: back, state: "ready" } });
    const [b] = await sql()<{ qty: string }[]>`select qty::text as qty from stock_balance where location_id = '00000000-0000-0000-0000-00000000b001' and item_id = ${ITEM}`;
    expect(Number(b!.qty)).toBe(8);
    const card = await call("GET", `/dashboard/warehouse/orders/${id}`, SUP);
    expect(card.json()).toMatchObject({ state: "done", short: true, lines: [{ expected: 10, done: 8, expectedKg: 180, doneKg: 150.5 }] });
    expect((await call("GET", `/dashboard/warehouse/orders/${randomUUID()}`, SUP)).statusCode).toBe(404);
    const open = await call("GET", `/dashboard/warehouse/orders?state=open&supplierId=${SUPPLIER}`, SUP);
    expect((open.json() as { orders: { id: string }[] }).orders.map((o) => o.id)).toEqual([back]);
  });

  it("refuses a malformed request before core sees it, and a closed document in words", async () => {
    expect((await call("POST", "/dashboard/warehouse/orders", KEEP, { id: "not-a-uuid", kind: "receipt", supplierId: SUPPLIER, lines: [] })).statusCode).toBe(400);
    expect((await call("GET", "/dashboard/warehouse/orders?state=finished", SUP)).statusCode).toBe(400);
    const [o] = await sql()<{ id: string }[]>`select id from wh_order where created_by = ${KEEP} and state = 'done'`;
    const r = await call("PUT", `/dashboard/warehouse/orders/${o!.id}`, KEEP, { note: "too late" });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ error: { code: "closed" } });
  });

  it("sets what to keep and suggests what to order", async () => {
    const rule = await call("POST", "/dashboard/warehouse/rules", KEEP, { itemId: ITEM, place: { kind: "warehouse" }, min: 10, max: 20, supplierId: SUPPLIER });
    expect(rule.statusCode).toBe(200);
    const s = await call("GET", "/dashboard/warehouse/suggestions", SUP);
    // 8 in the warehouse + 2 still coming (the backorder) = 10: not below the minimum of 10, so nothing to order.
    const row = (s.json() as { warehouse: { rule: { item: { id: string } }; forecast: number; suggest: number }[] }).warehouse.find((x) => x.rule.item.id === ITEM)!;
    expect(row).toMatchObject({ forecast: 10, suggest: 0 });
  });

  it("hands over the movements as a CSV file", async () => {
    const r = await call("GET", `/dashboard/warehouse/moves.csv?from=${today}&to=${today}&itemId=${ITEM}`, SUP);
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/csv");
    expect(r.headers["content-disposition"]).toContain(`freshnow-moves-${today}-to-${today}.csv`);
    const lines = r.body.trim().split("\r\n");
    expect(lines[0]).toBe("Time (Dubai),Kind,Reason,Item,Amount,Unit,From,To,By,Supplier,Document,Move");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("Delivery in");
    expect((await call("GET", `/dashboard/warehouse/moves.csv?from=${today}&to=${today}`, VMO)).statusCode).toBe(403);
    const stock = await call("GET", `/dashboard/warehouse/stock-at?date=${today}`, SUP);
    expect((stock.json() as { items: { id: string; warehouse: number }[] }).items.find((i) => i.id === ITEM)).toMatchObject({ warehouse: 8 });
    const report = await call("GET", `/dashboard/warehouse/suppliers/report?from=${today}&to=${today}`, SUP);
    expect((report.json() as { supplier: { id: string }; receipts: number }[]).find((x) => x.supplier.id === SUPPLIER)).toMatchObject({ receipts: 1 });
  });
});
