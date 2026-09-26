import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ACCESS_ROLES,
  acknowledgeBlocker,
  assignTask,
  attachNoteAndProcess,
  canAssignTo,
  checkRateLimit,
  createTask,
  eraseEmployee,
  mayAcknowledgeBlocker,
  recordTaskUpdate,
  updateOrg,
  withContext,
} from "@freshnow/core";
import { forbid, resolveViewer } from "../viewer.js";

/**
 * Creating work from the dashboard.
 *
 * Every route here is a thin shell over the same core function the Telegram bot calls —
 * `assignTask`, `recordTaskUpdate`, `acknowledgeBlocker`. None of them re-implements any
 * business rule, and none of them talks to Telegram: `assignTask` writes the outbox row
 * and the worker delivers it, so a task assigned in the browser reaches the employee's
 * phone by exactly the path a task assigned in the bot does. That is what keeps the two
 * channels in sync — one database, one outbox, no cross-calls.
 *
 * Paths live under `/dashboard/*` deliberately: the shared-secret hook and the JWT hook
 * in `dashboard.ts` both match that prefix, so a new prefix would be unauthenticated by
 * default. Authorization beyond authentication is explicit in each handler, because core
 * writes run as the BYPASSRLS service role and Postgres will not refuse them. The rule is
 * `canAssignTo` (core/org.ts) — the CEO anyone, a manager their reports, a lead their
 * department, everyone themselves — the same predicate RLS applies to reads.
 */

const TaskBody = z.object({
  title: z.string().min(3).max(200),
  /** Whose task it is. Omitted means the person asking. */
  employeeId: z.string().uuid().optional(),
});

const AssignBody = z.object({
  assignedTo: z.string().uuid(),
  title: z.string().min(3).max(200),
  note: z.string().max(1000).optional(),
});

const UpdateBody = z.object({
  taskId: z.string().uuid().nullable().optional(),
  status: z.enum(["done", "pending", "blocker", "in_progress"]),
  note: z.string().max(2000).optional(),
});

const IdParams = z.object({ id: z.string().uuid() });
const EraseBody = z.object({
  /** Why the person is being anonymised — recorded in the audit row, never inferred. */
  reason: z.enum(["left", "consent_withdrawn", "request"]),
});

const OrgBody = z.object({
  accessRole: z.enum(ACCESS_ROLES as [string, ...string[]]).optional(),
  managerEmployeeId: z.string().uuid().nullable().optional(),
  department: z.string().min(1).max(60).nullable().optional(),
});

export function registerWorkRoutes(app: FastifyInstance): void {
  /** Create a task, for yourself or for somebody you may give work to. */
  app.post("/dashboard/tasks", async (req, reply) => {
    const body = TaskBody.parse(req.body);
    const viewer = await resolveViewer(req);
    const owner = body.employeeId ?? viewer.employeeId;

    if (!(await canAssignTo(viewer, owner))) {
      return forbid(req, reply, "You can only add tasks for yourself or your own team");
    }

    const taskId = await createTask(owner, body.title, false, {
      correlationId: req.correlationId,
      createdBy: viewer.employeeId,
    });
    return reply.code(201).send({ taskId, employeeId: owner });
  });

  /** Assign work to somebody on your team. */
  app.post("/dashboard/assignments", async (req, reply) => {
    const body = AssignBody.parse(req.body);
    const viewer = await resolveViewer(req);

    if (body.assignedTo === viewer.employeeId) {
      return forbid(req, reply, "Use Add a task for your own work; an assignment is for somebody else");
    }
    if (!(await canAssignTo(viewer, body.assignedTo))) {
      return forbid(req, reply, "You can only assign work to people on your own team");
    }

    // HTTP is the more automatable surface of the two channels, so the existing
    // assignment ceiling (100/hour, an abuse limit rather than a productivity one) is
    // enforced here. The bot path is not yet bounded this way — recorded, not implied.
    const rl = await checkRateLimit({ key: "assignment", employeeId: viewer.employeeId });
    if (!rl.allowed) {
      return reply.code(429).send({
        error: { code: "rate_limited", message: rl.message, correlationId: req.correlationId },
      });
    }

    const res = await assignTask({
      assignedBy: viewer.employeeId,
      assignedTo: body.assignedTo,
      title: body.title,
      note: body.note ?? null,
      correlationId: req.correlationId,
    });
    // `delivered` means the outbox row was queued, not that Telegram accepted it — the
    // worker owns that, and the UI says "queued" rather than "sent" for the same reason.
    return reply.code(201).send({
      taskId: res.taskId,
      assignmentId: res.assignmentId,
      queued: res.delivered,
    });
  });

  /**
   * Report a status from the browser. Recorded with `channel: "web"`, and otherwise
   * identical to a tap in the bot — same table, same audit action, same end-of-day counts.
   *
   * A note goes through the same parser the bot uses, so a blocker typed in the dashboard
   * is detected, routed and escalated exactly as one typed in Telegram.
   */
  app.post("/dashboard/task-updates", async (req, reply) => {
    const body = UpdateBody.parse(req.body);
    const viewer = await resolveViewer(req);

    // A report is always about the reporter's own task. Ownership is checked by RLS
    // rather than a hand-written predicate: the task is read as the viewer, and a task
    // they may not see simply is not there. Seeing it is not enough, though — a manager
    // can see a report's task and must still not report on it in their name.
    if (body.taskId) {
      const rows = await withContext(
        viewer,
        (sql) => sql<{ employee_id: string }[]>`
          select employee_id from task where id = ${body.taskId!}`,
      );
      const owner = rows[0]?.employee_id;
      if (!owner || (owner !== viewer.employeeId && !viewer.isCeo)) {
        return forbid(req, reply, "That task is not yours to report on");
      }
    }

    const rec = await recordTaskUpdate({
      taskId: body.taskId ?? null,
      employeeId: viewer.employeeId,
      status: body.status,
      noteRaw: body.note ?? null,
      channel: "web",
      correlationId: req.correlationId,
    });

    // No note: nothing for the model to read, so nothing to wait for.
    if (!body.note) {
      return reply.code(201).send({ taskUpdateId: rec.taskUpdateId, needsReview: false });
    }

    const processed = await attachNoteAndProcess(rec.taskUpdateId, body.note, rec.correlationId);
    return reply.code(201).send({ taskUpdateId: rec.taskUpdateId, ...processed });
  });

  /**
   * Acknowledge a blocker — "somebody is on it". Stops the escalation ladder without
   * claiming the problem is fixed, which is why acknowledged and resolved are different
   * states. The CEO, the person it was routed to, or somebody who manages the person who
   * raised it may do it.
   */
  app.post("/dashboard/blockers/:id/ack", async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const viewer = await resolveViewer(req);

    const rows = await withContext(
      viewer,
      (sql) => sql<{ id: string }[]>`select id from blocker where id = ${id}`,
    );
    if (!rows[0]) return forbid(req, reply, "That blocker is not visible to you");
    // One rule for the bot and the dashboard, kept in core.
    if (!(await mayAcknowledgeBlocker(viewer.employeeId, id))) {
      return forbid(req, reply, "Only the CEO, the assigned resolver or the raiser's manager can acknowledge this");
    }

    await acknowledgeBlocker(id, req.correlationId, { by: viewer.employeeId });
    return reply.send({ blockerId: id, status: "acknowledged" });
  });

  /**
   * Change somebody's place in the org — role, manager, department. CEO only: this is
   * what decides who may see whom, and it should have exactly one author.
   */
  app.patch("/dashboard/people/:id", async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const body = OrgBody.parse(req.body);
    const viewer = await resolveViewer(req);
    if (!viewer.isCeo) return forbid(req, reply, "Only the CEO can change roles and reporting lines");

    try {
      await updateOrg({
        employeeId: id,
        ...(body.accessRole !== undefined ? { accessRole: body.accessRole as (typeof ACCESS_ROLES)[number] } : {}),
        ...(body.managerEmployeeId !== undefined ? { managerEmployeeId: body.managerEmployeeId } : {}),
        ...(body.department !== undefined ? { department: body.department } : {}),
        by: viewer.employeeId,
        correlationId: req.correlationId,
      });
    } catch (err) {
      // The cycle guard and the CEO-row rule raise plain errors; they are the caller's
      // mistake, not the server's.
      const message = err instanceof Error ? err.message : "Could not update";
      return reply.code(409).send({ error: { code: "org_conflict", message, correlationId: req.correlationId } });
    }
    return reply.send({ employeeId: id, updated: true });
  });

  /**
   * "This person has left." Anonymise, never delete (CLAUDE.md; PDPL). CEO only — the
   * data controller's action, and irreversible: the name, Telegram link, dashboard login
   * and every note are replaced, and no backup of the words is kept. Two refusals on top
   * of the role check: nobody erases themselves, and no CEO row is erased this way — the
   * CEO role changes hands through `updateOrg` first, so the system always has exactly one
   * live CEO to route to.
   */
  app.post("/dashboard/people/:id/erase", async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const { reason } = EraseBody.parse(req.body);
    const viewer = await resolveViewer(req);
    if (!viewer.isCeo) return forbid(req, reply, "Only the CEO can erase a person");
    if (id === viewer.employeeId) return forbid(req, reply, "You cannot erase yourself");

    const target = await withContext(viewer, (sql) =>
      sql<{ access_role: string; status: string }[]>`select access_role, status from employee where id = ${id}`,
    );
    if (!target[0]) return reply.code(404).send({ error: { code: "not_found", message: "No such person", correlationId: req.correlationId } });
    if (target[0].access_role === "ceo") {
      return reply.code(409).send({
        error: { code: "org_conflict", message: "Hand the CEO role to someone else before erasing this person", correlationId: req.correlationId },
      });
    }

    const r = await eraseEmployee({ employeeId: id, by: viewer.employeeId, reason, correlationId: req.correlationId });
    return reply.send({ employeeId: id, erased: true, notesRedacted: r.notesRedacted, assignmentNotesRedacted: r.assignmentNotesRedacted });
  });
}
