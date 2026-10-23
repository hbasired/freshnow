import { randomUUID } from "node:crypto";
import {
  EVENT_LEVEL,
  REFILL_FILL_TYPE,
  REFILL_SOURCE,
  assetNumber,
  dubaiDay,
  refillKey,
  type DateRange,
  type TelevendSource,
  type TvEvent,
  type TvMachine,
  type TvRefill,
  type TvVend,
} from "@freshnow/televend";
import { getServiceSql, type Db } from "./db.js";

/**
 * Televend → Postgres (TASK-056). Reads through a `TelevendSource` (TASK-055: allow-listed,
 * read-only) and writes the local mirror (migration 0023) on the service role.
 *
 * Correctness rules:
 *   - Natural unique keys + ON CONFLICT: re-reading any window inserts nothing twice. Vends are
 *     immutable (DO NOTHING); events change when Televend resolves them (DO UPDATE).
 *   - A stream's cursor only moves after a COMPLETE read of its window. An incomplete read is
 *     recorded as `partial` and the same window is read again next time.
 *   - Every incremental read overlaps the last one: telemetry boxes that were offline upload
 *     late, with their original timestamps.
 *   - The daily check re-reads whole past days and compares vends with Televend's own count —
 *     the only way to say "this day is complete" (G147, G148).
 *   - Bounded everywhere: windows, overlaps, requests, days per backfill run.
 */

type Transport = "bridge" | "official" | "files";
type Stream = "machines" | "vends" | "events" | "refills";
type Mode = "incremental" | "daily_check" | "backfill";

export interface SyncContext {
  source: TelevendSource;
  /** Requests sent so far by the client behind the source (for tv_sync_run). */
  requests?: () => number;
  sql?: Db;
  now?: () => Date;
  correlationId?: string;
}

/** Late telemetry arrives with old timestamps — every incremental window re-reads this much. */
export const VEND_OVERLAP_MS = 30 * 60_000;
export const EVENT_OVERLAP_MS = 60 * 60_000;
/** Do not read the last minutes: Televend may still be writing them. */
export const SETTLE_MS = 2 * 60_000;
/** A first incremental run (no cursor yet) starts at most this far back. Older days: backfill. */
export const FIRST_RUN_LOOKBACK_MS = 6 * 3_600_000;

const sqlOf = (c: SyncContext): Db => c.sql ?? getServiceSql();
const nowOf = (c: SyncContext): Date => (c.now ? c.now() : new Date());
const reqs = (c: SyncContext): number => (c.requests ? c.requests() : 0);
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const dubaiHour = (d: Date): number => new Date(d.getTime() + 4 * 3_600_000).getUTCHours();

interface RunHandle {
  id: string;
  finish(p: {
    status: "ok" | "partial" | "error";
    complete: boolean;
    rowsRead?: number;
    rowsNew?: number;
    rowsChanged?: number;
    televendCount?: number | null;
    error?: string;
  }): Promise<void>;
}

async function startRun(c: SyncContext, stream: Stream, mode: Mode, transport: Transport, window: DateRange | null): Promise<RunHandle> {
  const sql = sqlOf(c);
  const before = reqs(c);
  const id = randomUUID();
  await sql`
    insert into tv_sync_run (id, stream, mode, transport, window_from, window_to, status, correlation_id)
    values (${id}, ${stream}, ${mode}, ${transport}, ${window?.from ?? null}, ${window?.to ?? null}, 'partial', ${c.correlationId ?? null})`;
  return {
    id,
    async finish(p) {
      await sql`
        update tv_sync_run set
          status = ${p.status}, complete = ${p.complete},
          rows_read = ${p.rowsRead ?? 0}, rows_new = ${p.rowsNew ?? 0}, rows_changed = ${p.rowsChanged ?? 0},
          televend_count = ${p.televendCount ?? null}, requests = ${reqs(c) - before},
          error = ${p.error ? p.error.slice(0, 500) : null}, finished_at = now()
        where id = ${id}`;
    },
  };
}

// ── Machines ──────────────────────────────────────────────────────────────────

/** A refill log the machines list calls for: one Televend record, on these business days (oldest first). */
export interface RefillRead {
  televendId: number;
  days: string[];
  /**
   * Its last refill moved since the previous sync; it is new and was refilled today; or it was
   * disabled since the previous sync — a disabled record loses its last_refill but keeps its log,
   * usually with the row of the machine being emptied before it moved (G160).
   */
  reason: "refilled" | "first_sight" | "disabled";
}

export interface MachinesResult {
  machines: number;
  enabled: number;
  refillReads: RefillRead[];
  renamed: number;
}

/** A longer gap (the worker was down) is the daily check's or a backfill's to fill, not the 10-minute sync's. */
export const MAX_REFILL_DAYS = 2;

/**
 * The business days from the one `a` falls in to the one `b` falls in, in either order, keeping the
 * newest MAX_REFILL_DAYS: a refill at 23:56 and another at 00:01 between two syncs are on two days.
 */
export function refillDays(a: Date, b: Date): string[] {
  const hi = Math.max(a.getTime(), b.getTime());
  const lo = Math.max(Math.min(a.getTime(), b.getTime()), hi - (MAX_REFILL_DAYS - 1) * 86_400_000);
  const days = [dubaiDate(new Date(lo))];
  const last = dubaiDate(new Date(hi));
  while (days[days.length - 1] !== last && days.length < MAX_REFILL_DAYS) {
    days.push(dubaiDate(new Date(dubaiDay(days[days.length - 1]!).from.getTime() + 86_400_000)));
  }
  return days;
}

interface PreviousMachine {
  last_refill_at: Date | null;
  caption: string;
  enabled: boolean;
  last_seen_at: Date;
}

interface MachinesPlan {
  run: RunHandle;
  /** When the list was read (the sync's clock). */
  at: Date;
  list: (TvMachine & { televendId: number })[];
  previous: Map<number, PreviousMachine>;
  reads: RefillRead[];
}

/** Read the machines list and decide which refill logs it calls for. Writes nothing yet. */
async function readMachines(c: SyncContext, transport: Transport): Promise<MachinesPlan> {
  const run = await startRun(c, "machines", "incremental", transport, null);
  try {
    const list = (await c.source.machines()).filter((m): m is TvMachine & { televendId: number } => m.televendId !== null);
    const previous = new Map(
      (await sqlOf(c)<(PreviousMachine & { televend_id: string })[]>`
        select televend_id::text, last_refill_at, caption, enabled, last_seen_at from tv_machine`).map((r) => [Number(r.televend_id), r] as const),
    );
    const now = nowOf(c);
    const todayStart = dubaiDay(dubaiDate(now)).from;
    const reads: RefillRead[] = [];
    for (const m of list) {
      const before = previous.get(m.televendId);
      if (!before) {
        // First sight: today's refills only — older days are a backfill's.
        if (m.lastRefillAt && m.lastRefillAt >= todayStart) reads.push({ televendId: m.televendId, days: [dubaiDate(now)], reason: "first_sight" });
      } else if (m.lastRefillAt && (!before.last_refill_at || m.lastRefillAt > before.last_refill_at)) {
        // Everything after the previous sync is new: from that sync's day to the refill's.
        reads.push({ televendId: m.televendId, days: refillDays(before.last_seen_at, m.lastRefillAt), reason: "refilled" });
      } else if (before.enabled && !m.enabled) {
        // Disabled since the previous sync (G160): read its log since then once — an emptying at
        // 23:57 seen by the 00:05 sync is on the day before.
        reads.push({ televendId: m.televendId, days: refillDays(before.last_seen_at, now), reason: "disabled" });
      }
    }
    return { run, at: now, list, previous, reads };
  } catch (err) {
    await run.finish({ status: "error", complete: false, error: errorText(err) });
    throw err;
  }
}

/**
 * Save what the machines list said — AFTER the refill reads it called for. A record whose read
 * failed keeps its previous enabled flag, last refill and last-seen time, so the next run asks for
 * the same read again; saving the new state first lost the read for good (review 2026-10-15).
 */
async function saveMachines(c: SyncContext, plan: MachinesPlan, unread: ReadonlySet<number>): Promise<MachinesResult> {
  const sql = sqlOf(c);
  try {
    let fresh = 0;
    let renamed = 0;
    for (const m of plan.list) {
      const before = plan.previous.get(m.televendId);
      if (!before) fresh++;
      else if (before.caption !== m.caption) renamed++;
      const keep = before !== undefined && unread.has(m.televendId);
      const enabled = keep ? before.enabled : m.enabled;
      const lastRefillAt = keep ? before.last_refill_at : m.lastRefillAt;
      const asset = assetNumber(m.caption);
      // last_seen_at is the sync's own clock, not the database's: it starts the next run's refill
      // days, so it must be the time this list was read (and replayable with an injected clock).
      await sql`
        insert into tv_machine (televend_id, caption, asset_no, enabled, pid, external_id, location_id, location_caption, city,
          region_caption, machine_type_caption, stock_tracking, last_vend_at, last_refill_at, stock_percent, last_status,
          connection_status, signal_strength, raw, last_seen_at)
        values (${m.televendId}, ${m.caption}, ${asset}, ${enabled}, ${m.pid}, ${m.externalId}, ${m.locationId}, ${m.locationCaption},
          ${m.city}, ${m.regionCaption}, ${m.machineTypeCaption}, ${m.stockTracking}, ${m.lastVendAt}, ${lastRefillAt},
          ${m.stockPercent}, ${m.lastStatus}, ${m.connectionStatus}, ${m.signalStrength}, ${sql.json((m.raw ?? {}) as never)}, ${plan.at})
        on conflict (televend_id) do update set
          caption = excluded.caption, asset_no = excluded.asset_no, enabled = excluded.enabled, pid = excluded.pid,
          external_id = excluded.external_id, location_id = excluded.location_id, location_caption = excluded.location_caption,
          city = excluded.city, region_caption = excluded.region_caption, machine_type_caption = excluded.machine_type_caption,
          stock_tracking = excluded.stock_tracking, last_vend_at = excluded.last_vend_at, last_refill_at = excluded.last_refill_at,
          stock_percent = excluded.stock_percent, last_status = excluded.last_status,
          connection_status = excluded.connection_status, signal_strength = excluded.signal_strength,
          raw = excluded.raw,
          last_seen_at = case when ${keep}::boolean then tv_machine.last_seen_at else excluded.last_seen_at end`;
      await sql`
        insert into tv_machine_caption (televend_id, caption) values (${m.televendId}, ${m.caption})
        on conflict (televend_id, caption) do update set last_seen_at = now()`;
      await placeMachine(sql, m.televendId, asset, m.caption, enabled);
    }
    await plan.run.finish({ status: "ok", complete: true, rowsRead: plan.list.length, rowsNew: fresh, rowsChanged: renamed });
    return { machines: plan.list.length, enabled: plan.list.filter((m) => m.enabled).length, refillReads: plan.reads, renamed };
  } catch (err) {
    await plan.run.finish({ status: "error", complete: false, error: errorText(err) });
    throw err;
  }
}

/** Read and save the machines list in one go; the refill reads it calls for are returned, not performed. */
export async function syncMachines(c: SyncContext, transport: Transport = "bridge"): Promise<MachinesResult> {
  return saveMachines(c, await readMachines(c, transport), new Set());
}

/**
 * Keep the physical-machine registry in step: an enabled Televend machine with an asset number
 * is one physical machine (created on first sight); a disabled one has no open placement.
 * A Televend record whose asset number changed is closed and re-placed.
 */
async function placeMachine(sql: Db, tvId: number, asset: number | null, caption: string, enabled: boolean): Promise<void> {
  const open = (await sql<{ id: string; machine_id: string; asset_no: number | null }[]>`
    select p.id, p.machine_id, m.asset_no from machine_placement p join machine m on m.id = p.machine_id
    where p.tv_machine_id = ${tvId} and p.valid_to is null`)[0];
  if (!enabled || asset === null) {
    if (open) await sql`update machine_placement set valid_to = now() where id = ${open.id}`;
    return;
  }
  if (open && open.asset_no === asset) {
    // Same machine: keep its label in step with Televend's name unless someone set it by hand.
    await sql`update machine set label = ${caption}, updated_at = now() where id = ${open.machine_id} and not label_manual and label <> ${caption}`;
    return;
  }
  if (open) await sql`update machine_placement set valid_to = now() where id = ${open.id}`;
  const machine = (await sql<{ id: string }[]>`
    insert into machine (asset_no, label) values (${asset}, ${caption})
    on conflict (asset_no) do update set
      label = case when machine.label_manual then machine.label else excluded.label end,
      updated_at = now()
    returning id`)[0];
  if (machine) {
    await sql`insert into machine_placement (machine_id, tv_machine_id, source) values (${machine.id}, ${tvId}, 'televend_sync')`;
  }
}

// ── Vends, events, refills ─────────────────────────────────────────────────────

async function upsertVends(sql: Db, transport: "bridge" | "official", rows: TvVend[]): Promise<number> {
  let fresh = 0;
  for (const v of rows) {
    const deviceVendId = (v.raw as { televend_device_vend_id?: unknown } | undefined)?.televend_device_vend_id;
    const r = await sql`
      insert into tv_vend (source, external_id, machine_tv_id, at, product, payment_type, payment_caption, value, column_no,
        quantity, price_list, device_vend_id, raw)
      values (${transport}, ${String(v.televendId)}, ${v.machineTelevendId}, ${v.at}, ${v.product}, ${v.paymentType},
        ${v.paymentTypeCaption}, ${v.value}, ${v.column}, ${v.quantity}, ${v.priceList},
        ${typeof deviceVendId === "number" ? deviceVendId : null}, ${sql.json((v.raw ?? {}) as never)})
      on conflict (source, external_id) do nothing`;
    fresh += r.count;
  }
  return fresh;
}

const kindOf = (e: TvEvent): "alarm" | "warning" | "info" | "unknown" =>
  (typeof e.level === "number" ? EVENT_LEVEL[e.level] : undefined) ?? "unknown";

async function upsertEvents(sql: Db, transport: "bridge" | "official", rows: TvEvent[]): Promise<{ fresh: number; changed: number }> {
  let fresh = 0;
  let changed = 0;
  for (const e of rows) {
    if (e.televendId === null) continue;
    const r = await sql<{ inserted: boolean }[]>`
      insert into tv_event (source, external_id, machine_tv_id, level, kind, type_code, source_code, name, description,
        started_at, resolved_at, counter, raw)
      values (${transport}, ${String(e.televendId)}, ${e.machineTelevendId}, ${e.level}, ${kindOf(e)},
        ${e.type === null ? null : String(e.type)}, ${e.source === null ? null : String(e.source)}, ${e.name}, ${e.description},
        ${e.startedAt}, ${e.resolvedAt}, ${e.counter}, ${sql.json((e.raw ?? {}) as never)})
      on conflict (source, external_id) do update set
        resolved_at = excluded.resolved_at, counter = excluded.counter, raw = excluded.raw, last_seen_at = now()
      where tv_event.resolved_at is distinct from excluded.resolved_at or tv_event.counter is distinct from excluded.counter
      returning (xmax = 0) as inserted`;
    const row = r[0];
    if (row?.inserted) fresh++;
    else if (row) changed++;
  }
  return { fresh, changed };
}

async function upsertRefills(sql: Db, source: "bridge" | "official" | "file", rows: TvRefill[]): Promise<number> {
  let fresh = 0;
  for (const r of rows) {
    const res = await sql`
      insert into tv_refill (source, natural_key, machine_tv_id, machine_caption, at, filled_by, role, column_no, product, action,
        quantity_change, quantity_after, capacity, origin, raw)
      values (${source}, ${refillKey(r)}, ${r.machineTelevendId}, ${r.machineCaption}, ${r.at}, ${r.filledBy}, ${r.role}, ${r.column},
        ${r.product}, ${r.action}, ${r.quantityChange}, ${r.quantityAfter}, ${r.capacity}, ${r.origin},
        ${sql.json((r.raw ?? {}) as never)})
      on conflict do nothing`;
    // No conflict target on purpose: a row matching EITHER identity is the same refill — the key
    // shared with the exports (0023) or Televend's own identity of an API row (0024), which still
    // holds after a record's name changes number or a refill code gets its meaning.
    fresh += res.count;
  }
  return fresh;
}

/**
 * Rows stored while their refill code or origin had no meaning are re-read against the current
 * code tables. Once a code is mapped (G161) the stored row takes its action and its new key, so
 * reads of the same refill match it instead of adding a twin; a row whose new key already belongs
 * to another row is left as it is and counted for a person to look at.
 */
export async function remapUnknownRefills(sql: Db): Promise<{ remapped: number; clashes: number }> {
  const rows = await sql<
    {
      id: string;
      machine_tv_id: string | null;
      machine_caption: string | null;
      at: Date;
      column_no: number | null;
      quantity_change: string;
      action: TvRefill["action"];
      origin: TvRefill["origin"];
      raw: { fill_type?: unknown; source?: unknown } | null;
    }[]
  >`
    select id, machine_tv_id::text, machine_caption, at, column_no, quantity_change, action, origin, raw
    from tv_refill where action = 'unknown' or origin = 'unknown'`;
  let remapped = 0;
  let clashes = 0;
  for (const r of rows) {
    const code = typeof r.raw?.fill_type === "number" ? r.raw.fill_type : null;
    const from = typeof r.raw?.source === "number" ? r.raw.source : null;
    const action = r.action !== "unknown" ? r.action : (code !== null ? REFILL_FILL_TYPE[code] : undefined) ?? "unknown";
    const origin = r.origin !== "unknown" ? r.origin : (from !== null ? REFILL_SOURCE[from] : undefined) ?? "unknown";
    if (action === r.action && origin === r.origin) continue;
    const key = refillKey({
      machineTelevendId: r.machine_tv_id === null ? null : Number(r.machine_tv_id),
      machineCaption: r.machine_caption,
      at: r.at,
      column: r.column_no,
      action,
      quantityChange: Number(r.quantity_change),
    });
    const res = await sql`
      update tv_refill set action = ${action}, origin = ${origin}, natural_key = ${key}
      where id = ${r.id} and not exists (select 1 from tv_refill o where o.natural_key = ${key} and o.id <> ${r.id})`;
    if (res.count) remapped++;
    else clashes++;
  }
  return { remapped, clashes };
}

export interface WindowResult {
  window: DateRange;
  read: number;
  fresh: number;
  changed: number;
  complete: boolean;
  televendCount?: number | null;
  /** Set when this stream failed inside a day check; its run row says `error` and the other streams still ran. */
  error?: string;
  /** Not asked in this day check (already complete, or out of attempts). */
  skipped?: boolean;
}

export async function syncVendsWindow(c: SyncContext, window: DateRange, mode: Mode, transport: "bridge" | "official" = "bridge"): Promise<WindowResult> {
  const run = await startRun(c, "vends", mode, transport, window);
  try {
    const r = await c.source.vends(window, { maxRows: 50_000 });
    if (!r) throw new Error(`the ${c.source.transport} transport has no vends`);
    const fresh = await upsertVends(sqlOf(c), transport, r.rows);
    let complete = r.complete;
    let televendCount: number | null = null;
    // A whole day can be checked against Televend's own count (G147: only whole days).
    if (mode !== "incremental" && isWholeDubaiDays(window)) {
      const totals = await c.source.vendTotals(window);
      televendCount = totals?.vends ?? null;
      if (televendCount !== null) complete = complete && new Set(r.rows.map((v) => v.televendId)).size === televendCount;
    }
    await run.finish({ status: complete ? "ok" : "partial", complete, rowsRead: r.rows.length, rowsNew: fresh, televendCount });
    return { window, read: r.rows.length, fresh, changed: 0, complete, televendCount };
  } catch (err) {
    await run.finish({ status: "error", complete: false, error: errorText(err) });
    throw err;
  }
}

export async function syncEventsWindow(c: SyncContext, window: DateRange, mode: Mode, transport: "bridge" | "official" = "bridge"): Promise<WindowResult> {
  const run = await startRun(c, "events", mode, transport, window);
  try {
    const r = await c.source.events(window, { maxRows: 50_000 });
    if (!r) throw new Error(`the ${c.source.transport} transport has no events`);
    const { fresh, changed } = await upsertEvents(sqlOf(c), transport, r.rows);
    await run.finish({ status: r.complete ? "ok" : "partial", complete: r.complete, rowsRead: r.rows.length, rowsNew: fresh, rowsChanged: changed });
    return { window, read: r.rows.length, fresh, changed, complete: r.complete };
  } catch (err) {
    await run.finish({ status: "error", complete: false, error: errorText(err) });
    throw err;
  }
}

/** Refills on one business day — for the given machines, or every machine record, enabled or not (G160). */
export async function syncRefillsDay(
  c: SyncContext,
  day: string,
  mode: Mode,
  machineIds?: readonly number[],
  transport: "bridge" | "official" = "bridge",
): Promise<WindowResult> {
  const window = dubaiDay(day);
  const run = await startRun(c, "refills", mode, transport, window);
  try {
    const rows = await c.source.refills(day, machineIds);
    if (!rows) throw new Error(`the ${c.source.transport} transport has no refills`);
    await remapUnknownRefills(sqlOf(c)); // before the upsert, so a newly mapped code meets its stored row (G161)
    const fresh = await upsertRefills(sqlOf(c), transport, rows);
    // A day is complete only when every machine record was asked — disabled ones too: a record
    // disabled since keeps its refill log but not its last_refill (G160).
    const complete = machineIds === undefined;
    await run.finish({ status: "ok", complete, rowsRead: rows.length, rowsNew: fresh });
    return { window, read: rows.length, fresh, changed: 0, complete };
  } catch (err) {
    await run.finish({ status: "error", complete: false, error: errorText(err) });
    throw err;
  }
}

export function isWholeDubaiDays(w: DateRange): boolean {
  const offset = 4 * 3_600_000;
  const day = 86_400_000;
  return (w.from.getTime() + offset) % day === 0 && (w.to.getTime() + offset) % day === 0 && w.to > w.from;
}

/** The business day (Asia/Dubai) an instant falls in, as YYYY-MM-DD. */
export function dubaiDate(d: Date): string {
  return new Date(d.getTime() + 4 * 3_600_000).toISOString().slice(0, 10);
}

// ── The 10-minute sync ─────────────────────────────────────────────────────────

async function cursor(sql: Db, stream: "vends" | "events" | "refills"): Promise<Date | null> {
  const r = await sql<{ read_until: Date }[]>`select read_until from tv_sync_cursor where stream = ${stream}`;
  return r[0]?.read_until ?? null;
}

async function moveCursor(sql: Db, stream: "vends" | "events" | "refills", to: Date): Promise<void> {
  await sql`
    insert into tv_sync_cursor (stream, read_until) values (${stream}, ${to})
    on conflict (stream) do update set read_until = greatest(tv_sync_cursor.read_until, excluded.read_until), updated_at = now()`;
}

export const DAY_STREAMS = ["vends", "events", "refills"] as const;
export type DayStream = (typeof DAY_STREAMS)[number];

/** A whole day re-read stream by stream; `errors` names the streams that failed (the others still ran). */
export interface DayCheck {
  day: string;
  vends: WindowResult;
  events: WindowResult;
  refills: WindowResult;
  errors: string[];
}

export interface SyncResult {
  machines: MachinesResult;
  vends: WindowResult;
  events: WindowResult;
  refills: WindowResult | null;
  dailyCheck: DayCheck | null;
}

/**
 * Thrown at the END of a run when any stream failed. Every other stream's work is already saved
 * (its tv_sync_run row says ok); the job is marked failed so the failure is seen, and the next
 * run retries what failed.
 */
export class TelevendSyncError extends Error {
  constructor(readonly failures: readonly string[]) {
    super(`Televend sync: ${failures.join("; ")}`);
    this.name = "TelevendSyncError";
  }
}

/** Open alarms re-checked per run: each cluster of starts is one short window read (≈1 request). */
export const OPEN_ALARM_WINDOWS_PER_RUN = 12;
const OPEN_ALARM_CLUSTER_MS = 10 * 60_000;

/**
 * Televend resolves an alarm long after it started — the ones that matter typically 3–7 hours later —
 * but the incremental read re-reads only the last hour of starts and the daily check reads yesterday
 * once. So an alarm that cleared after both had moved on stayed open here for good: the command centre
 * showed the machine as needing someone and its problem never closed (review 2026-10-17,
 * command-centre#1). Televend has no "still open" list (asked without a window it answers 400, and a
 * 14-day window timed out, 502 — measured 2026-10-17), so: each run re-reads the short windows around
 * the starts of the alarms still open here, the ones checked longest ago first, a bounded number per
 * run. With ~50 open alarms that is every alarm within about four runs (≈40 minutes).
 */
export async function refreshOpenAlarms(
  c: SyncContext,
  before: Date,
  opts: { maxWindows?: number } = {},
): Promise<{ windows: number; checked: number; cleared: number; complete: boolean; failed: number }> {
  const sql = sqlOf(c);
  const now = nowOf(c);
  // The last 14 days — and, whatever its age, an alarm behind a problem still open: a machine unplugged for three weeks
  // must close its problem when Televend clears the alarm (review, 20 Oct).
  const open = await sql<{ external_id: string; started_at: Date; checked_at: Date | null }[]>`
    select e.external_id, e.started_at, e.checked_at from tv_event e
     where e.source = 'bridge' and e.kind in ('alarm', 'warning') and e.resolved_at is null and e.started_at < ${before}
       and (e.started_at > ${now}::timestamptz - interval '14 days'
            or exists (select 1 from machine_alarm ma join blocker b on b.id = ma.blocker_id
                        where ma.event_source = e.source and ma.event_id = e.external_id and b.status in ('open', 'acknowledged')))
     order by e.started_at
     limit 2000`;
  // Starts within 10 minutes of a cluster's first share one window.
  const clusters: { from: Date; to: Date; ids: string[]; checked: number }[] = [];
  for (const e of open) {
    const last = clusters[clusters.length - 1];
    const checked = e.checked_at?.getTime() ?? 0;
    if (last && e.started_at.getTime() - last.from.getTime() <= OPEN_ALARM_CLUSTER_MS) {
      last.to = e.started_at;
      last.ids.push(e.external_id);
      last.checked = Math.min(last.checked, checked);
    } else {
      clusters.push({ from: e.started_at, to: e.started_at, ids: [e.external_id], checked });
    }
  }
  const due = clusters.sort((a, b) => a.checked - b.checked || a.from.getTime() - b.from.getTime()).slice(0, opts.maxWindows ?? OPEN_ALARM_WINDOWS_PER_RUN);
  let cleared = 0;
  let checked = 0;
  let complete = true;
  const failures: string[] = [];
  for (const k of due) {
    // A second either side: Televend's times are whole seconds.
    const window = { from: new Date(k.from.getTime() - 1_000), to: new Date(k.to.getTime() + 1_000) };
    try {
      const r = await c.source.events(window, { maxRows: 2_000 });
      if (!r) throw new Error(`the ${c.source.transport} transport has no events`);
      await upsertEvents(sql, "bridge", r.rows);
      complete &&= r.complete;
      // A read that stopped short says nothing of the alarms it did not return: only those it did are checked.
      const seen = new Set(r.rows.map((row) => String(row.televendId)));
      const ids = r.complete ? k.ids : k.ids.filter((x) => seen.has(x));
      const after = await sql<{ n: number }[]>`
        update tv_event set checked_at = ${now}
         where source = 'bridge' and external_id = any(${ids}) returning (resolved_at is not null)::int as n`;
      cleared += after.reduce((s, x) => s + x.n, 0);
      checked += ids.length;
    } catch (err) {
      // One window failing every run must not stop the others (review, 20 Oct): it goes to the back of the queue, the rest
      // are read, and the run still ends in an error so the failure is seen.
      failures.push(`${window.from.toISOString()}: ${err instanceof Error ? err.message : String(err)}`);
      await sql`update tv_event set checked_at = ${now} where source = 'bridge' and external_id = any(${k.ids})`;
    }
  }
  if (failures.length > 0) {
    throw new Error(`${failures.length} of ${due.length} open-alarm windows could not be read (the others were): ${failures.slice(0, 3).join("; ")}`);
  }
  return { windows: due.length, checked, cleared, complete, failed: failures.length };
}

export const DAILY_CHECK_HOUR = 4; // 04:00 Asia/Dubai: after the night shift's last machines
export const DAILY_CHECK_MAX_ATTEMPTS = 3;

/**
 * One incremental sync:
 *   1. the machines list, then the refill logs it calls for, then the machines' new state — in
 *      that order, so a refill read that fails is asked for again next run;
 *   2. vends and events since their cursors (with overlap), each on its own;
 *   3. once a day after DAILY_CHECK_HOUR, yesterday re-read whole, stream by stream.
 * One stream failing never stops the others; the run then ends with a TelevendSyncError.
 */
export async function runIncrementalSync(c: SyncContext): Promise<SyncResult> {
  const sql = sqlOf(c);
  const now = nowOf(c);
  const settled = new Date(now.getTime() - SETTLE_MS);
  const failures: string[] = [];
  async function attempt<T>(what: string, f: () => Promise<T>): Promise<T | null> {
    try {
      return await f();
    } catch (err) {
      failures.push(`${what}: ${errorText(err)}`);
      return null;
    }
  }

  // 1. Refills are read per record and per business day, before the machines' state is saved.
  const plan = await readMachines(c, "bridge");
  const byDay = new Map<string, number[]>();
  for (const r of plan.reads) for (const d of r.days) byDay.set(d, [...(byDay.get(d) ?? []), r.televendId]);
  const unread = new Set<number>();
  const refillResults: WindowResult[] = [];
  for (const [day, ids] of [...byDay].sort(([a], [b]) => a.localeCompare(b))) {
    const r = await attempt(`refills ${day}`, () => syncRefillsDay(c, day, "incremental", ids));
    if (r) refillResults.push(r);
    else for (const id of ids) unread.add(id);
  }
  const machines = await saveMachines(c, plan, unread);

  // 2. Vends and events since their cursors; a cursor moves only after a complete read.
  const vends = await attempt("vends", async () => {
    const at = await cursor(sql, "vends");
    const from = new Date(Math.max((at?.getTime() ?? now.getTime() - FIRST_RUN_LOOKBACK_MS) - VEND_OVERLAP_MS, now.getTime() - 48 * 3_600_000));
    const r = await syncVendsWindow(c, { from, to: settled }, "incremental");
    if (r.complete) await moveCursor(sql, "vends", settled);
    return r;
  });
  let eventsFrom = settled;
  const events = await attempt("events", async () => {
    const at = await cursor(sql, "events");
    const from = new Date(Math.max((at?.getTime() ?? now.getTime() - FIRST_RUN_LOOKBACK_MS) - EVENT_OVERLAP_MS, now.getTime() - 48 * 3_600_000));
    eventsFrom = from;
    const r = await syncEventsWindow(c, { from, to: settled }, "incremental");
    if (r.complete) await moveCursor(sql, "events", settled);
    return r;
  });
  // Alarms that started before this run's window and are still open here: has Televend cleared them?
  if (events) await attempt("open alarms", () => refreshOpenAlarms(c, eventsFrom));

  // 3. Yesterday, stream by stream: a stream is re-read until it is complete, at most
  //    DAILY_CHECK_MAX_ATTEMPTS times — then left for a person rather than re-read for ever. Gating
  //    on vends alone skipped a failed refill read for good (review 2026-10-15).
  let dailyCheck: DayCheck | null = null;
  if (dubaiHour(now) >= DAILY_CHECK_HOUR) {
    const yesterday = dubaiDate(new Date(now.getTime() - 86_400_000));
    const todo = (await dayStreams(sql, yesterday))
      .filter((s) => !s.complete && s.dailyCheckAttempts < DAILY_CHECK_MAX_ATTEMPTS)
      .map((s) => s.stream);
    if (todo.length > 0) {
      dailyCheck = await checkDay(c, yesterday, "daily_check", todo);
      failures.push(...dailyCheck.errors.map((e) => `daily check ${yesterday} ${e}`));
    }
  }

  const first = refillResults[0];
  const refills: WindowResult | null = first
    ? {
        window: first.window,
        read: refillResults.reduce((s, r) => s + r.read, 0),
        fresh: refillResults.reduce((s, r) => s + r.fresh, 0),
        changed: 0,
        complete: refillResults.every((r) => r.complete),
      }
    : null;
  if (failures.length > 0 || !vends || !events) throw new TelevendSyncError(failures);
  return { machines, vends, events, refills, dailyCheck };
}

/** Per stream: is this whole day complete, and how many daily checks have tried it. */
async function dayStreams(sql: Db, day: string): Promise<{ stream: DayStream; complete: boolean; dailyCheckAttempts: number }[]> {
  const w = dubaiDay(day);
  const rows = await sql<{ stream: string; complete: number; attempts: number }[]>`
    select stream, count(*) filter (where complete)::int as complete, count(*) filter (where mode = 'daily_check')::int as attempts
    from tv_sync_run
    where mode in ('daily_check', 'backfill') and window_from = ${w.from} and window_to = ${w.to}
    group by stream`;
  const by = new Map(rows.map((r) => [r.stream, r] as const));
  return DAY_STREAMS.map((stream) => ({
    stream,
    complete: (by.get(stream)?.complete ?? 0) > 0,
    dailyCheckAttempts: by.get(stream)?.attempts ?? 0,
  }));
}

/**
 * Re-read a whole past day: vends (checked against Televend's own count), events, and the refills
 * of every machine record. Each stream on its own — one that fails is recorded and the others run.
 */
export async function checkDay(
  c: SyncContext,
  day: string,
  mode: "daily_check" | "backfill",
  streams: readonly DayStream[] = DAY_STREAMS,
): Promise<DayCheck> {
  const window = dubaiDay(day);
  const skipped: WindowResult = { window, read: 0, fresh: 0, changed: 0, complete: false, skipped: true };
  const errors: string[] = [];
  const one = async (s: DayStream, f: () => Promise<WindowResult>): Promise<WindowResult> => {
    if (!streams.includes(s)) return skipped;
    try {
      return await f();
    } catch (err) {
      const e = errorText(err);
      errors.push(`${s}: ${e}`);
      return { window, read: 0, fresh: 0, changed: 0, complete: false, error: e };
    }
  };
  const vends = await one("vends", () => syncVendsWindow(c, window, mode));
  const events = await one("events", () => syncEventsWindow(c, window, mode));
  const refills = await one("refills", () => syncRefillsDay(c, day, mode));
  return { day, vends, events, refills, errors };
}

/** "vends complete · refills failed" — only the streams this day check actually ran. */
export function describeDayCheck(d: DayCheck): string {
  return DAY_STREAMS.filter((s) => !d[s].skipped)
    .map((s) => `${s} ${d[s].error ? "failed" : d[s].complete ? "complete" : "INCOMPLETE"}`)
    .join(" · ");
}

/**
 * Backfill whole past days, newest first, skipping streams whose day is already complete.
 * Bounded by `maxRequests` (stops between days, resumable: run it again).
 */
export async function backfillDays(
  c: SyncContext,
  p: { from: string; to: string; streams: readonly DayStream[]; maxRequests: number; onDay?: (line: string) => void },
): Promise<{ days: number; stoppedAt: string | null }> {
  const sql = sqlOf(c);
  const start = reqs(c);
  let days = 0;
  for (let t = dubaiDay(p.to).from.getTime(); t >= dubaiDay(p.from).from.getTime(); t -= 86_400_000) {
    const day = dubaiDate(new Date(t));
    if (reqs(c) - start >= p.maxRequests) return { days, stoppedAt: day };
    const done = new Set((await dayStreams(sql, day)).filter((s) => s.complete).map((s) => s.stream));
    const todo = p.streams.filter((s) => !done.has(s));
    if (todo.length === 0) continue;
    const r = await checkDay(c, day, "backfill", todo);
    days++;
    p.onDay?.(
      `${day}: ` +
        todo
          .map((s) => {
            const x = r[s];
            return `${s} ${x.read} read, ${x.fresh} new${x.complete ? "" : x.error ? ` (failed: ${x.error})` : " (incomplete)"}`;
          })
          .join(" · "),
    );
  }
  return { days, stoppedAt: null };
}

// ── Health ─────────────────────────────────────────────────────────────────────

export interface TelevendHealth {
  configured: boolean;
  lastSyncAt: string | null;
  lastSyncOk: boolean | null;
  lagMinutes: number | null;
  stale: boolean | null;
  lastError: string | null;
  /**
   * From an hour after the daily check (05:00 Dubai): yesterday's streams that are still not
   * complete — a daily check that failed shows here instead of nowhere. Null before then.
   */
  yesterdayIncomplete: DayStream[] | null;
}

/** For /health: when Televend was last read, whether that is too long ago (> 30 min), and yesterday's gaps. */
export async function televendHealth(configured: boolean, now: Date = new Date()): Promise<TelevendHealth> {
  if (!configured) {
    return { configured: false, lastSyncAt: null, lastSyncOk: null, lagMinutes: null, stale: null, lastError: null, yesterdayIncomplete: null };
  }
  const sql = getServiceSql();
  const last = (await sql<{ finished_at: Date | null; status: string; error: string | null }[]>`
    select finished_at, status, error from tv_sync_run where mode = 'incremental' and stream = 'events'
    order by started_at desc limit 1`.catch(() => []))[0];
  const ok = (await sql<{ finished_at: Date | null }[]>`
    select finished_at from tv_sync_run where mode = 'incremental' and stream = 'events' and status = 'ok'
    order by started_at desc limit 1`.catch(() => []))[0];
  const lag = ok?.finished_at ? Math.round((now.getTime() - ok.finished_at.getTime()) / 60_000) : null;
  const yesterdayIncomplete =
    dubaiHour(now) >= DAILY_CHECK_HOUR + 1
      ? await dayStreams(sql, dubaiDate(new Date(now.getTime() - 86_400_000)))
          .then((ss) => ss.filter((s) => !s.complete).map((s) => s.stream))
          .catch(() => null)
      : null;
  return {
    configured: true,
    lastSyncAt: last?.finished_at?.toISOString() ?? null,
    lastSyncOk: last ? last.status === "ok" : null,
    lagMinutes: lag,
    stale: lag === null ? null : lag > 30,
    lastError: last?.status === "error" ? last.error : null,
    yesterdayIncomplete,
  };
}
