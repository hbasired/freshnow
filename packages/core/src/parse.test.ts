import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { closeDb, getServiceSql } from "./db.js";
import { parseTaskUpdate } from "./parse.js";

// Pipeline tests use a STUBBED fetch (deterministic). A gated live test below
// measures real English + Hindi extraction (run with RUN_LLM_LIVE=1).
const CORR = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function fakeResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}
function completion(content: string): unknown {
  return { choices: [{ message: { content } }], usage: { prompt_tokens: 20, completion_tokens: 20 } };
}

async function makeUpdate(noteRaw: string): Promise<{ empId: string; updId: string }> {
  const sql = getServiceSql();
  const empId = randomUUID();
  const updId = randomUUID();
  await sql`insert into employee (id, display_name, status, is_synthetic)
            values (${empId}, 'PARSETEST', 'active', true)`;
  await sql`insert into task_update (id, employee_id, status, note_raw, correlation_id, is_synthetic)
            values (${updId}, ${empId}, 'blocker', ${noteRaw}, ${CORR}, true)`;
  return { empId, updId };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  const sql = getServiceSql();
  await sql`delete from blocker where correlation_id = ${CORR}`;
  await sql`delete from task_update where correlation_id = ${CORR}`;
  await sql`delete from employee where display_name = 'PARSETEST'`;
  await sql`delete from llm_call where correlation_id = ${CORR}`;
});
afterAll(async () => {
  await closeDb();
});

describe("parseTaskUpdate", () => {
  it("creates a blocker from a parsed update and writes note_parsed", async () => {
    const { updId } = await makeUpdate("chiller in van 2 not holding temp, juice at risk");
    const content = JSON.stringify({
      is_blocker: true,
      category: "equipment",
      severity: "high",
      affected_asset: "van 2 chiller",
      risk: "cold chain / spoilage",
      summary: "Van 2 chiller not holding temperature",
    });
    vi.stubGlobal("fetch", vi.fn(async () => fakeResponse(completion(content))));

    const res = await parseTaskUpdate(updId, CORR);
    expect(res.needsReview).toBe(false);
    expect(res.blockerId).toBeTruthy();

    const sql = getServiceSql();
    const b = await sql`select category, severity, is_synthetic from blocker where id = ${res.blockerId!}`;
    expect(b[0]?.category).toBe("equipment");
    expect(b[0]?.severity).toBe("high");
    expect(b[0]?.is_synthetic).toBe(true); // inherited from the synthetic update
  });

  it("flags needs_review and creates no blocker when extraction fails", async () => {
    const { updId } = await makeUpdate("garbled input");
    vi.stubGlobal("fetch", vi.fn(async () => fakeResponse(completion("not json at all"))));

    const res = await parseTaskUpdate(updId, CORR);
    expect(res.needsReview).toBe(true);
    expect(res.blockerId).toBeUndefined();

    const sql = getServiceSql();
    const upd = await sql`select note_parsed from task_update where id = ${updId}`;
    expect((upd[0]?.note_parsed as { needs_review?: boolean }).needs_review).toBe(true);
    const blockers = await sql`select id from blocker where correlation_id = ${CORR}`;
    expect(blockers.length).toBe(0);
  });

  it("writes note_parsed but no blocker for a non-blocker update", async () => {
    const { updId } = await makeUpdate("all tasks done today");
    const content = JSON.stringify({
      is_blocker: false,
      category: "other",
      severity: "low",
      summary: "All tasks completed",
    });
    vi.stubGlobal("fetch", vi.fn(async () => fakeResponse(completion(content))));

    const res = await parseTaskUpdate(updId, CORR);
    expect(res.needsReview).toBe(false);
    expect(res.blockerId).toBeUndefined();
    const sql = getServiceSql();
    const blockers = await sql`select id from blocker where correlation_id = ${CORR}`;
    expect(blockers.length).toBe(0);
  });
});

// Live extraction quality — English + Hindi. Skipped unless RUN_LLM_LIVE=1.
describe.skipIf(!process.env.RUN_LLM_LIVE)("extractBlocker (LIVE)", () => {
  it("classifies real English + Hindi blocker text into valid enums", async () => {
    const { extractBlocker } = await import("./parse.js");
    const en = await extractBlocker("chiller in van 2 not holding temp, juice at risk");
    expect(en.is_blocker).toBe(true);
    expect(["equipment", "supply", "staffing", "quality", "logistics", "safety", "other"]).toContain(en.category);

    const hinglish = await extractBlocker("van 2 ka chiller theek nahi hai, juice kharab ho jayega");
    expect(hinglish.is_blocker).toBe(true);
    expect(["low", "medium", "high", "critical"]).toContain(hinglish.severity);
  }, 20_000);
});
