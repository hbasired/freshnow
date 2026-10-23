import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getServiceSql } from "./db.js";
import { DEMO_CEO_ID } from "./meta.js";
import { OpsRefused } from "./ops-alarms.js";
import { dayReport, fleetNow, machineDetail } from "./ops-fleet.js";
import { OpsDayRefused } from "./ops-sales.js";
import { loadViewer, type ViewerOrg } from "./org.js";

/**
 * The fleet, one machine, a day's report (TASK-059) — real Postgres, clock fixed on Tue 21 Nov 2023,
 * 15:00 Dubai. Every number is counted by hand from the rows below.
 *
 *   611 "Fleet Test-611-DXB"  OK, cash price AED 15 (set on the machine)
 *       collections: Mon 20:00, Tue 10:30
 *       vends Tue: 08:00 cash · 09:00 card · 10:00 cash · 11:00 cash · 12:00 token  → 5 cups, 3 cash
 *       → the 10:30 collection should have found 2 cash vends = AED 30; 1 cash vend (AED 15) waits since
 *       refilled Tue 09:30
 *   612 offline (connection 0) · 613 Televend warning (status 2) · 614 "Bill / Cash Box Full" open since 13:00
 */
const NOW = new Date("2023-11-21T15:00:00+04:00");
const at = (iso: string) => new Date(`${iso}+04:00`);
const TAG = `FLEET-${randomUUID().slice(0, 6)}`;
const SUP = randomUUID();
const OPS = randomUUID();
const VMO = randomUUID();
const IDS = { ok: 990611, offline: 990612, warning: 990613, alarm: 990614 };
let machineId = "";
let sup: ViewerOrg;
let ops: ViewerOrg;
let vmo: ViewerOrg;
const sql = () => getServiceSql();
let n = 0;

async function vend(machine: number, iso: string, paymentType: number) {
  await sql()`insert into tv_vend (source, external_id, machine_tv_id, at, payment_type, quantity, raw, is_synthetic)
              values ('bridge', ${`${TAG}-v${n++}`}, ${machine}, ${at(iso)}, ${paymentType}, 1, '{}'::jsonb, true)`;
}
async function event(machine: number, name: string, kind: string, iso: string) {
  await sql()`insert into tv_event (source, external_id, machine_tv_id, level, kind, name, started_at, raw, is_synthetic)
              values ('bridge', ${`${TAG}-e${n++}`}, ${machine}, ${kind === "info" ? 1 : 3}, ${kind}, ${name}, ${at(iso)}, '{}'::jsonb, true)`;
}

beforeAll(async () => {
  const s = sql();
  await s`insert into employee (id, display_name, status, is_synthetic, access_role, manager_employee_id)
          values (${SUP}, ${`${TAG} Sup`}, 'active', true, 'supervisor', ${DEMO_CEO_ID}),
                 (${OPS}, ${`${TAG} Ops`}, 'active', true, 'ops_head', ${DEMO_CEO_ID}),
                 (${VMO}, ${`${TAG} Vmo`}, 'active', true, 'vmo', ${DEMO_CEO_ID})`;
  sup = (await loadViewer(SUP))!;
  ops = (await loadViewer(OPS))!;
  vmo = (await loadViewer(VMO))!;
  const machines: [number, string, number, number][] = [
    [IDS.ok, "Fleet Test-611-DXB", 1, 1],
    [IDS.offline, "Fleet Test-612-SHJ", 1, 0],
    [IDS.warning, "Fleet Test-613-AJM", 2, 1],
    [IDS.alarm, "Fleet Test-614-DXB", 3, 1],
  ];
  for (const [id, caption, status, connection] of machines) {
    await s`insert into tv_machine (televend_id, caption, asset_no, enabled, region_caption, last_status, connection_status, raw, is_synthetic)
            values (${id}, ${caption}, ${id - 990000}, true, 'Metro', ${status}, ${connection}, '{}'::jsonb, true)`;
  }
  const [m] = await s<{ id: string }[]>`
    insert into machine (asset_no, label, cash_price_fils, is_synthetic) values (611, 'Fleet Test-611-DXB', 1500, true) returning id`;
  machineId = m!.id;
  await s`insert into machine_placement (machine_id, tv_machine_id, source, is_synthetic) values (${machineId}, ${IDS.ok}, 'manual', true)`;
  await event(IDS.ok, "Cash Collection", "info", "2023-11-20T20:00:00");
  await event(IDS.ok, "Cash Collection", "info", "2023-11-21T10:30:00");
  await vend(IDS.ok, "2023-11-21T08:00:00", 0);
  await vend(IDS.ok, "2023-11-21T09:00:00", 1);
  await vend(IDS.ok, "2023-11-21T10:00:00", 0);
  await vend(IDS.ok, "2023-11-21T11:00:00", 0);
  await vend(IDS.ok, "2023-11-21T12:00:00", 7);
  await s`insert into tv_refill (source, natural_key, machine_tv_id, at, filled_by, action, quantity_change, origin, raw, is_synthetic)
          values ('bridge', ${`${TAG}-r1`}, ${IDS.ok}, ${at("2023-11-21T09:30:00")}, 'Test Filler', 'filled', 60, 'mobile_app', '{}'::jsonb, true)`;
  await event(IDS.alarm, "Bill / Cash Box Full", "alarm", "2023-11-21T13:00:00");
});

afterAll(async () => {
  const s = sql();
  await s`delete from tv_vend where external_id like ${`${TAG}-%`}`;
  await s`delete from tv_event where external_id like ${`${TAG}-%`}`;
  await s`delete from tv_refill where natural_key like ${`${TAG}-%`}`;
  await s`delete from machine_placement where machine_id = ${machineId}`;
  await s`delete from machine where id = ${machineId}`;
  await s`delete from tv_machine where televend_id = any(${Object.values(IDS)})`;
  await s`delete from employee where id in (${SUP}, ${OPS}, ${VMO})`;
  await closeDb();
});

describe("the fleet now", () => {
  it("each machine's state, today's cups, its last collection and the cash waiting since — at its own price", async () => {
    const f = await fleetNow(ops, NOW);
    const of = (id: number) => f.machines.find((m) => m.machineTvId === id)!;
    expect(of(IDS.ok)).toMatchObject({
      assetNo: 611,
      label: "Fleet Test-611-DXB",
      region: "Metro",
      emirate: "Dubai",
      state: "ok",
      cupsToday: 5,
      cashCupsToday: 3,
      lastCashAt: at("2023-11-21T10:30:00").toISOString(),
      cashWaitingFils: 1500,
    });
    expect(of(IDS.offline)).toMatchObject({ state: "offline", emirate: "Sharjah", cashWaitingFils: null });
    expect(of(IDS.warning)).toMatchObject({ state: "warning", emirate: "Ajman" });
    expect(of(IDS.alarm).state).toBe("needs_action");
    expect(of(IDS.alarm).problems.map((p) => p.alarm)).toEqual(["Bill / Cash Box Full"]);
    expect(f.cashCollectionsToday).toBeGreaterThanOrEqual(1);
    expect(f.refillsToday).toBeGreaterThanOrEqual(1);
  });

  it("is for the people who run the machines", async () => {
    await expect(fleetNow(vmo, NOW)).rejects.toBeInstanceOf(OpsRefused);
  });

  it("never gives a Supervisor — who handles cash but does not see all of it — Televend's expected cash (D237, review 20 Oct)", async () => {
    const f = await fleetNow(sup, NOW);
    expect(f.seesExpectedCash).toBe(false);
    expect(f.cashWaitingFils).toBeNull();
    expect(f.machines.every((m) => m.cashWaitingFils === null)).toBe(true);
    // The rest of the fleet is the same as the Ops Head's.
    expect(f.machines.find((m) => m.machineTvId === IDS.ok)).toMatchObject({ cupsToday: 5, lastCashAt: at("2023-11-21T10:30:00").toISOString() });
    expect((await fleetNow(ops, NOW)).seesExpectedCash).toBe(true);
    const d = (await machineDetail(sup, 611, NOW))!;
    expect(d.collections[0]).toEqual({ at: at("2023-11-21T10:30:00").toISOString(), previousAt: at("2023-11-20T20:00:00").toISOString(), cashVends: null, expectedFils: null });
    const r = await dayReport(sup, "2023-11-21", NOW);
    expect(r.seesExpectedCash).toBe(false);
    expect(r.totals.expectedCashFils).toBeNull();
    expect(r.machines.find((m) => m.assetNo === 611)!.collections).toEqual([{ at: at("2023-11-21T10:30:00").toISOString(), cashVends: null, expectedFils: null }]);
  });
});

describe("one machine", () => {
  it("today by hour, each collection with the cash it should have found, the refills", async () => {
    const d = (await machineDetail(ops, 611, NOW))!;
    expect(d).toMatchObject({ assetNo: 611, label: "Fleet Test-611-DXB", priceFils: 1500 });
    expect(d.hourlyToday.slice(8, 13)).toEqual([1, 1, 1, 1, 1]);
    expect(d.hourlyToday.reduce((a, b) => a + b, 0)).toBe(5);
    // Newest first: the 10:30 collection found the 08:00 and 10:00 cash vends — not the card, not 11:00's.
    expect(d.collections[0]).toMatchObject({
      at: at("2023-11-21T10:30:00").toISOString(),
      previousAt: at("2023-11-20T20:00:00").toISOString(),
      cashVends: 2,
      expectedFils: 3000,
    });
    expect(d.collections[1]).toMatchObject({ at: at("2023-11-20T20:00:00").toISOString(), previousAt: null, cashVends: 0 });
    expect(d.refills).toEqual([{ at: at("2023-11-21T09:30:00").toISOString(), action: "filled", quantity: 60, product: null, by: "Test Filler" }]);
    expect(await machineDetail(sup, 98765, NOW)).toBeNull();
  });
});

describe("a day's report", () => {
  it("cups by payment, each collection with the cash it should have found, refills, alarms", async () => {
    const r = await dayReport(ops, "2023-11-21", NOW);
    const ok = r.machines.find((m) => m.assetNo === 611)!;
    expect(ok).toMatchObject({ cups: 5, cashCups: 3, cardCups: 1, otherCups: 1, refills: 1, alarmsNeedingSomeone: 0 });
    expect(ok.collections).toEqual([{ at: at("2023-11-21T10:30:00").toISOString(), cashVends: 2, expectedFils: 3000 }]);
    expect(r.machines.find((m) => m.assetNo === 614)).toMatchObject({ alarmsNeedingSomeone: 1, cups: 0 });
    expect(r.totals.expectedCashFils).toBeGreaterThanOrEqual(3000);
  });

  it("counts alarms by what happened, not by their rule: a 'blip' that lasted hours needed someone (review 2026-10-17, command-centre#6)", async () => {
    // 613: "Vending Machine Inhibited" (a noise rule, 30-minute wait) stopped the machine 08:00–11:00;
    // "Banknote acceptor" (actionable, 15-minute wait) cleared itself in 5 minutes.
    await sql()`insert into tv_event (source, external_id, machine_tv_id, level, kind, name, started_at, resolved_at, raw, is_synthetic) values
                ('bridge', ${`${TAG}-inh`}, ${IDS.warning}, 3, 'alarm', 'Vending Machine Inhibited', ${at("2023-11-21T08:00:00")}, ${at("2023-11-21T11:00:00")}, '{}'::jsonb, true),
                ('bridge', ${`${TAG}-bna`}, ${IDS.warning}, 3, 'alarm', 'Banknote acceptor', ${at("2023-11-21T09:00:00")}, ${at("2023-11-21T09:05:00")}, '{}'::jsonb, true)`;
    const r = await dayReport(sup, "2023-11-21", NOW);
    expect(r.machines.find((m) => m.assetNo === 613)).toMatchObject({ alarmsNeedingSomeone: 1, alarmsClearedThemselves: 1 });
  });

  it("counts an alarm from late in the day that is still open when the report is made as one that needed someone (review 20 Oct, 059-fixes#1)", async () => {
    // 612 (offline): an alarm nobody has classified (30-minute wait) from 23:45, still open the next morning at 08:00.
    await event(IDS.offline, `${TAG} late alarm`, "alarm", "2023-11-21T23:45:00");
    const morning = await dayReport(ops, "2023-11-21", at("2023-11-22T08:00:00"));
    expect(morning.machines.find((m) => m.assetNo === 612)).toMatchObject({ alarmsNeedingSomeone: 1, alarmsClearedThemselves: 0 });
  });

  it("refuses a day that is not a date or has not begun, and anyone who does not run the machines", async () => {
    await expect(dayReport(sup, "21/11/2023", NOW)).rejects.toBeInstanceOf(OpsDayRefused);
    await expect(dayReport(sup, "2023-11-22", NOW)).rejects.toBeInstanceOf(OpsDayRefused);
    await expect(dayReport(vmo, "2023-11-21", NOW)).rejects.toBeInstanceOf(OpsRefused);
  });
});
