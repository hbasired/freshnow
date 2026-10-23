import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CASH_REVERSE_REASONS,
  InventoryRefused,
  answerQuery,
  auditShift,
  cashHome,
  cashMachines,
  cashShift,
  cashShifts,
  endShift,
  recordCollection,
  recordDeposit,
  recordExpense,
  recordTestVend,
  reverseCash,
  startShift,
} from "@freshnow/core";
import { resolveViewer } from "../viewer.js";

/**
 * The Cash portal's API (TASK-061). Under /dashboard/*, so the sign-in hook guards every route (D71).
 * Who may do what is decided in core (the cash.* capabilities) and again by row-level security on every
 * read; these routes only check the shape of what arrives. Every entry carries an id the app made, so
 * sending it twice posts it once. Amounts are whole fils.
 */

const Uuid = z.string().uuid();
const Fils = z.number().int().min(0).max(100_000_000);
const Note = z.string().max(500).nullish();
const At = z.string().datetime({ offset: true }).nullish();
const Photos = z.array(Uuid).max(4).optional();
const Machine = z.number().int().min(1).max(99_999);
const IdParam = z.object({ id: Uuid });

const ShiftStart = z.object({ id: Uuid, vehicle: z.string().max(40).nullish() });
const ShiftEnd = z.object({ shiftId: Uuid.optional() });
const Collection = z.object({ id: Uuid, machineAssetNo: Machine, amountFils: Fils, note: Note, deviceAt: At, mediaIds: Photos });
const TestVend = z.object({ id: Uuid, machineAssetNo: Machine, amountFils: Fils, note: Note, deviceAt: At });
const Expense = z.object({
  id: Uuid,
  expenseKind: z.enum(["fuel", "other"]),
  amountFils: Fils,
  litres: z.number().positive().max(999.99).nullish(),
  receiptAt: At,
  note: Note,
  deviceAt: At,
  mediaIds: Photos,
});
const Deposit = z.object({
  id: Uuid,
  amountFils: Fils,
  cdmTxnNo: z.string().max(40).nullish(),
  cdmOperator: z.string().max(60).nullish(),
  cdsId: z.string().max(40).nullish(),
  bagNo: z.string().max(40).nullish(),
  denominations: z.record(z.string().regex(/^(1000|500|200|100|50|20|10|5)$/), z.number().int().min(0).max(100_000)).nullish(),
  receiptAt: At,
  note: Note,
  deviceAt: At,
  mediaIds: Photos,
});
const Reverse = z.object({ id: Uuid, reason: z.enum(CASH_REVERSE_REASONS), note: Note });
const Audit = z.object({ outcome: z.enum(["ok", "query"]), note: Note });
const AnswerIn = z.object({ note: z.string().min(1).max(500), questionAt: z.string().datetime({ offset: true }).nullish() });
const ShiftsQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  employeeId: Uuid.optional(),
});

/** One refusal shape, as the Stock portal's: the status and the words core chose (CashRefused is one). */
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

export function registerCashRoutes(app: FastifyInstance): void {
  const opts = (req: FastifyRequest) => ({ correlationId: req.correlationId });

  // ── reads ──────────────────────────────────────────────────────────────────
  app.get("/dashboard/cash/home", async (req, reply) => {
    const viewer = await resolveViewer(req);
    return answer(req, reply, () => cashHome(viewer));
  });
  app.get("/dashboard/cash/machines", async (req, reply) => {
    const viewer = await resolveViewer(req);
    return answer(req, reply, () => cashMachines(viewer));
  });
  app.get("/dashboard/cash/shifts", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const q = ShiftsQuery.parse(req.query);
    return answer(req, reply, () => cashShifts(viewer, defined(q)));
  });
  app.get("/dashboard/cash/shifts/:id", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { id } = IdParam.parse(req.params);
    const r = await answer(req, reply, () => cashShift(viewer, id));
    if (r === null) return reply.code(404).send({ error: { code: "not_found", message: "No such shift.", correlationId: req.correlationId } });
    return r;
  });

  // ── a shift ────────────────────────────────────────────────────────────────
  app.post("/dashboard/cash/shifts", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const body = ShiftStart.parse(req.body);
    return answer(req, reply, () => startShift(viewer, defined(body), opts(req)));
  });
  app.post("/dashboard/cash/shifts/end", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const body = ShiftEnd.parse(req.body ?? {});
    return answer(req, reply, () => endShift(viewer, defined(body), opts(req)));
  });
  app.post("/dashboard/cash/shifts/:id/audit", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { id } = IdParam.parse(req.params);
    const body = Audit.parse(req.body);
    return answer(req, reply, () => auditShift(viewer, id, defined(body), opts(req)));
  });
  app.post("/dashboard/cash/shifts/:id/answer", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { id } = IdParam.parse(req.params);
    const body = AnswerIn.parse(req.body);
    return answer(req, reply, () => answerQuery(viewer, id, body, opts(req)));
  });

  // ── entries ────────────────────────────────────────────────────────────────
  app.post("/dashboard/cash/collections", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const body = Collection.parse(req.body);
    return answer(req, reply, () => recordCollection(viewer, defined(body), opts(req)));
  });
  app.post("/dashboard/cash/test-vends", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const body = TestVend.parse(req.body);
    return answer(req, reply, () => recordTestVend(viewer, defined(body), opts(req)));
  });
  app.post("/dashboard/cash/expenses", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const body = Expense.parse(req.body);
    return answer(req, reply, () => recordExpense(viewer, defined(body), opts(req)));
  });
  app.post("/dashboard/cash/deposits", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const body = Deposit.parse(req.body);
    return answer(req, reply, () => recordDeposit(viewer, defined(body), opts(req)));
  });
  app.post("/dashboard/cash/entries/:id/reverse", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { id } = IdParam.parse(req.params);
    const body = Reverse.parse(req.body);
    return answer(req, reply, () => reverseCash(viewer, id, defined(body), opts(req)));
  });
}
