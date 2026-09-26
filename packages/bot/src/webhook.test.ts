import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Bot } from "grammy";
import { closeDb, getServiceSql } from "@freshnow/core";
import { startWebhookServer, webhookStats } from "./webhook.js";

/**
 * The webhook listener's one job is to refuse anything that does not carry the secret.
 * CLAUDE.md calls the check non-negotiable, and until 2026-09-18 the check — and the
 * listener — did not exist. These run against a real socket.
 */
const SECRET = "test-secret-token-of-sufficient-length";
const PATH = "/telegram/webhook";

let port = 0;
let server: ReturnType<typeof startWebhookServer>;
let received = 0;

beforeAll(async () => {
  // A bot with a fake token and a fake API, so nothing reaches Telegram. Only the
  // dispatch matters here: did the update get to a handler or not.
  const bot = new Bot("0:test-token-never-used");
  bot.botInfo = { id: 0, is_bot: true, first_name: "test", username: "test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as never;
  bot.on("message", () => {
    received++;
  });
  server = startWebhookServer({ bot: bot as never, secret: SECRET, path: PATH, port: 0 });
  await new Promise<void>((r) => server.once("listening", r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.close();
  await getServiceSql()`delete from audit_log where action = 'webhook.rejected' and detail->>'ip' in ('127.0.0.1', '::1', '::ffff:127.0.0.1')`;
  await closeDb();
});

const update = {
  update_id: 1,
  message: { message_id: 1, date: 0, chat: { id: 1, type: "private" }, from: { id: 1, is_bot: false, first_name: "x" }, text: "hi" },
};

async function post(headers: Record<string, string>, path = PATH, method = "POST"): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: method === "POST" ? JSON.stringify(update) : null,
  });
  return res.status;
}

describe("the webhook listener", () => {
  it("rejects an update with no secret token, and no handler runs", async () => {
    const before = received;
    expect(await post({})).toBe(401);
    expect(received).toBe(before);
  });

  it("rejects a wrong secret token, including one of the right length", async () => {
    const before = received;
    expect(await post({ "x-telegram-bot-api-secret-token": "wrong" })).toBe(401);
    expect(await post({ "x-telegram-bot-api-secret-token": "x".repeat(SECRET.length) })).toBe(401);
    expect(received).toBe(before);
    expect(webhookStats().rejected).toBeGreaterThanOrEqual(3);
  });

  it("accepts the right secret token and dispatches the update", async () => {
    const before = received;
    expect(await post({ "x-telegram-bot-api-secret-token": SECRET })).toBe(200);
    expect(received).toBe(before + 1);
  });

  it("answers 404 to any other path or method — nothing to fingerprint", async () => {
    expect(await post({ "x-telegram-bot-api-secret-token": SECRET }, "/")).toBe(404);
    expect(await post({ "x-telegram-bot-api-secret-token": SECRET }, "/health")).toBe(404);
    expect(await post({ "x-telegram-bot-api-secret-token": SECRET }, PATH, "GET")).toBe(404);
  });

  it("audits a rejection without recording the token that was tried", async () => {
    await post({ "x-telegram-bot-api-secret-token": "attacker-guess" });
    const rows = await getServiceSql()<{ detail: Record<string, unknown> }[]>`
      select detail from audit_log where action = 'webhook.rejected' order by created_at desc limit 1`;
    expect(rows[0]?.detail["reason"]).toMatch(/secret token/);
    expect(JSON.stringify(rows[0]?.detail)).not.toContain("attacker-guess");
    expect(JSON.stringify(rows[0]?.detail)).not.toContain(SECRET);
  });
});
