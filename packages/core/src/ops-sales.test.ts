import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getServiceSql } from "./db.js";
import { DEMO_CEO_ID } from "./meta.js";
import { OpsAccessRefused, OpsDayRefused, salesByHour } from "./ops-sales.js";
import { loadViewer, type ViewerOrg } from "./org.js";

/**
 * Cups sold by hour — against the real (throwaway) Postgres, never mocked. The days are in 2023 so
 * no other test's vends fall on them; every number below is counted by hand from the rows inserted.
 *
 *   Wednesday 22 Nov 2023 (the day)        Wednesday 15 Nov 2023 (a week earlier)
 *     00:30 ×1  ← 21 Nov in UTC              09:20 ×4
 *     09:10 ×1, 09:50 ×2                     15:00 ×3
 *     23:59:59 ×1                            (14 Nov 23:30 ×7 — the day before: not counted)
 *     (23 Nov 00:00 ×5 — the next day: not counted)
 *   Wednesday 29 Nov 2023: 10:00 ×6, but 06:00–08:00 was never read (a gap)
 *
 * The mirror's reach is set here too, as the sync records it: 15 Nov read whole and confirmed (a
 * backfill), then 16 Nov onwards read in windows up to the vends cursor — except 06:00–08:00 on 29 Nov.
 */
const RUN = `OPS-${randomUUID().slice(0, 6)}`;
const CORR = randomUUID();
const SUP = randomUUID();
const VMO = randomUUID();
let sup: ViewerOrg;
let vmo: ViewerOrg;
let savedCursor: Date | null = null;

const cursorAt = (iso: string) =>
  getServiceSql()`insert into tv_sync_cursor (stream, read_until) values ('vends', ${iso})
                  on conflict (stream) do update set read_until = excluded.read_until`;

beforeAll(async () => {
  const sql = getServiceSql();
  await sql`insert into employee (id, display_name, status, is_synthetic, access_role, manager_employee_id)
            values (${SUP}, ${`${RUN}-SUP`}, 'active', true, 'supervisor', ${DEMO_CEO_ID})`;
  await sql`insert into employee (id, display_name, status, is_synthetic, access_role, manager_employee_id)
            values (${VMO}, ${`${RUN}-VMO`}, 'active', true, 'vmo', ${SUP})`;
  sup = (await loadViewer(SUP))!;
  vmo = (await loadViewer(VMO))!;
  const vends: Array<[string, number]> = [
    ["2023-11-22T00:30:00+04:00", 1],
    ["2023-11-22T09:10:00+04:00", 1],
    ["2023-11-22T09:50:00+04:00", 2],
    ["2023-11-22T23:59:59+04:00", 1],
    ["2023-11-23T00:00:00+04:00", 5],
    ["2023-11-15T09:20:00+04:00", 4],
    ["2023-11-15T15:00:00+04:00", 3],
    ["2023-11-14T23:30:00+04:00", 7],
    ["2023-11-29T10:00:00+04:00", 6],
  ];
  let n = 0;
  for (const [at, quantity] of vends) {
    await sql`insert into tv_vend (source, external_id, machine_tv_id, at, payment_type, quantity, raw, is_synthetic)
              values ('bridge', ${`${RUN}-${n++}`}, 990001, ${at}, 1, ${quantity}, '{}'::jsonb, true)`;
  }
  // Televend's own count confirmed the earlier day only; the later one was read in windows, never checked.
  const run = (mode: string, from: string, to: string, complete = true) =>
    sql`insert into tv_sync_run (stream, mode, transport, window_from, window_to, status, complete, correlation_id, finished_at)
        values ('vends', ${mode}, 'bridge', ${from}, ${to}, ${complete ? "ok" : "partial"}, ${complete}, ${CORR}, now())`;
  await run("backfill", "2023-11-15T00:00:00+04:00", "2023-11-16T00:00:00+04:00");
  await run("incremental", "2023-11-16T00:00:00+04:00", "2023-11-29T06:00:00+04:00");
  await run("incremental", "2023-11-29T08:00:00+04:00", "2023-12-01T00:00:00+04:00");
  // A read that stopped early covers nothing; a window back to front (a clock jump) must not break the read.
  await run("incremental", "2023-11-29T06:00:00+04:00", "2023-11-29T08:00:00+04:00", false);
  await run("incremental", "2023-11-22T10:00:00+04:00", "2023-11-22T09:00:00+04:00");
  savedCursor = (await sql<{ read_until: Date }[]>`select read_until from tv_sync_cursor where stream = 'vends'`)[0]?.read_until ?? null;
  await cursorAt("2023-12-01T00:00:00+04:00");
});

afterAll(async () => {
  const sql = getServiceSql();
  if (savedCursor) await sql`update tv_sync_cursor set read_until = ${savedCursor} where stream = 'vends'`;
  else await sql`delete from tv_sync_cursor where stream = 'vends'`;
  await sql`delete from tv_vend where external_id like ${`${RUN}-%`}`;
  await sql`delete from tv_sync_run where correlation_id = ${CORR}`;
  await sql`delete from employee where id = ${VMO}`;
  await sql`delete from employee where id = ${SUP}`;
  await closeDb();
});

describe("cups sold by hour", () => {
  it("a whole day: by Dubai hour, against the whole of the same weekday a week earlier", async () => {
    const r = await salesByHour(sup, "2023-11-22", new Date("2023-12-01T12:00:00+04:00"));
    expect(r).toMatchObject({ date: "2023-11-22", comparedWith: "2023-11-15", throughHour: null, partial: null });
    expect(r.hours).toHaveLength(24);
    expect(r.hours[0]).toEqual({ hour: 0, cups: 1, cupsLastWeek: 0 }); // 00:30 Dubai is still 21 Nov in UTC
    expect(r.hours[9]).toEqual({ hour: 9, cups: 3, cupsLastWeek: 4 });
    expect(r.hours[15]).toEqual({ hour: 15, cups: 0, cupsLastWeek: 3 });
    expect(r.hours[23]).toEqual({ hour: 23, cups: 1, cupsLastWeek: 0 });
    expect(r.totals).toEqual({ cups: 5, cupsLastWeekSameTime: 7, cupsLastWeekWholeDay: 7 });
    expect(r.covered).toEqual({ date: true, comparedWith: true });
    expect(r.complete).toEqual({ date: false, comparedWith: true });
    expect(r.mirroredFrom).toBe("2023-11-15");
  });

  it("a day still being read: whole hours to the horizon, the hour in progress apart against the same minutes", async () => {
    // 09:30 on the day: hours 0–8 are whole, 09:00–09:30 is in progress, later hours are not read yet.
    const r = await salesByHour(sup, "2023-11-22", new Date("2023-11-22T09:30:00+04:00"));
    expect(r.throughHour).toBe(9);
    expect(r.hours[8]).toEqual({ hour: 8, cups: 0, cupsLastWeek: 0 });
    expect(r.hours[9]).toEqual({ hour: 9, cups: null, cupsLastWeek: 4 });
    expect(r.hours[10]!.cups).toBeNull();
    // 09:00–09:30: one cup at 09:10 (09:50 has not happened); a week earlier, the 09:20 cups.
    expect(r.partial).toEqual({ hour: 9, cups: 1, cupsLastWeekSameMinutes: 4 });
    expect(r.totals).toEqual({ cups: 2, cupsLastWeekSameTime: 4, cupsLastWeekWholeDay: 7 });
  });

  it("when Televend has not been read for a while, both days are cut where the reading stopped — not at the clock", async () => {
    await cursorAt("2023-11-22T09:00:00+04:00");
    try {
      const r = await salesByHour(sup, "2023-11-22", new Date("2023-11-22T12:00:00+04:00"));
      expect(r.horizon).toBe(new Date("2023-11-22T09:00:00+04:00").toISOString());
      expect(r.throughHour).toBe(9);
      // Today only the 00:30 cup was read; a week earlier, nothing before 09:00 either — not 4.
      expect(r.totals).toEqual({ cups: 1, cupsLastWeekSameTime: 0, cupsLastWeekWholeDay: 7 });
    } finally {
      await cursorAt("2023-12-01T00:00:00+04:00");
    }
  });

  it("a day before the mirror began is not in the mirror — no number at all, never zero sales", async () => {
    const r = await salesByHour(sup, "2023-11-01", new Date("2023-12-01T12:00:00+04:00"));
    expect(r.covered).toEqual({ date: false, comparedWith: false });
    expect(r).toMatchObject({ throughHour: null, partial: null, totals: { cups: null, cupsLastWeekSameTime: null, cupsLastWeekWholeDay: null } });
    expect(r.hours.every((h) => h.cups === null && h.cupsLastWeek === null)).toBe(true);
  });

  it("a day with a gap in what was read is not in the mirror, even with sales read around the gap; its earlier day still is", async () => {
    const r = await salesByHour(sup, "2023-11-29", new Date("2023-12-01T12:00:00+04:00"));
    expect(r.covered).toEqual({ date: false, comparedWith: true });
    // The 10:00 cups were read, but a day with two unread hours has no total to give.
    expect(r.totals).toEqual({ cups: null, cupsLastWeekSameTime: null, cupsLastWeekWholeDay: 5 });
    expect(r.hours[10]).toEqual({ hour: 10, cups: null, cupsLastWeek: 0 });
    expect(r.hours[9]).toEqual({ hour: 9, cups: null, cupsLastWeek: 3 });
  });

  it("just after midnight, before the day's first read, today is not read yet — not 23 hours of nothing sold", async () => {
    await cursorAt("2023-11-21T23:58:00+04:00");
    try {
      const r = await salesByHour(sup, "2023-11-22", new Date("2023-11-22T00:05:00+04:00"));
      expect(r.covered).toEqual({ date: false, comparedWith: true });
      expect(r).toMatchObject({ throughHour: null, partial: null });
      expect(r.totals).toEqual({ cups: null, cupsLastWeekSameTime: null, cupsLastWeekWholeDay: 7 });
      expect(r.hours.every((h) => h.cups === null)).toBe(true);
    } finally {
      await cursorAt("2023-12-01T00:00:00+04:00");
    }
  });

  it("only people who run the machines may read it, and only for a day that has begun", async () => {
    await expect(salesByHour(vmo, "2023-11-22")).rejects.toBeInstanceOf(OpsAccessRefused);
    await expect(salesByHour(sup, "22/11/2023")).rejects.toBeInstanceOf(OpsDayRefused);
    await expect(salesByHour(sup, "2023-11-23", new Date("2023-11-22T23:00:00+04:00"))).rejects.toBeInstanceOf(OpsDayRefused);
  });
});
