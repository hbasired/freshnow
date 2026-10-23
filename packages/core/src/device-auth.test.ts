import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { logAudit } from "./audit.js";
import { exportPersonData } from "./compliance-evidence.js";
import { closeDb, getServiceSql } from "./db.js";
import {
  appSessionFor,
  bindCredential,
  changePin,
  companySessionEnd,
  createEnrolment,
  devicePeople,
  enrolDevice,
  issueSetupCode,
  listDevices,
  pinRefusal,
  pruneAppAuth,
  refreshSession,
  revokeCredential,
  revokeDevice,
  shortName,
  signIn,
  signOut,
} from "./device-auth.js";
import { DEMO_CEO_ID } from "./meta.js";
import { loadViewer, type ViewerOrg } from "./org.js";

/**
 * Phone sign-in (TASK-058, D210) — against the real (throwaway) Postgres, never mocked.
 *
 *   CEO ── ADM (admin)        CEO ── SUP (supervisor) ── VMO, VMO2        CEO ── OUT (employee)
 */
const TAG = `DEVAUTH-${randomUUID().slice(0, 6)}`;
const P = { ADM: randomUUID(), SUP: randomUUID(), VMO: randomUUID(), VMO2: randomUUID(), OUT: randomUUID() };
const V = {} as Record<keyof typeof P | "CEO", ViewerOrg>;
const phones: string[] = [];
const PIN = "582917";
const OTHER = "940361";

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { status: number; code: string; extra: Record<string, unknown> };
  }
  throw new Error("expected a refusal");
};

async function phone(kind: "company" | "personal", owner?: string) {
  const e = await createEnrolment({ actor: V.ADM, kind, label: `${TAG} ${kind} phone`, ...(owner ? { employeeId: owner } : {}) });
  const d = await enrolDevice({ code: e.code, platform: "android", model: "test" });
  phones.push(d.deviceId);
  return d;
}

async function setUp(d: { deviceId: string; deviceSecret: string }, who: string, pin = PIN, by: ViewerOrg = V.SUP) {
  const code = await issueSetupCode({ actor: by, employeeId: who });
  return bindCredential({ deviceId: d.deviceId, deviceSecret: d.deviceSecret, setupCode: code.code, pin });
}

const sql = () => getServiceSql();

beforeAll(async () => {
  process.env.APP_PIN_PEPPER = "test-pepper-for-device-auth-0123456789abcdef";
  const person = (id: string, name: string, role: string, manager: string) =>
    sql()`insert into employee (id, display_name, status, is_synthetic, access_role, manager_employee_id)
          values (${id}, ${name}, 'active', true, ${role}, ${manager})`;
  await person(P.ADM, `Adam ${TAG}`, "admin", DEMO_CEO_ID);
  await person(P.SUP, `Sara ${TAG}`, "supervisor", DEMO_CEO_ID);
  await person(P.OUT, `Omar ${TAG}`, "employee", DEMO_CEO_ID);
  await person(P.VMO, `Kiran ${TAG}`, "vmo", P.SUP);
  await person(P.VMO2, `Kamran ${TAG}`, "vmo", P.SUP);
  for (const [k, id] of Object.entries({ ...P, CEO: DEMO_CEO_ID })) V[k as keyof typeof V] = (await loadViewer(id))!;
});

afterAll(async () => {
  const all = Object.values(P);
  const s = sql();
  await s`delete from app_session where device_id = any(${phones}) or employee_id = any(${all})`;
  await s`delete from app_credential where device_id = any(${phones}) or employee_id = any(${all})`;
  await s`delete from app_setup_code where employee_id = any(${all}) or created_by = any(${all}) or used_on_device = any(${phones})`;
  await s`delete from device_enrolment where created_by = any(${all}) or bound_employee_id = any(${all}) or device_id = any(${phones})`;
  await s`delete from device where id = any(${phones})`;
  await s`delete from notification_outbox where recipient_employee_id = any(${[...all, DEMO_CEO_ID]}) and idempotency_key like 'security.%'`;
  await s`delete from audit_log where action like 'app.%' or action like 'device.%'`;
  await s`update employee set manager_employee_id = null where id = any(${all})`;
  await s`delete from employee where id = any(${all})`;
  delete process.env.APP_PIN_PEPPER;
  await closeDb();
});

describe("enrolling a phone", () => {
  it("only the CEO or an Admin enrols; a code works once, and a code used twice switches off the phone it made", async () => {
    expect((await refusal(createEnrolment({ actor: V.VMO, kind: "company", label: "x" }))).status).toBe(403);
    const e = await createEnrolment({ actor: V.ADM, kind: "company", label: `${TAG} van 4` });
    expect(e.code).toMatch(/^[2-9A-HJ-NP-Z]{20}$/);
    const d = await enrolDevice({ code: e.code.toLowerCase(), platform: "android" }); // any case
    phones.push(d.deviceId);
    expect(d.deviceSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const again = await refusal(enrolDevice({ code: e.code }));
    expect(again).toMatchObject({ status: 401, code: "bad_code" });
    const [row] = await sql()<{ revoked_at: Date | null; revoke_reason: string | null }[]>`select revoked_at, revoke_reason from device where id = ${d.deviceId}`;
    expect(row?.revoked_at).not.toBeNull(); // the photo of the QR was used: that phone is not trusted
    expect((await refusal(devicePeople(d))).code).toBe("device_revoked");
  });

  it("refuses everything when the server has no pepper", async () => {
    const keep = process.env.APP_PIN_PEPPER;
    delete process.env.APP_PIN_PEPPER;
    try {
      expect(await refusal(createEnrolment({ actor: V.ADM, kind: "company", label: "x" }))).toMatchObject({ status: 503, code: "not_configured" });
    } finally {
      process.env.APP_PIN_PEPPER = keep;
    }
  });
});

describe("setting a person up", () => {
  it("their lead, the CEO or an Admin issues the code — not a stranger; the CEO's and Admins' only the CEO or themselves", async () => {
    await issueSetupCode({ actor: V.SUP, employeeId: P.VMO });
    expect((await refusal(issueSetupCode({ actor: V.OUT, employeeId: P.VMO }))).status).toBe(403);
    expect((await refusal(issueSetupCode({ actor: V.ADM, employeeId: DEMO_CEO_ID }))).status).toBe(403);
    await issueSetupCode({ actor: V.CEO, employeeId: P.ADM });
    await issueSetupCode({ actor: V.ADM, employeeId: P.ADM });
  });

  it("a new code voids the old one", async () => {
    const d = await phone("company");
    const old = await issueSetupCode({ actor: V.SUP, employeeId: P.VMO });
    await issueSetupCode({ actor: V.SUP, employeeId: P.VMO });
    expect((await refusal(bindCredential({ ...d, setupCode: old.code, pin: PIN }))).code).toBe("bad_code");
  });

  it("PINs: digits, 4 to 6 of them, and nothing a colleague would guess first", () => {
    for (const bad of ["12a4", "123", "1234567", "1111", "3456", "9876", "1212", "741852", "1987", "0512", "1305", "130587", "123123"]) {
      expect({ bad, why: pinRefusal(bad) }).toMatchObject({ why: expect.any(String) });
    }
    for (const ok of ["4590", "582917", "73914", "8264"]) expect({ ok, why: pinRefusal(ok) }).toEqual({ ok, why: null });
  });

  it("a shared phone takes anyone with a code but never the CEO or an Admin; a personal phone only its owner", async () => {
    const shared = await phone("company");
    const b = await setUp(shared, P.VMO);
    expect(b.personSecret).toMatch(/^fnp_[A-Za-z0-9_-]{43}$/);
    expect(await refusal(setUp(shared, P.ADM, PIN, V.CEO))).toMatchObject({ status: 403, code: "shared_phone" });
    expect(await refusal(setUp(shared, P.VMO2, "1111"))).toMatchObject({ status: 400, code: "weak_pin" });

    const own = await phone("personal", P.VMO2);
    expect(await refusal(setUp(own, P.VMO))).toMatchObject({ status: 403, code: "not_your_phone" });
    await setUp(own, P.VMO2);
    expect(await devicePeople(shared)).toEqual([{ employeeId: P.VMO, name: "Kiran D.", waiting: false }]);
  });

  it("five wrong set-up codes on one phone lock it for an hour", async () => {
    const d = await phone("company");
    for (let i = 0; i < 5; i++) expect((await refusal(bindCredential({ ...d, setupCode: "AAAAA-AAAAA", pin: PIN }))).code).toBe("bad_code");
    expect(await refusal(bindCredential({ ...d, setupCode: "AAAAA-AAAAA", pin: PIN }))).toMatchObject({ status: 429, code: "phone_locked" });
  });
});

describe("signing in", () => {
  it("needs the person's own secret and the right PIN; wrong PINs slow down, then stop — and the person and their lead are told", async () => {
    const d = await phone("company");
    const b = await setUp(d, P.VMO);
    const me = { ...d, employeeId: P.VMO, personSecret: b.personSecret };
    const t = await signIn({ ...me, pin: PIN });
    expect(t).toMatchObject({ employeeId: P.VMO, failedSinceLastSignIn: 0 });
    expect(t.accessToken).toMatch(/^fna_/);
    expect(t.refreshToken).toMatch(/^fnr_/);

    // Without the person's secret no PIN is even looked at: nothing is counted.
    expect((await refusal(signIn({ ...me, personSecret: "fnp_" + "x".repeat(43), pin: OTHER }))).code).toBe("bad_person_secret");
    const count = async () => (await sql()<{ n: number }[]>`select failed_count as n from app_credential where id = ${b.credentialId}`)[0]!.n;
    expect(await count()).toBe(0);

    for (let i = 1; i <= 4; i++) {
      expect(await refusal(signIn({ ...me, pin: OTHER }))).toMatchObject({ status: 401, code: "wrong_pin", extra: { attemptsLeft: 10 - i } });
    }
    const fifth = await refusal(signIn({ ...me, pin: OTHER }));
    expect(fifth).toMatchObject({ status: 401, code: "wrong_pin", extra: { retryAfterSeconds: 60 } });
    expect((await refusal(signIn({ ...me, pin: PIN }))).code).toBe("slowed"); // even the right PIN waits
    for (let i = 6; i <= 10; i++) {
      await sql()`update app_credential set locked_until = now() - interval '1 second' where id = ${b.credentialId}`;
      const r = await refusal(signIn({ ...me, pin: OTHER }));
      expect(r.code).toBe(i === 10 ? "disabled" : "wrong_pin");
    }
    expect((await refusal(signIn({ ...me, pin: PIN }))).status).toBe(423);

    const told = await sql()<{ recipient_employee_id: string; idempotency_key: string }[]>`
      select recipient_employee_id, idempotency_key from notification_outbox where idempotency_key like ${`security.%:${b.credentialId}:%`}`;
    expect(new Set(told.map((x) => x.recipient_employee_id))).toEqual(new Set([P.VMO, P.SUP]));
    expect(told.some((x) => x.idempotency_key.startsWith("security.wrong_pins:"))).toBe(true);
    expect(told.some((x) => x.idempotency_key.startsWith("security.sign_in_stopped:"))).toBe(true);
  });

  it("a good sign-in says how many wrong PINs came before it; twenty in thirty days stop the person on every phone", async () => {
    const a = await phone("company");
    const b = await phone("company");
    const ca = await setUp(a, P.VMO2);
    await setUp(b, P.VMO2);
    const me = { ...a, employeeId: P.VMO2, personSecret: ca.personSecret };
    await refusal(signIn({ ...me, pin: OTHER }));
    await refusal(signIn({ ...me, pin: OTHER }));
    expect((await signIn({ ...me, pin: PIN })).failedSinceLastSignIn).toBe(2);

    // Slow guessing: the run was cleared by the good sign-in, the 30-day count was not. Guesses count
    // against the credentials the person still has — here phone A's.
    for (let i = 0; i < 17; i++) {
      await logAudit({
        actor: "device:test",
        action: "app.sign_in_failed",
        entity: "app_credential",
        entityId: ca.credentialId,
        detail: { employeeId: P.VMO2, deviceId: randomUUID() },
      });
    }
    expect((await refusal(signIn({ ...me, pin: OTHER }))).code).toBe("disabled");
    // Every sign-in the person had ends, on both phones — recovery is a fresh set-up (review #9).
    const live = await sql()<{ n: number }[]>`
      select count(*)::int as n from app_credential where employee_id = ${P.VMO2} and revoked_at is null`;
    expect(live[0]!.n).toBe(0);

    // Set up again by their lead, with a new PIN: the old guesses no longer count, so one typo is one typo.
    const again = await setUp(a, P.VMO2, "4590");
    expect(await refusal(signIn({ ...a, employeeId: P.VMO2, personSecret: again.personSecret, pin: OTHER }))).toMatchObject({ code: "wrong_pin" });
    expect((await signIn({ ...a, employeeId: P.VMO2, personSecret: again.personSecret, pin: "4590" })).failedSinceLastSignIn).toBe(1);
  });

  it("one person at a time on a shared phone; a company sign-in ends at the next shift handover", async () => {
    const d = await phone("company");
    const one = await setUp(d, P.VMO);
    const two = await setUp(d, P.OUT, PIN, V.ADM);
    const first = await signIn({ ...d, employeeId: P.VMO, personSecret: one.personSecret, pin: PIN });
    expect(await appSessionFor(first.accessToken)).toMatchObject({ employeeId: P.VMO });
    await signIn({ ...d, employeeId: P.OUT, personSecret: two.personSecret, pin: PIN });
    expect(await appSessionFor(first.accessToken)).toBeNull();

    const at = (iso: string) => companySessionEnd(new Date(iso), ["07:30", "15:00"]).toISOString();
    expect(at("2026-10-16T14:40:00+04:00")).toBe(new Date("2026-10-17T08:00:00+04:00").toISOString());
    expect(at("2026-10-16T07:20:00+04:00")).toBe(new Date("2026-10-16T15:30:00+04:00").toISOString());
    expect(at("2026-10-16T22:00:00+04:00")).toBe(new Date("2026-10-17T08:00:00+04:00").toISOString());
    expect(at("2026-10-16T06:00:00+04:00")).toBe(new Date("2026-10-16T15:30:00+04:00").toISOString());
  });
});

describe("staying signed in", () => {
  it("refresh tokens rotate; one used twice ends the family — unless the answer was lost a moment ago", async () => {
    const d = await phone("personal", P.OUT);
    const c = await setUp(d, P.OUT, PIN, V.ADM);
    const t1 = await signIn({ ...d, employeeId: P.OUT, personSecret: c.personSecret, pin: PIN });
    const t2 = await refreshSession({ ...d, refreshToken: t1.refreshToken });
    expect(await appSessionFor(t2.accessToken)).toMatchObject({ employeeId: P.OUT });

    // The phone never received t2 and tries t1 again: it gets a new pair, and t2 is void.
    const t3 = await refreshSession({ ...d, refreshToken: t1.refreshToken });
    expect(await appSessionFor(t2.accessToken)).toBeNull();
    const t4 = await refreshSession({ ...d, refreshToken: t3.refreshToken });
    await refreshSession({ ...d, refreshToken: t4.refreshToken }); // t4 used: its successor is in use

    // t3 again, after its successor was used: two parties hold this family. All of it ends.
    expect((await refusal(refreshSession({ ...d, refreshToken: t3.refreshToken }))).code).toBe("signed_out");
    expect(await appSessionFor(t4.accessToken)).toBeNull();
    const [reuse] = await sql()<{ n: number }[]>`select count(*)::int as n from audit_log where action = 'app.refresh_reused' and detail ->> 'deviceId' = ${d.deviceId}`;
    expect(reuse!.n).toBeGreaterThan(0);

    // The pair voided by that grace, presented later: the phone that lost the answer never had it, so
    // whoever presents it holds a copy — the family ends and it is recorded (RFC 9700 §4.14; review #4).
    const u1 = await signIn({ ...d, employeeId: P.OUT, personSecret: c.personSecret, pin: PIN });
    const u2 = await refreshSession({ ...d, refreshToken: u1.refreshToken });
    const u3 = await refreshSession({ ...d, refreshToken: u1.refreshToken }); // within the grace: u2 is void
    expect(await appSessionFor(u3.accessToken)).toMatchObject({ employeeId: P.OUT });
    expect((await refusal(refreshSession({ ...d, refreshToken: u2.refreshToken }))).code).toBe("signed_out");
    expect(await appSessionFor(u3.accessToken)).toBeNull();
    const [voided] = await sql()<{ n: number }[]>`
      select count(*)::int as n from audit_log where action = 'app.refresh_reused' and detail ->> 'why' = 'voided_pair' and detail ->> 'deviceId' = ${d.deviceId}`;
    expect(voided!.n).toBe(1);

    // Signing out ends the family; doing it twice is fine.
    const t5 = await signIn({ ...d, employeeId: P.OUT, personSecret: c.personSecret, pin: PIN });
    expect(await signOut({ ...d, refreshToken: t5.refreshToken })).toEqual({ signedOut: true });
    expect(await appSessionFor(t5.accessToken)).toBeNull();
  });

  it("an access token is somebody's only while everything behind it is live", async () => {
    const d = await phone("company");
    const c = await setUp(d, P.VMO);
    const t = await signIn({ ...d, employeeId: P.VMO, personSecret: c.personSecret, pin: PIN });
    expect(await appSessionFor(t.accessToken)).toMatchObject({ employeeId: P.VMO, deviceId: d.deviceId });
    expect(await appSessionFor(`fna_${"A".repeat(43)}`)).toBeNull(); // never issued: nobody's
    expect(await appSessionFor("not-a-token")).toBeNull();
    expect(await revokeDevice({ actor: V.ADM, deviceId: d.deviceId, reason: "lost" })).toEqual({ revoked: true });
    expect(await appSessionFor(t.accessToken)).toBeNull();
    expect((await refusal(signIn({ ...d, employeeId: P.VMO, personSecret: c.personSecret, pin: PIN }))).code).toBe("device_revoked");
  });

  it("a PIN change needs the current PIN and signs nobody out", async () => {
    // OUT, not VMO2: VMO2 is past the 30-day limit from the test above, by design.
    const d = await phone("company");
    const a = await setUp(d, P.VMO);
    const b = await setUp(d, P.OUT, PIN, V.ADM);
    const ta = await signIn({ ...d, employeeId: P.VMO, personSecret: a.personSecret, pin: PIN });
    expect((await refusal(changePin({ ...d, employeeId: P.OUT, personSecret: b.personSecret, pin: OTHER, newPin: "4590" }))).code).toBe("wrong_pin");
    await changePin({ ...d, employeeId: P.OUT, personSecret: b.personSecret, pin: PIN, newPin: "4590" });
    expect(await appSessionFor(ta.accessToken)).toMatchObject({ employeeId: P.VMO }); // still signed in
    expect((await refusal(signIn({ ...d, employeeId: P.OUT, personSecret: b.personSecret, pin: PIN }))).code).toBe("wrong_pin");
    expect((await signIn({ ...d, employeeId: P.OUT, personSecret: b.personSecret, pin: "4590" })).employeeId).toBe(P.OUT);
  });
});

describe("for the CEO and Admins", () => {
  it("a person ends their own sign-in, a lead their report's; nobody but the CEO ends the CEO's or an Admin's", async () => {
    const d = await phone("company");
    const c = await setUp(d, P.VMO);
    expect((await refusal(revokeCredential({ actor: V.OUT, credentialId: c.credentialId }))).status).toBe(403);
    expect(await revokeCredential({ actor: V.SUP, credentialId: c.credentialId })).toEqual({ revoked: true });

    const mine = await phone("personal", DEMO_CEO_ID);
    const ceo = await setUp(mine, DEMO_CEO_ID, PIN, V.CEO);
    expect((await refusal(revokeCredential({ actor: V.ADM, credentialId: ceo.credentialId }))).status).toBe(403);
    expect((await refusal(revokeDevice({ actor: V.ADM, deviceId: mine.deviceId }))).status).toBe(403);
    expect(await revokeCredential({ actor: V.CEO, credentialId: ceo.credentialId })).toEqual({ revoked: true });
  });

  it("the phone list shows security state and no sign-in times — and no personal phone's last use", async () => {
    expect((await refusal(listDevices({ actor: V.SUP }))).status).toBe(403);
    const list = await listDevices({ actor: V.ADM });
    const ours = list.filter((x) => phones.includes(x.id));
    expect(ours.length).toBeGreaterThan(0);
    for (const p of ours.flatMap((x) => x.people)) expect(Object.keys(p).sort()).toEqual(["credentialId", "disabled", "displayName", "employeeId", "failedCount"]);
    for (const personal of ours.filter((x) => x.kind === "personal")) expect(personal.lastSeenAt).toBeNull();
  });

  it("expired sessions go after 30 days; a used set-up code stays while a sign-in points at it (review #3)", async () => {
    const d = await phone("personal", P.SUP);
    const c = await setUp(d, P.SUP, PIN, V.ADM);
    const t = await signIn({ ...d, employeeId: P.SUP, personSecret: c.personSecret, pin: PIN });
    await sql()`update app_session set revoked_at = now() - interval '31 days' where id = ${t.sessionId}`;
    // The code that made this sign-in, and an unused one, both long expired.
    await sql()`update app_setup_code set expires_at = now() - interval '40 days'
                where id = (select setup_code_id from app_credential where id = ${c.credentialId})`;
    const unused = await issueSetupCode({ actor: V.ADM, employeeId: P.OUT });
    void unused;
    await sql()`update app_setup_code set expires_at = now() - interval '40 days' where employee_id = ${P.OUT} and used_at is null and voided_at is null`;
    const r = await pruneAppAuth(); // used to fail here: the used code is referenced by the credential
    expect(r.sessions).toBeGreaterThanOrEqual(1);
    expect(r.codes).toBeGreaterThanOrEqual(1);
    expect((await sql()`select 1 from app_session where id = ${t.sessionId}`).length).toBe(0);
    expect((await sql()`select 1 from app_setup_code where id = (select setup_code_id from app_credential where id = ${c.credentialId})`).length).toBe(1);
  });

  it("someone made Admin after set-up can no longer use a shared phone — sign-in, refresh or token (review #6)", async () => {
    const promo = randomUUID();
    await sql()`insert into employee (id, display_name, status, is_synthetic, access_role, manager_employee_id)
                values (${promo}, ${`Pia ${TAG}`}, 'active', true, 'vmo', ${P.SUP})`;
    try {
      const d = await phone("company");
      const c = await setUp(d, promo);
      const t = await signIn({ ...d, employeeId: promo, personSecret: c.personSecret, pin: PIN });
      await sql()`update employee set access_role = 'admin' where id = ${promo}`;
      expect(await appSessionFor(t.accessToken)).toBeNull();
      expect((await refusal(refreshSession({ ...d, refreshToken: t.refreshToken }))).code).toBe("signed_out");
      expect(await refusal(signIn({ ...d, employeeId: promo, personSecret: c.personSecret, pin: PIN }))).toMatchObject({ status: 403, code: "shared_phone" });
    } finally {
      await sql()`delete from app_session where employee_id = ${promo}`;
      await sql()`delete from app_credential where employee_id = ${promo}`;
      await sql()`delete from app_setup_code where employee_id = ${promo}`;
      await sql()`delete from employee where id = ${promo}`;
    }
  });

  it("a wrong PIN is counted even when the request carries a correlation id that is not a UUID (review #2)", async () => {
    const d = await phone("company");
    const c = await setUp(d, P.VMO);
    const r = await refusal(signIn({ ...d, employeeId: P.VMO, personSecret: c.personSecret, pin: OTHER, correlationId: "not-a-uuid" }));
    expect(r.code).toBe("wrong_pin");
    const [row] = await sql()<{ n: number }[]>`
      select count(*)::int as n from audit_log where action = 'app.sign_in_failed' and entity_id = ${c.credentialId}`;
    expect(row!.n).toBe(1);
  });

  it("an unknown phone is refused before any PIN is hashed, and is not counted against any phone (review #7)", async () => {
    const ghost = { deviceId: randomUUID(), deviceSecret: "x".repeat(43) };
    expect((await refusal(bindCredential({ ...ghost, setupCode: "AAAAA-AAAAA", pin: "4590" }))).code).toBe("unknown_device");
    expect((await sql()`select 1 from audit_log where action = 'app.setup_code_refused' and entity_id = ${ghost.deviceId}`).length).toBe(0);
  });

  it("someone else's export of a person leaves the phone sign-in times out; the person's own keeps them (review #8)", async () => {
    const d = await phone("personal", P.SUP);
    const c = await setUp(d, P.SUP, PIN, V.ADM);
    await refusal(signIn({ ...d, employeeId: P.SUP, personSecret: c.personSecret, pin: OTHER }));
    await signIn({ ...d, employeeId: P.SUP, personSecret: c.personSecret, pin: PIN });
    const theirs = (await exportPersonData({ employeeId: P.SUP, requestedBy: DEMO_CEO_ID })) as Record<string, unknown>;
    for (const row of theirs.phoneSignIn as Record<string, unknown>[]) expect(row).not.toHaveProperty("last_signed_in_at");
    // Not even a count of sessions: it is a usage meter (review 2026-10-17, todays-fixes#3).
    expect(theirs.phoneSessions).toBe("Shown only in the person's own download.");
    expect((theirs.yourActions as Record<string, unknown>[]).some((a) => a.action === "app.signed_in")).toBe(false);
    expect((theirs.yourActions as Record<string, unknown>[]).some((a) => a.action === "app.sign_in_failed")).toBe(false);
    const own = (await exportPersonData({ employeeId: P.SUP, requestedBy: P.SUP })) as Record<string, Record<string, unknown>[]>;
    expect(own.phoneSignIn!.some((row) => row.last_signed_in_at !== null && row.last_signed_in_at !== undefined)).toBe(true);
    expect(own.yourActions!.some((a) => a.action === "app.signed_in")).toBe(true);
    // The wrong PIN is written by the phone, naming the person in its detail — it is in their own copy (todays-fixes#5).
    expect(own.yourActions!.some((a) => a.action === "app.sign_in_failed")).toBe(true);
    await sql()`delete from audit_log where action = 'data.exported' and entity_id = ${P.SUP}`;
  });

  it("short names on a shared phone: enough to find yourself, no more", () => {
    expect(shortName("Kiran Sharma")).toBe("Kiran S.");
    expect(shortName("Yakup")).toBe("Yakup");
    expect(shortName("  Mohammed  Ali  Khan ")).toBe("Mohammed K.");
  });
});
