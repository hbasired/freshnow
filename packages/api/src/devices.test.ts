import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createEnrolment, currentNoticeHash, DEMO_CEO_ID, getServiceSql, issueSetupCode, loadViewer, recordConsent } from "@freshnow/core";
import { buildServer } from "./server.js";

/**
 * Phone sign-in over HTTP (TASK-058, D210), with real sign-in switched on (SUPABASE_URL set, as in
 * auth.test.ts): the phone's own calls, and what a phone's token may and may not reach. The logic is
 * tested in core (device-auth.test.ts); this is the translation and the auth hook.
 */
const app = buildServer(false);
const TAG = `DEVAPI-${randomUUID().slice(0, 6)}`;
const SUP = randomUUID();
const VMO = randomUUID();
const PIN = "582917";
const saved = { url: process.env.SUPABASE_URL, pepper: process.env.APP_PIN_PEPPER };
const phones: string[] = [];

const signedIn = () => {
  // Real sign-in on: the dashboard hook checks every token. Nothing here is a Supabase token, so the
  // address is never called.
  process.env.SUPABASE_URL = "http://127.0.0.1:9";
};
const demo = () => {
  delete process.env.SUPABASE_URL;
};

beforeAll(async () => {
  process.env.APP_PIN_PEPPER = "test-pepper-for-device-api-0123456789abcdef";
  const sql = getServiceSql();
  await sql`insert into employee (id, display_name, status, is_synthetic, access_role, manager_employee_id)
            values (${SUP}, ${`Sara ${TAG}`}, 'active', true, 'supervisor', ${DEMO_CEO_ID})`;
  await sql`insert into employee (id, display_name, status, is_synthetic, access_role, manager_employee_id)
            values (${VMO}, ${`Kiran ${TAG}`}, 'active', true, 'vmo', ${SUP})`;
  await recordConsent({ employeeId: VMO, noticeHash: currentNoticeHash(), via: "app" });
});

afterAll(async () => {
  if (saved.url === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = saved.url;
  if (saved.pepper === undefined) delete process.env.APP_PIN_PEPPER;
  else process.env.APP_PIN_PEPPER = saved.pepper;
  const sql = getServiceSql();
  const people = [SUP, VMO];
  await sql`delete from app_session where device_id = any(${phones}) or employee_id = any(${people})`;
  await sql`delete from app_credential where device_id = any(${phones}) or employee_id = any(${people})`;
  await sql`delete from app_setup_code where employee_id = any(${people}) or used_on_device = any(${phones})`;
  await sql`delete from device_enrolment where device_id = any(${phones}) or bound_employee_id = any(${people}) or label like ${`${TAG}%`}`;
  await sql`delete from device where id = any(${phones})`;
  await sql`delete from notification_outbox where recipient_employee_id = any(${people})`;
  await sql`delete from consent_record where employee_id = any(${people})`;
  await sql`delete from audit_log where action like 'app.%' or action like 'device.%'`;
  await sql`update employee set manager_employee_id = null where id = any(${people})`;
  await sql`delete from employee where id = any(${people})`;
  await app.close();
  await closeDb();
});

const post = (url: string, payload: object, headers: Record<string, string> = {}) => app.inject({ method: "POST", url, payload, headers });

async function enrolledPhone() {
  const ceo = (await loadViewer(DEMO_CEO_ID))!;
  const e = await createEnrolment({ actor: ceo, kind: "company", label: `${TAG} van phone` });
  const r = await post("/device/enrol", { code: e.code, platform: "android", model: "test" });
  expect(r.statusCode).toBe(201);
  expect(r.headers["cache-control"]).toBe("no-store");
  const d = r.json() as { deviceId: string; deviceSecret: string };
  phones.push(d.deviceId);
  return { d, headers: { "x-device-id": d.deviceId, "x-device-secret": d.deviceSecret } };
}

async function setUp(headers: Record<string, string>) {
  const sup = (await loadViewer(SUP))!;
  const code = await issueSetupCode({ actor: sup, employeeId: VMO });
  const r = await post("/device/credentials", { setupCode: code.code, pin: PIN }, headers);
  expect(r.statusCode).toBe(201);
  return (r.json() as { personSecret: string }).personSecret;
}

describe("a phone, end to end", () => {
  it("enrols, sets a person up, signs them in — and the token opens /dashboard/me and nothing else", async () => {
    signedIn();
    const { headers } = await enrolledPhone();
    const personSecret = await setUp(headers);
    const people = await post("/device/people", {}, headers);
    expect(people.json()).toEqual({ people: [{ employeeId: VMO, name: `Kiran ${TAG.charAt(0)}.`, waiting: false }] });

    const s = await post("/device/sign-in", { employeeId: VMO, personSecret, pin: PIN }, headers);
    expect(s.statusCode).toBe(200);
    const t = s.json() as { accessToken: string; refreshToken: string; failedSinceLastSignIn: number };
    expect(t.failedSinceLastSignIn).toBe(0);
    const as = { authorization: `Bearer ${t.accessToken}` };

    const me = await app.inject({ method: "GET", url: "/dashboard/me", headers: as });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { employeeId: string }).employeeId).toBe(VMO);

    // Everything else is closed to a phone's token, whatever the person's role.
    const day = await app.inject({ method: "GET", url: "/dashboard/day?date=2026-10-16", headers: as });
    expect(day.statusCode).toBe(403);
    expect(day.json()).toMatchObject({ error: { code: "not_in_app" } });
    expect((await post("/dashboard/devices/enrolments", { kind: "company", label: "x" }, as)).statusCode).toBe(403);
    // A token that was never issued is nobody's.
    expect((await app.inject({ method: "GET", url: "/dashboard/me", headers: { authorization: `Bearer fna_${"A".repeat(43)}` } })).statusCode).toBe(401);

    // Signing out ends the token at once.
    expect((await post("/device/sign-out", { refreshToken: t.refreshToken }, headers)).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/dashboard/me", headers: as })).statusCode).toBe(401);
  });

  it("wrong PINs: the fifth says when to try again, and the next try is told to wait", async () => {
    signedIn();
    const { headers } = await enrolledPhone();
    const personSecret = await setUp(headers);
    let last = await post("/device/sign-in", { employeeId: VMO, personSecret, pin: "940361" }, headers);
    for (let i = 2; i <= 5; i++) last = await post("/device/sign-in", { employeeId: VMO, personSecret, pin: "940361" }, headers);
    expect(last.statusCode).toBe(401);
    expect(last.headers["retry-after"]).toBe("60");
    expect(last.json()).toMatchObject({ error: { code: "wrong_pin", attemptsLeft: 5 } });
    const wait = await post("/device/sign-in", { employeeId: VMO, personSecret, pin: PIN }, headers);
    expect(wait.statusCode).toBe(429);
    expect(Number(wait.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("the phone's id and secret travel in headers: without them 400, with a wrong secret 401", async () => {
    const { d } = await enrolledPhone();
    expect((await post("/device/people", {})).statusCode).toBe(400);
    const wrong = await post("/device/people", {}, { "x-device-id": d.deviceId, "x-device-secret": "x".repeat(43) });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({ error: { code: "unknown_device" } });
  });
});

describe("the dashboard side", () => {
  it("the CEO or an Admin enrols a phone and gets the QR's text; a VMO cannot", async () => {
    demo();
    const r = await post(`/dashboard/devices/enrolments?viewer=${DEMO_CEO_ID}`, { kind: "company", label: `${TAG} spare` });
    expect(r.statusCode).toBe(201);
    expect((r.json() as { qr: string }).qr).toMatch(/^freshnow-enrol:v1:[2-9A-HJ-NP-Z]{20}$/);
    expect((await post(`/dashboard/devices/enrolments?viewer=${VMO}`, { kind: "company", label: `${TAG} spare` })).statusCode).toBe(403);
    // A lead sets their own report up; the code is shown once.
    const code = await post(`/dashboard/people/${VMO}/phone-setup-code?viewer=${SUP}`, {});
    expect(code.statusCode).toBe(201);
    expect((code.json() as { code: string }).code).toMatch(/^[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}$/);
  });

  it("the activity feed leaves out sign-ins and sign-outs — an attendance log — but shows wrong PINs", async () => {
    demo();
    // The sign-ins above are in the audit trail …
    const [held] = await getServiceSql()<{ n: number }[]>`select count(*)::int as n from audit_log where action in ('app.signed_in', 'app.signed_out')`;
    expect(held!.n).toBeGreaterThan(0);
    // … and not on the CEO's screen.
    const r = await app.inject({ method: "GET", url: `/dashboard/activity?viewer=${DEMO_CEO_ID}` });
    expect(r.statusCode).toBe(200);
    const actions = (r.json() as { action: string }[]).map((a) => a.action);
    expect(actions).not.toContain("app.signed_in");
    expect(actions).not.toContain("app.signed_out");
    expect(actions).toContain("app.sign_in_failed");
  });
});
