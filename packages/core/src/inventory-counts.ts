import { getServiceSql, type Tx } from "./db.js";
import {
  InventoryRefused,
  PLACE,
  correlationOf,
  fmt,
  fromMilli,
  parseQty,
  requestHash,
  requireCan,
  toMilli,
} from "./inventory-ledger.js";
import type { ViewerOrg } from "./org.js";
import { can } from "./permissions.js";
import { noticeCount, noticeLowStock, warehouseItemsOf } from "./inventory-notify.js";

/**
 * Counting the warehouse (TASK-060, D218).
 *
 *   startCount      the keeper opens a count — the screen lists the items, never the system's figures
 *   submitCount     each line is compared with the ledger at that moment:
 *                     all equal                          → closed, nothing to decide
 *                     only small differences             → approval
 *                     a big difference, or the item moved while it was counted → recount
 *   startRecount /
 *   submitRecount   someone else counts those lines again, also without the figures
 *   waiveRecount    an approver lets the recount go, with a reason (one keeper on shift, say)
 *   decideCount     the Ops Head, the CEO or an Admin — never someone who counted — decides each
 *                   differing line: the count is right (an adjustment is posted, with a reason) or the
 *                   ledger is (nothing moves)
 *
 * "Blind" here means the count screen does not show the ledger. Anyone who may open the stock screen
 * can still look first, so the control is the second person, not the screen (D228).
 */

export const COUNT_KINDS = ["opening", "after_handout", "closing", "spot"] as const;
export type CountKind = (typeof COUNT_KINDS)[number];
export const COUNT_DECISION_REASONS = [
  "opening_balance",
  "used_unrecorded",
  "damaged_unrecorded",
  "delivery_difference",
  "earlier_miscount",
  "found",
  "unexplained",
] as const;
export type CountDecisionReason = (typeof COUNT_DECISION_REASONS)[number];

/** A count left open this long blocks nobody: the next one closes it as abandoned. */
const STALE_HOURS = 12;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CountItem {
  id: string;
  name: string;
  unit: string;
  step: number;
  icon: string | null;
}

export interface CountStep {
  sessionId: string;
  state: "counting" | "recount" | "approval" | "closed" | "cancelled";
  replay: boolean;
}

interface SessionRow {
  id: string;
  location_id: string;
  kind: CountKind;
  state: CountStep["state"];
  started_by: string;
  started_at: Date;
  submitted_at: Date | null;
  recount_by: string | null;
  recount_started_at: Date | null;
  recounted_at: Date | null;
  recount_waived_by: string | null;
  decided_by: string | null;
  is_synthetic: boolean;
}

async function lockSession(tx: Tx, sessionId: string): Promise<SessionRow> {
  if (!UUID_RE.test(sessionId)) throw new InventoryRefused("No such count.", 404, "no_count");
  const [s] = await tx<SessionRow[]>`
    select id, location_id, kind, state, started_by, started_at, submitted_at, recount_by, recount_started_at, recounted_at,
           recount_waived_by, decided_by, is_synthetic
      from count_session where id = ${sessionId} for update`;
  if (!s) throw new InventoryRefused("No such count.", 404, "no_count");
  return s;
}

async function lockItems(tx: Tx, itemIds: readonly string[]): Promise<void> {
  for (const id of [...new Set(itemIds)].sort()) await tx`select pg_advisory_xact_lock(hashtextextended(${`inventory:${id}`}, 0))`;
}

async function auditIn(tx: Tx, correlationId: string, actor: string, action: string, sessionId: string, detail: Record<string, unknown>): Promise<void> {
  await tx`
    insert into audit_log (correlation_id, actor, action, entity, entity_id, detail)
    values (${correlationId}, ${actor}, ${action}, 'count_session', ${sessionId}, ${tx.json(detail as never)})`;
}

async function activeItems(tx: Tx): Promise<CountItem[]> {
  const rows = await tx<{ id: string; name: string; unit: string; step: string; icon: string | null }[]>`
    select id, name, unit, step::text as step, icon from inv_item where active order by sort_order, lower(name)`;
  return rows.map((r) => ({ id: r.id, name: r.name, unit: r.unit, step: Number(r.step), icon: r.icon }));
}

interface Counted {
  item: CountItem;
  milli: number;
}

/** Do the figures sent match the figures stored — each item once, the same amount? */
function sameFigures(sent: readonly { itemId: string; qty: number | string }[], stored: readonly { itemId: string; milli: number }[]): boolean {
  if (sent.length !== stored.length) return false;
  const byItem = new Map(stored.map((s) => [s.itemId, s.milli]));
  return sent.every((l) => {
    const want = byItem.get(l.itemId);
    if (want === undefined) return false;
    try {
      return parseQty(l.qty, "count", true) === want;
    } catch {
      return false;
    }
  });
}

/** Every amount a whole number of the item's steps; each item once; only items still in use. */
function checkCounted(items: ReadonlyMap<string, CountItem>, lines: readonly { itemId: string; qty: number | string }[]): Counted[] {
  const seen = new Set<string>();
  return lines.map((l) => {
    const item = items.get(l.itemId);
    if (!item) throw new InventoryRefused("Count only the items on the list.", 400, "bad_item");
    if (seen.has(l.itemId)) throw new InventoryRefused("Each item once.", 400, "duplicate_item");
    seen.add(l.itemId);
    const milli = parseQty(l.qty, `count of ${item.name}`, true);
    if (milli % toMilli(item.step) !== 0) throw new InventoryRefused(`${item.name} is counted in steps of ${fmt(toMilli(item.step), item.unit)}.`, 400, "bad_step");
    return { item, milli };
  });
}

/**
 * What the place holds of each item now, whether it moved since `since`, and whether it is on a handover
 * still on its way in or out (waiting, or partly accepted) — read under the item locks. Stock in transit
 * has left the place on the books but may still be on the shelf (not yet collected; a return not yet
 * confirmed): a count that differs then cannot say which (TASK-060 review).
 */
async function ledgerNow(
  tx: Tx,
  placeId: string,
  itemIds: readonly string[],
  since: { sessionId: string; recount: boolean },
): Promise<Map<string, { milli: number; moved: boolean; inTransit: boolean }>> {
  // "Since" is read from the session in SQL: a time round-tripped through JavaScript loses its microseconds (G202), and a
  // move posted a moment before the count began would read as made during it.
  const rows = await tx<{ item_id: string; qty: string | null; moved: boolean; in_transit: boolean }[]>`
    with since as (
      select case when ${since.recount} then coalesce(recount_started_at, started_at) else started_at end as t
        from count_session where id = ${since.sessionId}
    )
    select i.id as item_id,
           (select b.qty::text from stock_balance b where b.location_id = ${placeId} and b.item_id = i.id) as qty,
           exists (select 1 from stock_move m
                    where m.item_id = i.id and (m.from_location_id = ${placeId} or m.to_location_id = ${placeId})
                      and m.posted_at > (select t from since)) as moved,
           -- On its way only while some of THIS item is still in transit on the handover: a partly accepted handover's
           -- other items arrived in full (review, 20 Oct).
           exists (select 1 from stock_doc d join stock_move m on m.doc_id = d.id
                    where m.item_id = i.id and d.kind = 'handover' and d.state in ('waiting', 'part_accepted')
                      and (d.from_location_id = ${placeId} or d.to_location_id = ${placeId})
                    group by d.id
                   having sum(case when m.to_location_id = ${PLACE.inTransit} then m.qty when m.from_location_id = ${PLACE.inTransit} then -m.qty else 0 end) > 0) as in_transit
      from inv_item i where i.id = any(${itemIds}::uuid[])`;
  return new Map(rows.map((r) => [r.item_id, { milli: r.qty === null ? 0 : toMilli(r.qty), moved: r.moved, inTransit: r.in_transit }]));
}

/** A line cannot be read as "the count is right" when the item moved meanwhile, or differs while some of it is in transit. */
const unclear = (l: { moved: boolean; inTransit: boolean }, counted: number, ledger: number): boolean => l.moved || (l.inTransit && counted !== ledger);

/** After a count moves on: who is told — best effort, as for every stock notice. */
async function afterCount<T extends CountStep & { adjustmentDocId?: string | null }>(step: T, what: "count" | "decision", correlationId: string): Promise<T> {
  if (step.replay) return step;
  try {
    await noticeCount(step.sessionId, correlationId);
    if (what === "decision" && step.adjustmentDocId) await noticeLowStock(await warehouseItemsOf(step.adjustmentDocId), { correlationId });
  } catch (err) {
    console.error("[inventory] a count notice failed", err);
  }
  return step;
}

// ── open a count ─────────────────────────────────────────────────────────────
export async function startCount(
  viewer: ViewerOrg,
  req: { id: string; kind: CountKind },
  opts: { correlationId?: string; now?: Date } = {},
): Promise<CountStep & { items: CountItem[]; resumed: boolean; kind: CountKind; startedAt: string }> {
  requireCan(viewer, "inventory.move", "Only the warehouse counts the warehouse.");
  if (!(COUNT_KINDS as readonly string[]).includes(req.kind)) throw new InventoryRefused("Unknown kind of count.", 400, "bad_kind");
  if (!UUID_RE.test(req.id)) throw new InventoryRefused("The count id must be a UUID made by the app.", 400, "bad_id");
  const correlationId = correlationOf(opts.correlationId);
  const now = opts.now ?? new Date();
  return getServiceSql().begin(async (tx) => {
    // One count of the warehouse at a time; a lock on the place keeps two from opening together.
    await tx`select pg_advisory_xact_lock(hashtextextended(${`count:${PLACE.warehouse}`}, 0))`;
    const [mine] = await tx<{ id: string; state: CountStep["state"]; started_by: string; kind: CountKind; started_at: Date }[]>`
      select id, state, started_by, kind, started_at from count_session where id = ${req.id}`;
    if (mine) {
      if (mine.started_by !== viewer.employeeId) throw new InventoryRefused("This count id was already used.", 409, "id_reused");
      return { sessionId: mine.id, state: mine.state, replay: true, resumed: true, kind: mine.kind, startedAt: mine.started_at.toISOString(), items: await activeItems(tx) };
    }
    const open = await tx<{ id: string; kind: CountKind; started_by: string; started_at: Date; display_name: string | null }[]>`
      select s.id, s.kind, s.started_by, s.started_at, e.display_name
        from count_session s left join employee e on e.id = s.started_by
       where s.location_id = ${PLACE.warehouse} and s.state = 'counting'`;
    for (const o of open) {
      if (now.getTime() - o.started_at.getTime() > STALE_HOURS * 3_600_000) {
        await tx`update count_session set state = 'cancelled' where id = ${o.id}`;
        await auditIn(tx, correlationId, "system", "stock.count_abandoned", o.id, { openHours: STALE_HOURS });
      } else if (o.started_by === viewer.employeeId) {
        // Their own count still open — of whatever kind it was opened as: the screen says which (TASK-060 review).
        return { sessionId: o.id, state: "counting" as const, replay: true, resumed: true, kind: o.kind, startedAt: o.started_at.toISOString(), items: await activeItems(tx) };
      } else {
        throw new InventoryRefused(`${o.display_name ?? "Someone"} is counting the warehouse now — wait until they hand it in.`, 409, "count_open");
      }
    }
    const synthetic = (await tx<{ s: boolean }[]>`select is_synthetic as s from employee where id = ${viewer.employeeId}`)[0]?.s ?? false;
    // The moment the count begins is the database's clock, under the count lock — a JavaScript time has no microseconds, and a
    // move posted in the same millisecond just before would read as made during the count (0040, G202). A test's fixed clock
    // is used as given.
    const [row] = await tx<{ started_at: Date }[]>`
      insert into count_session (id, location_id, kind, state, started_by, started_at, is_synthetic, correlation_id)
      values (${req.id}, ${PLACE.warehouse}, ${req.kind}, 'counting', ${viewer.employeeId}, coalesce(${opts.now ?? null}::timestamptz, clock_timestamp()),
              ${synthetic}, ${correlationId})
      returning started_at`;
    await auditIn(tx, correlationId, `employee:${viewer.employeeId}`, "stock.count_started", req.id, { kind: req.kind });
    return { sessionId: req.id, state: "counting" as const, replay: false, resumed: false, kind: req.kind, startedAt: row!.started_at.toISOString(), items: await activeItems(tx) };
  });
}

// ── hand in a count ──────────────────────────────────────────────────────────
export interface CountOutcome extends CountStep {
  lines: number;
  matched: number;
  /** Lines that differ but within the item's tolerance: decided without a recount. */
  small: number;
  /** Lines someone else counts again: a difference beyond tolerance, or the item moved meanwhile. */
  recount: number;
}

export async function submitCount(
  viewer: ViewerOrg,
  sessionId: string,
  req: { lines: readonly { itemId: string; qty: number | string }[] },
  opts: { correlationId?: string } = {},
): Promise<CountOutcome> {
  const correlationId = correlationOf(opts.correlationId);
  const done = await getServiceSql().begin(async (tx) => {
    const s = await lockSession(tx, sessionId);
    if (s.started_by !== viewer.employeeId || viewer.status !== "active") throw new InventoryRefused("Only the person who opened this count hands it in.", 403, "not_allowed");
    if (s.state !== "counting") {
      const stored = await tx<{ item_id: string; counted: string; expected: string; moved: boolean; tol: string }[]>`
        select l.item_id, l.counted_qty::text as counted, l.expected_qty::text as expected, l.moved_during as moved, i.count_tolerance::text as tol
          from count_line l join inv_item i on i.id = l.item_id where l.session_id = ${sessionId}`;
      if (s.state !== "cancelled" && stored.length > 0) {
        // The same hand-in sent twice is answered as before; different figures are refused, never
        // reported as handed in (TASK-060 review).
        if (!sameFigures(req.lines, stored.map((r) => ({ itemId: r.item_id, milli: toMilli(r.counted) })))) {
          throw new InventoryRefused("This count was already handed in, with other figures.", 409, "already_handed_in");
        }
        const out = { matched: 0, small: 0, recount: 0 };
        for (const r of stored) {
          const diff = Math.abs(toMilli(r.counted) - toMilli(r.expected));
          if (r.moved || diff > toMilli(r.tol)) out.recount++;
          else if (diff > 0) out.small++;
          else out.matched++;
        }
        return { sessionId, state: s.state, replay: true, lines: stored.length, ...out };
      }
      throw new InventoryRefused("This count is closed.", 409, "count_closed");
    }
    // Locked before they are read: an item's step cannot change under the count (saveItem takes the same lock).
    await lockItems(tx, req.lines.map((l) => l.itemId).filter((x) => UUID_RE.test(x)));
    const items = new Map((await activeItems(tx)).map((i) => [i.id, i]));
    const counted = checkCounted(items, req.lines);
    if (counted.length === 0) throw new InventoryRefused("Count at least one item.", 400, "no_lines");
    if (s.kind !== "spot" && counted.length !== items.size) {
      throw new InventoryRefused("A full count has a number for every item — 0 when there is none.", 400, "count_every_item");
    }
    const ledger = await ledgerNow(tx, s.location_id, counted.map((c) => c.item.id), { sessionId, recount: false });
    const tol = new Map(
      (await tx<{ id: string; t: string }[]>`select id, count_tolerance::text as t from inv_item where id = any(${counted.map((c) => c.item.id)}::uuid[])`).map((r) => [r.id, toMilli(r.t)]),
    );
    let matched = 0;
    let small = 0;
    let recount = 0;
    const lines: { item: string; counted: string; ledger: string; moved: boolean }[] = [];
    for (const c of counted) {
      const l = ledger.get(c.item.id) ?? { milli: 0, moved: false, inTransit: false };
      const moved = unclear(l, c.milli, l.milli);
      const diff = Math.abs(c.milli - l.milli);
      if (moved || diff > (tol.get(c.item.id) ?? 0)) recount++;
      else if (diff > 0) small++;
      else matched++;
      await tx`
        insert into count_line (session_id, item_id, counted_qty, expected_qty, moved_during)
        values (${sessionId}, ${c.item.id}, ${fromMilli(c.milli)}::numeric, ${fromMilli(l.milli)}::numeric, ${moved})`;
      lines.push({ item: c.item.name, counted: fromMilli(c.milli), ledger: fromMilli(l.milli), moved });
    }
    const state: CountStep["state"] = recount > 0 ? "recount" : small > 0 ? "approval" : "closed";
    // The moment of the count is taken now, under the item locks and after the ledger was read (0040).
    await tx`update count_session set state = ${state}, submitted_at = clock_timestamp() where id = ${sessionId}`;
    await auditIn(tx, correlationId, `employee:${viewer.employeeId}`, "stock.counted", sessionId, { kind: s.kind, outcome: state, lines });
    return { sessionId, state, replay: false, lines: counted.length, matched, small, recount };
  });
  return afterCount(done, "count", correlationId);
}

// ── the recount ──────────────────────────────────────────────────────────────
/** The lines a recount covers: beyond tolerance, or moved while counted. */
async function recountLines(tx: Tx, sessionId: string): Promise<CountItem[]> {
  const rows = await tx<{ id: string; name: string; unit: string; step: string; icon: string | null }[]>`
    select i.id, i.name, i.unit, i.step::text as step, i.icon
      from count_line l join inv_item i on i.id = l.item_id
     where l.session_id = ${sessionId}
       and (l.moved_during or abs(l.counted_qty - l.expected_qty) > i.count_tolerance)
     order by i.sort_order, lower(i.name)`;
  return rows.map((r) => ({ id: r.id, name: r.name, unit: r.unit, step: Number(r.step), icon: r.icon }));
}

export async function startRecount(viewer: ViewerOrg, sessionId: string, opts: { correlationId?: string } = {}): Promise<CountStep & { items: CountItem[] }> {
  requireCan(viewer, "inventory.move", "Only the warehouse, the Ops Head, the CEO or an Admin recounts.");
  const correlationId = correlationOf(opts.correlationId);
  return getServiceSql().begin(async (tx) => {
    const s = await lockSession(tx, sessionId);
    if (s.started_by === viewer.employeeId) throw new InventoryRefused("Someone else counts it again — not the person who counted first.", 403, "own_count");
    if (s.state !== "recount") throw new InventoryRefused("This count does not need a recount.", 409, "no_recount");
    if (s.recount_by && s.recount_by !== viewer.employeeId) throw new InventoryRefused("Someone else is already counting it again.", 409, "recount_taken");
    if (!s.recount_by) {
      await tx`update count_session set recount_by = ${viewer.employeeId}, recount_started_at = clock_timestamp() where id = ${sessionId}`;
      await auditIn(tx, correlationId, `employee:${viewer.employeeId}`, "stock.recount_started", sessionId, {});
    }
    return { sessionId, state: "recount" as const, replay: s.recount_by === viewer.employeeId, items: await recountLines(tx, sessionId) };
  });
}

export async function submitRecount(
  viewer: ViewerOrg,
  sessionId: string,
  req: { lines: readonly { itemId: string; qty: number | string }[] },
  opts: { correlationId?: string } = {},
): Promise<CountStep> {
  const correlationId = correlationOf(opts.correlationId);
  const done = await getServiceSql().begin(async (tx) => {
    const s = await lockSession(tx, sessionId);
    if (s.recount_by !== viewer.employeeId || viewer.status !== "active") throw new InventoryRefused("Only the person recounting hands the recount in.", 403, "not_allowed");
    if (s.state !== "recount") {
      if (s.state === "cancelled") throw new InventoryRefused("This count was cancelled.", 409, "count_closed");
      // Let go by an approver while it was being counted: say so — never answer as if it was recorded
      // (TASK-060 review).
      if (s.recounted_at === null) {
        throw new InventoryRefused("An approver let the recount go before you handed it in, so your figures were not recorded.", 409, "recount_waived");
      }
      const stored = await tx<{ item_id: string; q: string }[]>`
        select item_id, recount_qty::text as q from count_line where session_id = ${sessionId} and recount_qty is not null`;
      if (!sameFigures(req.lines, stored.map((r) => ({ itemId: r.item_id, milli: toMilli(r.q) })))) {
        throw new InventoryRefused("This recount was already handed in, with other figures.", 409, "already_handed_in");
      }
      return { sessionId, state: s.state, replay: true };
    }
    await lockItems(tx, req.lines.map((l) => l.itemId).filter((x) => UUID_RE.test(x)));
    const due = await recountLines(tx, sessionId);
    const counted = checkCounted(new Map(due.map((i) => [i.id, i])), req.lines);
    if (counted.length !== due.length) throw new InventoryRefused("Recount every item on the list.", 400, "count_every_item");
    const ledger = await ledgerNow(tx, s.location_id, counted.map((c) => c.item.id), { sessionId, recount: true });
    const lines: { item: string; counted: string; ledger: string; moved: boolean }[] = [];
    for (const c of counted) {
      const l = ledger.get(c.item.id) ?? { milli: 0, moved: false, inTransit: false };
      const moved = unclear(l, c.milli, l.milli);
      await tx`
        update count_line set recount_qty = ${fromMilli(c.milli)}::numeric, recount_expected_qty = ${fromMilli(l.milli)}::numeric,
                              recount_moved_during = ${moved}
         where session_id = ${sessionId} and item_id = ${c.item.id}`;
      lines.push({ item: c.item.name, counted: fromMilli(c.milli), ledger: fromMilli(l.milli), moved });
    }
    await tx`update count_session set state = 'approval', recounted_at = clock_timestamp() where id = ${sessionId}`;
    await auditIn(tx, correlationId, `employee:${viewer.employeeId}`, "stock.recounted", sessionId, { lines });
    return { sessionId, state: "approval" as const, replay: false };
  });
  return afterCount(done, "count", correlationId);
}

export async function waiveRecount(viewer: ViewerOrg, sessionId: string, req: { reason: string }, opts: { correlationId?: string } = {}): Promise<CountStep> {
  requireCan(viewer, "inventory.approve", "Only the Ops Head, the CEO or an Admin lets a recount go.");
  const reason = req.reason?.trim() ?? "";
  if (reason.length < 3) throw new InventoryRefused("Say why there is no recount.", 400, "reason_needed");
  const correlationId = correlationOf(opts.correlationId);
  const done = await getServiceSql().begin(async (tx) => {
    const s = await lockSession(tx, sessionId);
    if (s.started_by === viewer.employeeId) throw new InventoryRefused("The person who counted cannot let the recount go.", 403, "own_count");
    if (s.recount_by === viewer.employeeId) throw new InventoryRefused("You started the recount — hand it in instead.", 409, "recount_yours");
    if (s.state !== "recount") throw new InventoryRefused("This count is not waiting for a recount.", 409, "no_recount");
    await tx`
      update count_session set state = 'approval', recount_waived_by = ${viewer.employeeId}, recount_waived_reason = ${reason.slice(0, 300)}
       where id = ${sessionId}`;
    await auditIn(tx, correlationId, `employee:${viewer.employeeId}`, "stock.recount_waived", sessionId, { reason: reason.slice(0, 300) });
    return { sessionId, state: "approval" as const, replay: false };
  });
  return afterCount(done, "count", correlationId);
}

// ── the decision ─────────────────────────────────────────────────────────────
interface LineRow {
  item_id: string;
  name: string;
  unit: string;
  counted_qty: string;
  expected_qty: string;
  moved_during: boolean;
  recount_qty: string | null;
  recount_expected_qty: string | null;
  recount_moved_during: boolean | null;
}

/** The figure a line is decided on: the recount when there is one (the later, independent count), else the first. */
export function finalFigure(l: Pick<LineRow, "counted_qty" | "expected_qty" | "moved_during" | "recount_qty" | "recount_expected_qty" | "recount_moved_during">): {
  counted: number;
  expected: number;
  moved: boolean;
} {
  if (l.recount_qty !== null && l.recount_expected_qty !== null) {
    return { counted: toMilli(l.recount_qty), expected: toMilli(l.recount_expected_qty), moved: l.recount_moved_during === true };
  }
  return { counted: toMilli(l.counted_qty), expected: toMilli(l.expected_qty), moved: l.moved_during };
}

export async function decideCount(
  viewer: ViewerOrg,
  sessionId: string,
  req: {
    /** The adjustment document's id, made by the app — the same decision sent twice posts once. */
    docId: string;
    lines: readonly { itemId: string; decision: "accept_count" | "keep_ledger"; reason?: CountDecisionReason | null }[];
    note?: string | null;
  },
  opts: { correlationId?: string } = {},
): Promise<CountStep & { adjustmentDocId: string | null }> {
  requireCan(viewer, "inventory.approve", "Only the Ops Head, the CEO or an Admin decides a count.");
  if (!UUID_RE.test(req.docId)) throw new InventoryRefused("The document id must be a UUID made by the app.", 400, "bad_id");
  const correlationId = correlationOf(opts.correlationId);
  const note = req.note?.trim() ? req.note.trim().slice(0, 500) : null;
  const done = await getServiceSql().begin(async (tx) => {
    const s = await lockSession(tx, sessionId);
    if (s.started_by === viewer.employeeId || s.recount_by === viewer.employeeId) {
      throw new InventoryRefused("Someone who did not count decides it.", 403, "own_count");
    }
    if (s.state === "closed" && s.decided_by === viewer.employeeId) {
      const [d] = await tx<{ id: string }[]>`select id from stock_doc where count_session_id = ${sessionId} and kind = 'count_adjustment'`;
      // The same decision sent twice is answered as before; a different one is refused, never reported
      // as done (TASK-060 review).
      const decided = await tx<{ item_id: string; decision: string; reason: string | null }[]>`
        select item_id, decision, decision_reason as reason from count_line where session_id = ${sessionId} and decision is not null`;
      const same =
        decided.length === req.lines.length &&
        req.lines.every((l) => {
          const r = decided.find((x) => x.item_id === l.itemId);
          return r !== undefined && r.decision === l.decision && (l.decision === "keep_ledger" || r.reason === (l.reason ?? null));
        }) &&
        (d === undefined || d.id === req.docId);
      if (!same) throw new InventoryRefused("This count was already decided, differently.", 409, "already_decided");
      return { sessionId, state: "closed" as const, replay: true, adjustmentDocId: d?.id ?? null };
    }
    if (s.state !== "approval") throw new InventoryRefused(s.state === "recount" ? "This count waits for its recount first." : "This count is not waiting for a decision.", 409, "not_for_decision");

    const rows = await tx<LineRow[]>`
      select l.item_id, i.name, i.unit, l.counted_qty::text, l.expected_qty::text, l.moved_during,
             l.recount_qty::text, l.recount_expected_qty::text, l.recount_moved_during
        from count_line l join inv_item i on i.id = l.item_id
       where l.session_id = ${sessionId}`;
    const needs = rows.filter((r) => {
      const f = finalFigure(r);
      return f.moved || f.counted !== f.expected;
    });
    const given = new Map(req.lines.map((l) => [l.itemId, l]));
    if (given.size !== req.lines.length) throw new InventoryRefused("Each item once.", 400, "duplicate_item");
    for (const r of needs) if (!given.has(r.item_id)) throw new InventoryRefused(`Decide ${r.name} too.`, 400, "decide_every_line");
    for (const id of given.keys()) if (!needs.some((r) => r.item_id === id)) throw new InventoryRefused("Decide only the lines that differ.", 400, "bad_item");

    for (const r of needs) {
      const g = given.get(r.item_id)!;
      if (g.decision === "accept_count") {
        if (finalFigure(r).moved) {
          throw new InventoryRefused(`${r.name} moved, or was on its way in or out, while it was counted — so the count and the ledger are from different moments: keep the ledger figure, or count again.`, 409, "moved_during");
        }
        if (!g.reason || !(COUNT_DECISION_REASONS as readonly string[]).includes(g.reason)) throw new InventoryRefused(`Say why ${r.name} differs.`, 400, "reason_needed");
      } else if (g.decision !== "keep_ledger") {
        throw new InventoryRefused("Decide each line: the count, or the ledger.", 400, "bad_decision");
      }
    }

    // The difference posted is the count's figure minus the ledger's AT THE MOMENT IT WAS COUNTED. Stock
    // handed out or delivered since moves both alike, so the difference still holds; but another count's
    // correction, or a document undone since, corrects the books in a way this difference does not
    // know of — accepting it then would correct the same gap twice (TASK-060 review). Checked under the
    // item locks, so two decisions cannot both pass.
    const accepting = needs.filter((r) => given.get(r.item_id)!.decision === "accept_count");
    await lockItems(tx, accepting.map((r) => r.item_id));
    const moves: { itemId: string; delta: number; name: string; unit: string }[] = [];
    for (const r of accepting) {
      // The count's moment is read in SQL, never round-tripped through JavaScript (G202). A reversal changes the books only
      // when the document it undoes was posted by then: a mistake entered after the count and undone again nets out
      // (review, 20 Oct).
      const recounted = r.recount_qty !== null && s.recounted_at !== null;
      const [changed] = await tx<{ c: boolean }[]>`
        with at as (select case when ${recounted} then recounted_at else coalesce(submitted_at, started_at) end as t from count_session where id = ${sessionId})
        select exists (select 1 from stock_move m join stock_doc d on d.id = m.doc_id, at
                        where m.item_id = ${r.item_id} and (m.from_location_id = ${s.location_id} or m.to_location_id = ${s.location_id})
                          and m.posted_at > at.t
                          and ((d.kind = 'count_adjustment' and d.state <> 'reversed')
                               or (d.kind = 'reversal' and exists (select 1 from stock_move om where om.doc_id = d.reverses_doc_id and om.posted_at <= at.t)))) as c`;
      if (changed?.c) {
        throw new InventoryRefused(`${r.name} was corrected on the books after it was counted (another count's decision, or an undone document) — keep the ledger figure, or count again.`, 409, "changed_since");
      }
      const f = finalFigure(r);
      if (f.counted !== f.expected) moves.push({ itemId: r.item_id, delta: f.counted - f.expected, name: r.name, unit: r.unit });
    }

    let adjustmentDocId: string | null = null;
    if (moves.length > 0) {
      // A shortage takes stock out of the warehouse now: it must still be there (stock handed out
      // since the count is the warehouse's to account for in a new count).
      const short = moves.filter((m) => m.delta < 0);
      if (short.length > 0) {
        const have = new Map(
          (await tx<{ item_id: string; qty: string }[]>`
            select item_id, qty::text as qty from stock_balance where location_id = ${s.location_id} and item_id = any(${short.map((m) => m.itemId)}::uuid[])`).map((r) => [r.item_id, toMilli(r.qty)]),
        );
        for (const m of short) {
          if ((have.get(m.itemId) ?? 0) < -m.delta) {
            throw new InventoryRefused(`${m.name} has moved since the count — there is less in the warehouse now than the shortage. Count it again.`, 409, "moved_since");
          }
        }
      }
      const hash = requestHash({ k: "count_adjustment", session: sessionId, lines: req.lines });
      const exists = await tx<{ request_hash: string }[]>`select request_hash from stock_doc where id = ${req.docId}`;
      if (exists[0]) throw new InventoryRefused("This document id was already used for something else.", 409, "id_reused");
      await tx`
        insert into stock_doc (id, kind, from_location_id, to_location_id, state, created_by, count_session_id, note, request_hash, is_synthetic, correlation_id)
        values (${req.docId}, 'count_adjustment', ${s.location_id}, ${PLACE.adjustments}, 'posted', ${viewer.employeeId}, ${sessionId}, ${note},
                ${hash}, ${s.is_synthetic}, ${correlationId})`;
      for (const m of moves) {
        await tx`insert into stock_doc_line (doc_id, item_id, qty) values (${req.docId}, ${m.itemId}, ${fromMilli(Math.abs(m.delta))}::numeric)`;
        const [from, to] = m.delta < 0 ? [s.location_id, PLACE.adjustments] : [PLACE.adjustments, s.location_id];
        await tx`
          insert into stock_move (doc_id, item_id, from_location_id, to_location_id, qty, step, posted_by, is_synthetic, correlation_id)
          values (${req.docId}, ${m.itemId}, ${from}, ${to}, ${fromMilli(Math.abs(m.delta))}::numeric, 'post', ${viewer.employeeId}, ${s.is_synthetic}, ${correlationId})`;
      }
      adjustmentDocId = req.docId;
    }
    for (const r of needs) {
      const g = given.get(r.item_id)!;
      await tx`
        update count_line set decision = ${g.decision}, decision_reason = ${g.decision === "accept_count" ? g.reason! : null}
         where session_id = ${sessionId} and item_id = ${r.item_id}`;
    }
    await tx`
      update count_session set state = 'closed', decided_by = ${viewer.employeeId}, decided_at = now(), decision_note = ${note}
       where id = ${sessionId}`;
    await auditIn(tx, correlationId, `employee:${viewer.employeeId}`, "stock.count_decided", sessionId, {
      adjustmentDocId,
      lines: needs.map((r) => {
        const f = finalFigure(r);
        const g = given.get(r.item_id)!;
        return { item: r.name, counted: fromMilli(f.counted), ledger: fromMilli(f.expected), decision: g.decision, reason: g.reason ?? null };
      }),
    });
    return { sessionId, state: "closed" as const, replay: false, adjustmentDocId };
  });
  return afterCount(done, "decision", correlationId);
}

/** The person who opened it, while counting; an approver, before the decision. */
export async function cancelCount(viewer: ViewerOrg, sessionId: string, opts: { correlationId?: string } = {}): Promise<CountStep> {
  const correlationId = correlationOf(opts.correlationId);
  return getServiceSql().begin(async (tx) => {
    const s = await lockSession(tx, sessionId);
    if (s.state === "cancelled") return { sessionId, state: "cancelled" as const, replay: true };
    const own = s.started_by === viewer.employeeId && s.state === "counting" && viewer.status === "active";
    const approver = s.state !== "closed" && s.state !== "approval" && s.started_by !== viewer.employeeId;
    if (!own && !(approver && viewer.status === "active" && can(viewer, "inventory.approve"))) {
      throw new InventoryRefused("This count cannot be cancelled by you now.", 403, "not_allowed");
    }
    await tx`update count_session set state = 'cancelled' where id = ${sessionId}`;
    await auditIn(tx, correlationId, `employee:${viewer.employeeId}`, "stock.count_cancelled", sessionId, { from: s.state });
    return { sessionId, state: "cancelled" as const, replay: false };
  });
}
