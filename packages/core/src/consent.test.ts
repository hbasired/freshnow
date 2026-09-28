import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONSENT_POLICY_VERSION,
  ConsentNoticeChangedError,
  consentNotice,
  consentStatus,
  currentNoticeHash,
  hasCurrentConsent,
  noticeHash,
  noticeTag,
  recordConsent,
  requestConsentFromEveryone,
} from "./consent.js";
import { closeDb, getServiceSql } from "./db.js";
import { savePushSubscription } from "./push.js";

/**
 * Consent notice 2.0 — one notice for Telegram and the app, asked again whenever it changes.
 *
 * What must be true:
 *   - The notice names every service outside our database that the system is CONFIGURED to
 *     use — the AI providers with a key, Telegram when there is a bot token, the push relays
 *     when push is set up — and nothing it is not configured to use.
 *   - Changing what is used changes the words, and changing the words makes everyone's earlier
 *     consent out of date. Re-ordering the same providers does not.
 *   - Consent is only "current" for this version AND these exact words; agreement sent back
 *     against other words is refused, not recorded.
 *   - Everyone who uses the system and has not agreed is asked — in Telegram with a button tied
 *     to the words, and in the app — once per version of the words, never twice.
 */
const TAG = "CONSENT2";
const CORR = "c0c0c0c0-0000-4000-8000-00000000c2c2";
const ENV_KEYS = [
  "BOT_TOKEN",
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
  "NVIDIA_API_KEY",
  "LLM_PROVIDER_ORDER",
  "VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
  "VAPID_SUBJECT",
  "RETENTION_DAYS",
];
const saved: Record<string, string | undefined> = {};

async function person(p: { name: string; telegram?: boolean; app?: boolean; status?: string }): Promise<string> {
  const id = randomUUID();
  const tg = p.telegram ? 9_800_000_000_000 + Math.floor(Math.random() * 1e6) : null;
  await getServiceSql()`
    insert into employee (id, display_name, status, telegram_user_id, auth_user_id, access_role, is_synthetic)
    values (${id}, ${`${TAG} ${p.name}`}, ${p.status ?? "active"}, ${tg}, ${p.app ? randomUUID() : null}, 'employee', true)`;
  return id;
}

async function rowsFor(employeeId: string): Promise<{ channel: string; idempotency_key: string; payload: Record<string, unknown> }[]> {
  return [
    ...(await getServiceSql()<{ channel: string; idempotency_key: string; payload: Record<string, unknown> }[]>`
      select channel, idempotency_key, payload from notification_outbox
      where recipient_employee_id = ${employeeId} order by channel`),
  ];
}

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  // A known configuration, so the notice under test is deterministic.
  process.env.BOT_TOKEN = "0:test";
  process.env.GROQ_API_KEY = "gsk_test";
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.NVIDIA_API_KEY;
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  delete process.env.VAPID_SUBJECT;
  delete process.env.RETENTION_DAYS;
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  const sql = getServiceSql();
  const like = `${TAG} %`;
  await sql`delete from notification_outbox where recipient_employee_id in (select id from employee where display_name like ${like})`;
  await sql`delete from push_subscription where employee_id in (select id from employee where display_name like ${like})`;
  await sql`delete from consent_record where employee_id in (select id from employee where display_name like ${like})`;
  await sql`delete from audit_log where correlation_id = ${CORR}
            or (entity = 'employee' and entity_id in (select id::text from employee where display_name like ${like}))`;
  await sql`delete from employee where display_name like ${like}`;
});

afterAll(async () => {
  await closeDb();
});

describe("the notice names what the system is configured to use — and only that", () => {
  const env = (e: Record<string, string>): NodeJS.ProcessEnv => ({ ...e }) as NodeJS.ProcessEnv;

  it("names each AI provider that has a key, and no other", () => {
    const groqOnly = consentNotice("en", env({ GROQ_API_KEY: "k" }));
    expect(groqOnly).toMatch(/Groq/);
    expect(groqOnly).toMatch(/outside the UAE/);
    expect(groqOnly).not.toMatch(/OpenRouter/);
    expect(groqOnly).not.toMatch(/NVIDIA/);

    const all = consentNotice("en", env({ GROQ_API_KEY: "k", OPENROUTER_API_KEY: "k", NVIDIA_API_KEY: "k" }));
    for (const name of ["Groq", "OpenRouter", "NVIDIA"]) expect(all).toMatch(new RegExp(name));
  });

  it("says plainly when no AI service is used at all", () => {
    expect(consentNotice("en", env({}))).toMatch(/No AI service/);
  });

  it("names Telegram only when there is a bot, and the push relays only when push is set up", () => {
    expect(consentNotice("en", env({}))).not.toMatch(/Telegram —/);
    expect(consentNotice("en", env({ BOT_TOKEN: "0:x" }))).toMatch(/Telegram —.*outside the UAE/);
    expect(consentNotice("en", env({}))).not.toMatch(/Google, Apple or Microsoft/);
    expect(
      consentNotice("en", env({ VAPID_PUBLIC_KEY: "p", VAPID_PRIVATE_KEY: "q", VAPID_SUBJECT: "mailto:x@y.ae" })),
    ).toMatch(/Google, Apple or Microsoft/);
  });

  it("changes when the providers change, and not when only their order does", () => {
    const a = noticeHash(consentNotice("en", env({ GROQ_API_KEY: "k", OPENROUTER_API_KEY: "k" })));
    const reordered = noticeHash(
      consentNotice("en", env({ GROQ_API_KEY: "k", OPENROUTER_API_KEY: "k", LLM_PROVIDER_ORDER: "openrouter,groq" })),
    );
    const added = noticeHash(consentNotice("en", env({ GROQ_API_KEY: "k", OPENROUTER_API_KEY: "k", NVIDIA_API_KEY: "k" })));
    expect(reordered).toBe(a);
    expect(added).not.toBe(a);
  });

  it("states the retention period the company set, or that none is set", () => {
    expect(consentNotice("en", env({ RETENTION_DAYS: "90" }))).toMatch(/removed after 90 days/);
    expect(consentNotice("en", env({}))).toMatch(/not yet set how long/);
  });

  it("tells people both ways to withdraw — the bot command and the app", () => {
    const n = consentNotice("en", env({}));
    expect(n).toMatch(/\/withdraw in Telegram/);
    expect(n).toMatch(/Alerts → Your consent → Withdraw/);
  });

  it("shows English, not an unreviewed translation, in every language", () => {
    expect(consentNotice("hi")).toBe(consentNotice("en"));
    expect(consentNotice("ml")).toBe(consentNotice("en"));
  });
});

describe("only consent to today's words counts", () => {
  it("a new person has no consent", async () => {
    const p = await person({ name: "new", app: true });
    expect(await consentStatus(p)).toMatchObject({ consented: false, current: false, currentPolicyVersion: CONSENT_POLICY_VERSION });
    expect(await hasCurrentConsent(p)).toBe(false);
  });

  it("consent to the first notice is on record but not current", async () => {
    const p = await person({ name: "old notice", telegram: true });
    await getServiceSql()`insert into consent_record (employee_id, policy_version, notice_hash)
                          values (${p}, 'demo-1.0', ${noticeHash("the old words")})`;
    expect(await consentStatus(p)).toMatchObject({ consented: true, current: false, policyVersion: "demo-1.0" });
    expect(await hasCurrentConsent(p)).toBe(false);
  });

  it("refuses agreement sent back against words that are not today's", async () => {
    const p = await person({ name: "stale", app: true });
    await expect(recordConsent({ employeeId: p, noticeHash: noticeHash("some older wording"), via: "app" })).rejects.toBeInstanceOf(
      ConsentNoticeChangedError,
    );
    expect((await consentStatus(p)).consented).toBe(false);
  });

  it("records today's version and the hash of today's words, and audits which door it came through", async () => {
    const p = await person({ name: "agrees", app: true });
    const r = await recordConsent({ employeeId: p, noticeHash: currentNoticeHash(), via: "app", correlationId: CORR });
    expect(r).toMatchObject({ consented: true, current: true, policyVersion: CONSENT_POLICY_VERSION });
    const [row] = await getServiceSql()<{ notice_hash: string }[]>`select notice_hash from consent_record where employee_id = ${p}`;
    expect(row?.notice_hash).toBe(noticeHash(consentNotice("en")));
    const [audit] = await getServiceSql()<{ detail: { via: string } }[]>`
      select detail from audit_log where action = 'consent.recorded' and entity_id = ${p}`;
    expect(audit?.detail.via).toBe("app");
  });

  it("a new AI provider makes yesterday's consent out of date", async () => {
    const p = await person({ name: "provider change", telegram: true });
    await recordConsent({ employeeId: p, noticeHash: currentNoticeHash(), via: "telegram" });
    expect(await hasCurrentConsent(p)).toBe(true);
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    expect(await hasCurrentConsent(p)).toBe(false);
    delete process.env.OPENROUTER_API_KEY;
    expect(await hasCurrentConsent(p)).toBe(true);
  });
});

describe("everyone who has not agreed is asked, once per version of the words", () => {
  it("asks in Telegram with a button tied to the words, and in the app's inbox", async () => {
    const p = await person({ name: "telegram user", telegram: true, app: true });
    const r = await requestConsentFromEveryone({ employeeIds: [p], correlationId: CORR });
    expect(r).toEqual({ people: 1, enqueued: 2 });

    const rows = await rowsFor(p);
    expect(rows.map((x) => x.channel)).toEqual(["inapp", "telegram"]);
    const tg = rows.find((x) => x.channel === "telegram")!;
    expect(tg.payload["kind"]).toBe("consent.requested");
    expect(String(tg.payload["text"])).toContain(consentNotice("en"));
    const buttons = (tg.payload["reply_markup"] as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard.flat();
    expect(buttons.map((b) => b.callback_data)).toContain(`consent:renew:${noticeTag()}`);
  });

  it("adds a phone notification for someone with a device turned on", async () => {
    process.env.VAPID_PUBLIC_KEY = "p";
    process.env.VAPID_PRIVATE_KEY = "q";
    process.env.VAPID_SUBJECT = "mailto:ops@example.ae";
    // Web push is off by default (migration 0017); "Telegram + App" turns it on.
    const sql = getServiceSql();
    const [before] = await sql<{ enabled: boolean }[]>`select enabled from channel_setting where channel = 'webpush'`;
    await sql`update channel_setting set enabled = true where channel = 'webpush'`;
    try {
      const p = await person({ name: "app user", app: true });
      await savePushSubscription({ employeeId: p, endpoint: `https://push.example.invalid/${randomUUID()}`, p256dh: "BKey", auth: "a" });
      await requestConsentFromEveryone({ employeeIds: [p] });
      expect((await rowsFor(p)).map((x) => x.channel)).toEqual(["inapp", "webpush"]);
    } finally {
      await sql`update channel_setting set enabled = ${before?.enabled ?? false} where channel = 'webpush'`;
    }
  });

  it("does not ask twice for the same words", async () => {
    const p = await person({ name: "asked once", telegram: true });
    await requestConsentFromEveryone({ employeeIds: [p] });
    const again = await requestConsentFromEveryone({ employeeIds: [p] });
    expect(again.enqueued).toBe(0);
    expect((await rowsFor(p)).length).toBe(2);
  });

  it("asks again when the words change", async () => {
    const p = await person({ name: "asked per version", telegram: true });
    await requestConsentFromEveryone({ employeeIds: [p] });
    process.env.RETENTION_DAYS = "120";
    const r = await requestConsentFromEveryone({ employeeIds: [p] });
    expect(r.enqueued).toBe(2);
    expect((await rowsFor(p)).length).toBe(4);
  });

  it("does not try a channel the company has switched off — no dropped rows, no audit noise each minute", async () => {
    const sql = getServiceSql();
    await sql`update channel_setting set enabled = false where channel = 'telegram'`;
    try {
      const p = await person({ name: "app only company", telegram: true });
      const since = new Date();
      await requestConsentFromEveryone({ employeeIds: [p] });
      await requestConsentFromEveryone({ employeeIds: [p] });
      expect((await rowsFor(p)).map((x) => x.channel)).toEqual(["inapp"]);
      const noise = await sql`select 1 from audit_log where action = 'notification.channel_disabled' and created_at >= ${since}
                              and detail->>'recipientEmployeeId' = ${p}`;
      expect(noise.length).toBe(0);
    } finally {
      await sql`update channel_setting set enabled = true where channel = 'telegram'`;
    }
  });

  it("does not ask people who agreed, who are switched off, or who have no way to be reached", async () => {
    const agreed = await person({ name: "agreed", telegram: true });
    await recordConsent({ employeeId: agreed, noticeHash: currentNoticeHash(), via: "telegram" });
    const off = await person({ name: "withdrawn", telegram: true, status: "disabled" });
    const record = await person({ name: "seeded record only" });
    const r = await requestConsentFromEveryone({ employeeIds: [agreed, off, record] });
    expect(r).toEqual({ people: 0, enqueued: 0 });
    for (const id of [agreed, off, record]) expect(await rowsFor(id)).toEqual([]);
  });
});
