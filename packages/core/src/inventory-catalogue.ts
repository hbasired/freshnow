import { randomUUID } from "node:crypto";
import { getServiceSql, withContext } from "./db.js";
import { InventoryRefused, correlationOf, parseQty, fromMilli, requireCan, toMilli } from "./inventory-ledger.js";
import type { ViewerOrg } from "./org.js";
import { can } from "./permissions.js";

/**
 * The items the warehouse keeps (TASK-060): names, the one unit each is counted in, the smallest step,
 * the minimum below which the warehouse is low, and the tolerance within which a count skips the
 * recount. Whoever runs the warehouse keeps the list; the tolerance is the approvers' (it decides how
 * much a count may differ before a second person looks), and an item's unit and step are fixed once it
 * has moved — "10" must keep meaning what it meant.
 */

export const ITEM_CATEGORIES = ["oranges", "cups_packaging", "consumable", "cleaning", "spare_part", "vehicle", "device", "other"] as const;
export type ItemCategory = (typeof ITEM_CATEGORIES)[number];

export interface CatalogueItem {
  id: string;
  name: string;
  category: ItemCategory;
  unit: string;
  step: number;
  minLevel: number | null;
  countTolerance: number;
  icon: string | null;
  sortOrder: number;
  active: boolean;
  /** Its unit and step are fixed from its first move. */
  hasMoved: boolean;
}

export async function inventoryCatalogue(viewer: ViewerOrg): Promise<CatalogueItem[]> {
  if (viewer.status !== "active" || !(can(viewer, "inventory.read") || can(viewer, "inventory.hold"))) {
    throw new InventoryRefused("Stock is not part of your role.", 403, "not_allowed");
  }
  return withContext(
    viewer,
    async (tx) => {
      const rows = await tx<{
        id: string;
        name: string;
        category: ItemCategory;
        unit: string;
        step: string;
        min_level: string | null;
        count_tolerance: string;
        icon: string | null;
        sort_order: number;
        active: boolean;
        has_moved: boolean;
      }[]>`
        select i.id, i.name, i.category, i.unit, i.step::text as step, i.min_level::text as min_level,
               i.count_tolerance::text as count_tolerance, i.icon, i.sort_order, i.active,
               exists (select 1 from stock_doc_line l where l.item_id = i.id) as has_moved
          from inv_item i order by i.active desc, i.sort_order, lower(i.name)`;
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        category: r.category,
        unit: r.unit,
        step: Number(r.step),
        minLevel: r.min_level === null ? null : Number(r.min_level),
        countTolerance: Number(r.count_tolerance),
        icon: r.icon,
        sortOrder: r.sort_order,
        active: r.active,
        hasMoved: r.has_moved,
      }));
    },
    { readOnly: true },
  );
}

export interface ItemIn {
  /** Absent: a new item. */
  id?: string;
  name: string;
  category: ItemCategory;
  unit: string;
  step: number | string;
  minLevel?: number | string | null;
  countTolerance?: number | string;
  icon?: string | null;
  sortOrder?: number;
  active?: boolean;
}

export async function saveItem(viewer: ViewerOrg, req: ItemIn, opts: { correlationId?: string } = {}): Promise<{ id: string; created: boolean }> {
  requireCan(viewer, "inventory.move", "Only the warehouse keeps the list of items.");
  const name = req.name?.trim().replace(/\s+/g, " ") ?? "";
  const unit = req.unit?.trim().toLowerCase() ?? "";
  if (name.length < 1 || name.length > 60) throw new InventoryRefused("An item's name is 1–60 characters.", 400, "bad_name");
  if (unit.length < 1 || unit.length > 20) throw new InventoryRefused("A unit is 1–20 characters: carton, box, piece …", 400, "bad_unit");
  if (!(ITEM_CATEGORIES as readonly string[]).includes(req.category)) throw new InventoryRefused("Unknown category.", 400, "bad_category");
  const step = parseQty(req.step, "step");
  if (step > 1_000_000) throw new InventoryRefused("A step is at most 1,000.", 400, "bad_step");
  const minLevel = req.minLevel === undefined || req.minLevel === null || req.minLevel === "" ? null : parseQty(req.minLevel, "minimum", true);
  const tolerance = req.countTolerance === undefined ? null : parseQty(req.countTolerance, "count tolerance", true);
  const icon = req.icon?.trim() ? [...req.icon.trim()].slice(0, 4).join("") : null;
  const sortOrder = Number.isInteger(req.sortOrder) ? Math.min(Math.max(req.sortOrder!, 0), 10_000) : 100;
  const correlationId = correlationOf(opts.correlationId);

  return getServiceSql().begin(async (tx) => {
    const clash = await tx<{ id: string }[]>`select id from inv_item where lower(btrim(name)) = lower(${name}) and (${req.id ?? null}::uuid is null or id <> ${req.id ?? null})`;
    if (clash.length > 0) throw new InventoryRefused(`There is already an item called ${name}.`, 409, "name_taken");

    if (!req.id) {
      if (tolerance !== null && tolerance > 0 && !can(viewer, "inventory.approve")) {
        throw new InventoryRefused("The count tolerance is set by the Ops Head, the CEO or an Admin.", 403, "tolerance_is_approvers");
      }
      const id = randomUUID();
      const synthetic = (await tx<{ s: boolean }[]>`select is_synthetic as s from employee where id = ${viewer.employeeId}`)[0]?.s ?? false;
      await tx`
        insert into inv_item (id, name, category, unit, step, min_level, count_tolerance, icon, sort_order, active, created_by, is_synthetic)
        values (${id}, ${name}, ${req.category}, ${unit}, ${fromMilli(step)}::numeric, ${minLevel === null ? null : fromMilli(minLevel)}::numeric,
                ${fromMilli(tolerance ?? 0)}::numeric, ${icon}, ${sortOrder}, ${req.active ?? true}, ${viewer.employeeId}, ${synthetic})`;
      await tx`
        insert into audit_log (correlation_id, actor, action, entity, entity_id, detail)
        values (${correlationId}, ${`employee:${viewer.employeeId}`}, 'stock.item_created', 'inv_item', ${id},
                ${tx.json({ name, category: req.category, unit, step: fromMilli(step) } as never)})`;
      return { id, created: true };
    }

    // The ledger's lock on this item: no document or count can be checking its step while it changes.
    await tx`select pg_advisory_xact_lock(hashtextextended(${`inventory:${req.id}`}, 0))`;
    // Fixed once anything was recorded in it: a document line; a count still waiting for its decision
    // (it is posted in the unit it was counted in — TASK-060 review); or a count that found some of it.
    const [old] = await tx<{ name: string; unit: string; step: string; count_tolerance: string; min_level: string | null; active: boolean; moved: boolean }[]>`
      select name, unit, step::text as step, count_tolerance::text as count_tolerance, min_level::text as min_level, active,
             exists (select 1 from stock_doc_line l where l.item_id = i.id)
             or exists (select 1 from count_line c join count_session s on s.id = c.session_id
                         where c.item_id = i.id and s.state <> 'cancelled'
                           and (s.state in ('recount', 'approval') or c.counted_qty <> 0 or c.expected_qty <> 0 or coalesce(c.recount_qty, 0) <> 0)) as moved
        from inv_item i where id = ${req.id} for update`;
    if (!old) throw new InventoryRefused("No such item.", 404, "no_item");
    // A count open now was shown its unit when it began, and its figures are read in the unit at hand-in (review, 20 Oct).
    const [open] = await tx<{ n: number }[]>`select count(*)::int as n from count_session where state = 'counting'`;
    if (open!.n > 0 && (unit !== old.unit || step !== toMilli(old.step))) {
      throw new InventoryRefused(`The warehouse is being counted — change ${old.name}'s unit or step once the count is handed in.`, 409, "count_open");
    }
    if (old.moved && (unit !== old.unit || step !== toMilli(old.step))) {
      throw new InventoryRefused(`${old.name} has already been recorded (moved or counted), so its unit and step stay as they are — add a new item instead.`, 409, "unit_fixed");
    }
    const newTolerance = tolerance ?? toMilli(old.count_tolerance);
    if (newTolerance !== toMilli(old.count_tolerance) && !can(viewer, "inventory.approve")) {
      throw new InventoryRefused("The count tolerance is set by the Ops Head, the CEO or an Admin.", 403, "tolerance_is_approvers");
    }
    await tx`
      update inv_item set name = ${name}, category = ${req.category}, unit = ${unit}, step = ${fromMilli(step)}::numeric,
                          min_level = ${minLevel === null ? null : fromMilli(minLevel)}::numeric, count_tolerance = ${fromMilli(newTolerance)}::numeric,
                          icon = ${icon}, sort_order = ${sortOrder}, active = ${req.active ?? old.active}, updated_at = now()
       where id = ${req.id}`;
    await tx`
      insert into audit_log (correlation_id, actor, action, entity, entity_id, detail)
      values (${correlationId}, ${`employee:${viewer.employeeId}`}, 'stock.item_changed', 'inv_item', ${req.id},
              ${tx.json({
                before: { name: old.name, unit: old.unit, step: old.step, minLevel: old.min_level, tolerance: old.count_tolerance, active: old.active },
                after: { name, unit, step: fromMilli(step), minLevel: minLevel === null ? null : fromMilli(minLevel), tolerance: fromMilli(newTolerance), active: req.active ?? old.active },
              } as never)})`;
    return { id: req.id, created: false };
  });
}
