import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { currentNoticeHash, hasCurrentConsent, recordConsent, requestConsentFromEveryone } from "./consent.js";
import { closeDb, getServiceSql, withContext } from "./db.js";
import {
  decideEmailProposal,
  isConsentAgreement,
  listPendingEmailProposals,
  MAX_EMAIL_ATTEMPTS,
  processInboundEmail,
  screenAndRoute,
  storedInboundMessage,
  unreadInboundEmails,
  type InboundEmailMessage,
} from "./email-inbound.js";

/**
 * Email into FreshNow (TASK-053). The model is replaced by a stand-in provider that answers the
 * way a model would — it reads the numbered colleague list from the prompt — so these are the
 * pipeline's own rules: record once, screen, route by the FN key or the thread, propose rather
 * than assign. Addresses are placeholders on example.com.
 */

const run = randomUUID().slice(0, 8);
const addr = (who: string) => `eml-${run}-${who}@example.com`;
const BOSS = addr("boss");
const WORKER = addr("worker");
const OTHER = addr("other");
const OUTSIDER = addr("outsider");
const INBOX = `eml-${run}-boss+freshnow@example.com`;
const ids = { boss: randomUUID(), worker: randomUUID(), other: randomUUID(), outsider: randomUUID() };
const TAG = `EML-${run}`;
let workerTask = { id: "", number: 0 };
let otherTask = { id: "", number: 0 };

const env: NodeJS.ProcessEnv = {
  ...process.env,
  EMAIL_IMAP_HOST: "imap.test",
  EMAIL_IMAP_USER: BOSS,
  EMAIL_IMAP_PASS: "not-a-password",
  EMAIL_INBOX_ADDRESS: INBOX,
  EMAIL_ALLOWLIST: [BOSS, WORKER, OTHER].join(","),
};
const PASS = `mx.google.com; dkim=pass header.i=@example.com; spf=pass smtp.mailfrom=${WORKER}; dmarc=pass header.from=example.com`;

const saved = { smtp: process.env.SMTP_HOST, from: process.env.EMAIL_FROM, order: process.env.LLM_PROVIDER_ORDER };
let emailWasEnabled = false;

/**
 * A stand-in model: plans name a person by reading the list it was given (the worker unless told
 * otherwise; `named: null` = the email names nobody); updates are not problems unless they say "no gas".
 */
function fakeModel(opts: { fail?: boolean; pick?: string; named?: string | null } = {}) {
  vi.stubGlobal("fetch", vi.fn(async (_u: string | URL, init?: RequestInit) => {
    if (opts.fail) throw new Error("connect ECONNREFUSED (stand-in outage)");
    const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
    const all = body.messages.map((m) => m.content).join("\n");
    let content: string;
    if (all.includes("You read a work document")) {
      const pick = opts.pick ?? "Worker";
      const n = new RegExp(`\\n\\s+(\\d+)\\. EML-[^\\n]*${pick}`).exec(all)?.[1];
      const named = opts.named === undefined ? pick : opts.named;
      content = JSON.stringify({ tasks: [{ title: "Restock the Marina machine", detail: null, assignee_index: named === null ? 0 : Number(n ?? 0), named_as: named }], summary: "work for the week" });
    } else {
      const blocker = /no gas/i.test(all);
      content = JSON.stringify({ is_blocker: blocker, category: blocker ? "supply" : "other", severity: blocker ? "high" : "low", summary: blocker ? "No gas for the chiller" : "routine update" });
    }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }), text: async () => "" } as unknown as Response;
  }));
}

const mail = (o: Partial<InboundEmailMessage>): InboundEmailMessage => ({
  messageId: `<m-${randomUUID()}@mail.example.com>`,
  inReplyTo: null,
  references: [],
  from: `Worker <${WORKER}>`,
  to: [INBOX],
  subject: null,
  text: "",
  date: new Date(),
  authResults: [PASS],
  sentByMailboxOwner: false,
  isSynthetic: true,
  ...o,
});

beforeAll(async () => {
  process.env.SMTP_HOST = "smtp.test";
  process.env.EMAIL_FROM = `FreshNow Ops <${BOSS}>`;
  process.env.LLM_PROVIDER_ORDER = "groq";
  process.env.GROQ_API_KEY ??= "test-key";
  const sql = getServiceSql();
  emailWasEnabled = (await sql<{ enabled: boolean }[]>`select enabled from channel_setting where channel = 'email'`)[0]?.enabled ?? false;
  await sql`update channel_setting set enabled = true where channel = 'email'`;
  const person = (id: string, name: string, role: string, email: string, manager: string | null) =>
    sql`insert into employee (id, display_name, access_role, email, manager_employee_id, status, is_synthetic)
        values (${id}, ${`${TAG} ${name}`}, ${role}, ${email}, ${manager}, 'active', true)`;
  await person(ids.boss, "Boss", "manager", BOSS, null);
  await person(ids.worker, "Worker", "employee", WORKER, ids.boss);
  await person(ids.other, "Other", "employee", OTHER, null);
  await person(ids.outsider, "Outsider", "employee", OUTSIDER, null);
  for (const id of Object.values(ids)) await recordConsent({ employeeId: id, noticeHash: currentNoticeHash(), via: "telegram" });
  const t = async (emp: string, title: string) =>
    (await sql<{ id: string; task_number: string }[]>`insert into task (employee_id, title, status, is_synthetic) values (${emp}, ${title}, 'open', true) returning id, task_number::text`)[0]!;
  const w = await t(ids.worker, `${TAG} fix the van 2 chiller`);
  workerTask = { id: w.id, number: Number(w.task_number) };
  const o = await t(ids.other, `${TAG} count the crates`);
  otherTask = { id: o.id, number: Number(o.task_number) };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  const sql = getServiceSql();
  const all = Object.values(ids);
  await sql`update channel_setting set enabled = ${emailWasEnabled} where channel = 'email'`;
  await sql`delete from email_proposal where proposed_by = any(${all})`;
  // Tasks made from an email point back at it (task.source_email_id, TASK-054): release first.
  await sql`update task set source_email_id = null where employee_id = any(${all})`;
  await sql`delete from email_message where employee_id = any(${all}) or from_address like ${`eml-${run}-%`}`;
  await sql`delete from notification_outbox where recipient_employee_id = any(${all})`;
  await sql`delete from progress_event where employee_id = any(${all})`;
  await sql`delete from escalation where blocker_id in (select id from blocker where raised_by = any(${all}))`;
  await sql`delete from alert where blocker_id in (select id from blocker where raised_by = any(${all}))`.catch(() => {});
  await sql`delete from blocker where raised_by = any(${all})`;
  await sql`delete from task_update where employee_id = any(${all})`;
  await sql`delete from assignment where assigned_to = any(${all}) or assigned_by = any(${all})`;
  await sql`delete from task where employee_id = any(${all})`;
  await sql`delete from consent_record where employee_id = any(${all})`;
  await sql`delete from employee where id = any(${all})`;
  for (const [k, v] of [["SMTP_HOST", saved.smtp], ["EMAIL_FROM", saved.from], ["LLM_PROVIDER_ORDER", saved.order]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await closeDb();
});

const updatesBy = async (id: string) => (await getServiceSql()<{ n: number }[]>`select count(*)::int as n from task_update where employee_id = ${id}`)[0]!.n;

describe("a reply from an employee", () => {
  it("carrying FN-<n> becomes an update on that task; 'done' closes it; one reply goes back in the same thread; a second delivery changes nothing", async () => {
    fakeModel();
    const m = mail({ subject: `Re: [FN-${workerTask.number}] New task for you: fix the van 2 chiller`, text: `Done, chiller fixed.\n\nOn Mon, 5 Oct 2026, FreshNow wrote:\n> fix it` });
    const r = await processInboundEmail(m, env);
    expect(r).toMatchObject({ kind: "update", taskId: workerTask.id, taskKey: `FN-${workerTask.number}`, status: "done" });
    const sql = getServiceSql();
    const u = await sql<{ status: string; channel: string; note_raw: string }[]>`select status, channel, note_raw from task_update where id = ${r.kind === "update" ? r.taskUpdateId : ""}`;
    expect(u[0]).toEqual({ status: "done", channel: "email", note_raw: "Done, chiller fixed." }); // the quote is not filed
    expect((await sql<{ status: string }[]>`select status from task where id = ${workerTask.id}`)[0]!.status).toBe("done");
    const ack = await sql<{ channel: string; payload: { inReplyTo: string; subject: string } }[]>`
      select channel, payload from notification_outbox where idempotency_key = ${`email-ack:${r.kind === "update" ? r.emailId : ""}`}`;
    expect(ack).toHaveLength(1);
    expect(ack[0]!.channel).toBe("email");
    expect(ack[0]!.payload.inReplyTo).toBe(m.messageId!.replace(/[<>]/g, ""));
    expect(ack[0]!.payload.subject).toMatch(/^Re: \[FN-/);

    expect(await processInboundEmail(m, env)).toEqual({ kind: "duplicate" });
    expect(await updatesBy(ids.worker)).toBe(1);
    await sql`update task set status = 'open' where id = ${workerTask.id}`;
  });

  it("without a key, is found by its thread (In-Reply-To an email we sent), and a percentage is recorded as progress", async () => {
    fakeModel();
    const sql = getServiceSql();
    const ours = `fn.${randomUUID()}@example.com`;
    await sql`insert into email_message (direction, message_id, from_address, to_address, subject, employee_id, task_id, status, is_synthetic)
              values ('out', ${ours}, ${BOSS}, ${WORKER}, 'hello', ${ids.worker}, ${workerTask.id}, 'sent', true)`;
    const r = await processInboundEmail(mail({ subject: "Re: hello", inReplyTo: `<${ours}>`, text: "40% done, still on it" }), env);
    expect(r).toMatchObject({ kind: "update", taskId: workerTask.id, status: "in_progress" });
    expect((await sql<{ progress_pct: number }[]>`select progress_pct from task where id = ${workerTask.id}`)[0]!.progress_pct).toBe(40);
  });

  it("naming someone else's task key is not enough to file against it — it is kept as a general report", async () => {
    fakeModel();
    const r = await processInboundEmail(mail({ subject: `Re: [FN-${otherTask.number}]`, text: "Started on this" }), env);
    expect(r).toMatchObject({ kind: "update", taskId: null });
  });

  it("describing a problem still raises it — the email channel reaches the same blocker pipeline", async () => {
    fakeModel();
    const r = await processInboundEmail(mail({ subject: `Re: [FN-${workerTask.number}]`, text: "Blocked - no gas for the chiller" }), env);
    expect(r).toMatchObject({ kind: "update", status: "blocker", blocker: true });
  });
});

describe("what is refused or ignored — and writes nothing", () => {
  it.each([
    ["a sender not on the allow-list", mail({ from: OUTSIDER, text: "hello" }), "refused"],
    ["a forged sender (DKIM fails)", mail({ text: "done", authResults: ["mx.google.com; dkim=fail; spf=pass; dmarc=fail"] }), "refused"],
    ["a sender with no verdict at all", mail({ text: "done", authResults: [] }), "refused"],
    ["a verdict written by another server", mail({ text: "done", authResults: ["evil.example; dkim=pass; spf=pass; dmarc=pass"] }), "refused"],
    ["an out-of-office", mail({ text: "I am away", autoSubmitted: "auto-replied" }), "ignored"],
    ["mail not addressed to the inbox", mail({ text: "done", to: [BOSS] }), "ignored"],
    ["a reply that is only the quote", mail({ text: "> quoted only" }), "ignored"],
  ] as const)("%s", async (_name, m, kind) => {
    fakeModel();
    const before = await updatesBy(ids.worker);
    const r = await processInboundEmail(m, env);
    expect(r.kind).toBe(kind);
    expect(await updatesBy(ids.worker)).toBe(before);
    const row = await getServiceSql()<{ status: string; reason: string }[]>`select status, reason from email_message where id = ${"emailId" in r ? r.emailId : ""}`;
    expect(row[0]!.status).toBe(kind);
    expect(row[0]!.reason.length).toBeGreaterThan(5);
  });

  it("one of FreshNow's own emails, seen again in the Sent mailbox: ignored, never read as work", async () => {
    fakeModel();
    const sql = getServiceSql();
    const ours = `fn.${randomUUID()}@example.com`;
    await sql`insert into email_message (direction, message_id, from_address, to_address, subject, employee_id, status, is_synthetic)
              values ('out', ${ours}, ${BOSS}, ${INBOX}, 'loop?', ${ids.boss}, 'sent', true)`;
    const r = await processInboundEmail(mail({ messageId: `<${ours}>`, from: BOSS, text: "Worker: restock the Marina machine", authResults: [], sentByMailboxOwner: true }), env);
    expect(r).toMatchObject({ kind: "ignored", reason: "our own message" });
  });

  it("someone who has not agreed to the current notice: recorded, not read", async () => {
    fakeModel();
    const sql = getServiceSql();
    await sql`delete from consent_record where employee_id = ${ids.other}`;
    const r = await processInboundEmail(mail({ from: OTHER, text: "done", authResults: [PASS.replace(WORKER, OTHER)] }), env);
    expect(r).toMatchObject({ kind: "ignored", reason: "no current consent" });
    await recordConsent({ employeeId: ids.other, noticeHash: currentNoticeHash(), via: "telegram" });
  });
});

describe("work sent by email: assigned at once when every owner is certain, otherwise a proposal (TASK-054)", () => {
  const assignmentsTo = async (id: string) =>
    getServiceSql()<{ id: string; origin: string | null; notify_channels: string[] | null; task_id: string; source_email_id: string | null; assigned_by: string }[]>`
      select a.id, a.origin, a.notify_channels, a.task_id, t.source_email_id, a.assigned_by
        from assignment a join task t on t.id = a.task_id where a.assigned_to = ${id} order by a.created_at`;

  it("naming exactly one person, from the mailbox owner (Gmail's Sent label is the proof): assigned, recorded against the email, the assignee told by email too, one reply lists it", async () => {
    fakeModel();
    const before = (await assignmentsTo(ids.worker)).length;
    const r = await processInboundEmail(
      mail({ from: BOSS, subject: "Work for the week", text: "Worker: restock the Marina machine", authResults: [], sentByMailboxOwner: true }),
      env,
    );
    expect(r).toMatchObject({ kind: "assigned" });
    const rows = await assignmentsTo(ids.worker);
    expect(rows.length).toBe(before + 1);
    const a = rows.at(-1)!;
    // Where it came from, and how they were told — both on the record.
    expect(a).toMatchObject({ origin: "email", assigned_by: ids.boss, source_email_id: r.kind === "assigned" ? r.emailId : "" });
    expect(a.notify_channels).toContain("email");
    const sql = getServiceSql();
    const queued = await sql<{ channel: string }[]>`select channel from notification_outbox where idempotency_key like ${`task.assigned:${a.id}:%`}`;
    expect(queued.map((q) => q.channel).sort()).toEqual(expect.arrayContaining(["email", "inapp"]));
    // The sender gets one reply in the thread, naming the task key and the person.
    const ack = await sql<{ payload: { text: string } }[]>`select payload from notification_outbox where idempotency_key = ${`email-ack:${r.kind === "assigned" ? r.emailId : ""}`}`;
    expect(ack).toHaveLength(1);
    expect(ack[0]!.payload.text).toMatch(/FN-\d+ Restock the Marina machine → EML-\S+ Worker/);
    // Nothing waits as a proposal.
    expect((await listPendingEmailProposals()).filter((p) => p.from === BOSS)).toHaveLength(0);
  });

  it("sent TO the person (the inbox copied) and naming nobody: the recipient is the owner", async () => {
    fakeModel({ named: null });
    const before = (await assignmentsTo(ids.worker)).length;
    const r = await processInboundEmail(
      mail({ from: BOSS, to: [WORKER, INBOX], subject: "Marina", text: "Please restock the Marina machine today.", authResults: [], sentByMailboxOwner: true }),
      env,
    );
    expect(r).toMatchObject({ kind: "assigned" });
    expect((await assignmentsTo(ids.worker)).length).toBe(before + 1);
  });

  it("a reply-all from the assignee to that original email is filed on the task it created", async () => {
    fakeModel({ named: null });
    const original = `<orig-${randomUUID()}@mail.example.com>`;
    const r = await processInboundEmail(
      mail({ messageId: original, from: BOSS, to: [WORKER, INBOX], subject: "Filler", text: "Clean the filler before Friday.", authResults: [], sentByMailboxOwner: true }),
      env,
    );
    expect(r.kind).toBe("assigned");
    const taskId = r.kind === "assigned" ? r.assigned[0]!.taskId : "";
    const reply = await processInboundEmail(mail({ to: [BOSS, INBOX], subject: "Re: Filler", inReplyTo: original, text: "60% done, two nozzles left" }), env);
    expect(reply).toMatchObject({ kind: "update", taskId });
    // "60%" in their words became the task's own progress, labelled as theirs.
    const t = (await getServiceSql()<{ progress_pct: number; progress_source: string }[]>`select progress_pct, progress_source from task where id = ${taskId}`)[0]!;
    expect(t).toEqual({ progress_pct: 60, progress_source: "self_reported" });
  });

  it("a name nobody has: nothing assigned — a proposal waits for a person, and the reply says why", async () => {
    fakeModel({ named: "Zebedee" });
    const before = (await assignmentsTo(ids.worker)).length;
    const r = await processInboundEmail(
      mail({ from: BOSS, subject: "More", text: "Zebedee: restock the Marina machine", authResults: [], sentByMailboxOwner: true }),
      env,
    );
    expect(r).toMatchObject({ kind: "proposal", tasks: 1 });
    expect((await assignmentsTo(ids.worker)).length).toBe(before);
    const pending = (await listPendingEmailProposals()).filter((p) => p.from === BOSS);
    expect(pending).toHaveLength(1);
    const ack = await getServiceSql()<{ payload: { text: string } }[]>`select payload from notification_outbox where idempotency_key = ${`email-ack:${r.kind === "proposal" ? r.emailId : ""}`}`;
    expect(ack[0]!.payload.text).toMatch(/Nothing has been assigned yet \(not every job names exactly one person\)/);
    expect(await decideEmailProposal({ proposalId: pending[0]!.id, by: ids.boss, status: "dismissed" })).toBe(true);
    expect(await decideEmailProposal({ proposalId: pending[0]!.id, by: ids.boss, status: "applied" })).toBe(false); // decided once
  });

  it("a person the sender may not give work to (not their report): a proposal, never an assignment", async () => {
    fakeModel({ pick: "Other" });
    const r = await processInboundEmail(
      mail({ from: BOSS, subject: "Crates", text: "Other: count the crates again", authResults: [], sentByMailboxOwner: true }),
      env,
    );
    expect(r).toMatchObject({ kind: "proposal" });
    expect((await assignmentsTo(ids.other)).length).toBe(0);
  });

  it("the Sent label proves nothing for anyone but the mailbox owner", async () => {
    fakeModel();
    const r = await processInboundEmail(mail({ from: WORKER, text: "done", authResults: [], sentByMailboxOwner: true }), env);
    expect(r.kind).toBe("refused");
  });

  it("a model outage leaves the email for the retry job, which replays the same checks; after the cap a person is told", async () => {
    fakeModel({ fail: true });
    const r = await processInboundEmail(mail({ from: BOSS, subject: "More work", text: "Worker: clean the filler", authResults: [], sentByMailboxOwner: true }), env);
    expect(r.kind).toBe("retry");
    const id = "emailId" in r ? r.emailId : "";
    const sql = getServiceSql();
    expect((await sql<{ status: string }[]>`select status from email_message where id = ${id}`)[0]!.status).toBe("received");
    await sql`update email_message set created_at = now() - interval '5 minutes' where id = ${id}`;
    expect((await unreadInboundEmails(50)).map((x) => x.id)).toContain(id);
    const stored = (await storedInboundMessage(id))!;
    expect(stored.sentByMailboxOwner).toBe(true);
    for (let i = 1; i < MAX_EMAIL_ATTEMPTS - 1; i++) expect((await screenAndRoute(id, stored, env)).kind).toBe("retry");
    expect((await screenAndRoute(id, stored, env)).kind).toBe("proposal"); // gave up: a person is told
    expect((await sql<{ status: string; reason: string }[]>`select status, reason from email_message where id = ${id}`)[0]).toMatchObject({ status: "processed", reason: expect.stringMatching(/gave up/) });
  });
});

describe("agreeing to the privacy notice by email (TASK-054)", () => {
  it("only a clear statement counts — never silence, a bare yes, or a negation", () => {
    expect(isConsentAgreement("I AGREE")).toBe(true);
    expect(isConsentAgreement("Yes, I agree.\n\nThanks")).toBe(true);
    expect(isConsentAgreement("agreed")).toBe(true);
    expect(isConsentAgreement("I do not agree")).toBe(false);
    expect(isConsentAgreement("I don't agree with this")).toBe(false);
    expect(isConsentAgreement("yes")).toBe(false);
    expect(isConsentAgreement("ok")).toBe(false);
    expect(isConsentAgreement("")).toBe(false);
  });

  it("someone with only an email is sent the notice; replying I AGREE to it records consent; anything else records nothing", async () => {
    fakeModel();
    const sql = getServiceSql();
    await sql`delete from consent_record where employee_id = ${ids.other}`;
    const asked = await requestConsentFromEveryone({ employeeIds: [ids.other] });
    expect(asked.enqueued).toBeGreaterThan(0);
    const row = (await sql<{ id: string; payload: { kind: string; noticeHash: string; text: string } }[]>`
      select id, payload from notification_outbox where recipient_employee_id = ${ids.other} and channel = 'email'
        and payload->>'kind' = 'consent.requested' order by created_at desc limit 1`)[0]!;
    expect(row.payload.noticeHash).toBe(currentNoticeHash());
    expect(row.payload.text).toContain("I AGREE");
    // What the worker records when it sends that email.
    const ours = `fn.${row.id}@example.com`;
    await sql`insert into email_message (direction, message_id, from_address, to_address, subject, employee_id, outbox_id, status, is_synthetic)
              values ('out', ${ours}, ${BOSS}, ${OTHER}, 'FreshNow privacy notice', ${ids.other}, ${row.id}, 'sent', true)`;
    const from = { from: OTHER, authResults: [PASS.replace(WORKER, OTHER)], inReplyTo: `<${ours}>`, subject: "Re: FreshNow privacy notice" };

    const no = await processInboundEmail(mail({ ...from, text: "I do not agree" }), env);
    expect(no).toMatchObject({ kind: "consent", agreed: false });
    expect(await hasCurrentConsent(ids.other)).toBe(false);

    const yes = await processInboundEmail(mail({ ...from, text: "I AGREE\n\nOn Tue, FreshNow wrote:\n> notice" }), env);
    expect(yes).toMatchObject({ kind: "consent", agreed: true });
    expect(await hasCurrentConsent(ids.other)).toBe(true);
    const audit = await sql<{ detail: { via: string } }[]>`select detail from audit_log where action = 'consent.recorded' and entity_id = ${ids.other} order by created_at desc limit 1`;
    expect(audit[0]!.detail.via).toBe("email");
  });

  it("a reply to SOMEONE ELSE's notice is not consent", async () => {
    fakeModel();
    const sql = getServiceSql();
    await sql`delete from consent_record where employee_id = ${ids.other}`;
    const [o] = await sql<{ id: string }[]>`
      insert into notification_outbox (idempotency_key, payload, channel, recipient_employee_id, is_synthetic)
      values (${`consent-other-${randomUUID()}`}, ${sql.json({ kind: "consent.requested", noticeHash: currentNoticeHash() } as never)}, 'email', ${ids.worker}, true)
      returning id`;
    const ours = `fn.${o!.id}@example.com`;
    await sql`insert into email_message (direction, message_id, from_address, to_address, subject, employee_id, outbox_id, status, is_synthetic)
              values ('out', ${ours}, ${BOSS}, ${WORKER}, 'notice', ${ids.worker}, ${o!.id}, 'sent', true)`;
    const r = await processInboundEmail(mail({ from: OTHER, authResults: [PASS.replace(WORKER, OTHER)], inReplyTo: `<${ours}>`, text: "I agree" }), env);
    expect(r).toMatchObject({ kind: "ignored", reason: "no current consent" });
    expect(await hasCurrentConsent(ids.other)).toBe(false);
    await recordConsent({ employeeId: ids.other, noticeHash: currentNoticeHash(), via: "telegram" });
  });
});

describe("who may read emails (RLS)", () => {
  it("each person their own; a manager their report's; nobody else's; proposals only to the proposer", async () => {
    const view = (id: string, role: "employee" | "manager") =>
      withContext({ employeeId: id, isCeo: false, accessRole: role }, (sql) => sql<{ employee_id: string | null }[]>`select employee_id from email_message where employee_id = any(${Object.values(ids)})`);
    const workerSees = new Set((await view(ids.worker, "employee")).map((r) => r.employee_id));
    expect([...workerSees]).toEqual([ids.worker]);
    const bossSees = new Set((await view(ids.boss, "manager")).map((r) => r.employee_id));
    expect(bossSees.has(ids.worker)).toBe(true);
    expect(bossSees.has(ids.other)).toBe(false);
    const otherSees = new Set((await view(ids.other, "employee")).map((r) => r.employee_id));
    expect(otherSees.has(ids.worker)).toBe(false);
    const props = (id: string) => withContext({ employeeId: id, isCeo: false, accessRole: "employee" }, (sql) => sql`select id from email_proposal where proposed_by = ${ids.boss}`);
    expect((await props(ids.worker)).length).toBe(0);
    expect((await withContext({ employeeId: ids.boss, isCeo: false, accessRole: "manager" }, (sql) => sql`select id from email_proposal where proposed_by = ${ids.boss}`)).length).toBeGreaterThan(0);
  });
});
