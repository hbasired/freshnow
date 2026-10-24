import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { machinePerformance } from "./analytics.js";
import { compareSales, salesProfile, type SalesProfile } from "./analytics-explore.js";
import { buildSalesDay } from "./analytics-store.js";
import { closeDb, getServiceSql } from "./db.js";
import { DEMO_CEO_ID } from "./meta.js";
import { loadViewer, type ViewerOrg } from "./org.js";

/**
 * The Analytics portal's pages behind its buttons (TASK-075), against real Postgres. What must hold — from the user's words
 * of 23 Oct, not from reading the code:
 *   - choosing categories with the buttons recomputes everything for those categories only ("unselect … expo … the full
 *     analysis is shown … without including expo"), and the buttons still list the categories left out;
 *   - each day stands beside the same weekday a week before, with the % difference ("last week same day percentage
 *     difference"); a day not read is empty, never zero, and has no %;
 *   - a machine and a category open as their own analysis: days, hours, weekdays, payments, income;
 *   - two days, two periods, two machines or two categories compare side by side, the differences worked out by the server;
 *   - short sentences, every figure in them from the figures.
 *
 * The fixture, worked out by hand. Period Mon 9 – Sun 15 May 2033; Wed 11 NOT read (its whole-day count disagrees with
 * Televend's). Before = the week of 2–8 May, all read, so the changes compare 6 pairs (Wed 4 has no partner).
 *   P Metro     each day: 6 cups at 08h + 4 at 18h — 2 cash, 8 card;    before 5 a day at 08h, card
 *   Q Metro     4 a day at 18h, wallet;                                   before the same
 *   R Hospital  3 a day at 12h — 2 cash, 1 token; cash price set AED 12; before 6 a day at 12h, cash
 *   U Hospital  1 a day at 12h, cash;                                     before the same
 *   S Events    20 cups on Fri 13 only, at 15h, card;                     before nothing
 *   T           50 a day — corrected to "Not counted": out of every figure
 * The three categories, each read day: 18 cups (P 10, Q 4, R 3, U 1), Fri 13: 38. Over the 6 days read: 128 cups, 21.3 a day,
 * 5 machines sold, 4.3 per machine a day. Income a day 17,400 fils (P 10,000, Q 4,000, R 2,400, U 1,000), Fri + 20,000:
 * 124,400 in all; 122 paid cups (6 token) → 1,020 fils a paid cup. Cash 30 of 128 = 23.4 %. Before: 16 a day, 17,200 fils.
 * Changes on the 6 pairs: cups 128 against 96 = +33.3 %; income 124,400 against 103,200 = +20.5 %.
 * Hours over the 6 days: 08h 36, 12h 24, 15h 20, 18h 48 — the busiest, 37.5 % of 128.
 */

const TAG = `AX-${randomUUID().slice(0, 6)}`;
const OPS = randomUUID();
const KEEP = randomUUID();
const STAFF = [OPS, KEEP];
const CORR = randomUUID();
const NOW = new Date("2033-05-16T10:00:00+04:00");
const RANGE = { from: "2033-05-09", to: "2033-05-15" };
const CAT = { metro: `${TAG} Metro`, hospital: `${TAG} Hospital`, events: `${TAG} Events` };
const MINE = [CAT.metro, CAT.hospital, CAT.events];
const TV = { P: 995_001, Q: 995_002, R: 995_003, U: 995_004, S: 995_005, T: 995_006 } as const;
const ASSET = { P: 99_501, Q: 99_502, R: 99_503, U: 99_504, S: 99_505, T: 99_506 } as const;
type K = keyof typeof TV;
const machineOf = {} as Record<K, string>;
const v: Record<string, ViewerOrg> = {};
const sql = () => getServiceSql();
const dates = (from: string, n: number) => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));
let all: SalesProfile;

beforeAll(async () => {
  const s = sql();
  for (const [pid, name, role] of [
    [OPS, "Ops", "ops_head"],
    [KEEP, "Keeper", "warehouse_keeper"],
  ] as const) {
    await s`insert into employee (id, display_name, status, is_synthetic, access_role, manager_employee_id)
            values (${pid}, ${`${TAG} ${name}`}, 'active', true, ${role}, ${DEMO_CEO_ID})`;
  }
  const machines: [K, string, string, number | null, string | null][] = [
    ["P", `Metro P-${ASSET.P}-DXB`, CAT.metro, null, null],
    ["Q", `Metro Q-${ASSET.Q}-DXB`, CAT.metro, null, null],
    ["R", `Clinic R-AED15-${ASSET.R}-DXB`, CAT.hospital, 1200, null],
    ["U", `Clinic U-${ASSET.U}-DXB`, CAT.hospital, null, null],
    ["S", `Expo S-${ASSET.S}-DXB`, CAT.events, null, null],
    ["T", `Test T-${ASSET.T}-DXB`, CAT.events, null, "Not counted"],
  ];
  for (const [k, caption, region, price, override] of machines) {
    await s`insert into tv_machine (televend_id, caption, asset_no, enabled, region_caption, last_status, connection_status, raw, is_synthetic)
            values (${TV[k]}, ${caption}, ${ASSET[k]}, true, ${region}, 1, 1, '{}'::jsonb, true)`;
    const [m] = await s<{ id: string }[]>`
      insert into machine (asset_no, label, cash_price_fils, category_override, is_synthetic) values (${ASSET[k]}, ${caption}, ${price}, ${override}, true) returning id`;
    machineOf[k] = m!.id;
    await s`insert into machine_placement (machine_id, tv_machine_id, source, is_synthetic) values (${m!.id}, ${TV[k]}, 'manual', true)`;
  }
  const vends: { source: string; external_id: string; machine_tv_id: number; at: Date; payment_type: number; quantity: number; raw: string; is_synthetic: boolean }[] = [];
  let n = 0;
  // [machine, days, hour, payment type, cups a day]
  const sell = (k: K, days: string[], hour: number, type: number, perDay: number) => {
    for (const d of days)
      for (let i = 0; i < perDay; i++)
        vends.push({
          source: "bridge",
          external_id: `${TAG}-${n++}`,
          machine_tv_id: TV[k],
          at: new Date(`${d}T${String(hour).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00+04:00`),
          payment_type: type,
          quantity: 1,
          raw: "{}",
          is_synthetic: true,
        });
  };
  const now7 = dates("2033-05-09", 7); // includes Wed 11, whose sales must not count
  const before7 = dates("2033-05-02", 7);
  sell("P", now7, 8, 0, 2); sell("P", now7, 8, 1, 4); sell("P", now7, 18, 1, 4); sell("P", before7, 8, 1, 5);
  sell("Q", now7, 18, 8, 4); sell("Q", before7, 18, 8, 4);
  sell("R", now7, 12, 0, 2); sell("R", now7, 12, 7, 1); sell("R", before7, 12, 0, 6);
  sell("U", now7, 12, 0, 1); sell("U", before7, 12, 0, 1);
  sell("S", ["2033-05-13"], 15, 1, 20);
  sell("T", now7, 10, 1, 50);
  for (let i = 0; i < vends.length; i += 500) {
    await s`insert into tv_vend ${s(vends.slice(i, i + 500).map((x) => ({ ...x, raw: s.json({}) })) as never, "source", "external_id", "machine_tv_id", "at", "payment_type", "quantity", "raw", "is_synthetic")}`;
  }
  for (const d of [...before7, ...now7]) {
    await s`insert into tv_sync_run (stream, mode, transport, window_from, window_to, status, complete, televend_count, correlation_id, finished_at)
            select 'vends', 'backfill', 'bridge', ${`${d}T00:00:00+04:00`}::timestamptz, ${`${d}T00:00:00+04:00`}::timestamptz + interval '1 day', 'ok', true,
                   count(*)::int + ${d === "2033-05-11" ? 5 : 0}, ${CORR}, now()
              from tv_vend where at >= ${`${d}T00:00:00+04:00`}::timestamptz and at < ${`${d}T00:00:00+04:00`}::timestamptz + interval '1 day'`;
    await buildSalesDay(d, { correlationId: CORR, isSynthetic: true });
  }
  for (const pid of STAFF) v[pid] = (await loadViewer(pid))!;
  all = (await salesProfile(v[OPS]!, RANGE, { kind: "selection", categories: MINE }, NOW))!;
});

afterAll(async () => {
  const s = sql();
  await s`delete from sales_hour where run_id in (select id from analytics_run where correlation_id = ${CORR})`;
  await s`delete from sales_day where run_id in (select id from analytics_run where correlation_id = ${CORR})`;
  await s`delete from analytics_run where correlation_id = ${CORR}`;
  await s`delete from tv_vend where external_id like ${`${TAG}-%`}`;
  await s`delete from tv_sync_run where correlation_id = ${CORR}`;
  await s`delete from machine_placement where tv_machine_id = any(${Object.values(TV)}::bigint[])`;
  await s`delete from tv_machine where televend_id = any(${Object.values(TV)}::bigint[])`;
  await s`delete from machine where id = any(${Object.values(machineOf)}::uuid[])`;
  await s`delete from employee where id = any(${STAFF}::uuid[])`;
  await closeDb();
});

/** Every figure a sentence states must be in its own list — names (machines, categories) and "(asset number)" aside. */
function gate(insights: { id: string; text: string; numbers: string[] }[], names: string[]) {
  const sorted = [...names].sort((a, b) => b.length - a.length);
  for (const i of insights) {
    let stated = i.text;
    for (const n of sorted) stated = stated.split(n).join("");
    stated = stated.replace(/\(\d+\)/g, "");
    for (const num of stated.match(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g) ?? []) expect(i.numbers, `${i.id}: ${num} in "${i.text}"`).toContain(num);
  }
}
const labels = () => [...Object.keys(TV).map((k) => `${k === "R" ? "Clinic R-AED15" : k === "U" ? "Clinic U" : k === "S" ? "Expo S" : k === "T" ? "Test T" : `Metro ${k}`}-${ASSET[k as K]}-DXB`), ...MINE];

describe("choosing categories with the buttons", () => {
  it("recomputes every figure for the categories chosen — and still lists the ones left out", async () => {
    const two = await machinePerformance(v[OPS]!, RANGE, NOW, { categories: [CAT.hospital, CAT.metro] });
    expect(two.selection.categories).toEqual([CAT.hospital, CAT.metro].sort((a, b) => a.localeCompare(b)));
    // P 60, Q 24, R 18, U 6 over the 6 days read: 108 cups by 4 machines → 4.5 per machine a day.
    expect(two.fleet).toMatchObject({ selling: 4, cups: 108, cupsPerMachineDay: 4.5 });
    expect(two.machines.some((m) => m.machineTvId === TV.S)).toBe(false);
    // The machine left out of every figure is still listed apart, to correct.
    expect(two.machines.find((m) => m.machineTvId === TV.T)).toMatchObject({ counted: false });
    // The tiers are against the chosen machines' average: P 222 %, Q 88 %, R 66 %, U 22 %.
    expect(two.machines.find((m) => m.machineTvId === TV.P)).toMatchObject({ tier: "top", rank: 1 });
    expect(two.machines.find((m) => m.machineTvId === TV.Q)).toMatchObject({ tier: "average", vsAverage: 0.88 });
    expect(two.machines.find((m) => m.machineTvId === TV.U)).toMatchObject({ tier: "below", rank: 4 });
    expect(two.categories.map((c) => c.category)).toEqual([CAT.metro, CAT.hospital]);
    expect(two.selection.available.filter((c) => MINE.includes(c.category))).toEqual([
      { category: CAT.events, machines: 1, selling: 1 },
      { category: CAT.hospital, machines: 2, selling: 2 },
      { category: CAT.metro, machines: 2, selling: 2 },
    ]);
    // The sentence names the chosen categories' average, not the fleet's.
    expect(two.insights.find((i) => i.id === "best_category")!.text).toBe(
      `${CAT.metro} sells the most per machine: 7 cups a day — 1.6× the average machine of the chosen categories (4.5).`,
    );
  });

  it("with every category, says so — and the buttons' list is the same", async () => {
    const every = await machinePerformance(v[OPS]!, RANGE, NOW);
    expect(every.selection.categories).toBeNull();
    expect(every.selection.available.map((c) => c.category)).toEqual(expect.arrayContaining(MINE));
    expect(every.machines.some((m) => m.machineTvId === TV.S)).toBe(true);
  });

  it("tidies the names asked for and refuses malformed ones in words", async () => {
    const tidy = await machinePerformance(v[OPS]!, RANGE, NOW, { categories: [`  ${CAT.metro}  `, CAT.metro] });
    expect(tidy.selection.categories).toEqual([CAT.metro]);
    await expect(machinePerformance(v[OPS]!, RANGE, NOW, { categories: ["x".repeat(61)] })).rejects.toMatchObject({ status: 400, code: "bad_category" });
    await expect(machinePerformance(v[OPS]!, RANGE, NOW, { categories: Array.from({ length: 101 }, (_, i) => `c${i}`) })).rejects.toMatchObject({ status: 400 });
    // None chosen: nothing to count — never every category by accident.
    const none = await machinePerformance(v[OPS]!, RANGE, NOW, { categories: [] });
    expect(none.fleet).toMatchObject({ selling: 0, cups: 0, machines: 0 });
    expect(none.insights).toEqual([]);
  });
});

describe("a profile: the chosen categories over the period", () => {
  it("adds up the days read only, with the machines that sold and the cups per machine a day", () => {
    expect(all.coverage.notRead).toEqual(["2033-05-11"]);
    expect(all.coverage.compared).toHaveLength(6);
    expect(all.scope).toMatchObject({ kind: "selection", label: "3 categories", machines: 5 });
    expect(all.totals).toMatchObject({ cups: 128, cupsPerDay: 21.3, machinesSold: 5, cupsPerMachineDay: 4.3 });
  });

  it("sets each day beside the same weekday a week before, with the % — a day not read is empty, not zero", () => {
    expect(all.days).toHaveLength(7);
    expect(all.days[0]).toEqual({ date: "2033-05-09", cups: 18, incomeFils: 17_400, cashCups: 5, lastWeek: { date: "2033-05-02", cups: 16 }, changePct: 12.5 });
    expect(all.days[2]).toEqual({ date: "2033-05-11", cups: null, incomeFils: null, cashCups: null, lastWeek: { date: "2033-05-04", cups: 16 }, changePct: null });
    expect(all.days[4]).toMatchObject({ date: "2033-05-13", cups: 38, changePct: 137.5 });
    expect(all.totals.lastDay).toEqual({ date: "2033-05-15", cups: 18, lastWeek: { date: "2033-05-08", cups: 16 }, changePct: 12.5 });
  });

  it("estimates the income — cash at the cash price, the other paid cups at the name's price, tokens not at all", () => {
    expect(all.totals).toMatchObject({ incomeFils: 124_400, incomePerDayFils: 20_733, paidCups: 122, avgPriceFils: 1_020, cashShare: 23.4 });
  });

  it("compares with the same days before on the pairs read on both sides: cups +33.3 %, income +20.5 %", () => {
    expect(all.totals.compare).toEqual({ days: 6, now: 21.3, before: 16, changePct: 33.3 });
    expect(all.totals.incomeCompare).toMatchObject({ days: 6, changePct: 20.5 });
  });

  it("finds the busiest hour, and draws each hour per day read beside the days before", () => {
    expect(all.totals.peak).toEqual({ hour: 18, cups: 48, share: 37.5 });
    expect(all.hours[18]).toEqual({ hour: 18, now: 8, before: 4, nowCups: 48, beforeCups: 28 });
    expect(all.hours[15]).toEqual({ hour: 15, now: 3.3, before: 0, nowCups: 20, beforeCups: 0 });
    expect(all.hours.reduce((t, h) => t + h.nowCups, 0)).toBe(128);
  });

  it("splits the weekdays — Wednesday was not read, so it has no rate — and says how people paid", () => {
    expect(all.weekdays.find((w) => w.label === "Wed")).toEqual({ dow: 3, label: "Wed", days: 0, cups: 0, cupsPerDay: null });
    expect(all.weekdays.find((w) => w.label === "Fri")).toEqual({ dow: 5, label: "Fri", days: 1, cups: 38, cupsPerDay: 38 });
    const pay = Object.fromEntries(all.payments.map((p) => [p.kind, p]));
    expect(pay.cash).toEqual({ kind: "cash", now: 30, nowShare: 23.4, before: 49, beforeShare: 43.8 });
    expect(pay.card).toMatchObject({ now: 68, nowShare: 53.1, before: 35, beforeShare: 31.3 });
    expect(pay.wallet).toMatchObject({ now: 24, nowShare: 18.8, beforeShare: 25 });
    expect(pay.token).toMatchObject({ now: 6, nowShare: 4.7, before: 0, beforeShare: 0 });
  });

  it("names the best and the weakest day", () => {
    expect(all.totals.bestDay).toEqual({ date: "2033-05-13", cups: 38 });
    expect(all.totals.weakestDay!.cups).toBe(18);
  });

  it("says it in short sentences, each figure in it from the figures", () => {
    const by = (id: string) => all.insights.find((i) => i.id === id)!;
    expect(by("last_day").text).toBe("Sun 15 May: 18 cups, 12.5 % more than Sun 8 May.");
    expect(by("trend").text).toBe("Cups a day up 33.3 % against the week before: 21.3 against 16.");
    expect(by("peak_hour").text).toBe("Busiest hour: 18:00 to 19:00, 37.5 % of the cups.");
    expect(by("income").text).toBe("About AED 207 a day — AED 10.20 for each paid cup (estimated from the prices).");
    // Points from the exact shares (23.44 against 43.75), not from the rounded 23.4 and 43.8.
    expect(by("cash_share").text).toBe("Cash was 23.4 % of the cups, down from 43.8 % the week before.");
    gate(all.insights, labels());
  });
});

describe("a profile: one category, one machine", () => {
  it("opens a category on its own: Metro, 14 cups a day by 2 machines, +55.6 % on the days before", async () => {
    const metro = (await salesProfile(v[OPS]!, RANGE, { kind: "category", category: CAT.metro }, NOW))!;
    expect(metro.scope).toMatchObject({ kind: "category", label: CAT.metro, category: CAT.metro, machines: 2 });
    expect(metro.totals).toMatchObject({ cups: 84, cupsPerDay: 14, machinesSold: 2, cupsPerMachineDay: 7, compare: { now: 14, before: 9, changePct: 55.6 } });
  });

  it("opens a machine by its Televend record or by FreshNow's id — the same machine either way", async () => {
    const byRecord = (await salesProfile(v[OPS]!, RANGE, { kind: "machine", machine: TV.R }, NOW))!;
    const byId = (await salesProfile(v[OPS]!, RANGE, { kind: "machine", machine: machineOf.R }, NOW))!;
    expect(byRecord.totals).toEqual(byId.totals);
    expect(byRecord.scope).toMatchObject({ kind: "machine", machineKey: machineOf.R, machineTvId: TV.R, assetNo: ASSET.R, label: `Clinic R-AED15-${ASSET.R}-DXB (${ASSET.R})` });
    // 2 cash at the set AED 12 and 1 token a day: 18 cups, 12 paid, AED 144 in all.
    expect(byRecord.totals).toMatchObject({ cups: 18, paidCups: 12, incomeFils: 14_400, avgPriceFils: 1_200, cashShare: 66.7 });
    expect(byRecord.totals.lastDay).toMatchObject({ cups: 3, lastWeek: { cups: 6 }, changePct: -50 });
    expect(byRecord.hours[12]).toMatchObject({ nowCups: 18, now: 3, before: 6 });
    expect(await salesProfile(v[OPS]!, RANGE, { kind: "machine", machine: 999_999_998 }, NOW)).toBeNull();
  });

  it("leaves a machine 'Not counted' out of the categories, but opens it on its own", async () => {
    const events = (await salesProfile(v[OPS]!, RANGE, { kind: "category", category: CAT.events }, NOW))!;
    expect(events.totals.cups).toBe(20);
    const t = (await salesProfile(v[OPS]!, RANGE, { kind: "machine", machine: TV.T }, NOW))!;
    expect(t.totals.cups).toBe(300);
  });
});

describe("comparing two side by side", () => {
  it("two days: Thu 12 against Fri 13 — the volume, the categories and the machine that moved", async () => {
    const c = (await compareSales(v[OPS]!, { mode: "days", a: "2033-05-12", b: "2033-05-13", categories: MINE }, NOW))!;
    expect(c.rows.find((r) => r.id === "cups")).toEqual({ id: "cups", label: "Cups", unit: "cups", a: 18, b: 38, diff: 20, diffPct: 111.1 });
    expect(c.rows.find((r) => r.id === "income")).toMatchObject({ a: 17_400, b: 37_400, diff: 20_000, diffPct: 114.9 });
    expect(c.categories!.find((x) => x.category === CAT.events)).toEqual({ category: CAT.events, a: 0, b: 20, changePct: null });
    expect(c.categories!.find((x) => x.category === CAT.metro)).toEqual({ category: CAT.metro, a: 14, b: 14, changePct: 0 });
    // Only S changed between the two days.
    expect(c.movers).toEqual([{ key: machineOf.S, label: `Expo S-${ASSET.S}-DXB`, assetNo: ASSET.S, a: 0, b: 20, change: 20 }]);
    expect(c.days).toBeNull();
    expect(c.hours[18]).toEqual({ hour: 18, a: 8, b: 8 });
    expect(c.hours[15]).toEqual({ hour: 15, a: 0, b: 20 });
    expect(c.insights.find((i) => i.id === "volume")!.text).toBe("Fri 13 May sold 111.1 % more cups than Thu 12 May: 38 against 18.");
    expect(c.insights.find((i) => i.id === "peak")!.text).toBe("Busiest hour: Thu 12 May 18:00, Fri 13 May 15:00.");
    gate(c.insights, labels());
  });

  it("two periods: the week before against the week — a % from the totals, never from rounded rates", async () => {
    const c = (await compareSales(v[OPS]!, { mode: "periods", a: { from: "2033-05-02", to: "2033-05-08" }, b: RANGE, categories: MINE }, NOW))!;
    // 112 cups over 7 days against 128 over the 6 read: 16 against 21.33 a day = +33.3 % (from 21.3 it would be 33.1).
    expect(c.rows.find((r) => r.id === "cups_per_day")).toMatchObject({ a: 16, b: 21.3, diffPct: 33.3 });
    // The points too: 23.44 − 43.75 = −20.3 (the rounded shares shown would say −20.4).
    expect(c.rows.find((r) => r.id === "cash_share")).toMatchObject({ unit: "pct", a: 43.8, b: 23.4, diff: -20.3, diffPct: null });
    gate(c.insights, labels());
  });

  it("two machines over the same days, day by day — and the same machine twice is refused", async () => {
    const c = (await compareSales(v[OPS]!, { mode: "machines", range: RANGE, a: TV.P, b: machineOf.Q }, NOW))!;
    expect(c.rows.find((r) => r.id === "cups_per_day")).toMatchObject({ a: 10, b: 4, diff: -6, diffPct: -60 });
    expect(c.rows.some((r) => r.id === "machines_sold")).toBe(false);
    expect(c.days![0]).toEqual({ date: "2033-05-09", a: 10, b: 4 });
    expect(c.days![2]).toEqual({ date: "2033-05-11", a: null, b: null });
    expect(c.payments.find((p) => p.kind === "wallet")).toEqual({ kind: "wallet", a: 0, b: 100 });
    gate(c.insights, labels());
    await expect(compareSales(v[OPS]!, { mode: "machines", range: RANGE, a: TV.P, b: machineOf.P }, NOW)).rejects.toMatchObject({ status: 400, code: "same_twice" });
    expect(await compareSales(v[OPS]!, { mode: "machines", range: RANGE, a: TV.P, b: 999_999_997 }, NOW)).toBeNull();
  });

  it("two categories: per machine too, so 2 machines compare fairly with 2", async () => {
    const c = (await compareSales(v[OPS]!, { mode: "categories", range: RANGE, a: CAT.metro, b: CAT.hospital }, NOW))!;
    expect(c.rows.find((r) => r.id === "cups_per_day")).toMatchObject({ a: 14, b: 4, diffPct: -71.4 });
    expect(c.rows.find((r) => r.id === "per_machine")).toMatchObject({ a: 7, b: 2 });
    expect(c.insights.find((i) => i.id === "per_machine")!.text).toBe(`Per machine that sold: ${CAT.hospital} 2 cups a day, ${CAT.metro} 7.`);
    gate(c.insights, labels());
    await expect(compareSales(v[OPS]!, { mode: "categories", range: RANGE, a: CAT.metro, b: ` ${CAT.metro}` }, NOW)).rejects.toMatchObject({ code: "same_twice" });
  });
});

describe("who may", () => {
  it("refuses the warehouse, as the performance page does", async () => {
    await expect(salesProfile(v[KEEP]!, RANGE, { kind: "selection" }, NOW)).rejects.toMatchObject({ status: 403 });
    await expect(compareSales(v[KEEP]!, { mode: "days", a: "2033-05-12", b: "2033-05-13" }, NOW)).rejects.toMatchObject({ status: 403 });
  });
});
