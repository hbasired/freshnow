import { randomUUID } from "node:crypto";
import { ImapFlow } from "imapflow";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDb, currentNoticeHash, getServiceSql, recordConsent, type InboxConfig } from "@freshnow/core";
import { pollInbox, toInboundMessage } from "./email-inbox.js";
import { startBackgroundJobs } from "./jobs.js";

/**
 * The inbox adapter. Parsing is tested always; the IMAP path runs against a REAL IMAP server
 * when EMAIL_TEST_IMAP_HOST is set (a local Dovecot in development — Gmail itself cannot be
 * reached from a test machine). Addresses are placeholders on example.com.
 */

const raw = (o: { id: string; from: string; to: string; subject: string; body: string; auth?: string; extra?: string }) =>
  Buffer.from(
    [
      ...(o.auth ? [`Authentication-Results: ${o.auth}`] : []),
      `Message-ID: <${o.id}>`,
      `Date: ${new Date().toUTCString()}`,
      `From: ${o.from}`,
      `To: ${o.to}`,
      `Subject: ${o.subject}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      ...(o.extra ? [o.extra] : []),
      "",
      o.body,
    ].join("\r\n"),
  );

describe("turning a raw email into what core reads", () => {
  it("keeps the threading headers, every Authentication-Results line in order, and Gmail's Sent label", async () => {
    const m = await toInboundMessage(
      raw({
        id: "a1@mail.example.com",
        from: "Worker <worker@example.com>",
        to: "FreshNow <ops+freshnow@example.com>",
        subject: "Re: [FN-7] New task",
        body: "Done\r\n\r\nOn Mon, FreshNow wrote:\r\n> x",
        auth: "mx.google.com; dkim=pass; spf=pass; dmarc=pass",
        extra: "In-Reply-To: <fn.1@example.com>\r\nReferences: <fn.0@example.com> <fn.1@example.com>\r\nAuthentication-Results: other.example; dkim=fail",
      }),
      new Set(["\\Inbox", "\\Sent"]),
    );
    expect(m).toMatchObject({
      messageId: "<a1@mail.example.com>",
      inReplyTo: "<fn.1@example.com>",
      references: ["fn.0@example.com", "fn.1@example.com"],
      from: "worker@example.com",
      to: ["ops+freshnow@example.com"],
      subject: "Re: [FN-7] New task",
      sentByMailboxOwner: true,
    });
    expect(m.authResults).toEqual(["mx.google.com; dkim=pass; spf=pass; dmarc=pass", "other.example; dkim=fail"]);
    expect(m.text).toContain("Done");
  });

  it("an out-of-office carries its Auto-Submitted header through", async () => {
    const m = await toInboundMessage(raw({ id: "a2@x", from: "w@example.com", to: "ops+freshnow@example.com", subject: "Away", body: "away", extra: "Auto-Submitted: auto-replied" }));
    expect(m.autoSubmitted).toBe("auto-replied");
    expect(m.sentByMailboxOwner).toBe(false);
  });
});

const HOST = process.env.EMAIL_TEST_IMAP_HOST;
describe.skipIf(!HOST)("a real IMAP mailbox (EMAIL_TEST_IMAP_HOST)", () => {
  const run = randomUUID().slice(0, 8);
  const OWNER = process.env.EMAIL_TEST_IMAP_USER ?? "ops@example.com";
  const INBOX = OWNER.replace("@", "+freshnow@");
  const WORKER = `imap-${run}-worker@example.com`;
  const worker = randomUUID();
  let taskNumber = "";
  const cfg: InboxConfig = {
    host: HOST ?? "",
    port: Number(process.env.EMAIL_TEST_IMAP_PORT ?? 10143),
    secure: false,
    user: OWNER,
    pass: process.env.EMAIL_TEST_IMAP_PASS ?? "test-app-password",
    mailbox: "INBOX",
    inboxAddress: INBOX,
    trustedAuthserv: "mx.google.com",
    pollSeconds: 30,
  };
  const saved = { ...process.env };
  const client = () => new ImapFlow({ host: cfg.host, port: cfg.port, secure: false, auth: { user: cfg.user, pass: cfg.pass }, logger: false });

  beforeAll(async () => {
    Object.assign(process.env, {
      EMAIL_IMAP_HOST: cfg.host, EMAIL_IMAP_PORT: String(cfg.port), EMAIL_IMAP_TLS: "false", EMAIL_IMAP_USER: cfg.user,
      EMAIL_IMAP_PASS: cfg.pass, EMAIL_INBOX_ADDRESS: INBOX, EMAIL_POLL_SECONDS: "30", LLM_PROVIDER_ORDER: "groq",
    });
    process.env.GROQ_API_KEY ??= "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200, text: async () => "",
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ is_blocker: false, category: "other", severity: "low", summary: "update" }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    }) as unknown as Response));
    const sql = getServiceSql();
    await sql`insert into employee (id, display_name, email, status, is_synthetic) values (${worker}, ${`IMAP-${run} Worker`}, ${WORKER}, 'active', true)`;
    await recordConsent({ employeeId: worker, noticeHash: currentNoticeHash(), via: "telegram" });
    taskNumber = (await sql<{ task_number: string }[]>`insert into task (employee_id, title, status, is_synthetic) values (${worker}, 'IMAP chiller', 'open', true) returning task_number::text`)[0]!.task_number;
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    const sql = getServiceSql();
    await sql`delete from notification_outbox where recipient_employee_id = ${worker}`;
    await sql`update task set source_email_id = null where employee_id = ${worker}`;
    await sql`delete from email_message where employee_id = ${worker} or from_address like ${`imap-${run}-%`}`;
    await sql`delete from task_update where employee_id = ${worker}`;
    await sql`delete from assignment where assigned_to = ${worker}`;
    await sql`delete from task where employee_id = ${worker}`;
    await sql`delete from consent_record where employee_id = ${worker}`;
    await sql`delete from employee where id = ${worker}`;
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    await closeDb();
  });

  it("reads only mail to the inbox alias, files the reply once, and leaves the mailbox exactly as it was", async () => {
    const replyId = `r-${run}@mail.example.com`;
    const personalId = `p-${run}@mail.example.com`;
    const c = client();
    await c.connect();
    await c.append("INBOX", raw({ id: replyId, from: WORKER, to: INBOX, subject: `Re: [FN-${taskNumber}] New task`, body: "Done, fixed", auth: "mx.google.com; dkim=pass; spf=pass; dmarc=pass" }));
    // The owner's own mail — never the system's business.
    await c.append("INBOX", raw({ id: personalId, from: "friend@example.org", to: OWNER, subject: "Dinner?", body: "Friday?" }));
    await c.logout();

    const first = await pollInbox(cfg);
    expect(first.outcomes).toMatchObject({ update: 1 });
    const sql = getServiceSql();
    expect((await sql`select 1 from email_message where message_id = ${personalId}`).length).toBe(0);
    expect((await sql<{ status: string }[]>`select status from email_message where message_id = ${replyId}`)[0]!.status).toBe("processed");

    const second = await pollInbox(cfg);
    expect(second.fresh).toBe(0); // already recorded: not downloaded again
    expect((await sql<{ n: number }[]>`select count(*)::int as n from task_update where employee_id = ${worker}`)[0]!.n).toBe(1);

    // Nothing in the mailbox was marked read, moved or deleted.
    const check = client();
    await check.connect();
    const lock = await check.getMailboxLock("INBOX");
    try {
      const flags: string[][] = [];
      for await (const m of check.fetch({ all: true }, { flags: true, envelope: true })) {
        if ([replyId, personalId].includes((m.envelope?.messageId ?? "").replace(/[<>]/g, ""))) flags.push([...(m.flags ?? [])]);
      }
      expect(flags).toHaveLength(2);
      expect(flags.every((f) => !f.includes("\\Seen"))).toBe(true);
    } finally {
      lock.release();
      await check.logout();
    }
  });

  it("mail the account sent to its own alias — filed only in Sent, as Gmail does — is read from Cc, and the work is assigned (TASK-054)", async () => {
    const sql = getServiceSql();
    const boss = randomUUID();
    // The mailbox's owner is a manager, and the worker reports to them.
    await sql`insert into employee (id, display_name, email, access_role, status, is_synthetic) values (${boss}, ${`IMAP-${run} Boss`}, ${OWNER.toLowerCase()}, 'manager', 'active', true)`;
    await recordConsent({ employeeId: boss, noticeHash: currentNoticeHash(), via: "telegram" });
    await sql`update employee set manager_employee_id = ${boss} where id = ${worker}`;
    // A stand-in model that reads one job and names nobody — the email's recipient is the owner.
    vi.stubGlobal("fetch", vi.fn(async (_u: string | URL, init?: RequestInit) => {
      const all = String(init?.body ?? "");
      const content = all.includes("You read a work document")
        ? JSON.stringify({ tasks: [{ title: "Clean the filler", detail: null, assignee_index: 0, named_as: null }], summary: "one job" })
        : JSON.stringify({ is_blocker: false, category: "other", severity: "low", summary: "update" });
      return { ok: true, status: 200, text: async () => "", json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) } as unknown as Response;
    }));
    const sentId = `s-${run}@mail.example.com`;
    const privateId = `q-${run}@mail.example.com`;
    const c = client();
    await c.connect();
    // Written TO the worker with the FreshNow alias only on Cc — and only in Sent, never INBOX.
    await c.append("Sent", raw({ id: sentId, from: OWNER, to: WORKER, subject: "Filler", body: "Please clean the filler today.", extra: `Cc: ${INBOX}` }), ["\\Seen"]);
    // The owner's own sent mail without the alias — never read.
    await c.append("Sent", raw({ id: privateId, from: OWNER, to: "friend@example.org", subject: "Weekend", body: "See you" }), ["\\Seen"]);
    await c.logout();
    try {
      const r = await pollInbox(cfg);
      expect(r.outcomes).toMatchObject({ assigned: 1 });
      expect((await sql`select 1 from email_message where message_id = ${privateId}`).length).toBe(0);
      const a = await sql<{ origin: string; title: string }[]>`
        select a.origin, t.title from assignment a join task t on t.id = a.task_id
         where a.assigned_to = ${worker} and a.assigned_by = ${boss}`;
      expect(a).toEqual([{ origin: "email", title: "Clean the filler" }]);
    } finally {
      await sql`delete from notification_outbox where recipient_employee_id = ${boss}`;
      await sql`delete from assignment where assigned_by = ${boss}`;
      await sql`update task set source_email_id = null where employee_id = ${worker}`;
      await sql`delete from email_message where employee_id = ${boss}`;
      await sql`update employee set manager_employee_id = null where id = ${worker}`;
      await sql`delete from consent_record where employee_id = ${boss}`;
      await sql`delete from employee where id = ${boss}`;
    }
  });

  it("runs as a BullMQ job scheduler, and the run is recorded in job_run", async () => {
    const sql = getServiceSql();
    const before = new Date();
    const jobs = await startBackgroundJobs();
    try {
      let row: { status: string }[] = [];
      for (let i = 0; i < 40 && row.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 500));
        row = await sql<{ status: string }[]>`select status from job_run where job_name = 'email_poll' and created_at >= ${before}`;
      }
      expect(row[0]?.status).toBe("ok");
      const schedulers = await jobs.queue.getJobSchedulers();
      expect(schedulers.map((s) => s.key ?? s.id).sort()).toEqual(expect.arrayContaining(["email-poll", "email-retry"]));
    } finally {
      await jobs.queue.removeJobScheduler("email-poll");
      await jobs.queue.removeJobScheduler("email-retry");
      await jobs.close();
    }
  }, 40_000);
});
