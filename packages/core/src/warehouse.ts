import { getServiceSql, withContext, type Tx } from "./db.js";
import { InventoryRefused, PLACE, UUID_RE, correlationOf, fmt, fromMilli, parseQty, requestHash, requireCan, toMilli } from "./inventory-common.js";
import { postSupplierDoc } from "./inventory-ledger.js";
import { approvers, figuresHiddenFrom, noticeLowStock, tell, warehouseItemsOf } from "./inventory-notify.js";
import type { ViewerOrg } from "./org.js";
import { can } from "./permissions.js";
import { localDate } from "./time.js";

/**
 * Warehouse documents (TASK-086, migration 0042) — the plan on top of the stock ledger, modelled on Televend's Warehouse
 * Management (its user guide 1.1) and made stricter:
 *
 *   a receipt     expected from a supplier (draft → ready), received against what was expected — units AND kilograms — then
 *                 done: the ledger's delivery is posted in the same transaction, every line received becomes a lot, and a
 *                 shortfall leaves a backorder (a new ready receipt for the rest) or is closed short, as the receiver chooses
 *   a return      to the supplier, with a reason — from a received delivery (never more than came in it, less what went back
 *                 already) or on its own; done posts the ledger's 'supplier_return' (warehouse → Suppliers)
 *
 * What the ledger already guarantees still holds: items in use, whole steps, never below zero, the same id posted once, a
 * reversal by an approver to undo stock. Who is told is a fixed rule, never a model: a delivery short of its note — in units,
 * or in kilograms beyond SHORT_WEIGHT_SHARE — and every return reach the approvers (the Ops Head; with none, the CEO).
 */

export const RETURN_REASONS = ["quality", "wrong_item", "excess", "damaged_on_arrival", "expired", "other"] as const;
export type ReturnReason = (typeof RETURN_REASONS)[number];
export type OrderKind = "receipt" | "supplier_return";
export type OrderState = "draft" | "ready" | "done" | "cancelled";
/**
 * UNVERIFIED: a delivery this much lighter than its note is short — the proposal's placeholder (A-T85.4, "2 % short delivery"),
 * for FreshNow to set after the pilot measures what a carton loses between the farm and the door.
 */
export const SHORT_WEIGHT_SHARE = 0.02;
const MAX_LINES = 60;

/**
 * The note's weight for what came, in grams: a note weighs what was expected, so 8 of 10 cartons are held to 8/10 of its
 * kilograms — cartons that never came are counted short once, in cartons, not again as weight. Rounded to whole grams, as the
 * supplier report rounds it (warehouse-reports.ts).
 */
export function noteGramsFor(expectedMilli: number, doneMilli: number, expectedG: number): number {
  return expectedMilli > 0 ? Math.round(expectedG * (doneMilli / expectedMilli)) : 0;
}

/** Lighter than the note's weight for what came, beyond SHORT_WEIGHT_SHARE. Nothing came, or nothing weighed: not a weight question. */
export function isLight(expectedMilli: number, doneMilli: number, expectedG: number | null, doneG: number | null): boolean {
  if (expectedG === null || doneG === null || doneMilli <= 0) return false;
  return doneG < noteGramsFor(expectedMilli, doneMilli, expectedG) * (1 - SHORT_WEIGHT_SHARE);
}

// ── small helpers ─────────────────────────────────────────────────────────────
const cleanText = (s: string | null | undefined, max: number): string | null => {
  const t = s?.trim().replace(/\s+/g, " ");
  return t ? t.slice(0, max) : null;
};
const dayOk = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d);
const kgText = (g: number) => `${(g / 1000).toLocaleString("en-GB", { maximumFractionDigits: 3 })} kg`;

/** Kilograms as whole grams — "18.5" is 18,500 g; at most three decimals, more than 0, at most 100 tonnes. */
export function parseKg(kg: number | string | null | undefined, what = "weight", allowZero = false): number | null {
  if (kg === null || kg === undefined || kg === "") return null;
  const s = typeof kg === "number" ? String(kg) : kg.trim();
  if (!/^\d{1,6}(\.\d{1,3})?$/.test(s)) throw new InventoryRefused(`The ${what} is in kilograms, with at most three decimals.`, 400, "bad_weight");
  const g = Math.round(Number(s) * 1000);
  if (g === 0 && !allowZero) throw new InventoryRefused(`The ${what} must be more than zero.`, 400, "bad_weight");
  if (g > 100_000_000) throw new InventoryRefused(`The ${what} is at most 100,000 kg.`, 400, "bad_weight");
  return g;
}

function requireRead(viewer: ViewerOrg): void {
  if (viewer.status !== "active" || !can(viewer, "inventory.read")) throw new InventoryRefused("Warehouse documents are for the people who see all stock.", 403, "not_allowed");
}

async function auditWh(tx: Tx, a: { correlationId: string; actor: string; action: string; entityId: string; detail: Record<string, unknown> }): Promise<void> {
  await tx`
    insert into audit_log (correlation_id, actor, action, entity, entity_id, detail)
    values (${a.correlationId}, ${a.actor}, ${a.action}, 'wh_order', ${a.entityId}, ${tx.json(a.detail as never)})`;
}

const isSyntheticPerson = async (tx: Tx, employeeId: string): Promise<boolean> =>
  ((await tx<{ s: boolean }[]>`select is_synthetic as s from employee where id = ${employeeId}`)[0]?.s ?? false);

// ── suppliers ────────────────────────────────────────────────────────────────
export interface Supplier {
  id: string;
  name: string;
  code: string | null;
  leadDays: number | null;
  note: string | null;
  active: boolean;
  /** Receipts not done yet (draft or ready). */
  open: number;
  /** The Dubai day of its last delivery received. */
  lastDelivery: string | null;
}

export async function listSuppliers(viewer: ViewerOrg): Promise<Supplier[]> {
  requireRead(viewer);
  return withContext(
    viewer,
    async (tx) => {
      const rows = await tx<{ id: string; name: string; code: string | null; lead_days: number | null; note: string | null; active: boolean; open: number; last: Date | null }[]>`
        select s.id, s.name, s.code, s.lead_days, s.note, s.active,
               (select count(*)::int from wh_order o where o.supplier_id = s.id and o.kind = 'receipt' and o.state in ('draft', 'ready')) as open,
               (select max(o.done_at) from wh_order o where o.supplier_id = s.id and o.kind = 'receipt' and o.state = 'done') as last
          from supplier s
         order by s.active desc, lower(s.name)`;
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        code: r.code,
        leadDays: r.lead_days,
        note: r.note,
        active: r.active,
        open: r.open,
        lastDelivery: r.last ? localDate(r.last) : null,
      }));
    },
    { readOnly: true },
  );
}

export interface SupplierIn {
  /** Absent: a new supplier. */
  id?: string;
  name: string;
  code?: string | null;
  leadDays?: number | null;
  note?: string | null;
  active?: boolean;
}

export async function saveSupplier(viewer: ViewerOrg, req: SupplierIn, opts: { correlationId?: string } = {}): Promise<{ id: string; created: boolean }> {
  requireCan(viewer, "inventory.move", "Only the warehouse keeps the list of suppliers.");
  const name = cleanText(req.name, 200) ?? "";
  if (name.length < 1 || name.length > 80) throw new InventoryRefused("A supplier's name is 1–80 characters.", 400, "bad_name");
  const code = req.code?.trim() ? req.code.trim().toUpperCase() : null;
  if (code !== null && !/^[A-Z0-9-]{2,12}$/.test(code)) throw new InventoryRefused("A code is 2–12 letters, digits or dashes: FVC, AL-AWIR.", 400, "bad_code");
  const leadDays = req.leadDays === undefined || req.leadDays === null ? null : Number(req.leadDays);
  if (leadDays !== null && !(Number.isInteger(leadDays) && leadDays >= 0 && leadDays <= 60)) throw new InventoryRefused("Days to deliver: a whole number from 0 to 60.", 400, "bad_lead");
  const note = cleanText(req.note, 300);
  if (req.id !== undefined && !UUID_RE.test(req.id)) throw new InventoryRefused("No such supplier.", 404, "no_supplier");
  const correlationId = correlationOf(opts.correlationId);
  return getServiceSql().begin(async (tx) => {
    const clash = await tx<{ id: string; name: string; code: string | null }[]>`
      select id, name, code from supplier
       where (lower(btrim(name)) = lower(${name}) or (${code}::text is not null and code = ${code}))
         and (${req.id ?? null}::uuid is null or id <> ${req.id ?? null})`;
    if (clash.length > 0) {
      const c = clash[0]!;
      throw new InventoryRefused(c.name.toLowerCase() === name.toLowerCase() ? `There is already a supplier called ${c.name}.` : `The code ${code} is already ${c.name}'s.`, 409, "supplier_taken");
    }
    if (!req.id) {
      const synthetic = await isSyntheticPerson(tx, viewer.employeeId);
      const [r] = await tx<{ id: string }[]>`
        insert into supplier (name, code, lead_days, note, active, created_by, is_synthetic)
        values (${name}, ${code}, ${leadDays}, ${note}, ${req.active ?? true}, ${viewer.employeeId}, ${synthetic})
        returning id`;
      await tx`
        insert into audit_log (correlation_id, actor, action, entity, entity_id, detail)
        values (${correlationId}, ${`employee:${viewer.employeeId}`}, 'wh.supplier_created', 'supplier', ${r!.id}, ${tx.json({ name, code, leadDays } as never)})`;
      return { id: r!.id, created: true };
    }
    const [old] = await tx<{ name: string; code: string | null; lead_days: number | null; active: boolean }[]>`
      select name, code, lead_days, active from supplier where id = ${req.id} for update`;
    if (!old) throw new InventoryRefused("No such supplier.", 404, "no_supplier");
    await tx`
      update supplier set name = ${name}, code = ${code}, lead_days = ${leadDays}, note = ${note}, active = ${req.active ?? old.active}, updated_at = now()
       where id = ${req.id}`;
    await tx`
      insert into audit_log (correlation_id, actor, action, entity, entity_id, detail)
      values (${correlationId}, ${`employee:${viewer.employeeId}`}, 'wh.supplier_changed', 'supplier', ${req.id},
              ${tx.json({ before: { name: old.name, code: old.code, leadDays: old.lead_days, active: old.active }, after: { name, code, leadDays, active: req.active ?? old.active } } as never)})`;
    return { id: req.id, created: false };
  });
}

// ── lines ────────────────────────────────────────────────────────────────────
export interface OrderLineIn {
  itemId: string;
  /** In the item's unit: what is expected (a receipt) or to go back (a return). */
  qty: number | string;
  /** The delivery note's kilograms (a receipt), or the kilograms going back. */
  kg?: number | string | null;
  variety?: string | null;
  /** YYYY-MM-DD, as the carton says. */
  bestBefore?: string | null;
  note?: string | null;
}

interface CheckedLine {
  itemId: string;
  name: string;
  unit: string;
  milli: number;
  grams: number | null;
  variety: string | null;
  bestBefore: string | null;
  note: string | null;
}

/** One line per item, every item known and in use, every amount a whole number of its steps; kilograms as grams. */
async function checkLines(tx: Tx, lines: readonly OrderLineIn[]): Promise<CheckedLine[]> {
  if (lines.length === 0) throw new InventoryRefused("Add at least one item.", 400, "no_lines");
  if (lines.length > MAX_LINES) throw new InventoryRefused(`At most ${MAX_LINES} items on one document.`, 400, "too_many_lines");
  const ids = lines.map((l) => l.itemId);
  if (ids.some((id) => !UUID_RE.test(id))) throw new InventoryRefused("An item id is not valid.", 400, "bad_item");
  if (new Set(ids).size !== ids.length) throw new InventoryRefused("Each item once per document — add the amounts together.", 400, "duplicate_item");
  const items = new Map(
    (await tx<{ id: string; name: string; unit: string; step: string; active: boolean }[]>`
      select id, name, unit, step::text as step, active from inv_item where id = any(${ids}::uuid[])`).map((r) => [r.id, r]),
  );
  return lines.map((l) => {
    const it = items.get(l.itemId);
    if (!it) throw new InventoryRefused("An item on this document does not exist.", 404, "no_item");
    if (!it.active) throw new InventoryRefused(`${it.name} is no longer in use.`, 409, "item_inactive");
    const milli = parseQty(l.qty, `amount of ${it.name}`);
    if (milli % toMilli(it.step) !== 0) throw new InventoryRefused(`${it.name} is counted in steps of ${fmt(toMilli(it.step), it.unit)}.`, 400, "bad_step");
    const bestBefore = l.bestBefore?.trim() ? l.bestBefore.trim() : null;
    if (bestBefore !== null && !dayOk(bestBefore)) throw new InventoryRefused("A best-before day is YYYY-MM-DD.", 400, "bad_day");
    return {
      itemId: it.id,
      name: it.name,
      unit: it.unit,
      milli,
      grams: parseKg(l.kg, `weight of ${it.name}`),
      variety: cleanText(l.variety, 40),
      bestBefore,
      note: cleanText(l.note, 200),
    };
  });
}

/** IN-2026-0001 / RET-2026-0001: one counter per kind and year, in the document's own transaction (no gaps). */
async function nextNumber(tx: Tx, kind: OrderKind, now: Date): Promise<string> {
  const year = Number(localDate(now).slice(0, 4));
  const [r] = await tx<{ last: number }[]>`
    insert into wh_number (kind, year, last) values (${kind}, ${year}, 1)
    on conflict (kind, year) do update set last = wh_number.last + 1
    returning last`;
  return `${kind === "receipt" ? "IN" : "RET"}-${year}-${String(r!.last).padStart(4, "0")}`;
}

/** What may still go back from a received delivery, per item, in thousandths: received, less every other return of it. */
async function returnable(tx: Tx, receiptId: string, exceptOrder: string | null): Promise<Map<string, number>> {
  const rows = await tx<{ item_id: string; left: string }[]>`
    select l.item_id,
           (coalesce(l.done_qty, 0) - coalesce((
              select sum(case when o.state = 'done' then coalesce(rl.done_qty, 0) else rl.expected_qty end)
                from wh_order o join wh_order_line rl on rl.order_id = o.id and rl.item_id = l.item_id
               where o.return_of = ${receiptId} and o.state <> 'cancelled' and (${exceptOrder}::uuid is null or o.id <> ${exceptOrder})), 0))::text as left
      from wh_order_line l
     where l.order_id = ${receiptId}`;
  return new Map(rows.map((r) => [r.item_id, toMilli(r.left)]));
}

// ── a document ───────────────────────────────────────────────────────────────
export interface OrderRef {
  id: string;
  number: string;
  state: OrderState;
  /** True when this exact request had been made before: nothing was done again. */
  replay: boolean;
}

export interface CreateOrder {
  id: string;
  kind: OrderKind;
  supplierId: string;
  scheduledOn?: string | null;
  priority?: "normal" | "urgent";
  sourceRef?: string | null;
  vehicle?: string | null;
  note?: string | null;
  /** A return: why it goes back. */
  reason?: ReturnReason | null;
  /** A return from this received delivery. */
  returnOf?: string | null;
  lines: readonly OrderLineIn[];
  /** Straight to "ready" — expected, waiting for the truck (or, a return, ready to go). */
  ready?: boolean;
}

export async function createOrder(viewer: ViewerOrg, req: CreateOrder, opts: { correlationId?: string; now?: Date } = {}): Promise<OrderRef> {
  requireCan(viewer, "inventory.move", "Only the warehouse makes warehouse documents.");
  if (!UUID_RE.test(req.id)) throw new InventoryRefused("The document id must be a UUID made by the app.", 400, "bad_id");
  if (req.kind !== "receipt" && req.kind !== "supplier_return") throw new InventoryRefused("A document is a receipt or a return to the supplier.", 400, "bad_kind");
  if (!UUID_RE.test(req.supplierId)) throw new InventoryRefused("Choose a supplier.", 400, "no_supplier");
  const isReturn = req.kind === "supplier_return";
  if (isReturn && !(RETURN_REASONS as readonly string[]).includes(req.reason ?? "")) throw new InventoryRefused("Say why it goes back.", 400, "reason_needed");
  if (!isReturn && req.reason) throw new InventoryRefused("Only a return has a reason.", 400, "bad_reason");
  if (!isReturn && req.returnOf) throw new InventoryRefused("Only a return is made from a delivery.", 400, "bad_return");
  if (req.returnOf && !UUID_RE.test(req.returnOf)) throw new InventoryRefused("No such delivery.", 404, "no_order");
  const note = cleanText(req.note, 500);
  if (req.reason === "other" && !note) throw new InventoryRefused("Say what is wrong in the note.", 400, "note_needed");
  const scheduledOn = req.scheduledOn?.trim() ? req.scheduledOn.trim() : null;
  if (scheduledOn !== null && !dayOk(scheduledOn)) throw new InventoryRefused("The day is YYYY-MM-DD.", 400, "bad_day");
  const priority = req.priority ?? "normal";
  if (priority !== "normal" && priority !== "urgent") throw new InventoryRefused("Priority is normal or urgent.", 400, "bad_priority");
  const sourceRef = cleanText(req.sourceRef, 40);
  const vehicle = isReturn ? null : cleanText(req.vehicle, 20)?.toUpperCase() ?? null;
  const now = opts.now ?? new Date();
  const correlationId = correlationOf(opts.correlationId);
  const hash = requestHash({
    k: req.kind, supplierId: req.supplierId, scheduledOn, priority, sourceRef, vehicle, note, reason: req.reason ?? null,
    returnOf: req.returnOf ?? null, lines: req.lines, ready: req.ready ?? false,
  });
  return getServiceSql().begin(async (tx) => {
    const [again] = await tx<{ request_hash: string; number: string; state: OrderState }[]>`select request_hash, number, state from wh_order where id = ${req.id}`;
    if (again) {
      if (again.request_hash !== hash) throw new InventoryRefused("This document id was already used for something else.", 409, "id_reused");
      return { id: req.id, number: again.number, state: again.state, replay: true };
    }
    const [sup] = await tx<{ name: string; active: boolean }[]>`select name, active from supplier where id = ${req.supplierId}`;
    if (!sup) throw new InventoryRefused("No such supplier.", 404, "no_supplier");
    if (!sup.active) throw new InventoryRefused(`${sup.name} is no longer a supplier in use.`, 409, "supplier_inactive");
    const lines = await checkLines(tx, req.lines);
    if (req.returnOf) {
      const [of] = await tx<{ kind: string; state: string; supplier_id: string; number: string }[]>`
        select kind, state, supplier_id, number from wh_order where id = ${req.returnOf} for update`;
      if (!of || of.kind !== "receipt") throw new InventoryRefused("No such delivery.", 404, "no_order");
      if (of.state !== "done") throw new InventoryRefused(`${of.number} has not been received yet — nothing of it can go back.`, 409, "not_received");
      if (of.supplier_id !== req.supplierId) throw new InventoryRefused(`A return of ${of.number} goes to the supplier it came from.`, 400, "wrong_supplier");
      const left = await returnable(tx, req.returnOf, null);
      for (const l of lines) {
        const may = left.get(l.itemId);
        if (may === undefined) throw new InventoryRefused(`${l.name} did not come in ${of.number}.`, 400, "not_in_delivery");
        if (l.milli > may) throw new InventoryRefused(`At most ${fmt(Math.max(may, 0), l.unit)} of ${l.name} can go back from ${of.number}.`, 409, "more_than_received");
      }
    }
    const number = await nextNumber(tx, req.kind, now);
    const synthetic = await isSyntheticPerson(tx, viewer.employeeId);
    await tx`
      insert into wh_order (id, kind, number, state, supplier_id, scheduled_on, priority, source_ref, vehicle, note, reason, return_of,
                            created_by, request_hash, is_synthetic, correlation_id)
      values (${req.id}, ${req.kind}, ${number}, 'draft', ${req.supplierId}, ${scheduledOn}, ${priority}, ${sourceRef}, ${vehicle}, ${note},
              ${req.reason ?? null}, ${req.returnOf ?? null}, ${viewer.employeeId}, ${hash}, ${synthetic}, ${correlationId})`;
    await insertLines(tx, req.id, lines);
    let state: OrderState = "draft";
    if (req.ready) {
      await tx`update wh_order set state = 'ready', ready_by = ${viewer.employeeId}, ready_at = now() where id = ${req.id}`;
      state = "ready";
    }
    await auditWh(tx, {
      correlationId, actor: `employee:${viewer.employeeId}`, action: "wh.order_created", entityId: req.id,
      detail: { kind: req.kind, number, supplier: sup.name, state, returnOf: req.returnOf ?? null, lines: lines.map((l) => ({ item: l.name, qty: fromMilli(l.milli), g: l.grams })) },
    });
    return { id: req.id, number, state, replay: false };
  });
}

async function insertLines(tx: Tx, orderId: string, lines: readonly CheckedLine[]): Promise<void> {
  for (const l of lines) {
    await tx`
      insert into wh_order_line (order_id, item_id, expected_qty, expected_g, variety, best_before, note)
      values (${orderId}, ${l.itemId}, ${fromMilli(l.milli)}::numeric, ${l.grams}, ${l.variety}, ${l.bestBefore}::date, ${l.note})`;
  }
}

interface OrderRow {
  id: string;
  kind: OrderKind;
  number: string;
  state: OrderState;
  supplier_id: string;
  supplier_name: string;
  scheduled_on: string | null;
  priority: "normal" | "urgent";
  source_ref: string | null;
  vehicle: string | null;
  note: string | null;
  reason: ReturnReason | null;
  return_of: string | null;
  backorder_of: string | null;
  stock_doc_id: string | null;
  created_by: string;
  is_synthetic: boolean;
}

async function lockOrder(tx: Tx, id: string): Promise<OrderRow> {
  if (!UUID_RE.test(id)) throw new InventoryRefused("No such document.", 404, "no_order");
  const [o] = await tx<OrderRow[]>`
    select o.id, o.kind, o.number, o.state, o.supplier_id, s.name as supplier_name, o.scheduled_on::text as scheduled_on, o.priority,
           o.source_ref, o.vehicle, o.note, o.reason, o.return_of, o.backorder_of, o.stock_doc_id, o.created_by, o.is_synthetic
      from wh_order o join supplier s on s.id = o.supplier_id
     where o.id = ${id}
     for update of o`;
  if (!o) throw new InventoryRefused("No such document.", 404, "no_order");
  return o;
}

export interface UpdateOrder {
  scheduledOn?: string | null;
  priority?: "normal" | "urgent";
  sourceRef?: string | null;
  vehicle?: string | null;
  note?: string | null;
  reason?: ReturnReason | null;
  /** A draft only: the new lines, all of them. */
  lines?: readonly OrderLineIn[];
}

/** Change a draft (anything) or a ready document (its day, priority, paper, truck and note — the lines need it back as a draft). */
export async function updateOrder(viewer: ViewerOrg, id: string, req: UpdateOrder, opts: { correlationId?: string } = {}): Promise<OrderRef> {
  requireCan(viewer, "inventory.move", "Only the warehouse changes warehouse documents.");
  const correlationId = correlationOf(opts.correlationId);
  return getServiceSql().begin(async (tx) => {
    const o = await lockOrder(tx, id);
    if (o.state === "done" || o.state === "cancelled") throw new InventoryRefused(`${o.number} is ${o.state} — it is not changed any more.`, 409, "closed");
    if (req.lines && o.state !== "draft") throw new InventoryRefused(`Put ${o.number} back to draft to change its lines.`, 409, "not_draft");
    const scheduledOn = req.scheduledOn === undefined ? o.scheduled_on : req.scheduledOn?.trim() ? req.scheduledOn.trim() : null;
    if (scheduledOn !== null && !dayOk(scheduledOn)) throw new InventoryRefused("The day is YYYY-MM-DD.", 400, "bad_day");
    const priority = req.priority ?? o.priority;
    if (priority !== "normal" && priority !== "urgent") throw new InventoryRefused("Priority is normal or urgent.", 400, "bad_priority");
    const sourceRef = req.sourceRef === undefined ? o.source_ref : cleanText(req.sourceRef, 40);
    const vehicle = o.kind === "supplier_return" ? null : req.vehicle === undefined ? o.vehicle : (cleanText(req.vehicle, 20)?.toUpperCase() ?? null);
    const note = req.note === undefined ? o.note : cleanText(req.note, 500);
    let reason = o.reason;
    if (req.reason !== undefined) {
      if (o.kind !== "supplier_return") throw new InventoryRefused("Only a return has a reason.", 400, "bad_reason");
      if (!(RETURN_REASONS as readonly string[]).includes(req.reason ?? "")) throw new InventoryRefused("Say why it goes back.", 400, "reason_needed");
      reason = req.reason;
    }
    if (reason === "other" && !note) throw new InventoryRefused("Say what is wrong in the note.", 400, "note_needed");
    let lines: CheckedLine[] | null = null;
    if (req.lines) {
      lines = await checkLines(tx, req.lines);
      if (o.return_of) {
        const left = await returnable(tx, o.return_of, o.id);
        for (const l of lines) {
          const may = left.get(l.itemId);
          if (may === undefined) throw new InventoryRefused(`${l.name} did not come in that delivery.`, 400, "not_in_delivery");
          if (l.milli > may) throw new InventoryRefused(`At most ${fmt(Math.max(may, 0), l.unit)} of ${l.name} can go back.`, 409, "more_than_received");
        }
      }
      await tx`delete from wh_order_line where order_id = ${o.id}`;
      await insertLines(tx, o.id, lines);
    }
    await tx`
      update wh_order set scheduled_on = ${scheduledOn}::date, priority = ${priority}, source_ref = ${sourceRef}, vehicle = ${vehicle},
                          note = ${note}, reason = ${reason}
       where id = ${o.id}`;
    await auditWh(tx, {
      correlationId, actor: `employee:${viewer.employeeId}`, action: "wh.order_changed", entityId: o.id,
      detail: {
        number: o.number,
        before: { scheduledOn: o.scheduled_on, priority: o.priority, sourceRef: o.source_ref, vehicle: o.vehicle, reason: o.reason },
        after: { scheduledOn, priority, sourceRef, vehicle, reason },
        lines: lines ? lines.map((l) => ({ item: l.name, qty: fromMilli(l.milli), g: l.grams })) : "unchanged",
      },
    });
    return { id: o.id, number: o.number, state: o.state, replay: false };
  });
}

/** Draft → ready ("to do": expected, or ready to go back), or ready → draft to change its lines. The same step twice is not an error. */
export async function setOrderReady(viewer: ViewerOrg, id: string, ready: boolean, opts: { correlationId?: string } = {}): Promise<OrderRef> {
  requireCan(viewer, "inventory.move", "Only the warehouse changes warehouse documents.");
  const correlationId = correlationOf(opts.correlationId);
  return getServiceSql().begin(async (tx) => {
    const o = await lockOrder(tx, id);
    const want: OrderState = ready ? "ready" : "draft";
    if (o.state === want) return { id: o.id, number: o.number, state: o.state, replay: true };
    if (o.state === "done" || o.state === "cancelled") throw new InventoryRefused(`${o.number} is ${o.state}.`, 409, "closed");
    if (ready) await tx`update wh_order set state = 'ready', ready_by = ${viewer.employeeId}, ready_at = now() where id = ${o.id}`;
    else await tx`update wh_order set state = 'draft' where id = ${o.id}`;
    await auditWh(tx, { correlationId, actor: `employee:${viewer.employeeId}`, action: ready ? "wh.order_ready" : "wh.order_back_to_draft", entityId: o.id, detail: { number: o.number } });
    return { id: o.id, number: o.number, state: want, replay: false };
  });
}

/** A document that will not happen: cancelled with an optional note. A done one is undone by reversing its stock document. */
export async function cancelOrder(viewer: ViewerOrg, id: string, req: { note?: string | null } = {}, opts: { correlationId?: string } = {}): Promise<OrderRef> {
  requireCan(viewer, "inventory.move", "Only the warehouse cancels warehouse documents.");
  const correlationId = correlationOf(opts.correlationId);
  const note = cleanText(req.note, 300);
  return getServiceSql().begin(async (tx) => {
    const o = await lockOrder(tx, id);
    if (o.state === "cancelled") return { id: o.id, number: o.number, state: o.state, replay: true };
    if (o.state === "done") {
      throw new InventoryRefused(`${o.number} is done — its stock is undone by reversing its stock document (the Ops Head, the CEO or an Admin).`, 409, "already_done");
    }
    await tx`update wh_order set state = 'cancelled', cancelled_by = ${viewer.employeeId}, cancelled_at = now(), cancel_note = ${note} where id = ${o.id}`;
    await auditWh(tx, { correlationId, actor: `employee:${viewer.employeeId}`, action: "wh.order_cancelled", entityId: o.id, detail: { number: o.number, note } });
    return { id: o.id, number: o.number, state: "cancelled", replay: false };
  });
}

// ── receiving and returning ──────────────────────────────────────────────────
export interface ValidateOrder {
  /** The ledger document's id, made by the app — sending the same validation twice posts once. */
  stockDocId: string;
  /** Every line of the document once: what came (or went back), 0 for nothing; kilograms as weighed. */
  lines: readonly { itemId: string; qty: number | string; kg?: number | string | null }[];
  /** A receipt short of what was expected: a backorder for the rest (true), or closed short (false). */
  backorder?: boolean;
  /** The backorder's id, made by the app. */
  backorderId?: string | null;
  deviceAt?: string | Date | null;
  mediaIds?: readonly string[];
}

export interface ShortLine {
  itemId: string;
  name: string;
  unit: string;
  expected: number;
  done: number;
  /** The note's kilograms, for everything expected. */
  expectedKg: number | null;
  /** The note's kilograms for what came (noteGramsFor). */
  expectedKgForDone: number | null;
  doneKg: number | null;
  /** Lighter than the note's weight for what came, beyond SHORT_WEIGHT_SHARE (isLight). */
  weightShort: boolean;
}

export interface Validated extends OrderRef {
  stockDocId: string;
  backorder: OrderRef | null;
  /** A delivery in: lines that came short — in units, or lighter than the note's weight for what came (isLight). */
  short: ShortLine[];
}

export async function validateOrder(viewer: ViewerOrg, id: string, req: ValidateOrder, opts: { correlationId?: string; now?: Date } = {}): Promise<Validated> {
  requireCan(viewer, "inventory.move", "Only the warehouse receives deliveries and returns stock.");
  if (!UUID_RE.test(req.stockDocId)) throw new InventoryRefused("The stock document id must be a UUID made by the app.", 400, "bad_id");
  if (req.backorderId && !UUID_RE.test(req.backorderId)) throw new InventoryRefused("The backorder id must be a UUID made by the app.", 400, "bad_id");
  const correlationId = correlationOf(opts.correlationId);
  const now = opts.now ?? new Date();
  const out = await getServiceSql().begin(async (tx): Promise<Validated & { kind: OrderKind; notice: boolean }> => {
    const o = await lockOrder(tx, id);
    if (o.state === "done") {
      // The same validation again — the app retrying — is answered as done; anything else is refused.
      if (o.stock_doc_id === req.stockDocId) {
        const [b] = await tx<{ id: string; number: string; state: OrderState }[]>`select id, number, state from wh_order where backorder_of = ${o.id}`;
        return { id: o.id, number: o.number, state: "done", replay: true, stockDocId: o.stock_doc_id, backorder: b ? { ...b, replay: true } : null, short: [], kind: o.kind, notice: false };
      }
      throw new InventoryRefused(`${o.number} was already ${o.kind === "receipt" ? "received" : "returned"}.`, 409, "already_done");
    }
    if (o.state === "cancelled") throw new InventoryRefused(`${o.number} was cancelled.`, 409, "closed");
    const planned = await tx<{ item_id: string; name: string; unit: string; step: string; expected_qty: string; expected_g: string | null; variety: string | null; best_before: string | null; sort_order: number }[]>`
      select l.item_id, i.name, i.unit, i.step::text as step, l.expected_qty::text as expected_qty, l.expected_g::text as expected_g, l.variety,
             l.best_before::text as best_before, i.sort_order
        from wh_order_line l join inv_item i on i.id = l.item_id
       where l.order_id = ${o.id}
       order by i.sort_order, lower(i.name)`;
    const given = new Map(req.lines.map((l) => [l.itemId, l]));
    if (given.size !== req.lines.length || given.size !== planned.length || planned.some((p) => !given.has(p.item_id))) {
      throw new InventoryRefused("Give what came (or goes back) for every line of the document, once each — 0 for nothing.", 400, "every_line");
    }
    const done = planned.map((p) => {
      const g = given.get(p.item_id)!;
      const milli = parseQty(g.qty, `amount of ${p.name}`, true);
      if (milli % toMilli(p.step) !== 0) throw new InventoryRefused(`${p.name} is counted in steps of ${fmt(toMilli(p.step), p.unit)}.`, 400, "bad_step");
      if (o.kind === "supplier_return" && milli > toMilli(p.expected_qty)) {
        throw new InventoryRefused(`More ${p.name} than the return says (${fmt(toMilli(p.expected_qty), p.unit)}) — change the return first.`, 400, "more_than_planned");
      }
      const grams = parseKg(g.kg, `weight of ${p.name}`, true);
      return { p, milli, grams };
    });
    if (done.every((d) => d.milli === 0)) {
      throw new InventoryRefused(o.kind === "receipt" ? "Nothing was received — keep it waiting, or cancel it." : "Nothing goes back — cancel the return instead.", 409, "nothing_done");
    }
    if (o.return_of) {
      const left = await returnable(tx, o.return_of, o.id);
      for (const d of done) {
        if (d.milli > (left.get(d.p.item_id) ?? 0)) {
          throw new InventoryRefused(`At most ${fmt(Math.max(left.get(d.p.item_id) ?? 0, 0), d.p.unit)} of ${d.p.name} can go back from that delivery.`, 409, "more_than_received");
        }
      }
    }
    // The stock moves first, through the ledger, in this same transaction.
    const posted = await postSupplierDoc(tx, viewer, {
      id: req.stockDocId,
      kind: o.kind,
      supplier: o.supplier_name,
      invoiceNo: o.source_ref,
      note: o.note ? `${o.number} · ${o.note}` : o.number,
      reason: o.reason,
      lines: done.filter((d) => d.milli > 0).map((d) => ({ itemId: d.p.item_id, qty: fromMilli(d.milli), variety: d.p.variety })),
      ...(req.mediaIds ? { mediaIds: req.mediaIds } : {}),
      deviceAt: req.deviceAt ?? null,
      correlationId,
    });
    if (posted.replay) throw new InventoryRefused("That stock document id was already used for something else.", 409, "id_reused");
    for (const d of done) {
      await tx`update wh_order_line set done_qty = ${fromMilli(d.milli)}::numeric, done_g = ${d.grams} where order_id = ${o.id} and item_id = ${d.p.item_id}`;
    }
    const short: ShortLine[] = [];
    for (const d of done) {
      const expected = toMilli(d.p.expected_qty);
      const eg = d.p.expected_g === null ? null : Number(d.p.expected_g);
      const weightShort = isLight(expected, d.milli, eg, d.grams);
      // Short is a delivery's word: a return that goes back with less than planned is not the supplier's shortfall.
      if (o.kind === "receipt" && (d.milli < expected || weightShort)) {
        short.push({
          itemId: d.p.item_id, name: d.p.name, unit: d.p.unit, expected: expected / 1000, done: d.milli / 1000,
          expectedKg: eg === null ? null : eg / 1000, expectedKgForDone: eg === null ? null : noteGramsFor(expected, d.milli, eg) / 1000,
          doneKg: d.grams === null ? null : d.grams / 1000, weightShort,
        });
      }
    }
    let backorder: OrderRef | null = null;
    const unitsShort = done.filter((d) => d.milli < toMilli(d.p.expected_qty));
    if (o.kind === "receipt") {
      // Every line that came is a lot: this delivery's number and the line's place in it.
      const day = localDate(now);
      let n = 0;
      for (const d of done) {
        n++;
        if (d.milli === 0) continue;
        await tx`
          insert into inv_lot (code, item_id, supplier_id, order_id, stock_doc_id, received_on, best_before, variety, qty, weight_g, is_synthetic, correlation_id)
          values (${`${o.number}-${n}`}, ${d.p.item_id}, ${o.supplier_id}, ${o.id}, ${req.stockDocId}, ${day}::date, ${d.p.best_before}::date, ${d.p.variety},
                  ${fromMilli(d.milli)}::numeric, ${d.grams && d.grams > 0 ? d.grams : null}, ${o.is_synthetic}, ${correlationId})`;
      }
      if (unitsShort.length > 0 && req.backorder) {
        if (!req.backorderId) throw new InventoryRefused("A backorder needs its id, made by the app.", 400, "bad_id");
        const number = await nextNumber(tx, "receipt", now);
        await tx`
          insert into wh_order (id, kind, number, state, supplier_id, scheduled_on, priority, source_ref, note, backorder_of, created_by,
                                request_hash, is_synthetic, correlation_id)
          values (${req.backorderId}, 'receipt', ${number}, 'draft', ${o.supplier_id}, ${o.scheduled_on}::date, ${o.priority}, ${o.source_ref},
                  ${`The rest of ${o.number}`}, ${o.id}, ${viewer.employeeId}, ${requestHash({ k: "backorder", of: o.id })}, ${o.is_synthetic}, ${correlationId})`;
        for (const d of unitsShort) {
          await tx`
            insert into wh_order_line (order_id, item_id, expected_qty, variety)
            values (${req.backorderId}, ${d.p.item_id}, ${fromMilli(toMilli(d.p.expected_qty) - d.milli)}::numeric, ${d.p.variety})`;
        }
        await tx`update wh_order set state = 'ready', ready_by = ${viewer.employeeId}, ready_at = now() where id = ${req.backorderId}`;
        backorder = { id: req.backorderId, number, state: "ready", replay: false };
      }
    }
    const closedShort = unitsShort.length > 0 && backorder === null;
    await tx`
      update wh_order set state = 'done', done_by = ${viewer.employeeId}, done_at = now(), stock_doc_id = ${req.stockDocId}, closed_short = ${closedShort}
       where id = ${o.id}`;
    await auditWh(tx, {
      correlationId, actor: `employee:${viewer.employeeId}`, action: o.kind === "receipt" ? "wh.receipt_done" : "wh.return_done", entityId: o.id,
      detail: {
        number: o.number, stockDocId: req.stockDocId, backorder: backorder?.number ?? null, closedShort,
        lines: done.map((d) => ({ item: d.p.name, expected: d.p.expected_qty, done: fromMilli(d.milli), expectedG: d.p.expected_g, doneG: d.grams })),
      },
    });
    return { id: o.id, number: o.number, state: "done", replay: false, stockDocId: req.stockDocId, backorder, short, kind: o.kind, notice: true };
  });
  if (out.notice) {
    // After the commit, best effort (as the ledger's afterPost): who is told never decides whether the stock moved.
    try {
      if (out.kind === "receipt" && out.short.length > 0) await noticeShortDelivery(out.id, out.short, correlationId);
      if (out.kind === "supplier_return") await noticeReturn(out.id, correlationId);
      await noticeLowStock(await warehouseItemsOf(out.stockDocId), { correlationId });
    } catch (err) {
      console.error("[warehouse] a notice failed", err);
    }
  }
  return { id: out.id, number: out.number, state: out.state, replay: out.replay, stockDocId: out.stockDocId, backorder: out.backorder, short: out.short };
}

/** A return of (part of) a received delivery, to the supplier it came from: lines prefilled by the caller, capped by what came. */
export async function startReturn(
  viewer: ViewerOrg,
  receiptId: string,
  req: { id: string; reason: ReturnReason; lines: readonly OrderLineIn[]; note?: string | null; ready?: boolean },
  opts: { correlationId?: string; now?: Date } = {},
): Promise<OrderRef> {
  if (!UUID_RE.test(receiptId)) throw new InventoryRefused("No such delivery.", 404, "no_order");
  const [r] = await getServiceSql()<{ supplier_id: string; kind: string }[]>`select supplier_id, kind from wh_order where id = ${receiptId}`;
  if (!r || r.kind !== "receipt") throw new InventoryRefused("No such delivery.", 404, "no_order");
  return createOrder(
    viewer,
    { id: req.id, kind: "supplier_return", supplierId: r.supplier_id, reason: req.reason, returnOf: receiptId, lines: req.lines, note: req.note ?? null, ready: req.ready ?? true },
    opts,
  );
}

const shortWords = (s: ShortLine): string =>
  [
    s.done < s.expected ? `${s.name} ${s.done.toLocaleString("en-GB")} of ${s.expected.toLocaleString("en-GB")} ${s.unit}${s.expected === 1 ? "" : "s"}` : s.name,
    s.weightShort && s.expectedKgForDone !== null && s.doneKg !== null
      ? `${kgText(Math.round(s.doneKg * 1000))} on the scale against ${kgText(Math.round(s.expectedKgForDone * 1000))} by the note (−${((1 - s.doneKg / s.expectedKgForDone) * 100).toFixed(1)} %)`
      : null,
  ]
    .filter(Boolean)
    .join(", ");

/** A delivery came short of its note: the approvers hear it while the driver may still be at the door. */
async function noticeShortDelivery(orderId: string, short: ShortLine[], correlationId: string): Promise<number> {
  const [o] = await getServiceSql()<{ number: string; supplier: string; done_by: string | null }[]>`
    select o.number, s.name as supplier, o.done_by from wh_order o join supplier s on s.id = o.supplier_id where o.id = ${orderId}`;
  if (!o) return 0;
  return tell({
    to: await approvers([o.done_by]),
    key: `wh.short:${orderId}`,
    kind: "stock.short_delivery",
    title: `Short delivery: ${o.number}`,
    tag: `wh-short-${orderId}`,
    text: `📦 ${o.number} from ${o.supplier} came short: ${short.map(shortWords).join("; ")}.`,
    reason: "you approve the warehouse's stock",
    correlationId,
  });
}

/** Stock left the books to a supplier: the approvers hear it, as they would a write-off. */
async function noticeReturn(orderId: string, correlationId: string): Promise<number> {
  const [o] = await getServiceSql()<{ number: string; supplier: string; reason: string; done_by: string | null; lines: string }[]>`
    select o.number, s.name as supplier, o.reason, o.done_by,
           string_agg((l.done_qty::float8)::text || ' ' || i.unit || ' ' || i.name, ', ' order by i.sort_order) filter (where l.done_qty > 0) as lines
      from wh_order o join supplier s on s.id = o.supplier_id
      join wh_order_line l on l.order_id = o.id join inv_item i on i.id = l.item_id
     where o.id = ${orderId}
     group by o.number, s.name, o.reason, o.done_by`;
  if (!o) return 0;
  return tell({
    to: await approvers([o.done_by]),
    key: `wh.return:${orderId}`,
    kind: "stock.returned",
    title: `Returned to ${o.supplier}: ${o.number}`,
    tag: `wh-return-${orderId}`,
    text: `↩️ ${o.number}: ${o.lines} back to ${o.supplier} (${o.reason.replace(/_/g, " ")}).`,
    reason: "you approve the warehouse's stock",
    correlationId,
  });
}

// ── reading ──────────────────────────────────────────────────────────────────
export interface OrderLine {
  itemId: string;
  name: string;
  unit: string;
  step: number;
  icon: string | null;
  expected: number;
  done: number | null;
  /** The note's kilograms, for everything expected. */
  expectedKg: number | null;
  /** Done: the note's kilograms for what came (noteGramsFor) — what the scale is held to. */
  expectedKgForDone: number | null;
  doneKg: number | null;
  variety: string | null;
  bestBefore: string | null;
  note: string | null;
  lot: string | null;
  /** A received delivery: what may still go back (received, less every return of it). */
  returnable: number | null;
  /** A return not done yet: what the warehouse holds now — null while this viewer counts it (D236). */
  available: number | null;
}

export interface OrderCard {
  id: string;
  kind: OrderKind;
  number: string;
  state: OrderState;
  supplier: { id: string; name: string; code: string | null };
  scheduledOn: string | null;
  priority: "normal" | "urgent";
  sourceRef: string | null;
  vehicle: string | null;
  reason: ReturnReason | null;
  note: string | null;
  createdBy: { id: string; name: string };
  createdAt: string;
  readyAt: string | null;
  doneBy: { id: string; name: string } | null;
  doneAt: string | null;
  cancelledAt: string | null;
  cancelNote: string | null;
  closedShort: boolean;
  stockDocId: string | null;
  /** posted, or reversed by an approver since. */
  stockDocState: string | null;
  backorderOf: { id: string; number: string } | null;
  returnOf: { id: string; number: string } | null;
  backorders: { id: string; number: string; state: OrderState }[];
  returns: { id: string; number: string; state: OrderState }[];
  lines: OrderLine[];
  totals: { lines: number; expectedKg: number | null; doneKg: number | null };
  /** A delivery in, done with less than expected (in units), or a line lighter than its note's weight for what came (isLight). */
  short: boolean;
  /** Not done and its day has passed. */
  overdue: boolean;
  may: { edit: boolean; ready: boolean; draft: boolean; validate: boolean; cancel: boolean; return: boolean };
}

export interface OrdersQuery {
  kind?: OrderKind;
  /** "open" = draft or ready. */
  state?: OrderState | "open";
  supplierId?: string;
  /** Made, scheduled or done on or after this Dubai day … */
  from?: string;
  /** … and on or before this one. */
  to?: string;
  /** A number, a supplier, a paper reference or a plate. */
  search?: string;
  limit?: number;
  /** The last card's createdAt|id from the page before. */
  cursor?: string | null;
}

export async function listOrders(viewer: ViewerOrg, q: OrdersQuery = {}, now: Date = new Date()): Promise<{ orders: OrderCard[]; more: boolean; cursor: string | null }> {
  requireRead(viewer);
  const limit = Math.min(Math.max(Math.trunc(q.limit ?? 30), 1), 100);
  if (q.from && !dayOk(q.from)) throw new InventoryRefused("A day is YYYY-MM-DD.", 400, "bad_day");
  if (q.to && !dayOk(q.to)) throw new InventoryRefused("A day is YYYY-MM-DD.", 400, "bad_day");
  if (q.supplierId && !UUID_RE.test(q.supplierId)) throw new InventoryRefused("No such supplier.", 404, "no_supplier");
  let cAt: Date | null = null;
  let cId: string | null = null;
  if (q.cursor) {
    const [at, cid] = q.cursor.split("|");
    if (!at || !cid || !UUID_RE.test(cid) || Number.isNaN(Date.parse(at))) throw new InventoryRefused("That page marker is not valid.", 400, "bad_cursor");
    cAt = new Date(at);
    cId = cid;
  }
  const search = q.search?.trim() ? `%${q.search.trim().replace(/[%_\\]/g, (m) => `\\${m}`)}%` : null;
  const from = q.from ? new Date(`${q.from}T00:00:00+04:00`) : null;
  const to = q.to ? new Date(new Date(`${q.to}T00:00:00+04:00`).getTime() + 86_400_000) : null;
  const ids = await withContext(
    viewer,
    async (tx) =>
      tx<{ id: string; created_at: Date }[]>`
        select o.id, o.created_at from wh_order o join supplier s on s.id = o.supplier_id
         where (${q.kind ?? null}::text is null or o.kind = ${q.kind ?? null})
           and (${q.state ?? null}::text is null or (${q.state ?? null} = 'open' and o.state in ('draft', 'ready')) or o.state = ${q.state ?? null})
           and (${q.supplierId ?? null}::uuid is null or o.supplier_id = ${q.supplierId ?? null})
           and (${from}::timestamptz is null or o.created_at >= ${from} or o.done_at >= ${from} or o.scheduled_on >= ${q.from ?? null}::date)
           and (${to}::timestamptz is null or o.created_at < ${to} or o.done_at < ${to} or o.scheduled_on <= ${q.to ?? null}::date)
           and (${search}::text is null or o.number ilike ${search} or s.name ilike ${search} or coalesce(o.source_ref, '') ilike ${search}
                or coalesce(o.vehicle, '') ilike ${search})
           and (${cAt}::timestamptz is null or (o.created_at, o.id) < (${cAt}, ${cId}::uuid))
         order by o.created_at desc, o.id desc
         limit ${limit + 1}`,
    { readOnly: true },
  );
  const page = ids.slice(0, limit);
  const cards = await cardsOf(viewer, page.map((r) => r.id), now);
  const last = page[page.length - 1];
  return { orders: cards, more: ids.length > limit, cursor: ids.length > limit && last ? `${last.created_at.toISOString()}|${last.id}` : null };
}

export async function orderDetail(viewer: ViewerOrg, id: string, now: Date = new Date()): Promise<OrderCard | null> {
  requireRead(viewer);
  if (!UUID_RE.test(id)) return null;
  return (await cardsOf(viewer, [id], now))[0] ?? null;
}

async function cardsOf(viewer: ViewerOrg, ids: readonly string[], now: Date): Promise<OrderCard[]> {
  if (ids.length === 0) return [];
  const move = viewer.status === "active" && can(viewer, "inventory.move");
  const hidden = (await figuresHiddenFrom())(viewer.employeeId, move);
  const today = localDate(now);
  return withContext(
    viewer,
    async (tx) => {
      const rows = await tx<{
        id: string;
        kind: OrderKind;
        number: string;
        state: OrderState;
        supplier_id: string;
        supplier_name: string;
        supplier_code: string | null;
        scheduled_on: string | null;
        priority: "normal" | "urgent";
        source_ref: string | null;
        vehicle: string | null;
        reason: ReturnReason | null;
        note: string | null;
        created_by: string;
        created_at: Date;
        ready_at: Date | null;
        done_by: string | null;
        done_at: Date | null;
        cancelled_at: Date | null;
        cancel_note: string | null;
        closed_short: boolean;
        stock_doc_id: string | null;
        doc_state: string | null;
        backorder_of: string | null;
        backorder_of_number: string | null;
        return_of: string | null;
        return_of_number: string | null;
      }[]>`
        select o.id, o.kind, o.number, o.state, o.supplier_id, s.name as supplier_name, s.code as supplier_code, o.scheduled_on::text as scheduled_on,
               o.priority, o.source_ref, o.vehicle, o.reason, o.note, o.created_by, o.created_at, o.ready_at, o.done_by, o.done_at, o.cancelled_at,
               o.cancel_note, o.closed_short, o.stock_doc_id, d.state as doc_state, o.backorder_of, b.number as backorder_of_number,
               o.return_of, r.number as return_of_number
          from wh_order o
          join supplier s on s.id = o.supplier_id
          left join stock_doc d on d.id = o.stock_doc_id
          left join wh_order b on b.id = o.backorder_of
          left join wh_order r on r.id = o.return_of
         where o.id = any(${ids}::uuid[])`;
      const lines = await tx<{
        order_id: string;
        item_id: string;
        name: string;
        unit: string;
        step: string;
        icon: string | null;
        expected_qty: string;
        done_qty: string | null;
        expected_g: string | null;
        done_g: string | null;
        variety: string | null;
        best_before: string | null;
        note: string | null;
        lot: string | null;
        stock: string | null;
      }[]>`
        select l.order_id, l.item_id, i.name, i.unit, i.step::text as step, i.icon, l.expected_qty::text as expected_qty, l.done_qty::text as done_qty,
               l.expected_g::text as expected_g, l.done_g::text as done_g, l.variety, l.best_before::text as best_before, l.note, lot.code as lot,
               b.qty::text as stock
          from wh_order_line l
          join inv_item i on i.id = l.item_id
          left join inv_lot lot on lot.order_id = l.order_id and lot.item_id = l.item_id
          left join stock_balance b on b.location_id = ${PLACE.warehouse} and b.item_id = l.item_id
         where l.order_id = any(${ids}::uuid[])
         order by i.sort_order, lower(i.name)`;
      const kids = await tx<{ id: string; number: string; state: OrderState; backorder_of: string | null; return_of: string | null }[]>`
        select id, number, state, backorder_of, return_of from wh_order where backorder_of = any(${ids}::uuid[]) or return_of = any(${ids}::uuid[])
         order by created_at`;
      // What may still go back from each received delivery shown: received, less every other return of it.
      const backFrom = new Map<string, Map<string, number>>();
      for (const r of rows.filter((x) => x.kind === "receipt" && x.state === "done")) backFrom.set(r.id, await returnable(tx, r.id, null));
      const names = await namesOf(rows.flatMap((r) => [r.created_by, r.done_by]));
      const byId = new Map(
        rows.map((r) => {
          const own = lines.filter((l) => l.order_id === r.id);
          const back = backFrom.get(r.id);
          const ls: OrderLine[] = own.map((l) => ({
            itemId: l.item_id,
            name: l.name,
            unit: l.unit,
            step: Number(l.step),
            icon: l.icon,
            expected: toMilli(l.expected_qty) / 1000,
            done: l.done_qty === null ? null : toMilli(l.done_qty) / 1000,
            expectedKg: l.expected_g === null ? null : Number(l.expected_g) / 1000,
            expectedKgForDone:
              l.expected_g === null || l.done_qty === null ? null : noteGramsFor(toMilli(l.expected_qty), toMilli(l.done_qty), Number(l.expected_g)) / 1000,
            doneKg: l.done_g === null ? null : Number(l.done_g) / 1000,
            variety: l.variety,
            bestBefore: l.best_before,
            note: l.note,
            lot: l.lot,
            returnable: back ? Math.max(back.get(l.item_id) ?? 0, 0) / 1000 : null,
            available: r.kind === "supplier_return" && (r.state === "draft" || r.state === "ready") && !hidden ? toMilli(l.stock ?? "0") / 1000 : null,
          }));
          const kg = (f: (l: OrderLine) => number | null) => (ls.some((l) => f(l) !== null) ? Math.round(ls.reduce((t, l) => t + (f(l) ?? 0) * 1000, 0)) / 1000 : null);
          // A delivery in that came short; a return that went back with less than planned is not "short" — its lines say so.
          const short =
            r.kind === "receipt" &&
            r.state === "done" &&
            own.some(
              (l) =>
                toMilli(l.done_qty ?? "0") < toMilli(l.expected_qty) ||
                isLight(toMilli(l.expected_qty), toMilli(l.done_qty ?? "0"), l.expected_g === null ? null : Number(l.expected_g), l.done_g === null ? null : Number(l.done_g)),
            );
          const open = r.state === "draft" || r.state === "ready";
          const card: OrderCard = {
            id: r.id,
            kind: r.kind,
            number: r.number,
            state: r.state,
            supplier: { id: r.supplier_id, name: r.supplier_name, code: r.supplier_code },
            scheduledOn: r.scheduled_on,
            priority: r.priority,
            sourceRef: r.source_ref,
            vehicle: r.vehicle,
            reason: r.reason,
            note: r.note,
            createdBy: { id: r.created_by, name: names.get(r.created_by) ?? "—" },
            createdAt: r.created_at.toISOString(),
            readyAt: r.ready_at?.toISOString() ?? null,
            doneBy: r.done_by ? { id: r.done_by, name: names.get(r.done_by) ?? "—" } : null,
            doneAt: r.done_at?.toISOString() ?? null,
            cancelledAt: r.cancelled_at?.toISOString() ?? null,
            cancelNote: r.cancel_note,
            closedShort: r.closed_short,
            stockDocId: r.stock_doc_id,
            stockDocState: r.doc_state,
            backorderOf: r.backorder_of ? { id: r.backorder_of, number: r.backorder_of_number ?? "" } : null,
            returnOf: r.return_of ? { id: r.return_of, number: r.return_of_number ?? "" } : null,
            backorders: kids.filter((k) => k.backorder_of === r.id).map((k) => ({ id: k.id, number: k.number, state: k.state })),
            returns: kids.filter((k) => k.return_of === r.id).map((k) => ({ id: k.id, number: k.number, state: k.state })),
            lines: ls,
            totals: { lines: ls.length, expectedKg: kg((l) => l.expectedKg), doneKg: kg((l) => l.doneKg) },
            short,
            overdue: open && r.scheduled_on !== null && r.scheduled_on < today,
            may: {
              edit: move && open,
              ready: move && r.state === "draft",
              draft: move && r.state === "ready",
              validate: move && open,
              cancel: move && open,
              return: move && r.kind === "receipt" && r.state === "done" && r.doc_state === "posted" && ls.some((l) => (l.returnable ?? 0) > 0),
            },
          };
          return [r.id, card] as const;
        }),
      );
      return ids.map((i) => byId.get(i)).filter((c): c is OrderCard => c !== undefined);
    },
    { readOnly: true },
  );
}

/**
 * Names of the people these rows mention — never a list of everyone (an erased person's name is gone here too). Read on the
 * service role, as the stock pages do (inventory-read.ts): seeing a document is the permission to see who made it.
 */
async function namesOf(ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((x): x is string => typeof x === "string"))];
  if (want.length === 0) return new Map();
  const rows = await getServiceSql()<{ id: string; display_name: string }[]>`select id, display_name from employee where id = any(${want}::uuid[])`;
  return new Map(rows.map((r) => [r.id, r.display_name]));
}
