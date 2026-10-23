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
import { DETECTORS } from "./compliance.js";
import { closeDb, getServiceSql } from "./db.js";
import { savePushSubscription } from "./push.js";

/**
 * Consent notice 3.0 — one notice for Telegram and the app, asked again whenever it changes.
 *
 * What must be true:
 *   - The notice names every service outside our database that the system is CONFIGURED to
 *     use — the AI providers with a key, Telegram when there is a bot token, the push relays
 *     when push is set up, Televend when the connector reaches it — and nothing it is not
 *     configured to use. The same goes for what it records: photos only with a file store, phone
 *     sign-in only with phone sign-in switched on (3.0); stock and cash always (TASK-060, TASK-061).
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
  // Notice 3.0's parts: off unless a test switches them on.
  "TELEVEND_MODE",
  "TELEVEND_USERNAME",
  "TELEVEND_CLIENT_ID",
  "SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
  "APP_PIN_PEPPER",
  "MEDIA_RETENTION",
  "MEDIA_RETENTION_EVIDENCE_DAYS",
  "MEDIA_RETENTION_VIDEO_DAYS",
  "MEDIA_RETENTION_RECEIPT_DAYS",
  "MEDIA_RETENTION_CHAT_DAYS",
];
const SWITCHED_OFF = ENV_KEYS.slice(ENV_KEYS.indexOf("TELEVEND_MODE"));
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
  for (const k of SWITCHED_OFF) delete process.env[k];
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

  it("says who can see what since the new roles: Admins, and for the machines the operations managers", () => {
    expect(consentNotice("en", env({}))).toMatch(/the CEO and the company's Admins/);
    // Without Televend there are no machine records — the Ops Head is named only for stock (TASK-060).
    expect(consentNotice("en", env({}))).not.toMatch(/machine records from Televend/);
    expect(consentNotice("en", env({ TELEVEND_USERNAME: "u" }))).toMatch(/the CEO, Admins, the Ops Head and Supervisors/);
  });
});

describe("notice 3.0 — the operations work, each part named only when it is switched on", () => {
  const env = (e: Record<string, string>): NodeJS.ProcessEnv => ({ ...e }) as NodeJS.ProcessEnv;
  const hash = (e: Record<string, string>) => noticeHash(consentNotice("en", env(e)));

  it("names Televend exactly when the connector reaches it — the compliance rule's own test", () => {
    const notReached: Record<string, string>[] = [{}, { TELEVEND_MODE: "files", TELEVEND_USERNAME: "u" }];
    const reached: Record<string, string>[] = [{ TELEVEND_USERNAME: "u" }, { TELEVEND_MODE: "official", TELEVEND_CLIENT_ID: "c" }];
    for (const e of notReached) {
      expect(consentNotice("en", env(e))).not.toMatch(/Televend/);
      expect(DETECTORS.find((d) => d.id === "televend")!.reachable(env(e))).toBe(false);
    }
    for (const e of reached) {
      const n = consentNotice("en", env(e));
      expect(n).toMatch(/Televend — the vending machines' own system, run by INTIS d\.o\.o\./);
      expect(n).toMatch(/refills and machine alarms that Televend, the machines' own system, records against your name/);
      expect(n).toMatch(/FreshNow only reads from Televend and sends it nothing about you/);
      // Its hosting region is not published, so the notice claims none (compliance/processors.json).
      expect(n).toMatch(/not yet confirmed/);
      expect(DETECTORS.find((d) => d.id === "televend")!.reachable(env(e))).toBe(true);
    }
  });

  it("names photos and videos only when there is a store for them, with the periods only once they are switched on", () => {
    const store = { SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_SECRET_KEY: "s" };
    expect(consentNotice("en", env({}))).not.toMatch(/Photos/);
    const off = consentNotice("en", env(store));
    expect(off).toMatch(/Photos and short videos you send as proof of work/);
    expect(off).toMatch(/Location and device details are removed before they are stored/);
    expect(off).toMatch(/not yet set how long photos and videos are kept/);
    const on = consentNotice("en", env({ ...store, MEDIA_RETENTION: "on" }));
    expect(on).toMatch(/proof-of-work photos 180 days, videos 30 days, receipts 5 years, photos in chat 1 year/);
    expect(consentNotice("en", env({ ...store, MEDIA_RETENTION: "on", MEDIA_RETENTION_VIDEO_DAYS: "14" }))).toMatch(/videos 14 days/);
  });

  it("names phone sign-in and the app's wake-up only with phone sign-in on — and says what they are not for", () => {
    expect(consentNotice("en", env({}))).not.toMatch(/phone app/);
    // device-auth.ts refuses a pepper under 32 characters, so the notice does not count one either.
    expect(consentNotice("en", env({ APP_PIN_PEPPER: "x".repeat(31) }))).not.toMatch(/phone app/);
    const n = consentNotice("en", env({ APP_PIN_PEPPER: "x".repeat(32) }));
    expect(n).toMatch(/when you sign in and out, and wrong PINs/);
    expect(n).toMatch(/never used to check when or how much you work/);
    expect(n).toMatch(/No attendance tracking from phone sign-ins/);
    expect(n).toMatch(/after three wrong PINs in a row you and your lead are told/);
    expect(n).toMatch(/A difference is a fact about what is held, and a person looks at it before anything follows/);
    expect(n).toMatch(/Google's Firebase service wakes the app .* The signal carries no message/);
    expect(n).toMatch(/sessions are deleted 30 days after they end/);
  });

  it("names the stock everyone may be given, who sees it and how long it is kept — with or without the phone app (TASK-060)", () => {
    for (const n of [consentNotice("en", env({})), consentNotice("en", env({ APP_PIN_PEPPER: "x".repeat(32) }))]) {
      expect(n).toMatch(/Company stock you are given, hand back, use or count/);
      expect(n).toMatch(/The stock you hold and hand over: the warehouse keepers, the Ops Head, Supervisors, the CEO and Admins/);
      expect(n).toMatch(/every carton has one holder .* A difference is a fact about what is held/);
      expect(n).toMatch(/Stock records .* are kept as the company's stock record; the words you type on them go with your other words/);
    }
  });

  it("names the cash everyone who handles it records, who sees it and how long it is kept — with or without the phone app (TASK-061)", () => {
    for (const n of [consentNotice("en", env({})), consentNotice("en", env({ APP_PIN_PEPPER: "x".repeat(32) }))]) {
      expect(n).toMatch(/Cash you handle for the company: what you collect from each machine, put back to test it, spend .* and deposit/);
      expect(n).toMatch(/Cash is balanced the same way, shift by shift, and a cash auditor checks each shift/);
      expect(n).toMatch(/The cash you record, and its receipts: the cash auditor, the Ops Head, the CEO and Admins/);
      expect(n).toMatch(/Cash records are kept as the company's financial record/);
    }
    // The machines' own records are named only where Televend is read.
    expect(consentNotice("en", env({}))).not.toMatch(/the machines' own records say they took/);
    expect(consentNotice("en", env({ TELEVEND_USERNAME: "u" }))).toMatch(/beside the cash the machines' own records say they took/);
  });

  it("switching any part on or off changes the words — and so asks everyone again", () => {
    const base = hash({});
    const variants: Record<string, string>[] = [
      { TELEVEND_USERNAME: "u" },
      { SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_SECRET_KEY: "s" },
      { SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_SECRET_KEY: "s", MEDIA_RETENTION: "on" },
      { APP_PIN_PEPPER: "x".repeat(40) },
    ];
    const hashes = variants.map(hash);
    expect(new Set([base, ...hashes]).size).toBe(variants.length + 1);
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

  it("marks the request in the inbox read the moment the person agrees", async () => {
    const p = await person({ name: "agrees after asked", telegram: true, app: true });
    await requestConsentFromEveryone({ employeeIds: [p] });
    await recordConsent({ employeeId: p, noticeHash: currentNoticeHash(), via: "telegram" });
    const [inbox] = await getServiceSql()<{ read_at: Date | null }[]>`
      select read_at from notification_outbox where recipient_employee_id = ${p} and channel = 'inapp'`;
    expect(inbox?.read_at).not.toBeNull();
  });

  it("clears a request left unread by someone who agreed earlier, and leaves other messages alone", async () => {
    const sql = getServiceSql();
    const p = await person({ name: "agreed long ago", app: true });
    await requestConsentFromEveryone({ employeeIds: [p] });
    // Agreed before settling existed: the consent row is there, the request is still unread.
    await sql`insert into consent_record (employee_id, policy_version, notice_hash) values (${p}, ${CONSENT_POLICY_VERSION}, ${currentNoticeHash()})`;
    await sql`insert into notification_outbox (idempotency_key, channel, recipient_employee_id, payload, status)
              values (${`${TAG}-other-${p}`}, 'inapp', ${p}, ${sql.json({ kind: "task.assigned", text: "a task" })}, 'sent')`;
    await requestConsentFromEveryone({ employeeIds: [p] });
    const rows = await sql<{ kind: string; read_at: Date | null }[]>`
      select payload->>'kind' as kind, read_at from notification_outbox where recipient_employee_id = ${p} and channel = 'inapp' order by kind`;
    expect(rows.find((r) => r.kind === "consent.requested")?.read_at).not.toBeNull();
    expect(rows.find((r) => r.kind === "task.assigned")?.read_at).toBeNull();
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
