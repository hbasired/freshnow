/**
 * The portals, in one place (TASK-058). Each is its own part of the app, with its own data and its own
 * code chunk; the picker, the switcher and the phone's menu are all drawn from this list.
 *
 * A portal is shown only to people whose role includes what it needs (`needs`, a capability from
 * permissions.ts, sent by the API in /dashboard/me). Hiding one is NOT the security boundary — the API
 * and Postgres refuse whatever a person may not read — it only spares people a page that can say
 * nothing but "not for you".
 *
 * Kept free of React so the rules can be tested without a browser (portals.test.ts).
 */

export type PortalId = "tasks" | "projects" | "operations" | "analytics" | "inventory" | "cash" | "route";

export interface PortalDef {
  id: PortalId;
  /** An icon from components/icons.tsx. */
  icon: "clipboardCheck" | "folder" | "gauge" | "barChart" | "box" | "banknote" | "map";
  /** On the switcher and the phone's menu. */
  label: string;
  /** On the picker, with the tagline and the points under it. */
  name: string;
  tagline: string;
  points: string[];
  /** The capability that opens it — or any one of several; null = everyone signed in. */
  needs: string | readonly string[] | null;
}

export const PORTALS: readonly PortalDef[] = [
  {
    id: "tasks",
    icon: "clipboardCheck",
    label: "Tasks",
    name: "Task & logging",
    tagline: "What is happening today",
    points: [
      "Daily status from the Telegram bot and the web, in one place",
      "Problems routed, escalated and acknowledged",
      "Assignments, end-of-day reports, the audit trail",
    ],
    needs: null,
  },
  {
    id: "projects",
    icon: "folder",
    label: "Projects",
    name: "Projects",
    tagline: "Work with a plan and an end",
    points: [
      "Purpose, requirements and weighted milestones",
      "Progress computed from the work, never typed in",
      "Risks, the status log, and flow metrics",
    ],
    needs: null,
  },
  {
    id: "operations",
    icon: "gauge",
    label: "Operations",
    name: "Operations",
    tagline: "The machines, now and yesterday",
    points: [
      "Every machine's state, and the alarms that need someone — blips filtered out",
      "The cash each collection should have found, from Televend's own sales",
      "Straight from Televend, read every 10 minutes — never typed in",
    ],
    needs: "televend.read",
  },
  {
    id: "analytics",
    icon: "barChart",
    label: "Analytics",
    name: "Analytics",
    tagline: "Which machines and places sell, and what to do",
    points: [
      "Every machine against the fleet average: top, about average, below, or nothing sold",
      "Hospitals, Metro, malls, Expo and the rest, added up and compared fairly",
      "Day by day against the same day a week before, with what it means in words",
    ],
    needs: "televend.read",
  },
  {
    id: "inventory",
    icon: "box",
    label: "Stock",
    name: "Stock",
    tagline: "Every carton, box and phone — and who holds it",
    points: [
      "Deliveries, hand-outs and returns, each confirmed by the other side on their phone",
      "Counts the person counting cannot copy from the screen, checked by someone else",
      "What every person holds, and the warehouse's stock list — never copied forward",
    ],
    // Whoever sees all stock, and everyone who can be given some (a driver accepts on their phone).
    needs: ["inventory.read", "inventory.hold"],
  },
  {
    id: "cash",
    icon: "banknote",
    label: "Cash",
    name: "Cash",
    tagline: "Every dirham, from the machine to the bank",
    points: [
      "Each collection, fuel receipt, test note and deposit — with its photo, added up as you go",
      "Beside each collection, what the machine's own sales say it held",
      "The auditor checks each shift in the app: ok, or a question you answer there",
    ],
    // Whoever handles cash (a driver records it) and whoever sees all of it (the auditor checks it).
    needs: ["cash.hold", "cash.read"],
  },
  {
    id: "route",
    icon: "map",
    label: "Route",
    name: "Route",
    tagline: "Today's machines, what to do at each, and the proof",
    points: [
      "Each team's plan for the shift — the instruction sheet, in the app",
      "A visit starts at the machine: its sticker, or its number",
      "The proof at each stop, OK or missing, without looking through the group",
    ],
    // Whoever plans the routes, and whoever goes to the machines.
    needs: ["routes.plan", "visits.record"],
  },
];

export function isPortalId(x: unknown): x is PortalId {
  return PORTALS.some((p) => p.id === x);
}

/**
 * The Operations portal's views (TASK-059, TASK-072), as the hash names them: `#operations` is Now,
 * `#operations/vends` (recent sales), `#operations/sales` (by hour) and `#operations/day` the others. Here, not in the portal, so the shell can read
 * the hash without downloading the portal's code.
 */
export const OPERATIONS_VIEWS = ["now", "vends", "sales", "day"] as const;
export type OperationsView = (typeof OPERATIONS_VIEWS)[number];
export const isOperationsView = (x: unknown): x is OperationsView => (OPERATIONS_VIEWS as readonly unknown[]).includes(x);

/**
 * One machine as a full page (TASK-072): `#operations/machine/<asset number>`. The shell keeps it in its `sub` as
 * "machine:<n>"; these two say how, in one place.
 */
export const machineSub = (asset: number): string => `machine:${asset}`;
export function machineOfSub(sub: string | null): number | null {
  const m = /^machine:(\d{1,5})$/.exec(sub ?? "");
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 99_999 ? n : null;
}

/**
 * The portals this person may open, in order. Until their capabilities are known, only the portals
 * that need none — a portal is never shown on a guess.
 */
export function portalsFor(capabilities: readonly string[] | null | undefined): PortalDef[] {
  return PORTALS.filter((p) => {
    if (p.needs === null) return true;
    const any = typeof p.needs === "string" ? [p.needs] : p.needs;
    return any.some((n) => capabilities?.includes(n) ?? false);
  });
}

/**
 * The Inventory portal's views (TASK-060), as the hash names them: `#inventory` is Stock,
 * `#inventory/moves`, `#inventory/day` and `#inventory/items` the others.
 */
export const INVENTORY_VIEWS = ["stock", "moves", "day", "items"] as const;
export type InventoryView = (typeof INVENTORY_VIEWS)[number];
export const isInventoryView = (x: unknown): x is InventoryView => (INVENTORY_VIEWS as readonly unknown[]).includes(x);

/**
 * The Cash portal's views (TASK-061): `#cash` is the person's own cash, `#cash/check` the auditor's
 * shifts to check, `#cash/shifts` everyone's shifts by day.
 */
export const CASH_VIEWS = ["mine", "check", "shifts"] as const;
export type CashView = (typeof CASH_VIEWS)[number];
export const isCashView = (x: unknown): x is CashView => (CASH_VIEWS as readonly unknown[]).includes(x);

/**
 * The Route portal's views (TASK-061 part 2): `#route` is today's round, `#route/plans` the plans, `#route/proof`
 * the sheet's OK / NO for a day. A sticker's link, `#visit/<token>`, opens the round with that machine's visit.
 */
export const ROUTE_VIEWS = ["today", "plans", "proof"] as const;
export type RouteView = (typeof ROUTE_VIEWS)[number];
export const isRouteView = (x: unknown): x is RouteView => (ROUTE_VIEWS as readonly unknown[]).includes(x);

/** The machine sticker's token in a `#visit/<token>` link, or null. Only a UUID is taken (the API checks it again). */
export function stickerOf(hash: string): string | null {
  const m = /^#visit\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(hash);
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * Where a person lands: the portal they asked for if they may open it, else the first they may.
 * While their capabilities are unknown, the one asked for — the portal itself handles a refusal,
 * and the shell moves them once it knows.
 */
export function landingPortal(wanted: PortalId | null, capabilities: readonly string[] | null | undefined): PortalId {
  if (capabilities === null || capabilities === undefined) return wanted ?? "tasks";
  const open = portalsFor(capabilities);
  return open.some((p) => p.id === wanted) ? wanted! : (open[0]?.id ?? "tasks");
}

/**
 * The Analytics portal's views (TASK-070): `#analytics` is Machines, `#analytics/categories` the categories. Whole days
 * only — today's picture is Operations → Now.
 */
export const ANALYTICS_VIEWS = ["machines", "categories"] as const;
export type AnalyticsView = (typeof ANALYTICS_VIEWS)[number];
export const isAnalyticsView = (x: unknown): x is AnalyticsView => (ANALYTICS_VIEWS as readonly unknown[]).includes(x);
