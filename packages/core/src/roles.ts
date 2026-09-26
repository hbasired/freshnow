import type { AccessRole } from "./db.js";

/**
 * What a person may do in the bot. Three values, because the bot has three menus:
 *
 *   ceo       everything — blockers for everyone, assign to anyone, invites, documents
 *   manager   their team — blockers raised by their reports, assign to their reports
 *   employee  their own work
 *
 * "manager" here covers both `access_role = 'manager'` and `'lead'`; the DIFFERENCE between
 * those two (a lead also sees their department) is decided by `canAssignTo` and the RLS
 * predicate, never by this string. The bot asks "may I show the assign button?" with this
 * and "may this person assign to THAT person?" with `canAssignTo`, every time.
 */
export type Role = "ceo" | "manager" | "employee";

/**
 * Deterministic role resolution from Telegram identity: the CEO is exactly the configured
 * Telegram id; everyone else is an employee. The bigint compare avoids 32-bit truncation
 * (two ids can differ only beyond the int32 boundary). No model call — roles are a
 * lookup, per the SPEC determinism rules.
 */
export function resolveRole(userId: bigint, ceoUserId: bigint): Role {
  return userId === ceoUserId ? "ceo" : "employee";
}

/**
 * The bot's role for a linked person, from BOTH sources of identity:
 *
 *   * the configured Telegram id (the anchor — the CEO's account is never a self-declared
 *     fact, and it works before any employee row exists), and
 *   * the employee row's `access_role`, which is what the dashboard's People tab sets and
 *     what RLS enforces.
 *
 * A row the CEO has made `ceo` is the CEO in the bot too, so the two channels agree
 * (A-T38.1 was the state before this). `manager` and `lead` both get the manager menu.
 * An unlinked person has no row and is an employee until they register.
 */
export function botRole(isConfigCeo: boolean, accessRole: AccessRole | null | undefined): Role {
  if (isConfigCeo || accessRole === "ceo") return "ceo";
  if (accessRole === "manager" || accessRole === "lead") return "manager";
  return "employee";
}
