import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  InventoryRefused,
  RETURN_REASONS,
  cancelOrder,
  createOrder,
  itemTracking,
  listOrders,
  listReorderRules,
  listSuppliers,
  moveReport,
  moveReportCsv,
  orderDetail,
  reorderSuggestions,
  saveReorderRule,
  saveSupplier,
  setOrderReady,
  startReturn,
  stockAt,
  supplierReport,
  updateOrder,
  validateOrder,
} from "@freshnow/core";
import { resolveViewer } from "../viewer.js";

/**
 * The warehouse documents' API (TASK-086): suppliers, planned receipts and returns, reorder rules and their suggestions, and the
 * reports. Under /dashboard/*, so the sign-in hook guards every route (D71); who may do what is decided in core (inventory.read /
 * inventory.move) and again by row-level security on every read. These routes only check the shape of what arrives. Every write
 * that creates something carries an id the app made, so sending it twice creates it once.
 */

const Uuid = z.string().uuid();
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Qty = z.union([z.number().finite().nonnegative(), z.string().regex(/^\d{1,11}(\.\d{1,3})?$/)]);
const Kg = z.union([z.number().finite().nonnegative(), z.string().regex(/^\d{1,6}(\.\d{1,3})?$/)]);
const IdParam = z.object({ id: Uuid });
const Note = z.string().max(500).nullish();

const Supplier = z.object({
  name: z.string().min(1).max(80),
  code: z.string().max(12).nullish(),
  leadDays: z.number().int().min(0).max(60).nullish(),
  note: z.string().max(300).nullish(),
  active: z.boolean().optional(),
});
const Line = z.object({
  itemId: Uuid,
  qty: Qty,
  kg: Kg.nullish(),
  variety: z.string().max(40).nullish(),
  bestBefore: Day.nullish(),
  note: z.string().max(200).nullish(),
});
const Lines = z.array(Line).min(1).max(60);
const Header = {
  scheduledOn: Day.nullish(),
  priority: z.enum(["normal", "urgent"]).optional(),
  sourceRef: z.string().max(40).nullish(),
  vehicle: z.string().max(20).nullish(),
  note: Note,
  reason: z.enum(RETURN_REASONS).nullish(),
};
const Create = z.object({
  id: Uuid,
  kind: z.enum(["receipt", "supplier_return"]),
  supplierId: Uuid,
  ...Header,
  returnOf: Uuid.nullish(),
  lines: Lines,
  ready: z.boolean().optional(),
});
const Update = z.object({ ...Header, lines: Lines.optional() });
const Validate = z.object({
  stockDocId: Uuid,
  lines: z.array(z.object({ itemId: Uuid, qty: Qty, kg: Kg.nullish() })).max(60),
  backorder: z.boolean().optional(),
  backorderId: Uuid.nullish(),
  deviceAt: z.string().datetime({ offset: true }).nullish(),
  mediaIds: z.array(Uuid).max(6).optional(),
});
const Return = z.object({ id: Uuid, reason: z.enum(RETURN_REASONS), note: Note, lines: Lines, ready: z.boolean().optional() });
const Cancel = z.object({ note: z.string().max(300).nullish() });
const Orders = z.object({
  kind: z.enum(["receipt", "supplier_return"]).optional(),
  state: z.enum(["draft", "ready", "done", "cancelled", "open"]).optional(),
  supplierId: Uuid.optional(),
  from: Day.optional(),
  to: Day.optional(),
  search: z.string().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().max(80).optional(),
});
const Rule = z.object({
  itemId: Uuid,
  place: z.union([z.object({ kind: z.literal("warehouse") }), z.object({ kind: z.literal("person"), employeeId: Uuid })]),
  min: Qty,
  max: Qty,
  multiple: Qty.nullish(),
  supplierId: Uuid.nullish(),
  active: z.boolean().optional(),
});
const Range = z.object({ from: Day, to: Day });
const Moves = z.object({
  from: Day,
  to: Day,
  itemId: Uuid.optional(),
  employeeId: Uuid.optional(),
  kind: z.enum(["receipt", "handover", "use", "damage", "count_adjustment", "reversal", "supplier_return"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  cursor: z.coerce.number().int().positive().optional(),
});
const StockAtQuery = z.object({ date: Day.optional() });

async function answer<T>(req: FastifyRequest, reply: FastifyReply, run: () => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof InventoryRefused) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, correlationId: req.correlationId } });
    }
    throw err;
  }
}

/** Optional fields left out rather than sent as undefined (exactOptionalPropertyTypes in core's types). */
const defined = <T extends Record<string, unknown>>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export function registerWarehouseRoutes(app: FastifyInstance): void {
  const opts = (req: FastifyRequest) => ({ correlationId: req.correlationId });

  // ── suppliers ──────────────────────────────────────────────────────────────
  app.get("/dashboard/warehouse/suppliers", async (req, reply) => {
    const viewer = await resolveViewer(req);
    return answer(req, reply, () => listSuppliers(viewer));
  });
  app.post("/dashboard/warehouse/suppliers", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const b = Supplier.parse(req.body);
    return answer(req, reply, () => saveSupplier(viewer, defined(b), opts(req)));
  });
  app.put("/dashboard/warehouse/suppliers/:id", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { id } = IdParam.parse(req.params);
    const b = Supplier.parse(req.body);
    return answer(req, reply, () => saveSupplier(viewer, { ...defined(b), id }, opts(req)));
  });
  app.get("/dashboard/warehouse/suppliers/report", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const q = Range.parse(req.query);
    return answer(req, reply, () => supplierReport(viewer, q));
  });

  // ── documents ──────────────────────────────────────────────────────────────
  app.get("/dashboard/warehouse/orders", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const q = Orders.parse(req.query);
    return answer(req, reply, () => listOrders(viewer, defined(q)));
  });
  app.get("/dashboard/warehouse/orders/:id", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { id } = IdParam.parse(req.params);
    const r = await answer(req, reply, () => orderDetail(viewer, id));
    if (r === null) return reply.code(404).send({ error: { code: "not_found", message: "No such document.", correlationId: req.correlationId } });
    return r;
  });
  app.post("/dashboard/warehouse/orders", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const b = Create.parse(req.body);
    return answer(req, reply, () => createOrder(viewer, defined(b) as Parameters<typeof createOrder>[1], opts(req)));
  });
  app.put("/dashboard/warehouse/orders/:id", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { id } = IdParam.parse(req.params);
    const b = Update.parse(req.body);
    return answer(req, reply, () => updateOrder(viewer, id, defined(b) as Parameters<typeof updateOrder>[2], opts(req)));
  });
  app.post("/dashboard/warehouse/orders/:id/ready", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { id } = IdParam.parse(req.params);
    return answer(req, reply, () => setOrderReady(viewer, id, true, opts(req)));
  });
  app.post("/dashboard/warehouse/orders/:id/draft", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { id } = IdParam.parse(req.params);
    return answer(req, reply, () => setOrderReady(viewer, id, false, opts(req)));
  });
  app.post("/dashboard/warehouse/orders/:id/cancel", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { id } = IdParam.parse(req.params);
    const b = Cancel.parse(req.body ?? {});
    return answer(req, reply, () => cancelOrder(viewer, id, defined(b), opts(req)));
  });
  app.post("/dashboard/warehouse/orders/:id/validate", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { id } = IdParam.parse(req.params);
    const b = Validate.parse(req.body);
    return answer(req, reply, () => validateOrder(viewer, id, defined(b) as Parameters<typeof validateOrder>[2], opts(req)));
  });
  app.post("/dashboard/warehouse/orders/:id/return", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { id } = IdParam.parse(req.params);
    const b = Return.parse(req.body);
    return answer(req, reply, () => startReturn(viewer, id, defined(b) as Parameters<typeof startReturn>[2], opts(req)));
  });

  // ── what to keep in stock ──────────────────────────────────────────────────
  app.get("/dashboard/warehouse/rules", async (req, reply) => {
    const viewer = await resolveViewer(req);
    return answer(req, reply, () => listReorderRules(viewer));
  });
  app.post("/dashboard/warehouse/rules", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const b = Rule.parse(req.body);
    return answer(req, reply, () => saveReorderRule(viewer, defined(b) as Parameters<typeof saveReorderRule>[1], opts(req)));
  });
  app.put("/dashboard/warehouse/rules/:id", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { id } = IdParam.parse(req.params);
    const b = Rule.parse(req.body);
    return answer(req, reply, () => saveReorderRule(viewer, { ...(defined(b) as Parameters<typeof saveReorderRule>[1]), id }, opts(req)));
  });
  app.get("/dashboard/warehouse/suggestions", async (req, reply) => {
    const viewer = await resolveViewer(req);
    return answer(req, reply, () => reorderSuggestions(viewer));
  });

  // ── reports ────────────────────────────────────────────────────────────────
  app.get("/dashboard/warehouse/stock-at", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { date } = StockAtQuery.parse(req.query);
    return answer(req, reply, () => stockAt(viewer, date ?? null));
  });
  app.get("/dashboard/warehouse/moves", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const q = Moves.parse(req.query);
    return answer(req, reply, () => moveReport(viewer, defined(q)));
  });
  app.get("/dashboard/warehouse/moves.csv", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { limit: _l, cursor: _c, ...q } = Moves.parse(req.query);
    const r = await answer(req, reply, () => moveReportCsv(viewer, defined(q)));
    if (!r || typeof r !== "object" || !("csv" in r)) return r;
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="freshnow-moves-${q.from}-to-${q.to}.csv"`)
      .header("cache-control", "no-store")
      .send(r.csv);
  });
  app.get("/dashboard/warehouse/items/:id/tracking", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { id } = IdParam.parse(req.params);
    const q = Range.parse(req.query);
    const r = await answer(req, reply, () => itemTracking(viewer, id, q));
    if (r === null) return reply.code(404).send({ error: { code: "not_found", message: "No such item.", correlationId: req.correlationId } });
    return r;
  });
}
