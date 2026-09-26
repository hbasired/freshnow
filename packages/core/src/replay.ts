import { getServiceSql } from "./db.js";
import { resolveForCategory } from "./routing.js";

export interface ReplayCheck {
  blockerId: string;
  original: string | null;
  rederived: string | null;
  matches: boolean;
  /** The inputs the decision was made from, as recorded at the time. */
  input: RoutingInput | null;
  /** Set when the run predates input recording, so it cannot be replayed at all. */
  unreplayable?: string;
}

export interface ReplayReport {
  correlationId: string;
  /** False when no trace of this run exists at all — NOT the same as "nothing diverged". */
  found: boolean;
  steps: number;
  checks: ReplayCheck[];
  diverged: boolean;
  /** Checks that could not be attempted because the run predates input recording. */
  unreplayable: number;
}

interface RoutingInput {
  category: string | null;
  severity?: string | null;
  site?: string | null;
  shift?: string | null;
}

/**
 * Re-execute a run's deterministic decisions from what was RECORDED, and report divergence.
 *
 * ── What was wrong with this before 2026-09-18 ───────────────────────────────
 * It re-read the live `blocker` row to get the category, then re-derived from that. Two
 * things followed, both found by audit:
 *
 *   1. It was not a replay. A replay must use the inputs as they were; reading current
 *      state means a routing rule change and a *data* change are indistinguishable.
 *   2. It reported `diverged: true` for **90% of real runs** — not because anything had
 *      changed, but because `scripts/reset-employee.ts` hard-deletes blockers while the
 *      audit log keeps pointing at them. 45 of 50 routed blockers no longer existed.
 *
 * And a run that never existed returned `{steps: 0, checks: [], diverged: false}` — which
 * reads as "replayed fine, no divergence". That is the precise class of silent wrongness
 * `HONESTY-AND-ACCURACY.md` exists to prevent, so `found` is now explicit and separate.
 *
 * Runs recorded before the fix have no `detail.input` and are counted as `unreplayable`
 * rather than silently passing or silently failing.
 */
export async function replayRun(correlationId: string): Promise<ReplayReport> {
  const sql = getServiceSql();

  const traceRows = await sql<{ n: number }[]>`
    select count(*)::int as n from run_trace where correlation_id = ${correlationId}`;
  const auditRows = await sql<{ n: number }[]>`
    select count(*)::int as n from audit_log where correlation_id = ${correlationId}`;

  const routed = await sql<
    { entity_id: string; detail: { resolverId?: string; input?: RoutingInput } | null }[]
  >`select entity_id, detail from audit_log
      where correlation_id = ${correlationId} and action = 'blocker.routed'
      order by created_at`;

  const checks: ReplayCheck[] = [];
  for (const r of routed) {
    const original = r.detail?.resolverId ?? null;
    const input = r.detail?.input ?? null;

    if (!input) {
      // Recorded before inputs were kept. Say so rather than guessing from live state,
      // which is what produced the false divergence this function used to report.
      checks.push({
        blockerId: r.entity_id,
        original,
        rederived: null,
        matches: false,
        input: null,
        unreplayable: "run predates input recording (migration 0015); the decision's inputs were never stored",
      });
      continue;
    }

    // The whole point: re-derive from the RECORDED input, never from the live row.
    const rederived = await resolveForCategory({
      category: input.category,
      site: input.site ?? null,
      shift: input.shift ?? null,
    });
    checks.push({ blockerId: r.entity_id, original, rederived, matches: original === rederived, input });
  }

  const unreplayable = checks.filter((c) => c.unreplayable).length;
  return {
    correlationId,
    found: (traceRows[0]?.n ?? 0) > 0 || (auditRows[0]?.n ?? 0) > 0,
    steps: traceRows[0]?.n ?? 0,
    checks,
    // Only a check that actually ran can diverge. An unreplayable one is unknown, not equal.
    diverged: checks.some((c) => !c.unreplayable && !c.matches),
    unreplayable,
  };
}
