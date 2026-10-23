import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDb, getServiceSql, withContext } from "../db.js";
import { DEMO_CEO_ID } from "../meta.js";
import { answerQuestion, planReach } from "./answer.js";

const CORR = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const empId = randomUUID();

function fakeResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

// The NL→SQL prompt contains "translate"; the narration prompt does not — so the
// stub returns the canned SQL for the first call and the canned answer for the second.
function stubLlm(sqlText: string, answerText: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as { messages: { content: string }[] };
      const sys = body.messages[0]?.content ?? "";
      const content = sys.includes("translate") ? JSON.stringify({ sql: sqlText }) : JSON.stringify({ answer: answerText });
      return fakeResponse({ choices: [{ message: { content } }], usage: { prompt_tokens: 5, completion_tokens: 5 } });
    }),
  );
}

const COUNT_SQL = `select count(*)::int as n from blocker where category='equipment' and correlation_id='${CORR}'`;

beforeAll(async () => {
  const sql = getServiceSql();
  await sql`insert into employee (id, display_name, status, is_synthetic) values (${empId}, 'QTEST', 'active', true)`;
  await sql`insert into blocker (raised_by, category, severity, correlation_id, is_synthetic) values
    (${empId}, 'equipment', 'high', ${CORR}, true),
    (${empId}, 'equipment', 'critical', ${CORR}, true),
    (${empId}, 'supply', 'low', ${CORR}, true)`;
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  const sql = getServiceSql();
  await sql`delete from blocker where correlation_id = ${CORR}`;
  await sql`delete from employee where id = ${empId}`;
  await sql`delete from llm_call where correlation_id = ${CORR}`;
  await sql`delete from audit_log where correlation_id = ${CORR} and action = 'query.scope_refused'`;
  await closeDb();
});

describe("answerQuestion", () => {
  it("translates → executes → narrates → passes the numeric gate", async () => {
    stubLlm(COUNT_SQL, "There are 2 equipment blockers.");
    const r = await answerQuestion("how many equipment blockers?", CORR);
    expect(r.abstained).toBe(false);
    expect(r.gate.numericSanity).toBe(true);
    expect(r.rowCount).toBe(1);
    expect(r.sql).toContain("count(*)");
    expect(r.answer).toContain("2");
  });

  it("abstains when the narration invents a number (gate fails), but still shows the SQL", async () => {
    stubLlm(COUNT_SQL, "There are 9 equipment blockers.");
    const r = await answerQuestion("how many equipment blockers?", CORR);
    expect(r.gate.numericSanity).toBe(false);
    expect(r.abstained).toBe(true);
    expect(r.sql).toContain("count(*)");
  });

  it("rejects non-read-only SQL and abstains with no SQL", async () => {
    stubLlm("delete from blocker", "done");
    const r = await answerQuestion("delete everything", CORR);
    expect(r.abstained).toBe(true);
    expect(r.sql).toBeNull();
  });

  // The CEO's row-level security reads sign-ins and the audit trail; the question box must not —
  // "when did X sign in each day" would be an attendance report (privacy notice 3.0). However the
  // table is reached — directly, through a CTE, a subquery or a join — Postgres's plan names it.
  it.each([
    ["directly", "select employee_id, created_at from app_session"],
    ["through a CTE", "with s as (select * from audit_log where action = 'app.signed_in') select count(*) from s"],
    ["in a subquery", "select display_name from employee e where exists (select 1 from app_credential c where c.employee_id = e.id)"],
    ["in a join", "select e.display_name, c.consented_at from employee e join consent_record c on c.employee_id = e.id"],
  ])("refuses a table outside the approved set, reached %s — and records the refusal", async (_how, sqlText) => {
    stubLlm(sqlText, "There are 3.");
    const r = await answerQuestion("when did people sign in this week?", CORR);
    expect(r.abstained).toBe(true);
    expect(r.answer).toMatch(/not allowed to read/);
    const [audit] = await getServiceSql()<{ detail: { tables: string[] } }[]>`
      select detail from audit_log where action = 'query.scope_refused' and correlation_id = ${CORR} order by created_at desc limit 1`;
    expect(audit?.detail.tables.some((t) => /^public\.(app_session|audit_log|app_credential|consent_record)$/.test(t))).toBe(true);
  });

  // A function that reads a table by name, or runs SQL text, hides that table from the plan's tables
  // (review 2026-10-17, todays-fixes#1). Refused before anything runs.
  it.each([
    ["query_to_xml", "select query_to_xml('select * from app_session', true, false, '')"],
    ["table_to_xml", "select table_to_xml('app_credential', true, false, '')"],
    ["ts_stat", "select * from ts_stat('select to_tsvector(note_raw) from task_update')"],
    ["a Unicode-escaped name", `select U&"\\0071uery_to_xml"('select 1', true, false, '')`],
  ])("refuses SQL that reads through %s", async (_how, sqlText) => {
    stubLlm(sqlText, "Here they are.");
    const r = await answerQuestion("show me the sessions", CORR);
    expect(r.abstained).toBe(true);
    expect(r.sql).toBeNull();
  });

  it("finds such a function in the plan itself, however the query spelled it", async () => {
    const reach = await withContext({ employeeId: DEMO_CEO_ID, isCeo: true }, (tx) =>
      planReach(tx, `select U&"\\0071uery_to_xml"('select 1', true, false, '')`), { readOnly: true });
    expect(reach.functions).toContain("query_to_xml");
    const clean = await withContext({ employeeId: DEMO_CEO_ID, isCeo: true }, (tx) => planReach(tx, "select count(*) from blocker"), { readOnly: true });
    expect(clean).toEqual({ tables: ["public.blocker"], functions: [] });
  });

  it("still answers over the approved tables, joins included", async () => {
    stubLlm(
      `select count(*)::int as n from blocker b join employee e on e.id = b.raised_by where b.correlation_id = '${CORR}' and b.category = 'equipment'`,
      "There are 2 equipment blockers.",
    );
    const r = await answerQuestion("how many equipment blockers, by who raised them?", CORR);
    expect(r.abstained).toBe(false);
    expect(r.answer).toContain("2");
  });
});
