import { createTransport, type Transporter } from "nodemailer";
import {
  composeOutboundEmail,
  emailAddressAllowed,
  getServiceSql,
  logAudit,
  recordOutboundEmail,
  setNotificationPref,
  type EmailPayload,
} from "@freshnow/core";
import { RateLimitError, type Deliverer } from "./outbox-relay.js";

/**
 * Deliver an outbox row by email.
 *
 * Plain SMTP on purpose, rather than a provider's own SDK: Brevo, Resend, SMTP2GO, Postmark
 * and a company mail server all speak it, so choosing or changing provider is four lines of
 * `.env` and no code. The free tiers (Brevo 300/day) cover this system's volume several
 * times over.
 *
 * Two behaviours worth knowing:
 *
 *   * A HARD BOUNCE TURNS THE CHANNEL OFF FOR THAT PERSON. An address that does not exist
 *     will never exist; retrying it wastes the provider's reputation, which is shared with
 *     every other message we send. The rule is written down in EMAIL-SETUP-GUIDE.md and
 *     implemented here rather than left as advice.
 *   * NO ADDRESS IS NOT AN ERROR. Somebody with the email channel on but no address in
 *     their record is a configuration gap, not a delivery failure — it succeeds silently
 *     rather than retrying five times and being abandoned.
 */

const SEND_TIMEOUT_MS = 20_000;

/** 5xx SMTP codes are permanent: the address is wrong, not the moment. */
function isHardBounce(err: unknown): boolean {
  const code = (err as { responseCode?: number }).responseCode;
  return typeof code === "number" && code >= 500 && code < 600;
}

export function makeEmailSender(transport?: Transporter): Deliverer {
  const host = process.env.SMTP_HOST;
  const from = process.env.EMAIL_FROM;
  // Fail at construction rather than dropping every message quietly at run time.
  if (!host || !from) throw new Error("Email needs SMTP_HOST and EMAIL_FROM — see docs/EMAIL-SETUP-GUIDE.md");

  const mailer =
    transport ??
    createTransport({
      host,
      port: Number(process.env.SMTP_PORT ?? 587),
      // 465 is implicit TLS; 587 starts plain and upgrades with STARTTLS. Both are
      // encrypted in transit — this is not a choice about whether to use TLS.
      secure: Number(process.env.SMTP_PORT ?? 587) === 465,
      ...(process.env.SMTP_USER ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? "" } } : {}),
      connectionTimeout: SEND_TIMEOUT_MS,
      greetingTimeout: SEND_TIMEOUT_MS,
      socketTimeout: SEND_TIMEOUT_MS,
    });

  return async ({ payload, recipientEmployeeId, outboxId, correlationId }) => {
    if (!recipientEmployeeId) throw new Error("email needs a recipient_employee_id");
    const sql = getServiceSql();
    const rows = await sql<{ email: string | null; display_name: string }[]>`
      select email, display_name from employee where id = ${recipientEmployeeId}`;
    const to = rows[0]?.email;
    if (!to) return; // No address on file. Not a failure of this message.
    // The allow-list (EMAIL_ALLOWLIST) is the last word on who may be emailed: an address not on
    // it is never sent to, whatever the database says. Recorded, not retried — retrying cannot
    // make the address allowed.
    if (!emailAddressAllowed(to)) {
      await logAudit({
        correlationId: correlationId ?? undefined,
        actor: "system",
        action: "email.not_allowed",
        entity: "employee",
        entityId: recipientEmployeeId,
        detail: { reason: "recipient address is not on EMAIL_ALLOWLIST" },
      });
      return;
    }

    // Subject with the task key, our own Message-ID, Reply-To the inbox — so a reply finds
    // its task (core/email-outbound.ts).
    const email = await composeOutboundEmail({
      payload: (payload ?? {}) as EmailPayload,
      recipientEmployeeId,
      to,
      fromAddress: from,
      ...(outboxId ? { outboxId } : {}),
    });

    try {
      await mailer.sendMail({
        from,
        to: email.to,
        subject: email.subject,
        // Plain text only. An operations alert is three lines; an HTML template would add a
        // rendering surface, a spam signal and nothing a person reading it would value.
        text: email.text,
        messageId: `<${email.messageId}>`,
        ...(email.inReplyTo ? { inReplyTo: `<${email.inReplyTo}>`, references: email.references.map((r) => `<${r}>`) } : {}),
        ...(email.replyTo ? { replyTo: email.replyTo } : {}),
      });
      // The row a reply is matched against. After the send: a row for an email that never
      // left would route a reply to nothing.
      await recordOutboundEmail({ email, fromAddress: from, recipientEmployeeId, ...(outboxId ? { outboxId } : {}), correlationId: correlationId ?? null });
    } catch (err) {
      if (isHardBounce(err)) {
        // Stop sending to this address, and leave a record of why rather than going quiet.
        await setNotificationPref({
          employeeId: recipientEmployeeId,
          eventType: "blocker.raised",
          channel: "email",
          mode: "off",
        }).catch(() => {});
        return;
      }
      // 421/450/451 are "try later" — back off rather than burning one of five attempts.
      const code = (err as { responseCode?: number }).responseCode;
      if (code === 421 || code === 450 || code === 451) throw new RateLimitError(`SMTP ${code}`);
      throw err;
    }
  };
}
