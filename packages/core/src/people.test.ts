import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb, getServiceSql } from "./db.js";
import { DEMO_CEO_ID } from "./meta.js";
import { redeemInvite } from "./onboarding.js";
import { addPerson, AddPersonError } from "./people.js";

/**
 * A person the CEO adds on the dashboard is the SAME person who later joins the bot (TASK-054).
 * The invite code issued with them is bound to their row, so redeeming it links Telegram to that
 * row rather than creating a second employee with the same name — two of them would make every
 * "assign to Farah" ambiguous for ever.
 */

const run = randomUUID().slice(0, 6);
const made: string[] = [];
const tg = 9_820_000_000_000 + Math.floor(Math.random() * 1e5);

afterAll(async () => {
  const sql = getServiceSql();
  await sql`delete from notification_outbox where recipient_employee_id = any(${made})`;
  await sql`delete from consent_record where employee_id = any(${made})`;
  await sql`delete from invite_code where employee_id = any(${made})`;
  await sql`delete from employee where id = any(${made})`;
  await closeDb();
});

describe("addPerson", () => {
  it("joining the bot with the bound invite links Telegram to the same person — no second row", async () => {
    const r = await addPerson({ displayName: `PPLC-${run} Farah`, department: "Retail", by: DEMO_CEO_ID });
    made.push(r.employeeId);
    expect(r.invite).not.toBeNull();
    const sql = getServiceSql();
    const named = async () => (await sql<{ n: number }[]>`select count(*)::int as n from employee where display_name = ${`PPLC-${run} Farah`}`)[0]!.n;
    expect(await named()).toBe(1);

    const red = await redeemInvite(r.invite!.code, tg);
    expect(red).toMatchObject({ ok: true, employeeId: r.employeeId });
    expect(await named()).toBe(1);
    const [row] = await sql<{ telegram_user_id: string; department: string }[]>`select telegram_user_id, department from employee where id = ${r.employeeId}`;
    expect(Number(row!.telegram_user_id)).toBe(tg);
    expect(row!.department).toBe("Retail");
  });

  it("refuses a manager who is not an active person", async () => {
    const sql = getServiceSql();
    const gone = randomUUID();
    await sql`insert into employee (id, display_name, status, is_synthetic) values (${gone}, ${`PPLC-${run} Gone`}, 'disabled', true)`;
    made.push(gone);
    await expect(addPerson({ displayName: `PPLC-${run} Zed`, managerEmployeeId: gone, by: DEMO_CEO_ID })).rejects.toBeInstanceOf(AddPersonError);
    expect((await sql`select 1 from employee where display_name = ${`PPLC-${run} Zed`}`).length).toBe(0);
  });

  it("says when the name is already someone else's, so the CEO can make it unambiguous", async () => {
    const a = await addPerson({ displayName: `PPLC-${run} Omar`, by: DEMO_CEO_ID, telegramInvite: false });
    const b = await addPerson({ displayName: `pplc-${run} omar`, by: DEMO_CEO_ID, telegramInvite: false });
    made.push(a.employeeId, b.employeeId);
    expect(a.sameName).toBe(0);
    expect(b.sameName).toBe(1);
    expect(b.invite).toBeNull();
  });
});
