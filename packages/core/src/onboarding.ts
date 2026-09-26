import { createHash } from "node:crypto";
import { logAudit } from "./audit.js";
import { getServiceSql } from "./db.js";
import { DEMO_CEO_ID } from "./meta.js";
import { ceoEmployeeId } from "./org.js";

// ── PDPL consent ────────────────────────────────────────────────────────────
// UAE Federal Decree-Law No. 45 of 2021 requires a lawful basis, transparency and
// withdrawable consent. We store the policy version AND a hash of the exact notice
// text the person saw, so we can later prove what they agreed to.
export const CONSENT_POLICY_VERSION = "demo-1.0";

const NOTICES: Record<string, string> = {
  en:
    "Before you start — what this bot records:\n\n" +
    "• The daily task status you report (task, status, and your own words).\n" +
    "• Blockers you raise, so they reach the person who can clear them.\n\n" +
    "What it does NOT do:\n" +
    "• No location tracking. No productivity scoring. No sentiment analysis.\n\n" +
    "Your updates are stored in the company database, visible to you and the CEO.\n" +
    "You can withdraw consent at any time with /withdraw.",
  hi:
    "शुरू करने से पहले — यह बॉट क्या रिकॉर्ड करता है:\n\n" +
    "• आपकी दैनिक कार्य स्थिति (कार्य, स्थिति, और आपके अपने शब्द)।\n" +
    "• आपके द्वारा बताई गई रुकावटें, ताकि वे सही व्यक्ति तक पहुँचें।\n\n" +
    "यह क्या नहीं करता:\n" +
    "• लोकेशन ट्रैकिंग नहीं। उत्पादकता स्कोरिंग नहीं। भावना विश्लेषण नहीं।\n\n" +
    "आपके अपडेट कंपनी डेटाबेस में रहते हैं, जो आपको और CEO को दिखते हैं।\n" +
    "आप कभी भी /withdraw से सहमति वापस ले सकते हैं।",
  // UNVERIFIED: the Hindi and Malayalam notices were written here, not by a native
  // speaker. PDPL requires the person to actually understand what they agree to —
  // have both reviewed before showing them to real employees.
  ml:
    "തുടങ്ങുന്നതിന് മുമ്പ് — ഈ ബോട്ട് എന്താണ് രേഖപ്പെടുത്തുന്നത്:\n\n" +
    "• നിങ്ങൾ അറിയിക്കുന്ന ദൈനംദിന ജോലി നില (ജോലി, നില, നിങ്ങളുടെ സ്വന്തം വാക്കുകൾ).\n" +
    "• നിങ്ങൾ പറയുന്ന തടസ്സങ്ങൾ, അവ പരിഹരിക്കാൻ കഴിയുന്ന ആളിലേക്ക് എത്താൻ.\n\n" +
    "ഇത് ചെയ്യാത്തത്:\n" +
    "• ലൊക്കേഷൻ ട്രാക്കിംഗ് ഇല്ല. ഉൽപ്പാദനക്ഷമത സ്കോറിംഗ് ഇല്ല. വികാര വിശകലനം ഇല്ല.\n\n" +
    "നിങ്ങളുടെ അപ്ഡേറ്റുകൾ കമ്പനിയുടെ ഡാറ്റാബേസിൽ സൂക്ഷിക്കുന്നു; നിങ്ങൾക്കും CEO-യ്ക്കും കാണാം.\n" +
    "/withdraw ഉപയോഗിച്ച് എപ്പോൾ വേണമെങ്കിലും സമ്മതം പിൻവലിക്കാം.",
};

export function consentNotice(language = "en"): string {
  return NOTICES[language] ?? NOTICES.en!;
}

/** Hash of the exact notice text shown, so consent stays provable after a re-wording. */
export function noticeHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

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
      detail: { code: norm, policyVersion: CONSENT_POLICY_VERSION },
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

const PROMPTS: Record<ProfileField, string> = {
  department: "1/4 · Which department do you work in?\n(e.g. production, warehouse, delivery, retail)",
  role_title: "2/4 · What is your role or job title?\n(e.g. juice production operator, route driver)",
  site: "3/4 · Which site do you work at?\n(e.g. HQ, warehouse, Deira route)",
  shift: "4/4 · Which shift do you work?\n(e.g. day, evening, night)",
  language: "Preferred language?",
};

export function profilePrompt(field: ProfileField): string {
  return PROMPTS[field];
}

/**
 * Update one descriptive profile column. The column comes from a fixed whitelist —
 * an SQL identifier is never interpolated from user input.
 */
export async function updateProfileField(
  employeeId: string,
  field: ProfileField,
  value: string,
): Promise<void> {
  const sql = getServiceSql();
  const v = value.trim().slice(0, 120);
  switch (field) {
    case "department":
      await sql`update employee set department = ${v} where id = ${employeeId}`;
      break;
    case "role_title":
      await sql`update employee set role_title = ${v} where id = ${employeeId}`;
      break;
    case "site":
      await sql`update employee set site = ${v} where id = ${employeeId}`;
      break;
    case "shift":
      await sql`update employee set shift = ${v} where id = ${employeeId}`;
      break;
    case "language":
      await sql`update employee set language = ${v} where id = ${employeeId}`;
      break;
  }
  await logAudit({
    actor: `employee:${employeeId}`,
    action: "employee.profile_updated",
    entity: "employee",
    entityId: employeeId,
    detail: { field },
  });
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

/** Withdraw consent (PDPL). Records the withdrawal; history is retained, not deleted. */
export async function withdrawConsent(employeeId: string): Promise<void> {
  const sql = getServiceSql();
  await sql`update employee set status = 'disabled' where id = ${employeeId}`;
  await logAudit({
    actor: `employee:${employeeId}`,
    action: "consent.withdrawn",
    entity: "employee",
    entityId: employeeId,
  });
}
