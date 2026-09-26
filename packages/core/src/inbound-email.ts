import { timingSafeEqual } from "node:crypto";
import { logAudit } from "./audit.js";
import { getServiceSql } from "./db.js";

/**
 * Turning an email into a PROPOSAL of tasks.
 *
 * This is the only path in the system where something outside the company can cause a
 * write, which makes it the most dangerous file here. Anyone can put any address in a
 * `From:` header, so the question "did this really come from the CEO?" cannot be answered
 * by reading the message — only by the receiving mail server's SPF, DKIM and DMARC checks,
 * which is why those verdicts are required and a failure is refused outright.
 *
 * Four gates, in order, cheapest first:
 *
 *   1. A shared secret, compared in constant time. Stops the internet at large.
 *   2. SPF / DKIM / DMARC verdicts from the receiving edge. Stops forgery.
 *   3. A sender allowlist: the address must belong to an active employee who may give work.
 *      Stops a real but unauthorised sender.
 *   4. Auto-reply headers dropped, so an out-of-office never becomes a task.
 *
 * And then: it produces a PROPOSAL a human confirms in the dashboard. Even having passed
 * all four gates, an email never silently creates work — the same rule as the PDF flow.
 */

export interface InboundEmail {
  from: string;
  to?: string | null;
  subject?: string | null;
  text: string;
  /** The receiving edge's verdicts. Anything other than "pass" is refused. */
  spf?: string | null;
  dkim?: string | null;
  dmarc?: string | null;
  /** Raw headers we check for auto-replies, lower-cased keys. */
  headers?: Record<string, string> | undefined;
}

export type InboundVerdict =
  | { accepted: false; reason: string; status: number }
  | { accepted: true; senderEmployeeId: string; senderName: string; text: string };

/** Constant-time secret compare — the same shape the Telegram webhook uses. */
export function secretMatches(supplied: string | undefined, expected: string): boolean {
  if (!supplied) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** `"Name <a@b.c>"` → `a@b.c`, lower-cased. */
export function addressOf(from: string): string {
  const m = /<([^>]+)>/.exec(from);
  return (m?.[1] ?? from).trim().toLowerCase();
}

/**
 * Is this message allowed to create work? Returns the reason when not, so the caller can
 * audit it — a refused email should leave a trace, or a misconfigured sender looks like
 * silence.
 */
export async function screenInboundEmail(mail: InboundEmail, correlationId?: string): Promise<InboundVerdict> {
  const refuse = async (reason: string, status: number): Promise<InboundVerdict> => {
    await logAudit({
      correlationId,
      actor: "system",
      action: "inbound_email.refused",
      entity: "employee",
      entityId: addressOf(mail.from),
      // The address and the reason. Never the body: a refused message is often exactly the
      // one whose contents should not be stored.
      detail: { reason, from: addressOf(mail.from), spf: mail.spf ?? null, dkim: mail.dkim ?? null, dmarc: mail.dmarc ?? null },
    }).catch(() => {});
    return { accepted: false, reason, status };
  };

  // Gate 2 — authentication of the sending domain. Missing is treated as failing: an edge
  // that did not check is not evidence that the message is genuine.
  const ok = (v: string | null | undefined) => (v ?? "").toLowerCase() === "pass";
  if (!ok(mail.spf) || !ok(mail.dkim) || !ok(mail.dmarc)) {
    return refuse("SPF, DKIM and DMARC must all pass — inbound email is otherwise a spoofable write path", 403);
  }

  // Gate 4 — machines talking to machines. Cheap, and catches the common accident.
  const h = mail.headers ?? {};
  if (h["auto-submitted"] && h["auto-submitted"].toLowerCase() !== "no") {
    return refuse("auto-submitted message", 202);
  }
  if (["bulk", "junk", "list"].includes((h["precedence"] ?? "").toLowerCase())) {
    return refuse("bulk or automated message", 202);
  }

  // Gate 3 — a real person who may give work. An ordinary employee cannot create tasks for
  // others in the dashboard either, so they cannot by email.
  const sql = getServiceSql();
  const rows = await sql<{ id: string; display_name: string; access_role: string; status: string }[]>`
    select id, display_name, access_role, status from employee
    where lower(email) = ${addressOf(mail.from)}`;
  const sender = rows[0];
  if (!sender) return refuse("no active employee has that email address", 403);
  if (sender.status !== "active") return refuse("that person's account is not active", 403);
  if (sender.access_role === "employee") return refuse("only a manager, lead or the CEO may assign work by email", 403);

  return { accepted: true, senderEmployeeId: sender.id, senderName: sender.display_name, text: mail.text };
}

/**
 * Store the message before anything interprets it. The same rule as a Telegram update: an
 * employee's words must survive the model being slow, wrong or unavailable, so they are on
 * disk first and parsed second.
 */
export async function recordInboundEmail(p: {
  from: string;
  subject: string | null;
  text: string;
  senderEmployeeId: string | null;
  correlationId?: string;
}): Promise<void> {
  await logAudit({
    correlationId: p.correlationId,
    actor: p.senderEmployeeId ? `employee:${p.senderEmployeeId}` : "system",
    action: "inbound_email.received",
    entity: "employee",
    entityId: p.senderEmployeeId ?? addressOf(p.from),
    // The subject and a length, not the body. The body becomes a task proposal the CEO
    // sees; copying it into the audit log would duplicate personal data for no purpose.
    detail: { from: addressOf(p.from), subject: p.subject ?? null, chars: p.text.length },
  });
}
