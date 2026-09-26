import { logAudit } from "./audit.js";
import { getServiceSql, withContext, type AccessRole, type AppContext, type Tx } from "./db.js";
import { DEMO_CEO_ID } from "./meta.js";
import type { DirectoryEntry, OpenBlocker } from "./updates.js";

/**
 * The org chart as a permission model.
 *
 * Two things live here and nowhere else: what a viewer's RLS context should be, and whether
 * one person may give work to another. The SQL side of the same rule is
 * app_can_view_employee() in migration 0009; this file is its TypeScript twin for the writes,
 * which run as the service role and therefore get no help from Postgres.
 *
 *   ceo       everyone
 *   manager   their direct reports
 *   lead      their direct reports, plus everyone in their department
 *   employee  themselves
 */

export const ACCESS_ROLES: readonly AccessRole[] = ["ceo", "manager", "lead", "employee"];

export interface ViewerOrg extends AppContext {
  employeeId: string;
  isCeo: boolean;
  accessRole: AccessRole;
  department: string | null;
  displayName: string;
  status: string;
}

/**
 * The employee id of the CEO — looked up, not assumed.
 *
 * `DEMO_CEO_ID` is the seeded row and is still referenced where the seed itself needs it,
 * but anything that TELLS the CEO something, or files something under the CEO, must find
 * the real one: `access_role = 'ceo'`, active. The seeded id is preferred when it is one of
 * them (so nothing changes on day one) and is the fallback only when no CEO row exists at
 * all — an empty database, or one mid-migration. An audit on 2026-09-18 found five places
 * hardcoding the seeded id; on a real org chart each would have told, or parented to, a
 * person who did not exist.
 */
export async function ceoEmployeeId(): Promise<string> {
  const sql = getServiceSql();
  const rows = await sql<{ id: string }[]>`
    select id from employee
    where access_role = 'ceo' and status = 'active'
    order by (id = ${DEMO_CEO_ID}) desc, created_at
    limit 1`;
  return rows[0]?.id ?? DEMO_CEO_ID;
}

/** Everything withContext and the write routes need to know about a viewer, in one query. */
export async function loadViewer(employeeId: string): Promise<ViewerOrg | null> {
  const sql = getServiceSql();
  const rows = await sql<
    { id: string; display_name: string; status: string; access_role: AccessRole; department: string | null }[]
  >`select id, display_name, status, access_role, department from employee where id = ${employeeId}`;
  const e = rows[0];
  if (!e) return null;
  return {
    employeeId: e.id,
    // The CEO is the one fixed row, exactly as the bot decides it; the role column agrees.
    isCeo: e.id === DEMO_CEO_ID || e.access_role === "ceo",
    accessRole: e.access_role,
    department: e.department,
    displayName: e.display_name,
    status: e.status,
  };
}

/**
 * May `actor` create work for `target`? Self is always allowed (the bot's "Add a task").
 * Otherwise the same three branches as the SQL predicate, evaluated against the target's row.
 */
export async function canAssignTo(actor: ViewerOrg, target: string): Promise<boolean> {
  if (actor.isCeo) return true;
  if (target === actor.employeeId) return true;
  if (actor.accessRole !== "manager" && actor.accessRole !== "lead") return false;

  const sql = getServiceSql();
  const rows = await sql<{ manager_employee_id: string | null; department: string | null }[]>`
    select manager_employee_id, department from employee where id = ${target} and status <> 'disabled'`;
  const t = rows[0];
  if (!t) return false;
  if (t.manager_employee_id === actor.employeeId) return true;
  // Same rule as the SQL predicate: departments compare case-insensitively, because they
  // are typed by people at onboarding.
  const same = (a: string | null, b: string | null) =>
    a != null && b != null && a.trim().toLowerCase() === b.trim().toLowerCase();
  return actor.accessRole === "lead" && same(t.department, actor.department);
}

/**
 * Change somebody's place in the org. Only the CEO may (enforced by the caller); the audit
 * row records the before and after, because "who made X a manager" is a question that
 * gets asked.
 */
export async function updateOrg(p: {
  employeeId: string;
  accessRole?: AccessRole;
  managerEmployeeId?: string | null;
  department?: string | null;
  by: string;
  correlationId?: string;
}): Promise<void> {
  const sql = getServiceSql();
  const before = await sql<{ access_role: string; manager_employee_id: string | null; department: string | null }[]>`
    select access_role, manager_employee_id, department from employee where id = ${p.employeeId}`;
  if (!before[0]) throw new Error("no such employee");

  if (p.employeeId === DEMO_CEO_ID && p.accessRole && p.accessRole !== "ceo") {
    throw new Error("the CEO row keeps the ceo role");
  }

  // Each field only when supplied — an absent field means "leave it", never "clear it".
  if (p.accessRole !== undefined) {
    await sql`update employee set access_role = ${p.accessRole} where id = ${p.employeeId}`;
  }
  if (p.managerEmployeeId !== undefined) {
    // The cycle guard trigger (0009) raises if this would loop; let that surface.
    await sql`update employee set manager_employee_id = ${p.managerEmployeeId} where id = ${p.employeeId}`;
  }
  if (p.department !== undefined) {
    await sql`update employee set department = ${p.department} where id = ${p.employeeId}`;
  }

  await logAudit({
    correlationId: p.correlationId,
    actor: `employee:${p.by}`,
    action: "employee.org_updated",
    entity: "employee",
    entityId: p.employeeId,
    detail: {
      before: before[0],
      after: {
        access_role: p.accessRole ?? before[0].access_role,
        manager_employee_id: p.managerEmployeeId === undefined ? before[0].manager_employee_id : p.managerEmployeeId,
        department: p.department === undefined ? before[0].department : p.department,
      },
    },
  });
}

/**
 * The people this viewer may give work to, for a directory keyboard. The CEO gets
 * everyone; a manager their reports; a lead their reports and their department — the SQL
 * form of `canAssignTo`, so the bot never lists a name the write would then refuse.
 * Self is left out: "Add a task" is the self path, and a directory with your own name in
 * it is how work gets assigned to the wrong person.
 */
export async function listAssignable(viewer: ViewerOrg, limit = 25): Promise<DirectoryEntry[]> {
  const sql = getServiceSql();
  const isLead = viewer.accessRole === "lead";
  const rows = viewer.isCeo
    ? await sql<{ id: string; display_name: string; department: string | null; telegram_user_id: string | null }[]>`
        select id, display_name, department, telegram_user_id from employee
        where status <> 'disabled' and id <> ${viewer.employeeId}
        order by is_synthetic, display_name limit ${limit}`
    : viewer.accessRole === "manager" || isLead
      ? await sql<{ id: string; display_name: string; department: string | null; telegram_user_id: string | null }[]>`
        select id, display_name, department, telegram_user_id from employee
        where status <> 'disabled' and id <> ${viewer.employeeId}
          and (manager_employee_id = ${viewer.employeeId}
               or (${isLead}::boolean and ${viewer.department}::text is not null
                   and lower(trim(department)) = lower(trim(${viewer.department}::text))))
        order by is_synthetic, display_name limit ${limit}`
      : [];
  return rows.map((r) => ({ id: r.id, display_name: r.display_name, department: r.department, linked: r.telegram_user_id != null }));
}

/**
 * Open blockers this viewer is allowed to see — the CEO's whole queue, or a manager's
 * team. The non-CEO branch runs UNDER row-level security as that person, so the bot's
 * `/blockers` and the dashboard's blocker list are the same policy (`blocker_select`:
 * raised by someone they may see, or routed to them) and cannot drift apart. The reporter
 * is left-joined: a blocker routed to a manager may have been raised by someone whose row
 * the manager may not read, and the blocker must still show — with the name withheld.
 */
export async function listOpenBlockersFor(viewer: ViewerOrg, limit = 10): Promise<OpenBlocker[]> {
  const query = (sql: Tx | ReturnType<typeof getServiceSql>) => sql<OpenBlocker[]>`
    select b.id, b.category, b.severity,
           coalesce(b.affected_asset, b.risk) as summary,
           coalesce(reporter.display_name, 'someone outside your team') as raised_by_name,
           b.raised_at
    from blocker b
    left join employee reporter on b.raised_by = reporter.id
    where b.status = 'open'
    order by b.raised_at desc
    limit ${limit}`;
  if (viewer.isCeo) return [...(await query(getServiceSql()))];
  if (viewer.accessRole !== "manager" && viewer.accessRole !== "lead") return [];
  return [...(await withContext(viewer, (sql) => query(sql), { readOnly: true }))];
}
