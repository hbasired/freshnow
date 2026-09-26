import { afterAll, describe, expect, it } from "vitest";
import { closeDb, getServiceSql } from "./db.js";
import { createInvite } from "./invite.js";
import { DEMO_CEO_ID } from "./meta.js";
import {
  CONSENT_POLICY_VERSION,
  consentNotice,
  ensureCeoLinked,
  noticeHash,
  redeemInvite,
  updateProfileField,
  validateInvite,
} from "./onboarding.js";

// Distinct Telegram ids per test — the column is UNIQUE and the test DB is shared.
let seq = 0;
const nextTg = (): number => 9_100_000_000_000 + seq++ * 7919 + Math.floor(Math.random() * 500);

afterAll(async () => {
  await closeDb();
});

describe("invite validation (does not consume the code)", () => {
  it("rejects an unknown code", async () => {
    expect(await validateInvite("ZZZZZZZZ")).toMatchObject({ valid: false, reason: "unknown" });
  });

  it("accepts a fresh code and reports who it is for", async () => {
    const inv = await createInvite({ displayName: "Test Person" });
    const check = await validateInvite(inv.code);
    expect(check.valid).toBe(true);
    expect(check.displayName).toBe("Test Person");
    // Checking must NOT redeem it — consent is shown before the code is consumed.
    const sql = getServiceSql();
    const row = await sql`select redeemed_at from invite_code where code = ${inv.code}`;
    expect(row[0]?.redeemed_at).toBeNull();
  });

  it("rejects an expired code", async () => {
    const inv = await createInvite({ displayName: "Expired", ttlHours: -1 });
    expect(await validateInvite(inv.code)).toMatchObject({ valid: false, reason: "expired" });
  });
});

describe("redeemInvite", () => {
  it("links the account, creates the employee, and records PDPL consent", async () => {
    const inv = await createInvite({ displayName: "Ravi Kumar" });
    const tg = nextTg();
    const res = await redeemInvite(inv.code, tg, "en");
    expect(res.ok).toBe(true);

    const sql = getServiceSql();
    const emp = await sql`
      select display_name, telegram_user_id, status, is_synthetic, manager_employee_id
      from employee where id = ${res.employeeId!}`;
    expect(emp[0]?.display_name).toBe("Ravi Kumar");
    expect(Number(emp[0]?.telegram_user_id)).toBe(tg);
    expect(emp[0]?.status).toBe("active");
    // A real person is NOT demo data.
    expect(emp[0]?.is_synthetic).toBe(false);
    expect(emp[0]?.manager_employee_id).toBe(DEMO_CEO_ID);

    // Consent proves WHAT they agreed to, not just that they agreed.
    const consent = await sql`
      select policy_version, notice_hash from consent_record where employee_id = ${res.employeeId!}`;
    expect(consent[0]?.policy_version).toBe(CONSENT_POLICY_VERSION);
    expect(consent[0]?.notice_hash).toBe(noticeHash(consentNotice("en")));

    const used = await sql`select redeemed_at, employee_id from invite_code where code = ${inv.code}`;
    expect(used[0]?.redeemed_at).not.toBeNull();
    expect(used[0]?.employee_id).toBe(res.employeeId);
  });

  it("refuses to redeem the same code twice", async () => {
    const inv = await createInvite({ displayName: "Once Only" });
    expect((await redeemInvite(inv.code, nextTg())).ok).toBe(true);
    expect((await redeemInvite(inv.code, nextTg())).ok).toBe(false);
  });

  it("refuses to bind one Telegram account to two employees", async () => {
    const tg = nextTg();
    const first = await createInvite({ displayName: "First" });
    expect((await redeemInvite(first.code, tg)).ok).toBe(true);

    const second = await createInvite({ displayName: "Second" });
    expect(await redeemInvite(second.code, tg)).toMatchObject({
      ok: false,
      reason: "telegram_already_linked",
    });
  });

  it("refuses an expired code even if the caller skips validation", async () => {
    const inv = await createInvite({ displayName: "Stale", ttlHours: -1 });
    expect((await redeemInvite(inv.code, nextTg())).ok).toBe(false);
  });
});

describe("self-filled profile and CEO linking", () => {
  it("writes whitelisted profile columns only", async () => {
    const inv = await createInvite({ displayName: "Profile Person" });
    const res = await redeemInvite(inv.code, nextTg());
    await updateProfileField(res.employeeId!, "department", "production");
    await updateProfileField(res.employeeId!, "shift", "day");

    const sql = getServiceSql();
    const rows = await sql`select department, shift from employee where id = ${res.employeeId!}`;
    expect(rows[0]).toMatchObject({ department: "production", shift: "day" });
  });

  it("binds the CEO's Telegram account to the seeded CEO row", async () => {
    const tg = nextTg();
    expect(await ensureCeoLinked(tg)).toBe(true);
    const sql = getServiceSql();
    const rows = await sql`select telegram_user_id from employee where id = ${DEMO_CEO_ID}`;
    expect(Number(rows[0]?.telegram_user_id)).toBe(tg);
  });

  it("will not steal a Telegram account that already belongs to an employee", async () => {
    const inv = await createInvite({ displayName: "Not The CEO" });
    const tg = nextTg();
    expect((await redeemInvite(inv.code, tg)).ok).toBe(true);
    expect(await ensureCeoLinked(tg)).toBe(false);
  });
});
