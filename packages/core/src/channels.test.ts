import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { channelAvailability, channelStates, isChannelLive, liveChannels, setChannelEnabled } from "./channels.js";
import { closeDb, getServiceSql } from "./db.js";
import { DEMO_CEO_ID } from "./meta.js";
import { enqueueNotification } from "./outbox.js";

/**
 * Three gates: configured on this box, switched on by the company, wanted by the person.
 * The tests below prove the first two, and prove that a message on a channel which fails
 * either one is DROPPED and audited rather than queued to a sender that will never come.
 */
const TAG = "CHANTEST";
const saved: Record<string, string | undefined> = {};
const ENV = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT", "SMTP_HOST", "EMAIL_FROM", "CHAT_WEBHOOK_URL", "BOT_TOKEN"];

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
});
afterEach(async () => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  const sql = getServiceSql();
  await sql`delete from notification_outbox where idempotency_key like ${`${TAG}%`}`;
  await sql`delete from audit_log where action in ('channel.toggled', 'notification.channel_disabled') and created_at > now() - interval '5 minutes'`;
  // Put the switches back the way the migration seeded them.
  await sql`update channel_setting set enabled = (channel in ('telegram', 'inapp')), updated_by = null`;
});
afterAll(async () => {
  await closeDb();
});

describe("gate 1 — is the channel configured on this box", () => {
  it("names the missing key rather than just saying no", () => {
    delete process.env.VAPID_PUBLIC_KEY;
    const push = channelAvailability("webpush");
    expect(push.available).toBe(false);
    expect(push.why).toMatch(/VAPID/);

    delete process.env.SMTP_HOST;
    expect(channelAvailability("email").why).toMatch(/SMTP_HOST/);

    delete process.env.CHAT_WEBHOOK_URL;
    expect(channelAvailability("chat").why).toMatch(/CHAT_WEBHOOK_URL/);
  });

  it("the in-app inbox is always available — there is nothing to configure", () => {
    for (const k of ENV) delete process.env[k];
    expect(channelAvailability("inapp")).toEqual({ available: true, why: "" });
  });

  it("becomes available once every key it needs is present", () => {
    // Start from nothing: this machine's own .env has real VAPID keys, and a test that
    // depends on which keys happen to be configured is a test that passes by accident.
    for (const k of ENV) delete process.env[k];
    process.env.VAPID_PUBLIC_KEY = "pub";
    process.env.VAPID_PRIVATE_KEY = "priv";
    expect(channelAvailability("webpush").available).toBe(false); // subject still missing
    process.env.VAPID_SUBJECT = "mailto:ops@example.ae";
    expect(channelAvailability("webpush")).toEqual({ available: true, why: "" });
  });
});

describe("gate 2 — has the company switched it on", () => {
  it("configured but not switched on is not live, and says which it is", async () => {
    process.env.VAPID_PUBLIC_KEY = "pub";
    process.env.VAPID_PRIVATE_KEY = "priv";
    process.env.VAPID_SUBJECT = "mailto:ops@example.ae";

    const before = (await channelStates()).find((c) => c.channel === "webpush")!;
    expect(before).toMatchObject({ available: true, enabled: false, live: false });
    expect(before.why).toMatch(/has not switched it on/);

    const after = await setChannelEnabled({ channel: "webpush", enabled: true, by: DEMO_CEO_ID });
    expect(after).toMatchObject({ available: true, enabled: true, live: true, why: "" });
    expect(await liveChannels()).toContain("webpush");
  });

  it("switched on but not configured is still not live", async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    await setChannelEnabled({ channel: "webpush", enabled: true, by: DEMO_CEO_ID });
    expect(await isChannelLive("webpush")).toBe(false);
    expect(await liveChannels()).not.toContain("webpush");
    const state = (await channelStates()).find((c) => c.channel === "webpush")!;
    expect(state).toMatchObject({ available: false, enabled: true, live: false });
  });

  it("records who flipped it, and from what to what", async () => {
    await setChannelEnabled({ channel: "email", enabled: true, by: DEMO_CEO_ID });
    const [row] = await getServiceSql()<{ actor: string; entity_id: string; detail: Record<string, unknown> }[]>`
      select actor, entity_id, detail from audit_log
      where action = 'channel.toggled' order by created_at desc limit 1`;
    expect(row?.actor).toBe(`employee:${DEMO_CEO_ID}`);
    expect(row?.entity_id).toBe("email");
    expect(row?.detail).toMatchObject({ before: false, after: true });
  });

  it("refuses a channel that does not exist", async () => {
    await expect(setChannelEnabled({ channel: "carrier-pigeon" as never, enabled: true, by: DEMO_CEO_ID }))
      .rejects.toThrow(/unknown channel/);
  });

  it("today's live set is exactly telegram and the in-app inbox", async () => {
    process.env.BOT_TOKEN = "0:test";
    expect([...(await liveChannels())].sort()).toEqual(["inapp", "telegram"]);
  });
});

describe("the outbox refuses a channel that is not live", () => {
  it("drops the message, audits why, and never queues a row", async () => {
    const key = `${TAG}-${randomUUID()}`;
    // 'chat' is configured-but-off and has no sender; this is the case that used to leave a
    // row pending forever.
    process.env.CHAT_WEBHOOK_URL = "https://example.invalid/hook";
    const r = await enqueueNotification({ idempotencyKey: key, payload: { text: "x" }, channel: "chat", recipientEmployeeId: DEMO_CEO_ID });
    expect(r.enqueued).toBe(false);

    const sql = getServiceSql();
    const rows = await sql`select 1 from notification_outbox where idempotency_key = ${key}`;
    expect(rows.length).toBe(0);

    const [audit] = await sql<{ detail: Record<string, unknown> }[]>`
      select detail from audit_log where action = 'notification.channel_disabled' order by created_at desc limit 1`;
    expect(audit?.detail).toMatchObject({ channel: "chat", recipientEmployeeId: DEMO_CEO_ID });
    // The audit row says a message was not sent — it is not a copy of what it would have said.
    expect(JSON.stringify(audit?.detail)).not.toContain("x");
  });

  it("closes the four call sites that queue a channel directly", async () => {
    // These callers (needs-review, attachments, project alerts) pass channel: "telegram"
    // themselves and never consulted the gate. Turning Telegram off must silence them too.
    await setChannelEnabled({ channel: "telegram", enabled: false, by: DEMO_CEO_ID });
    const key = `${TAG}-${randomUUID()}`;
    const r = await enqueueNotification({ idempotencyKey: key, payload: { text: "y" }, channel: "telegram" });
    expect(r.enqueued).toBe(false);
    expect((await getServiceSql()`select 1 from notification_outbox where idempotency_key = ${key}`).length).toBe(0);
  });

  it("still queues on a live channel", async () => {
    process.env.BOT_TOKEN = "0:test";
    const key = `${TAG}-${randomUUID()}`;
    const r = await enqueueNotification({ idempotencyKey: key, payload: { text: "z" }, channel: "inapp", recipientEmployeeId: DEMO_CEO_ID });
    expect(r.enqueued).toBe(true);
    expect((await getServiceSql()`select 1 from notification_outbox where idempotency_key = ${key}`).length).toBe(1);
  });
});
