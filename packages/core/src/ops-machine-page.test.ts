import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getServiceSql } from "./db.js";
import { DEMO_CEO_ID } from "./meta.js";
import { refillsOn, salesList } from "./ops-activity.js";
import { machinePage } from "./ops-machine-page.js";
import { loadViewer, type ViewerOrg } from "./org.js";

/**
 * One machine as a full page, a day's refills and a day's sales (TASK-072), against real Postgres. What must hold — from the
 * request (R7.3–7.5, R10, R11, R13) and the mirror's rules, not from reading the code:
 *   - a machine that moved keeps its history: every Televend record it has had is on its page and in its figures;
 *   - prices: cash is the price set on the machine, else AED 10; card is the "AED n" in its name, else the cash price;
 *   - stock: Televend's share × the capacity of a column (from the newest refill) × the columns, "about";
 *   - today by hour against the same weekday a week before; the week before's total only up to the same minute;
 *   - refills with who and how much; sales newest first, paged without a row twice, filtered, with the day's totals;
 *   - only the people who read Televend's data; names of visitors shown to a Supervisor who may read the visit.
 *
 * The fixture (Wednesday 20 Jul 2033, noon; the week before is Wednesday 13 Jul — far from any real data):
 *   asset 99601 stood at "Old Place" (Televend record A, now off) and stands at "New Place … AED12" (record B, 25 % stock).
 *   Today on B: 3 cups at 09:xx (2 cash, 1 Cashless 3), 2 at 11:xx (Cashless).
 *   13 Jul on A (before the move): 4 cups at 09:xx, 5 at 13:xx → the same minute last week (noon) is 4.
 *   A refill on B today: +30 to 63 of 63, by "Driver Kiran". A visit today by the driver.
 */

const TAG = `MP-${randomUUID().slice(0, 6)}`;
const CORR = randomUUID();
const SUP = randomUUID();
const KEEP = randomUUID();
const DRV = randomUUID();
const STAFF = [SUP, KEEP, DRV];
const ASSET = 99_601;
const A = 997_001;
const B = 997_002;
const NOW = new Date("2033-07-20T12:00:00+04:00");
const TODAY = "2033-07-20";
const LAST_WEEK = "2033-07-13";
const v: Record<string, ViewerOrg> = {};
const sql = () => getServiceSql();
let machineId = "";
let savedCursor: Date | null = null;
let n = 0;

async function sell(record: number, at: string, type: number, caption: string): Promise<void> {
  await sql()`
    insert into tv_vend (source, external_id, machine_tv_id, at, payment_type, payment_caption, product, quantity, raw, is_synthetic)
    values ('bridge', ${`${TAG}-${String(n++).padStart(3, "0")}`}, ${record}, ${at}, ${type}, ${caption}, 'Orange Juice New', 1, '{}'::jsonb, true)`;
}

beforeAll(async () => {
  const s = sql();
  for (const [pid, name, role] of [
    [SUP, "Sup", "supervisor"],
    [KEEP, "Keeper", "warehouse_keeper"],
    [DRV, "Driver Kiran", "vmo"],
  ] as const) {
    await s`insert into employee (id, display_name, status, is_synthetic, access_role, manager_employee_id)
            values (${pid}, ${`${TAG} ${name}`}, 'active', true, ${role}, ${DEMO_CEO_ID})`;
  }
  await s`insert into tv_machine (televend_id, caption, asset_no, enabled, region_caption, last_status, connection_status, raw, is_synthetic)
          values (${A}, ${`Old Place-${ASSET}-DXB`}, ${ASSET}, false, ${`${TAG} Parks`}, 1, 1, '{}'::jsonb, true)`;
  await s`insert into tv_machine (televend_id, caption, asset_no, enabled, region_caption, last_status, connection_status, signal_strength,
                                  stock_percent, raw, is_synthetic)
          values (${B}, ${`New Place-${ASSET}-AED12-DXB`}, ${ASSET}, true, ${`${TAG} Metro`}, 1, 1, 77, 0.25,
                  ${s.json({ stock_data: { num_column: 1, percentage: 0.25 } } as never)}, true)`;
  machineId = (await s<{ id: string }[]>`insert into machine (asset_no, label, is_synthetic) values (${ASSET}, ${`New Place-${ASSET}-AED12-DXB`}, true) returning id`)[0]!.id;
  await s`insert into machine_placement (machine_id, tv_machine_id, source, valid_from, valid_to, is_synthetic)
          values (${machineId}, ${A}, 'manual', '2033-07-01T00:00:00+04:00', '2033-07-15T00:00:00+04:00', true)`;
  await s`insert into machine_placement (machine_id, tv_machine_id, source, valid_from, is_synthetic)
          values (${machineId}, ${B}, 'manual', '2033-07-15T00:00:00+04:00', true)`;
  for (const [rec, cap, first, last] of [
    [A, `Old Place-${ASSET}-DXB`, "2033-07-01T08:00:00+04:00", "2033-07-14T20:00:00+04:00"],
    [B, `New Place-${ASSET}-AED12-DXB`, "2033-07-15T08:00:00+04:00", "2033-07-20T11:00:00+04:00"],
  ] as const) {
    await s`insert into tv_machine_caption (televend_id, caption, first_seen_at, last_seen_at) values (${rec}, ${cap}, ${first}, ${last})`;
  }
  // Today, on the new record.
  await sell(B, `${TODAY}T09:05:00+04:00`, 0, "Cash");
  await sell(B, `${TODAY}T09:15:00+04:00`, 0, "Cash");
  await sell(B, `${TODAY}T09:25:00+04:00`, 3, "Cashless 3");
  await sell(B, `${TODAY}T11:05:00+04:00`, 1, "Cashless");
  await sell(B, `${TODAY}T11:15:00+04:00`, 1, "Cashless");
  // The week before, on the old record.
  for (let i = 0; i < 4; i++) await sell(A, `${LAST_WEEK}T09:${String(10 + i).padStart(2, "0")}:00+04:00`, 0, "Cash");
  for (let i = 0; i < 5; i++) await sell(A, `${LAST_WEEK}T13:${String(10 + i).padStart(2, "0")}:00+04:00`, 1, "Cashless");
  await s`insert into tv_sync_run (stream, mode, transport, window_from, window_to, status, complete, correlation_id, finished_at)
          values ('vends', 'backfill', 'bridge', '2033-06-15T00:00:00+04:00', ${NOW}, 'ok', true, ${CORR}, now())`;
  savedCursor = (await s<{ read_until: Date }[]>`select read_until from tv_sync_cursor where stream = 'vends'`)[0]?.read_until ?? null;
  await s`insert into tv_sync_cursor (stream, read_until) values ('vends', ${NOW}) on conflict (stream) do update set read_until = excluded.read_until`;
  await s`insert into tv_refill (source, natural_key, machine_tv_id, machine_caption, at, filled_by, action, quantity_change, quantity_after, capacity, origin, raw, is_synthetic)
          values ('bridge', ${`${TAG}-r1`}, ${B}, ${`New Place-${ASSET}-AED12-DXB`}, ${`${TODAY}T08:30:00+04:00`}, 'Driver Kiran', 'filled', 30, 63, 63, 'mobile_app', '{}'::jsonb, true)`;
  await s`insert into tv_event (source, external_id, machine_tv_id, level, kind, name, started_at, raw, is_synthetic)
          values ('bridge', ${`${TAG}-e1`}, ${B}, 1, 'info', 'Cash Collection', ${`${TODAY}T08:40:00+04:00`}, '{}'::jsonb, true)`;
  await s`insert into visit (id, machine_id, employee_id, started_at, started_how, ended_at, request_hash, is_synthetic)
          values (${randomUUID()}, ${machineId}, ${DRV}, ${`${TODAY}T08:20:00+04:00`}, 'qr', ${`${TODAY}T08:50:00+04:00`}, ${"0".repeat(64)}, true)`;
  for (const pid of STAFF) v[pid] = (await loadViewer(pid))!;
});

afterAll(async () => {
  const s = sql();
  const visits = (await s<{ id: string }[]>`select id from visit where machine_id = ${machineId}`).map((r) => r.id);
  await s`select visit_purge(${visits}::uuid[])`;
  await s`delete from tv_vend where external_id like ${`${TAG}-%`}`;
  await s`delete from tv_refill where natural_key like ${`${TAG}-%`}`;
  await s`delete from tv_event where external_id like ${`${TAG}-%`}`;
  await s`delete from tv_sync_run where correlation_id = ${CORR}`;
  if (savedCursor) await s`update tv_sync_cursor set read_until = ${savedCursor} where stream = 'vends'`;
  else await s`delete from tv_sync_cursor where stream = 'vends'`;
  await s`delete from machine_placement where machine_id = ${machineId}`;
  await s`delete from tv_machine_caption where televend_id = any(${[A, B]}::bigint[])`;
  await s`delete from tv_machine where televend_id = any(${[A, B]}::bigint[])`;
  await s`delete from machine where id = ${machineId}`;
  await s`delete from employee where id = any(${STAFF}::uuid[])`;
  await closeDb();
});

describe("one machine's page", () => {
  it("follows the machine across every Televend record it has had", async () => {
    const p = (await machinePage(v[SUP]!, ASSET, NOW))!;
    expect(p.places.map((x) => ({ id: x.televendId, current: x.current, enabled: x.enabled }))).toEqual([
      { id: B, current: true, enabled: true },
      { id: A, current: false, enabled: false },
    ]);
    expect(p).toMatchObject({ category: `${TAG} Metro`, televendRegion: `${TAG} Metro`, corrected: false, emirate: "Dubai", cardOnly: false });
  });

  it("says the cash price (set, else AED 10) and the card price (the AED n in the name)", async () => {
    const p = (await machinePage(v[SUP]!, ASSET, NOW))!;
    expect(p.prices).toEqual({ cashFils: 1000, cashSource: "default", cardFils: 1200, cardSource: "name" });
  });

  it("estimates the cups left from Televend's share, the column's capacity and the columns", async () => {
    const p = (await machinePage(v[SUP]!, ASSET, NOW))!;
    expect(p.stock).toEqual({ percent: 0.25, columns: 1, capacityPerColumn: 63, cupsLeft: 16, negative: false });
    expect(p.status).toMatchObject({ connection: "online", signal: 77, state: "ok" });
    expect(p.status.lastCollectionAt).toBe(new Date(`${TODAY}T08:40:00+04:00`).toISOString());
  });

  it("puts today by hour beside the same weekday a week before — the earlier total only up to the same minute", async () => {
    const p = (await machinePage(v[SUP]!, ASSET, NOW))!;
    expect(p.today.cups).toBe(5);
    expect(p.today.hours[9]).toEqual({ hour: 9, cups: 3, cupsWeekBefore: 4 });
    expect(p.today.hours[11]).toEqual({ hour: 11, cups: 2, cupsWeekBefore: 0 });
    expect(p.today.hours[13]).toEqual({ hour: 13, cups: 0, cupsWeekBefore: 5 });
    expect(p.today.cupsWeekBeforeSameTime).toBe(4);
  });

  it("lists the earlier days beside the same weekday a week before, payments, sales, refills, collections and visits", async () => {
    const p = (await machinePage(v[SUP]!, ASSET, NOW))!;
    expect(p.days).toHaveLength(28);
    expect(p.days.find((d) => d.date === LAST_WEEK)).toMatchObject({ cups: 9 });
    expect(p.days.find((d) => d.date === "2033-07-19")).toEqual({ date: "2033-07-19", cups: 0, weekBefore: 0 });
    // The rolling last 7 days reach back to noon on 13 Jul: that afternoon's 5 card sales count, its morning's 4 cash do not.
    expect(p.payments).toEqual([
      { caption: "Cashless", cups: 7 },
      { caption: "Cash", cups: 2 },
      { caption: "Cashless 3", cups: 1 },
    ]);
    expect(p.recentSales).toHaveLength(14);
    expect(p.recentSales[0]).toMatchObject({ payment: "Cashless", product: "Orange Juice New" });
    expect(p.refills[0]).toMatchObject({ action: "filled", change: 30, after: 63, capacity: 63, by: "Driver Kiran" });
    expect(p.collections[0]).toMatchObject({ at: new Date(`${TODAY}T08:40:00+04:00`).toISOString() });
    // Read as a Supervisor: the collection's time, never Televend's figure (D237).
    expect(p.seesExpectedCash).toBe(false);
    expect(p.collections.every((c) => c.cashVends === null && c.expectedFils === null)).toBe(true);
    expect(p.visits).toEqual([expect.objectContaining({ by: `${TAG} Driver Kiran`, how: "qr", proof: 0 })]);
  });

  it("is for the people who read Televend's data — not the warehouse; an unknown number is not found", async () => {
    await expect(machinePage(v[KEEP]!, ASSET, NOW)).rejects.toThrow(/Operations|machines/);
    expect(await machinePage(v[SUP]!, 99_999, NOW)).toBeNull();
  });
});

describe("a day's refills", () => {
  it("names the machine, who filled, how much and how full after", async () => {
    const r = await refillsOn(v[SUP]!, TODAY, NOW);
    expect(r.filter((x) => x.assetNo === ASSET)).toEqual([
      { at: new Date(`${TODAY}T08:30:00+04:00`).toISOString(), assetNo: ASSET, label: `New Place-${ASSET}-AED12-DXB`, action: "filled", change: 30, after: 63, capacity: 63, by: "Driver Kiran" },
    ]);
    await expect(refillsOn(v[SUP]!, "2033-07-21", NOW)).rejects.toThrow(/not begun/);
  });
});

describe("a day's sales", () => {
  it("pages newest first without a row twice, with the day's totals", async () => {
    const one = await salesList(v[SUP]!, { date: TODAY, machineTvId: B, limit: 3 }, NOW);
    expect(one.rows.map((r) => r.at)).toEqual(["11:15", "11:05", "09:25"].map((t) => new Date(`${TODAY}T${t}:00+04:00`).toISOString()));
    expect(one.next).not.toBeNull();
    const two = await salesList(v[SUP]!, { date: TODAY, machineTvId: B, limit: 3, before: one.next! }, NOW);
    expect(two.rows.map((r) => r.at)).toEqual(["09:15", "09:05"].map((t) => new Date(`${TODAY}T${t}:00+04:00`).toISOString()));
    expect(two.next).toBeNull();
    expect(one.summary).toMatchObject({ cups: 5, machines: 1 });
    expect(one.summary.byHour[9]).toEqual({ hour: 9, cups: 3 });
    expect(one.rows[0]).toMatchObject({ assetNo: ASSET, category: `${TAG} Metro`, payment: "Cashless" });
  });

  it("filters by category and payment, and offers the day's choices", async () => {
    const cash = await salesList(v[SUP]!, { date: TODAY, category: `${TAG} metro`, payment: "Cash" }, NOW);
    expect(cash.rows.filter((r) => r.machineTvId === B).map((r) => r.payment)).toEqual(["Cash", "Cash"]);
    expect(cash.choices.payments).toEqual(expect.arrayContaining(["Cash", "Cashless", "Cashless 3"]));
    expect(cash.choices.categories).toContain(`${TAG} Metro`);
    await expect(salesList(v[SUP]!, { date: TODAY, before: "nonsense" }, NOW)).rejects.toThrow(/page marker/);
    await expect(salesList(v[KEEP]!, { date: TODAY }, NOW)).rejects.toThrow();
  });
});
