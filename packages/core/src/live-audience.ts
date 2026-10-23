import { orgChangeCount, type ChangeScope } from "./changes.js";
import { getServiceSql, withContext } from "./db.js";
import { loadViewer, type ViewerOrg } from "./org.js";
import { CAPABILITIES, can, type Capability } from "./permissions.js";

/**
 * Who hears a change (TASK-058, migration 0027).
 *
 * Every open live stream asks one question per change: "does this concern my viewer?" The answer
 * comes from what the viewer may see — the people and the projects their row-level security lets
 * them read — asked of Postgres under that person's own context, so the rule is the policies' own
 * and not a second copy of them. It is loaded once per person, however many tabs and phones they
 * have open, and reloaded after a change to who may see whom (an `org` change).
 *
 * Every doubt resolves to YES. A doorbell carries no data, so ringing one needlessly costs a
 * refetch; NOT ringing one leaves a board stale until its poll comes round (D93). So: not loaded
 * yet, reload pending, a key this code does not know, a notification without a scope — the viewer
 * hears it.
 */

interface Seen {
  viewer: ViewerOrg | null;
  readsAll: boolean;
  employees: ReadonlySet<string>;
  projects: ReadonlySet<string>;
  /** orgChangeCount() when the load began; behind the current count means out of date. */
  loadedAt: number;
  /** Set once a load has finished; until then everything is heard. */
  loaded: boolean;
  loading: Promise<void> | undefined;
  /** When a load last failed — retried after RETRY_MS, not on every change. */
  failedAt: number;
  holders: number;
}

export interface LiveAudience {
  /** Whether a change with this scope concerns the viewer. */
  hears(scope: ChangeScope): boolean;
  /** False once the person is known to be no longer active — their stream should end. */
  readonly active: boolean;
  /** Settles when the picture is current (loaded since the last org change) or a load failed; never rejects. */
  readonly ready: Promise<void>;
  close(): void;
}

/** Loads at once: the pool has 5 connections, and requests need some of them too. */
const MAX_LOADS = 2;
const RETRY_MS = 5_000;
const NOTHING: ReadonlySet<string> = new Set();

const byPerson = new Map<string, Seen>();
let running = 0;
const waiting: Array<() => void> = [];

async function limited<T>(fn: () => Promise<T>): Promise<T> {
  // A loop, not an if: a waiter woken by `finally` must look again — another load may have started in
  // between, and the cap would be passed (review 2026-10-17, live-updates-media#8).
  while (running >= MAX_LOADS) await new Promise<void>((go) => waiting.push(go));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

async function load(personId: string, s: Seen): Promise<void> {
  // Read before the queries: an org change that lands while they run leaves this result stale.
  const at = orgChangeCount();
  const viewer = await loadViewer(personId);
  if (!viewer || viewer.status !== "active") {
    Object.assign(s, { viewer, readsAll: false, employees: NOTHING, projects: NOTHING, loadedAt: at, loaded: true });
    return;
  }
  const readsAll = can(viewer, "data.read_all");
  let employees = NOTHING;
  let projects = NOTHING;
  if (!readsAll) {
    // Row security decides, but only about the rows it could possibly allow. The policy shows a
    // person who does not read everything only themself, their direct reports and their department
    // (app_can_view_employee); asking it about every row costs ~0.15 ms a row — 44 ms per person at
    // 300 people, measured (G179) — for rows it can only refuse. So: the candidates first, without
    // row security (indexed, cheap), then row security judges those alone. `id = any(…)` is
    // leakproof, so Postgres may apply it before the policy; a `lower(trim(…))` in the same query
    // would not be, and the policy would run on every row again. live-audience.test.ts checks, for
    // every kind of viewer, that the result equals what row security shows over the whole table.
    const department = viewer.department ?? "";
    const candidates = (
      await getServiceSql()<{ id: string }[]>`
        select id from employee
         where id = ${viewer.employeeId}
            or manager_employee_id = ${viewer.employeeId}
            or (${department} <> '' and lower(trim(department)) = lower(trim(${department})))`
    ).map((r) => r.id);
    const rows = await withContext(
      viewer,
      (sql) => sql<{ kind: "e" | "p"; id: string }[]>`
        select 'e' as kind, id from employee where id = any(${candidates}::uuid[])
        union all
        select 'p', id from project`,
      { readOnly: true },
    );
    employees = new Set(rows.filter((r) => r.kind === "e").map((r) => r.id));
    projects = new Set(rows.filter((r) => r.kind === "p").map((r) => r.id));
  }
  Object.assign(s, { viewer, readsAll, employees, projects, loadedAt: at, loaded: true });
}

/** Start a (re)load if this picture is missing or out of date; never waits for it. */
function refresh(personId: string, s: Seen): Promise<void> {
  const fresh = s.loaded && s.loadedAt === orgChangeCount();
  if (fresh || s.loading || Date.now() - s.failedAt < RETRY_MS) return s.loading ?? Promise.resolve();
  s.loading = limited(() => load(personId, s))
    .catch(() => {
      s.failedAt = Date.now(); // keep hearing everything; try again on a later change
    })
    .finally(() => {
      s.loading = undefined;
    });
  return s.loading;
}

function decide(s: Seen, scope: ChangeScope): boolean {
  if (!s.loaded || s.loadedAt !== orgChangeCount() || !s.viewer) return true;
  if (s.viewer.status !== "active") return false;
  if (s.readsAll) return true;
  for (const key of scope) {
    if (key === "*" || key === "org") return true;
    const kind = key.slice(0, 2);
    const id = key.slice(2);
    if (kind === "e:") {
      if (s.employees.has(id)) return true;
    } else if (kind === "s:") {
      if (id === s.viewer.employeeId) return true;
    } else if (kind === "p:") {
      if (s.projects.has(id)) return true;
    } else if (kind === "c:") {
      // Everyone whose role holds this capability (0032: stock; 0033: the machines' problems).
      if ((CAPABILITIES as readonly string[]).includes(id) && can(s.viewer, id as Capability)) return true;
    } else {
      return true; // a key this code does not know yet: tell them rather than leave them stale
    }
  }
  return false;
}

/** One per open stream; the person's picture is shared by all their streams. */
export function openLiveAudience(personId: string): LiveAudience {
  let s = byPerson.get(personId);
  if (!s) {
    s = {
      viewer: null,
      readsAll: false,
      employees: NOTHING,
      projects: NOTHING,
      loadedAt: -1,
      loaded: false,
      loading: undefined,
      failedAt: 0,
      holders: 0,
    };
    byPerson.set(personId, s);
  }
  s.holders++;
  const seen = s;
  let open = true;
  return {
    hears(scope) {
      void refresh(personId, seen);
      return decide(seen, scope);
    },
    get active() {
      // Until the first load says otherwise, assume so; afterwards, a person who has gone or been
      // switched off has no stream to keep (their next refetch would be refused anyway).
      return !seen.loaded || seen.viewer?.status === "active";
    },
    get ready() {
      return refresh(personId, seen);
    },
    close() {
      if (!open) return;
      open = false;
      seen.holders--;
      if (seen.holders <= 0 && byPerson.get(personId) === seen) byPerson.delete(personId);
    },
  };
}

/** People with at least one open stream — for /health and the load test. */
export function liveAudienceCount(): number {
  return byPerson.size;
}

/** For the load test: how many pictures are out of date (everything heard) or being reloaded. */
export function liveAudienceStats(): { people: number; outOfDate: number; loading: number } {
  const now = orgChangeCount();
  let outOfDate = 0;
  let loading = 0;
  for (const s of byPerson.values()) {
    if (!s.loaded || s.loadedAt !== now) outOfDate++;
    if (s.loading) loading++;
  }
  return { people: byPerson.size, outOfDate, loading };
}
