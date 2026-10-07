import { randomBytes } from "node:crypto";
import { getServiceSql } from "./db.js";
import { replyToAddress } from "./email-config.js";
import { emailAddressOf, formatTaskKey } from "./email-reply.js";

/**
 * Composing an outbound email so its reply can find its way back.
 *
 * Three things make a reply routable, all borrowed from how Jira does it: the task key in the
 * subject ("[FN-42] New task for you: Fix the van 2 chiller"), a Message-ID we choose and record
 * (a reply carries it back in In-Reply-To), and a Reply-To pointing at the inbox the worker
 * reads. The Message-ID is derived from the outbox row, so a retried send reuses it and is
 * recorded once.
 */

export interface EmailPayload {
  title?: string;
  text?: string;
  url?: string;
  kind?: string;
  taskId?: string;
  assignmentId?: string;
  /** For a reply we send (an acknowledgement): the Message-ID and subject being answered. */
  inReplyTo?: string;
  subject?: string;
}

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  replyTo: string | null;
  taskId: string | null;
  assignmentId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function taskIdOf(p: EmailPayload): string | null {
  if (p.taskId && UUID.test(p.taskId)) return p.taskId;
  const m = /[?&]task=([0-9a-f-]{36})/i.exec(p.url ?? "");
  return m && UUID.test(m[1]!) ? m[1]! : null;
}

const oneLine = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max);

export async function composeOutboundEmail(p: {
  payload: EmailPayload;
  recipientEmployeeId: string;
  to: string;
  fromAddress: string;
  outboxId?: string;
  publicUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<OutboundEmail> {
  const env = p.env ?? process.env;
  const sql = getServiceSql();
  const taskId = taskIdOf(p.payload);
  const task = taskId
    ? (await sql<{ task_number: string; title: string; employee_id: string }[]>`
        select task_number::text, title, employee_id from task where id = ${taskId}`)[0] ?? null
    : null;
  const role = (await sql<{ access_role: string }[]>`select access_role from employee where id = ${p.recipientEmployeeId}`)[0]?.access_role ?? "employee";
  const replyTo = replyToAddress(env);
  const key = task ? formatTaskKey(task.task_number) : null;

  const heading = p.payload.title?.trim() || "FreshNow";
  const subject = oneLine(
    p.payload.subject ??
      (key && task ? `[${key}] ${heading}: ${task.title}` : heading),
    200,
  );

  const link = p.payload.url ? `\n\n${new URL(p.payload.url, p.publicUrl ?? env.PUBLIC_URL ?? "http://localhost:3001").toString()}` : "";
  // How to answer — only what this person can actually do by email.
  let footer = "";
  if (p.payload.kind === "consent.requested") {
    // The notice is the whole message; anything added under it would read as part of it.
    footer = "";
  } else if (replyTo && task && key && task.employee_id === p.recipientEmployeeId) {
    footer = `\n\n— Reply to this email to update ${key}: write "done", a percentage like "40%", or what is stopping you. Your reply goes straight into FreshNow.`;
  } else if (replyTo && role !== "employee" && !p.payload.inReplyTo) {
    footer =
      `\n\n— To give work by email, write to ${replyTo} (or copy it on an email to the person), one line per job, naming the person` +
      ` ("Rashid: restock the Marina machine"). When every job names exactly one person you may assign to, it is assigned at once` +
      ` and they are told; otherwise it waits for you in the dashboard (Assign → From email).`;
  }

  const domain = emailAddressOf(p.fromAddress).split("@")[1] || "freshnow.local";
  const id = p.outboxId && UUID.test(p.outboxId) ? p.outboxId : randomBytes(12).toString("hex");
  const inReplyTo = p.payload.inReplyTo?.trim() || null;

  return {
    to: p.to.trim().toLowerCase(),
    subject,
    text: `${p.payload.text ?? ""}${link}${footer}\n\n— FreshNow Operations`,
    messageId: `fn.${id}@${domain}`,
    inReplyTo,
    references: inReplyTo ? [inReplyTo] : [],
    replyTo,
    taskId: task ? taskId : null,
    assignmentId: p.payload.assignmentId && UUID.test(p.payload.assignmentId) ? p.payload.assignmentId : null,
  };
}

/** Record a sent email, once — the row a reply's In-Reply-To is matched against. */
export async function recordOutboundEmail(p: {
  email: OutboundEmail;
  fromAddress: string;
  recipientEmployeeId: string;
  outboxId?: string;
  correlationId?: string | null;
  isSynthetic?: boolean;
}): Promise<void> {
  const sql = getServiceSql();
  await sql`
    insert into email_message
      (direction, message_id, in_reply_to, thread_refs, from_address, to_address, subject,
       employee_id, task_id, assignment_id, outbox_id, status, correlation_id, sent_at, is_synthetic)
    values ('out', ${p.email.messageId}, ${p.email.inReplyTo}, ${p.email.references},
            ${emailAddressOf(p.fromAddress)}, ${p.email.to}, ${p.email.subject},
            ${p.recipientEmployeeId}, ${p.email.taskId}, ${p.email.assignmentId},
            ${p.outboxId && UUID.test(p.outboxId) ? p.outboxId : null}, 'sent',
            ${p.correlationId ?? null}, now(), ${p.isSynthetic ?? false})
    on conflict (direction, message_id) do nothing`;
}
