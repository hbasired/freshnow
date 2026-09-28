import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { notify, notifyPeople, resolveAlertRecipients, setNotificationPref } from "./alerts.js";
import { channelStates, deliveryModeOf, DeliveryModeError, setDeliveryMode } from "./channels.js";
import { closeDb, getServiceSql } from "./db.js";
import { DEMO_CEO_ID } from "./meta.js";
import { savePushSubscription } from "./push.js";

/**
 * The app as a replacement for Telegram, behind the company's toggle.
 *
 * What must be true (TASK-044):
 *   - Telegram is the default; "Telegram + App" adds web push; "App only" switches Telegram
 *     off — but only when web push can actually reach a phone.
 *   - A person who turned notifications on for a device gets web push without also having
 *     to find and set a per-event rule; a per-event "off" still silences it.
 *   - In app-only mode nothing is queued on Telegram; the inbox and the device get it.
 *   - A phone banner says what it is and opens the right place.
 *   - Messages that are not one of the five alert events (an unreadable update, project
 *     news) reach the same channels.
 *   (Consent — one notice for the bot and the app — is covered in consent.test.ts.)
 */
const TAG = "APPCHAN";
const CORR = "a99c4a00-0000-4000-8000-00000000a44c";
const ENV = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT", "BOT_TOKEN"];
const saved: Record<string, string | undefined> = {};

function withPushConfigured(): void {
  process.env.VAPID_PUBLIC_KEY = "test-public";
  process.env.VAPID_PRIVATE_KEY = "test-private";
  process.env.VAPID_SUBJECT = "mailto:ops@example.ae";
}

async function person(p: { name: string; telegram?: boolean; status?: string }): Promise<string> {
  const id = randomUUID();
  const tg = p.telegram === false ? null : 9_700_000_000_000 + Math.floor(Math.random() * 1e6);
  await getServiceSql()`
    insert into employee (id, display_name, status, telegram_user_id, access_role, is_synthetic)
    values (${id}, ${`${TAG} ${p.name}`}, ${p.status ?? "active"}, ${tg}, 'employee', true)`;
  return id;
}

async function device(employeeId: string): Promise<void> {
  await savePushSubscription({
    employeeId,
    endpoint: `https://push.example.invalid/${randomUUID()}`,
    p256dh: "BTestKey",
    auth: "testauth",
  });
}

async function task(owner: string): Promise<string> {
  const rows = await getServiceSql()<{ id: string }[]>`
    insert into task (employee_id, title, status, is_synthetic) values (${owner}, ${`${TAG} task`}, 'open', true) returning id`;
  return rows[0]!.id;
}

async function rowsFor(employeeId: string): Promise<{ channel: string; idempotency_key: string; payload: Record<string, unknown> }[]> {
  return [
    ...(await getServiceSql()<{ channel: string; idempotency_key: string; payload: Record<string, unknown> }[]>`
      select channel, idempotency_key, payload from notification_outbox
      where recipient_employee_id = ${employeeId} order by channel`),
  ];
}

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.BOT_TOKEN = "0:test";
});

afterEach(async () => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  const sql = getServiceSql();
  const like = `${TAG} %`;
  await sql`delete from notification_outbox where recipient_employee_id in (select id from employee where display_name like ${like})`;
  await sql`delete from notification_outbox where idempotency_key like ${`${TAG}%`}`;
  await sql`delete from notification_pref where employee_id in (select id from employee where display_name like ${like})`;
  await sql`delete from push_subscription where employee_id in (select id from employee where display_name like ${like})`;
  await sql`delete from consent_record where employee_id in (select id from employee where display_name like ${like})`;
  await sql`delete from task where title = ${`${TAG} task`}`;
  await sql`delete from audit_log where correlation_id = ${CORR}
            or (action in ('channel.toggled', 'channel.mode_set', 'push.subscribed', 'consent.recorded') and created_at > now() - interval '5 minutes')`;
  await sql`delete from employee where display_name like ${like}`;
  // Back to what migration 0017 seeded: Telegram and the inbox on, everything else off.
  await sql`update channel_setting set enabled = (channel in ('telegram', 'inapp')), updated_by = null`;
});

afterAll(async () => {
  await closeDb();
});

describe("the delivery-mode toggle", () => {
  it("names the three presets from the switches, and anything else as custom", () => {
    const s = (telegram: boolean, webpush: boolean) => [
      { channel: "telegram" as const, enabled: telegram },
      { channel: "webpush" as const, enabled: webpush },
      { channel: "inapp" as const, enabled: true },
    ];
    expect(deliveryModeOf(s(true, false))).toBe("telegram");
    expect(deliveryModeOf(s(true, true))).toBe("both");
    expect(deliveryModeOf(s(false, true))).toBe("app");
    expect(deliveryModeOf(s(false, false))).toBe("custom");
  });

  it("starts on Telegram — the default the company runs today", async () => {
    expect(deliveryModeOf(await channelStates())).toBe("telegram");
  });

  it("refuses app-only while web push is not set up, and changes nothing", async () => {
    for (const k of ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]) delete process.env[k];
    await expect(setDeliveryMode({ mode: "app", by: DEMO_CEO_ID, correlationId: CORR })).rejects.toBeInstanceOf(DeliveryModeError);
    const states = await channelStates();
    expect(states.find((c) => c.channel === "telegram")?.enabled).toBe(true);
    expect(states.find((c) => c.channel === "webpush")?.enabled).toBe(false);
  });

  it("allows Telegram + App without web push keys, because it only adds", async () => {
    for (const k of ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]) delete process.env[k];
    const r = await setDeliveryMode({ mode: "both", by: DEMO_CEO_ID, correlationId: CORR });
    expect(r.mode).toBe("both");
    expect(r.channels.find((c) => c.channel === "telegram")?.live).toBe(true);
  });

  it("app-only turns web push on BEFORE Telegram off, and records the decision once", async () => {
    withPushConfigured();
    const r = await setDeliveryMode({ mode: "app", by: DEMO_CEO_ID, correlationId: CORR });
    expect(r.mode).toBe("app");
    expect(r.channels.find((c) => c.channel === "telegram")).toMatchObject({ enabled: false, live: false });
    expect(r.channels.find((c) => c.channel === "webpush")).toMatchObject({ enabled: true, live: true });

    const sql = getServiceSql();
    const toggles = await sql<{ entity_id: string }[]>`
      select entity_id from audit_log where correlation_id = ${CORR} and action = 'channel.toggled' order by created_at, id`;
    expect(toggles.map((t) => t.entity_id)).toEqual(["webpush", "telegram"]);
    const decided = await sql<{ actor: string; detail: Record<string, unknown> }[]>`
      select actor, detail from audit_log where correlation_id = ${CORR} and action = 'channel.mode_set'`;
    expect(decided).toHaveLength(1);
    expect(decided[0]).toMatchObject({ actor: `employee:${DEMO_CEO_ID}`, detail: { before: "telegram", after: "app" } });

    // And back, which is what the demo does at the end.
    expect((await setDeliveryMode({ mode: "telegram", by: DEMO_CEO_ID, correlationId: CORR })).mode).toBe("telegram");
  });
});

describe("web push reaches the people who turned it on", () => {
  beforeEach(async () => {
    withPushConfigured();
    await setDeliveryMode({ mode: "both", by: DEMO_CEO_ID, correlationId: CORR });
  });

  it("a person with a device gets web push with no rule; a person without one does not", async () => {
    const withPhone = await person({ name: "with phone" });
    const without = await person({ name: "without phone" });
    await device(withPhone);

    const a = await resolveAlertRecipients({ type: "task.assigned", assignmentId: randomUUID(), taskId: randomUUID(), assigneeId: withPhone, assignedBy: DEMO_CEO_ID });
    expect(a.map((r) => r.channel).sort()).toEqual(["inapp", "telegram", "webpush"]);

    const b = await resolveAlertRecipients({ type: "task.assigned", assignmentId: randomUUID(), taskId: randomUUID(), assigneeId: without, assignedBy: DEMO_CEO_ID });
    expect(b.map((r) => r.channel).sort()).toEqual(["inapp", "telegram"]);
  });

  it("a per-event 'off' rule silences web push for that event only", async () => {
    const p = await person({ name: "quiet" });
    await device(p);
    await setNotificationPref({ employeeId: p, eventType: "task.assigned", channel: "webpush", mode: "off" });
    const assigned = await resolveAlertRecipients({ type: "task.assigned", assignmentId: randomUUID(), taskId: randomUUID(), assigneeId: p, assignedBy: DEMO_CEO_ID });
    expect(assigned.map((r) => r.channel)).not.toContain("webpush");
  });

  it("the banner says what it is, opens that task, and only a problem is urgent", async () => {
    const p = await person({ name: "banner" });
    await device(p);
    const taskId = await task(p);
    await notify(
      { type: "task.assigned", assignmentId: randomUUID(), taskId, assigneeId: p, assignedBy: DEMO_CEO_ID },
      { text: "📌 New task: clean chiller", correlationId: CORR },
    );
    const push = (await rowsFor(p)).find((r) => r.channel === "webpush");
    expect(push).toBeDefined();
    expect(push!.payload.title).toEqual(expect.any(String));
    expect(String(push!.payload.title).length).toBeGreaterThan(0);
    expect(push!.payload.url).toContain(`task=${taskId}`);
    expect(String(push!.payload.url).startsWith("/app/")).toBe(true);
    expect(push!.payload.tag).toEqual(expect.any(String));
    expect(push!.payload.urgent).toBe(false);
    expect(push!.payload.text).toBe("📌 New task: clean chiller");
  });
});

describe("app only: the app replaces Telegram", () => {
  it("queues nothing on Telegram — the inbox and the device get the message", async () => {
    withPushConfigured();
    await setDeliveryMode({ mode: "app", by: DEMO_CEO_ID, correlationId: CORR });
    const p = await person({ name: "app only" }); // linked to Telegram, which must not matter now
    await device(p);
    const taskId = await task(p);
    await notify(
      { type: "task.assigned", assignmentId: randomUUID(), taskId, assigneeId: p, assignedBy: DEMO_CEO_ID },
      { text: "📌 New task", correlationId: CORR },
    );
    expect((await rowsFor(p)).map((r) => r.channel)).toEqual(["inapp", "webpush"]);
  });
});

describe("messages that are not alert events reach the same channels", () => {
  it("with Telegram off, a one-off message goes to the inbox and the device, never twice", async () => {
    withPushConfigured();
    await setDeliveryMode({ mode: "app", by: DEMO_CEO_ID, correlationId: CORR });
    const p = await person({ name: "one-off" });
    await device(p);
    const send = () =>
      notifyPeople({
        recipients: [{ employeeId: p, reason: "test" }],
        keyFor: (id, ch) => `${TAG}-oneoff:${id}:${ch}`,
        text: "An update needs a human",
        kind: "needs_review",
        presentation: { title: "Needs a human", url: "/app/#tasks/today", tag: "t", urgent: false },
        correlationId: CORR,
      });
    expect((await send()).enqueued).toBe(2);
    expect((await send()).enqueued).toBe(0);
    const rows = await rowsFor(p);
    expect(rows.map((r) => r.channel)).toEqual(["inapp", "webpush"]);
    expect(rows.map((r) => r.idempotency_key).sort()).toEqual([`${TAG}-oneoff:${p}:inapp`, `${TAG}-oneoff:${p}:webpush`]);
  });

  it("with Telegram on, a linked person also gets Telegram; a disabled person gets nothing", async () => {
    const linked = await person({ name: "linked" });
    const gone = await person({ name: "gone", status: "disabled" });
    await notifyPeople({
      recipients: [{ employeeId: linked, reason: "member" }, { employeeId: gone, reason: "member" }],
      keyFor: (id, ch) => `${TAG}-oneoff2:${id}:${ch}`,
      text: "Project news",
      kind: "project",
      presentation: { title: "Project update", url: "/app/#projects", tag: "p", urgent: false },
    });
    expect((await rowsFor(linked)).map((r) => r.channel)).toEqual(["inapp", "telegram"]);
    expect(await rowsFor(gone)).toEqual([]);
  });
});
