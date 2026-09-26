import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  HEALTHS,
  ISSUE_KINDS,
  MEMBER_ROLES,
  MOSCOW,
  PROJECT_STATUSES,
  REQUIREMENT_KINDS,
  addMilestone,
  addProjectMember,
  addProjectUpdate,
  addRequirement,
  canContributeToProject,
  canManageProject,
  createProject,
  raiseProjectIssue,
  removeProjectMember,
  resolveProjectIssue,
  setMilestoneStatus,
  setProjectHealth,
  setRequirementStatus,
  setTaskProject,
  updateProject,
  withContext,
  type ViewerOrg,
} from "@freshnow/core";
import { forbid, resolveViewer } from "../viewer.js";

/**
 * The project portal's HTTP surface.
 *
 * Reads go through `withContext`, so RLS decides what a viewer may see — a project is visible
 * to its members, to anyone who can see its lead or sponsor, and to the CEO. Writes run as the
 * service role, so every one of them checks permission here first: `canManageProject` for the
 * plan (requirements, milestones, dates, health) and `canContributeToProject` for the things
 * anyone on the project may do (post an update, raise an issue).
 *
 * Nothing here computes a percentage. Progress comes from the `project_progress` view, which
 * is SQL over every row, and the one number a person types — `pct_reported` on an update — is
 * returned beside the computed one rather than in place of it.
 */

const IdParams = z.object({ id: z.string().uuid() });
const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

const CreateBody = z.object({
  name: z.string().min(3).max(160),
  purpose: z.string().max(4000).nullish(),
  code: z.string().max(30).nullish(),
  startDate: DateStr.nullish(),
  targetDate: DateStr.nullish(),
  leadEmployeeId: z.string().uuid().nullish(),
  sponsorEmployeeId: z.string().uuid().nullish(),
});
const PatchBody = z.object({
  name: z.string().min(3).max(160).optional(),
  purpose: z.string().max(4000).nullable().optional(),
  status: z.enum(PROJECT_STATUSES as unknown as [string, ...string[]]).optional(),
  startDate: DateStr.nullable().optional(),
  targetDate: DateStr.nullable().optional(),
  leadEmployeeId: z.string().uuid().nullable().optional(),
  sponsorEmployeeId: z.string().uuid().nullable().optional(),
});
const HealthBody = z.object({
  health: z.enum(HEALTHS as unknown as [string, ...string[]]),
  note: z.string().min(3).max(1000),
});
const RequirementBody = z.object({
  text: z.string().min(3).max(2000),
  kind: z.enum(REQUIREMENT_KINDS as unknown as [string, ...string[]]).optional(),
  priority: z.enum(MOSCOW as unknown as [string, ...string[]]).optional(),
  acceptance: z.string().max(2000).nullish(),
});
const RequirementPatch = z.object({ status: z.enum(["open", "met", "dropped"]) });
const MilestoneBody = z.object({
  name: z.string().min(2).max(160),
  dueDate: DateStr.nullish(),
  weight: z.number().int().min(1).max(100).optional(),
});
const MilestonePatch = z.object({ status: z.enum(["open", "done", "cancelled"]), force: z.boolean().optional() });
const MemberBody = z.object({
  employeeId: z.string().uuid(),
  role: z.enum(MEMBER_ROLES as unknown as [string, ...string[]]).optional(),
});
const UpdateBody = z.object({
  narrative: z.string().min(3).max(4000),
  pctReported: z.number().int().min(0).max(100).nullish(),
  health: z.enum(HEALTHS as unknown as [string, ...string[]]).optional(),
});
const IssueBody = z.object({
  title: z.string().min(3).max(300),
  kind: z.enum(ISSUE_KINDS as unknown as [string, ...string[]]).optional(),
  severity: z.enum(["low", "medium", "high", "critical"]).optional(),
  description: z.string().max(4000).nullish(),
  ownerId: z.string().uuid().nullish(),
  milestoneId: z.string().uuid().nullish(),
  dueDate: DateStr.nullish(),
});
const IssuePatch = z.object({
  status: z.enum(["resolved", "accepted", "mitigating"]),
  note: z.string().min(3).max(2000),
});
const TaskProjectBody = z.object({
  projectId: z.string().uuid().nullable(),
  milestoneId: z.string().uuid().nullish(),
});

/** RLS answers "may this viewer see it at all". Everything else is checked explicitly. */
async function visible(viewer: ViewerOrg, projectId: string): Promise<boolean> {
  const rows = await withContext(viewer, (sql) => sql`select 1 from project where id = ${projectId}`);
  return rows.length > 0;
}

export function registerProjectRoutes(app: FastifyInstance): void {
  /** Every project the viewer may see, with its computed progress beside its dates. */
  app.get("/dashboard/projects", async (req) => {
    const viewer = await resolveViewer(req);
    const rows = await withContext(viewer, (sql) => sql<
      {
        project_id: string; name: string; status: string; health: string;
        start_date: string | null; target_date: string | null;
        tasks_total: number; tasks_done: number; milestones_total: number; milestones_done: number;
        milestones_overdue: number; issues_open: number; issues_serious: number;
        progress_pct: number; progress_source: string; schedule_elapsed_pct: number | null;
        last_update_at: Date | null; lead_name: string | null;
      }[]
    >`
      select pp.*, employee_display_name(p.lead_employee_id) as lead_name
      from project_progress pp
      join project p on p.id = pp.project_id
      order by case pp.status when 'active' then 0 when 'draft' then 1 when 'on_hold' then 2 else 3 end,
               pp.target_date nulls last, pp.name
      limit 100`);
    return rows.map((r) => ({ ...r, behind: isBehind(r.progress_pct, r.schedule_elapsed_pct) }));
  });

  /** One project, whole: the plan, the work, the log, the risks — everything the page needs. */
  app.get("/dashboard/projects/:id", async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const viewer = await resolveViewer(req);

    const head = await withContext(viewer, (sql) => sql<
      {
        id: string; name: string; code: string | null; purpose: string | null; status: string;
        start_date: string | null; target_date: string | null; health: string; health_note: string | null;
        health_updated_at: Date | null; lead_employee_id: string | null; sponsor_employee_id: string | null;
        lead_name: string | null; sponsor_name: string | null;
      }[]
    >`
      select p.id, p.name, p.code, p.purpose, p.status, p.start_date, p.target_date, p.health,
             p.health_note, p.health_updated_at, p.lead_employee_id, p.sponsor_employee_id,
             employee_display_name(p.lead_employee_id) as lead_name,
             employee_display_name(p.sponsor_employee_id) as sponsor_name
      from project p where p.id = ${id}`);
    if (!head[0]) return forbid(req, reply, "That project is not visible to you");

    const [progress, requirements, milestones, tasks, members, updates, issues, flow] = await Promise.all([
      withContext(viewer, (sql) => sql<Record<string, unknown>[]>`
        select * from project_progress where project_id = ${id}`),
      withContext(viewer, (sql) => sql<Record<string, unknown>[]>`
        select r.id, r.kind, r.text, r.priority, r.acceptance, r.status,
               employee_display_name(r.raised_by) as raised_by_name, r.created_at
        from project_requirement r where r.project_id = ${id}
        order by case r.priority when 'must' then 0 when 'should' then 1 when 'could' then 2 else 3 end, r.position
        limit 200`),
      withContext(viewer, (sql) => sql<Record<string, unknown>[]>`
        select m.id, m.name, m.due_date, m.weight, m.status, m.done_at,
               (select count(*)::int from task t where t.milestone_id = m.id) as tasks_total,
               (select count(*)::int from task t join task_status s on s.key = t.status
                where t.milestone_id = m.id and s.category = 'done') as tasks_done,
               (m.status = 'open' and m.due_date is not null and m.due_date < current_date) as overdue
        from milestone m where m.project_id = ${id} order by m.due_date nulls last, m.position
        limit 100`),
      withContext(viewer, (sql) => sql<Record<string, unknown>[]>`
        select t.id, t.title, t.status, s.category as status_category, t.progress_pct, t.progress_source,
               t.priority, t.due_at, t.milestone_id, t.employee_id,
               employee_display_name(t.employee_id) as employee_name
        from task t join task_status s on s.key = t.status
        where t.project_id = ${id}
        order by s.category = 'done', t.due_at nulls last, t.created_at
        limit 200`),
      withContext(viewer, (sql) => sql<Record<string, unknown>[]>`
        select pm.employee_id, pm.role, employee_display_name(pm.employee_id) as name
        from project_member pm where pm.project_id = ${id} order by pm.role, pm.created_at limit 100`),
      withContext(viewer, (sql) => sql<Record<string, unknown>[]>`
        select u.id, u.narrative, u.pct_reported, u.health, u.created_at,
               employee_display_name(u.author_id) as author_name
        from project_update u where u.project_id = ${id} order by u.created_at desc limit 50`),
      withContext(viewer, (sql) => sql<Record<string, unknown>[]>`
        select i.id, i.kind, i.title, i.description, i.severity, i.status, i.due_date,
               i.mitigation, i.resolution_note, i.resolved_at, i.created_at, i.milestone_id,
               employee_display_name(i.owner_id) as owner_name,
               employee_display_name(i.raised_by) as raised_by_name
        from project_issue i where i.project_id = ${id}
        order by i.status in ('resolved', 'accepted'),
                 case i.severity when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end,
                 i.created_at desc
        limit 100`),
      withContext(viewer, (sql) => sql<Record<string, unknown>[]>`
        select * from flow_metrics where project_id = ${id}`),
    ]);

    const pp = progress[0] as { progress_pct?: number; schedule_elapsed_pct?: number | null } | undefined;
    return {
      project: head[0],
      progress: pp ? { ...pp, behind: isBehind(pp.progress_pct ?? 0, pp.schedule_elapsed_pct ?? null) } : null,
      flow: flow[0] ?? null,
      requirements,
      milestones,
      tasks,
      members,
      updates,
      issues,
      // What this viewer may do, so the page shows only what will actually work.
      may: {
        manage: await canManageProject(viewer, id),
        contribute: await canContributeToProject(viewer, id),
      },
    };
  });

  /** Start a project. Anyone who may give work out may start one; employees may not. */
  app.post("/dashboard/projects", async (req, reply) => {
    const body = CreateBody.parse(req.body);
    const viewer = await resolveViewer(req);
    if (viewer.accessRole === "employee" && !viewer.isCeo) {
      return forbid(req, reply, "Only a manager, a lead or the CEO can start a project");
    }
    const r = await createProject({
      name: body.name,
      ...(body.purpose !== undefined ? { purpose: body.purpose } : {}),
      ...(body.code !== undefined ? { code: body.code } : {}),
      ...(body.startDate !== undefined ? { startDate: body.startDate } : {}),
      ...(body.targetDate !== undefined ? { targetDate: body.targetDate } : {}),
      ...(body.leadEmployeeId !== undefined ? { leadEmployeeId: body.leadEmployeeId } : {}),
      ...(body.sponsorEmployeeId !== undefined ? { sponsorEmployeeId: body.sponsorEmployeeId } : {}),
      by: viewer.employeeId,
      ...(req.correlationId ? { correlationId: req.correlationId } : {}),
    });
    return reply.code(201).send(r);
  });

  app.patch("/dashboard/projects/:id", async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const body = PatchBody.parse(req.body);
    const viewer = await resolveViewer(req);
    if (!(await visible(viewer, id))) return forbid(req, reply, "That project is not visible to you");
    if (!(await canManageProject(viewer, id))) return forbid(req, reply, "Only the project's lead, sponsor or the CEO can change it");
    await updateProject({
      projectId: id,
      fields: body as Parameters<typeof updateProject>[0]["fields"],
      by: viewer.employeeId,
      ...(req.correlationId ? { correlationId: req.correlationId } : {}),
    });
    return { updated: true };
  });

  app.post("/dashboard/projects/:id/health", async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const body = HealthBody.parse(req.body);
    const viewer = await resolveViewer(req);
    if (!(await visible(viewer, id))) return forbid(req, reply, "That project is not visible to you");
    if (!(await canManageProject(viewer, id))) return forbid(req, reply, "Only the project's lead, sponsor or the CEO can set its health");
    await setProjectHealth({
      projectId: id,
      health: body.health as "green",
      note: body.note,
      by: viewer.employeeId,
      ...(req.correlationId ? { correlationId: req.correlationId } : {}),
    });
    return { health: body.health };
  });

  // ── The plan ───────────────────────────────────────────────────────────────
  app.post("/dashboard/projects/:id/requirements", async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const body = RequirementBody.parse(req.body);
    const viewer = await resolveViewer(req);
    if (!(await visible(viewer, id))) return forbid(req, reply, "That project is not visible to you");
    if (!(await canManageProject(viewer, id))) return forbid(req, reply, "Only the project's lead, sponsor or the CEO can change the plan");
    const r = await addRequirement({
      projectId: id,
      text: body.text,
      ...(body.kind ? { kind: body.kind as "need" } : {}),
      ...(body.priority ? { priority: body.priority as "must" } : {}),
      ...(body.acceptance !== undefined ? { acceptance: body.acceptance } : {}),
      by: viewer.employeeId,
      ...(req.correlationId ? { correlationId: req.correlationId } : {}),
    });
    return reply.code(201).send(r);
  });

  app.patch("/dashboard/requirements/:id", async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const body = RequirementPatch.parse(req.body);
    const viewer = await resolveViewer(req);
    const owner = await withContext(viewer, (sql) => sql<{ project_id: string }[]>`
      select project_id from project_requirement where id = ${id}`);
    if (!owner[0]) return forbid(req, reply, "That requirement is not visible to you");
    if (!(await canManageProject(viewer, owner[0].project_id))) return forbid(req, reply, "Only the project's lead, sponsor or the CEO can change the plan");
    await setRequirementStatus({
      requirementId: id,
      status: body.status,
      by: viewer.employeeId,
      ...(req.correlationId ? { correlationId: req.correlationId } : {}),
    });
    return { status: body.status };
  });

  app.post("/dashboard/projects/:id/milestones", async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const body = MilestoneBody.parse(req.body);
    const viewer = await resolveViewer(req);
    if (!(await visible(viewer, id))) return forbid(req, reply, "That project is not visible to you");
    if (!(await canManageProject(viewer, id))) return forbid(req, reply, "Only the project's lead, sponsor or the CEO can change the plan");
    const r = await addMilestone({
      projectId: id,
      name: body.name,
      ...(body.dueDate !== undefined ? { dueDate: body.dueDate } : {}),
      ...(body.weight !== undefined ? { weight: body.weight } : {}),
      by: viewer.employeeId,
      ...(req.correlationId ? { correlationId: req.correlationId } : {}),
    });
    return reply.code(201).send(r);
  });

  /**
   * Ticking a milestone with unfinished work under it is refused with a 409 and the count.
   * The UI then asks the person to confirm, and `force` records that they did — because a
   * milestone silently marked done over open work is how a project reports itself green.
   */
  app.patch("/dashboard/milestones/:id", async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const body = MilestonePatch.parse(req.body);
    const viewer = await resolveViewer(req);
    const owner = await withContext(viewer, (sql) => sql<{ project_id: string }[]>`
      select project_id from milestone where id = ${id}`);
    if (!owner[0]) return forbid(req, reply, "That milestone is not visible to you");
    if (!(await canManageProject(viewer, owner[0].project_id))) return forbid(req, reply, "Only the project's lead, sponsor or the CEO can change the plan");
    try {
      const r = await setMilestoneStatus({
        milestoneId: id,
        status: body.status,
        by: viewer.employeeId,
        ...(body.force !== undefined ? { force: body.force } : {}),
        ...(req.correlationId ? { correlationId: req.correlationId } : {}),
      });
      return { status: body.status, openTasks: r.openTasks };
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not change the milestone";
      if (message.includes("not finished")) {
        return reply.code(409).send({ error: { code: "open_tasks", message }, correlationId: req.correlationId });
      }
      throw e;
    }
  });

  // ── People ─────────────────────────────────────────────────────────────────
  app.post("/dashboard/projects/:id/members", async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const body = MemberBody.parse(req.body);
    const viewer = await resolveViewer(req);
    if (!(await visible(viewer, id))) return forbid(req, reply, "That project is not visible to you");
    if (!(await canManageProject(viewer, id))) return forbid(req, reply, "Only the project's lead, sponsor or the CEO can change who is on it");
    return addProjectMember({ projectId: id, employeeId: body.employeeId, ...(body.role ? { role: body.role as "member" } : {}) });
  });

  app.delete("/dashboard/projects/:id/members", async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const body = MemberBody.parse(req.body);
    const viewer = await resolveViewer(req);
    if (!(await visible(viewer, id))) return forbid(req, reply, "That project is not visible to you");
    if (!(await canManageProject(viewer, id))) return forbid(req, reply, "Only the project's lead, sponsor or the CEO can change who is on it");
    await removeProjectMember({ projectId: id, employeeId: body.employeeId });
    return { removed: true };
  });

  // ── The log and the risks — anyone on the project ──────────────────────────
  app.post("/dashboard/projects/:id/updates", async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const body = UpdateBody.parse(req.body);
    const viewer = await resolveViewer(req);
    if (!(await visible(viewer, id))) return forbid(req, reply, "That project is not visible to you");
    if (!(await canContributeToProject(viewer, id))) return forbid(req, reply, "Only people on the project can post an update");
    const r = await addProjectUpdate({
      projectId: id,
      narrative: body.narrative,
      ...(body.pctReported !== undefined ? { pctReported: body.pctReported } : {}),
      ...(body.health ? { health: body.health as "green" } : {}),
      by: viewer.employeeId,
      ...(req.correlationId ? { correlationId: req.correlationId } : {}),
    });
    // The computed number comes back with the claim, so the page can show both at once.
    return reply.code(201).send(r);
  });

  app.post("/dashboard/projects/:id/issues", async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const body = IssueBody.parse(req.body);
    const viewer = await resolveViewer(req);
    if (!(await visible(viewer, id))) return forbid(req, reply, "That project is not visible to you");
    if (!(await canContributeToProject(viewer, id))) return forbid(req, reply, "Only people on the project can raise an issue");
    const r = await raiseProjectIssue({
      projectId: id,
      title: body.title,
      ...(body.kind ? { kind: body.kind as "issue" } : {}),
      ...(body.severity ? { severity: body.severity } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.ownerId !== undefined ? { ownerId: body.ownerId } : {}),
      ...(body.milestoneId !== undefined ? { milestoneId: body.milestoneId } : {}),
      ...(body.dueDate !== undefined ? { dueDate: body.dueDate } : {}),
      by: viewer.employeeId,
      ...(req.correlationId ? { correlationId: req.correlationId } : {}),
    });
    return reply.code(201).send(r);
  });

  app.patch("/dashboard/issues/:id", async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const body = IssuePatch.parse(req.body);
    const viewer = await resolveViewer(req);
    const owner = await withContext(viewer, (sql) => sql<{ project_id: string }[]>`
      select project_id from project_issue where id = ${id}`);
    if (!owner[0]) return forbid(req, reply, "That issue is not visible to you");
    if (!(await canContributeToProject(viewer, owner[0].project_id))) return forbid(req, reply, "Only people on the project can change an issue");
    await resolveProjectIssue({
      issueId: id,
      status: body.status,
      note: body.note,
      by: viewer.employeeId,
      ...(req.correlationId ? { correlationId: req.correlationId } : {}),
    });
    return { status: body.status };
  });

  /** Put a task under a project (or take it out). Needs rights over both the task and the project. */
  app.patch("/dashboard/tasks/:id/project", async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const body = TaskProjectBody.parse(req.body);
    const viewer = await resolveViewer(req);
    const task = await withContext(viewer, (sql) => sql<{ employee_id: string }[]>`
      select employee_id from task where id = ${id}`);
    if (!task[0]) return forbid(req, reply, "That task is not visible to you");
    if (body.projectId && !(await canManageProject(viewer, body.projectId))) {
      return forbid(req, reply, "Only the project's lead, sponsor or the CEO can put work into it");
    }
    try {
      await setTaskProject({
        taskId: id,
        projectId: body.projectId,
        ...(body.milestoneId !== undefined ? { milestoneId: body.milestoneId } : {}),
        by: viewer.employeeId,
        ...(req.correlationId ? { correlationId: req.correlationId } : {}),
      });
    } catch (e) {
      return reply.code(400).send({
        error: { code: "bad_milestone", message: e instanceof Error ? e.message : "Could not link the task" },
        correlationId: req.correlationId,
      });
    }
    return { projectId: body.projectId, milestoneId: body.milestoneId ?? null };
  });
}

/**
 * The same rule the task board uses: more of the time gone than of the work done, by more
 * than 30 points. A flag, computed on read, never a forecast. NULL dates mean no opinion.
 */
function isBehind(progressPct: number, elapsedPct: number | null): boolean {
  if (elapsedPct == null) return false;
  return elapsedPct - progressPct > 30;
}
