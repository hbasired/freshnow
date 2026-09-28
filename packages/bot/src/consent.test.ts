import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Update } from "grammy/types";
import { closeDb, consentNotice, getServiceSql, hasCurrentConsent, noticeHash, noticeTag } from "@freshnow/core";
import { createBot } from "./bot.js";

/**
 * The consent door in Telegram — through the REAL bot, with every Bot API call intercepted.
 *
 * What must hold (consent notice 2.0, core/src/consent.ts):
 *   - A linked person who has not agreed to today's notice gets the notice and an "I agree"
 *     button for ANYTHING they send, and nothing they sent is processed or stored — their words
 *     would otherwise go to the AI services the notice names. They are told it was not recorded.
 *   - Agreeing through the button records consent to exactly today's words; a tap under an
 *     older version of the words records nothing and shows the new words.
 *   - Withdrawing still works without agreeing first.
 */

const bot = createBot({ token: "0:test" });
bot.botInfo = { id: 1, is_bot: true, first_name: "test", username: "freshnow_test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false } as unknown as typeof bot.botInfo;

interface Sent { method: string; payload: Record<string, unknown> }
const sent: Sent[] = [];
let msgId = 500;
bot.api.config.use(async (_prev, method, payload) => {
  sent.push({ method, payload: payload as Record<string, unknown> });
  if (method === "sendMessage") {
    const p = payload as { chat_id: number; text: string };
    return { ok: true, result: { message_id: ++msgId, date: 0, chat: { id: p.chat_id, type: "private" }, text: p.text } } as never;
  }
  return { ok: true, result: true } as never;
});

let updateId = 5000;
const from = (tg: number) => ({ id: tg, is_bot: false, first_name: "T" });
function text(tg: number, t: string): Update {
  const entities = t.startsWith("/") ? [{ type: "bot_command" as const, offset: 0, length: t.split(" ")[0]!.length }] : [];
  return { update_id: updateId++, message: { message_id: ++msgId, date: 0, chat: { id: tg, type: "private", first_name: "T" }, from: from(tg), text: t, entities } };
}
function tap(tg: number, data: string): Update {
  return {
    update_id: updateId++,
    callback_query: { id: String(updateId), from: from(tg), chat_instance: "x", data, message: { message_id: ++msgId, date: 0, chat: { id: tg, type: "private", first_name: "T" }, text: "menu" } },
  };
}
function drain(): { texts: string[]; buttons: string[]; alerts: string[] } {
  const out = { texts: [] as string[], buttons: [] as string[], alerts: [] as string[] };
  for (const s of sent) {
    if (s.method === "sendMessage") {
      out.texts.push(String(s.payload["text"]));
      const kb = (s.payload["reply_markup"] as { inline_keyboard?: { callback_data?: string }[][] } | undefined)?.inline_keyboard ?? [];
      for (const row of kb) for (const b of row) if (b.callback_data) out.buttons.push(b.callback_data);
    }
    if (s.method === "answerCallbackQuery" && s.payload["text"]) out.alerts.push(String(s.payload["text"]));
  }
  sent.length = 0;
  return out;
}

let tg = 0;
let id = "";

beforeEach(async () => {
  tg = 9_950_000_000_000 + Math.floor(Math.random() * 1e6);
  id = randomUUID();
  await getServiceSql()`insert into employee (id, display_name, status, is_synthetic, access_role, telegram_user_id)
    values (${id}, ${"CONSENT-BOT " + id.slice(0, 8)}, 'active', true, 'employee', ${tg})`;
  sent.length = 0;
});

afterEach(async () => {
  const sql = getServiceSql();
  await sql`delete from bot_session where key = ${String(tg)}`;
  await sql`delete from consent_record where employee_id = ${id}`;
  await sql`delete from task_update where employee_id = ${id}`;
  await sql`delete from task where employee_id = ${id}`;
  await sql`delete from audit_log where actor = ${`employee:${id}`} or actor = ${`telegram:${tg}`} or (entity = 'employee' and entity_id = ${id})`;
  await sql`delete from employee where id = ${id}`;
});

afterAll(async () => {
  await closeDb();
});

describe("a linked person who has not agreed to today's notice", () => {
  it("gets the notice and an I-agree button instead of having their message processed", async () => {
    await bot.handleUpdate(text(tg, "chiller in van 2 is not cooling"));
    const { texts, buttons } = drain();
    const said = texts.join("\n");
    expect(said).toMatch(/privacy notice has changed/);
    expect(said).toMatch(/have not recorded the message you just sent/);
    expect(said).toContain(consentNotice("en"));
    expect(buttons).toContain(`consent:renew:${noticeTag()}`);
    expect(buttons).toContain("consent:later");
    // Nothing about the message was stored.
    const updates = await getServiceSql()`select 1 from task_update where employee_id = ${id}`;
    expect(updates.length).toBe(0);
  });

  it("gets the notice for a menu tap too, with a short explanation on the button itself", async () => {
    await bot.handleUpdate(tap(tg, "menu:log"));
    const { texts, alerts } = drain();
    expect(alerts.join(" ")).toMatch(/updated notice/);
    expect(texts.join("\n")).toContain(consentNotice("en"));
  });

  it("is shown the notice by /start, without being told a message was lost", async () => {
    await bot.handleUpdate(text(tg, "/start"));
    const said = drain().texts.join("\n");
    expect(said).toMatch(/privacy notice has changed/);
    expect(said).not.toMatch(/have not recorded/);
  });

  it("agrees with one tap, and consent to exactly today's words is recorded", async () => {
    await bot.handleUpdate(tap(tg, `consent:renew:${noticeTag()}`));
    expect(drain().texts.join("\n")).toMatch(/Thank you — recorded/);
    expect(await hasCurrentConsent(id)).toBe(true);
    const [row] = await getServiceSql()<{ notice_hash: string }[]>`select notice_hash from consent_record where employee_id = ${id}`;
    expect(row?.notice_hash).toBe(noticeHash(consentNotice("en")));

    // …and is then served normally.
    await bot.handleUpdate(text(tg, "/start"));
    expect(drain().texts.join("\n")).toMatch(/Welcome back/);

    // A second tap (or the worker's copy, after agreeing in the app) is not a second agreement.
    await bot.handleUpdate(tap(tg, `consent:renew:${noticeTag()}`));
    expect(drain().texts.join("\n")).toMatch(/Already recorded/);
    const rows = await getServiceSql()`select 1 from consent_record where employee_id = ${id}`;
    expect(rows.length).toBe(1);
  });

  it("records nothing for a tap under an older version of the words, and shows the current ones", async () => {
    await bot.handleUpdate(tap(tg, "consent:renew:0123456789abcdef"));
    const { texts, buttons } = drain();
    expect(texts.join("\n")).toMatch(/changed again/);
    expect(buttons).toContain(`consent:renew:${noticeTag()}`);
    expect(await hasCurrentConsent(id)).toBe(false);
  });

  it("can say not now, and nothing is recorded", async () => {
    await bot.handleUpdate(tap(tg, "consent:later"));
    expect(drain().texts.join("\n")).toMatch(/Until you agree I can't take your updates/);
    expect(await hasCurrentConsent(id)).toBe(false);
  });

  it("can still withdraw without agreeing first", async () => {
    await bot.handleUpdate(text(tg, "/withdraw"));
    expect(drain().texts.join("\n")).toMatch(/consent has been withdrawn/);
    const [e] = await getServiceSql()<{ status: string }[]>`select status from employee where id = ${id}`;
    expect(e?.status).toBe("disabled");
  });
});
