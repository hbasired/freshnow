import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getServiceSql } from "./db.js";
import { DEMO_CEO_ID } from "./meta.js";
import { sendMorningReport } from "./ops-morning.js";
import { savePushSubscription } from "./push.js";

/**
 * Yesterday's report, every morning (TASK-059) — real Postgres, clock fixed on Wed 22 Nov 2023 so the
 * report is about Tue 21 Nov, a day no other test sells on.
 *
 *   SUP  supervisor, Telegram linked AND a phone with notifications on → the app only (Telegram is the fallback)
 *   SUP2 supervisor, Telegram linked, no device                        → Telegram too — the app cannot reach their phone
 *   VMO  a driver                                                       → nothing: not someone who runs the machines
 */
const TAG = `MORN-${randomUUID().slice(0, 6)}`;
const SUP = randomUUID();
const SUP2 = randomUUID();
const VMO = randomUUID();
const DATE = "2023-11-21";
const KEY = `ops.morning_report:${DATE}:%`;
const M = 990701;
const ENV = ["BOT_TOKEN", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
let webpushWas = false;
const sql = () => getServiceSql();

beforeAll(async () => {
  process.env.BOT_TOKEN = "0:test";
  process.env.VAPID_PUBLIC_KEY = "p";
  process.env.VAPID_PRIVATE_KEY = "q";
  process.env.VAPID_SUBJECT = "mailto:ops@example.ae";
  const s = sql();
  webpushWas = (await s<{ enabled: boolean }[]>`select enabled from channel_setting where channel = 'webpush'`)[0]?.enabled ?? false;
  await s`update channel_setting set enabled = true where channel = 'webpush'`;
  await s`insert into employee (id, display_name, status, is_synthetic, access_role, manager_employee_id, telegram_user_id)
          values (${SUP}, ${`${TAG} Sup`}, 'active', true, 'supervisor', ${DEMO_CEO_ID}, ${9_700_000_000_000 + Math.floor(Math.random() * 1e6)}),
                 (${SUP2}, ${`${TAG} Sup2`}, 'active', true, 'supervisor', ${DEMO_CEO_ID}, ${9_710_000_000_000 + Math.floor(Math.random() * 1e6)}),
                 (${VMO}, ${`${TAG} Vmo`}, 'active', true, 'vmo', ${SUP}, null)`;
  await savePushSubscription({ employeeId: SUP, endpoint: `https://push.example.invalid/${randomUUID()}`, p256dh: "BKey", auth: "a" });
  await s`insert into tv_machine (televend_id, caption, asset_no, enabled, raw, is_synthetic) values (${M}, 'Morning Test-701-DXB', 701, true, '{}'::jsonb, true)`;
  for (const [i, at, type] of [[0, "09:00", 0], [1, "10:00", 1], [2, "11:00", 0]] as const) {
    await s`insert into tv_vend (source, external_id, machine_tv_id, at, payment_type, quantity, raw, is_synthetic)
            values ('bridge', ${`${TAG}-v${i}`}, ${M}, ${new Date(`${DATE}T${at}:00+04:00`)}, ${type}, 1, '{}'::jsonb, true)`;
  }
});

afterAll(async () => {
  const s = sql();
  await s`delete from notification_outbox where idempotency_key like ${KEY}`;
  await s`delete from audit_log where action = 'ops.morning_report' and entity_id = ${DATE}`;
  await s`delete from push_subscription where employee_id = ${SUP}`;
  await s`delete from tv_vend where external_id like ${`${TAG}-%`}`;
  await s`delete from tv_machine where televend_id = ${M}`;
  await s`update employee set manager_employee_id = null where id = ${VMO}`;
  await s`delete from employee where id in (${SUP}, ${SUP2}, ${VMO})`;
  await s`update channel_setting set enabled = ${webpushWas} where channel = 'webpush'`;
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await closeDb();
});

describe("yesterday's report, every morning", () => {
  it("waits until 07:30 — the night shift's collections are in by then", async () => {
    expect(await sendMorningReport({ now: new Date("2023-11-22T07:15:00+04:00") })).toEqual({ sent: false, reason: "too early" });
  });

  it("waits — until 10:00 — while Televend has not read yesterday in full (the worker may have just started)", async () => {
    // Televend reachable, and the test database has no complete read of 21 Nov: the report waits.
    process.env.TELEVEND_USERNAME = "test-only";
    try {
      expect(await sendMorningReport({ now: new Date("2023-11-22T08:00:00+04:00") })).toMatchObject({ sent: false, reason: "waiting for Televend to read yesterday in full" });
    } finally {
      delete process.env.TELEVEND_USERNAME;
    }
  });

  it("goes to the people who run the machines — app first, Telegram only where the app cannot reach a phone", async () => {
    const r = await sendMorningReport({ now: new Date("2023-11-22T08:00:00+04:00") });
    expect(r).toMatchObject({ sent: true, date: DATE });
    const rows = await sql()<{ recipient_employee_id: string; channel: string; text: string }[]>`
      select recipient_employee_id, channel, payload->>'text' as text from notification_outbox where idempotency_key like ${KEY}`;
    const of = (id: string) => rows.filter((x) => x.recipient_employee_id === id).map((x) => x.channel).sort();
    expect(of(SUP)).toEqual(["inapp", "webpush"]); // has a phone: no Telegram
    expect(of(SUP2)).toEqual(["inapp", "telegram"]); // no phone set up: Telegram as the fallback
    expect(of(VMO)).toEqual([]); // a driver does not get the machines' report
    expect(of(DEMO_CEO_ID)).toContain("inapp");
    const text = rows.find((x) => x.recipient_employee_id === SUP && x.channel === "inapp")!.text;
    expect(text).toMatch(/Yesterday, Tue 21 Nov/);
    expect(text).toMatch(/cups sold \(\d+ cash · \d+ card\)/);
    // Televend's "should have found" only for whoever sees all cash — the CEO, not a Supervisor (D237, review 20 Oct).
    expect(text).not.toMatch(/should have found/);
    expect(text).toMatch(/cash collections logged in Televend/);
    expect(rows.find((x) => x.recipient_employee_id === DEMO_CEO_ID && x.channel === "inapp")!.text).toMatch(/should have found AED/);
    // The test database has no Televend sync runs: the day is not "in the mirror" — and the message says so.
    expect(text).toMatch(/not read from Televend in full/);
  });

  it("once a day: the second run sends nothing", async () => {
    expect(await sendMorningReport({ now: new Date("2023-11-22T09:00:00+04:00") })).toMatchObject({ sent: false, reason: "already sent" });
    const [n] = await sql()<{ n: number }[]>`select count(*)::int as n from audit_log where action = 'ops.morning_report' and entity_id = ${DATE}`;
    expect(n!.n).toBe(1);
  });
});
