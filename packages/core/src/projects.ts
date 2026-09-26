import { logAudit } from "./audit.js";
import { getServiceSql } from "./db.js";
import { canAssignTo, type ViewerOrg } from "./org.js";
import { enqueueNotification } from "./outbox.js";

/**
 * Projects: work that has a plan, a shape and an end.
 *
 * The rules that make this different from the task portal, and the reasons for them:
 *
 *  • A project's percentage is COMPUTED (the `project_progress` view), from milestone weights
 *    or, failing those, from its tasks' own evidence-based percentages. A human may say where
 *    they think they are in a `project_update`, and that number is stored NEXT TO the computed
 *    one, never instead of it. The gap between the two is the most useful thing on the page.
 *  • Health is the one thing a person sets, deliberately: whether a schedule slip is worrying
 *    is a judgement, not an arithmetic result.
 *  • A `project_issue` is a risk to the plan, reviewed weekly. It is not a `blocker`, which is
 *    an operational problem with a response window measured in minutes. Keeping them apart is
 *    what stops one of them getting the wrong urgency.
 *  • The unit of work is the ordinary `task` row, so everything Phase 3 built applies here.
 */

export const PROJECT_STATUSES = ["draft", "active", "on_hold", "done", "cancelled"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export const HEALTHS = ["green", "amber", "red"] as const;
export type Health = (typeof HEALTHS)[number];
export const REQUIREMENT_KINDS = ["need", "requirement", "constraint", "assumption"] as const;
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number];
export const MOSCOW = ["must", "should", "could", "wont"] as const;
export type Moscow = (typeof MOSCOW)[number];
export const ISSUE_KINDS = ["issue", "risk", "dependency", "decision"] as const;
export type IssueKind = (typeof ISSUE_KINDS)[number];
export const ISSUE_STATUSES = ["open", "mitigating", "resolved", "accepted"] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];
export const MEMBER_ROLES = ["sponsor", "lead", "member", "watcher"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

/** How long a project may go without a status update before it is called stale. [assumed] */
export const STALE_PROJECT_DAYS = 7;

// ── Creating and shaping a project ───────────────────────────────────────────

export async function createProject(p: {
  name: string;
  purpose?: string | null;
  code?: string | null;
  startDate?: string | null;
  targetDate?: string | null;
  leadEmployeeId?: string | null;
  sponsorEmployeeId?: string | null;
  by: string;
  correlationId?: string;
}): Promise<{ projectId: string }> {
  const name = p.name.trim();
  if (name.length < 3) throw new Error("Give the project a name");
  const sql = getServiceSql();
  const rows = await sql<{ id: string }[]>`
    insert into project (name, code, purpose, start_date, target_date, lead_employee_id, sponsor_employee_id, created_by)
    values (${name}, ${p.code?.trim() || null}, ${p.purpose?.trim() || null},
            ${p.startDate ?? null}, ${p.targetDate ?? null},
            ${p.leadEmployeeId ?? null}, ${p.sponsorEmployeeId ?? null}, ${p.by})
    returning id`;
  const projectId = rows[0]!.id;

  // Everyone named on the project is a member from the start, so they can see it without
  // anyone remembering to add them. Least specific role first: `addProjectMember` upserts the
  // role, so when one person is both the creator and the lead, "lead" is what survives.
  for (const [id, role] of [
    [p.by, "member"],
    [p.sponsorEmployeeId, "sponsor"],
    [p.leadEmployeeId, "lead"],
  ] as const) {
    if (id) await addProjectMember({ projectId, employeeId: id, role: role as MemberRole });
  }

  await logAudit({
    correlationId: p.correlationId,
    actor: `employee:${p.by}`,
    action: "project.created",
    entity: "project",
    entityId: projectId,
    detail: { name, lead: p.leadEmployeeId ?? null, targetDate: p.targetDate ?? null },
  });
  return { projectId };
}

export async function updateProject(p: {
  projectId: string;
  fields: {
    name?: string;
    purpose?: string | null;
    status?: ProjectStatus;
    startDate?: string | null;
    targetDate?: string | null;
    leadEmployeeId?: string | null;
    sponsorEmployeeId?: string | null;
  };
  by: string;
  correlationId?: string;
}): Promise<void> {
  const f = p.fields;
  const sql = getServiceSql();
  const before = await sql<Record<string, unknown>[]>`
    select name, purpose, status, start_date, target_date, lead_employee_id, sponsor_employee_id
    from project where id = ${p.projectId}`;
  if (!before[0]) throw new Error("No such project");

  await sql`
    update project set
      name                = coalesce(${f.name ?? null}, name),
      purpose             = ${f.purpose === undefined ? sql`purpose` : f.purpose},
      status              = coalesce(${f.status ?? null}, status),
      start_date          = ${f.startDate === undefined ? sql`start_date` : f.startDate},
      target_date         = ${f.targetDate === undefined ? sql`target_date` : f.targetDate},
      lead_employee_id    = ${f.leadEmployeeId === undefined ? sql`lead_employee_id` : f.leadEmployeeId},
      sponsor_employee_id = ${f.sponsorEmployeeId === undefined ? sql`sponsor_employee_id` : f.sponsorEmployeeId}
    where id = ${p.projectId}`;

  if (f.leadEmployeeId) await addProjectMember({ projectId: p.projectId, employeeId: f.leadEmployeeId, role: "lead" });
  if (f.sponsorEmployeeId) await addProjectMember({ projectId: p.projectId, employeeId: f.sponsorEmployeeId, role: "sponsor" });

  await logAudit({
    correlationId: p.correlationId,
    actor: `employee:${p.by}`,
    action: "project.updated",
    entity: "project",
    entityId: p.projectId,
    detail: { before: before[0], after: f },
  });
}

/**
 * Health is set by a person and always with a reason. It is the one number on the page that
 * is a judgement rather than a calculation, so it must say who made it and why.
 */
export async function setProjectHealth(p: {
  projectId: string;
  health: Health;
  note: string;
  by: string;
  correlationId?: string;
}): Promise<void> {
  const note = p.note.trim();
  if (note.length < 3) throw new Error("Say why the health is what it is");
  const sql = getServiceSql();
  const prev = await sql<{ health: string }[]>`select health from project where id = ${p.projectId}`;
  if (!prev[0]) throw new Error("No such project");
  await sql`update project set health = ${p.health}, health_note = ${note.slice(0, 1000)},
            health_updated_at = now() where id = ${p.projectId}`;
  await logAudit({
    correlationId: p.correlationId,
    actor: `employee:${p.by}`,
    action: "project.health_set",
    entity: "project",
    entityId: p.projectId,
    detail: { from: prev[0].health, to: p.health, note },
  });
  // A project turning red is news. Everyone on it is told, through their own channels.
  if (p.health === "red" && prev[0].health !== "red") {
    await alertProjectMembers(p.projectId, {
      text: `🔴 Project health is RED: ${await projectName(p.projectId)}\n\n💬 "${note.slice(0, 300)}"`,
      key: `project.health:${p.projectId}:${Date.now()}`,
      correlationId: p.correlationId,
    });
  }
}

async function projectName(projectId: string): Promise<string> {
  const sql = getServiceSql();
  const rows = await sql<{ name: string }[]>`select name from project where id = ${projectId}`;
  return rows[0]?.name ?? "project";
}

// ── Requirements, milestones, members ────────────────────────────────────────

export async function addRequirement(p: {
  projectId: string;
  text: string;
  kind?: RequirementKind;
  priority?: Moscow;
  acceptance?: string | null;
  by: string;
  correlationId?: string;
}): Promise<{ id: string }> {
  const text = p.text.trim();
  if (text.length < 3) throw new Error("Say what is required");
  const sql = getServiceSql();
  const rows = await sql<{ id: string }[]>`
    insert into project_requirement (project_id, kind, text, priority, acceptance, raised_by, position)
    values (${p.projectId}, ${p.kind ?? "requirement"}, ${text}, ${p.priority ?? "should"},
            ${p.acceptance?.trim() || null}, ${p.by},
            coalesce((select max(position) + 1 from project_requirement where project_id = ${p.projectId}), 0))
    returning id`;
  await logAudit({
    correlationId: p.correlationId,
    actor: `employee:${p.by}`,
    action: "project.requirement_added",
    entity: "project",
    entityId: p.projectId,
    detail: { requirementId: rows[0]!.id, kind: p.kind ?? "requirement", priority: p.priority ?? "should" },
  });
  return { id: rows[0]!.id };
}

export async function setRequirementStatus(p: {
  requirementId: string;
  status: "open" | "met" | "dropped";
  by: string;
  correlationId?: string;
}): Promise<void> {
  const sql = getServiceSql();
  const rows = await sql<{ project_id: string }[]>`
    update project_requirement set status = ${p.status} where id = ${p.requirementId} returning project_id`;
  if (!rows[0]) throw new Error("No such requirement");
  await logAudit({
    correlationId: p.correlationId,
    actor: `employee:${p.by}`,
    action: "project.requirement_status",
    entity: "project",
    entityId: rows[0].project_id,
    detail: { requirementId: p.requirementId, status: p.status },
  });
}

export async function addMilestone(p: {
  projectId: string;
  name: string;
  dueDate?: string | null;
  weight?: number;
  by: string;
  correlationId?: string;
}): Promise<{ id: string }> {
  const name = p.name.trim();
  if (name.length < 2) throw new Error("Give the milestone a name");
  const weight = Math.max(1, Math.min(100, Math.trunc(p.weight ?? 1)));
  const sql = getServiceSql();
  const rows = await sql<{ id: string }[]>`
    insert into milestone (project_id, name, due_date, weight, position)
    values (${p.projectId}, ${name}, ${p.dueDate ?? null}, ${weight},
            coalesce((select max(position) + 1 from milestone where project_id = ${p.projectId}), 0))
    returning id`;
  await logAudit({
    correlationId: p.correlationId,
    actor: `employee:${p.by}`,
    action: "project.milestone_added",
    entity: "project",
    entityId: p.projectId,
    detail: { milestoneId: rows[0]!.id, name, dueDate: p.dueDate ?? null, weight },
  });
  return { id: rows[0]!.id };
}

/**
 * A milestone cannot be ticked while work under it is unfinished — that is the single most
 * common way a project reports itself green while being late. The caller must say so out loud.
 */
export async function setMilestoneStatus(p: {
  milestoneId: string;
  status: "open" | "done" | "cancelled";
  by: string;
  force?: boolean;
  correlationId?: string;
}): Promise<{ openTasks: number }> {
  const sql = getServiceSql();
  const rows = await sql<{ project_id: string; open_tasks: number }[]>`
    select m.project_id,
           (select count(*)::int from task t join task_status s on s.key = t.status
            where t.milestone_id = m.id and s.category <> 'done') as open_tasks
    from milestone m where m.id = ${p.milestoneId}`;
  const m = rows[0];
  if (!m) throw new Error("No such milestone");
  if (p.status === "done" && m.open_tasks > 0 && !p.force) {
    throw new Error(`${m.open_tasks} task(s) under this milestone are not finished`);
  }
  await sql`update milestone set status = ${p.status},
            done_at = ${p.status === "done" ? sql`now()` : null} where id = ${p.milestoneId}`;
  await logAudit({
    correlationId: p.correlationId,
    actor: `employee:${p.by}`,
    action: "project.milestone_status",
    entity: "project",
    entityId: m.project_id,
    detail: { milestoneId: p.milestoneId, status: p.status, openTasksAtTheTime: m.open_tasks, forced: p.force === true },
  });
  return { openTasks: m.open_tasks };
}

export async function addProjectMember(p: {
  projectId: string;
  employeeId: string;
  role?: MemberRole;
}): Promise<{ added: boolean }> {
  const sql = getServiceSql();
  const rows = await sql`
    insert into project_member (project_id, employee_id, role)
    values (${p.projectId}, ${p.employeeId}, ${p.role ?? "member"})
    on conflict (project_id, employee_id) do update set role = excluded.role
    returning id`;
  return { added: rows.length > 0 };
}

export async function removeProjectMember(p: { projectId: string; employeeId: string }): Promise<void> {
  const sql = getServiceSql();
  await sql`delete from project_member where project_id = ${p.projectId} and employee_id = ${p.employeeId}`;
}

// ── Work under a project ─────────────────────────────────────────────────────

/**
 * Put an existing task under a project (and optionally a milestone), or clear it. The task
 * keeps its owner, its steps and its progress — a project is a grouping, not a new kind of work.
 */
export async function setTaskProject(p: {
  taskId: string;
  projectId: string | null;
  milestoneId?: string | null;
  by: string;
  correlationId?: string;
}): Promise<void> {
  const sql = getServiceSql();
  if (p.milestoneId) {
    const ok = await sql`select 1 from milestone where id = ${p.milestoneId} and project_id = ${p.projectId}`;
    if (!ok[0]) throw new Error("That milestone belongs to a different project");
  }
  await sql`update task set project_id = ${p.projectId},
            milestone_id = ${p.projectId === null ? null : (p.milestoneId ?? null)}
            where id = ${p.taskId}`;
  await logAudit({
    correlationId: p.correlationId,
    actor: `employee:${p.by}`,
    action: "project.task_linked",
    entity: "task",
    entityId: p.taskId,
    detail: { projectId: p.projectId, milestoneId: p.milestoneId ?? null },
  });
}

// ── The status log ───────────────────────────────────────────────────────────

/**
 * Append a status update. `pctReported` is what a person SAYS; the computed percentage from
 * `project_progress` is recorded alongside it in the same row's audit, so the two can always
 * be compared later rather than one quietly replacing the other.
 */
export async function addProjectUpdate(p: {
  projectId: string;
  narrative: string;
  pctReported?: number | null;
  health?: Health;
  by: string;
  correlationId?: string;
}): Promise<{ id: string; computedPct: number | null }> {
  const narrative = p.narrative.trim();
  if (narrative.length < 3) throw new Error("Say what happened");
  if (p.pctReported != null && (p.pctReported < 0 || p.pctReported > 100)) {
    throw new Error("A percentage is between 0 and 100");
  }
  const sql = getServiceSql();
  const computed = await sql<{ progress_pct: number }[]>`
    select progress_pct from project_progress where project_id = ${p.projectId}`;
  const computedPct = computed[0]?.progress_pct ?? null;

  const rows = await sql<{ id: string }[]>`
    insert into project_update (project_id, author_id, narrative, pct_reported, health, correlation_id)
    values (${p.projectId}, ${p.by}, ${narrative.slice(0, 4000)}, ${p.pctReported ?? null},
            ${p.health ?? null}, ${p.correlationId ?? null})
    returning id`;

  if (p.health) {
    await setProjectHealth({ projectId: p.projectId, health: p.health, note: narrative, by: p.by, ...(p.correlationId ? { correlationId: p.correlationId } : {}) });
  }
  await logAudit({
    correlationId: p.correlationId,
    actor: `employee:${p.by}`,
    action: "project.update_added",
    entity: "project",
    entityId: p.projectId,
    // Both numbers, side by side, at the moment the claim was made.
    detail: { updateId: rows[0]!.id, pctReported: p.pctReported ?? null, computedPct },
  });
  return { id: rows[0]!.id, computedPct };
}

// ── Issues and risks ─────────────────────────────────────────────────────────

export async function raiseProjectIssue(p: {
  projectId: string;
  title: string;
  kind?: IssueKind;
  severity?: "low" | "medium" | "high" | "critical";
  description?: string | null;
  ownerId?: string | null;
  milestoneId?: string | null;
  dueDate?: string | null;
  by: string;
  correlationId?: string;
}): Promise<{ id: string }> {
  const title = p.title.trim();
  if (title.length < 3) throw new Error("Say what the problem is");
  const severity = p.severity ?? "medium";
  const sql = getServiceSql();
  const rows = await sql<{ id: string }[]>`
    insert into project_issue (project_id, milestone_id, kind, title, description, severity, owner_id, raised_by, due_date, correlation_id)
    values (${p.projectId}, ${p.milestoneId ?? null}, ${p.kind ?? "issue"}, ${title},
            ${p.description?.trim() || null}, ${severity}, ${p.ownerId ?? null}, ${p.by},
            ${p.dueDate ?? null}, ${p.correlationId ?? null})
    returning id`;
  const id = rows[0]!.id;

  await logAudit({
    correlationId: p.correlationId,
    actor: `employee:${p.by}`,
    action: "project.issue_raised",
    entity: "project",
    entityId: p.projectId,
    detail: { issueId: id, kind: p.kind ?? "issue", severity, owner: p.ownerId ?? null },
  });

  // A serious issue tells the project; a routine one is read on the page. The line is drawn
  // at high/critical deliberately: telling everyone about everything is how people stop reading.
  if (severity === "high" || severity === "critical") {
    await alertProjectMembers(p.projectId, {
      text: `⚠️ ${severity.toUpperCase()} ${p.kind ?? "issue"} on ${await projectName(p.projectId)}\n\n${title}` +
        (p.description ? `\n\n💬 "${p.description.slice(0, 300)}"` : ""),
      key: `project.issue:${id}`,
      correlationId: p.correlationId,
      except: p.by,
    });
  }
  return { id };
}

export async function resolveProjectIssue(p: {
  issueId: string;
  status: "resolved" | "accepted" | "mitigating";
  note: string;
  by: string;
  correlationId?: string;
}): Promise<void> {
  const note = p.note.trim();
  if (note.length < 3) throw new Error("Say how it was handled");
  const sql = getServiceSql();
  const rows = await sql<{ project_id: string }[]>`
    update project_issue
    set status = ${p.status},
        mitigation = case when ${p.status} = 'mitigating' then ${note.slice(0, 2000)} else mitigation end,
        resolution_note = case when ${p.status} <> 'mitigating' then ${note.slice(0, 2000)} else resolution_note end,
        resolved_at = case when ${p.status} <> 'mitigating' then now() else null end
    where id = ${p.issueId} and status <> 'resolved'
    returning project_id`;
  if (!rows[0]) throw new Error("That issue is already resolved");
  await logAudit({
    correlationId: p.correlationId,
    actor: `employee:${p.by}`,
    action: "project.issue_status",
    entity: "project",
    entityId: rows[0].project_id,
    detail: { issueId: p.issueId, status: p.status },
  });
}

// ── Telling the project ──────────────────────────────────────────────────────

/**
 * Project news goes to the project's members, through the Phase 4 machinery: each person on
 * the channels their own rules allow, with the reason recorded, exactly-once per key.
 *
 * It deliberately reuses `task.assigned`'s preference vocabulary rather than inventing a
 * project-specific one, because a person who has said "Telegram off for work assigned to me"
 * has not said anything about project news — so project news is sent on the default channels
 * and a future phase can add its own event types without changing this call site.
 */
async function alertProjectMembers(
  projectId: string,
  m: { text: string; key: string; correlationId?: string; except?: string },
): Promise<void> {
  const sql = getServiceSql();
  const members = await sql<{ employee_id: string; role: string }[]>`
    select employee_id, role from project_member where project_id = ${projectId} limit 50`;
  const chat = await sql<{ id: string; telegram_user_id: string | null; status: string }[]>`
    select id, telegram_user_id, status from employee
    where id = any(${members.map((r) => r.employee_id)})`;
  const chatOf = new Map(chat.map((c) => [c.id, c]));

  let told = 0;
  for (const member of members) {
    if (member.employee_id === m.except) continue;
    const person = chatOf.get(member.employee_id);
    if (!person || person.status === "disabled") continue;
    const reason = `${member.role} of the project`;
    await enqueueNotification({
      idempotencyKey: `${m.key}:${member.employee_id}:inapp`,
      payload: { text: m.text, kind: "project" },
      channel: "inapp",
      recipientEmployeeId: member.employee_id,
      reason,
    });
    told++;
    if (person.telegram_user_id != null) {
      await enqueueNotification({
        idempotencyKey: `${m.key}:${member.employee_id}:telegram`,
        chatId: Number(person.telegram_user_id),
        payload: { text: m.text, kind: "project" },
        channel: "telegram",
        recipientEmployeeId: member.employee_id,
        reason,
      });
    }
  }
  await logAudit({
    correlationId: m.correlationId,
    actor: "system",
    action: "project.alerted",
    entity: "project",
    entityId: projectId,
    detail: { told, key: m.key },
  });
}

// ── The sweeps ───────────────────────────────────────────────────────────────

export interface ProjectSweepResult {
  milestonesOverdue: number;
  projectsStale: number;
  issuesOverdue: number;
}

/**
 * Three deterministic checks, run beside the SLA sweep. Each is a query, each tells the
 * project's members once per day (the date is in the idempotency key), and none of them
 * changes any state — a sweep that silently edited data would make the history unreadable.
 */
export async function projectSweep(correlationId?: string): Promise<ProjectSweepResult> {
  const sql = getServiceSql();
  const today = new Date().toISOString().slice(0, 10);

  const overdue = await sql<{ project_id: string; id: string; name: string; due_date: string; open_tasks: number }[]>`
    select m.project_id, m.id, m.name, m.due_date::text as due_date,
           (select count(*)::int from task t join task_status s on s.key = t.status
            where t.milestone_id = m.id and s.category <> 'done') as open_tasks
    from milestone m
    join project p on p.id = m.project_id
    where m.status = 'open' and m.due_date < current_date and p.status = 'active'
    limit 100`;
  for (const m of overdue) {
    await alertProjectMembers(m.project_id, {
      text: `📅 Milestone overdue: ${m.name} (due ${m.due_date})` +
        (m.open_tasks > 0 ? `\n\n${m.open_tasks} task(s) under it are still open.` : `\n\nAll its tasks are done — it may just need ticking.`),
      key: `project.milestone_overdue:${m.id}:${today}`,
      ...(correlationId ? { correlationId } : {}),
    });
  }

  const stale = await sql<{ project_id: string; name: string; days: number }[]>`
    select pp.project_id, pp.name,
           coalesce(extract(day from now() - pp.last_update_at)::int, 999) as days
    from project_progress pp
    where pp.status = 'active'
      and (pp.last_update_at is null or pp.last_update_at < now() - make_interval(days => ${STALE_PROJECT_DAYS}))
    limit 100`;
  for (const s of stale) {
    await alertProjectMembers(s.project_id, {
      text: `🕓 No status update on ${s.name} for ${s.days >= 999 ? "as long as it has existed" : `${s.days} days`}.`,
      key: `project.stale:${s.project_id}:${today}`,
      ...(correlationId ? { correlationId } : {}),
    });
  }

  const issues = await sql<{ project_id: string; id: string; title: string }[]>`
    select i.project_id, i.id, i.title from project_issue i
    join project p on p.id = i.project_id
    where i.status in ('open', 'mitigating') and i.due_date < current_date and p.status = 'active'
    limit 100`;
  for (const i of issues) {
    await alertProjectMembers(i.project_id, {
      text: `⏰ Project issue past its date: ${i.title}`,
      key: `project.issue_overdue:${i.id}:${today}`,
      ...(correlationId ? { correlationId } : {}),
    });
  }

  return { milestonesOverdue: overdue.length, projectsStale: stale.length, issuesOverdue: issues.length };
}

// ── Permission ───────────────────────────────────────────────────────────────

/**
 * May this viewer change the project? The CEO, its lead or sponsor, or anyone who could give
 * work to its lead (their manager). Reads are handled by RLS; this guards the writes, which
 * run as the service role and get no help from Postgres.
 */
export async function canManageProject(viewer: ViewerOrg, projectId: string): Promise<boolean> {
  if (viewer.isCeo) return true;
  const sql = getServiceSql();
  const rows = await sql<{ lead_employee_id: string | null; sponsor_employee_id: string | null }[]>`
    select lead_employee_id, sponsor_employee_id from project where id = ${projectId}`;
  const p = rows[0];
  if (!p) return false;
  if (p.lead_employee_id === viewer.employeeId || p.sponsor_employee_id === viewer.employeeId) return true;
  if (p.lead_employee_id && (await canAssignTo(viewer, p.lead_employee_id))) return true;
  return false;
}

/** May this viewer contribute — raise an issue, post an update? Any member, plus the above. */
export async function canContributeToProject(viewer: ViewerOrg, projectId: string): Promise<boolean> {
  if (await canManageProject(viewer, projectId)) return true;
  const sql = getServiceSql();
  const rows = await sql`
    select 1 from project_member where project_id = ${projectId} and employee_id = ${viewer.employeeId}`;
  return rows.length > 0;
}
