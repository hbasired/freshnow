import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, DEMO_CEO_ID, getServiceSql } from "@freshnow/core";
import { buildServer } from "./server.js";

/** The Operations portal's first read over HTTP: who may have it, and that it says what Postgres counted. */
const app = buildServer(false);
const RUN = `OPSAPI-${randomUUID().slice(0, 6)}`;
const SUP = randomUUID();
const VMO = randomUUID();
const CORR = randomUUID();
let savedCursor: Date | null = null;

beforeAll(async () => {
  const sql = getServiceSql();
  await sql`insert into employee (id, display_name, status, is_synthetic, access_role, manager_employee_id)
            values (${SUP}, ${`${RUN}-SUP`}, 'active', true, 'supervisor', ${DEMO_CEO_ID})`;
  await sql`insert into employee (id, display_name, status, is_synthetic, access_role, manager_employee_id)
            values (${VMO}, ${`${RUN}-VMO`}, 'active', true, 'vmo', ${SUP})`;
  // 18 Oct 2023, 14:05 Dubai: two cups. Nothing else in the suite sells on that day.
  await sql`insert into tv_vend (source, external_id, machine_tv_id, at, payment_type, quantity, raw, is_synthetic)
            values ('bridge', ${`${RUN}-1`}, 990002, '2023-10-18T14:05:00+04:00', 1, 2, '{}'::jsonb, true)`;
  // The mirror's reach: 11 Oct read whole (a backfill run), then read in windows to well past both days.
  await sql`insert into tv_sync_run (stream, mode, transport, window_from, window_to, status, complete, correlation_id, finished_at)
            values ('vends', 'backfill', 'bridge', '2023-10-11T00:00:00+04:00', '2023-10-12T00:00:00+04:00', 'ok', true, ${CORR}, now()),
                   ('vends', 'incremental', 'bridge', '2023-10-12T00:00:00+04:00', '2023-11-01T00:00:00+04:00', 'ok', true, ${CORR}, now())`;
  savedCursor = (await sql<{ read_until: Date }[]>`select read_until from tv_sync_cursor where stream = 'vends'`)[0]?.read_until ?? null;
  await sql`insert into tv_sync_cursor (stream, read_until) values ('vends', '2023-11-01T00:00:00+04:00')
            on conflict (stream) do update set read_until = excluded.read_until`;
});

afterAll(async () => {
  const sql = getServiceSql();
  if (savedCursor) await sql`update tv_sync_cursor set read_until = ${savedCursor} where stream = 'vends'`;
  else await sql`delete from tv_sync_cursor where stream = 'vends'`;
  await sql`delete from tv_sync_run where correlation_id = ${CORR}`;
  await sql`delete from tv_vend where external_id like ${`${RUN}-%`}`;
  await sql`delete from employee where id = ${VMO}`;
  await sql`delete from employee where id = ${SUP}`;
  await app.close();
  await closeDb();
});

describe("GET /dashboard/ops/sales-by-hour", () => {
  it("gives a supervisor the day's cups by hour, as Postgres counted them", async () => {
    const r = await app.inject({ method: "GET", url: `/dashboard/ops/sales-by-hour?viewer=${SUP}&date=2023-10-18` });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { hours: { hour: number; cups: number }[]; totals: { cups: number }; comparedWith: string; covered: unknown };
    expect(body.comparedWith).toBe("2023-10-11");
    expect(body.covered).toEqual({ date: true, comparedWith: true });
    expect(body.hours).toHaveLength(24);
    expect(body.hours[14]).toMatchObject({ hour: 14, cups: 2 });
    expect(body.totals.cups).toBe(2);
  });

  it("says a day the mirror never read is not in it — null over HTTP, not 0", async () => {
    const r = await app.inject({ method: "GET", url: `/dashboard/ops/sales-by-hour?viewer=${SUP}&date=2023-10-04` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ covered: { date: false, comparedWith: false }, totals: { cups: null, cupsLastWeekWholeDay: null } });
  });

  it("the command centre's reads: the fleet, the alarms, one machine, a day's report — for a supervisor, not a VMO", async () => {
    for (const url of ["/dashboard/ops/fleet", "/dashboard/ops/alarms", "/dashboard/ops/day-report?date=2023-10-18"]) {
      const ok = await app.inject({ method: "GET", url: `${url}${url.includes("?") ? "&" : "?"}viewer=${SUP}` });
      expect(ok.statusCode, url).toBe(200);
      const no = await app.inject({ method: "GET", url: `${url}${url.includes("?") ? "&" : "?"}viewer=${VMO}` });
      expect(no.statusCode, url).toBe(403);
    }
    const fleet = (await app.inject({ method: "GET", url: `/dashboard/ops/fleet?viewer=${SUP}` })).json() as { counts: { total: number }; machines: unknown[] };
    expect(fleet.counts.total).toBe(fleet.machines.length);
    const report = (await app.inject({ method: "GET", url: `/dashboard/ops/day-report?viewer=${SUP}&date=2023-10-18` })).json() as {
      machines: { cups: number }[];
      totals: { cups: number };
    };
    expect(report.totals.cups).toBe(report.machines.reduce((n, m) => n + m.cups, 0));
    expect((await app.inject({ method: "GET", url: `/dashboard/ops/machines/98765?viewer=${SUP}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/dashboard/ops/machines/abc?viewer=${SUP}` })).statusCode).toBe(400);
  });

  it("refuses a VMO (no Televend access), and a day that is not a date or has not begun", async () => {
    const vmo = await app.inject({ method: "GET", url: `/dashboard/ops/sales-by-hour?viewer=${VMO}&date=2023-10-18` });
    expect(vmo.statusCode).toBe(403);
    expect(vmo.json()).toMatchObject({ error: { code: "forbidden" } });
    expect((await app.inject({ method: "GET", url: `/dashboard/ops/sales-by-hour?viewer=${SUP}&date=18-10-2023` })).statusCode).toBe(400);
    const future = await app.inject({ method: "GET", url: `/dashboard/ops/sales-by-hour?viewer=${SUP}&date=2999-01-01` });
    expect(future.statusCode).toBe(400);
    expect(future.json()).toMatchObject({ error: { code: "bad_day" } });
  });
});
