import { getServiceSql, withContext, type Tx } from "./db.js";
import { InventoryRefused, PLACE, UUID_RE, correlationOf, fmt, fromMilli, parseQty, requireCan, toMilli } from "./inventory-common.js";
import { personPlace } from "./inventory-ledger.js";
import { figuresHiddenFrom } from "./inventory-notify.js";
import { loadViewer, type ViewerOrg } from "./org.js";
import { can } from "./permissions.js";
import { localDate } from "./time.js";
import { SHORT_WEIGHT_SHARE } from "./warehouse.js";

/**
 * The warehouse's planning and its reports (TASK-086), modelled on Televend's Automatic Orders and Reporting (its user guide
 * 1.1) — every number summed by Postgres over the ledger, under the viewer's row-level security:
 *
 *   reorder rules        per item and place (the warehouse, or one person's own stock): min, max, the multiple to order in, the
 *                        supplier. A SUGGESTION, worked out the same way every time — forecast = on hand + already coming (open
 *                        receipts, drafts included; for a person, what is on its way to them); below the minimum, the amount up
 *                        to the maximum, rounded up to whole multiples (Odoo's rule as its 19 docs draft describes it — never above
 *                        the maximum by a whole multiple or more). Nothing is ordered or handed out by a rule: a person confirms.
 *   stock on a date      every real place's stock at the end of a Dubai day — the ledger summed up to then
 *   movements            every move in a range, by item, person or kind, with totals in and out — and as a CSV file
 *   item tracking        one item: where it is now, its lots, its moves
 *   suppliers            receipts on time, lines complete, kilograms against the notes, returns — the supplier's process, not
 *                        anybody's score (CLAUDE.md: no employee scoring)
 */

const num = (q: string | null | undefined): number => (q === null || q === undefined ? 0 : toMilli(q) / 1000);
const dayOk = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d);
const dayStart = (d: string) => new Date(`${d}T00:00:00+04:00`);
const dayEnd = (d: string) => new Date(dayStart(d).getTime() + 86_400_000);
/** The longest range a report reads at once. */
const MAX_DAYS = 366;
/** The most rows a CSV carries; past it, the file says how many more there were. */
export const CSV_MAX_ROWS = 10_000;

function requireRead(viewer: ViewerOrg): void {
  if (viewer.status !== "active" || !can(viewer, "inventory.read")) throw new InventoryRefused("The warehouse's reports are for the people who see all stock.", 403, "not_allowed");
}

/** A report shows the warehouse's figures, so not to someone counting it (D236), as the day sheet. */
async function refuseWhileCounting(viewer: ViewerOrg): Promise<void> {
  if ((await figuresHiddenFrom())(viewer.employeeId, can(viewer, "inventory.move"))) {
    throw new InventoryRefused("Hand in your count first — the warehouse's figures are not shown while you count.", 409, "counting_now");
  }
}

function checkRange(from: string, to: string): { start: Date; end: Date } {
  if (!dayOk(from) || !dayOk(to)) throw new InventoryRefused("A day is YYYY-MM-DD.", 400, "bad_day");
  if (from > to) throw new InventoryRefused("The first day comes before the last.", 400, "bad_range");
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  if (days > MAX_DAYS) throw new InventoryRefused(`At most ${MAX_DAYS} days at a time.`, 400, "bad_range");
  return { start: dayStart(from), end: dayEnd(to) };
}

async function namesOf(ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((x): x is string => typeof x === "string"))];
  if (want.length === 0) return new Map();
  const rows = await getServiceSql()<{ id: string; display_name: string }[]>`select id, display_name from employee where id = any(${want}::uuid[])`;
  return new Map(rows.map((r) => [r.id, r.display_name]));
}

export interface PlaceRef {
  id: string;
  kind: string;
  /** The person's name for a person's place; the place's own name otherwise. */
  name: string;
  employeeId: string | null;
}
const placeOf = (names: Map<string, string>, r: { id: string; kind: string; name: string | null; employee_id: string | null }): PlaceRef => ({
  id: r.id,
  kind: r.kind,
  name: r.employee_id ? (names.get(r.employee_id) ?? "—") : (r.name ?? "—"),
  employeeId: r.employee_id,
});

// ── reorder rules ────────────────────────────────────────────────────────────
export interface ItemRef {
  id: string;
  name: string;
  unit: string;
  step: number;
  icon: string | null;
}

export interface ReorderRule {
  id: string;
  item: ItemRef;
  place: PlaceRef;
  min: number;
  max: number;
  /** The pack it is ordered in — the rule's own, or the item's step. */
  multiple: number;
  supplier: { id: string; name: string } | null;
  active: boolean;
}

interface RuleRow {
  id: string;
  item_id: string;
  item_name: string;
  unit: string;
  step: string;
  icon: string | null;
  location_id: string;
  location_kind: string;
  location_name: string | null;
  employee_id: string | null;
  min_qty: string;
  max_qty: string;
  multiple: string | null;
  supplier_id: string | null;
  supplier_name: string | null;
  lead_days: number | null;
  active: boolean;
}

async function ruleRows(tx: Tx, activeOnly: boolean): Promise<RuleRow[]> {
  return tx<RuleRow[]>`
    select r.id, r.item_id, i.name as item_name, i.unit, i.step::text as step, i.icon, r.location_id, l.kind as location_kind, l.name as location_name,
           l.employee_id, r.min_qty::text as min_qty, r.max_qty::text as max_qty, r.multiple::text as multiple, r.supplier_id, s.name as supplier_name,
           s.lead_days, r.active
      from reorder_rule r
      join inv_item i on i.id = r.item_id
      join inv_location l on l.id = r.location_id
      left join supplier s on s.id = r.supplier_id
     where (not ${activeOnly} or (r.active and i.active))
     order by l.kind = 'person', i.sort_order, lower(i.name)`;
}

const ruleOf = (names: Map<string, string>, r: RuleRow): ReorderRule => ({
  id: r.id,
  item: { id: r.item_id, name: r.item_name, unit: r.unit, step: Number(r.step), icon: r.icon },
  place: placeOf(names, { id: r.location_id, kind: r.location_kind, name: r.location_name, employee_id: r.employee_id }),
  min: num(r.min_qty),
  max: num(r.max_qty),
  multiple: num(r.multiple ?? r.step),
  supplier: r.supplier_id ? { id: r.supplier_id, name: r.supplier_name ?? "—" } : null,
  active: r.active,
});

export async function listReorderRules(viewer: ViewerOrg): Promise<ReorderRule[]> {
  requireRead(viewer);
  const rows = await withContext(viewer, (tx) => ruleRows(tx, false), { readOnly: true });
  const names = await namesOf(rows.map((r) => r.employee_id));
  return rows.map((r) => ruleOf(names, r));
}

export interface ReorderRuleIn {
  /** Absent: a new rule. */
  id?: string;
  itemId: string;
  place: { kind: "warehouse" } | { kind: "person"; employeeId: string };
  min: number | string;
  max: number | string;
  multiple?: number | string | null;
  supplierId?: string | null;
  active?: boolean;
}

export async function saveReorderRule(viewer: ViewerOrg, req: ReorderRuleIn, opts: { correlationId?: string } = {}): Promise<{ id: string; created: boolean }> {
  requireCan(viewer, "inventory.move", "Only the warehouse sets what to keep in stock.");
  if (!UUID_RE.test(req.itemId)) throw new InventoryRefused("Choose an item.", 400, "bad_item");
  if (req.id !== undefined && !UUID_RE.test(req.id)) throw new InventoryRefused("No such rule.", 404, "no_rule");
  const correlationId = correlationOf(opts.correlationId);
  const person = req.place.kind === "person" ? req.place.employeeId : null;
  if (person !== null) {
    if (!UUID_RE.test(person)) throw new InventoryRefused("No such person.", 404, "no_person");
    const who = await loadViewer(person);
    if (!who) throw new InventoryRefused("No such person.", 404, "no_person");
    if (who.status !== "active" || !can(who, "inventory.hold")) {
      throw new InventoryRefused(`${who.displayName || "That person"} does not hold stock: their account is not active or their role does not hold stock.`, 409, "not_a_holder");
    }
  }
  if (person !== null && req.supplierId) throw new InventoryRefused("A person's stock is filled from the warehouse, not from a supplier.", 400, "bad_supplier");
  if (req.supplierId && !UUID_RE.test(req.supplierId)) throw new InventoryRefused("No such supplier.", 404, "no_supplier");
  return getServiceSql().begin(async (tx) => {
    // The ledger's lock on the item: its step cannot change while the rule is checked against it.
    await tx`select pg_advisory_xact_lock(hashtextextended(${`inventory:${req.itemId}`}, 0))`;
    const [it] = await tx<{ name: string; unit: string; step: string; active: boolean }[]>`select name, unit, step::text as step, active from inv_item where id = ${req.itemId}`;
    if (!it) throw new InventoryRefused("No such item.", 404, "no_item");
    if (!it.active) throw new InventoryRefused(`${it.name} is no longer in use.`, 409, "item_inactive");
    const step = toMilli(it.step);
    const min = parseQty(req.min, "minimum", true);
    const max = parseQty(req.max, "maximum");
    if (max < min) throw new InventoryRefused("The maximum is at least the minimum.", 400, "bad_range");
    const multiple = req.multiple === undefined || req.multiple === null || req.multiple === "" ? null : parseQty(req.multiple, "pack size");
    for (const [what, m] of [["minimum", min], ["maximum", max], ["pack size", multiple]] as const) {
      if (m !== null && m % step !== 0) throw new InventoryRefused(`The ${what} of ${it.name} is in steps of ${fmt(step, it.unit)}.`, 400, "bad_step");
    }
    if (req.supplierId) {
      const [s] = await tx<{ name: string; active: boolean }[]>`select name, active from supplier where id = ${req.supplierId}`;
      if (!s) throw new InventoryRefused("No such supplier.", 404, "no_supplier");
      if (!s.active) throw new InventoryRefused(`${s.name} is no longer a supplier in use.`, 409, "supplier_inactive");
    }
    const location = person === null ? PLACE.warehouse : await personPlace(tx, person);
    if (!req.id) {
      const [clash] = await tx<{ id: string }[]>`select id from reorder_rule where item_id = ${req.itemId} and location_id = ${location}`;
      if (clash) throw new InventoryRefused(`There is already a rule for ${it.name} there — change that one.`, 409, "rule_exists");
      const synthetic = ((await tx<{ s: boolean }[]>`select is_synthetic as s from employee where id = ${viewer.employeeId}`)[0]?.s ?? false);
      const [r] = await tx<{ id: string }[]>`
        insert into reorder_rule (item_id, location_id, min_qty, max_qty, multiple, supplier_id, active, created_by, updated_by, is_synthetic)
        values (${req.itemId}, ${location}, ${fromMilli(min)}::numeric, ${fromMilli(max)}::numeric, ${multiple === null ? null : fromMilli(multiple)}::numeric,
                ${req.supplierId ?? null}, ${req.active ?? true}, ${viewer.employeeId}, ${viewer.employeeId}, ${synthetic})
        returning id`;
      await tx`
        insert into audit_log (correlation_id, actor, action, entity, entity_id, detail)
        values (${correlationId}, ${`employee:${viewer.employeeId}`}, 'wh.rule_created', 'reorder_rule', ${r!.id},
                ${tx.json({ item: it.name, place: person ?? "warehouse", min: fromMilli(min), max: fromMilli(max), multiple: multiple === null ? null : fromMilli(multiple), supplierId: req.supplierId ?? null } as never)})`;
      return { id: r!.id, created: true };
    }
    const [old] = await tx<{ item_id: string; location_id: string; min_qty: string; max_qty: string; multiple: string | null; supplier_id: string | null; active: boolean }[]>`
      select item_id, location_id, min_qty::text as min_qty, max_qty::text as max_qty, multiple::text as multiple, supplier_id, active
        from reorder_rule where id = ${req.id} for update`;
    if (!old) throw new InventoryRefused("No such rule.", 404, "no_rule");
    if (old.item_id !== req.itemId || old.location_id !== location) throw new InventoryRefused("A rule keeps its item and place — make a new rule for another.", 400, "rule_fixed");
    await tx`
      update reorder_rule set min_qty = ${fromMilli(min)}::numeric, max_qty = ${fromMilli(max)}::numeric,
                              multiple = ${multiple === null ? null : fromMilli(multiple)}::numeric, supplier_id = ${req.supplierId ?? null},
                              active = ${req.active ?? old.active}, updated_by = ${viewer.employeeId}, updated_at = now()
       where id = ${req.id}`;
    await tx`
      insert into audit_log (correlation_id, actor, action, entity, entity_id, detail)
      values (${correlationId}, ${`employee:${viewer.employeeId}`}, 'wh.rule_changed', 'reorder_rule', ${req.id},
              ${tx.json({
                item: it.name,
                before: { min: old.min_qty, max: old.max_qty, multiple: old.multiple, supplierId: old.supplier_id, active: old.active },
                after: { min: fromMilli(min), max: fromMilli(max), multiple: multiple === null ? null : fromMilli(multiple), supplierId: req.supplierId ?? null, active: req.active ?? old.active },
              } as never)})`;
    return { id: req.id, created: false };
  });
}

export interface Suggestion {
  rule: ReorderRule;
  onHand: number;
  /** Already coming: open receipts (drafts included) for the warehouse; what is on its way to a person. */
  incoming: number;
  forecast: number;
  /** 0 when the forecast is at or above the minimum. */
  suggest: number;
  /** A warehouse rule whose supplier takes days: the day it should be ordered by — today, as the stock is already short. */
  leadDays: number | null;
}

/**
 * What each rule suggests now. Rounded UP to the pack: below the minimum, the forecast is brought to at least the maximum — at
 * most one pack less than a pack above it. Hidden from someone counting the warehouse: the suggestion would tell its figures.
 */
export async function reorderSuggestions(viewer: ViewerOrg): Promise<{ hidden: boolean; warehouse: Suggestion[]; people: Suggestion[] }> {
  requireRead(viewer);
  const hidden = (await figuresHiddenFrom())(viewer.employeeId, can(viewer, "inventory.move"));
  const { rows, stock, coming, onTheWay } = await withContext(
    viewer,
    async (tx) => {
      const rows = await ruleRows(tx, true);
      const places = [...new Set(rows.map((r) => r.location_id))];
      const items = [...new Set(rows.map((r) => r.item_id))];
      const stock = await tx<{ location_id: string; item_id: string; qty: string }[]>`
        select location_id, item_id, qty::text as qty from stock_balance where location_id = any(${places}::uuid[]) and item_id = any(${items}::uuid[])`;
      const coming = await tx<{ item_id: string; qty: string }[]>`
        select l.item_id, sum(l.expected_qty)::text as qty
          from wh_order o join wh_order_line l on l.order_id = o.id
         where o.kind = 'receipt' and o.state in ('draft', 'ready') and l.item_id = any(${items}::uuid[])
         group by l.item_id`;
      // What is in transit to each person: sent and not yet answered, or left after a part acceptance.
      const onTheWay = await tx<{ location_id: string; item_id: string; qty: string }[]>`
        select d.to_location_id as location_id, m.item_id,
               (sum(case when m.to_location_id = ${PLACE.inTransit} then m.qty else 0 end)
              - sum(case when m.from_location_id = ${PLACE.inTransit} then m.qty else 0 end))::text as qty
          from stock_doc d join stock_move m on m.doc_id = d.id
         where d.kind = 'handover' and d.state in ('waiting', 'part_accepted') and d.to_location_id = any(${places}::uuid[])
         group by d.to_location_id, m.item_id`;
      return { rows, stock, coming, onTheWay };
    },
    { readOnly: true },
  );
  const names = await namesOf(rows.map((r) => r.employee_id));
  const at = (list: { location_id?: string; item_id: string; qty: string }[], item: string, place?: string) =>
    toMilli(list.find((x) => x.item_id === item && (place === undefined || x.location_id === place))?.qty ?? "0");
  const out = { hidden, warehouse: [] as Suggestion[], people: [] as Suggestion[] };
  for (const r of rows) {
    const isWarehouse = r.location_id === PLACE.warehouse;
    if (isWarehouse && hidden) continue;
    const onHand = at(stock, r.item_id, r.location_id);
    const incoming = isWarehouse ? at(coming, r.item_id) : at(onTheWay, r.item_id, r.location_id);
    const forecast = onHand + incoming;
    const min = toMilli(r.min_qty);
    const max = toMilli(r.max_qty);
    const pack = toMilli(r.multiple ?? r.step);
    const suggest = forecast < min ? Math.ceil((max - forecast) / pack) * pack : 0;
    const s: Suggestion = {
      rule: ruleOf(names, r),
      onHand: onHand / 1000,
      incoming: incoming / 1000,
      forecast: forecast / 1000,
      suggest: suggest / 1000,
      leadDays: isWarehouse ? r.lead_days : null,
    };
    (isWarehouse ? out.warehouse : out.people).push(s);
  }
  const need = (a: Suggestion, b: Suggestion) => Number(b.suggest > 0) - Number(a.suggest > 0) || a.rule.item.name.localeCompare(b.rule.item.name);
  out.warehouse.sort(need);
  out.people.sort((a, b) => need(a, b) || a.rule.place.name.localeCompare(b.rule.place.name));
  return out;
}

// ── stock on a date ──────────────────────────────────────────────────────────
export interface StockAt {
  /** The end of the day asked for (or now). */
  at: string;
  date: string | null;
  items: (ItemRef & { warehouse: number; withPeople: number; inTransit: number; total: number })[];
  people: { employeeId: string; name: string; items: { itemId: string; qty: number }[] }[];
}

/** Every real place's stock at the end of a Dubai day (or now): the ledger's moves up to then, summed. */
export async function stockAt(viewer: ViewerOrg, date: string | null, now: Date = new Date()): Promise<StockAt> {
  requireRead(viewer);
  if (date !== null && !dayOk(date)) throw new InventoryRefused("A day is YYYY-MM-DD.", 400, "bad_day");
  if (date !== null && dayStart(date) > now) throw new InventoryRefused("That day has not started yet.", 400, "bad_day");
  await refuseWhileCounting(viewer);
  const cutoff = date === null ? now : new Date(Math.min(dayEnd(date).getTime(), now.getTime()));
  const rows = await withContext(
    viewer,
    async (tx) =>
      tx<{ place: string; kind: string; employee_id: string | null; item_id: string; name: string; unit: string; step: string; icon: string | null; qty: string }[]>`
        with m as (
          select item_id, from_location_id, to_location_id, qty from stock_move where posted_at < ${cutoff}
        ), x as (
          select to_location_id as place, item_id, qty from m
          union all
          select from_location_id, item_id, -qty from m
        )
        select x.place, l.kind, l.employee_id, x.item_id, i.name, i.unit, i.step::text as step, i.icon, sum(x.qty)::text as qty
          from x join inv_location l on l.id = x.place and not l.is_virtual
          join inv_item i on i.id = x.item_id
         group by x.place, l.kind, l.employee_id, x.item_id, i.name, i.unit, i.step, i.icon, i.sort_order
        having sum(x.qty) <> 0
         order by i.sort_order, lower(i.name)`,
    { readOnly: true },
  );
  const items = new Map<string, StockAt["items"][number]>();
  const people = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const it = items.get(r.item_id) ?? { id: r.item_id, name: r.name, unit: r.unit, step: Number(r.step), icon: r.icon, warehouse: 0, withPeople: 0, inTransit: 0, total: 0 };
    const q = toMilli(r.qty);
    if (r.kind === "warehouse") it.warehouse += q;
    else if (r.kind === "in_transit") it.inTransit += q;
    else if (r.kind === "person" && r.employee_id) {
      it.withPeople += q;
      const per = people.get(r.employee_id) ?? new Map<string, number>();
      per.set(r.item_id, (per.get(r.item_id) ?? 0) + q);
      people.set(r.employee_id, per);
    }
    it.total += q;
    items.set(r.item_id, it);
  }
  const names = await namesOf([...people.keys()]);
  return {
    at: cutoff.toISOString(),
    date,
    items: [...items.values()].map((i) => ({ ...i, warehouse: i.warehouse / 1000, withPeople: i.withPeople / 1000, inTransit: i.inTransit / 1000, total: i.total / 1000 })),
    people: [...people.entries()]
      .map(([employeeId, per]) => ({ employeeId, name: names.get(employeeId) ?? "—", items: [...per.entries()].map(([itemId, q]) => ({ itemId, qty: q / 1000 })) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// ── movements ────────────────────────────────────────────────────────────────
export interface MoveRow {
  id: number;
  at: string;
  docId: string;
  kind: string;
  reason: string | null;
  step: string;
  item: ItemRef;
  from: PlaceRef;
  to: PlaceRef;
  qty: number;
  by: { id: string; name: string };
  supplier: string | null;
  /** The warehouse document that posted it: IN-2026-0007, RET-2026-0002. */
  order: { id: string; number: string } | null;
}

export interface MovesQuery {
  from: string;
  to: string;
  itemId?: string | null;
  /** Moves into or out of this person's own stock. */
  employeeId?: string | null;
  /** The document's kind: receipt, handover, use, damage, count_adjustment, reversal, supplier_return. */
  kind?: string | null;
  limit?: number;
  /** The last row's id from the page before. */
  cursor?: number | null;
}

const KINDS = ["receipt", "handover", "use", "damage", "count_adjustment", "reversal", "supplier_return"];

interface MoveDbRow {
  id: string;
  posted_at: Date;
  doc_id: string;
  kind: string;
  reason: string | null;
  step: string;
  item_id: string;
  name: string;
  unit: string;
  step_size: string;
  icon: string | null;
  from_id: string;
  from_kind: string;
  from_name: string | null;
  from_employee: string | null;
  to_id: string;
  to_kind: string;
  to_name: string | null;
  to_employee: string | null;
  qty: string;
  posted_by: string;
  supplier: string | null;
  order_id: string | null;
  order_number: string | null;
}

function checkMoves(q: MovesQuery): { start: Date; end: Date } {
  const r = checkRange(q.from, q.to);
  if (q.itemId && !UUID_RE.test(q.itemId)) throw new InventoryRefused("No such item.", 404, "no_item");
  if (q.employeeId && !UUID_RE.test(q.employeeId)) throw new InventoryRefused("No such person.", 404, "no_person");
  if (q.kind && !KINDS.includes(q.kind)) throw new InventoryRefused("Unknown kind of document.", 400, "bad_kind");
  if (q.cursor !== undefined && q.cursor !== null && !(Number.isSafeInteger(q.cursor) && q.cursor > 0)) throw new InventoryRefused("That page marker is not valid.", 400, "bad_cursor");
  return r;
}

async function moveRows(tx: Tx, q: MovesQuery, range: { start: Date; end: Date }, limit: number): Promise<MoveDbRow[]> {
  return tx<MoveDbRow[]>`
    select m.id::text as id, m.posted_at, m.doc_id, d.kind, d.reason, m.step, m.item_id, i.name, i.unit, i.step::text as step_size, i.icon,
           lf.id as from_id, lf.kind as from_kind, lf.name as from_name, lf.employee_id as from_employee,
           lt.id as to_id, lt.kind as to_kind, lt.name as to_name, lt.employee_id as to_employee,
           m.qty::text as qty, m.posted_by, d.supplier, o.id as order_id, o.number as order_number
      from stock_move m
      join stock_doc d on d.id = m.doc_id
      join inv_item i on i.id = m.item_id
      join inv_location lf on lf.id = m.from_location_id
      join inv_location lt on lt.id = m.to_location_id
      left join wh_order o on o.stock_doc_id = d.id
     where m.posted_at >= ${range.start} and m.posted_at < ${range.end}
       and (${q.itemId ?? null}::uuid is null or m.item_id = ${q.itemId ?? null})
       and (${q.employeeId ?? null}::uuid is null or lf.employee_id = ${q.employeeId ?? null} or lt.employee_id = ${q.employeeId ?? null})
       and (${q.kind ?? null}::text is null or d.kind = ${q.kind ?? null})
       and (${q.cursor ?? null}::bigint is null or m.id < ${q.cursor ?? null})
     order by m.id desc
     limit ${limit}`;
}

const moveOf = (names: Map<string, string>, r: MoveDbRow): MoveRow => ({
  id: Number(r.id),
  at: r.posted_at.toISOString(),
  docId: r.doc_id,
  kind: r.kind,
  reason: r.reason,
  step: r.step,
  item: { id: r.item_id, name: r.name, unit: r.unit, step: Number(r.step_size), icon: r.icon },
  from: placeOf(names, { id: r.from_id, kind: r.from_kind, name: r.from_name, employee_id: r.from_employee }),
  to: placeOf(names, { id: r.to_id, kind: r.to_kind, name: r.to_name, employee_id: r.to_employee }),
  qty: num(r.qty),
  by: { id: r.posted_by, name: names.get(r.posted_by) ?? "—" },
  supplier: r.supplier,
  order: r.order_id ? { id: r.order_id, number: r.order_number ?? "" } : null,
});

export interface MovesReport {
  rows: MoveRow[];
  /** Over the whole filter, not just this page: what came into and went out of the warehouse — or the person's stock. */
  totals: (ItemRef & { into: number; outOf: number })[];
  more: boolean;
  cursor: number | null;
}

export async function moveReport(viewer: ViewerOrg, q: MovesQuery): Promise<MovesReport> {
  requireRead(viewer);
  const range = checkMoves(q);
  await refuseWhileCounting(viewer);
  const limit = Math.min(Math.max(Math.trunc(q.limit ?? 100), 1), 500);
  const { rows, totals } = await withContext(
    viewer,
    async (tx) => {
      const rows = await moveRows(tx, q, range, limit + 1);
      // In and out of the warehouse — or, with a person chosen, of that person's own stock.
      const totals = await tx<{ item_id: string; name: string; unit: string; step: string; icon: string | null; into: string; out_of: string }[]>`
        with p as (
          select case when ${q.employeeId ?? null}::uuid is null then ${PLACE.warehouse}::uuid
                      else (select id from inv_location where kind = 'person' and employee_id = ${q.employeeId ?? null}) end as id
        )
        select m.item_id, i.name, i.unit, i.step::text as step, i.icon,
               coalesce(sum(m.qty) filter (where m.to_location_id = p.id), 0)::text as into,
               coalesce(sum(m.qty) filter (where m.from_location_id = p.id), 0)::text as out_of
          from stock_move m
          join stock_doc d on d.id = m.doc_id
          join inv_item i on i.id = m.item_id
          cross join p
         where m.posted_at >= ${range.start} and m.posted_at < ${range.end}
           and (${q.itemId ?? null}::uuid is null or m.item_id = ${q.itemId ?? null})
           and (${q.kind ?? null}::text is null or d.kind = ${q.kind ?? null})
           and (m.to_location_id = p.id or m.from_location_id = p.id)
         group by m.item_id, i.name, i.unit, i.step, i.icon, i.sort_order
         order by i.sort_order, lower(i.name)`;
      return { rows, totals };
    },
    { readOnly: true },
  );
  const page = rows.slice(0, limit);
  const names = await namesOf(page.flatMap((r) => [r.posted_by, r.from_employee, r.to_employee]));
  const last = page[page.length - 1];
  return {
    rows: page.map((r) => moveOf(names, r)),
    totals: totals.map((t) => ({ id: t.item_id, name: t.name, unit: t.unit, step: Number(t.step), icon: t.icon, into: num(t.into), outOf: num(t.out_of) })),
    more: rows.length > limit,
    cursor: rows.length > limit && last ? Number(last.id) : null,
  };
}

const KIND_WORDS: Readonly<Record<string, string>> = {
  receipt: "Delivery in",
  handover: "Handover",
  use: "Used",
  damage: "Damaged",
  count_adjustment: "Count adjustment",
  reversal: "Reversal",
  supplier_return: "Returned to supplier",
};
const dubai = (d: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
    .format(new Date(d))
    .replace(",", "");
/** A spreadsheet cell: quoted when it must be; a leading = + - @ is made text, so a spreadsheet never runs it as a formula. */
const cell = (v: string | number | null): string => {
  if (v === null) return "";
  let s = String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The movements as a CSV file — at most CSV_MAX_ROWS rows, newest first; past it, a last line says how many more there were. */
export async function moveReportCsv(viewer: ViewerOrg, q: Omit<MovesQuery, "limit" | "cursor">): Promise<{ csv: string; rows: number; more: number }> {
  requireRead(viewer);
  const range = checkMoves(q);
  await refuseWhileCounting(viewer);
  const { rows, total } = await withContext(
    viewer,
    async (tx) => {
      const rows = await moveRows(tx, { ...q, cursor: null }, range, CSV_MAX_ROWS);
      const [n] = await tx<{ n: number }[]>`
        select count(*)::int as n
          from stock_move m join stock_doc d on d.id = m.doc_id
          join inv_location lf on lf.id = m.from_location_id join inv_location lt on lt.id = m.to_location_id
         where m.posted_at >= ${range.start} and m.posted_at < ${range.end}
           and (${q.itemId ?? null}::uuid is null or m.item_id = ${q.itemId ?? null})
           and (${q.employeeId ?? null}::uuid is null or lf.employee_id = ${q.employeeId ?? null} or lt.employee_id = ${q.employeeId ?? null})
           and (${q.kind ?? null}::text is null or d.kind = ${q.kind ?? null})`;
      return { rows, total: n!.n };
    },
    { readOnly: true },
  );
  const names = await namesOf(rows.flatMap((r) => [r.posted_by, r.from_employee, r.to_employee]));
  const head = ["Time (Dubai)", "Kind", "Reason", "Item", "Amount", "Unit", "From", "To", "By", "Supplier", "Document", "Move"];
  const lines = [head.map(cell).join(",")];
  for (const r of rows) {
    const m = moveOf(names, r);
    lines.push(
      [dubai(m.at), KIND_WORDS[m.kind] ?? m.kind, m.reason, m.item.name, m.qty, m.item.unit, m.from.name, m.to.name, m.by.name, m.supplier, m.order?.number ?? m.docId, m.id]
        .map(cell)
        .join(","),
    );
  }
  const more = Math.max(total - rows.length, 0);
  if (more > 0) lines.push(cell(`… and ${more} more moves not in this file — choose fewer days, or one item.`));
  return { csv: `${lines.join("\r\n")}\r\n`, rows: rows.length, more };
}

// ── one item ─────────────────────────────────────────────────────────────────
export interface ItemTracking {
  item: ItemRef & { category: string; active: boolean };
  now: { place: PlaceRef; qty: number }[];
  lots: { code: string; supplier: string; receivedOn: string; bestBefore: string | null; variety: string | null; qty: number; kg: number | null; order: { id: string; number: string } }[];
  moves: MoveRow[];
  more: boolean;
}

/** One item: where every unit of it is now, the lots it came in, and its moves over a range (newest first). */
export async function itemTracking(viewer: ViewerOrg, itemId: string, q: { from: string; to: string; limit?: number }): Promise<ItemTracking | null> {
  requireRead(viewer);
  if (!UUID_RE.test(itemId)) return null;
  const range = checkRange(q.from, q.to);
  await refuseWhileCounting(viewer);
  const limit = Math.min(Math.max(Math.trunc(q.limit ?? 200), 1), 500);
  const res = await withContext(
    viewer,
    async (tx) => {
      const [item] = await tx<{ id: string; name: string; unit: string; step: string; icon: string | null; category: string; active: boolean }[]>`
        select id, name, unit, step::text as step, icon, category, active from inv_item where id = ${itemId}`;
      if (!item) return null;
      const now = await tx<{ id: string; kind: string; name: string | null; employee_id: string | null; qty: string }[]>`
        select l.id, l.kind, l.name, l.employee_id, b.qty::text as qty
          from stock_balance b join inv_location l on l.id = b.location_id
         where b.item_id = ${itemId} and not l.is_virtual and b.qty <> 0
         order by l.kind = 'warehouse' desc, l.kind = 'in_transit' desc`;
      const lots = await tx<{ code: string; supplier: string; received_on: string; best_before: string | null; variety: string | null; qty: string; weight_g: string | null; order_id: string; number: string }[]>`
        select lot.code, s.name as supplier, lot.received_on::text as received_on, lot.best_before::text as best_before, lot.variety, lot.qty::text as qty,
               lot.weight_g::text as weight_g, o.id as order_id, o.number
          from inv_lot lot join supplier s on s.id = lot.supplier_id join wh_order o on o.id = lot.order_id
         where lot.item_id = ${itemId}
         order by lot.received_on desc, lot.code desc
         limit 30`;
      const moves = await moveRows(tx, { from: q.from, to: q.to, itemId }, range, limit + 1);
      return { item, now, lots, moves };
    },
    { readOnly: true },
  );
  if (!res) return null;
  const names = await namesOf([...res.now.map((n) => n.employee_id), ...res.moves.flatMap((m) => [m.posted_by, m.from_employee, m.to_employee])]);
  return {
    item: { id: res.item.id, name: res.item.name, unit: res.item.unit, step: Number(res.item.step), icon: res.item.icon, category: res.item.category, active: res.item.active },
    now: res.now.map((n) => ({ place: placeOf(names, n), qty: num(n.qty) })),
    lots: res.lots.map((l) => ({
      code: l.code,
      supplier: l.supplier,
      receivedOn: l.received_on,
      bestBefore: l.best_before,
      variety: l.variety,
      qty: num(l.qty),
      kg: l.weight_g === null ? null : Number(l.weight_g) / 1000,
      order: { id: l.order_id, number: l.number },
    })),
    moves: res.moves.slice(0, limit).map((m) => moveOf(names, m)),
    more: res.moves.length > limit,
  };
}

// ── suppliers over a range ───────────────────────────────────────────────────
export interface SupplierRow {
  supplier: { id: string; name: string; code: string | null };
  /** Receipts done in the range. */
  receipts: number;
  /** Of those with a day expected: done on or before it. */
  scheduled: number;
  onTime: number;
  /** Receipt lines done in the range, and those with everything expected. */
  lines: number;
  linesComplete: number;
  /**
   * Lines that came and were weighed against a note's weight: the note's kilograms for what came (8 of 10 cartons → 8/10 of
   * them), the scale's kilograms, and the lines lighter than that beyond the tolerance.
   */
  kgExpected: number | null;
  kgReceived: number | null;
  linesLight: number;
  /** Returns done in the range, and their lines. */
  returns: number;
  returnLines: number;
  /** Receipts not done yet; of those, past their day. */
  open: number;
  overdue: number;
}

/** The rows, and the weight tolerance they were counted with — so a page explains "lighter" with the server's own figure. */
export async function supplierReport(viewer: ViewerOrg, q: { from: string; to: string }, now: Date = new Date()): Promise<{ lightShare: number; rows: SupplierRow[] }> {
  requireRead(viewer);
  const range = checkRange(q.from, q.to);
  const today = localDate(now);
  const rows = await withContext(
    viewer,
    async (tx) =>
      tx<{
        id: string;
        name: string;
        code: string | null;
        receipts: number;
        scheduled: number;
        on_time: number;
        lines: number;
        lines_complete: number;
        kg_expected: string | null;
        kg_received: string | null;
        lines_light: number;
        returns: number;
        return_lines: number;
        open: number;
        overdue: number;
      }[]>`
        with done as (
          select o.* from wh_order o where o.state = 'done' and o.done_at >= ${range.start} and o.done_at < ${range.end}
        ), rl as (
          select o.supplier_id, l.*
            from done o join wh_order_line l on l.order_id = o.id
           where o.kind = 'receipt'
        )
        select s.id, s.name, s.code,
               (select count(*)::int from done o where o.supplier_id = s.id and o.kind = 'receipt') as receipts,
               (select count(*)::int from done o where o.supplier_id = s.id and o.kind = 'receipt' and o.scheduled_on is not null) as scheduled,
               (select count(*)::int from done o where o.supplier_id = s.id and o.kind = 'receipt' and o.scheduled_on is not null
                   and (o.done_at at time zone 'Asia/Dubai')::date <= o.scheduled_on) as on_time,
               (select count(*)::int from rl where rl.supplier_id = s.id) as lines,
               (select count(*)::int from rl where rl.supplier_id = s.id and rl.done_qty >= rl.expected_qty) as lines_complete,
               -- The note's weight for what came (noteGramsFor in warehouse.ts): 8 of 10 cartons are held to 8/10 of its kilograms.
               (select sum(round(rl.expected_g * rl.done_qty / rl.expected_qty))::text from rl
                 where rl.supplier_id = s.id and rl.expected_g is not null and rl.done_g is not null and rl.done_qty > 0) as kg_expected,
               (select sum(rl.done_g)::text from rl
                 where rl.supplier_id = s.id and rl.expected_g is not null and rl.done_g is not null and rl.done_qty > 0) as kg_received,
               (select count(*)::int from rl where rl.supplier_id = s.id and rl.expected_g is not null and rl.done_g is not null and rl.done_qty > 0
                   and rl.done_g < round(rl.expected_g * rl.done_qty / rl.expected_qty) * (1 - ${SHORT_WEIGHT_SHARE}::numeric)) as lines_light,
               (select count(*)::int from done o where o.supplier_id = s.id and o.kind = 'supplier_return') as returns,
               (select count(*)::int from done o join wh_order_line l on l.order_id = o.id
                 where o.supplier_id = s.id and o.kind = 'supplier_return' and l.done_qty > 0) as return_lines,
               (select count(*)::int from wh_order o where o.supplier_id = s.id and o.kind = 'receipt' and o.state in ('draft', 'ready')) as open,
               (select count(*)::int from wh_order o where o.supplier_id = s.id and o.kind = 'receipt' and o.state in ('draft', 'ready')
                   and o.scheduled_on < ${today}::date) as overdue
          from supplier s
         order by s.active desc, lower(s.name)`,
    { readOnly: true },
  );
  const out = rows
    .filter((r) => r.receipts + r.returns + r.open > 0)
    .map((r) => ({
      supplier: { id: r.id, name: r.name, code: r.code },
      receipts: r.receipts,
      scheduled: r.scheduled,
      onTime: r.on_time,
      lines: r.lines,
      linesComplete: r.lines_complete,
      kgExpected: r.kg_expected === null ? null : Number(r.kg_expected) / 1000,
      kgReceived: r.kg_received === null ? null : Number(r.kg_received) / 1000,
      linesLight: r.lines_light,
      returns: r.returns,
      returnLines: r.return_lines,
      open: r.open,
      overdue: r.overdue,
    }));
  return { lightShare: SHORT_WEIGHT_SHARE, rows: out };
}
