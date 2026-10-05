import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  addTaskStep,
  canAssignTo,
  closeTask,
  linkTasks,
  PROGRESS_BANDS,
  reportProgress,
  resolveBlocker,
  setStepDone,
  updateTaskFields,
  withContext,
  type RelationKind,
  type ViewerOrg,
} from "@freshnow/core";
import { forbid, resolveViewer } from "../viewer.js";

/**
 * The depth behind one task: steps, progress, relations, resolution.
 *
 * Reads are RLS-scoped as everywhere else. Writes are allowed to the task's owner and to
 * anyone who could have given them the work (`canAssignTo`) — a manager may tick a step
 * on a report's task; a stranger cannot even see it. Every percentage the routes return
 * is computed in SQL from steps, status or the person's own report, and says which.
 */

/**
 * How far behind schedule a task may fall before it is flagged: elapsed fraction of the
 * time between start and due, minus reported progress, in percentage points.
 * [assumed] 30 points, until FreshNow says otherwise. Shown as a flag, never as a forecast.
 */
export const BEHIND_THRESHOLD_POINTS = 30;

const IdParams = z.object({ id: z.string().uuid() });
const StepBody = z.object({ title: z.string().min(2).max(200) });
const StepPatch = z.object({ done: z.boolean() });
// An exact figure OR a range from the picker — exactly one, and the range one of core's own
// ten steps (checked here too, so a bad range is a 400 and not a 500). Core turns the range
// into the number totals use.
const ProgressBody = z
  .object({
    pct: z.number().int().min(0).max(100).optional(),
    band: z
      .object({ low: z.number().int(), high: z.number().int() })
      .refine((b) => PROGRESS_BANDS.some((x) => x.low === b.low && x.high === b.high), { message: "Not one of the listed ranges" })
      .optional(),
    note: z.string().min(3).max(500),
  })
  .refine((b) => (b.pct === undefined) !== (b.band === undefined), { message: "Give either pct or band, not both" });
const FieldsBody = z.object({
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  dueAt: z.string().datetime().nullable().optional(),
  estimateMinutes: z.number().int().positive().nullable().optional(),
  details: z.string().max(2000).nullable().optional(),
});
const RelationBody = z.object({
  toTaskId: z.string().uuid(),
  kind: z.enum(["blocks", "blocked_by", "precedes", "follows", "relates", "duplicates"]),
});
const CloseBody = z.object({ resolution: z.enum(["wont_do", "duplicate", "cancelled"]) });
const ResolveBody = z.object({ note: z.string().min(3).max(1000) });

/** The task as the viewer may see it — null when RLS hides it. */
async function visibleTask(viewer: ViewerOrg, id: string): Promise<{ employee_id: string } | null> {
  const rows = await withContext(viewer, (sql) => sql<{ employee_id: string }[]>`
    select employee_id from task where id = ${id}`);
  return rows[0] ?? null;
}

async function mayManage(viewer: ViewerOrg, ownerId: string): Promise<boolean> {
  return ownerId === viewer.employeeId || canAssignTo(viewer, ownerId);
}

export function registerTaskRoutes(app: FastifyInstance): void {
  /** Everything about one task, in one read, all under RLS. */
  app.get("/dashboard/tasks/:id", async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const viewer = await resolveViewer(req);
    const detail = await withContext(viewer, async (sql) => {
      const [task] = await sql<Record<string, unknown>[]>`
        select t.id, t.task_number::text as task_number, t.title, t.details, t.status, s.category as status_category, t.resolution, t.resolved_at,
               t.progress_pct, t.progress_source, t.progress_note, t.progress_updated_at,
               t.progress_band_low, t.progress_band_high,
               t.started_at, t.due_at, t.priority, t.estimate_minutes, t.parent_task_id, t.task_type,
               t.created_at, t.is_synthetic, t.employee_id,
               employee_display_name(t.employee_id) as employee_name,
               case when t.started_at is not null and t.due_at is not null and t.due_at > t.started_at
                    then greatest(0, least(100, round(100 * extract(epoch from (now() - t.started_at))
                                                        / extract(epoch from (t.due_at - t.started_at)))))::int
                    else null end as elapsed_pct
        from task t join task_status s on s.key = t.status
        where t.id = ${id}`;
      if (!task) return null;
      const steps = await sql`select id, title, position, done, done_at, employee_display_name(done_by) as done_by_name
                              from task_step where task_id = ${id} order by position, created_at`;
      const relations = await sql`select r.id, r.kind, r.to_task_id, o.title as other_title, o.status as other_status,
                                         employee_display_name(o.employee_id) as other_owner
                                  from task_relation r join task o on o.id = r.to_task_id
                                  where r.from_task_id = ${id} order by r.created_at`;
      const history = await sql`select pct, band_low, band_high, source, note, created_at, employee_display_name(employee_id) as by_name
                                from progress_event where task_id = ${id} order by created_at desc limit 20`;
      const blockers = await sql`select b.id, b.severity, b.category, b.status, b.raised_at, b.resolved_at, b.resolution_note,
                                        employee_display_name(b.resolved_by) as resolved_by_name, u.note_raw
                                 from blocker b join task_update u on u.id = b.task_update_id
                                 where u.task_id = ${id} order by b.raised_at desc`;
      const subtasks = await sql`select id, title, status, progress_pct, progress_source from task
                                 where parent_task_id = ${id} order by created_at`;
      return { task, steps, relations, history, blockers, subtasks };
    });
    if (!detail) return forbid(req, reply, "That task is not visible to you");
    const elapsed = detail.task.elapsed_pct as number | null;
    const pct = detail.task.progress_pct as number;
    const behind = elapsed != null && elapsed - pct > BEHIND_THRESHOLD_POINTS;
    return { ...detail, task: { ...detail.task, behind, behind_threshold: BEHIND_THRESHOLD_POINTS } };
  });

  app.post("/dashboard/tasks/:id/steps", async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const body = StepBody.parse(req.body);
    const viewer = await resolveViewer(req);
    const t = await visibleTask(viewer, id);
    if (!t || !(await mayManage(viewer, t.employee_id))) return forbid(req, reply, "That task is not yours to change");
    const step = await addTaskStep({ taskId: id, title: body.title, by: viewer.employeeId, correlationId: req.correlationId });
    return reply.code(201).send(step);
  });

  app.patch("/dashboard/steps/:id", async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const body = StepPatch.parse(req.body);
    const viewer = await resolveViewer(req);
    // The step is reachable only if its task is; RLS on task_step follows the task.
    const rows = await withContext(viewer, (sql) => sql<{ employee_id: string }[]>`
      select t.employee_id from task_step s join task t on t.id = s.task_id where s.id = ${id}`);
    const owner = rows[0]?.employee_id;
    if (!owner || !(await mayManage(viewer, owner))) return forbid(req, reply, "That step is not yours to change");
    const r = await setStepDone({ stepId: id, done: body.done, by: viewer.employeeId, correlationId: req.correlationId });
    return reply.send({ stepId: id, taskId: r.taskId, done: body.done });
  });

  /** A self-reported percentage — allowed, labelled, and only with a note. */
  app.post("/dashboard/tasks/:id/progress", async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const body = ProgressBody.parse(req.body);
    const viewer = await resolveViewer(req);
    const t = await visibleTask(viewer, id);
    if (!t || !(await mayManage(viewer, t.employee_id))) return forbid(req, reply, "That task is not yours to change");
    const r = await reportProgress({
      taskId: id,
      employeeId: viewer.employeeId,
      ...(body.band ? { band: body.band } : { pct: body.pct! }),
      note: body.note,
      correlationId: req.correlationId,
    });
    return reply.send({ taskId: id, pct: r.pct, band: r.band, source: "self_reported" });
  });

  app.patch("/dashboard/tasks/:id", async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const body = FieldsBody.parse(req.body);
    const viewer = await resolveViewer(req);
    const t = await visibleTask(viewer, id);
    if (!t || !(await mayManage(viewer, t.employee_id))) return forbid(req, reply, "That task is not yours to change");
    await updateTaskFields({
      taskId: id,
      by: viewer.employeeId,
      ...(body.priority !== undefined ? { priority: body.priority } : {}),
      ...(body.dueAt !== undefined ? { dueAt: body.dueAt } : {}),
      ...(body.estimateMinutes !== undefined ? { estimateMinutes: body.estimateMinutes } : {}),
      ...(body.details !== undefined ? { details: body.details } : {}),
      correlationId: req.correlationId,
    });
    return reply.send({ taskId: id, updated: true });
  });

  app.post("/dashboard/tasks/:id/relations", async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const body = RelationBody.parse(req.body);
    const viewer = await resolveViewer(req);
    const a = await visibleTask(viewer, id);
    const b = await visibleTask(viewer, body.toTaskId);
    if (!a || !b) return forbid(req, reply, "Both tasks must be visible to you");
    if (!(await mayManage(viewer, a.employee_id))) return forbid(req, reply, "That task is not yours to change");
    try {
      await linkTasks({ fromTaskId: id, toTaskId: body.toTaskId, kind: body.kind as RelationKind, by: viewer.employeeId, correlationId: req.correlationId });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not link";
      return reply.code(409).send({ error: { code: "relation_conflict", message, correlationId: req.correlationId } });
    }
    return reply.code(201).send({ taskId: id, toTaskId: body.toTaskId, kind: body.kind });
  });

  /** Stop a task for a reason that is not "done". */
  app.post("/dashboard/tasks/:id/close", async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const body = CloseBody.parse(req.body);
    const viewer = await resolveViewer(req);
    const t = await visibleTask(viewer, id);
    if (!t || !(await mayManage(viewer, t.employee_id))) return forbid(req, reply, "That task is not yours to change");
    await closeTask({ taskId: id, resolution: body.resolution, by: viewer.employeeId, correlationId: req.correlationId });
    return reply.send({ taskId: id, status: "cancelled", resolution: body.resolution });
  });

  /** Close a problem, saying how. The CEO, the resolver, or the raiser's manager. */
  app.post("/dashboard/blockers/:id/resolve", async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const body = ResolveBody.parse(req.body);
    const viewer = await resolveViewer(req);
    const rows = await withContext(viewer, (sql) => sql<{ raised_by: string; assigned_resolver: string | null }[]>`
      select raised_by, assigned_resolver from blocker where id = ${id}`);
    const b = rows[0];
    if (!b) return forbid(req, reply, "That blocker is not visible to you");
    const may = viewer.isCeo || b.assigned_resolver === viewer.employeeId || b.raised_by === viewer.employeeId || (await canAssignTo(viewer, b.raised_by));
    if (!may) return forbid(req, reply, "Only the CEO, the resolver, the raiser or their manager can resolve this");
    try {
      await resolveBlocker({ blockerId: id, resolvedBy: viewer.employeeId, note: body.note, correlationId: req.correlationId });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not resolve";
      return reply.code(409).send({ error: { code: "blocker_conflict", message, correlationId: req.correlationId } });
    }
    return reply.send({ blockerId: id, status: "resolved" });
  });
}
