import { getServiceSql } from "./db.js";

/**
 * The replay spine: what a run actually did, step by step, with the inputs it used.
 *
 * ── Why this exists separately from `audit_log` ──────────────────────────────
 * `audit_log` answers "what happened and who did it" — it is the business record, it is
 * append-only, and it is what a CEO's number traces back to. `run_trace` answers the
 * different question CLAUDE.md rule 3 asks: **"can this run be re-executed from stored
 * state and produce the same decision?"** That needs the INPUTS a step consumed, not just
 * the outcome it produced.
 *
 * Until 2026-09-18 nothing but `seed.ts` ever wrote here, so the table had two rows and
 * "every run is reconstructible" was not true. The audit caught it; this is the fix.
 *
 * ── It must never break the thing it is observing ────────────────────────────
 * A trace write is best-effort. Losing a trace row costs replayability for one run; letting
 * a trace failure abort a blocker being routed would cost the operation. Every failure is
 * swallowed and counted, the same contract the Langfuse tracer already has.
 */

/** The steps a run can record. A closed set, so a typo cannot invent a new step name. */
export const TRACE_STEPS = [
  "parse_update",
  "route_blocker",
  "escalate_blocker",
  "plan_document",
  "answer_question",
  "generate_eod",
] as const;
export type TraceStep = (typeof TRACE_STEPS)[number];

let written = 0;
let failed = 0;

/**
 * Record one step of a run.
 *
 * `input` must contain everything the step needed to reach its decision — for routing that
 * is the category, site and shift, NOT just the resolver it chose. Replay re-derives from
 * this, so anything omitted here makes the run unreplayable no matter what else is stored.
 *
 * Append-only, like the audit log. One run may perform the same step for several entities
 * (a document that creates five assignments; the seeder routing three blockers), so a
 * retried or repeated step appears more than once — which is what actually happened.
 */
export async function recordTrace(p: {
  correlationId: string | undefined;
  step: TraceStep;
  input: unknown;
  output: unknown;
}): Promise<void> {
  // A trace with no run to belong to cannot be replayed and would just be noise.
  if (!p.correlationId) return;
  try {
    const sql = getServiceSql();
    await sql`
      insert into run_trace (correlation_id, step, input, output)
      values (${p.correlationId}, ${p.step}, ${sql.json(p.input as never)}, ${sql.json(p.output as never)})`;
    written++;
  } catch {
    // Deliberately swallowed — see the note at the top of this file.
    failed++;
  }
}

/** Counters for /health, so a silently broken spine is visible rather than assumed working. */
export function traceStats(): { written: number; failed: number } {
  return { written, failed };
}

/** Tests only. */
export function resetTraceStats(): void {
  written = 0;
  failed = 0;
}
