import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, DEMO_CEO_ID, getServiceSql } from "@freshnow/core";
import { buildServer } from "./server.js";

/**
 * The Route portal over HTTP (TASK-061 part 2): a Supervisor plans a team's shift, the driver on it starts a visit at
 * the machine — by its sticker or its number — adds the proof and ends it, and the Supervisor sees the sheet's OK / NO.
 * Who may do what, the same request twice, and refusals in words.
 */
const app = buildServer(false);
const TAG = `RTAPI-${randomUUID().slice(0, 6)}`;
const SUP = randomUUID();
const VMO = randomUUID();
const KEEP = randomUUID();
const STAFF: string[] = [SUP, VMO, KEEP];
const ASSET = 99_771;
const OTHER = 99_772;
const MACHINES: string[] = [];
let TOKEN = "";
const sql = () => getServiceSql();
const DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(new Date());

const call = (method: "GET" | "POST" | "PUT", url: string, viewer: string, payload?: unknown) =>
  app.inject({ method, url: `${url}${url.includes("?") ? "&" : "?"}viewer=${viewer}`, ...(payload === undefined ? {} : { payload: payload as object }) });

async function media(by: string, kind: "photo" | "video"): Promise<string> {
  const sha = createHash("sha256").update(`${TAG}-${randomUUID()}`).digest("hex");
  const [r] = await sql()<{ id: string }[]>`
    insert into media_object (sha256, kind, mime, bytes, storage_path, uploaded_by, retention_class, retention_until, scan_status, is_synthetic)
    values (${sha}, ${kind}, ${kind === "photo" ? "image/jpeg" : "video/mp4"}, 1000, ${`test/${sha}`}, ${by},
            ${kind === "photo" ? "evidence" : "video"}, now() + interval '1 day', 'not_scanned', true) returning id`;
  return r!.id;
}

beforeAll(async () => {
  for (const [pid, name, role] of [
    [SUP, "Planner", "supervisor"],
    [VMO, "Driver", "vmo"],
    [KEEP, "Keeper", "warehouse_keeper"],
  ] as const) {
    await sql()`insert into employee (id, display_name, status, is_synthetic, access_role, manager_employee_id)
                values (${pid}, ${`${TAG} ${name}`}, 'active', true, ${role}, ${DEMO_CEO_ID})`;
  }
  for (const [no, label] of [
    [ASSET, `${TAG} Mina-771`],
    [OTHER, `${TAG} Wasl-772`],
  ] as const) {
    const [m] = await sql()<{ id: string; qr_token: string }[]>`
      insert into machine (asset_no, label, is_synthetic) values (${no}, ${label}, true) returning id, qr_token`;
    MACHINES.push(m!.id);
    if (no === ASSET) TOKEN = m!.qr_token;
  }
});

afterAll(async () => {
  const s = sql();
  const visits = (await s<{ id: string }[]>`select id from visit where employee_id = any(${STAFF}::uuid[])`).map((r) => r.id);
  await s`select visit_purge(${visits}::uuid[])`;
  const plans = (await s<{ id: string }[]>`select id from route_plan where created_by = any(${STAFF}::uuid[])`).map((r) => r.id);
  await s`delete from route_stop where plan_id = any(${plans}::uuid[])`;
  await s`delete from route_plan_member where plan_id = any(${plans}::uuid[])`;
  await s`delete from route_plan where id = any(${plans}::uuid[])`;
  await s`delete from media_object where uploaded_by = any(${STAFF}::uuid[])`;
  await s`delete from machine where id = any(${MACHINES}::uuid[])`;
  await s`delete from notification_outbox where recipient_employee_id = any(${STAFF}::uuid[])`;
  await s`delete from audit_log where actor = any(${STAFF.map((x) => `employee:${x}`)})`;
  await s`delete from employee where id = any(${STAFF}::uuid[])`;
  await app.close();
  await closeDb();
});

describe("the Route API", () => {
  const plan = randomUUID();
  const stop = randomUUID();
  const body = () => ({
    id: plan,
    businessDate: DAY,
    shiftWindow: "day",
    name: `${TAG} Team`,
    memberIds: [VMO],
    stops: [{ id: stop, machineAssetNo: ASSET, tasks: ["full_service", "resort"], crates: 3, evidence: ["normal_photo", "resorting_photo"] }],
  });

  it("a Supervisor makes a team's plan; sent again, it is the same plan; the driver sees it on their round", async () => {
    const r1 = await call("POST", "/dashboard/route/plans", SUP, body());
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toMatchObject({ id: plan, created: true, crates: 3 });
    const r2 = await call("POST", "/dashboard/route/plans", SUP, body());
    expect(r2.json()).toMatchObject({ id: plan, created: false });
    const home = (await call("GET", "/dashboard/route/home", VMO)).json() as { can: { plan: boolean; visit: boolean }; round: { plans: { id: string; stops: { id: string }[] }[] } };
    expect(home.can).toMatchObject({ plan: false, visit: true });
    expect(home.round.plans.map((p) => p.id)).toContain(plan);
    expect(home.round.plans.find((p) => p.id === plan)!.stops.map((s) => s.id)).toEqual([stop]);
  });

  it("the driver starts at the machine by its sticker, adds the proof, ticks the tasks and ends; the Supervisor sees OK and NO", async () => {
    const sticker = await call("GET", `/dashboard/route/sticker/${TOKEN}`, VMO);
    expect(sticker.json()).toMatchObject({ assetNo: ASSET });
    const visit = randomUUID();
    const s1 = await call("POST", "/dashboard/route/visits", VMO, { id: visit, qrToken: TOKEN });
    expect(s1.statusCode).toBe(200);
    expect(s1.json()).toMatchObject({ visitId: visit, stopId: stop, replay: false });
    expect((await call("POST", "/dashboard/route/visits", VMO, { id: visit, qrToken: TOKEN })).json()).toMatchObject({ replay: true });

    const ev = await call("POST", `/dashboard/route/visits/${visit}/evidence`, VMO, { kind: "normal_photo", mediaId: await media(VMO, "photo") });
    expect(ev.statusCode).toBe(200);
    expect(ev.json()).toMatchObject({ missing: ["resorting_photo"] });
    const tasks = await call("POST", `/dashboard/route/visits/${visit}/tasks`, VMO, { tasks: ["full_service"] });
    expect(tasks.json()).toMatchObject({ tasksDone: ["full_service"] });
    const end = await call("POST", `/dashboard/route/visits/${visit}/end`, VMO, {});
    expect(end.json()).toMatchObject({ visitId: visit, missing: ["resorting_photo"], tasksLeft: ["resort"] });

    const grid = (await call("GET", `/dashboard/route/grid?date=${DAY}`, SUP)).json() as { rows: { stop: { id: string; missing: string[]; visits: { startedHow: string }[] } }[] };
    const row = grid.rows.find((r) => r.stop.id === stop)!;
    expect(row.stop.missing).toEqual(["resorting_photo"]);
    expect(row.stop.visits.map((v) => v.startedHow)).toEqual(["qr"]);
  });

  it("refuses in words: a driver planning, a keeper reading the plans, a photo as the dispenser's video, a second open visit, an unknown sticker", async () => {
    const plans = await call("POST", "/dashboard/route/plans", VMO, { ...body(), id: randomUUID() });
    expect(plans.statusCode).toBe(403);
    expect((await call("GET", `/dashboard/route/plans?date=${DAY}`, KEEP)).statusCode).toBe(403);
    // The keeper's round is empty and offers nothing — it is not refused, there is simply nothing for them.
    expect((await call("GET", "/dashboard/route/home", KEEP)).json()).toMatchObject({ can: { plan: false, visit: false }, round: { plans: [] }, openVisit: null });

    const visit = randomUUID();
    expect((await call("POST", "/dashboard/route/visits", VMO, { id: visit, machineAssetNo: OTHER })).json()).toMatchObject({ visitId: visit, stopId: null });
    const asVideo = await call("POST", `/dashboard/route/visits/${visit}/evidence`, VMO, { kind: "dispenser_video", mediaId: await media(VMO, "photo") });
    expect(asVideo.statusCode).toBe(400);
    expect(asVideo.json()).toMatchObject({ error: { code: "video_needed" } });
    expect((await call("POST", `/dashboard/route/visits/${visit}/evidence`, VMO, { kind: "dispenser_video", mediaId: await media(VMO, "video") })).statusCode).toBe(200);
    const second = await call("POST", "/dashboard/route/visits", VMO, { id: randomUUID(), machineAssetNo: ASSET });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: { code: "visit_open" } });
    // The Supervisor may end a visit the driver forgot to end; then the driver can start the next.
    expect((await call("POST", `/dashboard/route/visits/${visit}/end`, SUP, {})).statusCode).toBe(200);

    expect((await call("GET", `/dashboard/route/sticker/${randomUUID()}`, VMO)).statusCode).toBe(404);
    const both = await call("POST", "/dashboard/route/visits", VMO, { id: randomUUID(), machineAssetNo: ASSET, qrToken: TOKEN });
    expect(both.statusCode).toBe(400);
  });

  it("a machine served only at night is said when it goes on a day plan; only a planner sets that", async () => {
    expect((await call("PUT", `/dashboard/route/machines/${OTHER}/rule`, VMO, { shift: "night" })).statusCode).toBe(403);
    const rule = await call("PUT", `/dashboard/route/machines/${OTHER}/rule`, SUP, { shift: "night", note: "loading bay" });
    expect(rule.json()).toMatchObject({ assetNo: OTHER, shift: "night", note: "loading bay" });
    const r = await call("POST", "/dashboard/route/plans", SUP, {
      ...body(),
      id: randomUUID(),
      name: `${TAG} Day team 2`,
      stops: [{ id: randomUUID(), machineAssetNo: OTHER, tasks: ["cash"], evidence: [] }],
    });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { warnings: string[] }).warnings.join(" ")).toMatch(/night/i);
  });
});
