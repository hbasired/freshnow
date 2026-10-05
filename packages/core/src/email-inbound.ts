import { createHash, randomUUID } from "node:crypto";
import { logAudit } from "./audit.js";
import { hasCurrentConsent } from "./consent.js";
import { CONTEXT_LIMITS, relevantPeople } from "./context-scope.js";
import { getServiceSql } from "./db.js";
import { planDocumentTasks, planningDirectory } from "./documents.js";
import { emailAddressAllowed, inboxConfig } from "./email-config.js";
import {
  authPasses,
  emailAddressOf,
  extractReply,
  formatTaskKey,
  normaliseMessageId,
  parseEmailStatus,
  readAuthResults,
  taskNumberFromSubject,
} from "./email-reply.js";
import { enqueueNotification } from "./outbox.js";
import { reportProgress } from "./progress.js";
import { attachNoteAndProcess, recordTaskUpdate } from "./updates.js";

/**
 * An email arriving in the FreshNow inbox, turned into exactly one of: a status update, a
 * proposal of tasks, or a recorded refusal.
 *
 * The order is the system's usual one:
 *   1. RECORD first — the words are on disk (email_message) before anything interprets them, and
 *      the row's uniqueness on Message-ID makes a second delivery of the same email a no-op.
 *   2. SCREEN in code — addressed to the inbox, not an auto-reply, on the allow-list, PROVEN to
 *      come from that address (the receiving server's SPF/DKIM/DMARC, or Gmail's own record that
 *      the mailbox owner sent it), an active employee, who has agreed to the privacy notice.
 *   3. ROUTE by rules — which task (the FN-42 key in the subject first, then In-Reply-To: the Jira
 *      order), whose task, and whether the sender may give work. No model decides any of it.
 *   4. Only then the model: the blocker parser reads an update's words; the planner reads a work
 *      email. A plan is a PROPOSAL — nothing is assigned until a person taps Apply.
 */

export interface InboundEmailMessage {
  messageId: string | null;
  inReplyTo: string | null;
  references: readonly string[];
  from: string;
  to: readonly string[];
  subject: string | null;
  /** The plain-text body as received, quote and all. */
  text: string;
  date: Date | null;
  /** Lower-cased header values the screen needs. */
  autoSubmitted?: string | null;
  precedence?: string | null;
  /** Every Authentication-Results header, in order (top first). */
  authResults: readonly string[];
  /** Gmail says the mailbox's owner sent this (it carries the \Sent label). */
  sentByMailboxOwner?: boolean;
  isSynthetic?: boolean;
}

export type InboundEmailOutcome =
  | { kind: "duplicate" }
  | { kind: "refused" | "ignored"; emailId: string; reason: string }
  | { kind: "retry"; emailId: string; reason: string }
  | { kind: "update"; emailId: string; taskUpdateId: string; taskId: string | null; taskKey: string | null; status: string; blocker: boolean }
  | { kind: "proposal"; emailId: string; proposalId: string | null; tasks: number };

/** After this many failed reads (a model outage), an email is handed to a person instead. */
export const MAX_EMAIL_ATTEMPTS = 4;

interface Sender {
  id: string;
  display_name: string;
  access_role: string;
  status: string;
}

/** A stable id for a message that arrived without a Message-ID, so it is still processed once. */
function syntheticMessageId(m: InboundEmailMessage): string {
  const h = createHash("sha256")
    .update([emailAddressOf(m.from), m.date?.toISOString() ?? "", m.subject ?? "", m.text].join("\u0000"))
    .digest("hex")
    .slice(0, 32);
  return `nomid.${h}@freshnow.local`;
}

export async function processInboundEmail(m: InboundEmailMessage, env: NodeJS.ProcessEnv = process.env): Promise<InboundEmailOutcome> {
  const sql = getServiceSql();
  const correlationId = randomUUID();
  const messageId = normaliseMessageId(m.messageId) ?? syntheticMessageId(m);
  const from = emailAddressOf(m.from);
  const to = m.to.map(emailAddressOf);
  const inbox = inboxConfig(env);
  const reply = extractReply(m.text);

  // 1 ── record first; a second delivery of the same email stops here.
  const inserted = await sql<{ id: string }[]>`
    insert into email_message
      (direction, message_id, in_reply_to, thread_refs, from_address, to_address, subject,
       body_text, status, correlation_id, sent_at, is_synthetic)
    values ('in', ${messageId}, ${normaliseMessageId(m.inReplyTo)}, ${[...m.references]},
            ${from}, ${(inbox && to.find((a) => a === inbox.inboxAddress)) ?? to[0] ?? ""},
            ${m.subject?.slice(0, 500) ?? null}, ${reply || null}, 'received',
            ${correlationId}, ${m.date}, ${m.isSynthetic ?? false})
    on conflict (direction, message_id) do nothing
    returning id`;
  const emailId = inserted[0]?.id;
  if (!emailId) return { kind: "duplicate" };
  return screenAndRoute(emailId, m, env);
}

/**
 * Screen and route a recorded email. Separate from `processInboundEmail` so the retry job can
 * run it again for an email a model outage left unread — same rules, same row.
 */
export async function screenAndRoute(emailId: string, m: InboundEmailMessage, env: NodeJS.ProcessEnv = process.env): Promise<InboundEmailOutcome> {
  const sql = getServiceSql();
  const row = (await sql<{ correlation_id: string; body_text: string | null; attempts: number }[]>`
    update email_message set attempts = attempts + 1 where id = ${emailId}
    returning correlation_id, body_text, attempts`)[0]!;
  const correlationId = row.correlation_id;
  const from = emailAddressOf(m.from);
  const to = m.to.map(emailAddressOf);
  const inbox = inboxConfig(env);

  const close = async (
    status: "refused" | "ignored" | "processed",
    reason: string,
    extra: { employeeId?: string | null; taskId?: string | null; taskUpdateId?: string | null; auth?: Record<string, unknown> } = {},
  ) => {
    await sql`
      update email_message
         set status = ${status}, reason = ${reason.slice(0, 300)},
             employee_id = coalesce(${extra.employeeId ?? null}, employee_id),
             task_id = coalesce(${extra.taskId ?? null}, task_id),
             task_update_id = coalesce(${extra.taskUpdateId ?? null}, task_update_id),
             auth = coalesce(${extra.auth ? sql.json(extra.auth as never) : null}, auth)
       where id = ${emailId}`;
    await logAudit({
      correlationId,
      actor: extra.employeeId ? `employee:${extra.employeeId}` : "system",
      action: status === "processed" ? "email.processed" : `email.${status}`,
      entity: "email_message",
      entityId: emailId,
      // Who and why — never the body.
      detail: { from, status, reason: reason.slice(0, 300) },
    });
  };

  // 2 ── screen, cheapest first.
  if (inbox && !to.includes(inbox.inboxAddress)) {
    await close("ignored", `not addressed to the FreshNow inbox (${inbox.inboxAddress})`);
    return { kind: "ignored", emailId, reason: "not addressed to the inbox" };
  }
  if ((m.autoSubmitted && m.autoSubmitted.toLowerCase() !== "no") || ["bulk", "junk", "list"].includes((m.precedence ?? "").toLowerCase())) {
    await close("ignored", "an automatic message (out-of-office, mailing list)");
    return { kind: "ignored", emailId, reason: "automatic message" };
  }
  if (!emailAddressAllowed(from, env)) {
    await close("refused", "sender is not on EMAIL_ALLOWLIST");
    return { kind: "refused", emailId, reason: "not on the allow-list" };
  }

  // Is the From address real? Anyone can WRITE any From:. Two kinds of proof are accepted:
  // the mailbox's own owner sending to its inbox alias (Gmail marks it \Sent — only someone
  // signed in to that account can do that), or the receiving server's verdicts all passing.
  const owner = inbox?.user.toLowerCase() ?? null;
  const verdict = readAuthResults(m.authResults, inbox?.trustedAuthserv ?? "mx.google.com");
  const auth = { ...verdict, ownerSent: Boolean(m.sentByMailboxOwner && owner && from === owner) };
  if (!auth.ownerSent && !authPasses(verdict)) {
    await close("refused", "the receiving server did not confirm the sender (SPF, DKIM and DMARC must all pass)", { auth });
    return { kind: "refused", emailId, reason: "sender not authenticated" };
  }

  const sender = (await sql<Sender[]>`
    select id, display_name, access_role, status from employee where lower(email) = ${from}`)[0];
  if (!sender || sender.status !== "active") {
    await close("refused", sender ? "that person's account is not active" : "no active employee has that email address", { auth });
    return { kind: "refused", emailId, reason: "not an active employee" };
  }
  if (!(await hasCurrentConsent(sender.id))) {
    // The same door as Telegram and the dashboard: nothing is taken from someone who has not
    // agreed to the notice as it reads today. Their email stays recorded; nothing is read.
    await close("ignored", "the sender has not agreed to the current privacy notice", { employeeId: sender.id, auth });
    return { kind: "ignored", emailId, reason: "no current consent" };
  }

  const words = row.body_text ?? "";
  if (!words.trim()) {
    await close("ignored", "nothing written above the quoted message", { employeeId: sender.id, auth });
    return { kind: "ignored", emailId, reason: "empty reply" };
  }

  // 3 ── which task? The key in the subject first, then the thread (Jira's order).
  const task = await findTask(m);
  const mayGiveWork = sender.access_role !== "employee";

  if (task && task.employee_id === sender.id) {
    return fileUpdate({ emailId, correlationId, sender, task, words, auth, close });
  }
  if (mayGiveWork) {
    return proposeWork({ emailId, correlationId, sender, subject: m.subject, words, auth, attempts: row.attempts, close });
  }
  // An employee writing about no task of theirs: still a report — words kept, a problem still
  // escalates — just not filed against someone else's job.
  return fileUpdate({ emailId, correlationId, sender, task: null, words, auth, close });
}

interface TaskRow {
  id: string;
  employee_id: string;
  title: string;
  task_number: string;
}

async function findTask(m: InboundEmailMessage): Promise<TaskRow | null> {
  const sql = getServiceSql();
  const n = taskNumberFromSubject(m.subject);
  if (n !== null) {
    const byKey = (await sql<TaskRow[]>`select id, employee_id, title, task_number::text from task where task_number = ${n}`)[0];
    if (byKey) return byKey;
  }
  const ids = [normaliseMessageId(m.inReplyTo), ...m.references.map(normaliseMessageId)].filter((x): x is string => !!x);
  if (ids.length === 0) return null;
  const byThread = (await sql<TaskRow[]>`
    select t.id, t.employee_id, t.title, t.task_number::text
      from email_message e join task t on t.id = e.task_id
     where e.direction = 'out' and e.message_id = any(${ids})
     order by e.created_at desc limit 1`)[0];
  return byThread ?? null;
}

type Close = (
  status: "refused" | "ignored" | "processed",
  reason: string,
  extra?: { employeeId?: string | null; taskId?: string | null; taskUpdateId?: string | null; auth?: Record<string, unknown> },
) => Promise<void>;

async function fileUpdate(p: {
  emailId: string;
  correlationId: string;
  sender: Sender;
  task: TaskRow | null;
  words: string;
  auth: Record<string, unknown>;
  close: Close;
}): Promise<InboundEmailOutcome> {
  const st = parseEmailStatus(p.words);
  const key = p.task ? formatTaskKey(p.task.task_number) : null;
  // Write-first, exactly as Telegram does: the update exists before the model reads a word.
  const rec = await recordTaskUpdate({
    taskId: p.task?.id ?? null,
    employeeId: p.sender.id,
    status: st.status,
    channel: "email",
    correlationId: p.correlationId,
  });
  if (p.task && st.percent !== null && st.status !== "done") {
    await reportProgress({ taskId: p.task.id, employeeId: p.sender.id, pct: st.percent, note: p.words.slice(0, 500), correlationId: p.correlationId }).catch(() => {});
  }
  const res = await attachNoteAndProcess(rec.taskUpdateId, p.words, p.correlationId);
  await p.close("processed", key ? `status update on ${key} (${st.status})` : `status update (${st.status})`, {
    employeeId: p.sender.id,
    taskId: p.task?.id ?? null,
    taskUpdateId: rec.taskUpdateId,
    auth: p.auth,
  });

  const lines = [
    key && p.task ? `Saved your update on ${key} — "${p.task.title}".` : "Saved your update.",
    `Status: ${st.status === "blocker" ? "blocked" : st.status.replace("_", " ")}${st.percent !== null ? ` (${st.percent}%)` : ""}.`,
    res.needsReview
      ? "I could not read the rest automatically, so it has gone to the CEO to read. Nothing was lost."
      : res.blockerId
        ? `Logged a ${res.severity} ${res.category} problem${res.alerted ? " — the CEO has been alerted" : ""}.`
        : "I did not read it as a problem; the CEO can see exactly what you wrote.",
  ];
  await acknowledge({ emailId: p.emailId, to: p.sender.id, taskId: p.task?.id ?? null, title: key ? `Saved: ${key}` : "Saved", text: lines.join("\n"), correlationId: p.correlationId });
  return { kind: "update", emailId: p.emailId, taskUpdateId: rec.taskUpdateId, taskId: p.task?.id ?? null, taskKey: key, status: st.status, blocker: Boolean(res.blockerId) };
}

async function proposeWork(p: {
  emailId: string;
  correlationId: string;
  sender: Sender;
  subject: string | null;
  words: string;
  auth: Record<string, unknown>;
  attempts: number;
  close: Close;
}): Promise<InboundEmailOutcome> {
  const sql = getServiceSql();
  const text = `${p.subject ? `${p.subject}\n\n` : ""}${p.words}`.slice(0, CONTEXT_LIMITS.documentChars);
  // Only the people this email could be about go to the model (context-scope.ts).
  const scoped = relevantPeople(text, await planningDirectory(p.sender.id));

  let plan: Awaited<ReturnType<typeof planDocumentTasks>>;
  try {
    plan = await planDocumentTasks({ text, colleagues: scoped.people, instruction: p.subject, uploadedBy: p.sender.id, correlationId: p.correlationId });
  } catch (err) {
    // A model outage is not a refusal. The email stays 'received' and the retry job reads it
    // again; after MAX_EMAIL_ATTEMPTS a person is told instead (bounded — CLAUDE.md rule 4).
    const reason = `could not be read yet: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`;
    if (p.attempts >= MAX_EMAIL_ATTEMPTS) {
      await p.close("processed", `gave up after ${p.attempts} attempts — ${reason}`, { employeeId: p.sender.id, auth: p.auth });
      await acknowledge({ emailId: p.emailId, to: p.sender.id, taskId: null, title: "Could not read your email", text: "I could not read the work in your email automatically. It is saved — please assign it in the dashboard.", correlationId: p.correlationId });
      return { kind: "proposal", emailId: p.emailId, proposalId: null, tasks: 0 };
    }
    // Keep who and how they were proven, so the retry screens exactly as this pass did.
    await sql`update email_message set reason = ${reason.slice(0, 300)}, employee_id = ${p.sender.id},
                     auth = ${sql.json(p.auth as never)} where id = ${p.emailId}`;
    return { kind: "retry", emailId: p.emailId, reason };
  }

  if (plan.tasks.length === 0) {
    await p.close("processed", "no tasks found in it", { employeeId: p.sender.id, auth: p.auth });
    await acknowledge({ emailId: p.emailId, to: p.sender.id, taskId: null, title: "No tasks found", text: "I found no separate pieces of work in your email, so nothing was proposed. Write one line per job, naming the person.", correlationId: p.correlationId });
    return { kind: "proposal", emailId: p.emailId, proposalId: null, tasks: 0 };
  }

  const tasks = plan.tasks.map((t) => ({
    title: t.title,
    detail: t.detail,
    assigneeId: t.assignee?.id ?? null,
    assigneeName: t.assignee?.display_name ?? null,
    namedAs: t.namedAs,
    matchedBy: t.matchedBy,
    candidates: t.candidates.map((c) => ({ id: c.id, name: c.display_name })),
  }));
  const proposal = (await sql<{ id: string }[]>`
    insert into email_proposal (email_message_id, proposed_by, summary, tasks)
    values (${p.emailId}, ${p.sender.id}, ${plan.summary || null}, ${sql.json(tasks as never)})
    on conflict (email_message_id) do nothing
    returning id`)[0];
  await p.close("processed", `proposed ${tasks.length} task(s)${scoped.truncated ? ` — ${scoped.people.length} of ${scoped.total} people offered` : ""}`, { employeeId: p.sender.id, auth: p.auth });

  const owner = (t: (typeof tasks)[number]) =>
    t.assigneeName
      ? `${t.assigneeName}${t.matchedBy === "ai" ? " (my guess — check)" : ""}`
      : t.candidates.length > 1
        ? `"${t.namedAs ?? ""}" could be ${t.candidates.map((c) => c.name).join(" or ")} — choose`
        : t.namedAs
          ? `"${t.namedAs}" — not in the system, choose someone`
          : "nobody named — choose someone";
  await acknowledge({
    emailId: p.emailId,
    to: p.sender.id,
    taskId: null,
    title: `${tasks.length} task(s) to confirm`,
    text:
      `I read ${tasks.length} task(s) in your email. Nothing has been assigned yet — confirm them in the dashboard (Assign → From email):\n\n` +
      tasks.map((t, i) => `${i + 1}. ${t.title} → ${owner(t)}`).join("\n"),
    url: "/app/#tasks/assign",
    correlationId: p.correlationId,
  });
  return { kind: "proposal", emailId: p.emailId, proposalId: proposal?.id ?? null, tasks: tasks.length };
}

/**
 * Answer the sender in the same email thread. A direct reply to their own email, so it goes by
 * email whatever their per-event preferences say — but only if the email channel is live, and
 * the outbox keeps it to one reply per inbound email.
 */
async function acknowledge(p: { emailId: string; to: string; taskId: string | null; title: string; text: string; url?: string; correlationId: string }): Promise<void> {
  const sql = getServiceSql();
  const e = (await sql<{ message_id: string; subject: string | null }[]>`select message_id, subject from email_message where id = ${p.emailId}`)[0];
  const subject = e?.subject ? (/^re:/i.test(e.subject) ? e.subject : `Re: ${e.subject}`) : p.title;
  await enqueueNotification({
    idempotencyKey: `email-ack:${p.emailId}`,
    channel: "email",
    recipientEmployeeId: p.to,
    reason: "reply to your email",
    payload: { kind: "email.ack", title: p.title, text: p.text, subject, inReplyTo: e?.message_id, ...(p.taskId ? { taskId: p.taskId } : {}), ...(p.url ? { url: p.url } : {}) },
    correlationId: p.correlationId,
  });
}

// ── Proposals: listed, applied, dismissed ────────────────────────────────────────

export interface EmailProposalRow {
  id: string;
  createdAt: string;
  from: string;
  fromName: string;
  subject: string | null;
  summary: string | null;
  tasks: {
    title: string;
    detail: string | null;
    assigneeId: string | null;
    assigneeName: string | null;
    namedAs: string | null;
    matchedBy: "name" | "ai" | null;
    candidates: { id: string; name: string }[];
  }[];
}

/** Pending proposals, newest first, bounded — all of them, or one proposer's. */
export async function listPendingEmailProposals(limit = 20, proposedBy?: string): Promise<EmailProposalRow[]> {
  const sql = getServiceSql();
  const rows = await sql<{ id: string; created_at: Date; from_address: string; display_name: string; subject: string | null; summary: string | null; tasks: EmailProposalRow["tasks"] }[]>`
    select p.id, p.created_at, m.from_address, e.display_name, m.subject, p.summary, p.tasks
      from email_proposal p
      join email_message m on m.id = p.email_message_id
      join employee e on e.id = p.proposed_by
     where p.status = 'pending' and (${proposedBy ?? null}::uuid is null or p.proposed_by = ${proposedBy ?? null})
     order by p.created_at desc
     limit ${Math.min(Math.max(limit, 1), 50)}`;
  return rows.map((r) => ({ id: r.id, createdAt: r.created_at.toISOString(), from: r.from_address, fromName: r.display_name, subject: r.subject, summary: r.summary, tasks: r.tasks }));
}

/** One pending proposal with its proposer, for the API's permission check before applying. */
export async function pendingEmailProposal(id: string): Promise<{ id: string; proposedBy: string; subject: string | null } | null> {
  const sql = getServiceSql();
  const r = (await sql<{ id: string; proposed_by: string; subject: string | null }[]>`
    select p.id, p.proposed_by, m.subject from email_proposal p join email_message m on m.id = p.email_message_id
     where p.id = ${id} and p.status = 'pending'`)[0];
  return r ? { id: r.id, proposedBy: r.proposed_by, subject: r.subject } : null;
}

/**
 * The older route (/inbound/email, a mail edge on a company domain) screened and planned an email
 * but stored only an audit line — the words and the plan were returned to the mail edge and lost,
 * so the CEO had nothing to confirm. It now records the email and the proposal like the inbox does.
 */
export async function recordWebhookProposal(p: {
  from: string;
  to: string | null;
  subject: string | null;
  text: string;
  senderEmployeeId: string;
  plan: { summary: string; tasks: { title: string; detail: string | null; assignee: { id: string; display_name: string } | null; namedAs: string | null; matchedBy: "name" | "ai" | null; candidates: { id: string; display_name: string }[] }[] };
  correlationId?: string;
}): Promise<{ proposalId: string | null }> {
  const sql = getServiceSql();
  const messageId = `webhook.${createHash("sha256").update([p.from, p.subject ?? "", p.text].join("\u0000")).digest("hex").slice(0, 32)}@freshnow.local`;
  const email = (await sql<{ id: string }[]>`
    insert into email_message (direction, message_id, from_address, to_address, subject, body_text, employee_id, status, reason, correlation_id)
    values ('in', ${messageId}, ${emailAddressOf(p.from)}, ${p.to ? emailAddressOf(p.to) : ""}, ${p.subject?.slice(0, 500) ?? null},
            ${extractReply(p.text) || null}, ${p.senderEmployeeId}, 'processed', ${`proposed ${p.plan.tasks.length} task(s) (mail edge)`}, ${p.correlationId ?? null})
    on conflict (direction, message_id) do update set status = email_message.status
    returning id`)[0]!;
  if (p.plan.tasks.length === 0) return { proposalId: null };
  const tasks = p.plan.tasks.map((t) => ({
    title: t.title, detail: t.detail, assigneeId: t.assignee?.id ?? null, assigneeName: t.assignee?.display_name ?? null,
    namedAs: t.namedAs, matchedBy: t.matchedBy, candidates: t.candidates.map((c) => ({ id: c.id, name: c.display_name })),
  }));
  const row = (await sql<{ id: string }[]>`
    insert into email_proposal (email_message_id, proposed_by, summary, tasks)
    values (${email.id}, ${p.senderEmployeeId}, ${p.plan.summary || null}, ${sql.json(tasks as never)})
    on conflict (email_message_id) do nothing returning id`)[0];
  return { proposalId: row?.id ?? null };
}

/** Mark a proposal decided. Only a pending one can be — a second tap changes nothing. */
export async function decideEmailProposal(p: { proposalId: string; by: string; status: "applied" | "dismissed"; correlationId?: string }): Promise<boolean> {
  const sql = getServiceSql();
  const rows = await sql`
    update email_proposal set status = ${p.status}, decided_by = ${p.by}, decided_at = now()
     where id = ${p.proposalId} and status = 'pending'
     returning id`;
  if (rows.length === 0) return false;
  await logAudit({ correlationId: p.correlationId, actor: `employee:${p.by}`, action: `email_proposal.${p.status}`, entity: "email_proposal", entityId: p.proposalId });
  return true;
}

/** Inbound emails a model outage left unread, for the retry job. Bounded. */
export async function unreadInboundEmails(limit = 10): Promise<{ id: string }[]> {
  const sql = getServiceSql();
  return sql<{ id: string }[]>`
    select id from email_message
     where direction = 'in' and status = 'received' and attempts between 1 and ${MAX_EMAIL_ATTEMPTS - 1}
       and created_at < now() - interval '1 minute'
     order by created_at
     limit ${limit}`;
}

/** Rebuild the message a stored inbound row came from, for a retry (screening runs again). */
export async function storedInboundMessage(emailId: string): Promise<InboundEmailMessage | null> {
  const sql = getServiceSql();
  const r = (await sql<{ message_id: string; in_reply_to: string | null; thread_refs: string[]; from_address: string; to_address: string; subject: string | null; body_text: string | null; sent_at: Date | null; auth: { spf?: string; dkim?: string; dmarc?: string; by?: string; ownerSent?: boolean } | null }[]>`
    select message_id, in_reply_to, thread_refs, from_address, to_address, subject, body_text, sent_at, auth
      from email_message where id = ${emailId} and direction = 'in'`)[0];
  if (!r) return null;
  // The verdicts were recorded on the first pass; replay them in the header form they came in.
  const a = r.auth;
  const authResults = a?.by ? [`${a.by}; spf=${a.spf ?? "none"}; dkim=${a.dkim ?? "none"}; dmarc=${a.dmarc ?? "none"}`] : [];
  return {
    messageId: r.message_id,
    inReplyTo: r.in_reply_to,
    references: r.thread_refs,
    from: r.from_address,
    to: [r.to_address],
    subject: r.subject,
    text: r.body_text ?? "",
    date: r.sent_at,
    authResults,
    sentByMailboxOwner: Boolean(a?.ownerSent),
  };
}
