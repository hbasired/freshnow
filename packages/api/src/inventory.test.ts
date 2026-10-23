import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, DEMO_CEO_ID, getServiceSql } from "@freshnow/core";
import { buildServer } from "./server.js";

/** The Inventory portal over HTTP (TASK-060): who may do what, the same request twice, refusals in words. */
const app = buildServer(false);
const TAG = `INVAPI-${randomUUID().slice(0, 6)}`;
const KEEP = randomUUID();
const KEEP2 = randomUUID();
const OPS = randomUUID();
const VMO = randomUUID();
const CASH = randomUUID();
const STAFF: string[] = [KEEP, KEEP2, OPS, VMO, CASH];
const ITEM = randomUUID();
const sql = () => getServiceSql();

const call = (method: "GET" | "POST" | "PUT", url: string, viewer: string, payload?: unknown) =>
  app.inject({ method, url: `${url}${url.includes("?") ? "&" : "?"}viewer=${viewer}`, ...(payload === undefined ? {} : { payload: payload as object }) });

beforeAll(async () => {
  for (const [pid, name, role] of [
    [KEEP, "Keeper", "warehouse_keeper"],
    [KEEP2, "Keeper2", "warehouse_keeper"],
    [OPS, "Ops", "ops_head"],
    [VMO, "Driver", "vmo"],
    [CASH, "Cash", "cash_auditor"],
  ] as const) {
    await sql()`insert into employee (id, display_name, status, is_synthetic, access_role, manager_employee_id)
                values (${pid}, ${`${TAG} ${name}`}, 'active', true, ${role}, ${DEMO_CEO_ID})`;
  }
  await sql()`insert into inv_item (id, name, category, unit, step, sort_order, is_synthetic) values (${ITEM}, ${`${TAG} oranges`}, 'oranges', 'carton', 1, 1, true)`;
});

afterAll(async () => {
  await sql().begin(async (tx) => {
    const docs = (await tx<{ id: string }[]>`select id from stock_doc where created_by = any(${STAFF}::uuid[])`).map((r) => r.id);
    await tx`delete from audit_log where entity = 'stock_doc' and entity_id = any(${docs})`;
    await tx`select inv_purge_docs(${docs}::uuid[])`;
    await tx`set local freshnow.ledger_purge = 'on'`;
    await tx`delete from count_line where session_id in (select id from count_session where started_by = any(${STAFF}::uuid[]))`;
    await tx`delete from count_session where started_by = any(${STAFF}::uuid[])`;
    await tx`delete from stock_balance where item_id = ${ITEM}`;
    await tx`delete from inv_location where employee_id = any(${STAFF}::uuid[])`;
    await tx`delete from inv_item where id = ${ITEM} or name like ${`${TAG}%`}`;
  });
  await sql()`delete from notification_outbox where idempotency_key like ${"stock.%"}`;
  await sql()`delete from audit_log where actor = any(${STAFF.map((s) => `employee:${s}`)})`;
  await sql()`delete from employee where id = any(${STAFF}::uuid[])`;
  await app.close();
  await closeDb();
});

describe("the Inventory API", () => {
  const delivery = randomUUID();
  const handover = randomUUID();

  it("a keeper records a delivery; the same request again changes nothing", async () => {
    const body = { id: delivery, supplier: "FVC", lines: [{ itemId: ITEM, qty: 10, variety: "LALA", cartonKg: 17.15 }] };
    const r1 = await call("POST", "/dashboard/inventory/receipts", KEEP, body);
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toEqual({ docId: delivery, state: "posted", replay: false });
    const r2 = await call("POST", "/dashboard/inventory/receipts", KEEP, body);
    expect(r2.json()).toMatchObject({ replay: true });
    const home = (await call("GET", "/dashboard/inventory/home", KEEP)).json() as { items: { id: string; warehouse: number }[] };
    expect(home.items.find((i) => i.id === ITEM)?.warehouse).toBe(10);
  });

  it("refuses in words: a driver recording a delivery, a cash auditor opening the portal, a bad amount", async () => {
    const vmo = await call("POST", "/dashboard/inventory/receipts", VMO, { id: randomUUID(), lines: [{ itemId: ITEM, qty: 1 }] });
    expect(vmo.statusCode).toBe(403);
    expect(vmo.json()).toMatchObject({ error: { code: "not_allowed", message: "Only the warehouse records deliveries." } });
    expect((await call("GET", "/dashboard/inventory/home", CASH)).statusCode).toBe(403);
    const bad = await call("POST", "/dashboard/inventory/receipts", KEEP, { id: randomUUID(), lines: [{ itemId: ITEM, qty: "1.2345" }] });
    expect(bad.statusCode).toBe(400);
    expect((await call("GET", `/dashboard/inventory/docs/${randomUUID()}`, KEEP)).statusCode).toBe(404);
  });

  it("a hand-out waits for the driver, who sees it — and only they can accept it", async () => {
    const r = await call("POST", "/dashboard/inventory/handovers", KEEP, {
      id: handover, from: { kind: "warehouse" }, to: { kind: "person", employeeId: VMO }, lines: [{ itemId: ITEM, qty: 4 }],
    });
    expect(r.json()).toMatchObject({ state: "waiting" });
    const home = (await call("GET", "/dashboard/inventory/home", VMO)).json() as { waitingForMe: { id: string; may: { answer: boolean } }[]; items: unknown[] };
    expect(home.waitingForMe.map((d) => d.id)).toContain(handover);
    expect(home.waitingForMe.find((d) => d.id === handover)?.may.answer).toBe(true);
    expect(home.items).toEqual([]);
    expect((await call("POST", `/dashboard/inventory/handovers/${handover}/answer`, KEEP2, { answer: "accept" })).statusCode).toBe(403);
    const ok = await call("POST", `/dashboard/inventory/handovers/${handover}/answer`, VMO, { answer: "accept" });
    expect(ok.json()).toMatchObject({ state: "accepted" });
    const mine = (await call("GET", "/dashboard/inventory/home", VMO)).json() as { mine: { itemId: string; qty: number }[] };
    // Each held item carries its step: a driver's screen has no catalogue to look it up in.
    expect(mine.mine).toEqual([expect.objectContaining({ itemId: ITEM, qty: 4, step: 1 })]);
  });

  it("the driver's own document is theirs to read; another driver's is not", async () => {
    const own = await call("GET", `/dashboard/inventory/docs/${handover}`, VMO);
    expect(own.statusCode).toBe(200);
    expect(own.json()).toMatchObject({ kind: "handover", state: "accepted", lines: [expect.objectContaining({ qty: 4, step: 1, accepted: 4, pending: 0 })] });
    expect((await call("GET", `/dashboard/inventory/docs/${delivery}`, VMO)).statusCode).toBe(404);
  });

  it("a count over HTTP: the list without figures, then the outcome", async () => {
    const id = randomUUID();
    const start = await call("POST", "/dashboard/inventory/counts", KEEP, { id, kind: "spot" });
    expect(start.statusCode).toBe(200);
    const items = (start.json() as { items: Record<string, unknown>[] }).items;
    expect(items.every((i) => !("expected" in i) && !("qty" in i))).toBe(true);
    const done = await call("POST", `/dashboard/inventory/counts/${id}/submit`, KEEP, { lines: [{ itemId: ITEM, qty: 6 }] });
    expect(done.json()).toMatchObject({ state: "closed", matched: 1 });
    const list = (await call("GET", "/dashboard/inventory/counts", OPS)).json() as { id: string; state: string }[];
    expect(list.find((c) => c.id === id)?.state).toBe("closed");
  });

  it("the day's sheet and the movements list, for whoever sees all stock", async () => {
    const day = await call("GET", "/dashboard/inventory/day", OPS);
    expect(day.statusCode).toBe(200);
    const row = (day.json() as { warehouse: { itemId: string; received: number; givenOut: number; closing: number }[] }).warehouse.find((w) => w.itemId === ITEM);
    expect(row).toMatchObject({ received: 10, givenOut: 4, closing: 6 });
    expect((await call("GET", "/dashboard/inventory/day", VMO)).statusCode).toBe(403);
    const moves = (await call("GET", `/dashboard/inventory/movements?itemId=${ITEM}`, OPS)).json() as { docs: { id: string }[] };
    expect(moves.docs.map((d) => d.id)).toEqual(expect.arrayContaining([delivery, handover]));
  });

  it("the catalogue: the keeper adds an item; the tolerance is the approvers'", async () => {
    const add = await call("POST", "/dashboard/inventory/items", KEEP, { name: `${TAG} lids`, category: "cups_packaging", unit: "box", step: 1 });
    expect(add.json()).toMatchObject({ created: true });
    const id = (add.json() as { id: string }).id;
    const tol = await call("PUT", `/dashboard/inventory/items/${id}`, KEEP, { name: `${TAG} lids`, category: "cups_packaging", unit: "box", step: 1, countTolerance: 2 });
    expect(tol.statusCode).toBe(403);
    const byOps = await call("PUT", `/dashboard/inventory/items/${id}`, OPS, { name: `${TAG} lids`, category: "cups_packaging", unit: "box", step: 1, countTolerance: 2, minLevel: 3 });
    expect(byOps.json()).toMatchObject({ created: false });
  });
});
