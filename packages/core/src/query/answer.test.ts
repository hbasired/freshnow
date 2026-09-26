import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDb, getServiceSql } from "../db.js";
import { answerQuestion } from "./answer.js";

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
});
