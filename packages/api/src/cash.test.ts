import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, DEMO_CEO_ID, getServiceSql } from "@freshnow/core";
import { buildServer } from "./server.js";

/** The Cash portal over HTTP (TASK-061): who may do what, the same entry twice, refusals in words. */
const app = buildServer(false);
const TAG = `CASHAPI-${randomUUID().slice(0, 6)}`;
const VMO = randomUUID();
const AUD = randomUUID();
const KEEP = randomUUID();
const STAFF: string[] = [VMO, AUD, KEEP];
const ASSET = 99_781;
let MACHINE = "";
const sql = () => getServiceSql();

const call = (method: "GET" | "POST", url: string, viewer: string, payload?: unknown) =>
  app.inject({ method, url: `${url}${url.includes("?") ? "&" : "?"}viewer=${viewer}`, ...(payload === undefined ? {} : { payload: payload as object }) });

async function photo(by: string): Promise<string> {
  const sha = createHash("sha256").update(`${TAG}-${randomUUID()}`).digest("hex");
  const [r] = await sql()<{ id: string }[]>`
    insert into media_object (sha256, kind, mime, bytes, storage_path, uploaded_by, retention_class, retention_until, scan_status, is_synthetic)
    values (${sha}, 'photo', 'image/jpeg', 1000, ${`test/${sha}.jpg`}, ${by}, 'receipt', now() + interval '1 day', 'not_scanned', true) returning id`;
  return r!.id;
}

beforeAll(async () => {
  for (const [pid, name, role] of [
    [VMO, "Driver", "vmo"],
    [AUD, "Auditor", "cash_auditor"],
    [KEEP, "Keeper", "warehouse_keeper"],
  ] as const) {
    await sql()`insert into employee (id, display_name, status, is_synthetic, access_role, manager_employee_id)
                values (${pid}, ${`${TAG} ${name}`}, 'active', true, ${role}, ${DEMO_CEO_ID})`;
  }
  MACHINE = (await sql()<{ id: string }[]>`insert into machine (asset_no, label, is_synthetic) values (${ASSET}, ${`${TAG} Expo-781`}, true) returning id`)[0]!.id;
});

afterAll(async () => {
  const s = sql();
  const shifts = (await s<{ id: string }[]>`select id from shift where employee_id = any(${STAFF}::uuid[])`).map((r) => r.id);
  await s`select cash_purge_shifts(${shifts}::uuid[])`;
  await s`delete from cash_account where employee_id = any(${STAFF}::uuid[]) or machine_id = ${MACHINE}`;
  await s`delete from media_object where uploaded_by = any(${STAFF}::uuid[])`;
  await s`delete from machine where id = ${MACHINE}`;
  await s`delete from notification_outbox where recipient_employee_id = any(${STAFF}::uuid[])`;
  await s`delete from audit_log where actor = any(${STAFF.map((x) => `employee:${x}`)})`;
  await s`delete from employee where id = any(${STAFF}::uuid[])`;
  await app.close();
  await closeDb();
});

describe("the Cash API", () => {
  it("a driver records a collection and a deposit; the same entry again changes nothing", async () => {
    const entry = randomUUID();
    const body = { id: entry, machineAssetNo: ASSET, amountFils: 64_000, mediaIds: [await photo(VMO)] };
    const r1 = await call("POST", "/dashboard/cash/collections", VMO, body);
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toMatchObject({ docId: entry, replay: false });
    expect((await call("POST", "/dashboard/cash/collections", VMO, body)).json()).toMatchObject({ replay: true });
    const dep = await call("POST", "/dashboard/cash/deposits", VMO, {
      id: randomUUID(),
      amountFils: 64_000,
      denominations: { "500": 1, "100": 1, "20": 2 },
      cdmTxnNo: "T-9",
      mediaIds: [await photo(VMO)],
    });
    expect(dep.statusCode).toBe(200);
    const home = (await call("GET", "/dashboard/cash/home", VMO)).json() as { heldFils: number; openShift: { collectedFils: number; depositedFils: number } };
    expect(home).toMatchObject({ heldFils: 0, openShift: { collectedFils: 64_000, depositedFils: 64_000 } });
    expect(((await call("GET", "/dashboard/cash/machines", VMO)).json() as { assetNo: number }[]).some((m) => m.assetNo === ASSET)).toBe(true);
  });

  it("refuses in words: no photo, more than held, a keeper opening the portal, a driver reading everyone's shifts, fils with a fraction", async () => {
    const noPhoto = await call("POST", "/dashboard/cash/collections", VMO, { id: randomUUID(), machineAssetNo: ASSET, amountFils: 100 });
    expect(noPhoto.statusCode).toBe(400);
    expect(noPhoto.json()).toMatchObject({ error: { code: "photo_needed" } });
    const tooMuch = await call("POST", "/dashboard/cash/deposits", VMO, { id: randomUUID(), amountFils: 100, mediaIds: [await photo(VMO)] });
    expect(tooMuch.statusCode).toBe(409);
    expect(tooMuch.json()).toMatchObject({ error: { code: "not_enough_cash" } });
    expect((await call("GET", "/dashboard/cash/home", KEEP)).statusCode).toBe(403);
    expect((await call("GET", "/dashboard/cash/shifts", VMO)).statusCode).toBe(403);
    expect((await call("POST", "/dashboard/cash/collections", VMO, { id: randomUUID(), machineAssetNo: ASSET, amountFils: 10.5, mediaIds: [] })).statusCode).toBe(400);
    expect((await call("GET", `/dashboard/cash/shifts/${randomUUID()}`, VMO)).statusCode).toBe(404);
  });

  it("the driver ends the shift; the auditor sees it to check, asks, and the driver answers", async () => {
    expect((await call("POST", "/dashboard/cash/shifts/end", VMO, {})).statusCode).toBe(200);
    const toCheck = ((await call("GET", "/dashboard/cash/home", AUD)).json() as { toCheck: { id: string; employee: { id: string } }[] }).toCheck;
    const shift = toCheck.find((s) => s.employee.id === VMO)!;
    expect(shift).toBeDefined();
    expect((await call("POST", `/dashboard/cash/shifts/${shift.id}/audit`, AUD, { outcome: "query", note: "Which machine was the 640?" })).statusCode).toBe(200);
    expect((await call("POST", `/dashboard/cash/shifts/${shift.id}/answer`, VMO, { note: "Expo 781 — the photo shows its sticker." })).statusCode).toBe(200);
    expect((await call("POST", `/dashboard/cash/shifts/${shift.id}/audit`, VMO, { outcome: "ok" })).statusCode).toBe(403);
    expect((await call("POST", `/dashboard/cash/shifts/${shift.id}/audit`, AUD, { outcome: "ok" })).json()).toMatchObject({ outcome: "ok" });
    const seen = (await call("GET", `/dashboard/cash/shifts/${shift.id}`, AUD)).json() as { audit: { outcome: string }; answer: { note: string } };
    expect(seen).toMatchObject({ audit: { outcome: "ok" }, answer: { note: "Expo 781 — the photo shows its sticker." } });
  });
});
