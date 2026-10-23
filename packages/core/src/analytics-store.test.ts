import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyticsStoreHealth, backfillDayTotals, buildSalesDay, daysToBuild, runAnalyticsStore } from "./analytics-store.js";
import { closeDb, getServiceSql, withContext } from "./db.js";
import { DEMO_CEO_ID } from "./meta.js";
import { loadViewer, type ViewerOrg } from "./org.js";

/**
 * The analytics store (TASK-071), against real Postgres. What must hold — from the request (R0.2, R15.3) and the rules of the
 * mirror, not from reading the code:
 *   - a day is built only once the sync read it to its end and checked it against Televend's own count; a day not checked is
 *     not in the store at all (never "sold nothing");
 *   - each machine record's day: cups by payment (cash, cashless, cashless 3, token, wallet, other — adding up to the cups),
 *     first and last sale, and its name and region at the day's last sale (a machine renamed or moved that day keeps the later);
 *   - each hour with sales; the run records what it read and whether it equals Televend's count;
 *   - built twice from the same sales it is not built again; a late sale makes the day be built again, the earlier run kept;
 *   - read only with televend.read, written by nobody but the store;
 *   - Televend's own fleet totals per day, newest first, bounded by a request budget, resumable.
 *
 * The fixture (days far from any real data):
 *   10 May 2033, checked, Televend says 9: M1 3 cash at 09:00–09:20 as "Old Name / Events", 2 cashless-3 at 21:00–21:05 as
 *     "New Name / Hospital / Clinics"; M2 one each of token, wallet, cashless and an unknown payment type.
 *   11 May, checked, Televend says 3: M1 2 cups → the store says it differs.
 *   12 May, sales but no check → not built.
 */

const TAG = `AS-${randomUUID().slice(0, 6)}`;
const CORR = randomUUID();
const OPS = randomUUID();
const KEEP = randomUUID();
const M1 = 996_001;
const M2 = 996_002;
const v: Record<string, ViewerOrg> = {};
const sql = () => getServiceSql();
let n = 0;

const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+04:00`);
async function sell(machine: number, when: Date, type: number, caption: string, region: string): Promise<void> {
  await sql()`
    insert into tv_vend (source, external_id, machine_tv_id, at, payment_type, quantity, raw, is_synthetic)
    values ('bridge', ${`${TAG}-${n++}`}, ${machine}, ${when}, ${type}, 1,
            ${sql().json({ machine_caption: caption, location_caption: region } as never)}, true)`;
}
async function checked(day: string, televendCount: number): Promise<void> {
  await sql()`
    insert into tv_sync_run (stream, mode, transport, window_from, window_to, status, complete, televend_count, correlation_id, finished_at)
    values ('vends', 'daily_check', 'bridge', ${`${day}T00:00:00+04:00`}, ${new Date(Date.parse(`${day}T00:00:00+04:00`) + 86_400_000)},
            'ok', true, ${televendCount}, ${CORR}, now())`;
}

beforeAll(async () => {
  for (const [pid, role] of [
    [OPS, "ops_head"],
    [KEEP, "warehouse_keeper"],
  ] as const) {
    await sql()`insert into employee (id, display_name, status, is_synthetic, access_role, manager_employee_id)
                values (${pid}, ${`${TAG} ${role}`}, 'active', true, ${role}, ${DEMO_CEO_ID})`;
    v[pid] = (await loadViewer(pid))!;
  }
  const d1 = "2033-05-10";
  for (const t of ["09:00", "09:10", "09:20"]) await sell(M1, at(d1, t), 0, "Old Name-996-DXB", "Events");
  for (const t of ["21:00", "21:05"]) await sell(M1, at(d1, t), 3, "New Name-996-SHJ", "Hospital / Clinics");
  await sell(M2, at(d1, "12:00"), 7, "M2-997-DXB", "Metro");
  await sell(M2, at(d1, "12:30"), 8, "M2-997-DXB", "Metro");
  await sell(M2, at(d1, "13:00"), 1, "M2-997-DXB", "Metro");
  await sell(M2, at(d1, "14:00"), 99, "M2-997-DXB", "Metro");
  await checked(d1, 9);
  await sell(M1, at("2033-05-11", "10:00"), 0, "New Name-996-SHJ", "Hospital / Clinics");
  await sell(M1, at("2033-05-11", "11:00"), 0, "New Name-996-SHJ", "Hospital / Clinics");
  await checked("2033-05-11", 3);
  await sell(M2, at("2033-05-12", "10:00"), 0, "M2-997-DXB", "Metro");
});

afterAll(async () => {
  const s = sql();
  await s`delete from sales_hour where day between '2033-05-01' and '2033-05-31'`;
  await s`delete from sales_day where day between '2033-05-01' and '2033-05-31'`;
  await s`delete from analytics_run where day between '2033-05-01' and '2033-05-31'`;
  await s`delete from tv_vend where external_id like ${`${TAG}-%`}`;
  await s`delete from tv_sync_run where correlation_id = ${CORR}`;
  await s`delete from tv_day_total where day between '2033-04-01' and '2033-04-30'`;
  await s`delete from employee where id = any(${[OPS, KEEP]}::uuid[])`;
  await closeDb();
});

const RANGE = { from: "2033-05-01", to: "2033-05-31" };

describe("which days are built", () => {
  it("only the days read to their end and checked — not a day with sales but no check", async () => {
    expect(await daysToBuild(RANGE)).toEqual(["2033-05-10", "2033-05-11"]);
  });
});

describe("a day in the store", () => {
  it("has each machine record's cups by payment, adding up, with its first and last sale", async () => {
    const r = await runAnalyticsStore(RANGE);
    expect(r.failed).toEqual([]);
    expect(r.built.map((b) => b.day)).toEqual(["2033-05-10", "2033-05-11"]);
    const rows = await sql()<Record<string, unknown>[]>`
      select machine_tv_id::int as m, cups, cash_cups, cashless_cups, cashless3_cups, token_cups, wallet_cups, other_cups,
             machine_caption, location_caption, first_sale_at, last_sale_at
        from sales_day where day = '2033-05-10' order by machine_tv_id`;
    expect(rows[0]).toMatchObject({ m: M1, cups: 5, cash_cups: 3, cashless3_cups: 2, cashless_cups: 0, token_cups: 0 });
    expect(rows[0]!.first_sale_at).toEqual(at("2033-05-10", "09:00"));
    expect(rows[0]!.last_sale_at).toEqual(at("2033-05-10", "21:05"));
    expect(rows[1]).toMatchObject({ m: M2, cups: 4, token_cups: 1, wallet_cups: 1, cashless_cups: 1, other_cups: 1, cash_cups: 0 });
  });

  it("keeps the name and region of the day's last sale — a machine moved that day is counted where it ended", async () => {
    const [m1] = await sql()<{ machine_caption: string; location_caption: string }[]>`
      select machine_caption, location_caption from sales_day where day = '2033-05-10' and machine_tv_id = ${M1}`;
    expect(m1).toEqual({ machine_caption: "New Name-996-SHJ", location_caption: "Hospital / Clinics" });
  });

  it("has each hour with sales, in Dubai hours", async () => {
    const hours = await sql()<{ hour: number; cups: number }[]>`
      select hour, cups from sales_hour where day = '2033-05-10' and machine_tv_id = ${M1} order by hour`;
    expect(hours).toEqual([
      { hour: 9, cups: 3 },
      { hour: 21, cups: 2 },
    ]);
  });

  it("records what each build read and whether it equals Televend's count", async () => {
    const runs = await sql()<{ day: string; vends_read: number; cups: number; machines: number; televend_count: number; agrees: boolean; status: string }[]>`
      select to_char(day, 'YYYY-MM-DD') as day, vends_read, cups, machines, televend_count, agrees, status
        from analytics_run where day between '2033-05-01' and '2033-05-31' order by day`;
    expect(runs).toEqual([
      { day: "2033-05-10", vends_read: 9, cups: 9, machines: 2, televend_count: 9, agrees: true, status: "ok" },
      { day: "2033-05-11", vends_read: 2, cups: 2, machines: 1, televend_count: 3, agrees: false, status: "ok" },
    ]);
    expect(await sql()`select 1 from sales_day where day = '2033-05-12'`).toHaveLength(0);
  });
});

describe("building again", () => {
  it("builds nothing when the sales are the same", async () => {
    expect(await daysToBuild(RANGE)).toEqual([]);
    expect((await runAnalyticsStore(RANGE)).built).toEqual([]);
  });

  it("builds a day again when a late sale arrives — replacing its rows, keeping the earlier run", async () => {
    await sell(M2, at("2033-05-10", "23:30"), 0, "M2-997-DXB", "Metro");
    expect(await daysToBuild(RANGE)).toEqual(["2033-05-10"]);
    const b = await buildSalesDay("2033-05-10");
    expect(b).toMatchObject({ vendsRead: 10, cups: 10, machines: 2, televendCount: 9, agrees: false });
    const [m2] = await sql()<{ cups: number; cash_cups: number; run_id: string }[]>`
      select cups, cash_cups, run_id from sales_day where day = '2033-05-10' and machine_tv_id = ${M2}`;
    expect(m2).toMatchObject({ cups: 5, cash_cups: 1, run_id: b.runId });
    const [runs] = await sql()<{ n: number }[]>`select count(*)::int as n from analytics_run where day = '2033-05-10'`;
    expect(runs!.n).toBe(2);
  });
});

describe("for /health", () => {
  it("says the newest day built and the days whose sales differ from Televend's count", async () => {
    const h = await analyticsStoreHealth();
    expect(h.lastBuiltDay).toBe("2033-05-11");
    expect(h.differ).toEqual(expect.arrayContaining(["2033-05-10", "2033-05-11"]));
    expect(h.failed).toEqual([]);
  });
});

describe("who reads the store", () => {
  it("the people who read Televend's data see it; the warehouse sees nothing; nobody writes it through the app role", async () => {
    const seen = (pid: string) =>
      withContext(v[pid]!, (tx) => tx<{ n: number }[]>`select count(*)::int as n from sales_day where day between '2033-05-01' and '2033-05-31'`, { readOnly: true });
    expect((await seen(OPS))[0]!.n).toBe(3);
    expect((await seen(KEEP))[0]!.n).toBe(0);
    for (const t of ["analytics_run", "sales_day", "sales_hour", "tv_day_total"]) {
      const [r] = await sql()<{ sel: boolean; ins: boolean; upd: boolean; del: boolean }[]>`
        select has_table_privilege('freshnow_app', ${t}, 'SELECT') as sel, has_table_privilege('freshnow_app', ${t}, 'INSERT') as ins,
               has_table_privilege('freshnow_app', ${t}, 'UPDATE') as upd, has_table_privilege('freshnow_app', ${t}, 'DELETE') as del`;
      expect({ t, ...r }).toEqual({ t, sel: true, ins: false, upd: false, del: false });
    }
    await expect(sql()`insert into sales_day (day, machine_tv_id, cups, cash_cups, cashless_cups, cashless3_cups, token_cups, wallet_cups, other_cups,
                         first_sale_at, last_sale_at, run_id) values ('2033-05-20', 1, 5, 1, 1, 1, 1, 0, 0, now(), now(),
                         (select id from analytics_run where day = '2033-05-10' limit 1))`).rejects.toThrow(/check/i);
  });
});

describe("Televend's own fleet totals", () => {
  it("are read newest first within the budget, resume where they stopped, and skip days already read", async () => {
    const asked: string[] = [];
    const source = {
      vendTotals: async (r: { from: Date; to: Date }) => {
        const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(r.from);
        expect(r.to.getTime() - r.from.getTime()).toBe(86_400_000);
        asked.push(day);
        return { vends: 1000 + Number(day.slice(-2)), quantity: null };
      },
    };
    const first = await backfillDayTotals(source, { from: "2033-04-01", to: "2033-04-03", maxRequests: 2 });
    expect(first).toEqual({ days: 2, stoppedAt: "2033-04-01" });
    expect(asked).toEqual(["2033-04-03", "2033-04-02"]);
    const second = await backfillDayTotals(source, { from: "2033-04-01", to: "2033-04-03", maxRequests: 2 });
    expect(second).toEqual({ days: 1, stoppedAt: null });
    expect(asked).toEqual(["2033-04-03", "2033-04-02", "2033-04-01"]);
    const totals = await sql()<{ day: string; vends: number }[]>`
      select to_char(day, 'YYYY-MM-DD') as day, vends from tv_day_total where day between '2033-04-01' and '2033-04-03' order by day`;
    expect(totals).toEqual([
      { day: "2033-04-01", vends: 1001 },
      { day: "2033-04-02", vends: 1002 },
      { day: "2033-04-03", vends: 1003 },
    ]);
  });
});
