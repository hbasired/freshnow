import { createHash } from "node:crypto";
import { logAudit } from "./audit.js";
import { emailAddressAllowed, inboxConfig } from "./email-config.js";
import { channelAvailability, liveChannels } from "./channels.js";
import { getServiceSql } from "./db.js";
import { enqueueNotification } from "./outbox.js";
import { hasPushDevice } from "./push.js";
import { retentionDays } from "./retention.js";

/**
 * PDPL consent — one notice, both channels, asked again whenever it changes.
 *
 * Why this exists. UAE Federal Decree-Law No. 45 of 2021 lets personal data leave the country
 * on a few grounds (Art. 22–23); with the Executive Regulations still unissued, the usable ones
 * are a PDPL-grade contract or "the express Consent of the Data Subject". Consent must be
 * specific (Art. 6), so it only covers what the person was told. The first notice (demo-1.0)
 * said updates were "stored in the company database, visible to you and the CEO" — it never
 * mentioned Telegram's servers abroad or the AI services that read every update. Consent to
 * that notice is not consent to those transfers (CEO deck, slides 10 and 15).
 *
 * What this module guarantees:
 *   1. The notice NAMES what the system is actually configured to use. It is built from the
 *      same environment the senders and the model client read, so it cannot drift from the
 *      truth: add or remove an AI provider and the text changes.
 *   2. The text is hashed. "Current" consent means a record of THIS version AND one of THESE
 *      hashes — so any change to the words, including a provider change, makes everyone's
 *      consent outdated and they are asked again. Changing only the provider ORDER does not
 *      change the text, so it does not re-ask anyone.
 *   3. Until a person agrees to the current notice: the bot and the dashboard do not take
 *      their updates (the doors, in bot.ts and routes/dashboard.ts), and the outbox holds every
 *      message to them except the in-app inbox and the consent request itself (the relay, in
 *      worker/outbox-relay.ts). Nothing about them goes to Telegram, a push relay or email.
 *   4. Everyone is ASKED — in Telegram with an "I agree" button, and in the app — without
 *      having to message first (`requestConsentFromEveryone`, run by the worker).
 *
 * UNVERIFIED: the wording is a developer's draft, not FreshNow's or a lawyer's. The version
 * string says "draft" until the company signs it off. Hindi and Malayalam versions must be
 * written by native speakers (the machine-written ones for 1.0 were never reviewed); until
 * they exist, everyone sees English.
 */
export const CONSENT_POLICY_VERSION = "2.0-draft";

type Env = NodeJS.ProcessEnv;

/**
 * The AI services the model client may call, in a fixed order so that re-ordering the
 * fallback chain (LLM_PROVIDER_ORDER) does not change the notice. Availability is exactly
 * the client's own rule in llm/client.ts: a key is set.
 */
const AI_PROVIDERS = [
  { env: "GROQ_API_KEY", line: "Groq, Inc. — a US company; its data centres are outside the UAE." },
  {
    env: "OPENROUTER_API_KEY",
    line: "OpenRouter, Inc. — a US company that passes the text on to the AI model's own provider, outside the UAE.",
  },
  { env: "NVIDIA_API_KEY", line: "NVIDIA Corporation — a US company; outside the UAE." },
] as const;

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** Every service outside the company's own database that receives someone's data, as notice lines. */
export function dataRecipientLines(env: Env = process.env): string[] {
  const lines: string[] = [];
  if (channelAvailability("telegram", env).available) {
    lines.push(
      "Telegram — if you use the FreshNow bot, your messages with it are stored by Telegram on servers outside the UAE.",
    );
  }
  const ai = AI_PROVIDERS.filter((p) => env[p.env]);
  if (ai.length > 0) {
    lines.push(
      "An AI service reads what you type or say, only to recognise problems and how urgent they are. Today that is:\n" +
        ai.map((p) => `   – ${p.line}`).join("\n") +
        (env.GROQ_API_KEY ? "\n   Voice notes are turned into text by Groq." : ""),
    );
  } else {
    lines.push("No AI service is switched on: your words are read only by people.");
  }
  if (channelAvailability("webpush", env).available) {
    lines.push(
      "Phone and desktop notifications, if you turn them on, are relayed by Google, Apple or Microsoft depending on your device. " +
        "They are encrypted to your device; the relay cannot read them.",
    );
  }
  if (channelAvailability("email", env).available) {
    lines.push(`Email, if the company emails you, is sent through ${env.SMTP_HOST}.`);
  }
  const inbox = inboxConfig(env);
  if (inbox) {
    lines.push(
      `Emails you send to ${inbox.inboxAddress} are read by the system from that mailbox (through ${inbox.host}) to file your updates. ` +
        "Only email to that address is read.",
    );
  }
  const chat = hostOf(env.CHAT_WEBHOOK_URL);
  if (chat) lines.push(`Messages about work are also posted to the company chat at ${chat}.`);
  if (env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY && env.LANGFUSE_CAPTURE_CONTENT === "1") {
    const lf = hostOf(env.LANGFUSE_BASE_URL ?? "http://localhost:3000");
    lines.push(`Troubleshooting copies of what the AI service is asked are kept by Langfuse at ${lf}.`);
  }
  return lines;
}

/**
 * The notice, in English. Every language falls back to English until a native speaker has
 * written the translation — showing someone words they cannot read would not be consent.
 */
export function consentNotice(_language = "en", env: Env = process.env): string {
  const days = retentionDays(env);
  return [
    `FreshNow Ops — privacy notice (version ${CONSENT_POLICY_VERSION})`,
    "",
    "What this system records about you",
    "• The tasks you are given and the status you report, including your own words, typed or spoken.",
    "• Problems you raise, so they reach the person who can clear them.",
    "• Your name, department, role, site and shift.",
    "• If you turn on notifications in the app: that device's push address.",
    "",
    "Why",
    "To run the company's daily work: tasks, problems, and who needs to act. Fixed company rules — never the AI — decide who is told and when something escalates.",
    "",
    "Who can see it",
    "You, the people you report to, and the CEO. It is kept in FreshNow's own database.",
    "",
    "Where your data goes beyond FreshNow's database — this is what you are agreeing to",
    ...dataRecipientLines(env).map((l) => `• ${l}`),
    "",
    "What it does NOT do",
    "• No location tracking. No productivity scoring. No ranking of people. No sentiment analysis.",
    "",
    "How long",
    days
      ? `• Your own words are removed after ${days} days. Statuses, counts and the audit trail are kept.`
      : "• The company has not yet set how long your own words are kept; until it does, they are kept.",
    "",
    "Your choices",
    "• Until you agree, the system does not take your updates, and nothing about you is sent through Telegram, notifications or email except this request — you will find messages only in the app's inbox.",
    "• You can withdraw at any time: /withdraw in Telegram, or Alerts → Your consent → Withdraw in the app. Withdrawing switches your account off; records already made stay as the company's record.",
    "• To see or correct what is held about you, ask the CEO.",
  ].join("\n");
}

/** Hash of the exact notice text shown, so consent stays provable after a re-wording. */
export function noticeHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The hash of the notice a person is shown now. */
export function currentNoticeHash(env: Env = process.env): string {
  return noticeHash(consentNotice("en", env));
}

/**
 * Every hash that counts as the current notice — one per language once translations exist.
 * A person agreed to "the current notice" if they agreed to any of these words.
 */
export function currentNoticeHashes(env: Env = process.env): string[] {
  return [currentNoticeHash(env)];
}

/** Short form carried in a Telegram button, so a tap on an out-of-date message is caught. */
export function noticeTag(env: Env = process.env): string {
  return currentNoticeHash(env).slice(0, 16);
}

export interface ConsentStatus {
  /** Any consent on record, to any version. */
  consented: boolean;
  /** Consent to the notice shown today — the only kind that permits processing. */
  current: boolean;
  consentedAt: string | null;
  policyVersion: string | null;
  currentPolicyVersion: string;
}

/** True when this person agreed to the notice as it reads today. */
export async function hasCurrentConsent(employeeId: string): Promise<boolean> {
  const sql = getServiceSql();
  const rows = await sql<{ ok: boolean }[]>`
    select exists (
      select 1 from consent_record
      where employee_id = ${employeeId}
        and policy_version = ${CONSENT_POLICY_VERSION}
        and notice_hash = any(${currentNoticeHashes()})
    ) as ok`;
  return rows[0]?.ok ?? false;
}

/** The person's latest consent, and whether it is to the current notice. */
export async function consentStatus(employeeId: string): Promise<ConsentStatus> {
  const sql = getServiceSql();
  const rows = await sql<{ policy_version: string; consented_at: Date }[]>`
    select policy_version, consented_at from consent_record
    where employee_id = ${employeeId} order by consented_at desc limit 1`;
  const r = rows[0];
  return {
    consented: r != null,
    current: r != null && (await hasCurrentConsent(employeeId)),
    consentedAt: r ? r.consented_at.toISOString() : null,
    policyVersion: r?.policy_version ?? null,
    currentPolicyVersion: CONSENT_POLICY_VERSION,
  };
}

export class ConsentNoticeChangedError extends Error {}

/**
 * Once someone has agreed, the request in their inbox is done: mark it read so the bell stops
 * telling them "until you do, your updates can't be taken". Left unread it sat at the top of
 * the inbox for people who had already agreed, contradicting the app they were using.
 * Only requests are touched — never another message.
 */
async function settleConsentRequests(employeeIds: readonly string[] | null): Promise<number> {
  const sql = getServiceSql();
  const rows = await sql`
    update notification_outbox o set read_at = now()
    where o.channel = 'inapp' and o.read_at is null
      and o.payload->>'kind' = 'consent.requested'
      and (${employeeIds ? [...employeeIds] : null}::uuid[] is null or o.recipient_employee_id = any(${employeeIds ? [...employeeIds] : null}::uuid[]))
      and exists (
        select 1 from consent_record c
        where c.employee_id = o.recipient_employee_id
          and c.policy_version = ${CONSENT_POLICY_VERSION}
          and c.notice_hash = any(${currentNoticeHashes()})
      )
    returning o.id`;
  return rows.length;
}

/**
 * Record consent. The caller sends back the hash of the notice it SHOWED; if the words have
 * changed since, nothing is recorded — the whole value of the hash is that it proves what
 * was agreed to, so it must never be written against text the person did not see.
 */
export async function recordConsent(p: {
  employeeId: string;
  noticeHash: string;
  /** Where they agreed: the bot's button, the app's screen, or a reply to the notice by email. */
  via: "telegram" | "app" | "email";
  correlationId?: string;
}): Promise<ConsentStatus> {
  if (!currentNoticeHashes().includes(p.noticeHash)) {
    throw new ConsentNoticeChangedError("The notice has changed since it was shown. Read the new one and agree again.");
  }
  const sql = getServiceSql();
  await sql`insert into consent_record (employee_id, policy_version, notice_hash)
            values (${p.employeeId}, ${CONSENT_POLICY_VERSION}, ${p.noticeHash})`;
  await logAudit({
    correlationId: p.correlationId,
    actor: `employee:${p.employeeId}`,
    action: "consent.recorded",
    entity: "employee",
    entityId: p.employeeId,
    detail: { via: p.via, policyVersion: CONSENT_POLICY_VERSION, noticeHash: p.noticeHash },
  });
  await settleConsentRequests([p.employeeId]);
  return consentStatus(p.employeeId);
}

/** The Telegram buttons under a consent request. The tag ties a tap to the words it was under. */
export function consentKeyboard(tag: string = noticeTag()): { inline_keyboard: { text: string; callback_data: string }[][] } {
  return {
    inline_keyboard: [
      [{ text: "✅ I agree", callback_data: `consent:renew:${tag}` }],
      [{ text: "Not now", callback_data: "consent:later" }],
    ],
  };
}

/**
 * Ask everyone who uses the system and has not agreed to the current notice — in Telegram
 * (the notice with an "I agree" button), in the app's inbox, and as a notification on any
 * device they turned on. Idempotent: each row is keyed on the notice, so running this every
 * few minutes asks each person once per version of the words, never twice.
 *
 * "Uses the system" means a Telegram account or a dashboard sign-in is linked, or — since
 * TASK-054 — an email address is on file, so a person the CEO added with only an email is asked
 * by email and agrees by replying "I AGREE" (email-inbound.ts). Seeded rows with none of these
 * are records, not users, and there is nobody to ask.
 */
export async function requestConsentFromEveryone(
  opts: {
    correlationId?: string;
    /** Only these people — e.g. one account just linked. Everyone when absent. */
    employeeIds?: readonly string[];
  } = {},
): Promise<{ people: number; enqueued: number }> {
  const sql = getServiceSql();
  const hashes = currentNoticeHashes();
  const only = opts.employeeIds ? [...opts.employeeIds] : null;
  // Requests already answered — including ones left unread before this cleanup existed.
  await settleConsentRequests(only);
  const people = await sql<{ id: string; telegram_user_id: string | null; email: string | null; display_name: string }[]>`
    select e.id, e.telegram_user_id, e.email, e.display_name from employee e
    where e.status = 'active'
      and (${only}::uuid[] is null or e.id = any(${only}::uuid[]))
      and (e.telegram_user_id is not null or e.auth_user_id is not null or e.email is not null)
      and not exists (
        select 1 from consent_record c
        where c.employee_id = e.id and c.policy_version = ${CONSENT_POLICY_VERSION} and c.notice_hash = any(${hashes})
      )`;
  if (people.length === 0) return { people: 0, enqueued: 0 };

  const tag = noticeTag();
  const notice = consentNotice("en");
  // Only channels that are live right now. Queueing on a switched-off channel is dropped AND
  // audited by enqueueNotification — once a minute, per person, for as long as they have not
  // agreed — which would bury the audit log under a message nobody could have received.
  const live = new Set(await liveChannels());
  const withDevice = live.has("webpush") ? await hasPushDevice(people.map((p) => p.id)) : new Set<string>();
  const reason = "the privacy notice changed";
  let enqueued = 0;
  for (const person of people) {
    const key = (channel: string) => `consent.requested:${tag}:${person.id}:${channel}`;
    const rows = [
      live.has("telegram") &&
        person.telegram_user_id != null &&
        enqueueNotification({
          idempotencyKey: key("telegram"),
          chatId: Number(person.telegram_user_id),
          channel: "telegram",
          recipientEmployeeId: person.id,
          reason,
          correlationId: opts.correlationId,
          payload: {
            kind: "consent.requested",
            text:
              "📄 FreshNow's privacy notice has changed. Please read it and tap “✅ I agree”. " +
              "Until you do, I can't take your updates.\n\n" +
              notice,
            reply_markup: consentKeyboard(tag),
          },
        }),
      live.has("inapp") &&
        enqueueNotification({
          idempotencyKey: key("inapp"),
          channel: "inapp",
          recipientEmployeeId: person.id,
          reason,
          correlationId: opts.correlationId,
          payload: {
            kind: "consent.requested",
            title: "Please read the updated privacy notice",
            text: `The privacy notice changed (version ${CONSENT_POLICY_VERSION}). Open the app to read it and agree — until you do, your updates can't be taken and messages reach you only here.`,
            url: "/app/",
            tag: "consent",
          },
        }),
      // By email: the whole notice in the body, and the hash of exactly those words in the
      // payload, so a reply "I AGREE" records agreement to what this email said — and to nothing
      // else if the notice has changed since (recordConsent refuses a stale hash).
      live.has("email") &&
        person.email != null &&
        emailAddressAllowed(person.email) &&
        enqueueNotification({
          idempotencyKey: key("email"),
          channel: "email",
          recipientEmployeeId: person.id,
          reason,
          correlationId: opts.correlationId,
          payload: {
            kind: "consent.requested",
            title: "Please read FreshNow's privacy notice",
            subject: "FreshNow privacy notice — reply I AGREE to start",
            noticeHash: currentNoticeHash(),
            noticeTag: tag,
            text:
              `Hello ${person.display_name},\n\n` +
              "FreshNow is the system the company uses for daily tasks. Before it can send you work or take your updates, " +
              "please read the notice below.\n\n" +
              "To agree, reply to this email with the words: I AGREE\n" +
              "If you do not agree, do nothing — nothing about you will be sent by email, and you can ask the CEO any questions.\n\n" +
              "────────────────────────────\n" +
              notice,
          },
        }),
      withDevice.has(person.id) &&
        enqueueNotification({
          idempotencyKey: key("webpush"),
          channel: "webpush",
          recipientEmployeeId: person.id,
          reason,
          correlationId: opts.correlationId,
          payload: {
            kind: "consent.requested",
            title: "Please read the updated privacy notice",
            text: "Open FreshNow to read it and agree.",
            url: "/app/",
            tag: "consent",
          },
        }),
    ];
    for (const r of rows) if (r && (await r).enqueued) enqueued++;
  }
  if (enqueued > 0) {
    await logAudit({
      correlationId: opts.correlationId,
      actor: "system",
      action: "consent.requested",
      entity: "consent_record",
      entityId: CONSENT_POLICY_VERSION,
      detail: { people: people.length, enqueued, noticeTag: tag },
    });
  }
  return { people: people.length, enqueued };
}
