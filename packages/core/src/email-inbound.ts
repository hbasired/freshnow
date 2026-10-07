import { createHash, randomUUID } from "node:crypto";
import { reachOf, type NotifyChoice } from "./alerts.js";
import { logAudit } from "./audit.js";
import { ConsentNoticeChangedError, hasCurrentConsent, recordConsent, requestConsentFromEveryone } from "./consent.js";
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
import { canAssignTo, loadViewer } from "./org.js";
import { enqueueNotification } from "./outbox.js";
import { matchPeopleByName } from "./people-match.js";
import { checkRateLimit } from "./rate-limit.js";
import { assignTask, attachNoteAndProcess, recordTaskUpdate } from "./updates.js";

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
 *      email. WHO each job is for is then decided in code, never by the model (TASK-054): when
 *      every job names exactly one person by name (people-match.ts), or the email was sent TO
 *      exactly one employee and names nobody else, the work is assigned at once — exactly as a
 *      Telegram message naming the person is — and the sender gets a reply saying what was
 *      assigned to whom and how they were told. When any owner is a guess, ambiguous or missing,
 *      the email becomes a PROPOSAL a person confirms in the dashboard, as before.
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
  | { kind: "proposal"; emailId: string; proposalId: string | null; tasks: number }
  | { kind: "assigned"; emailId: string; assigned: { taskId: string; taskKey: string; assignedTo: string }[] }
  | { kind: "consent"; emailId: string; agreed: boolean };

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
  // One of OUR messages coming back (the poller reads the Sent mailbox, where every email FreshNow
  // sends also lands): never read as someone's words, or a reply could answer itself for ever.
  const mid = normaliseMessageId(m.messageId);
  if (mid && (await sql`select 1 from email_message where direction = 'out' and message_id = ${mid} limit 1`).length > 0) {
    await close("ignored", "a message FreshNow sent itself");
    return { kind: "ignored", emailId, reason: "our own message" };
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
  // A reply to the privacy notice we emailed them (TASK-054) — the one thing an email from
  // someone who has not agreed yet may do. Matched by thread to OUR notice email to THEM.
  const consentHash = await consentRequestRepliedTo(m, sender.id);
  if (consentHash) {
    return consentReply({ emailId, correlationId, sender, noticeHash: consentHash, words: row.body_text ?? "", auth, close });
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
  const task = await findTask(m, sender.id);
  const mayGiveWork = sender.access_role !== "employee";

  if (task && task.employee_id === sender.id) {
    return fileUpdate({ emailId, correlationId, sender, task, words, auth, close });
  }
  if (mayGiveWork) {
    // Everyone else the email was addressed to — the people it may be FOR.
    const recipients = to.filter((a) => a !== from && a !== inbox?.inboxAddress);
    return proposeWork({ emailId, correlationId, sender, subject: m.subject, words, auth, attempts: row.attempts, close, recipients });
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

async function findTask(m: InboundEmailMessage, senderId: string): Promise<TaskRow | null> {
  const sql = getServiceSql();
  const n = taskNumberFromSubject(m.subject);
  if (n !== null) {
    const byKey = (await sql<TaskRow[]>`select id, employee_id, title, task_number::text from task where task_number = ${n}`)[0];
    if (byKey) return byKey;
  }
  const ids = threadIds(m);
  if (ids.length === 0) return null;
  const byThread = (await sql<TaskRow[]>`
    select t.id, t.employee_id, t.title, t.task_number::text
      from email_message e join task t on t.id = e.task_id
     where e.direction = 'out' and e.message_id = any(${ids})
     order by e.created_at desc limit 1`)[0];
  if (byThread) return byThread;
  // A reply-all to the email the work was GIVEN in (the CEO wrote to them and copied the inbox):
  // the sender's own task made from that email — and only when there is exactly one, because
  // with two jobs in one email a bare reply does not say which (TASK-054).
  const fromSource = await sql<TaskRow[]>`
    select t.id, t.employee_id, t.title, t.task_number::text
      from email_message e join task t on t.source_email_id = e.id
     where e.direction = 'in' and e.message_id = any(${ids}) and t.employee_id = ${senderId}
     limit 2`;
  return fromSource.length === 1 ? fromSource[0]! : null;
}

/** Every Message-ID this email says it answers, In-Reply-To first. */
function threadIds(m: InboundEmailMessage): string[] {
  return [normaliseMessageId(m.inReplyTo), ...m.references.map(normaliseMessageId)].filter((x): x is string => !!x);
}

/**
 * Is this a reply to the privacy notice we emailed THIS person? Returns the hash of the notice
 * that email carried, or null. Only our own outbound notice to the same person counts — a
 * forwarded copy answered by someone else is not their agreement.
 */
async function consentRequestRepliedTo(m: InboundEmailMessage, senderId: string): Promise<string | null> {
  const ids = threadIds(m);
  if (ids.length === 0) return null;
  const rows = await getServiceSql()<{ notice_hash: string | null }[]>`
    select o.payload->>'noticeHash' as notice_hash
      from email_message e join notification_outbox o on o.id = e.outbox_id
     where e.direction = 'out' and e.message_id = any(${ids}) and e.employee_id = ${senderId}
       and o.payload->>'kind' = 'consent.requested'
     order by e.created_at desc limit 1`;
  return rows[0]?.notice_hash ?? null;
}

/**
 * The words that count as agreeing, on the first line of the reply: "I agree", "I AGREE",
 * "Yes, I agree", "agreed", "I accept", "I consent". Anything with a negation is not agreement,
 * and a bare "yes" or "ok" is not either — consent has to be the clear statement the email asked
 * for (PDPL: "a specific, clear and unambiguous indication"). Pure and exported for tests.
 */
export function isConsentAgreement(reply: string): boolean {
  const first = (reply.split("\n").find((l) => l.trim().length > 0) ?? "").trim().toLowerCase();
  if (first.length === 0 || first.length > 120) return false;
  if (/\b(not|don'?t|do\s+not|disagree|refuse|won'?t|never|no)\b/.test(first)) return false;
  return /\b(i\s+agree|agreed|i\s+accept|i\s+consent)\b/.test(first);
}

async function consentReply(p: {
  emailId: string;
  correlationId: string;
  sender: Sender;
  noticeHash: string;
  words: string;
  auth: Record<string, unknown>;
  close: Close;
}): Promise<InboundEmailOutcome> {
  if (!isConsentAgreement(p.words)) {
    await p.close("processed", "a reply to the privacy notice that did not agree — nothing recorded", { employeeId: p.sender.id, auth: p.auth });
    // Part of the consent conversation, so it goes out as one (the relay holds every other
    // message to someone who has not agreed).
    await acknowledge({
      emailId: p.emailId, to: p.sender.id, taskId: null, kind: "consent.requested",
      title: "Nothing was recorded",
      text: "Thank you for your reply. Nothing was recorded. If you agree to the notice, reply to it with the words I AGREE. If you have questions, ask the CEO.",
      correlationId: p.correlationId,
    });
    return { kind: "consent", emailId: p.emailId, agreed: false };
  }
  try {
    await recordConsent({ employeeId: p.sender.id, noticeHash: p.noticeHash, via: "email", correlationId: p.correlationId });
  } catch (err) {
    if (!(err instanceof ConsentNoticeChangedError)) throw err;
    // They agreed to words that are no longer the notice. Nothing is recorded against text they
    // did not see; the current notice is sent to them instead.
    await p.close("processed", "agreed to an older version of the notice — the current one was sent", { employeeId: p.sender.id, auth: p.auth });
    await requestConsentFromEveryone({ correlationId: p.correlationId, employeeIds: [p.sender.id] });
    return { kind: "consent", emailId: p.emailId, agreed: false };
  }
  await p.close("processed", "agreed to the privacy notice by email", { employeeId: p.sender.id, auth: p.auth });
  await acknowledge({
    emailId: p.emailId, to: p.sender.id, taskId: null,
    title: "Thank you — recorded",
    text:
      "Thank you — your agreement to the privacy notice is recorded.\n\n" +
      "From now on, work given to you can arrive by email. To update a task, reply to its email: write \"done\", a percentage like \"40%\", or what is stopping you.",
    correlationId: p.correlationId,
  });
  return { kind: "consent", emailId: p.emailId, agreed: true };
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
  // A percentage in the reply ("40% done") becomes the task's self-reported progress inside
  // attachNoteAndProcess — the same rule for Telegram, the app and email (TASK-054).
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
  /** The addresses the email went to, other than the inbox and the sender. */
  recipients: readonly string[];
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

  // WHO, decided in code (TASK-054). Every job needs an owner we are CERTAIN of, and the sender
  // must be allowed to give each of them work; otherwise the whole email waits for a person —
  // never half of it assigned and half not.
  const owners = await certainOwners(plan.tasks, p.recipients, p.sender.id);
  const actor = await loadViewer(p.sender.id);
  let directBlocked: string | null = owners.every((o) => o !== null) ? null : "not every job names exactly one person";
  if (!directBlocked && actor) {
    for (const o of owners) {
      if (!(await canAssignTo(actor, o!.id))) { directBlocked = `${o!.name} is outside the people you may give work to`; break; }
    }
  }
  if (!directBlocked) {
    const rl = await checkRateLimit({ key: "assignment", employeeId: p.sender.id });
    if (!rl.allowed) directBlocked = "the hourly assignment limit was reached";
  }
  if (!directBlocked && actor) {
    return assignFromEmail({ ...p, tasks: plan.tasks.map((t, i) => ({ title: t.title, detail: t.detail, owner: owners[i]! })) });
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
      `I read ${tasks.length} task(s) in your email. Nothing has been assigned yet (${directBlocked ?? "it needs a check"}) — confirm them in the dashboard (Assign → From email):\n\n` +
      tasks.map((t, i) => `${i + 1}. ${t.title} → ${owner(t)}`).join("\n") +
      "\n\nNext time, to have it assigned at once: name one person per job as they appear in FreshNow, or send the email TO that person and copy this address.",
    url: "/app/#tasks/assign",
    correlationId: p.correlationId,
  });
  return { kind: "proposal", emailId: p.emailId, proposalId: proposal?.id ?? null, tasks: tasks.length };
}

interface Owner {
  id: string;
  name: string;
  /** How we know: the name as written, the address it was written as, or who the email went to. */
  by: "name" | "address" | "addressed";
}

/**
 * The owner of each job when it is CERTAIN, else null — pure rules over the plan the model read
 * and the email's own headers, never the model's pick alone (D161):
 *   1. the name written fits exactly one person (people-match.ts did this: matchedBy "name");
 *   2. the job names someone by email address, and that address is an active person's;
 *   3. the email went TO exactly one employee, and the job names nobody else — "the email to
 *      Hemanth says fix the chiller" is Hemanth's job.
 * Anything else — two possible people, a nickname only the model recognised, a name nobody has —
 * is uncertain, and the email becomes a proposal.
 */
async function certainOwners(
  tasks: readonly { assignee: { id: string; display_name: string } | null; namedAs: string | null; matchedBy: "name" | "ai" | null }[],
  recipients: readonly string[],
  senderId: string,
): Promise<(Owner | null)[]> {
  const sql = getServiceSql();
  const addressed = recipients.length
    ? await sql<{ id: string; display_name: string; email: string }[]>`
        select id, display_name, lower(email) as email from employee
         where status = 'active' and id <> ${senderId} and lower(email) = any(${[...recipients]})`
    : [];
  const sole = addressed.length === 1 ? addressed[0]! : null;
  const out: (Owner | null)[] = [];
  for (const t of tasks) {
    if (t.assignee && t.matchedBy === "name") {
      out.push({ id: t.assignee.id, name: t.assignee.display_name, by: "name" });
      continue;
    }
    const written = t.namedAs?.trim().toLowerCase() ?? "";
    if (written.includes("@")) {
      const byAddress = (await sql<{ id: string; display_name: string }[]>`
        select id, display_name from employee where status = 'active' and lower(email) = ${emailAddressOf(written)}`)[0];
      out.push(byAddress ? { id: byAddress.id, name: byAddress.display_name, by: "address" } : null);
      continue;
    }
    if (sole) {
      // No name written (the model's own fill-in is the assignee's name), or the name written is
      // the addressed person's: the email's recipient is the owner. Any other name: not certain.
      const noName = !written || (t.assignee !== null && t.matchedBy === "ai" && written === t.assignee.display_name.toLowerCase());
      if (noName || matchPeopleByName(written, [sole]).length === 1) {
        out.push({ id: sole.id, name: sole.display_name, by: "addressed" });
        continue;
      }
    }
    out.push(null);
  }
  return out;
}

/**
 * Assign what an email asked for, the moment every owner is certain — the email channel's equal
 * of naming the person in Telegram. Each task records the email it came from
 * (task.source_email_id) and origin "email"; the assignee is told on their usual channels AND by
 * email when they have an address, so their reply to that email lands on the right task; the
 * sender gets one reply listing what went to whom.
 */
async function assignFromEmail(p: {
  emailId: string;
  correlationId: string;
  sender: Sender;
  subject: string | null;
  auth: Record<string, unknown>;
  close: Close;
  tasks: { title: string; detail: string | null; owner: Owner }[];
}): Promise<InboundEmailOutcome> {
  const provenance = `(from ${p.sender.display_name}'s email${p.subject ? `: ${p.subject.slice(0, 120)}` : ""})`;
  const reach = await reachOf(p.tasks.map((t) => t.owner.id));
  const assigned: { taskId: string; taskKey: string; assignedTo: string; name: string; notified: NotifyChoice[]; held: boolean }[] = [];
  for (const t of p.tasks) {
    const r = reach.get(t.owner.id);
    // Their usual channels, plus email when it can reach them: work given by email should be
    // answerable by email.
    const channels = r ? ([...new Set<NotifyChoice>([...r.usual, ...(r.email.ok ? (["email"] as const) : [])])] as NotifyChoice[]) : undefined;
    const res = await assignTask({
      assignedBy: p.sender.id,
      assignedTo: t.owner.id,
      title: t.title,
      note: t.detail ? `${t.detail}\n\n${provenance}` : provenance,
      correlationId: p.correlationId,
      origin: "email",
      sourceEmailId: p.emailId,
      ...(channels && channels.length ? { channels } : {}),
    });
    assigned.push({ taskId: res.taskId, taskKey: res.taskKey, assignedTo: t.owner.id, name: t.owner.name, notified: res.notified, held: res.heldForConsent });
  }
  await p.close(
    "processed",
    `assigned ${assigned.length} task(s): ${assigned.map((a) => `${a.taskKey} → ${a.name}`).join(", ")}`.slice(0, 300),
    { employeeId: p.sender.id, auth: p.auth, ...(assigned.length === 1 ? { taskId: assigned[0]!.taskId } : {}) },
  );
  await logAudit({
    correlationId: p.correlationId,
    actor: `employee:${p.sender.id}`,
    action: "email.assigned",
    entity: "email_message",
    entityId: p.emailId,
    detail: { tasks: assigned.map((a, i) => ({ taskId: a.taskId, assignedTo: a.assignedTo, ownerBy: p.tasks[i]!.owner.by, notified: a.notified })) },
  });
  const label: Record<NotifyChoice, string> = { telegram: "Telegram", app: "the app", email: "email" };
  await acknowledge({
    emailId: p.emailId,
    to: p.sender.id,
    taskId: null,
    title: `Assigned ${assigned.length} task(s)`,
    text:
      `Assigned from your email:\n\n` +
      assigned
        .map(
          (a, i) =>
            `${i + 1}. ${a.taskKey} ${p.tasks[i]!.title} → ${a.name}` +
            (a.notified.length ? ` (told by ${a.notified.map((c) => label[c]).join(", ")})` : " (no channel could reach them — it is on their list in the app)") +
            (a.held ? ` — waiting: ${a.name} has not agreed to the privacy notice yet, so messages are held until they do` : ""),
        )
        .join("\n") +
      "\n\nEach task is on the dashboard now. Replies they send to the task email are filed against it.",
    url: "/app/#tasks/assign",
    correlationId: p.correlationId,
  });
  return { kind: "assigned", emailId: p.emailId, assigned: assigned.map(({ taskId, taskKey, assignedTo }) => ({ taskId, taskKey, assignedTo })) };
}

/**
 * Answer the sender in the same email thread. A direct reply to their own email, so it goes by
 * email whatever their per-event preferences say — but only if the email channel is live, and
 * the outbox keeps it to one reply per inbound email.
 */
async function acknowledge(p: {
  emailId: string;
  to: string;
  taskId: string | null;
  title: string;
  text: string;
  url?: string;
  correlationId: string;
  /** Part of the consent conversation: the one kind the relay sends before someone has agreed. */
  kind?: "email.ack" | "consent.requested";
}): Promise<void> {
  const sql = getServiceSql();
  const e = (await sql<{ message_id: string; subject: string | null }[]>`select message_id, subject from email_message where id = ${p.emailId}`)[0];
  const subject = e?.subject ? (/^re:/i.test(e.subject) ? e.subject : `Re: ${e.subject}`) : p.title;
  await enqueueNotification({
    idempotencyKey: `email-ack:${p.emailId}`,
    channel: "email",
    recipientEmployeeId: p.to,
    reason: "reply to your email",
    payload: { kind: p.kind ?? "email.ack", title: p.title, text: p.text, subject, inReplyTo: e?.message_id, ...(p.taskId ? { taskId: p.taskId } : {}), ...(p.url ? { url: p.url } : {}) },
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
