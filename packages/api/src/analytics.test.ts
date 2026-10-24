import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, DEMO_CEO_ID, getServiceSql } from "@freshnow/core";
import { buildServer } from "./server.js";

/**
 * The Analytics portal over HTTP (TASK-070): who may read and who may correct, the range checked, refusals in words.
 * The figures themselves are tested in core (analytics.test.ts); here, that the routes carry them and refuse well.
 */
const app = buildServer(false);
const TAG = `ANAPI-${randomUUID().slice(0, 6)}`;
const OPS = randomUUID();
const SUP = randomUUID();
const VMO = randomUUID();
const STAFF = [OPS, SUP, VMO];
const TV = 994_001;
const ASSET = 99_401;
let MACHINE = "";
const sql = () => getServiceSql();
const yesterday = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(new Date(Date.now() - 86_400_000));
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(new Date());

const call = (method: "GET" | "PUT", url: string, viewer: string, payload?: unknown) =>
  app.inject({ method, url: `${url}${url.includes("?") ? "&" : "?"}viewer=${viewer}`, ...(payload === undefined ? {} : { payload: payload as object }) });

beforeAll(async () => {
  for (const [pid, name, role] of [
    [OPS, "Ops", "ops_head"],
    [SUP, "Sup", "supervisor"],
    [VMO, "Driver", "vmo"],
  ] as const) {
    await sql()`insert into employee (id, display_name, status, is_synthetic, access_role, manager_employee_id)
                values (${pid}, ${`${TAG} ${name}`}, 'active', true, ${role}, ${DEMO_CEO_ID})`;
  }
  await sql()`insert into tv_machine (televend_id, caption, asset_no, enabled, region_caption, last_status, connection_status, raw, is_synthetic)
              values (${TV}, ${`${TAG} Mall-${ASSET}-DXB`}, ${ASSET}, true, ${`${TAG} Malls`}, 1, 1, '{}'::jsonb, true)`;
  MACHINE = (await sql()<{ id: string }[]>`insert into machine (asset_no, label, is_synthetic) values (${ASSET}, ${`${TAG} Mall`}, true) returning id`)[0]!.id;
  await sql()`insert into machine_placement (machine_id, tv_machine_id, source, is_synthetic) values (${MACHINE}, ${TV}, 'manual', true)`;
});

afterAll(async () => {
  await sql()`delete from machine_placement where tv_machine_id = ${TV}`;
  await sql()`delete from tv_machine where televend_id = ${TV}`;
  await sql()`delete from audit_log where entity = 'machine' and entity_id = ${MACHINE}`;
  await sql()`delete from machine where id = ${MACHINE}`;
  await sql()`delete from employee where id = any(${STAFF}::uuid[])`;
  await app.close();
  await closeDb();
});

describe("the Analytics API", () => {
  it("answers the people who run the machines with the period, the figures and the machines", async () => {
    const r = await call("GET", `/dashboard/analytics/performance?from=${yesterday}&to=${yesterday}`, SUP);
    expect(r.statusCode).toBe(200);
    const body = r.json() as { period: { days: number }; before: { shiftDays: number }; machines: { machineTvId: number; category: string }[] };
    expect(body.period.days).toBe(1);
    expect(body.before.shiftDays).toBe(7);
    expect(body.machines.find((m) => m.machineTvId === TV)).toMatchObject({ category: `${TAG} Malls` });
    const d = await call("GET", `/dashboard/analytics/machines/${TV}/daily?from=${yesterday}&to=${yesterday}`, SUP);
    expect(d.statusCode).toBe(200);
    expect((d.json() as { days: unknown[] }).days).toHaveLength(1);
  });

  it("refuses in words: a driver reading, today (not a whole day), a range back to front, an unknown machine", async () => {
    const driver = await call("GET", `/dashboard/analytics/performance?from=${yesterday}&to=${yesterday}`, VMO);
    expect(driver.statusCode).toBe(403);
    expect(driver.json()).toMatchObject({ error: { code: "not_allowed" } });
    const now = await call("GET", `/dashboard/analytics/performance?from=${today}&to=${today}`, SUP);
    expect(now.statusCode).toBe(400);
    expect(now.json()).toMatchObject({ error: { code: "not_whole_day" } });
    const back = await call("GET", `/dashboard/analytics/performance?from=${yesterday}&to=2020-01-01`, SUP);
    expect(back.json()).toMatchObject({ error: { code: "bad_range" } });
    expect((await call("GET", `/dashboard/analytics/performance?from=yesterday&to=${yesterday}`, SUP)).statusCode).toBe(400);
    expect((await call("GET", `/dashboard/analytics/machines/999999999/daily?from=${yesterday}&to=${yesterday}`, SUP)).statusCode).toBe(404);
  });

  it("recomputes for the categories chosen, sent as a JSON array of names, and refuses a malformed list (TASK-075)", async () => {
    const cats = encodeURIComponent(JSON.stringify([`${TAG} Malls`]));
    const r = await call("GET", `/dashboard/analytics/performance?from=${yesterday}&to=${yesterday}&categories=${cats}`, SUP);
    expect(r.statusCode).toBe(200);
    const body = r.json() as { selection: { categories: string[] | null; available: { category: string }[] }; machines: { machineTvId: number }[] };
    expect(body.selection.categories).toEqual([`${TAG} Malls`]);
    expect(body.machines.find((m) => m.machineTvId === TV)).toBeTruthy();
    const every = (await call("GET", `/dashboard/analytics/performance?from=${yesterday}&to=${yesterday}`, SUP)).json() as { selection: { categories: null } };
    expect(every.selection.categories).toBeNull();
    expect((await call("GET", `/dashboard/analytics/performance?from=${yesterday}&to=${yesterday}&categories=Malls`, SUP)).statusCode).toBe(400);
    const long = encodeURIComponent(JSON.stringify(["x".repeat(61)]));
    expect((await call("GET", `/dashboard/analytics/performance?from=${yesterday}&to=${yesterday}&categories=${long}`, SUP)).statusCode).toBe(400);
  });

  it("opens a profile — the categories chosen, a category, a machine — and says when a machine is not known", async () => {
    const sel = await call("GET", `/dashboard/analytics/profile?scope=selection&from=${yesterday}&to=${yesterday}`, SUP);
    expect(sel.statusCode).toBe(200);
    expect(sel.json()).toMatchObject({ scope: { kind: "selection", label: "Every category" }, days: [{ date: yesterday }] });
    const cat = await call("GET", `/dashboard/analytics/profile?scope=category&category=${encodeURIComponent(`${TAG} Malls`)}&from=${yesterday}&to=${yesterday}`, SUP);
    expect(cat.json()).toMatchObject({ scope: { kind: "category", category: `${TAG} Malls`, machines: 1 } });
    const one = await call("GET", `/dashboard/analytics/profile?scope=machine&machine=${MACHINE}&from=${yesterday}&to=${yesterday}`, SUP);
    expect(one.json()).toMatchObject({ scope: { kind: "machine", machineTvId: TV, assetNo: ASSET } });
    expect((await call("GET", `/dashboard/analytics/profile?scope=machine&machine=999999999&from=${yesterday}&to=${yesterday}`, SUP)).statusCode).toBe(404);
    expect((await call("GET", `/dashboard/analytics/profile?scope=everything&from=${yesterday}&to=${yesterday}`, SUP)).statusCode).toBe(400);
    expect((await call("GET", `/dashboard/analytics/profile?scope=selection&from=${yesterday}&to=${yesterday}`, VMO)).statusCode).toBe(403);
  });

  it("compares two days, two periods, two machines and two categories — and refuses the same one twice", async () => {
    const weekAgo = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(new Date(Date.now() - 8 * 86_400_000));
    const days = await call("GET", `/dashboard/analytics/compare?mode=days&a=${weekAgo}&b=${yesterday}`, SUP);
    expect(days.statusCode).toBe(200);
    expect(days.json()).toMatchObject({ mode: "days", rows: expect.arrayContaining([expect.objectContaining({ id: "cups" })]) });
    const periods = await call("GET", `/dashboard/analytics/compare?mode=periods&aFrom=${weekAgo}&aTo=${weekAgo}&bFrom=${yesterday}&bTo=${yesterday}`, SUP);
    expect(periods.json()).toMatchObject({ mode: "periods" });
    const same = await call("GET", `/dashboard/analytics/compare?mode=machines&from=${yesterday}&to=${yesterday}&a=${TV}&b=${MACHINE}`, SUP);
    expect(same.statusCode).toBe(400);
    expect(same.json()).toMatchObject({ error: { code: "same_twice" } });
    const cats = await call("GET", `/dashboard/analytics/compare?mode=categories&from=${yesterday}&to=${yesterday}&a=${encodeURIComponent(`${TAG} Malls`)}&b=Nowhere`, SUP);
    expect(cats.statusCode).toBe(200);
    expect((await call("GET", `/dashboard/analytics/compare?mode=machines&from=${yesterday}&to=${yesterday}&a=${TV}&b=999999999`, SUP)).statusCode).toBe(404);
    expect((await call("GET", `/dashboard/analytics/compare?mode=weeks&a=${yesterday}&b=${yesterday}`, SUP)).statusCode).toBe(400);
    expect((await call("GET", `/dashboard/analytics/compare?mode=days&a=${weekAgo}&b=${yesterday}`, VMO)).statusCode).toBe(403);
  });

  it("lets the Ops Head correct a category and the Supervisor not", async () => {
    const sup = await call("PUT", `/dashboard/analytics/machines/${TV}/category`, SUP, { category: "Not counted" });
    expect(sup.statusCode).toBe(403);
    const ops = await call("PUT", `/dashboard/analytics/machines/${TV}/category`, OPS, { category: "Not counted", note: "test machine" });
    expect(ops.statusCode).toBe(200);
    expect(ops.json()).toEqual({ machineId: expect.any(String), machineTvId: TV, category: "Not counted", corrected: true });
    const choices = (await call("GET", "/dashboard/analytics/categories", SUP)).json() as string[];
    expect(choices).toEqual(expect.arrayContaining([`${TAG} Malls`, "Not counted"]));
    expect((await call("PUT", `/dashboard/analytics/machines/${TV}/category`, OPS, { category: "x".repeat(61) })).statusCode).toBe(400);
  });
});
