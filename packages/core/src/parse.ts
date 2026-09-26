import { z } from "zod";
import { getServiceSql } from "./db.js";
import { recordTrace } from "./trace.js";
import { llmComplete } from "./llm/client.js";

export const blockerExtractionSchema = z.object({
  is_blocker: z.boolean(),
  // "safety" added after the low-literacy stress test filed a bleeding injury under
  // "staffing" — there was no category for a person being hurt.
  category: z.enum(["equipment", "supply", "staffing", "quality", "logistics", "safety", "other"]),
  severity: z.enum(["low", "medium", "high", "critical"]),
  affected_asset: z.string().max(120).optional(),
  risk: z.string().max(200).optional(),
  summary: z.string().max(300),
});
export type BlockerExtraction = z.infer<typeof blockerExtractionSchema>;

// The model TRANSLATES free text into structure. It never decides who resolves the
// blocker or whether to escalate — that is deterministic (Task 009).
// Rewritten after a low-literacy stress test (30 runs, in-persona) exposed four
// reproducible failures: a leading "boss" flipped a real breakdown to needs_review;
// pure-Hindi and Malayalam were dropped; a shortage mentioned AFTER good news raised
// no blocker; and severity moved with spelling/script rather than with consequence.
const SYSTEM = `You extract structured facts from a warehouse / juice-production / delivery employee's status update.

LANGUAGE
The employee writes in English, Hindi (Devanagari or romanized "Hinglish"), or Malayalam
(Malayalam script or romanized), often mixed together, misspelled, and without punctuation.
Interpret the MEANING, not the spelling. Never ignore a message because of how it is written.

OUTPUT LANGUAGE — CRITICAL
Whatever language the employee writes in, your ENTIRE reply must be a single JSON object
whose values are in ENGLISH. Never reply in the employee's language. Never write prose,
explanation, or any text outside the JSON object. Replying in Malayalam or Hindi is a failure.

FORMS OF ADDRESS
"boss", "sir", "bhai", "sahab", "madam", "chetta" are how the employee addresses the reader.
They are NEVER equipment and NEVER a person involved in the problem. Ignore them entirely.

is_blocker
TRUE if the message reports ANYTHING that stops, slows, endangers, or spoils work —
EVEN IF the employee first reports good news or completed work. Politeness must not hide a problem:
"today everything is done, but there are no oranges for tomorrow" IS a blocker (the shortage).
Things that ARE blockers: a machine or vehicle stopped; stock missing, finished or short-delivered;
someone absent, late, sick or injured; a customer complaint, return, or bad-tasting product; a
delivery or address failure; any delay to tomorrow's work.
FALSE only when there is genuinely no problem: a pure greeting, a pure completion report, or
unintelligible noise.

category — choose one:
  equipment  a machine, chiller, fridge, pump, or vehicle part has failed
  supply     stock, ingredients, bottles or packaging missing, finished, or short-delivered
  staffing   someone absent, late, sick, or short-handed
  quality    product taste, smell, appearance or spoilage; a customer complaint or return
  logistics  a delivery, route, address, or transport problem
  safety     a person is hurt or in danger; gas/chemical smell; fire; electrical hazard; contamination
  other      a real problem fitting none of the above
If a PERSON is hurt or in danger, category is ALWAYS safety, whatever else is mentioned.

severity — judge by CONSEQUENCE, never by how loudly or urgently it is written:
  critical  a person hurt or in danger; a safety hazard; production fully stopped;
            cold chain broken with stock already spoiling
  high      a machine or vehicle down; stock already spoiled, returned, or short by a large amount;
            tomorrow's work cannot start; a shortage that stops a route or a shift
  medium    work is slowed but can continue; one machine empty; one person absent
  low       minor, cosmetic, or easily worked around
Harm that has ALREADY happened is never rated lower than the risk of that same harm
(juice already spoiled is at least as severe as a chiller merely switched off).

affected_asset  the specific thing named (e.g. "van 2 chiller", "machine no 3"), else omit
risk            the consequence in a few words (e.g. "cold chain / spoilage"), else omit
summary         ONE neutral English sentence saying only what the employee actually said.
                Do not invent equipment, causes, or outcomes they did not state.

Return ONLY the JSON object. No commentary.`;

/** Extract structured blocker facts from free text (English, Hindi, or Malayalam). */
export async function extractBlocker(
  text: string,
  correlationId?: string,
): Promise<BlockerExtraction> {
  return llmComplete({
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: text },
    ],
    schema: blockerExtractionSchema,
    operation: "parse_update",
    correlationId,
    // gpt-oss-120b is a reasoning model: too small a cap truncates it mid-JSON and
    // Groq rejects the whole generation with json_validate_failed. Give it room.
    maxTokens: 1200,
  });
}

export interface ParseResult {
  needsReview: boolean;
  blockerId?: string;
  extraction?: BlockerExtraction;
}

/**
 * Parse a stored task_update: read note_raw, extract structure via the LLM, write
 * note_parsed, and create a blocker row if it is one. On any LLM/validation failure
 * the update is flagged needs_review and NO blocker is created — the raw text is
 * never lost (it was written first, before the model was ever called).
 */
export async function parseTaskUpdate(
  taskUpdateId: string,
  correlationId?: string,
): Promise<ParseResult> {
  const sql = getServiceSql();
  const rows = await sql<{ note_raw: string | null; employee_id: string }[]>`
    select note_raw, employee_id from task_update where id = ${taskUpdateId}`;
  const row = rows[0];
  if (!row) throw new Error(`task_update ${taskUpdateId} not found`);

  let extraction: BlockerExtraction;
  try {
    extraction = await extractBlocker(row.note_raw ?? "", correlationId);
  } catch (err) {
    await sql`update task_update
              set note_parsed = ${sql.json({ needs_review: true, error: String(err) } as never)}
              where id = ${taskUpdateId}`;
    await recordTrace({
      correlationId,
      step: "parse_update",
      input: { taskUpdateId, noteRaw: row.note_raw },
      output: { needs_review: true, error: String(err) },
    });
    return { needsReview: true };
  }

  await sql`update task_update
            set note_parsed = ${sql.json(extraction as never)}
            where id = ${taskUpdateId}`;

  // The first half of the replay spine: the employee's own words in, the structured
  // extraction out. This is what makes "re-run this run and see what the model made of it"
  // possible at all — the trace table held nothing but seed rows until 2026-09-18.
  await recordTrace({
    correlationId,
    step: "parse_update",
    input: { taskUpdateId, noteRaw: row.note_raw },
    output: extraction,
  });

  if (!extraction.is_blocker) {
    return { needsReview: false, extraction };
  }

  const inserted = await sql<{ id: string }[]>`
    insert into blocker
      (task_update_id, raised_by, category, severity, affected_asset, risk, correlation_id, is_synthetic)
    values (${taskUpdateId}, ${row.employee_id}, ${extraction.category}, ${extraction.severity},
            ${extraction.affected_asset ?? null}, ${extraction.risk ?? null}, ${correlationId ?? null},
            (select is_synthetic from task_update where id = ${taskUpdateId}))
    returning id`;
  return { needsReview: false, blockerId: inserted[0]!.id, extraction };
}
