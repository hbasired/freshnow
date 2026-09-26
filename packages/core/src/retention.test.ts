import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, getServiceSql } from "./db.js";
import { DEMO_CEO_ID } from "./meta.js";
import { eraseEmployee, retentionDays, retentionSweep } from "./retention.js";

/**
 * Retention ages out WORDS, never counts. Erasure anonymises, never deletes. Both are the
 * PDPL obligations CLAUDE.md lists for Phase 1, and neither existed before 2026-09-18.
 */
const TAG = "RETTEST";
const saved = process.env.RETENTION_DAYS;

async function person(name: string, telegram = 9_900_000_000_001): Promise<string> {
  const id = randomUUID();
  await getServiceSql()`insert into employee (id, display_name, status, telegram_user_id, is_synthetic)
                        values (${id}, ${`${TAG} ${name}`}, 'active', ${telegram}, true)`;
  return id;
}

async function update(employeeId: string, note: string, daysAgo: number): Promise<string> {
  const rows = await getServiceSql()<{ id: string }[]>`
    insert into task_update (employee_id, status, note_raw, note_parsed, channel, submitted_at, is_synthetic)
    values (${employeeId}, 'done', ${note}, ${getServiceSql().json({ is_blocker: false, summary: note } as never)}, 'telegram',
            now() - make_interval(days => ${daysAgo}), true)
    returning id`;
  return rows[0]!.id;
}

afterEach(async () => {
  if (saved === undefined) delete process.env.RETENTION_DAYS;
  else process.env.RETENTION_DAYS = saved;
  const sql = getServiceSql();
  // Children before parents: assignment → task → task_update → employee. The subquery is
  // inlined each time — a postgres.js fragment cannot be spliced as a subquery (G80).
  const tag = `${TAG} %`;
  await sql`delete from assignment
            where assigned_to in (select id from employee where (display_name like ${tag} or display_name = 'Former employee') and is_synthetic)
               or task_id in (select t.id from task t join employee e on e.id = t.employee_id
                              where (e.display_name like ${tag} or e.display_name = 'Former employee') and e.is_synthetic)`;
  await sql`delete from task where employee_id in (select id from employee where (display_name like ${tag} or display_name = 'Former employee') and is_synthetic)`;
  await sql`delete from task_update where employee_id in (select id from employee where (display_name like ${tag} or display_name = 'Former employee') and is_synthetic)`;
  await sql`delete from employee where (display_name like ${tag} or display_name = 'Former employee') and is_synthetic`;
  await sql`delete from audit_log where action in ('retention.notes_aged', 'employee.erased') and created_at > now() - interval '5 minutes'`;
});
afterAll(async () => {
  await closeDb();
});

describe("retention", () => {
  it("does nothing, and says so, until the company has set a window", async () => {
    delete process.env.RETENTION_DAYS;
    expect(retentionDays()).toBeNull();
    const r = await retentionSweep();
    expect(r).toEqual({ enabled: false, days: null, notesAged: 0 });
  });

  it("refuses a window under 30 days — that is not retention, that is losing data", () => {
    process.env.RETENTION_DAYS = "7";
    expect(retentionDays()).toBeNull();
    process.env.RETENTION_DAYS = "nonsense";
    expect(retentionDays()).toBeNull();
  });

  it("ages out the words of old updates and leaves the recent ones, the statuses and the counts", async () => {
    process.env.RETENTION_DAYS = "90";
    const emp = await person("worker");
    const old = await update(emp, "van 2 ka chiller theek nahi hai", 120);
    const recent = await update(emp, "sab theek hai", 10);

    const r = await retentionSweep();
    expect(r.enabled).toBe(true);
    expect(r.notesAged).toBe(1);

    const sql = getServiceSql();
    const rows = await sql<{ id: string; note_raw: string; status: string; note_parsed: Record<string, unknown> }[]>`
      select id, note_raw, status, note_parsed from task_update where id in (${old}, ${recent})`;
    const o = rows.find((x) => x.id === old)!;
    const n = rows.find((x) => x.id === recent)!;
    expect(o.note_raw).toMatch(/redacted/);
    expect(o.note_raw).not.toContain("chiller");
    expect(o.status).toBe("done"); // the operational record stays
    expect(o.note_parsed["redacted"]).toBe(true);
    expect(o.note_parsed["summary"]).toBeUndefined(); // the parsed copy is not a loophole
    expect(n.note_raw).toBe("sab theek hai");

    // Running again ages nothing more, and the audit carries a count, never content.
    expect((await retentionSweep()).notesAged).toBe(0);
    const audit = await sql<{ detail: Record<string, unknown> }[]>`
      select detail from audit_log where action = 'retention.notes_aged' order by created_at desc limit 1`;
    expect(audit[0]?.detail).toMatchObject({ days: 90, count: 1 });
    expect(JSON.stringify(audit[0]?.detail)).not.toContain("chiller");
  });
});

describe("erasure", () => {
  it("anonymises a person — name, Telegram, login, every word — and keeps the record of work", async () => {
    const emp = await person("leaver", 9_900_000_000_002);
    const u = await update(emp, "filler head 3 jammed again", 3);
    const sql = getServiceSql();
    const t = await sql<{ id: string }[]>`insert into task (employee_id, title, status, is_synthetic) values (${emp}, ${`${TAG} task`}, 'done', true) returning id`;
    await sql`insert into assignment (task_id, assigned_by, assigned_to, note, status, is_synthetic)
              values (${t[0]!.id}, ${DEMO_CEO_ID}, ${emp}, 'please do this carefully', 'done', true)`;

    const r = await eraseEmployee({ employeeId: emp, by: DEMO_CEO_ID, reason: "left" });
    expect(r.notesRedacted).toBe(1);
    expect(r.assignmentNotesRedacted).toBe(1);

    const e = await sql<{ display_name: string; telegram_user_id: string | null; auth_user_id: string | null; status: string }[]>`
      select display_name, telegram_user_id, auth_user_id, status from employee where id = ${emp}`;
    expect(e[0]).toEqual({ display_name: "Former employee", telegram_user_id: null, auth_user_id: null, status: "disabled" });

    const words = await sql<{ note_raw: string }[]>`select note_raw from task_update where id = ${u}`;
    expect(words[0]?.note_raw).toBe("[erased]");
    const asg = await sql<{ note: string }[]>`select note from assignment where task_id = ${t[0]!.id}`;
    expect(asg[0]?.note).toBe("[erased]");

    // The row, the task and the update still EXIST — anonymised, not deleted.
    expect((await sql`select 1 from employee where id = ${emp}`).length).toBe(1);
    expect((await sql`select 1 from task where id = ${t[0]!.id}`).length).toBe(1);
    expect((await sql`select 1 from task_update where id = ${u}`).length).toBe(1);

    // Idempotent.
    const again = await eraseEmployee({ employeeId: emp, by: DEMO_CEO_ID, reason: "left" });
    expect(again.notesRedacted).toBe(0);

    const audit = await sql<{ actor: string; detail: Record<string, unknown> }[]>`
      select actor, detail from audit_log where action = 'employee.erased' and entity_id = ${emp} order by created_at limit 1`;
    expect(audit[0]?.actor).toBe(`employee:${DEMO_CEO_ID}`);
    expect(audit[0]?.detail).toMatchObject({ reason: "left", notesRedacted: 1 });
    expect(JSON.stringify(audit[0]?.detail)).not.toContain("filler head");
  });

  it("refuses an employee that does not exist", async () => {
    await expect(eraseEmployee({ employeeId: randomUUID(), by: DEMO_CEO_ID, reason: "request" })).rejects.toThrow(/not found/);
  });
});
