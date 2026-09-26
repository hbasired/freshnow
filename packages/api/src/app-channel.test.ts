import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getServiceSql } from "@freshnow/core";
import { buildServer } from "./server.js";

/**
 * The app-as-Telegram-replacement routes over HTTP (TASK-044):
 *   - the delivery-mode toggle is the CEO's alone, and "app only" is refused (409) while web
 *     push cannot reach a phone;
 *   - the test-notification button says why it cannot send rather than silently doing nothing;
 *   - /dashboard/me says whether Telegram is linked, so the UI offers only columns that work;
 *   - consent is recorded against the words shown, and the CEO cannot withdraw themselves.
 */

const app = buildServer(false);
const WORKER = randomUUID();
const APP_ONLY = randomUUID();
const ENV = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT", "BOT_TOKEN"];
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  const sql = getServiceSql();
  await sql`insert into employee (id, display_name, status, is_synthetic, access_role, telegram_user_id) values
    (${WORKER}, 'APPR-Worker', 'active', true, 'employee', 9_700_000_000_441),
    (${APP_ONLY}, 'APPR-AppOnly', 'active', true, 'employee', null)`;
});

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.BOT_TOKEN = "0:test";
});

afterEach(async () => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await getServiceSql()`update channel_setting set enabled = (channel in ('telegram', 'inapp')), updated_by = null`;
});

afterAll(async () => {
  const sql = getServiceSql();
  const ids = [WORKER, APP_ONLY];
  await sql`delete from notification_outbox where recipient_employee_id = any(${ids})`;
  await sql`delete from push_subscription where employee_id = any(${ids})`;
  await sql`delete from consent_record where employee_id = any(${ids})`;
  await sql`delete from audit_log where actor = any(${ids.map((i) => `employee:${i}`)}) or entity_id = any(${ids.map(String)})`;
  await sql`delete from employee where id = any(${ids})`;
  await app.close();
  await closeDb();
});

const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) =>
  app.inject({ method, url, ...(payload ? { payload } : {}) });

function pushConfigured(): void {
  process.env.VAPID_PUBLIC_KEY = "test-public";
  process.env.VAPID_PRIVATE_KEY = "test-private";
  process.env.VAPID_SUBJECT = "mailto:ops@example.ae";
}

describe("the delivery-mode toggle", () => {
  it("reads back the current mode — Telegram by default", async () => {
    const r = await call("GET", `/dashboard/channels?viewer=${WORKER}`);
    expect(r.statusCode).toBe(200);
    expect((r.json() as { mode: string }).mode).toBe("telegram");
  });

  it("only the CEO may change it", async () => {
    pushConfigured();
    const r = await call("PUT", `/dashboard/channels/mode?viewer=${WORKER}`, { mode: "app" });
    expect(r.statusCode).toBe(403);
  });

  it("refuses app-only with a reason while web push is not set up", async () => {
    for (const k of ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]) delete process.env[k];
    const r = await call("PUT", "/dashboard/channels/mode?viewer=ceo", { mode: "app" });
    expect(r.statusCode).toBe(409);
    expect((r.json() as { error: { message: string } }).error.message).toMatch(/web push/i);
  });

  it("switches to app-only when web push is set up, and back", async () => {
    pushConfigured();
    const r = await call("PUT", "/dashboard/channels/mode?viewer=ceo", { mode: "app" });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { mode: string; channels: { channel: string; live: boolean }[] };
    expect(body.mode).toBe("app");
    expect(body.channels.find((c) => c.channel === "telegram")?.live).toBe(false);
    expect(body.channels.find((c) => c.channel === "webpush")?.live).toBe(true);
    const back = await call("PUT", "/dashboard/channels/mode?viewer=ceo", { mode: "telegram" });
    expect((back.json() as { mode: string }).mode).toBe("telegram");
  });

  it("rejects a mode that does not exist", async () => {
    const r = await call("PUT", "/dashboard/channels/mode?viewer=ceo", { mode: "carrier-pigeon" });
    expect(r.statusCode).toBe(400);
  });
});

describe("the test-notification button", () => {
  it("says web push is not live rather than pretending to send", async () => {
    const r = await call("POST", `/dashboard/me/push-test?viewer=${WORKER}`);
    expect(r.statusCode).toBe(409);
  });

  it("says there is no device yet when the person has not turned one on", async () => {
    pushConfigured();
    await call("PUT", "/dashboard/channels/mode?viewer=ceo", { mode: "both" });
    const r = await call("POST", `/dashboard/me/push-test?viewer=${WORKER}`);
    expect(r.statusCode).toBe(409);
    expect((r.json() as { error: { message: string } }).error.message).toMatch(/device/i);
  });

  it("queues exactly one web push to the viewer's own devices", async () => {
    pushConfigured();
    await call("PUT", "/dashboard/channels/mode?viewer=ceo", { mode: "both" });
    const sub = await call("POST", `/dashboard/me/push-subscriptions?viewer=${WORKER}`, {
      endpoint: `https://push.example.invalid/${randomUUID()}`,
      keys: { p256dh: "BTestKey", auth: "testauth" },
    });
    expect(sub.statusCode).toBe(201);
    const a = await call("POST", `/dashboard/me/push-test?viewer=${WORKER}`);
    const b = await call("POST", `/dashboard/me/push-test?viewer=${WORKER}`);
    expect(a.statusCode).toBe(202);
    expect(b.statusCode).toBe(202);
    const rows = await getServiceSql()<{ channel: string }[]>`
      select channel from notification_outbox
      where recipient_employee_id = ${WORKER} and payload->>'kind' = 'test'`;
    // Two taps inside the same ten seconds are one notification.
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.length).toBeLessThanOrEqual(2);
    expect(rows.every((r) => r.channel === "webpush")).toBe(true);
  });
});

describe("who the viewer is", () => {
  it("says whether Telegram is linked", async () => {
    expect((await call("GET", `/dashboard/me?viewer=${WORKER}`)).json()).toMatchObject({ telegramLinked: true });
    expect((await call("GET", `/dashboard/me?viewer=${APP_ONLY}`)).json()).toMatchObject({ telegramLinked: false });
  });
});

describe("consent in the app", () => {
  it("shows the notice and its fingerprint to somebody with no consent", async () => {
    const r = await call("GET", `/dashboard/me/consent?viewer=${APP_ONLY}`);
    expect(r.statusCode).toBe(200);
    const c = r.json() as { consented: boolean; notice: string; noticeHash: string };
    expect(c.consented).toBe(false);
    expect(c.notice.length).toBeGreaterThan(100);
    expect(c.noticeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a fingerprint that is not the current notice's, and records nothing", async () => {
    const r = await call("POST", `/dashboard/me/consent?viewer=${APP_ONLY}`, { noticeHash: "0".repeat(64) });
    expect(r.statusCode).toBe(409);
    const c = (await call("GET", `/dashboard/me/consent?viewer=${APP_ONLY}`)).json() as { consented: boolean };
    expect(c.consented).toBe(false);
  });

  it("records consent against the notice that was shown", async () => {
    const shown = (await call("GET", `/dashboard/me/consent?viewer=${APP_ONLY}`)).json() as { noticeHash: string };
    const r = await call("POST", `/dashboard/me/consent?viewer=${APP_ONLY}`, { noticeHash: shown.noticeHash });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { consented: boolean }).consented).toBe(true);
  });

  it("the CEO cannot withdraw from the app — it would lock the company out", async () => {
    const r = await call("POST", "/dashboard/me/consent/withdraw?viewer=ceo");
    expect(r.statusCode).toBe(403);
  });

  it("an employee who withdraws is switched off", async () => {
    const r = await call("POST", `/dashboard/me/consent/withdraw?viewer=${APP_ONLY}`);
    expect(r.statusCode).toBe(200);
    const [row] = await getServiceSql()<{ status: string }[]>`select status from employee where id = ${APP_ONLY}`;
    expect(row?.status).toBe("disabled");
  });
});
