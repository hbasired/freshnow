import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { categoryChoices, checkRange, insightsOf, machineDaily, machinePerformance, setMachineCategory, standing, type MachinePerf, type Performance } from "./analytics.js";
import { buildSalesDay } from "./analytics-store.js";
import { exportPersonData } from "./compliance-evidence.js";
import { closeDb, getServiceSql } from "./db.js";
import { DEMO_CEO_ID } from "./meta.js";
import { loadViewer, type ViewerOrg } from "./org.js";
import { eraseEmployee, retentionSweep } from "./retention.js";

/**
 * Machine performance and categories (TASK-070), against real Postgres. What must hold — from the user's words and
 * answers (REQ-2026-10-19 R8.2–8.4, D248), not from reading the code:
 *   - three tiers against the fleet average of cups per machine per day (≥ 125 % top, < 75 % below), "no sales" apart;
 *   - the average is over the machines that sold; a machine "Not counted" is out of every figure;
 *   - only days the store holds count — read to their end AND checked against Televend's own count; a day not read is
 *     not a day of zero sales, and a day whose count disagrees is not read;
 *   - the period before is the same days of the week, whole weeks earlier, and a change compares only days read on
 *     both sides (review, 20 Oct);
 *   - income = cash cups × the cash price (set, else AED 10) + the other paid cups × the "AED12" in the name (else the
 *     cash price); token cups are not paid;
 *   - a machine is FreshNow's machine, whatever Televend records it had; one switched off since counts in "before";
 *   - each machine's days sit beside the same weekday a week before; categories add up their machines;
 *   - the sentences state only numbers from the figures, and say what to do.
 *
 * The fixture, worked out by hand (period 8–14 Mar 2032, 10 Mar NOT read — an incremental read covers it and its whole-day
 * count disagrees with Televend's; before: 1–7 Mar, all read, so 3 Mar has no partner and is never compared):
 *   A Metro    20/day (5 cash), before 10/day (5 cash), +100 card on 3 Mar  → 120 cups, top
 *   B Metro    10/day card,     before 10/day all cash       →  60, average
 *   C Hospital  4/day (1 cash), AED15, before 12/day         →  24, below, a sharp drop
 *   D Hospital  6/day (1 token), card only, AED12, before 6  →  36, below
 *   E Events    nothing,        before 5/day                 →   0, no sales
 *   F Events   50/day — corrected to "Not counted"           →  out of the figures
 *   G Hospital  2/day, disabled in Televend now              →  12, below
 *   I Kiosk    switched off since 8 Mar; before 7/day        →   0 now, in "before" only
 *   H, J, K, L "Not counted": H re-registered (three Televend records, one machine); J tiny, its name "Al Raed 2" names
 *     no price; K's Televend record moved to L on 11 Mar.
 *   Counted now: 252 cups over 6 read days by 5 selling machines → 8.4 cups per machine per day (the level). Compared
 *   on the 6 pairs (8↔1, 9↔2, 11↔4 … 14↔7): 42 a day against (10+10+12+6+5+7) = 50 a day → −16 % (the change, on volume,
 *   I's cups included). Hospital: 12 a day against 18 → −33.3 %, although its per-machine level fell from 9 to 4.
 */

const TAG = `AN-${randomUUID().slice(0, 6)}`;
const OPS = randomUUID(); // ops head: reads, and corrects categories
const SUP = randomUUID(); // supervisor: reads, may not correct
const KEEP = randomUUID(); // warehouse keeper: may not read
const STAFF = [OPS, SUP, KEEP];
const CORR = randomUUID();
const NOW = new Date("2032-03-15T10:00:00+04:00");
const RANGE = { from: "2032-03-08", to: "2032-03-14" };
const CAT = { metro: `${TAG} Metro`, hospital: `${TAG} Hospital / Clinics`, events: `${TAG} Events` };
const CAT2 = { kiosk: `${TAG} Kiosk`, lab: `${TAG} Lab` };
const TV = {
  A: 993_001, B: 993_002, C: 993_003, D: 993_004, E: 993_005, F: 993_006, G: 993_007,
  H0: 993_010, H1: 993_011, H2: 993_012, I: 993_013, J: 993_014, K1: 993_015, N: 993_016,
} as const;
const ASSET = { A: 99_301, B: 99_302, C: 99_303, D: 99_304, E: 99_305, F: 99_306, G: 99_307, H: 99_308, I: 99_309, J: 99_310, K: 99_311, L: 99_312 } as const;
const machineOf: Record<string, string> = {};
const machineIds: string[] = [];
const v: Record<string, ViewerOrg> = {};
const sql = () => getServiceSql();
let perf: Performance;

const day = (d: string, minute: number) => new Date(`${d}T10:${String(minute % 60).padStart(2, "0")}:00+04:00`);
const dates = (from: string, n: number) => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));

beforeAll(async () => {
  const s = sql();
  for (const [pid, name, role] of [
    [OPS, "Ops", "ops_head"],
    [SUP, "Sup", "supervisor"],
    [KEEP, "Keeper", "warehouse_keeper"],
  ] as const) {
    await s`insert into employee (id, display_name, status, is_synthetic, access_role, manager_employee_id)
            values (${pid}, ${`${TAG} ${name}`}, 'active', true, ${role}, ${DEMO_CEO_ID})`;
  }
  const machines: [keyof typeof TV, string, string, boolean][] = [
    ["A", `Metro A-${ASSET.A}-c3 only-DXB`, CAT.metro, true],
    ["B", `Metro B-${ASSET.B}-Cashless 3 Only-DXB`, CAT.metro, true],
    ["C", `NMC C-AED15-${ASSET.C}-Cashless 1-DXB`, CAT.hospital, true],
    ["D", `Expo D-${ASSET.D}-Card only-AED12-SHJ`, CAT.hospital, true],
    ["E", `Expo E-${ASSET.E}-SHJ`, CAT.events, true],
    ["F", `WAREHOUSE F-${ASSET.F}-DXB`, CAT.events, true],
    ["G", `Clinic G-${ASSET.G}-DXB`, CAT.hospital, false],
  ];
  for (const [k, caption, region, enabled] of machines) {
    await s`insert into tv_machine (televend_id, caption, asset_no, enabled, region_caption, last_status, connection_status, raw, is_synthetic)
            values (${TV[k]}, ${caption}, ${(ASSET as Record<string, number>)[k]!}, ${enabled}, ${region}, 1, 1, '{}'::jsonb, true)`;
    const [m] = await s<{ id: string }[]>`insert into machine (asset_no, label, is_synthetic) values (${(ASSET as Record<string, number>)[k]!}, ${caption}, true) returning id`;
    machineIds.push(m!.id);
    machineOf[k] = m!.id;
    await s`insert into machine_placement (machine_id, tv_machine_id, source, is_synthetic) values (${m!.id}, ${TV[k]}, 'manual', true)`;
  }
  // F is a test machine: out of the figures.
  await s`update machine set category_override = 'Not counted' where asset_no = ${ASSET.F}`;
  const tv = async (id: number, caption: string, asset: number | null, enabled: boolean, region: string) =>
    s`insert into tv_machine (televend_id, caption, asset_no, enabled, region_caption, last_status, connection_status, raw, is_synthetic)
      values (${id}, ${caption}, ${asset}, ${enabled}, ${region}, 1, 1, '{}'::jsonb, true)`;
  const machine = async (k: string, asset: number, label: string, override: string | null) => {
    const [m] = await s<{ id: string }[]>`insert into machine (asset_no, label, category_override, is_synthetic) values (${asset}, ${label}, ${override}, true) returning id`;
    machineIds.push(m!.id);
    machineOf[k] = m!.id;
    return m!.id;
  };
  const place = (machineId: string, tvId: number, from: string, to: string | null) =>
    s`insert into machine_placement (machine_id, tv_machine_id, valid_from, valid_to, source, is_synthetic) values (${machineId}, ${tvId}, ${from}, ${to}, 'manual', true)`;
  // H, re-registered: an old record never placed (found by its number), one switched off, and the live one.
  const H = await machine("H", ASSET.H, `Mall H-${ASSET.H}-DXB`, "Not counted");
  await tv(TV.H0, `Mall H-${ASSET.H}-DXB`, ASSET.H, false, CAT.metro);
  await tv(TV.H1, `Mall H-${ASSET.H}-DXB`, ASSET.H, false, CAT.metro);
  await tv(TV.H2, `Mall H-${ASSET.H}-DXB`, ASSET.H, true, CAT.metro);
  await place(H, TV.H1, "2032-02-01T00:00:00+04:00", "2032-03-05T12:00:00+04:00");
  await place(H, TV.H2, "2032-03-05T12:00:00+04:00", null);
  // I, switched off on 8 Mar: its placement closed, as the sync does.
  const I = await machine("I", ASSET.I, `Kiosk I-${ASSET.I}-DXB`, null);
  await tv(TV.I, `Kiosk I-${ASSET.I}-DXB`, ASSET.I, false, CAT2.kiosk);
  await place(I, TV.I, "2032-02-01T00:00:00+04:00", "2032-03-08T00:00:00+04:00");
  // J: tiny, not counted; "Al Raed 2" in its name is not a price.
  const J = await machine("J", ASSET.J, `Al Raed 2 Tower-${ASSET.J}-DXB`, "Not counted");
  await tv(TV.J, `Al Raed 2 Tower-${ASSET.J}-DXB`, ASSET.J, true, CAT.metro);
  await place(J, TV.J, "2032-02-01T00:00:00+04:00", null);
  // K's Televend record moved to L at midnight on 11 Mar.
  const K = await machine("K", ASSET.K, `Old K-${ASSET.K}-DXB`, "Not counted");
  const L = await machine("L", ASSET.L, `New L-${ASSET.L}-DXB`, "Not counted");
  await tv(TV.K1, `New L-${ASSET.L}-DXB`, ASSET.L, true, CAT.metro);
  await place(K, TV.K1, "2032-02-01T00:00:00+04:00", "2032-03-11T00:00:00+04:00");
  await place(L, TV.K1, "2032-03-11T00:00:00+04:00", null);
  // N: a live record with no number, so no FreshNow machine yet.
  await tv(TV.N, `${TAG} Oranfresh-ITALY`, null, true, CAT2.lab);

  // Sales: [machine, payment type, cups a day] for each day of a span. 10 Mar has sales too — they must not count.
  const vends: { source: string; external_id: string; machine_tv_id: number; at: Date; payment_type: number; quantity: number; raw: string; is_synthetic: boolean }[] = [];
  let n = 0;
  const sell = (k: keyof typeof TV, days: string[], type: number, perDay: number) => {
    if (perDay === 0) return;
    for (const d of days) for (let i = 0; i < perDay; i++) vends.push({ source: "bridge", external_id: `${TAG}-${n++}`, machine_tv_id: TV[k], at: day(d, i), payment_type: type, quantity: 1, raw: "{}", is_synthetic: true });
  };
  const now7 = dates("2032-03-08", 7); // includes 10 Mar
  const before7 = dates("2032-03-01", 7);
  sell("A", now7, 0, 5); sell("A", now7, 3, 15); sell("A", before7, 0, 5); sell("A", before7, 1, 5);
  sell("A", ["2032-03-03"], 1, 100); // a spike on the one day before with no partner: never compared
  sell("B", now7, 1, 10); sell("B", before7, 0, 10);
  sell("C", now7, 0, 1); sell("C", now7, 1, 3); sell("C", before7, 1, 12);
  sell("D", now7, 7, 1); sell("D", now7, 1, 5); sell("D", before7, 1, 6);
  sell("E", before7, 1, 5);
  sell("F", now7, 1, 50);
  sell("G", now7, 1, 2);
  sell("I", before7, 1, 7);
  sell("H0", ["2032-03-01"], 1, 2); sell("H1", ["2032-03-02", "2032-03-03", "2032-03-04"], 1, 3); sell("H2", now7, 1, 4);
  sell("J", ["2032-03-08", "2032-03-09"], 1, 1); sell("J", ["2032-03-01"], 1, 1);
  sell("K1", [...before7, ...now7], 1, 3);
  for (let i = 0; i < vends.length; i += 500) {
    await s`insert into tv_vend ${s(vends.slice(i, i + 500).map((x) => ({ ...x, raw: s.json({}) })) as never, "source", "external_id", "machine_tv_id", "at", "payment_type", "quantity", "raw", "is_synthetic")}`;
  }
  // Each day read whole and checked against Televend's own count (a backfill), then built into the store. 10 Mar: an
  // incremental read covers it (that never counted), and its whole-day read found Televend counting more — not read.
  const runFor = async (d: string, extra: number) =>
    s`insert into tv_sync_run (stream, mode, transport, window_from, window_to, status, complete, televend_count, correlation_id, finished_at)
      select 'vends', 'backfill', 'bridge', ${`${d}T00:00:00+04:00`}::timestamptz, ${`${d}T00:00:00+04:00`}::timestamptz + interval '1 day', 'ok', true,
             count(*)::int + ${extra}, ${CORR}, now()
        from tv_vend where at >= ${`${d}T00:00:00+04:00`}::timestamptz and at < ${`${d}T00:00:00+04:00`}::timestamptz + interval '1 day'`;
  for (const d of [...before7, ...now7]) {
    await runFor(d, d === "2032-03-10" ? 5 : 0);
    await buildSalesDay(d, { correlationId: CORR, isSynthetic: true });
  }
  await s`insert into tv_sync_run (stream, mode, transport, window_from, window_to, status, complete, correlation_id, finished_at)
          values ('vends', 'incremental', 'bridge', '2032-03-09T23:00:00+04:00', '2032-03-11T01:00:00+04:00', 'ok', true, ${CORR}, now())`;
  for (const pid of STAFF) v[pid] = (await loadViewer(pid))!;
  perf = await machinePerformance(v[OPS]!, RANGE, NOW);
});

afterAll(async () => {
  const s = sql();
  await s`delete from sales_hour where run_id in (select id from analytics_run where correlation_id = ${CORR})`;
  await s`delete from sales_day where run_id in (select id from analytics_run where correlation_id = ${CORR})`;
  await s`delete from analytics_run where correlation_id = ${CORR}`;
  await s`delete from tv_vend where external_id like ${`${TAG}-%`}`;
  await s`delete from tv_sync_run where correlation_id = ${CORR}`;
  const made = (await s<{ id: string }[]>`select machine_id as id from machine_placement where tv_machine_id = any(${Object.values(TV)}::bigint[])`).map((r) => r.id);
  await s`delete from machine_placement where tv_machine_id = any(${Object.values(TV)}::bigint[])`;
  await s`delete from tv_machine where televend_id = any(${Object.values(TV)}::bigint[])`;
  await s`delete from audit_log where entity = 'machine' and entity_id = any(${[...machineIds, ...made]})`;
  await s`delete from machine where id = any(${[...new Set([...machineIds, ...made])]}::uuid[])`;
  await s`delete from employee where id = any(${STAFF}::uuid[])`;
  await closeDb();
});

const mine = (k: keyof typeof TV) => perf.machines.find((m) => m.machineTvId === TV[k])!;
const machine = (k: string, p: Performance = perf) => p.machines.find((m) => m.machineId === machineOf[k])!;

describe("the range", () => {
  it("is whole days up to yesterday, the earlier first, at most 92 — and is compared with the same weekdays", () => {
    expect(checkRange({ from: "2032-03-14", to: "2032-03-14" }, NOW)).toMatchObject({ days: 1, shiftDays: 7 });
    expect(checkRange({ from: "2032-03-05", to: "2032-03-14" }, NOW)).toMatchObject({ days: 10, shiftDays: 14 });
    expect(() => checkRange({ from: "2032-03-15", to: "2032-03-15" }, NOW)).toThrow(/up to yesterday/);
    expect(() => checkRange({ from: "2032-03-14", to: "2032-03-08" }, NOW)).toThrow(/comes before/);
    expect(() => checkRange({ from: "2031-12-01", to: "2032-03-14" }, NOW)).toThrow(/At most 92/);
    expect(() => checkRange({ from: "14-03-2032", to: "2032-03-14" }, NOW)).toThrow(/YYYY-MM-DD/);
    // A day that does not exist is refused, not rolled over into 1 Mar (review, 20 Oct).
    expect(() => checkRange({ from: "2031-02-29", to: "2031-03-05" }, NOW)).toThrow(/YYYY-MM-DD/);
    expect(() => checkRange({ from: "2032-02-30", to: "2032-03-05" }, NOW)).toThrow(/YYYY-MM-DD/);
    // …and one that does not parse at all is refused in words too, never an error 500.
    for (const bad of ["2031-13-01", "2031-02-32", "2031-01-00"]) expect(() => checkRange({ from: bad, to: "2031-03-05" }, NOW)).toThrow(/YYYY-MM-DD/);
  });

  it("puts a machine exactly at 125 % in 'top' and shows 125 %; a hair under is 'average' at 124 %; exactly 75 % is not 'below'", () => {
    // 83 machines sold 10,624 cups: 160 cups is exactly 125 % of the average, 96 exactly 75 %.
    expect(standing(160, 83, 10_624)).toEqual({ vsAverage: 1.25, tier: "top" });
    expect(standing(159, 83, 10_624)).toEqual({ vsAverage: 1.24, tier: "average" });
    expect(standing(96, 83, 10_624)).toEqual({ vsAverage: 0.75, tier: "average" });
    expect(standing(95, 83, 10_624)).toEqual({ vsAverage: 0.74, tier: "below" });
  });
});

describe("machines against the fleet average", () => {
  it("counts only the days the store holds checked: 10 Mar — read by an incremental run, its count disagreeing — is not counted", () => {
    expect(perf.coverage.notRead).toEqual(["2032-03-10"]);
    expect(perf.coverage.read).toHaveLength(6);
    expect(perf.coverage.beforeRead).toHaveLength(7);
    // 3 Mar's partner, 10 Mar, was not read: the changes compare the other six days.
    expect(perf.coverage.compared).toEqual(["2032-03-08", "2032-03-09", "2032-03-11", "2032-03-12", "2032-03-13", "2032-03-14"]);
    expect(perf.before).toMatchObject({ from: "2032-03-01", to: "2032-03-07", shiftDays: 7 });
    expect(mine("A")).toMatchObject({ cups: 120, cupsPerDay: 20, cashCups: 30, cashShare: 25 });
  });

  it("averages the machines that sold — 8.4 cups each a day — and sorts them into the three tiers", () => {
    expect(perf.fleet).toMatchObject({ selling: 5, cups: 252, cupsPerMachineDay: 8.4 });
    expect(mine("A")).toMatchObject({ tier: "top", vsAverage: 2.38 });
    expect(mine("B")).toMatchObject({ tier: "average", vsAverage: 1.19 });
    expect(mine("C").tier).toBe("below");
    expect(mine("D")).toMatchObject({ tier: "below", vsAverage: 0.71 });
    expect(mine("G")).toMatchObject({ tier: "below", disabledNow: true });
    expect(mine("E")).toMatchObject({ tier: "no_sales", cups: 0 });
    expect(perf.fleet.tiers.top).toEqual({ machines: 1, cupsShare: 47.6 });
    expect(perf.fleet.tiers.average).toEqual({ machines: 1, cupsShare: 23.8 });
    expect(perf.fleet.tiers.below).toEqual({ machines: 3, cupsShare: 28.6 });
    // The ranks and the tier lines come from the server; a % shown never crosses its tier's line.
    expect(["A", "B", "D", "C", "G"].map((k) => mine(k as keyof typeof TV).rank)).toEqual([1, 2, 3, 4, 5]);
    expect(perf.fleet.thresholds!.top).toBeCloseTo(10.5);
    expect(perf.fleet.thresholds!.below).toBeCloseTo(6.3);
  });

  it("keeps a machine 'Not counted' out of every figure", () => {
    expect(mine("F")).toMatchObject({ counted: false, tier: null, cups: 300 });
    expect(perf.categories.some((c) => c.category === "Not counted")).toBe(false);
  });

  it("names the fewest machines that made 80 % of the cups: A, B and D", () => {
    expect(perf.fleet.top80).toBe(3);
    expect(["A", "B", "D"].every((k) => mine(k as keyof typeof TV).inTop80)).toBe(true);
    expect(mine("C").inTop80).toBe(false);
  });

  it("estimates income: cash at the cash price (set, or AED 10), card at the name's price (A-T70.3) — and token sales not at all", () => {
    expect(mine("A")).toMatchObject({ prices: { cashFils: 1000, cashSource: "default", cardFils: 1000, cardSource: "cash" }, incomeFils: 120_000 });
    // C: 6 cash cups at AED 10 and 18 card cups at the AED 15 in its name.
    expect(mine("C")).toMatchObject({ prices: { cashFils: 1000, cardFils: 1500, cardSource: "name" }, cashCups: 6, incomeFils: 33_000 });
    expect(mine("D")).toMatchObject({ prices: { cardFils: 1200, cardSource: "name" }, tokenCups: 6, incomeFils: 36_000, cardOnly: true });
    expect(mine("A").cardOnly).toBe(false);
    // "Al Raed 2 Tower" names no price: a whole word "AED" only (review, 20 Oct).
    expect(machine("J").prices).toMatchObject({ cardFils: 1000, cardSource: "cash" });
    expect(perf.fleet.incomeFils).toBe(261_000);
  });

  it("compares with the same weekdays before, day for day — 3 Mar's spike has no partner and changes nothing", () => {
    // Unpaired, A's "before" would be 170 ÷ 7 = 24.3 a day and its change −17.6 %.
    expect(mine("A")).toMatchObject({ compare: { days: 6, now: 20, before: 10, changePct: 100 }, changePct: 100 });
    expect(mine("C")).toMatchObject({ before: { cupsPerDay: 12 }, changePct: -66.7 });
    expect(mine("G").changePct).toBeNull(); // sold nothing before: no % change
    expect(perf.fleet).toMatchObject({ cupsPerDay: 42, before: { cupsPerDay: 50, cupsPerMachineDay: 8.3 } });
    expect(perf.fleet.compare).toEqual({ days: 6, now: 42, before: 50, changePct: -16 });
    expect(perf.fleet.cashShare).toBe(14.3);
    expect(perf.fleet.cashCompare).toEqual({ now: 14.3, before: 30, move: -15.7 });
    expect(perf.fleet.cashShareMove).toBe(-15.7);
  });

  it("works a change out from the totals, never from rounded rates: 2 cups against 1 is +100 %, not +200 %", () => {
    expect(machine("J")).toMatchObject({ counted: false, cups: 2, compare: { days: 6, changePct: 100 } });
  });

  it("keeps a machine switched off since in 'before' — and says so (review, 20 Oct)", () => {
    expect(machine("I")).toMatchObject({ counted: true, disabledNow: true, cups: 0, tier: null, before: { cups: 42 } });
    const off = perf.insights.find((i) => i.id === "switched_off")!;
    expect(off.text).toBe(
      `1 machine that sold on the days before is switched off in Televend now: Kiosk I-${ASSET.I}-DXB (${ASSET.I}). Its cups count in the figures before, so the change includes it.`,
    );
  });

  it("is FreshNow's machine, whatever Televend records it had: H once with all its sales; K's record moved to L at midnight", () => {
    const hs = perf.machines.filter((m) => m.assetNo === ASSET.H);
    expect(hs).toHaveLength(1);
    // Now: H2's 4 a day on the 6 days read. Before, compared: H0's 2 on 1 Mar, H1's 3 on 2 and 4 Mar (3 Mar has no partner).
    expect(hs[0]).toMatchObject({ machineId: machineOf.H, machineTvId: TV.H2, counted: false, cups: 24, before: { cups: 8 } });
    expect(machine("K")).toMatchObject({ cups: 6, before: { cups: 18 }, machineTvId: TV.K1 });
    expect(machine("L")).toMatchObject({ cups: 12, before: { cups: 0 }, machineTvId: TV.K1 });
    expect(machine("K").key).not.toBe(machine("L").key);
  });
});

describe("categories", () => {
  it("adds up each category's machines, per machine per day, best first", () => {
    const mine3 = perf.categories.filter((c) => c.category.startsWith(TAG));
    expect(mine3.map((c) => c.category)).toEqual([CAT.metro, CAT.hospital, CAT.events, CAT2.kiosk, CAT2.lab]);
    expect(mine3[0]).toMatchObject({ machines: 2, selling: 2, cups: 180, cupsPerDay: 30, cupsPerMachineDay: 15, share: 71.4, changePct: 50 });
    expect(mine3[0]!.best).toMatchObject({ assetNo: ASSET.A, cupsPerDay: 20 });
    expect(mine3[0]!.weakest).toMatchObject({ assetNo: ASSET.B, cupsPerDay: 10 });
    expect(mine3[1]).toMatchObject({ machines: 3, selling: 3, cups: 72, cupsPerDay: 12, cupsPerMachineDay: 4, before: { cupsPerDay: 18, cupsPerMachineDay: 9 }, changePct: -33.3 });
    // Events sold 5 cups a day before and none now: its volume fell 100 %; with no machine selling, it has no level.
    expect(mine3[2]).toMatchObject({ machines: 1, selling: 0, noSales: 1, cupsPerMachineDay: null, cupsPerDay: 0, before: { cupsPerDay: 5 }, changePct: -100 });
    // Kiosk's one machine is switched off: no machine in the period, its cups before still count.
    expect(mine3[3]).toMatchObject({ machines: 0, selling: 0, cups: 0, before: { cupsPerDay: 7 }, changePct: -100 });
  });

  it("draws each day per machine that sold beside the same weekday before — and nothing for the day not read", () => {
    const metro = perf.categories.find((c) => c.category === CAT.metro)!;
    expect(metro.daily).toHaveLength(7);
    expect(metro.daily[0]).toEqual({ date: "2032-03-08", cupsPerMachine: 15, before: 10 });
    // 3 Mar is drawn, spike and all — it only takes no part in the change.
    expect(metro.daily[2]).toEqual({ date: "2032-03-10", cupsPerMachine: null, before: 60 });
    // Divided by the machines that sold, as the headline is: Events sold nothing, so it draws nothing.
    expect(perf.categories.find((c) => c.category === CAT.events)!.daily.every((d) => d.cupsPerMachine === null && d.before === null)).toBe(true);
  });
});

describe("what the figures say", () => {
  const find = (id: string) => perf.insights.find((i) => i.id === id);

  it("puts the machines to check first, with what to do", () => {
    expect(perf.insights[0]!.id).toBe("no_sales");
    expect(find("no_sales")!.text).toContain(`(${ASSET.E})`);
    expect(find("no_sales")!.action!.assetNos).toContain(ASSET.E);
    expect(find(`drop:${TV.C}`)).toMatchObject({
      tone: "bad",
      text: `NMC C-AED15-${ASSET.C}-Cashless 1-DXB (${ASSET.C}) fell from 12 to 4 cups a day (−66.7 %).`,
      action: { assetNos: [ASSET.C] },
    });
  });

  it("says the trend, the 80 % set, the best and weakest category, the movers and the cash share in plain words", () => {
    expect(find("trend")!.text).toBe("Cups sold fell 16 %: 42 a day, against 50 a day the week before.");
    expect(find("top80")!.text).toBe("3 of the 5 machines that sold made 80 % of the cups — the key machines.");
    expect(find("best_category")!.text).toBe(
      `${CAT.metro} sells the most per machine: 15 cups a day — 1.8× the average machine (8.4).`,
    );
    expect(find("weakest_category")!.text).toBe(
      `${CAT.hospital} sells the least per machine: 4 cups a day across 3 machines.`,
    );
    expect(find(`category_move:${CAT.metro}`)!.text).toBe(`${CAT.metro} sold 50 % more cups a day than the week before: 30 against 20.`);
    expect(find(`category_move:${CAT.hospital}`)!.text).toBe(`${CAT.hospital} sold 33.3 % fewer cups a day than the week before: 12 against 18.`);
    expect(find("cash_share")!.text).toBe("Cash was 14.3 % of the cups, down from 30 % the week before.");
  });

  it("says a category where one machine sold is left out of the ranking, and names the period by its weeks", () => {
    // A third category where one machine sold: it is that machine, so the best/weakest sentences skip it — and say so.
    const lone = { ...perf.categories[0]!, category: "Lone", selling: 1, cupsPerMachineDay: 99 };
    const said = insightsOf({ fleet: perf.fleet, machines: [], categories: [...perf.categories, lone], nDays: 6, shiftDays: 14 });
    expect(said.find((i) => i.id === "best_category")!.text).toBe(
      `${CAT.metro} sells the most per machine: 15 cups a day — 1.8× the average machine (8.4). (Categories where only one machine sold are not ranked.)`,
    );
    expect(said.find((i) => i.id === "trend")!.text).toBe("Cups sold fell 16 %: 42 a day, against 50 a day the 2 weeks before.");
  });

  it("counts the machines it does not name: 'and 2 more' carries its 2", () => {
    const silent = Array.from({ length: 8 }, (_, i) => ({ ...mine("E"), assetNo: 1000 + i, label: `Silent ${i}`, tier: "no_sales" as const })) as MachinePerf[];
    const said = insightsOf({ fleet: perf.fleet, machines: silent, categories: [], nDays: 6 }).find((i) => i.id === "no_sales")!;
    expect(said.text).toMatch(/and 2 more\.$/);
    expect(said.numbers).toEqual(["8", "2"]);
  });

  it("states no number that is not in its own list of figures", () => {
    // Machine names, category names and "(asset number)" identify; they are not figures.
    const names = [...perf.machines.map((m) => m.label), ...perf.categories.map((c) => c.category)].sort((a, b) => b.length - a.length);
    for (const i of perf.insights) {
      let stated = i.text;
      for (const n of names) stated = stated.split(n).join("");
      stated = stated.replace(/\(\d+\)/g, "");
      for (const num of stated.match(/\d+(\.\d+)?/g) ?? []) expect(i.numbers, `${i.id}: ${num}`).toContain(num);
    }
  });
});

describe("one machine, day by day", () => {
  it("gives each day beside the same weekday a week before; a day not read is empty, not zero", async () => {
    const d = await machineDaily(v[SUP]!, TV.A, RANGE, NOW);
    expect(d!.days[0]).toEqual({ date: "2032-03-08", cups: 20, weekBefore: 10 });
    expect(d!.days[2]).toEqual({ date: "2032-03-10", cups: null, weekBefore: 110 });
    expect(d!.days.filter((x) => x.cups === 20)).toHaveLength(6);
    expect(await machineDaily(v[SUP]!, 999_999_999, RANGE, NOW)).toBeNull();
  });

  it("is asked by FreshNow's machine: K and L share a Televend record, each has its own days", async () => {
    const k = await machineDaily(v[SUP]!, machineOf.K!, RANGE, NOW);
    const l = await machineDaily(v[SUP]!, machineOf.L!, RANGE, NOW);
    expect(k!.days.map((x) => x.cups)).toEqual([3, 3, null, 0, 0, 0, 0]);
    expect(l!.days.map((x) => x.cups)).toEqual([0, 0, null, 3, 3, 3, 3]);
    // H, by any of its records: all of them.
    expect((await machineDaily(v[SUP]!, TV.H1, RANGE, NOW))!.days[0]).toEqual({ date: "2032-03-08", cups: 4, weekBefore: 2 });
  });
});

describe("who may", () => {
  it("lets the people who run the machines read — not the warehouse", async () => {
    await expect(machinePerformance(v[KEEP]!, RANGE, NOW)).rejects.toMatchObject({ status: 403 });
    await expect(machineDaily(v[KEEP]!, TV.A, RANGE, NOW)).rejects.toMatchObject({ status: 403 });
  });

  it("lets the Ops Head correct a category, audited without the reason's words; choosing Televend's region undoes it", async () => {
    await expect(setMachineCategory(v[SUP]!, TV.C, { category: CAT.metro })).rejects.toMatchObject({ status: 403 });
    const r = await setMachineCategory(v[OPS]!, TV.C, { category: CAT.metro, note: "It stands in the metro station" });
    expect(r).toEqual({ machineId: machineOf.C, machineTvId: TV.C, category: CAT.metro, corrected: true });
    const moved = await machinePerformance(v[OPS]!, RANGE, NOW);
    expect(moved.machines.find((m) => m.machineTvId === TV.C)).toMatchObject({ category: CAT.metro, televendRegion: CAT.hospital, corrected: true });
    const [audit] = await sql()<{ detail: Record<string, unknown> }[]>`
      select detail from audit_log where action = 'machine.category_set' and entity_id = ${machineIds[2]!} order by created_at desc limit 1`;
    expect(audit!.detail).toMatchObject({ from: CAT.hospital, to: CAT.metro, corrected: true, reasonGiven: true });
    expect(JSON.stringify(audit!.detail)).not.toContain("metro station");
    expect(await setMachineCategory(v[OPS]!, TV.C, { category: CAT.hospital })).toEqual({ machineId: machineOf.C, machineTvId: TV.C, category: CAT.hospital, corrected: false });
    const [row] = await sql()<{ category_override: string | null; category_note: string | null }[]>`select category_override, category_note from machine where id = ${machineIds[2]!}`;
    expect(row).toEqual({ category_override: null, category_note: null });
    expect(await categoryChoices(v[SUP]!)).toEqual(expect.arrayContaining([CAT.metro, CAT.hospital, "Not counted"]));
  });

  it("corrects a machine switched off in Televend, and a record FreshNow had no machine for (review, 20 Oct)", async () => {
    // I's only placement is closed: still found.
    expect(await setMachineCategory(v[OPS]!, TV.I, { category: CAT.metro })).toMatchObject({ machineId: machineOf.I, category: CAT.metro, corrected: true });
    // N has no number and no machine: one is made, so it can be left out.
    const n = await setMachineCategory(v[OPS]!, TV.N, { category: "Not counted" });
    expect(n).toMatchObject({ machineTvId: TV.N, category: "Not counted", corrected: true });
    const after = await machinePerformance(v[OPS]!, RANGE, NOW);
    expect(after.machines.find((m) => m.machineTvId === TV.N)).toMatchObject({ machineId: n.machineId, counted: false });
    // The machines sync closes a hand-made placement of a record with no number: the record still stands for that machine.
    await sql()`update machine_placement set valid_to = now() where tv_machine_id = ${TV.N} and valid_to is null`;
    const synced = await machinePerformance(v[OPS]!, RANGE, NOW);
    expect(synced.machines.filter((m) => m.machineTvId === TV.N)).toEqual([expect.objectContaining({ machineId: n.machineId, counted: false, disabledNow: false })]);
    // By FreshNow's id too.
    expect(await setMachineCategory(v[OPS]!, machineOf.I!, { category: null })).toMatchObject({ machineId: machineOf.I, corrected: false });
  });
});

describe("the reason for a correction follows the person's other words", () => {
  const saved = process.env.RETENTION_DAYS;
  afterAll(() => {
    if (saved === undefined) delete process.env.RETENTION_DAYS;
    else process.env.RETENTION_DAYS = saved;
  });

  it("is in the person's own download, aged by the retention sweep, and erased with them — the correction stays", async () => {
    await setMachineCategory(v[OPS]!, TV.E, { category: CAT.metro, note: "Moved to the metro gate last week" });
    const out = (await exportPersonData({ employeeId: OPS, requestedBy: OPS })) as Record<string, Record<string, unknown>[]>;
    expect(out.machineCategoriesSet).toEqual(expect.arrayContaining([expect.objectContaining({ machine: ASSET.E, your_reason: "Moved to the metro gate last week" })]));

    process.env.RETENTION_DAYS = "90";
    await sql()`update machine set category_set_at = now() - interval '121 days' where asset_no = ${ASSET.E}`;
    await retentionSweep();
    const [aged] = await sql()<{ category_override: string; category_note: string }[]>`select category_override, category_note from machine where asset_no = ${ASSET.E}`;
    expect(aged).toMatchObject({ category_override: CAT.metro, category_note: expect.stringMatching(/^\[redacted/) });

    await setMachineCategory(v[OPS]!, TV.B, { category: CAT.events, note: "Counted with the Expo stands" });
    await eraseEmployee({ employeeId: OPS, by: DEMO_CEO_ID, reason: "request" });
    const [erased] = await sql()<{ category_override: string; category_note: string }[]>`select category_override, category_note from machine where asset_no = ${ASSET.B}`;
    expect(erased).toEqual({ category_override: CAT.events, category_note: "[erased]" });
  });
});
