import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getServiceSql } from "@freshnow/core";
import { makeChatSender } from "./chat-sender.js";
import { makeEmailSender } from "./email-sender.js";
import { RateLimitError } from "./outbox-relay.js";

/**
 * The two simplest senders. The chat one runs against a REAL local HTTP server, because it
 * uses plain `fetch` and can; the email one takes an injected nodemailer transport, because
 * standing up an SMTP server in a test proves nothing about our logic and a great deal
 * about nodemailer's.
 *
 * What is being tested in both cases is the decision-making: which failures are permanent,
 * which are "try later", and what happens when there is nobody to send to.
 */

const TAG = "SENDTEST";
const EMP_WITH = randomUUID();
const EMP_WITHOUT = randomUUID();
const saved: Record<string, string | undefined> = {};
const ENV = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "EMAIL_FROM", "CHAT_WEBHOOK_URL", "PUBLIC_URL"];

let server: Server;
let hookUrl: string;
let nextStatus = 200;
const received: string[] = [];

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.SMTP_HOST = "smtp.example.invalid";
  process.env.EMAIL_FROM = "FreshNow <ops@example.invalid>";

  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push(body);
      if (nextStatus === 429) res.setHeader("retry-after", "11");
      res.writeHead(nextStatus);
      res.end(nextStatus >= 400 ? "nope" : "ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  hookUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/hooks/test`;
  process.env.CHAT_WEBHOOK_URL = hookUrl;

  const sql = getServiceSql();
  await sql`insert into employee (id, display_name, status, is_synthetic, email) values
    (${EMP_WITH}, ${`${TAG} has address`}, 'active', true, ${`${TAG.toLowerCase()}@example.invalid`}),
    (${EMP_WITHOUT}, ${`${TAG} no address`}, 'active', true, null)`;
});

afterAll(async () => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const sql = getServiceSql();
  await sql`delete from notification_pref where employee_id in (${EMP_WITH}, ${EMP_WITHOUT})`;
  await sql`delete from employee where id in (${EMP_WITH}, ${EMP_WITHOUT})`;
  await closeDb();
});

/** The one nodemailer method the sender uses, standing in for a real SMTP conversation. */
function fakeTransport(behaviour: () => void | never) {
  const sent: { to?: string; subject?: string; text?: string }[] = [];
  const transport = {
    sendMail: async (opts: { to?: string; subject?: string; text?: string }) => {
      behaviour();
      sent.push(opts);
      return {};
    },
  } as unknown as Parameters<typeof makeEmailSender>[0];
  return { transport, sent };
}

const msg = (recipient: string) => ({
  chatId: null,
  payload: { title: "Blocker raised", text: "van 2 chiller is not cooling", url: "/app/#tasks/alerts" },
  recipientEmployeeId: recipient,
});

describe("the email sender", () => {
  it("refuses to start without SMTP_HOST and EMAIL_FROM", () => {
    const keep = process.env.EMAIL_FROM;
    delete process.env.EMAIL_FROM;
    try {
      expect(() => makeEmailSender()).toThrow(/EMAIL_FROM/);
    } finally {
      process.env.EMAIL_FROM = keep;
    }
  });

  it("sends to the address on the employee record, with a link back", async () => {
    const { transport, sent } = fakeTransport(() => {});
    await makeEmailSender(transport)(msg(EMP_WITH));
    expect(sent.length).toBe(1);
    expect(sent[0]?.to).toBe(`${TAG.toLowerCase()}@example.invalid`);
    expect(sent[0]?.subject).toBe("Blocker raised");
    expect(sent[0]?.text).toContain("van 2 chiller");
    expect(sent[0]?.text).toContain("/app/#tasks/alerts");
  });

  it("succeeds without sending when the person has no address — a gap, not a failure", async () => {
    const { transport, sent } = fakeTransport(() => {
      throw new Error("should never be called");
    });
    await expect(makeEmailSender(transport)(msg(EMP_WITHOUT))).resolves.toBeUndefined();
    expect(sent.length).toBe(0);
  });

  it("turns email off for that person on a hard bounce, instead of retrying a dead address", async () => {
    const { transport } = fakeTransport(() => {
      throw Object.assign(new Error("550 no such user"), { responseCode: 550 });
    });
    await expect(makeEmailSender(transport)(msg(EMP_WITH))).resolves.toBeUndefined();

    const prefs = await getServiceSql()<{ mode: string }[]>`
      select mode from notification_pref where employee_id = ${EMP_WITH} and channel = 'email'`;
    expect(prefs[0]?.mode).toBe("off");
  });

  it("backs off rather than burning an attempt on a temporary 451", async () => {
    const { transport } = fakeTransport(() => {
      throw Object.assign(new Error("451 try later"), { responseCode: 451 });
    });
    await expect(makeEmailSender(transport)(msg(EMP_WITH))).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe("the chat sender", () => {
  it("refuses to start without a webhook URL", () => {
    const keep = process.env.CHAT_WEBHOOK_URL;
    delete process.env.CHAT_WEBHOOK_URL;
    try {
      expect(() => makeChatSender()).toThrow(/CHAT_WEBHOOK_URL/);
    } finally {
      process.env.CHAT_WEBHOOK_URL = keep;
    }
  });

  it("posts the message to the webhook as JSON", async () => {
    received.length = 0;
    nextStatus = 200;
    await makeChatSender()(msg(EMP_WITH));
    expect(received.length).toBe(1);
    const body = JSON.parse(received[0]!) as { text: string };
    expect(body.text).toContain("Blocker raised");
    expect(body.text).toContain("van 2 chiller");
  });

  it("raises RateLimitError on 429 so the relay backs off", async () => {
    nextStatus = 429;
    await expect(makeChatSender()(msg(EMP_WITH))).rejects.toBeInstanceOf(RateLimitError);
    nextStatus = 200;
  });

  it("fails loudly on any other error, so the relay can retry and then abandon", async () => {
    nextStatus = 500;
    await expect(makeChatSender()(msg(EMP_WITH))).rejects.toThrow(/500/);
    nextStatus = 200;
  });
});
