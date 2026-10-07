import { randomUUID } from "node:crypto";
import { logAudit } from "./audit.js";
import { requestConsentFromEveryone } from "./consent.js";
import { getServiceSql } from "./db.js";
import { checkedEmployeeEmail, EmailAddressError } from "./email-people.js";
import { createInvite } from "./invite.js";
import type { AccessRole } from "./db.js";
import { ACCESS_ROLES, ceoEmployeeId } from "./org.js";

/**
 * The CEO adds a person (TASK-054) — name, email, department, role, who they report to — and
 * can give them work straight away, by email if they have no Telegram.
 *
 * Until now a person existed only once they redeemed an invite code in Telegram, so someone
 * without Telegram could never be given work at all. Adding them here creates the same employee
 * row the bot would, and also issues the invite code BOUND to that row: if they later open the
 * bot and paste it, their Telegram attaches to this person instead of creating a second one.
 *
 * Two things this deliberately does not do:
 *   - It does not record consent. Consent is the person's own act (PDPL); the CEO cannot give it
 *     for them. Until they agree, the outbox holds every message to them except the in-app inbox
 *     and the consent request itself — which, for someone with an email address, now goes by
 *     email, and they agree by replying "I AGREE" (email-inbound.ts).
 *   - It does not let anyone be added as CEO. The CEO role changes hands through `updateOrg`, so
 *     there is always exactly one person the system routes to.
 */

export class AddPersonError extends Error {}

export interface AddPersonInput {
  displayName: string;
  email?: string | null;
  department?: string | null;
  roleTitle?: string | null;
  site?: string | null;
  shift?: string | null;
  /** employee (default), manager or lead — never ceo. */
  accessRole?: AccessRole;
  /** Who they report to; the CEO when absent, as an invite redemption does. */
  managerEmployeeId?: string | null;
  /** Also issue a Telegram invite code bound to this person. Default true. */
  telegramInvite?: boolean;
  by: string;
  correlationId?: string;
}

export interface AddPersonResult {
  employeeId: string;
  email: string | null;
  invite: { code: string; expiresAt: string } | null;
  /** Other active people with exactly this name — "assign to Ahmed" will then ask which one. */
  sameName: number;
  /** Whether a privacy-notice email went into the outbox for them now. */
  consentRequested: boolean;
}

const clean = (v: string | null | undefined, max: number): string | null => {
  const t = v?.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
};

export async function addPerson(p: AddPersonInput): Promise<AddPersonResult> {
  const correlationId = p.correlationId ?? randomUUID();
  const name = clean(p.displayName, 120);
  if (!name) throw new AddPersonError("A name is needed.");
  // Every check before any write: a person is added whole or not at all.
  const email = checkedEmployeeEmail(p.email);
  const accessRole = p.accessRole ?? "employee";
  if (!(ACCESS_ROLES as readonly string[]).includes(accessRole) || accessRole === "ceo") {
    throw new AddPersonError("A person can be added as employee, manager or department lead. The CEO role is handed over on the People page.");
  }
  const sql = getServiceSql();
  let manager = p.managerEmployeeId ?? null;
  if (manager) {
    const m = await sql<{ status: string }[]>`select status from employee where id = ${manager}`;
    if (m[0]?.status !== "active") throw new AddPersonError("The manager chosen is not an active person.");
  } else {
    manager = await ceoEmployeeId();
  }

  let employeeId: string;
  try {
    const rows = await sql<{ id: string }[]>`
      insert into employee (display_name, email, department, role_title, site, shift, access_role,
                            manager_employee_id, language, status, is_synthetic)
      values (${name}, ${email}, ${clean(p.department, 60)}, ${clean(p.roleTitle, 120)},
              ${clean(p.site, 120)}, ${clean(p.shift, 60)}, ${accessRole}, ${manager}, 'en', 'active', false)
      returning id`;
    employeeId = rows[0]!.id;
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw new EmailAddressError("That address already belongs to someone else.");
    throw err;
  }

  const invite =
    p.telegramInvite === false
      ? null
      : await createInvite({ displayName: name, issuedBy: p.by, employeeId });

  const same = await sql<{ n: number }[]>`
    select count(*)::int as n from employee
     where status = 'active' and id <> ${employeeId} and lower(display_name) = lower(${name})`;

  // The name is not copied into the append-only log (erasure could never remove it there): the
  // row id, the role and the email DOMAIN say what happened without keeping the personal data.
  await logAudit({
    correlationId,
    actor: `employee:${p.by}`,
    action: "employee.added",
    entity: "employee",
    entityId: employeeId,
    detail: {
      accessRole,
      department: clean(p.department, 60),
      managerEmployeeId: manager,
      hasEmail: email !== null,
      ...(email ? { emailDomain: email.split("@")[1] } : {}),
      telegramInvite: invite !== null,
    },
  });

  // Ask for their agreement now, on every channel that can reach them — for an email-only person
  // that is the notice by email. Idempotent per version of the notice.
  const asked = await requestConsentFromEveryone({ correlationId, employeeIds: [employeeId] });

  return {
    employeeId,
    email,
    invite: invite ? { code: invite.code, expiresAt: invite.expiresAt.toISOString() } : null,
    sameName: same[0]?.n ?? 0,
    consentRequested: asked.enqueued > 0,
  };
}
