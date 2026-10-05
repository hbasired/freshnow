import { z } from "zod";
import { withContext, type AppContext } from "../db.js";
import { DEMO_CEO_ID } from "../meta.js";
import { llmComplete } from "../llm/client.js";
import { groundingGate, numericSanityGate } from "./gates.js";
import { validateReadOnlySql } from "./guard.js";
import { pruneSchema } from "./schema-prune.js";

export const MAX_ROWS = 50;

// Curated schema for NL→SQL, derived by hand from semantic/schema.yaml — and PRUNED per question
// (schema-prune.ts): the model sees only the tables the question needs, plus the tables they join
// through. Only queryable tables and columns are listed at all.
const QUERY_RULES = `RULES THAT MATTER:
- Person names: ALWAYS match case-insensitively and partially — use
  display_name ILIKE '%hemanth%'. NEVER use display_name = 'hemanth' (it is
  case-sensitive and will silently return zero rows).
- "What did X say / report / mention about ...": select task_update.note_raw
  (and note_parsed->>'summary'), NOT just status. note_raw holds their actual words.
- task_update.task_id IS NULLABLE — a person can report something without it being
  tied to a task. When asked what someone SAID, query task_update joined to employee
  and LEFT JOIN task (never an inner join to task), or you will silently drop exactly
  the messages that carry their words.
- Prefer rows where note_raw IS NOT NULL when the question is about what was said.
- "Status of X's task": select task.title and task.status, and usually the latest
  task_update.status too. Prefer showing BOTH the task and what they said about it.
- employee.manager_employee_id->employee.id is a SELF-JOIN (who reports to whom).
- blocker joins employee twice (raised_by, assigned_resolver) — alias them separately.`;

const sqlSchema = z.object({ sql: z.string() });
const answerSchema = z.object({ answer: z.string() });

export interface QueryResult {
  answer: string;
  sql: string | null;
  rowCount: number;
  truncated: boolean;
  gate: { numericSanity: boolean; grounding: boolean };
  abstained: boolean;
  correlationId?: string;
}

/**
 * Run model-written SQL as the RLS-ENFORCED app role, inside the asker's own context.
 *
 * This used to use `getServiceSql()` — the BYPASSRLS `postgres` role, which is a member of
 * `pg_read_all_data` and can read `auth.users`: password hashes, refresh tokens, every
 * identity. A question box that hands a model a database connection of that strength is a
 * blast radius nobody needs, and it contradicted both `CLAUDE.md` ("a read-only role") and
 * `db.ts`'s own rule that the service client is "never for user-facing reads". Found in
 * audit, 2026-09-18.
 *
 * `freshnow_app` has no privileges on the `auth` schema at all, is not BYPASSRLS and is not
 * a superuser, so the worst a wrong or injected query can now reach is what the ASKER could
 * already see in the dashboard. The question box is CEO-only, and a CEO's RLS context sees
 * every business row, so nothing legitimate is lost.
 */
async function runReadOnly(sqlText: string, asker: AppContext): Promise<Record<string, unknown>[]> {
  return withContext(
    asker,
    async (tx) => {
      const rows = await tx.unsafe(sqlText);
      return (rows as unknown as Record<string, unknown>[]).slice(0, MAX_ROWS);
    },
    { readOnly: true }, // any write throws; set FIRST, see withContext
  );
}

/**
 * Answer a question over the data. The model TRANSLATES to SQL; Postgres computes;
 * the model narrates ≤50 rows; then the numeric-sanity gate runs before anything is
 * returned. Bounded (2 SQL attempts, MAX_ROWS), abstention reachable, and the
 * executed SQL + row count + gate verdict travel with the answer (SPEC-003).
 */
export async function answerQuestion(
  question: string,
  correlationId?: string,
  /**
   * Whose eyes the query runs behind. Defaults to the demo CEO so the bot's existing
   * CEO-gated call needs no change; an HTTP caller passes the signed-in viewer, and the
   * answer is then bounded by what that person may actually see.
   */
  asker: AppContext = { employeeId: DEMO_CEO_ID, isCeo: true, accessRole: "ceo" },
): Promise<QueryResult> {
  const abstain = (answer: string, sql: string | null, rowCount = 0, numericSanity = true): QueryResult => ({
    answer, sql, rowCount, truncated: false, gate: { numericSanity, grounding: true }, abstained: true, correlationId,
  });

  // The tables this question needs — not the whole schema (schema-prune.ts).
  const schema = pruneSchema(question);

  // 1) NL → SQL (bounded attempts), validated read-only.
  let sqlText: string | null = null;
  for (let attempt = 0; attempt < 2 && sqlText === null; attempt++) {
    try {
      const out = await llmComplete({
        messages: [
          {
            role: "system",
            content:
              `You translate a question into ONE read-only Postgres SELECT over the tables below. ` +
              `Return JSON {"sql":"..."}. SELECT only. Always include LIMIT ${MAX_ROWS}. ` +
              `Aggregate in SQL (COUNT/SUM/GROUP BY) — never select raw rows to count.\n${schema.text}\n\n${QUERY_RULES}`,
          },
          { role: "user", content: question },
        ],
        schema: sqlSchema,
        operation: "question_to_sql",
        correlationId,
        // The model reasons before answering; too small a cap truncates it mid-JSON and
        // the provider rejects the whole generation (gotcha G21). Budget for the
        // reasoning, not just the SELECT.
        maxTokens: 1200,
      });
      const check = validateReadOnlySql(out.sql, MAX_ROWS);
      if (check.ok) sqlText = check.sql;
    } catch {
      // A provider outage must degrade to an honest "I can't answer", never a 500.
    }
  }
  if (sqlText === null) {
    return abstain("I couldn't produce a safe query for that — please rephrase.", null);
  }

  // 2) Execute read-only.
  let rows: Record<string, unknown>[];
  try {
    rows = await runReadOnly(sqlText, asker);
  } catch {
    return abstain("The query could not run, so I won't guess.", sqlText);
  }
  const truncated = rows.length >= MAX_ROWS;
  if (rows.length === 0) {
    return { ...abstain("No matching records — I don't have data on that.", sqlText, 0), truncated };
  }

  // 3) Narrate the bounded rows.
  let narration: { answer: string };
  try {
    narration = await llmComplete({
      messages: [
        {
          role: "system",
          content:
            `Answer the question in one or two sentences using ONLY these result rows. ` +
            `Every number you state must come from the rows. ` +
            `If a row contains the person's own words (note_raw), quote or paraphrase them — ` +
            `that is usually what was asked for. Return JSON {"answer":"..."}.`,
        },
        { role: "user", content: `Question: ${question}\nRows: ${JSON.stringify(rows).slice(0, 4000)}` },
      ],
      schema: answerSchema,
      operation: "narrate_answer",
      correlationId,
      maxTokens: 1200,
    });
  } catch {
    // We have the rows and the SQL — surface those rather than failing the request.
    return {
      answer: `I found ${rows.length} matching row(s) but could not phrase an answer just now. The SQL and row count are below.`,
      sql: sqlText, rowCount: rows.length, truncated, gate: { numericSanity: true, grounding: true }, abstained: true, correlationId,
    };
  }

  // 4) Numeric-sanity gate BEFORE returning anything.
  const gate = numericSanityGate(narration.answer, rows);
  if (!gate.passed) {
    return {
      answer: "I found data but couldn't verify the numbers, so I won't state them. See the SQL and re-run.",
      sql: sqlText, rowCount: rows.length, truncated, gate: { numericSanity: false, grounding: true }, abstained: true, correlationId,
    };
  }

  // 5) Grounding gate: a claim about a policy, rule or food-safety requirement must have a
  //    source record behind it — the SQL must have read a policy-bearing table. A failure
  //    does not fail the request: the data and the SQL are still returned, the claim is not.
  const grounding = groundingGate(narration.answer, sqlText, rows.length);
  if (!grounding.passed) {
    return {
      answer:
        `I found ${rows.length} matching row(s), but the answer would state a rule or requirement ` +
        `(${grounding.claims.slice(0, 3).join(", ")}) that no source record in this system backs. ` +
        `I won't state it. The data and the SQL are below.`,
      sql: sqlText, rowCount: rows.length, truncated, gate: { numericSanity: true, grounding: false }, abstained: true, correlationId,
    };
  }

  return { answer: narration.answer, sql: sqlText, rowCount: rows.length, truncated, gate: { numericSanity: true, grounding: true }, abstained: false, correlationId };
}
