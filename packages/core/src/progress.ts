import { notify, resolveAlertOfBlocker } from "./alerts.js";
import { logAudit } from "./audit.js";
import { getServiceSql } from "./db.js";

/**
 * Progress, steps, relations and resolution — the depth behind a task.
 *
 * The one rule that shapes everything here: a percentage is evidence, never an opinion
 * dressed as a measurement. Three sources exist and the row always says which it is:
 *
 *   counted        done steps / total steps — the strongest evidence, wins whenever steps exist
 *   status         the percentage the status implies (task_status.pct_when_here), for a task
 *                  with no steps — a consequence of an observable transition
 *   self_reported  a person typed it, with a mandatory note; kept, labelled, never promoted
 *
 * Every change to the percentage is appended to progress_event, so "it sat at 90% for three
 * weeks" is a query, not a memory. Nothing here calls a model.
 */

export type ProgressSource = "counted" | "status" | "self_reported";

/**
 * A self-reported range, as the person picked it: "10–20%" is `{ low: 10, high: 20 }`.
 * The list a person picks from is ten steps of ten points, so that is also the only shape
 * accepted — a band the pickers cannot produce is a client bug, refused rather than stored.
 */
export interface ProgressBand {
  low: number;
  high: number;
}

export const PROGRESS_BAND_WIDTH = 10;

/** 0–10, 10–20 … 90–100, in order. "100% — finished" is not a band: that is reporting Done. */
export const PROGRESS_BANDS: readonly ProgressBand[] = Array.from({ length: 100 / PROGRESS_BAND_WIDTH }, (_, i) => ({
  low: i * PROGRESS_BAND_WIDTH,
  high: (i + 1) * PROGRESS_BAND_WIDTH,
}));

/**
 * The one number a band stands for in totals and the behind flag: its midpoint (0–10 → 5).
 * Nothing says where inside the range the work sits, and the midpoint is the value that
 * neither flatters nor punishes the estimate. The band is stored beside it and shown instead
 * of it, so the midpoint is never presented as something anybody measured.
 */
export function bandMidpoint(b: ProgressBand): number {
  return Math.round((b.low + b.high) / 2);
}

export function isAllowedBand(b: ProgressBand): boolean {
  return PROGRESS_BANDS.some((x) => x.low === b.low && x.high === b.high);
}

export type RelationKind = "blocks" | "blocked_by" | "precedes" | "follows" | "relates" | "duplicates";

/** The inverse of each directional relation; `relates` and `duplicates` are symmetric. */
export const INVERSE: Record<RelationKind, RelationKind> = {
  blocks: "blocked_by",
  blocked_by: "blocks",
  precedes: "follows",
  follows: "precedes",
  relates: "relates",
  duplicates: "duplicates",
};

/** Asana caps a task at 30 dependencies; the same bound keeps the graph walkable. */
export const MAX_RELATIONS_PER_TASK = 30;

export interface TaskStep {
  id: string;
  task_id: string;
  title: string;
  position: number;
  done: boolean;
  done_at: Date | null;
}

export async function addTaskStep(p: {
  taskId: string;
  title: string;
  by: string;
  correlationId?: string;
}): Promise<TaskStep> {
  const sql = getServiceSql();
  const rows = await sql<TaskStep[]>`
    insert into task_step (task_id, title, position, created_by)
    values (${p.taskId}, ${p.title.trim().slice(0, 200)},
            coalesce((select max(position) + 1 from task_step where task_id = ${p.taskId}), 0),
            ${p.by})
    returning id, task_id, title, position, done, done_at`;
  await recomputeProgress(p.taskId, p.correlationId, p.by);
  return rows[0]!;
}

export async function setStepDone(p: {
  stepId: string;
  done: boolean;
  by: string;
  correlationId?: string;
}): Promise<{ taskId: string }> {
  const sql = getServiceSql();
  const rows = await sql<{ task_id: string }[]>`
    update task_step
    set done = ${p.done},
        done_at = case when ${p.done} then now() else null end,
        done_by = case when ${p.done} then ${p.by}::uuid else null end
    where id = ${p.stepId}
    returning task_id`;
  const taskId = rows[0]?.task_id;
  if (!taskId) throw new Error("no such step");
  await recomputeProgress(taskId, p.correlationId, p.by);
  return { taskId };
}

/**
 * Derive the percentage from evidence. Steps win when they exist; otherwise the status.
 * A self-reported figure is replaced here — a person's estimate is the weakest source and
 * a real change in the countable evidence supersedes it. The event log keeps both.
 */
export async function recomputeProgress(taskId: string, correlationId?: string, by?: string): Promise<{ pct: number; source: ProgressSource }> {
  const sql = getServiceSql();
  const rows = await sql<{ pct: number; source: ProgressSource; before: number; before_source: ProgressSource }[]>`
    with counted as (
      select count(*) filter (where done)::int as done, count(*)::int as total
      from task_step where task_id = ${taskId}
    ),
    derived as (
      select
        case when c.total > 0 then round(100.0 * c.done / c.total)::int else s.pct_when_here end as pct,
        case when c.total > 0 then 'counted' else 'status' end as source,
        t.progress_pct as before, t.progress_source as before_source
      from task t join task_status s on s.key = t.status, counted c
      where t.id = ${taskId}
    )
    update task t
    set progress_pct = d.pct, progress_source = d.source,
        progress_note = case when d.source = 'counted' then null else t.progress_note end,
        -- A band belongs to a person's estimate; a derived figure is exact, so it has none.
        progress_band_low = null, progress_band_high = null,
        progress_updated_at = now()
    from derived d
    where t.id = ${taskId}
    returning d.pct, d.source, d.before, d.before_source`;
  const r = rows[0];
  if (!r) throw new Error("no such task");
  if (r.pct !== r.before || r.source !== r.before_source) {
    await sql`insert into progress_event (task_id, employee_id, pct, source, correlation_id)
              values (${taskId}, ${by ?? null}, ${r.pct}, ${r.source}, ${correlationId ?? null})`;
  }
  return { pct: r.pct, source: r.source };
}

/**
 * A person says how far along they are. Allowed — you chose to keep it — but it must come
 * with a reason, it is labelled self-reported wherever it is shown, and the next countable
 * change replaces it. An override with no note is refused, not silently accepted.
 */
export async function reportProgress(p: {
  taskId: string;
  employeeId: string;
  /** An exact figure. Give this or `band`, not both. */
  pct?: number;
  /** A range picked from the list — stored as given, counted as its midpoint. */
  band?: ProgressBand;
  note: string;
  correlationId?: string;
}): Promise<{ pct: number; band: ProgressBand | null }> {
  const note = p.note.trim();
  if (note.length < 3) throw new Error("A self-reported percentage needs a note saying what was done");
  if ((p.pct === undefined) === (p.band === undefined)) throw new Error("Give either a percentage or a range, not both");
  if (p.band !== undefined && !isAllowedBand(p.band)) {
    throw new Error(`A range must be one of the ${PROGRESS_BAND_WIDTH}-point steps: 0–${PROGRESS_BAND_WIDTH}, ${PROGRESS_BAND_WIDTH}–${2 * PROGRESS_BAND_WIDTH} … 90–100`);
  }
  const band = p.band ?? null;
  const pct = band ? bandMidpoint(band) : p.pct!;
  if (!Number.isInteger(pct) || pct < 0 || pct > 100) throw new Error("Percentage must be a whole number from 0 to 100");

  const sql = getServiceSql();
  await sql`update task set progress_pct = ${pct}, progress_source = 'self_reported',
              progress_band_low = ${band?.low ?? null}, progress_band_high = ${band?.high ?? null},
              progress_note = ${note.slice(0, 500)}, progress_updated_at = now(),
              started_at = coalesce(started_at, now())
            where id = ${p.taskId}`;
  await sql`insert into progress_event (task_id, employee_id, pct, band_low, band_high, source, note, correlation_id)
            values (${p.taskId}, ${p.employeeId}, ${pct}, ${band?.low ?? null}, ${band?.high ?? null},
                    'self_reported', ${note.slice(0, 500)}, ${p.correlationId ?? null})`;
  await logAudit({
    correlationId: p.correlationId,
    actor: `employee:${p.employeeId}`,
    action: "task.progress_reported",
    entity: "task",
    entityId: p.taskId,
    detail: { pct, ...(band ? { band } : {}), source: "self_reported" },
  });
  return { pct, band };
}

/** Priority, due date, estimate, details — the descriptive fields, each optional. */
export async function updateTaskFields(p: {
  taskId: string;
  by: string;
  priority?: "low" | "normal" | "high" | "urgent";
  dueAt?: string | null;
  estimateMinutes?: number | null;
  details?: string | null;
  correlationId?: string;
}): Promise<void> {
  const sql = getServiceSql();
  if (p.priority !== undefined) await sql`update task set priority = ${p.priority} where id = ${p.taskId}`;
  if (p.dueAt !== undefined) await sql`update task set due_at = ${p.dueAt} where id = ${p.taskId}`;
  if (p.estimateMinutes !== undefined) await sql`update task set estimate_minutes = ${p.estimateMinutes} where id = ${p.taskId}`;
  if (p.details !== undefined) await sql`update task set details = ${p.details} where id = ${p.taskId}`;
  await logAudit({
    correlationId: p.correlationId,
    actor: `employee:${p.by}`,
    action: "task.updated",
    entity: "task",
    entityId: p.taskId,
    detail: { priority: p.priority, dueAt: p.dueAt, estimateMinutes: p.estimateMinutes, details: p.details != null },
  });
}

/**
 * Link two tasks. The inverse is written in the same transaction so both sides always
 * agree; the per-task cap and the cycle check keep the graph bounded — a dependency chain
 * that loops would make "what is this waiting on" unanswerable.
 */
export async function linkTasks(p: {
  fromTaskId: string;
  toTaskId: string;
  kind: RelationKind;
  by: string;
  correlationId?: string;
}): Promise<void> {
  if (p.fromTaskId === p.toTaskId) throw new Error("A task cannot relate to itself");
  const sql = getServiceSql();

  const counts = await sql<{ n: number }[]>`
    select count(*)::int as n from task_relation where from_task_id = ${p.fromTaskId} or to_task_id = ${p.fromTaskId}`;
  if ((counts[0]?.n ?? 0) >= MAX_RELATIONS_PER_TASK) {
    throw new Error(`A task can have at most ${MAX_RELATIONS_PER_TASK} relations`);
  }

  // Ordering relations must not loop: if "to" already (transitively) precedes/blocks "from",
  // adding from→to would close a cycle. Bounded walk, 50 hops, same spirit as the manager guard.
  if (p.kind === "blocks" || p.kind === "precedes" || p.kind === "blocked_by" || p.kind === "follows") {
    const forward: RelationKind = p.kind === "blocks" || p.kind === "precedes" ? p.kind : INVERSE[p.kind];
    const [head, tail] = p.kind === forward ? [p.fromTaskId, p.toTaskId] : [p.toTaskId, p.fromTaskId];
    const reach = await sql<{ found: boolean }[]>`
      with recursive walk(id, depth) as (
        select ${tail}::uuid, 0
        union
        select r.to_task_id, w.depth + 1
        from task_relation r join walk w on r.from_task_id = w.id
        where r.kind = ${forward} and w.depth < 50
      )
      select exists (select 1 from walk where id = ${head}::uuid) as found`;
    if (reach[0]?.found) throw new Error("That link would make the tasks depend on each other in a loop");
  }

  await sql.begin(async (tx) => {
    await tx`insert into task_relation (from_task_id, to_task_id, kind, created_by)
             values (${p.fromTaskId}, ${p.toTaskId}, ${p.kind}, ${p.by})
             on conflict (from_task_id, to_task_id, kind) do nothing`;
    await tx`insert into task_relation (from_task_id, to_task_id, kind, created_by)
             values (${p.toTaskId}, ${p.fromTaskId}, ${INVERSE[p.kind]}, ${p.by})
             on conflict (from_task_id, to_task_id, kind) do nothing`;
  });
  await logAudit({
    correlationId: p.correlationId,
    actor: `employee:${p.by}`,
    action: "task.linked",
    entity: "task",
    entityId: p.fromTaskId,
    detail: { toTaskId: p.toTaskId, kind: p.kind },
  });
}

/**
 * Close a problem. Acknowledged means "somebody is on it"; resolved means "it is over", and
 * it says who decided that and why — the two things the next person to hit the same
 * problem wants to know.
 */
export async function resolveBlocker(p: {
  blockerId: string;
  resolvedBy: string;
  note: string;
  correlationId?: string;
}): Promise<void> {
  const note = p.note.trim();
  if (note.length < 3) throw new Error("Say how it was resolved");
  const sql = getServiceSql();
  const rows = await sql<{ id: string }[]>`
    update blocker set status = 'resolved', resolved_at = now(), resolved_by = ${p.resolvedBy},
                       resolution_note = ${note.slice(0, 1000)}
    where id = ${p.blockerId} and status in ('open', 'acknowledged')
    returning id`;
  if (!rows[0]) throw new Error("That blocker is not open");
  await logAudit({
    correlationId: p.correlationId,
    actor: `employee:${p.resolvedBy}`,
    action: "blocker.resolved",
    entity: "blocker",
    entityId: p.blockerId,
  });
  await resolveAlertOfBlocker(p.blockerId, p.correlationId);

  // The person who raised it is told it is fixed, in the resolver's words — the loop
  // closes for them, not only for the dashboard.
  const who = await sql<{ display_name: string; category: string | null; affected_asset: string | null }[]>`
    select r.display_name, b.category, b.affected_asset
    from blocker b join employee r on r.id = b.resolved_by where b.id = ${p.blockerId}`;
  const w = who[0];
  await notify(
    { type: "blocker.resolved", blockerId: p.blockerId, resolvedBy: p.resolvedBy },
    {
      text:
        `✅ Resolved${w?.category ? ` · ${w.category}` : ""}${w?.affected_asset ? ` — ${w.affected_asset}` : ""}` +
        `\n\n👤 ${w?.display_name ?? "Someone"}: "${note.slice(0, 300)}"`,
      payload: { blockerId: p.blockerId },
      correlationId: p.correlationId,
    },
  );
}

/**
 * Mark a task as stopped with a reason that is not "done": won't do, duplicate, cancelled.
 * Status and resolution are set together, never one without the other.
 */
export async function closeTask(p: {
  taskId: string;
  resolution: "wont_do" | "duplicate" | "cancelled";
  by: string;
  correlationId?: string;
}): Promise<void> {
  const sql = getServiceSql();
  await sql`update task set status = 'cancelled', resolution = ${p.resolution}, resolved_at = now() where id = ${p.taskId}`;
  await recomputeProgress(p.taskId, p.correlationId, p.by);
  await logAudit({
    correlationId: p.correlationId,
    actor: `employee:${p.by}`,
    action: "task.closed",
    entity: "task",
    entityId: p.taskId,
    detail: { resolution: p.resolution },
  });
}
