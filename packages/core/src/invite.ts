import { randomInt } from "node:crypto";
import { getServiceSql } from "./db.js";
import { DEMO_CEO_ID } from "./meta.js";

// Unambiguous alphabet — no 0/O/1/I/L, since people read codes off a screen.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** A single-use invite code, e.g. "K7M2QXAB". Not a secret token — short and readable. */
export function generateInviteCode(length = 8): string {
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export interface CreatedInvite {
  code: string;
  expiresAt: Date;
}

/**
 * Create a single-use invite the CEO hands to a real person. Identity is never
 * self-declared (05-TELEGRAM-DATA-FLOW.md §3); after redeeming the code the
 * employee self-fills only their descriptive profile.
 */
export async function createInvite(params: {
  displayName: string;
  issuedBy?: string;
  ttlHours?: number;
  /** Only true for seeded demo fixtures. A code the CEO issues for a real person is real. */
  isSynthetic?: boolean;
  /**
   * The person this code is for, when they already exist (added on the dashboard). Redeeming it
   * then links Telegram to THIS row (onboarding.ts) instead of creating a second person.
   */
  employeeId?: string;
}): Promise<CreatedInvite> {
  const sql = getServiceSql();
  const code = generateInviteCode();
  const ttlHours = params.ttlHours ?? 72;
  const rows = await sql<{ expires_at: Date }[]>`
    insert into invite_code (code, display_name, issued_by, expires_at, is_synthetic, employee_id)
    values (${code}, ${params.displayName}, ${params.issuedBy ?? DEMO_CEO_ID},
            now() + make_interval(hours => ${ttlHours}), ${params.isSynthetic ?? false},
            ${params.employeeId ?? null})
    returning expires_at`;
  return { code, expiresAt: rows[0]!.expires_at };
}
