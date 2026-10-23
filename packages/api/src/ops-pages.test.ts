import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, DEMO_CEO_ID, getServiceSql } from "@freshnow/core";
import { buildServer } from "./server.js";

/**
 * The Operations pages over HTTP (TASK-072): one machine as a page, a day's refills, a day's sales — who may read them, bad input
 * refused in words, and the shapes the screens draw. The figures themselves are tested in core (ops-machine-page.test.ts).
 */
const app = buildServer(false);
const TAG = `OPAPI-${randomUUID().slice(0, 6)}`;
const SUP = randomUUID();
const VMO = randomUUID();
const STAFF = [SUP, VMO];
const TV = 998_001;
const ASSET = 99_801;
let MACHINE = "";
const sql = () => getServiceSql();
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(new Date());
const tomorrow = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(new Date(Date.now() + 86_400_000));

const get = (url: string, viewer: string) => app.inject({ method: "GET", url: `${url}${url.includes("?") ? "&" : "?"}viewer=${viewer}` });

beforeAll(async () => {
  for (const [pid, role] of [
    [SUP, "supervisor"],
    [VMO, "vmo"],
  ] as const) {
    await sql()`insert into employee (id, display_name, status, is_synthetic, access_role, manager_employee_id)
                values (${pid}, ${`${TAG} ${role}`}, 'active', true, ${role}, ${DEMO_CEO_ID})`;
  }
  await sql()`insert into tv_machine (televend_id, caption, asset_no, enabled, region_caption, last_status, connection_status, stock_percent, raw, is_synthetic)
              values (${TV}, ${`${TAG} Mall-${ASSET}-DXB`}, ${ASSET}, true, ${`${TAG} Malls`}, 1, 1, 0.5, '{}'::jsonb, true)`;
  MACHINE = (await sql()<{ id: string }[]>`insert into machine (asset_no, label, is_synthetic) values (${ASSET}, ${`${TAG} Mall`}, true) returning id`)[0]!.id;
  await sql()`insert into machine_placement (machine_id, tv_machine_id, source, is_synthetic) values (${MACHINE}, ${TV}, 'manual', true)`;
  await sql()`insert into tv_vend (source, external_id, machine_tv_id, at, payment_type, payment_caption, quantity, raw, is_synthetic)
              values ('bridge', ${`${TAG}-1`}, ${TV}, now() - interval '1 minute', 0, 'Cash', 1, '{}'::jsonb, true)`;
});

afterAll(async () => {
  await sql()`delete from tv_vend where external_id like ${`${TAG}-%`}`;
  await sql()`delete from machine_placement where tv_machine_id = ${TV}`;
  await sql()`delete from tv_machine where televend_id = ${TV}`;
  await sql()`delete from machine where id = ${MACHINE}`;
  await sql()`delete from employee where id = any(${STAFF}::uuid[])`;
  await app.close();
  await closeDb();
});

describe("the Operations pages", () => {
  it("give a reader the machine's page, the day's refills and the day's sales", async () => {
    const page = await get(`/dashboard/ops/machines/${ASSET}/page`, SUP);
    expect(page.statusCode).toBe(200);
    expect(page.json()).toMatchObject({ assetNo: ASSET, category: `${TAG} Malls`, stock: { percent: 0.5 }, today: { cups: 1 } });
    expect((await get(`/dashboard/ops/refills?date=${today}`, SUP)).statusCode).toBe(200);
    const sales = await get(`/dashboard/ops/sales?date=${today}&machine=${TV}&limit=10`, SUP);
    expect(sales.statusCode).toBe(200);
    expect(sales.json()).toMatchObject({ date: today, summary: { cups: 1, machines: 1 }, rows: [{ machineTvId: TV, assetNo: ASSET, payment: "Cash" }] });
    // The fleet carries Televend's stock figure for the "low on stock" tile.
    const fleet = (await get("/dashboard/ops/fleet", SUP)).json() as { machines: { machineTvId: number; stockPercent: number | null }[] };
    expect(fleet.machines.find((m) => m.machineTvId === TV)?.stockPercent).toBe(0.5);
  });

  it("refuse a driver, a day not begun, a bad page marker, and an unknown machine", async () => {
    expect((await get(`/dashboard/ops/machines/${ASSET}/page`, VMO)).statusCode).toBe(403);
    expect((await get(`/dashboard/ops/sales?date=${today}`, VMO)).statusCode).toBe(403);
    expect((await get(`/dashboard/ops/refills?date=${tomorrow}`, SUP)).json()).toMatchObject({ error: { code: "bad_day" } });
    expect((await get(`/dashboard/ops/sales?date=${today}&before=nonsense`, SUP)).statusCode).toBe(400);
    expect((await get("/dashboard/ops/machines/99999/page", SUP)).statusCode).toBe(404);
    expect((await get(`/dashboard/ops/sales?date=${today}&limit=500`, SUP)).statusCode).toBe(400);
  });
});
