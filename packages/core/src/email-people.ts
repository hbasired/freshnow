import { logAudit } from "./audit.js";
import { getServiceSql } from "./db.js";
import { emailAddressAllowed, emailAllowlist, emailStatus, inboxConfig } from "./email-config.js";
import { formatTaskKey } from "./email-reply.js";

/**
 * Whose email address is whose, and what the email channel has been doing — for the CEO.
 */

export class EmailAddressError extends Error {}

const ADDRESS = /^[^\s@<>"(),;:]+@[^\s@<>"(),;:]+\.[A-Za-z]{2,}$/;

/**
 * Set or clear a person's email address. The CEO's action (checked by the API). Refused when the
 * address is malformed, already someone else's (the unique index), or not on EMAIL_ALLOWLIST —
 * an address the system may never use is not worth storing. Audited without the address itself:
 * the row says that it changed and the domain, not the personal data.
 */
export async function setEmployeeEmail(p: { employeeId: string; email: string | null; by: string; correlationId?: string }): Promise<{ email: string | null }> {
  const email = p.email?.trim().toLowerCase() || null;
  if (email !== null) {
    if (email.length > 254 || !ADDRESS.test(email)) throw new EmailAddressError("That does not look like an email address.");
    if (!emailAddressAllowed(email)) throw new EmailAddressError("That address is not on EMAIL_ALLOWLIST, so the system may not use it.");
  }
  const sql = getServiceSql();
  try {
    const rows = await sql`update employee set email = ${email} where id = ${p.employeeId} returning id`;
    if (rows.length === 0) throw new EmailAddressError("No such person.");
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw new EmailAddressError("That address already belongs to someone else.");
    throw err;
  }
  await logAudit({
    correlationId: p.correlationId,
    actor: `employee:${p.by}`,
    action: email ? "employee.email_set" : "employee.email_cleared",
    entity: "employee",
    entityId: p.employeeId,
    detail: email ? { domain: email.split("@")[1] } : {},
  });
  return { email };
}

export interface EmailOverview {
  sending: boolean;
  receiving: boolean;
  inboxAddress: string | null;
  /** The allow-list, for the CEO only. Null = none set. */
  allowlist: string[] | null;
  lastPoll: { at: string; ok: boolean; detail: Record<string, unknown> | null } | null;
  people: { id: string; name: string; email: string | null }[];
  recent: {
    id: string;
    direction: "in" | "out";
    at: string;
    counterpart: string;
    subject: string | null;
    status: string;
    reason: string | null;
    taskKey: string | null;
  }[];
}

/** The CEO's email screen. Bounded: the last 30 emails, active people only. */
export async function emailOverview(): Promise<EmailOverview> {
  const sql = getServiceSql();
  const s = emailStatus();
  const allow = emailAllowlist();
  const poll = (await sql<{ finished_at: Date; status: string; detail: Record<string, unknown> | null }[]>`
    select finished_at, status, detail from job_run where job_name = 'email_poll' order by created_at desc limit 1`)[0];
  const people = await sql<{ id: string; display_name: string; email: string | null }[]>`
    select id, display_name, email from employee where status = 'active' order by is_synthetic, display_name limit 500`;
  const recent = await sql<{ id: string; direction: "in" | "out"; created_at: Date; from_address: string; to_address: string; subject: string | null; status: string; reason: string | null; task_number: string | null }[]>`
    select m.id, m.direction, m.created_at, m.from_address, m.to_address, m.subject, m.status, m.reason, t.task_number::text
      from email_message m left join task t on t.id = m.task_id
     order by m.created_at desc limit 30`;
  return {
    sending: s.sending,
    receiving: s.receiving,
    inboxAddress: inboxConfig()?.inboxAddress ?? null,
    allowlist: allow ? [...allow] : null,
    lastPoll: poll ? { at: poll.finished_at.toISOString(), ok: poll.status === "ok", detail: poll.detail } : null,
    people: people.map((p) => ({ id: p.id, name: p.display_name, email: p.email })),
    recent: recent.map((r) => ({
      id: r.id,
      direction: r.direction,
      at: r.created_at.toISOString(),
      counterpart: r.direction === "in" ? r.from_address : r.to_address,
      subject: r.subject,
      status: r.status,
      reason: r.reason,
      taskKey: r.task_number ? formatTaskKey(r.task_number) : null,
    })),
  };
}

/** For /health — public, so no addresses: whether email works and when the inbox was last read. */
export async function emailHealth(): Promise<{ sending: boolean; receiving: boolean; lastPollAt: string | null; lastPollOk: boolean | null }> {
  const s = emailStatus();
  if (!s.receiving) return { sending: s.sending, receiving: false, lastPollAt: null, lastPollOk: null };
  const poll = (await getServiceSql()<{ finished_at: Date; status: string }[]>`
    select finished_at, status from job_run where job_name = 'email_poll' order by created_at desc limit 1`.catch(() => []))[0];
  return { sending: s.sending, receiving: true, lastPollAt: poll?.finished_at.toISOString() ?? null, lastPollOk: poll ? poll.status === "ok" : null };
}
