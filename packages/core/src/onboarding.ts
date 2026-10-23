import { logAudit } from "./audit.js";
import { CONSENT_POLICY_VERSION, consentNotice, noticeHash } from "./consent.js";
import { getServiceSql } from "./db.js";
import { DEMO_CEO_ID } from "./meta.js";
import { ceoEmployeeId } from "./org.js";

// The consent notice, its hash and the "is it current?" rules live in consent.ts. Re-exported
// here because onboarding is where the bot first shows the notice.
export { CONSENT_POLICY_VERSION, consentNotice, noticeHash } from "./consent.js";

// ── Invite validation & redemption ──────────────────────────────────────────
export interface InviteCheck {
  valid: boolean;
  reason?: "unknown" | "already_used" | "expired";
  displayName?: string;
}

/** Check a code WITHOUT consuming it, so consent can be shown before redeeming. */
export async function validateInvite(code: string): Promise<InviteCheck> {
  const sql = getServiceSql();
  const rows = await sql<
    { display_name: string | null; redeemed_at: Date | null; expires_at: Date | null }[]
  >`select display_name, redeemed_at, expires_at
      from invite_code where code = ${code.trim().toUpperCase()}`;
  const inv = rows[0];
  if (!inv) return { valid: false, reason: "unknown" };
  if (inv.redeemed_at) return { valid: false, reason: "already_used" };
  if (inv.expires_at && inv.expires_at.getTime() < Date.now()) {
    return { valid: false, reason: "expired" };
  }
  return { valid: true, displayName: inv.display_name ?? "New employee" };
}

export interface RedeemResult {
  ok: boolean;
  reason?: string;
  employeeId?: string;
  displayName?: string;
}

/**
 * Redeem a single-use invite: create/link the employee row, bind this Telegram
 * account to it, and record PDPL consent — all in ONE transaction, with the invite
 * row locked, so a double redeem cannot produce two identities.
 *
 * Identity is never self-declared (05-TELEGRAM-DATA-FLOW.md §3): the code is the
 * authorisation gate. Only the descriptive profile is self-filled afterwards.
 */
export async function redeemInvite(
  code: string,
  telegramUserId: bigint | number,
  language = "en",
): Promise<RedeemResult> {
  const sql = getServiceSql();
  const norm = code.trim().toUpperCase();
  const tg = Number(telegramUserId);

  // One Telegram account maps to exactly one employee.
  const existing = await sql<{ id: string }[]>`
    select id from employee where telegram_user_id = ${tg}`;
  if (existing[0]) return { ok: false, reason: "telegram_already_linked" };

  const result = (await sql.begin(async (tx) => {
    const inv = await tx<{ id: string; display_name: string | null; employee_id: string | null }[]>`
      select id, display_name, employee_id from invite_code
      where code = ${norm} and redeemed_at is null
        and (expires_at is null or expires_at > now())
      for update`;
    if (!inv[0]) return { ok: false, reason: "already_used" } as RedeemResult;

    const displayName = inv[0].display_name ?? "New employee";
    let employeeId = inv[0].employee_id;

    if (employeeId) {
      await tx`update employee set telegram_user_id = ${tg}, status = 'active',
                                   language = ${language}
               where id = ${employeeId}`;
    } else {
      // A real person is NOT synthetic — is_synthetic stays false.
      // Reports to the real CEO until somebody sets a manager in the People tab. The
      // seeded id would have parented a real hire to a demo row (audit 2026-09-18).
      const ceoId = await ceoEmployeeId();
      const emp = await tx<{ id: string }[]>`
        insert into employee (display_name, telegram_user_id, manager_employee_id,
                              language, status, is_synthetic)
        values (${displayName}, ${tg}, ${ceoId}, ${language}, 'active', false)
        returning id`;
      employeeId = emp[0]!.id;
    }

    await tx`update invite_code set redeemed_at = now(), employee_id = ${employeeId}
             where id = ${inv[0].id}`;

    const notice = consentNotice(language);
    await tx`insert into consent_record (employee_id, policy_version, notice_hash, is_synthetic)
             values (${employeeId}, ${CONSENT_POLICY_VERSION}, ${noticeHash(notice)}, false)`;

    return { ok: true, employeeId, displayName } as RedeemResult;
  })) as RedeemResult;

  if (result.ok) {
    await logAudit({
      actor: `telegram:${tg}`,
      action: "invite.redeemed",
      entity: "employee",
      entityId: result.employeeId,
      detail: { code: norm, policyVersion: CONSENT_POLICY_VERSION, via: "telegram" },
    });
  }
  return result;
}

// ── Self-filled profile ─────────────────────────────────────────────────────
// The employee answers these themselves — they know their own job. Identity was
// already established by the invite code, so this is descriptive data only.
export const PROFILE_STEPS = ["department", "role_title", "site", "shift"] as const;
export type ProfileStep = (typeof PROFILE_STEPS)[number];
export type ProfileField = ProfileStep | "language";

/**
 * Fields a person may fill in for themselves only while they are blank. Department decides what
 * a department lead sees and who leads a person; site and shift decide who resolves their
 * blockers. "Update my details" rewrote them at will through the service role, past the guard on
 * the employee table (0014) — so once set, they change on the People page (found by the role
 * map, 2026-10-15). Role title and language stay the person's own.
 */
export const SELF_FILL_ONCE: readonly ProfileField[] = ["department", "site", "shift"];

const PROMPTS: Record<ProfileField, string> = {
  department: "Which department do you work in?\n(e.g. production, warehouse, delivery, retail)",
  role_title: "What is your role or job title?\n(e.g. juice production operator, route driver)",
  site: "Which site do you work at?\n(e.g. HQ, warehouse, Deira route)",
  shift: "Which shift do you work?\n(e.g. day, evening, night)",
  language: "Preferred language?",
};

/** The question for one field — numbered ("2/3 · …") when it is part of a run of questions. */
export function profilePrompt(field: ProfileField, position?: { index: number; of: number }): string {
  return position && position.of > 1 ? `${position.index + 1}/${position.of} · ${PROMPTS[field]}` : PROMPTS[field];
}

/** The profile questions this person may still answer: role title always, the others while blank. */
export async function profileStepsFor(employeeId: string): Promise<ProfileStep[]> {
  const row = (await getServiceSql()<{ department: string | null; site: string | null; shift: string | null }[]>`
    select department, site, shift from employee where id = ${employeeId}`)[0];
  const blank = (v: string | null | undefined): boolean => !v || v.trim() === "";
  return PROFILE_STEPS.filter((f) => f === "role_title" || blank(row?.[f]));
}

/**
 * Update one descriptive profile column. The column comes from a fixed whitelist —
 * an SQL identifier is never interpolated from user input. A SELF_FILL_ONCE field that
 * already has a value is left as it is; the result says whether anything changed.
 */
export async function updateProfileField(
  employeeId: string,
  field: ProfileField,
  value: string,
): Promise<{ updated: boolean }> {
  const sql = getServiceSql();
  const v = value.trim().slice(0, 120);
  let count = 0;
  switch (field) {
    case "department":
      count = (await sql`update employee set department = ${v} where id = ${employeeId} and coalesce(btrim(department), '') = ''`).count;
      break;
    case "role_title":
      count = (await sql`update employee set role_title = ${v} where id = ${employeeId}`).count;
      break;
    case "site":
      count = (await sql`update employee set site = ${v} where id = ${employeeId} and coalesce(btrim(site), '') = ''`).count;
      break;
    case "shift":
      count = (await sql`update employee set shift = ${v} where id = ${employeeId} and coalesce(btrim(shift), '') = ''`).count;
      break;
    case "language":
      count = (await sql`update employee set language = ${v} where id = ${employeeId}`).count;
      break;
  }
  if (count === 0) return { updated: false };
  await logAudit({
    actor: `employee:${employeeId}`,
    action: "employee.profile_updated",
    entity: "employee",
    entityId: employeeId,
    detail: { field },
  });
  return { updated: true };
}

/**
 * Bind the CEO's Telegram account to the seeded CEO employee row so routed alerts
 * have a chat to reach. Deterministic: the CEO is whoever matches
 * CEO_TELEGRAM_USER_ID in config — never self-declared.
 * Returns false if that Telegram account already belongs to a different employee.
 */
export async function ensureCeoLinked(telegramUserId: bigint | number): Promise<boolean> {
  const sql = getServiceSql();
  const tg = Number(telegramUserId);
  const clash = await sql<{ id: string }[]>`
    select id from employee where telegram_user_id = ${tg} and id <> ${DEMO_CEO_ID}`;
  if (clash[0]) return false;
  const rows = await sql<{ id: string }[]>`
    update employee set telegram_user_id = ${tg}, status = 'active'
    where id = ${DEMO_CEO_ID}
      and (telegram_user_id is null or telegram_user_id <> ${tg})
    returning id`;
  if (rows[0]) {
    await logAudit({
      actor: `telegram:${tg}`,
      action: "ceo.linked",
      entity: "employee",
      entityId: DEMO_CEO_ID,
    });
  }
  return true;
}

/** The CEO's account cannot be withdrawn: it would lock the company out of its own system. */
export class CeoWithdrawalRefused extends Error {
  constructor() {
    super("The CEO account cannot withdraw — hand the CEO role to someone else first");
    this.name = "CeoWithdrawalRefused";
  }
}

/**
 * Withdraw consent (PDPL). Records the withdrawal; history is retained, not deleted.
 *
 * Refused for the CEO here, in core, so every channel enforces it: the dashboard refused it, but
 * the bot's /withdraw did not — and a disabled CEO row locks the dashboard with no way back in
 * (found by the role map, 2026-10-15).
 */
export async function withdrawConsent(employeeId: string): Promise<void> {
  const sql = getServiceSql();
  const row = (await sql<{ access_role: string }[]>`select access_role from employee where id = ${employeeId}`)[0];
  if (employeeId === DEMO_CEO_ID || row?.access_role === "ceo") throw new CeoWithdrawalRefused();
  await sql`update employee set status = 'disabled' where id = ${employeeId}`;
  await logAudit({
    actor: `employee:${employeeId}`,
    action: "consent.withdrawn",
    entity: "employee",
    entityId: employeeId,
  });
}
