/**
 * Roles and permissions as code (TASK-057).
 *
 * One table says what each role may do; every check in the API, the bot, the worker and the
 * dashboard asks `can()`. Its copy in Postgres is the role_capability table (migration 0025),
 * read by app_has_capability() inside the row-level-security policies — a test fails the build if
 * the two ever disagree. Deny by default: a capability a role does not list is refused, an
 * unknown role has none, and an account that is not active has none at all.
 *
 * What it encodes (SPEC-000 §2 actors, R9, R27, R30; the approved plan §3; the user's decisions of
 * 2026-10-15):
 *   - Admin sees everything the CEO sees and manages people and settings — but is not the CEO. The
 *     CEO's own account, the CEO role and the Admin role are never Admin's to change, and nothing
 *     is ever done in the CEO's name (R30).
 *   - Ops Head and Supervisor give work like a manager: to their direct reports. Teams arrive with
 *     field operations (TASK-061); until then "their team" is their direct reports.
 *   - Cash auditor, warehouse keeper, technician and VMO act on their own work only; their
 *     operations screens arrive with TASK-059–061.
 *   - Stock (TASK-060): the warehouse keeper runs the warehouse, everyone in the field can hold
 *     stock and confirms what they receive, and differences are decided by the Ops Head, the CEO or
 *     an Admin — never by the person who counted (D218).
 *   - Nobody may rank or score people (R27): there is no such capability to grant.
 */

/** Every role, in the order the People page lists them. */
export const ACCESS_ROLES = [
  "ceo",
  "admin",
  "ops_head",
  "supervisor",
  "manager",
  "lead",
  "cash_auditor",
  "warehouse_keeper",
  "technician",
  "vmo",
  "employee",
] as const;
export type AccessRole = (typeof ACCESS_ROLES)[number];

export const CAPABILITIES = [
  "data.read_all",
  "data.ask",
  "people.view_reports",
  "people.view_department",
  "people.manage",
  "people.grant_roles",
  "people.grant_admin",
  "work.give_to_anyone",
  "work.give_to_reports",
  "work.give_to_department",
  "work.report_for_others",
  "documents.plan_tasks",
  "documents.plan_in_bot",
  "projects.create",
  "projects.manage_all",
  "reports.generate_all",
  "settings.manage",
  "compliance.read",
  "televend.read",
  "inventory.read",
  "inventory.hold",
  "inventory.move",
  "inventory.approve",
  "cash.hold",
  "cash.read",
  "cash.audit",
  "routes.plan",
  "visits.record",
  "machines.manage",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** What each capability allows, in words a person on the People page understands. */
export const CAPABILITY_MEANING: Readonly<Record<Capability, string>> = {
  "data.read_all": "sees everything in the system",
  "data.ask": "asks questions of the data in plain words",
  "people.view_reports": "sees the work of the people who report to them",
  "people.view_department": "sees the work of everyone in their department",
  "people.manage": "adds people, invites them, and changes their manager, department, email, site and shift",
  "people.grant_roles": "changes people's roles (never to or from CEO)",
  "people.grant_admin": "makes someone Admin, or takes it away",
  "work.give_to_anyone": "gives work to anyone",
  "work.give_to_reports": "gives work to the people who report to them",
  "work.give_to_department": "gives work to anyone in their department",
  "work.report_for_others": "reports progress on someone else's task",
  "documents.plan_tasks": "turns a document into tasks on the dashboard",
  "documents.plan_in_bot": "turns a document sent to the bot into tasks",
  "projects.create": "starts projects",
  "projects.manage_all": "manages any project",
  "reports.generate_all": "produces everyone's end-of-day report",
  "settings.manage": "changes the delivery channels and email settings",
  "compliance.read": "reads the data-protection record",
  "televend.read": "sees the machines and their Televend data (sales, alarms, refills)",
  "inventory.read": "sees all stock: the warehouse, what each person holds, every movement",
  "inventory.hold": "can be given company stock, and confirms what they receive and give back",
  "inventory.move": "runs the warehouse: receives deliveries, gives out and takes back stock, counts it",
  "inventory.approve": "decides count differences and disputed handovers, and reverses mistakes",
  "cash.hold": "collects cash from machines, pays expenses and deposits it — and accounts for every dirham",
  "cash.read": "sees everyone's cash: collections, expenses, deposits and what each person holds",
  "cash.audit": "checks each shift's cash against Televend's own sales: ok, or a question",
  "routes.plan": "makes each team's plan of machines and what to do at each, and sees every team's visits and their proof",
  "visits.record": "records their visits to machines: what was done, with the photos and videos as proof",
  "machines.manage": "corrects a machine's details in FreshNow — its category in the analytics — never in Televend",
};

/** A manager's powers — the base of every role that leads people. */
const LEADS_PEOPLE: readonly Capability[] = ["people.view_reports", "work.give_to_reports", "documents.plan_tasks"];

export const ROLE_CAPABILITIES: Readonly<Record<AccessRole, readonly Capability[]>> = {
  ceo: CAPABILITIES,
  // Everything except making Admins: that, the CEO role and the CEO's account stay the CEO's.
  admin: CAPABILITIES.filter((c) => c !== "people.grant_admin"),
  // Stock (TASK-060, D218): the Ops Head approves differences; the keeper runs the warehouse but
  // never approves their own count; everyone in the field can hold stock and must account for it.
  // Cash (TASK-061): drivers and supervisors handle it; the cash auditor and the Ops Head check it; the
  // warehouse keeper and the technician never see it.
  // Routes and visits (TASK-061 part 2): the Supervisor — the route planner — and the Ops Head make the
  // plans and see every team's proof; whoever goes to the machines records visits.
  // Machines (TASK-070): the Ops Head corrects a machine's category for the analytics; Televend is never changed.
  ops_head: [
    ...LEADS_PEOPLE, "projects.create", "televend.read",
    "inventory.read", "inventory.hold", "inventory.move", "inventory.approve",
    "cash.hold", "cash.read", "cash.audit",
    "routes.plan", "visits.record",
    "machines.manage",
  ],
  supervisor: [...LEADS_PEOPLE, "televend.read", "inventory.read", "inventory.hold", "cash.hold", "routes.plan", "visits.record"],
  manager: [...LEADS_PEOPLE, "projects.create"],
  lead: [...LEADS_PEOPLE, "people.view_department", "work.give_to_department", "projects.create"],
  cash_auditor: ["cash.read", "cash.audit"],
  warehouse_keeper: ["inventory.read", "inventory.hold", "inventory.move"],
  technician: ["inventory.hold", "visits.record"],
  vmo: ["inventory.hold", "cash.hold", "visits.record"],
  employee: [],
};

export interface RoleInfo {
  label: string;
  /** One line for the People page. */
  describe: string;
}

export const ROLE_INFO: Readonly<Record<AccessRole, RoleInfo>> = {
  ceo: { label: "CEO", describe: "Sees and decides everything; the only one who can make someone Admin." },
  admin: { label: "Admin", describe: "Sees everything; manages people, roles and settings — never the CEO's own account." },
  ops_head: { label: "Ops Head", describe: "Runs operations: sees the machines, Televend data and all stock, approves stock differences, gives work to their team, starts projects." },
  supervisor: { label: "Supervisor", describe: "Leads a field team and plans its routes: gives work to their team, makes each team's plan of machines, sees every visit's proof, the machines, Televend data and stock." },
  manager: { label: "Manager", describe: "Gives work to the people who report to them and sees their work." },
  lead: { label: "Dept lead", describe: "Like a manager, and also sees and gives work across their department." },
  cash_auditor: { label: "Cash auditor", describe: "Checks every shift's cash — each collection against Televend's own sales, the fuel, the deposits — and sees no stock." },
  warehouse_keeper: { label: "Warehouse keeper", describe: "Runs the warehouse: receives deliveries, gives out and takes back stock, counts it — never approves their own count." },
  technician: { label: "Technician", describe: "Holds the parts given to them and confirms what they receive and give back; records their visits to machines with the proof." },
  vmo: { label: "VMO / driver", describe: "Follows the team's route: records each machine visit with its proof, and accounts for the stock and cash they hold." },
  employee: { label: "Employee", describe: "Reports on their own work." },
};

/** Anything that knows who someone is: a dashboard viewer, a bot context, an employee row. */
// `| undefined` spelled out: the dashboard compiles this file too (its portal test reads the real
// table), under exactOptionalPropertyTypes, where an optional field does not accept undefined.
export interface Actor {
  accessRole?: string | null | undefined;
  isCeo?: boolean | undefined;
  /** Absent means "not known here" — the caller already refused inactive accounts. */
  status?: string | null | undefined;
}

export const isAccessRole = (r: unknown): r is AccessRole => typeof r === "string" && (ACCESS_ROLES as readonly string[]).includes(r);

const NONE: ReadonlySet<Capability> = new Set();
const BY_ROLE = new Map<AccessRole, ReadonlySet<Capability>>(ACCESS_ROLES.map((r) => [r, new Set(ROLE_CAPABILITIES[r])]));

/** The CEO's for the CEO (the configured identity, whatever the row says); none for an inactive account. */
export function capabilitiesOf(a: Actor): ReadonlySet<Capability> {
  if (a.status !== undefined && a.status !== null && a.status !== "active") return NONE;
  if (a.isCeo) return BY_ROLE.get("ceo")!;
  return isAccessRole(a.accessRole) ? BY_ROLE.get(a.accessRole)! : NONE;
}

export function can(a: Actor, capability: Capability): boolean {
  return capabilitiesOf(a).has(capability);
}

/** May give work to somebody other than themselves (the assign tab, the bot's assign menu, email). */
export function mayGiveWork(a: Actor): boolean {
  return can(a, "work.give_to_anyone") || can(a, "work.give_to_reports") || can(a, "work.give_to_department");
}

/** Sees other people's blockers — all of them, or their team's (RLS decides which). */
export function maySeeOthersBlockers(a: Actor): boolean {
  return can(a, "data.read_all") || can(a, "people.view_reports");
}

/**
 * May this role be someone's manager? Only a role that SEES its reports: escalation sends a
 * raiser's own words to their manager, which must not reach someone the rules hide them from.
 */
export function mayLeadPeople(role: string | null | undefined): boolean {
  return can({ accessRole: role }, "data.read_all") || can({ accessRole: role }, "people.view_reports");
}

/**
 * The roles this actor may give someone. Never "ceo" — the CEO role is handed over, not granted —
 * and "admin" only by the CEO.
 */
export function grantableRoles(a: Actor): AccessRole[] {
  if (!can(a, "people.grant_roles")) return [];
  return ACCESS_ROLES.filter((r) => r !== "ceo" && (r !== "admin" || can(a, "people.grant_admin")));
}

/**
 * May `actor` change the role of someone who now holds `from` to `to`? Null when allowed, otherwise
 * the reason, in words. The CEO role is handed over by the CEO alone, and an Admin's role is the
 * CEO's to change.
 */
export function roleChangeRefusal(actor: Actor, from: string, to: string): string | null {
  if (!can(actor, "people.grant_roles")) return "Only the CEO or an Admin changes roles.";
  // The CEO role is handed over by the CEO alone (deliberately, through the API — the People page
  // never offers it), never granted or taken by anyone else.
  if ((from === "ceo" || to === "ceo") && !actor.isCeo) return "The CEO role is the CEO's to hand over.";
  if ((from === "admin" || to === "admin") && !can(actor, "people.grant_admin")) return "Only the CEO makes someone Admin or takes it away.";
  if (!isAccessRole(to)) return "That is not a role.";
  return null;
}
