import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  COUNT_DECISION_REASONS,
  COUNT_KINDS,
  DAMAGE_REASONS,
  ITEM_CATEGORIES,
  InventoryRefused,
  REFUSE_REASONS,
  REVERSE_REASONS,
  USE_REASONS,
  WRITE_OFF_REASONS,
  answerHandover,
  cancelCount,
  cancelHandover,
  companyToday,
  decideCount,
  inventoryCatalogue,
  inventoryCount,
  inventoryCounts,
  inventoryDay,
  inventoryDoc,
  inventoryHolders,
  inventoryHome,
  inventoryMovements,
  receiveDelivery,
  recordUse,
  reverseDocument,
  saveItem,
  settleHandover,
  startCount,
  startHandover,
  startRecount,
  submitCount,
  submitRecount,
  waiveRecount,
} from "@freshnow/core";
import { resolveViewer } from "../viewer.js";

/**
 * The Inventory portal's API (TASK-060). Under /dashboard/*, so the sign-in hook guards every route
 * (D71). Who may do what is decided in core (the inventory.* capabilities) and again by row-level
 * security on every read; these routes only check the shape of what arrives. Every write carries an id
 * the app made, so sending it twice posts it once.
 */

const Uuid = z.string().uuid();
const Qty = z.union([z.number().finite().nonnegative(), z.string().regex(/^\d{1,11}(\.\d{1,3})?$/)]);
const Line = z.object({
  itemId: Uuid,
  qty: Qty,
  variety: z.string().max(40).nullish(),
  cartonKg: z.number().positive().max(99.99).nullish(),
});
const Lines = z.array(Line).min(1).max(60);
const Note = z.string().max(500).nullish();
const DeviceAt = z.string().datetime({ offset: true }).nullish();
const Photos = z.array(Uuid).max(6).optional();
const Side = z.union([z.object({ kind: z.literal("warehouse") }), z.object({ kind: z.literal("person"), employeeId: Uuid })]);
const IdParam = z.object({ id: Uuid });
const DayQuery = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

const Receipt = z.object({ id: Uuid, supplier: z.string().max(80).nullish(), invoiceNo: z.string().max(40).nullish(), note: Note, deviceAt: DeviceAt, lines: Lines, mediaIds: Photos });
const Handover = z.object({ id: Uuid, from: Side, to: Side, lines: Lines, note: Note, deviceAt: DeviceAt, mediaIds: Photos });
const Answer = z.object({
  answer: z.enum(["accept", "counted", "refuse"]),
  lines: z.array(z.object({ itemId: Uuid, qty: Qty })).max(60).optional(),
  reason: z.enum(REFUSE_REASONS).nullish(),
  note: Note,
});
const Settle = z.object({
  lines: z.array(z.object({ itemId: Uuid, outcome: z.enum(["back", "write_off"]), reason: z.enum(WRITE_OFF_REASONS).nullish() })).min(1).max(60),
  note: Note,
});
const Use = z.object({
  id: Uuid,
  kind: z.enum(["use", "damage"]),
  from: z.enum(["warehouse", "mine"]),
  reason: z.enum([...USE_REASONS, ...DAMAGE_REASONS] as [string, ...string[]]),
  machineAssetNo: z.number().int().min(1).max(99_999).nullish(),
  lines: Lines,
  note: Note,
  deviceAt: DeviceAt,
  mediaIds: Photos,
});
const Reverse = z.object({ id: Uuid, reason: z.enum(REVERSE_REASONS), note: Note });
const CountStart = z.object({ id: Uuid, kind: z.enum(COUNT_KINDS) });
const Counted = z.object({ lines: z.array(z.object({ itemId: Uuid, qty: Qty })).min(1).max(200) });
const Waive = z.object({ reason: z.string().min(3).max(300) });
const Decide = z.object({
  docId: Uuid,
  lines: z.array(z.object({ itemId: Uuid, decision: z.enum(["accept_count", "keep_ledger"]), reason: z.enum(COUNT_DECISION_REASONS).nullish() })).max(200),
  note: Note,
});
const Item = z.object({
  name: z.string().min(1).max(60),
  category: z.enum(ITEM_CATEGORIES),
  unit: z.string().min(1).max(20),
  step: Qty,
  minLevel: Qty.nullish(),
  countTolerance: Qty.optional(),
  icon: z.string().max(16).nullish(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  active: z.boolean().optional(),
});
const Moves = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  itemId: Uuid.optional(),
  personId: Uuid.optional(),
  kind: z.enum(["receipt", "handover", "use", "damage", "count_adjustment", "reversal"]).optional(),
  // The previous page's cursor: "<time to the microsecond>|<document id>" (a bare time still works).
  before: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})(\|[0-9a-f-]{36})?$/i).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/** One refusal shape for the whole portal: the status and the words core chose. */
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

export function registerInventoryRoutes(app: FastifyInstance): void {
  const opts = (req: FastifyRequest) => ({ correlationId: req.correlationId });

  // ── reads ──────────────────────────────────────────────────────────────────
  app.get("/dashboard/inventory/home", async (req, reply) => {
    const viewer = await resolveViewer(req);
    return answer(req, reply, () => inventoryHome(viewer));
  });
  app.get("/dashboard/inventory/holders", async (req, reply) => {
    const viewer = await resolveViewer(req);
    return answer(req, reply, () => inventoryHolders(viewer));
  });
  app.get("/dashboard/inventory/items", async (req, reply) => {
    const viewer = await resolveViewer(req);
    return answer(req, reply, () => inventoryCatalogue(viewer));
  });
  app.get("/dashboard/inventory/movements", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const q = Moves.parse(req.query);
    return answer(req, reply, () => inventoryMovements(viewer, defined(q)));
  });
  app.get("/dashboard/inventory/docs/:id", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { id } = IdParam.parse(req.params);
    const r = await answer(req, reply, () => inventoryDoc(viewer, id));
    if (r === null) return reply.code(404).send({ error: { code: "not_found", message: "No such stock document.", correlationId: req.correlationId } });
    return r;
  });
  app.get("/dashboard/inventory/day", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { date } = DayQuery.parse(req.query);
    return answer(req, reply, () => inventoryDay(viewer, date ?? companyToday()));
  });
  app.get("/dashboard/inventory/counts", async (req, reply) => {
    const viewer = await resolveViewer(req);
    return answer(req, reply, () => inventoryCounts(viewer));
  });
  app.get("/dashboard/inventory/counts/:id", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { id } = IdParam.parse(req.params);
    const r = await answer(req, reply, () => inventoryCount(viewer, id));
    if (r === null) return reply.code(404).send({ error: { code: "not_found", message: "No such count.", correlationId: req.correlationId } });
    return r;
  });

  // ── stock moving ───────────────────────────────────────────────────────────
  app.post("/dashboard/inventory/receipts", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const b = Receipt.parse(req.body);
    return answer(req, reply, () => receiveDelivery(viewer, defined(b), opts(req)));
  });
  app.post("/dashboard/inventory/handovers", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const b = Handover.parse(req.body);
    return answer(req, reply, () => startHandover(viewer, defined(b), opts(req)));
  });
  app.post("/dashboard/inventory/handovers/:id/answer", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { id } = IdParam.parse(req.params);
    const b = Answer.parse(req.body);
    return answer(req, reply, () => answerHandover(viewer, id, defined(b), opts(req)));
  });
  app.post("/dashboard/inventory/handovers/:id/cancel", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { id } = IdParam.parse(req.params);
    return answer(req, reply, () => cancelHandover(viewer, id, opts(req)));
  });
  app.post("/dashboard/inventory/handovers/:id/settle", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { id } = IdParam.parse(req.params);
    const b = Settle.parse(req.body);
    return answer(req, reply, () => settleHandover(viewer, id, defined(b), opts(req)));
  });
  app.post("/dashboard/inventory/uses", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const b = Use.parse(req.body);
    return answer(req, reply, () => recordUse(viewer, defined(b) as Parameters<typeof recordUse>[1], opts(req)));
  });
  app.post("/dashboard/inventory/docs/:id/reverse", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { id } = IdParam.parse(req.params);
    const b = Reverse.parse(req.body);
    return answer(req, reply, () => reverseDocument(viewer, id, defined(b), opts(req)));
  });

  // ── counts ─────────────────────────────────────────────────────────────────
  app.post("/dashboard/inventory/counts", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const b = CountStart.parse(req.body);
    return answer(req, reply, () => startCount(viewer, b, opts(req)));
  });
  app.post("/dashboard/inventory/counts/:id/submit", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { id } = IdParam.parse(req.params);
    const b = Counted.parse(req.body);
    return answer(req, reply, () => submitCount(viewer, id, b, opts(req)));
  });
  app.post("/dashboard/inventory/counts/:id/recount", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { id } = IdParam.parse(req.params);
    return answer(req, reply, () => startRecount(viewer, id, opts(req)));
  });
  app.post("/dashboard/inventory/counts/:id/recount/submit", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { id } = IdParam.parse(req.params);
    const b = Counted.parse(req.body);
    return answer(req, reply, () => submitRecount(viewer, id, b, opts(req)));
  });
  app.post("/dashboard/inventory/counts/:id/waive", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { id } = IdParam.parse(req.params);
    const b = Waive.parse(req.body);
    return answer(req, reply, () => waiveRecount(viewer, id, b, opts(req)));
  });
  app.post("/dashboard/inventory/counts/:id/decide", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { id } = IdParam.parse(req.params);
    const b = Decide.parse(req.body);
    return answer(req, reply, () => decideCount(viewer, id, defined(b), opts(req)));
  });
  app.post("/dashboard/inventory/counts/:id/cancel", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { id } = IdParam.parse(req.params);
    return answer(req, reply, () => cancelCount(viewer, id, opts(req)));
  });

  // ── the catalogue ──────────────────────────────────────────────────────────
  app.post("/dashboard/inventory/items", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const b = Item.parse(req.body);
    return answer(req, reply, () => saveItem(viewer, defined(b), opts(req)));
  });
  app.put("/dashboard/inventory/items/:id", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { id } = IdParam.parse(req.params);
    const b = Item.parse(req.body);
    return answer(req, reply, () => saveItem(viewer, { ...defined(b), id }, opts(req)));
  });
}
