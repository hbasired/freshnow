import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Update } from "grammy/types";
import { closeDb, currentNoticeHash, DEMO_CEO_ID, getServiceSql, loadViewer, recordConsent } from "@freshnow/core";
import { createBot, handleText, type FreshCtx } from "./bot.js";

/**
 * Managers in Telegram — through the REAL bot.
 *
 * Updates are fed to grammY's `bot.handleUpdate` and every outgoing Bot API call is
 * intercepted by a transformer (the testing approach grammY documents), so the whole
 * middleware chain runs: the auth middleware that reads `access_role`, the session in
 * Postgres, the command and callback handlers, and the core writes underneath. The
 * refusals matter most: callback data is guessable, and a manager who can tap
 * `assignto:<any id>` can put work on a stranger's list.
 */

const CEO_TG = 9_700_000_000_099;
const M_TG = 9_700_000_000_001;
const R_TG = 9_700_000_000_002;
const O_TG = 9_700_000_000_003;
const E_TG = 9_700_000_000_004;
const M = randomUUID(); // manager
const R = randomUUID(); // reports to M
const O = randomUUID(); // reports to the CEO — outside M's team
const E = randomUUID(); // plain employee
// Two of M's team share a first name — the case where a guess sends work to the wrong phone.
const AK = randomUUID();
const AA = randomUUID();
const TAG = "ROLE-";

const bot = createBot({ token: "0:test", ceoUserId: BigInt(CEO_TG) });
// Only the fields the handlers read; grammY's full `UserFromGetMe` shape is a fixture cast.
bot.botInfo = { id: 1, is_bot: true, first_name: "test", username: "freshnow_test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false } as unknown as typeof bot.botInfo;

interface Sent { method: string; payload: Record<string, unknown> }
const sent: Sent[] = [];
let msgId = 100;
bot.api.config.use(async (_prev, method, payload) => {
  sent.push({ method, payload: payload as Record<string, unknown> });
  if (method === "sendMessage") {
    const p = payload as { chat_id: number; text: string };
    return { ok: true, result: { message_id: ++msgId, date: 0, chat: { id: p.chat_id, type: "private" }, text: p.text } } as never;
  }
  return { ok: true, result: true } as never;
});

let updateId = 1;
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
/** What the bot said (and offered as buttons) since the last drain. */
function drain(): { texts: string[]; buttons: string[]; alerts: string[] } {
  const out = { texts: [] as string[], buttons: [] as string[], alerts: [] as string[] };
  for (const s of sent) {
    if (s.method === "sendMessage") {
      out.texts.push(String(s.payload["text"]));
      const kb = (s.payload["reply_markup"] as { inline_keyboard?: { callback_data?: string }[][] } | undefined)?.inline_keyboard ?? [];
      for (const row of kb) for (const b of row) if (b.callback_data) out.buttons.push(b.callback_data);
    }
    if (s.method === "answerCallbackQuery" && s.payload["show_alert"]) out.alerts.push(String(s.payload["text"]));
  }
  sent.length = 0;
  return out;
}

let ceoTelegramBefore: string | null = null;

beforeAll(async () => {
  const sql = getServiceSql();
  const person = (id: string, name: string, role: string, manager: string | null, tg: number) =>
    sql`insert into employee (id, display_name, status, is_synthetic, access_role, manager_employee_id, department, telegram_user_id)
        values (${id}, ${TAG + name}, 'active', true, ${role}, ${manager}, 'production', ${tg})`;
  await person(M, "Maryam", "manager", DEMO_CEO_ID, M_TG);
  await person(R, "Rahim", "employee", M, R_TG);
  await person(O, "Omar", "employee", DEMO_CEO_ID, O_TG);
  await person(E, "Elif", "employee", DEMO_CEO_ID, E_TG);
  await sql`insert into blocker (raised_by, category, severity, status, affected_asset, is_synthetic) values
    (${R}, 'equipment', 'high', 'open', 'ROLE chiller van 2', true),
    (${O}, 'supply', 'low', 'open', 'ROLE oranges', true)`;
  // The configured CEO id must map to the CEO row for the CEO path to be exercised.
  const [ceo] = await sql<{ telegram_user_id: string | null }[]>`select telegram_user_id from employee where id = ${DEMO_CEO_ID}`;
  ceoTelegramBefore = ceo?.telegram_user_id ?? null;
  await sql`update employee set telegram_user_id = ${CEO_TG} where id = ${DEMO_CEO_ID}`;
  // Everyone here has agreed to today's notice; the door for those who have not is
  // consent.test.ts's subject, not this file's.
  for (const id of [M, R, O, E, DEMO_CEO_ID]) {
    await recordConsent({ employeeId: id, noticeHash: currentNoticeHash(), via: "telegram" });
  }
});

afterAll(async () => {
  const sql = getServiceSql();
  const ids = [M, R, O, E, AK, AA];
  await sql`update employee set telegram_user_id = ${ceoTelegramBefore} where id = ${DEMO_CEO_ID}`;
  await sql`delete from bot_session where key = any(${[CEO_TG, M_TG, R_TG, O_TG, E_TG].map(String)})`;
  await sql`delete from notification_outbox where recipient_employee_id = any(${ids})`;
  await sql`delete from escalation where blocker_id in (select id from blocker where raised_by = any(${ids}))`;
  await sql`delete from blocker where raised_by = any(${ids})`;
  await sql`delete from task_update where employee_id = any(${ids})`;
  await sql`delete from assignment where assigned_to = any(${ids}) or assigned_by = any(${ids})`;
  await sql`delete from task where employee_id = any(${ids})`;
  await sql`delete from audit_log where actor = any(${ids.map((i) => `employee:${i}`)}) or actor = any(${[M_TG, R_TG, O_TG, E_TG, CEO_TG].map((t) => `telegram:${t}`)})`;
  await sql`delete from audit_log where entity = 'employee' and entity_id = any(${ids})`;
  await sql`delete from consent_record where employee_id = any(${[...ids, DEMO_CEO_ID]}) and consented_at > now() - interval '1 hour'`;
  await sql`delete from employee where id = any(${ids})`;
  await closeDb();
});

describe("a manager in Telegram", () => {
  it("is greeted as a manager, with the team menu and no invite button", async () => {
    await bot.handleUpdate(text(M_TG, "/start"));
    const { texts, buttons } = drain();
    expect(texts.join("\n")).toMatch(/signed in as \*manager\*/);
    expect(buttons).toContain("menu:blockers");
    expect(buttons).toContain("menu:assign");
    expect(buttons).toContain("menu:log");
    expect(buttons).not.toContain("menu:invite");
  });

  it("/assign lists only their reports", async () => {
    await bot.handleUpdate(text(M_TG, "/assign"));
    const { texts, buttons } = drain();
    expect(texts.join("\n")).toMatch(/Who should do the task/);
    expect(buttons).toContain(`assignto:${R}`);
    expect(buttons).not.toContain(`assignto:${O}`);
    expect(buttons).not.toContain(`assignto:${E}`);
    expect(buttons).not.toContain(`assignto:${DEMO_CEO_ID}`);
  });

  it("a crafted tap on somebody outside the team is refused, and nothing is created", async () => {
    await bot.handleUpdate(tap(M_TG, `assignto:${O}`));
    const { alerts, texts } = drain();
    expect(alerts.join(" ")).toMatch(/only assign to people who report to you/i);
    expect(texts.join(" ")).not.toMatch(/What should/);
    // A follow-up title must not land on Omar's list either.
    await bot.handleUpdate(text(M_TG, "Sort out the oranges"));
    const tasks = await getServiceSql()<{ n: number }[]>`select count(*)::int as n from task where employee_id = ${O}`;
    expect(tasks[0]?.n).toBe(0);
    drain();
  });

  it("assigning to a report goes through the same core path as the CEO's — task, assignment, outbox", async () => {
    await bot.handleUpdate(tap(M_TG, `assignto:${R}`));
    expect(drain().texts.join(" ")).toMatch(/What should ROLE-Rahim do/);
    await bot.handleUpdate(text(M_TG, "Check the chiller in van 2 before the afternoon run"));
    expect(drain().texts.join(" ")).toMatch(/Assigned to ROLE-Rahim/);

    const sql = getServiceSql();
    const [task] = await sql<{ id: string; status: string }[]>`select id, status from task where employee_id = ${R} and title like 'Check the chiller%'`;
    expect(task).toBeTruthy();
    const [asg] = await sql<{ assigned_by: string }[]>`select assigned_by from assignment where task_id = ${task!.id}`;
    expect(asg?.assigned_by).toBe(M);
    // Rahim is linked, so he is told the same way the CEO's assignments are: a Telegram
    // row (plus the in-app copy every recipient gets).
    const out = await sql<{ channel: string }[]>`select channel from notification_outbox where recipient_employee_id = ${R}`;
    expect(out.map((r) => r.channel)).toContain("telegram");
  });

  it("/blockers shows the team's problems and not a stranger's", async () => {
    await bot.handleUpdate(text(M_TG, "/blockers"));
    const { texts } = drain();
    const all = texts.join("\n");
    expect(all).toMatch(/in your team/);
    expect(all).toContain("ROLE chiller van 2");
    expect(all).not.toContain("ROLE oranges");
  });

  it("a typed stranger's name at the 'who?' prompt is not recognised, and creates nothing", async () => {
    // The text router with a stub context, as flows.test.ts does — the step under test is
    // reachable only after a plan or an assignment with nobody named.
    const replies: string[] = [];
    const viewer = (await loadViewer(M))!;
    const ctx = {
      session: { step: { kind: "assign_pending", title: "Count the crates" }, stepAt: Date.now() },
      role: "manager",
      employee: { id: M, display_name: TAG + "Maryam", status: "active", language: "en", access_role: "manager", department: "production" },
      viewer,
      message: { message_id: 1 },
      reply: async (t: string) => void replies.push(t),
    } as unknown as FreshCtx;
    await handleText(ctx, "Omar");
    expect(replies.join(" ")).toMatch(/don't recognise that name/i);
    const n = await getServiceSql()<{ n: number }[]>`select count(*)::int as n from task where employee_id = ${O}`;
    expect(n[0]?.n).toBe(0);
  });

  it("a typed first name two people share is asked about — only those two offered — and nothing is created", async () => {
    const sql = getServiceSql();
    await sql`insert into employee (id, display_name, status, is_synthetic, access_role, manager_employee_id, department) values
      (${AK}, ${TAG + "Ahmed Khan"}, 'active', true, 'employee', ${M}, 'production'),
      (${AA}, ${TAG + "Ahmed Ali"}, 'active', true, 'employee', ${M}, 'production')`;
    const viewer = (await loadViewer(M))!;
    const replies: { text: string; buttons: string[] }[] = [];
    const ctx = {
      session: { step: { kind: "assign_pending", title: "Count the crates" }, stepAt: Date.now() },
      role: "manager",
      employee: { id: M, display_name: TAG + "Maryam", status: "active", language: "en", access_role: "manager", department: "production" },
      viewer,
      message: { message_id: 1 },
      reply: async (t: string, o?: { reply_markup?: { inline_keyboard?: { callback_data?: string }[][] } }) =>
        void replies.push({ text: t, buttons: (o?.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data ?? "") }),
    } as unknown as FreshCtx;

    await handleText(ctx, "Ahmed");
    expect(replies[0]!.text).toMatch(/could be .*Ahmed (Khan|Ali) or .*Ahmed (Khan|Ali)/);
    expect(replies[0]!.buttons.filter((b) => b.startsWith("assignto:")).sort()).toEqual([`assignto:${AA}`, `assignto:${AK}`].sort());
    const none = await sql<{ n: number }[]>`select count(*)::int as n from task where employee_id = any(${[AK, AA]})`;
    expect(none[0]?.n).toBe(0);

    // The full name settles it: the work goes to that Ahmed and not the other.
    await handleText(ctx, "Ahmed Khan");
    const owners = await sql<{ employee_id: string }[]>`select employee_id from task where employee_id = any(${[AK, AA]}) and title = 'Count the crates'`;
    expect(owners.map((o) => o.employee_id)).toEqual([AK]);
  });

  it("still cannot create invites", async () => {
    await bot.handleUpdate(text(M_TG, "/invite Somebody New"));
    expect(drain().texts.join(" ")).toMatch(/Only the CEO can create invites/);
  });
});

describe("a plain employee in Telegram", () => {
  it("is refused the manager commands", async () => {
    await bot.handleUpdate(text(E_TG, "/assign"));
    expect(drain().texts.join(" ")).toMatch(/Only the CEO or a manager can assign/);
    await bot.handleUpdate(text(E_TG, "/blockers"));
    expect(drain().texts.join(" ")).toMatch(/Only the CEO or a manager sees the blocker queue/);
    await bot.handleUpdate(tap(E_TG, "menu:assign"));
    expect(drain().texts.join(" ")).toMatch(/Only the CEO or a manager can assign/);
  });

  it("is refused a crafted tap even with a guessable id", async () => {
    await bot.handleUpdate(tap(E_TG, `assignto:${R}`));
    expect(drain().alerts.join(" ")).toMatch(/only assign to people who report to you/i);
  });
});

describe("the CEO in Telegram", () => {
  it("still sees everyone in the directory and every open blocker", async () => {
    await bot.handleUpdate(text(CEO_TG, "/assign"));
    const { buttons } = drain();
    for (const id of [M, R, O, E]) expect(buttons).toContain(`assignto:${id}`);
    expect(buttons).not.toContain(`assignto:${DEMO_CEO_ID}`);

    await bot.handleUpdate(text(CEO_TG, "/blockers"));
    const all = drain().texts.join("\n");
    expect(all).toContain("ROLE chiller van 2");
    expect(all).toContain("ROLE oranges");
    expect(all).not.toMatch(/in your team/);
  });
});
