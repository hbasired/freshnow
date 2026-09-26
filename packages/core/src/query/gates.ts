export interface GateResult {
  passed: boolean;
  missing: string[];
}

/**
 * Numeric-sanity gate: every number stated in the answer must literally appear in
 * the returned rows. Catches the classic failure — correct query, correct rows,
 * invented total. A heuristic (token match against the serialized rows), not a
 * proof, but it reliably catches a fabricated aggregate.
 */
export function numericSanityGate(answer: string, rows: unknown[]): GateResult {
  const nums = (answer.match(/\d[\d,]*\.?\d*/g) ?? []).map((n) => n.replace(/,/g, ""));
  if (nums.length === 0) return { passed: true, missing: [] };
  const hay = JSON.stringify(rows);
  const missing = nums.filter(
    (n) => !new RegExp(`(^|[^\\d.])${n.replace(".", "\\.")}([^\\d]|$)`).test(hay),
  );
  return { passed: missing.length === 0, missing };
}

/**
 * The grounding gate — the SECOND of the two deterministic gates CLAUDE.md specifies, and
 * the one that did not exist until 2026-09-18 (an audit found the docs claiming it did).
 *
 * The rule: if an answer makes a claim about a POLICY, a RULE or a FOOD-SAFETY REQUIREMENT,
 * it must cite a source record. Here, "cite" means the SQL that produced the rows read
 * from a table that IS the policy — `sla_policy`, the escalation ladder, `routing_rule`,
 * `task_status` — and returned at least one row. A narrated "critical must be acknowledged
 * within 15 minutes" is grounded when those 15 minutes came out of `sla_policy`; it is
 * ungrounded when the model produced the sentence with no such row behind it.
 *
 * There is no policy DOCUMENT store yet (no HACCP plan, no SOPs — see the future plan), so
 * a food-safety claim can never be grounded today. That is the correct outcome: the gate
 * refuses it rather than letting a confident sentence about a legal requirement reach the
 * CEO with nothing behind it. When documents arrive, they become a source table here.
 *
 * Pure code. No model. Same inputs, same verdict.
 */
export interface GroundingResult {
  passed: boolean;
  /** The claim phrases that needed a source. Empty when the answer makes no such claim. */
  claims: string[];
  /** Whether the SQL read from a policy-bearing table and returned rows. */
  sourced: boolean;
}

const POLICY_CLAIM =
  /\b(polic(?:y|ies)|regulation(?:s)?|compliance|compliant|HACCP|food[ -]safety|hygiene requirement|mandatory|is required|are required|must (?:be|not)|the rule (?:is|says)|rules? (?:say|state|require)|according to (?:the )?(?:policy|rule|regulation|SLA)|SLA (?:is|requires|says)|within \d+ (?:minutes?|hours?|days?) (?:of|after|from))\b/gi;

/** Tables whose rows ARE the policy. A claim is grounded when the SQL read one of these. */
const SOURCE_TABLES = /\b(sla_policy|escalation_policy|escalation_level|escalation_target|routing_rule|task_status)\b/i;

export function groundingGate(answer: string, sql: string | null, rowCount: number): GroundingResult {
  const claims = [...new Set((answer.match(POLICY_CLAIM) ?? []).map((c) => c.toLowerCase()))];
  const sourced = sql !== null && SOURCE_TABLES.test(sql) && rowCount > 0;
  return { passed: claims.length === 0 || sourced, claims, sourced };
}
