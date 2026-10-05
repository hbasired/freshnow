import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getServiceSql } from "./db.js";
import { composeOutboundEmail, recordOutboundEmail } from "./email-outbound.js";
import { retentionSweep } from "./retention.js";

/**
 * An email we send must be answerable: the task key in the subject, our own Message-ID (stable
 * across a retried send), Reply-To the inbox, and reply instructions only for the person who can
 * act on them. Addresses are placeholders.
 */

const run = randomUUID().slice(0, 8);
const ids = { owner: randomUUID(), boss: randomUUID(), other: randomUUID() };
let task = { id: "", number: "" };
const env = { ...process.env, EMAIL_IMAP_HOST: "imap.test", EMAIL_IMAP_USER: "ops@example.com", EMAIL_IMAP_PASS: "x", EMAIL_INBOX_ADDRESS: "ops+freshnow@example.com" };

beforeAll(async () => {
  const sql = getServiceSql();
  await sql`insert into employee (id, display_name, access_role, status, is_synthetic) values
    (${ids.owner}, ${`OUT-${run} Owner`}, 'employee', 'active', true),
    (${ids.boss}, ${`OUT-${run} Boss`}, 'manager', 'active', true),
    (${ids.other}, ${`OUT-${run} Other`}, 'employee', 'active', true)`;
  const t = (await sql<{ id: string; task_number: string }[]>`
    insert into task (employee_id, title, status, is_synthetic) values (${ids.owner}, 'Fix the van 2 chiller', 'open', true) returning id, task_number::text`)[0]!;
  task = { id: t.id, number: t.task_number };
});

afterAll(async () => {
  const sql = getServiceSql();
  await sql`delete from email_message where employee_id = any(${Object.values(ids)})`;
  await sql`delete from task where employee_id = any(${Object.values(ids)})`;
  await sql`delete from employee where id = any(${Object.values(ids)})`;
  await closeDb();
});

const payload = () => ({ title: "New task for you", text: "📌 New task from the CEO:\n\nFix the van 2 chiller", url: `/app/?task=${task.id}#tasks/mine`, taskId: task.id });

describe("composing an email", () => {
  it("carries the task key in the subject, a Message-ID from the outbox row, and Reply-To the inbox", async () => {
    const outboxId = randomUUID();
    const e = await composeOutboundEmail({ payload: payload(), recipientEmployeeId: ids.owner, to: "Owner@Example.com", fromAddress: "FreshNow Ops <ops@example.com>", outboxId, env });
    expect(e.subject).toBe(`[FN-${task.number}] New task for you: Fix the van 2 chiller`);
    expect(e.messageId).toBe(`fn.${outboxId}@example.com`);
    expect(e.replyTo).toBe("ops+freshnow@example.com");
    expect(e.to).toBe("owner@example.com");
    expect(e.text).toContain(`Reply to this email to update FN-${task.number}`);
    // Same outbox row, same id: a retried send is the same email.
    const again = await composeOutboundEmail({ payload: payload(), recipientEmployeeId: ids.owner, to: "owner@example.com", fromAddress: "ops@example.com", outboxId, env });
    expect(again.messageId).toBe(e.messageId);
  });

  it("tells only the task's owner how to update it; someone who may give work is told how to send work instead", async () => {
    const forOther = await composeOutboundEmail({ payload: payload(), recipientEmployeeId: ids.other, to: "o@example.com", fromAddress: "ops@example.com", env });
    expect(forOther.text).not.toContain("Reply to this email to update");
    const forBoss = await composeOutboundEmail({ payload: payload(), recipientEmployeeId: ids.boss, to: "b@example.com", fromAddress: "ops@example.com", env });
    expect(forBoss.text).toContain("To give work by email, write to ops+freshnow@example.com");
  });

  it("without an inbox configured, promises nothing about replies", async () => {
    const e = await composeOutboundEmail({ payload: payload(), recipientEmployeeId: ids.owner, to: "o@example.com", fromAddress: "ops@example.com", env: { ...process.env, EMAIL_IMAP_HOST: "" } });
    expect(e.replyTo).toBeNull();
    expect(e.text).not.toContain("Reply to this email");
  });

  it("an acknowledgement threads under the email it answers", async () => {
    const e = await composeOutboundEmail({
      payload: { title: "Saved", text: "Saved your update.", subject: "Re: [FN-1] x", inReplyTo: "m-1@mail.example.com" },
      recipientEmployeeId: ids.owner,
      to: "o@example.com",
      fromAddress: "ops@example.com",
      env,
    });
    expect(e).toMatchObject({ subject: "Re: [FN-1] x", inReplyTo: "m-1@mail.example.com", references: ["m-1@mail.example.com"] });
  });

  it("is recorded once, however often it is recorded", async () => {
    const e = await composeOutboundEmail({ payload: payload(), recipientEmployeeId: ids.owner, to: "o@example.com", fromAddress: "ops@example.com", outboxId: randomUUID(), env });
    await recordOutboundEmail({ email: e, fromAddress: "ops@example.com", recipientEmployeeId: ids.owner });
    await recordOutboundEmail({ email: e, fromAddress: "ops@example.com", recipientEmployeeId: ids.owner });
    const rows = await getServiceSql()<{ task_id: string }[]>`select task_id from email_message where direction = 'out' and message_id = ${e.messageId}`;
    expect(rows).toEqual([{ task_id: task.id }]);
  });
});

describe("retention reaches emailed words", () => {
  it("ages an old inbound body and leaves a recent one", async () => {
    const saved = process.env.RETENTION_DAYS;
    process.env.RETENTION_DAYS = "90";
    const sql = getServiceSql();
    const old = `old-${randomUUID()}@x.example`;
    const recent = `new-${randomUUID()}@x.example`;
    await sql`insert into email_message (direction, message_id, from_address, to_address, body_text, employee_id, status, created_at, is_synthetic) values
      ('in', ${old}, 'o@example.com', 'ops@example.com', 'the chiller in van 2 leaks', ${ids.owner}, 'processed', now() - interval '120 days', true),
      ('in', ${recent}, 'o@example.com', 'ops@example.com', 'all good today', ${ids.owner}, 'processed', now() - interval '3 days', true)`;
    try {
      await retentionSweep();
      const rows = await sql<{ message_id: string; body_text: string }[]>`select message_id, body_text from email_message where message_id = any(${[old, recent]})`;
      expect(rows.find((r) => r.message_id === old)!.body_text).toMatch(/redacted/);
      expect(rows.find((r) => r.message_id === recent)!.body_text).toBe("all good today");
    } finally {
      if (saved === undefined) delete process.env.RETENTION_DAYS;
      else process.env.RETENTION_DAYS = saved;
    }
  });
});
