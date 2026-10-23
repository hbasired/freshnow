import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  EVIDENCE_KINDS,
  InventoryRefused,
  SHIFT_WINDOWS,
  STOP_TASKS,
  addEvidence,
  can,
  cancelPlan,
  copyPlans,
  endVisit,
  evidenceGrid,
  machineByToken,
  myRound,
  openVisitOf,
  planById,
  plansOn,
  recordVisitCash,
  recordVisitFill,
  removeEvidence,
  routeMachines,
  routePeople,
  savePlan,
  setMachineServiceRule,
  setTasksDone,
  startVisit,
  visitDetail,
} from "@freshnow/core";
import { resolveViewer } from "../viewer.js";

/**
 * The Route portal's API (TASK-061 part 2). Under /dashboard/*, so the sign-in hook guards every route (D71).
 * Who may do what is decided in core (routes.plan, visits.record) and again by row-level security on every read;
 * these routes only check the shape of what arrives. Every write that creates something carries an id the app
 * made, so sending it twice posts it once.
 */

const Uuid = z.string().uuid();
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Note = z.string().max(500).nullish();
const At = z.string().datetime({ offset: true }).nullish();
const Machine = z.number().int().min(1).max(99_999);
const Task = z.enum(STOP_TASKS);
const Evidence = z.enum(EVIDENCE_KINDS);
const IdParam = z.object({ id: Uuid });

const Stop = z.object({
  id: Uuid,
  machineAssetNo: Machine,
  tasks: z.array(Task).min(1).max(STOP_TASKS.length),
  crates: z.number().int().min(0).max(20).nullish(),
  instructions: z.string().max(300).nullish(),
  evidence: z.array(Evidence).max(EVIDENCE_KINDS.length),
});
const Plan = z.object({
  id: Uuid,
  businessDate: Day,
  shiftWindow: z.enum(SHIFT_WINDOWS),
  name: z.string().min(1).max(80),
  note: Note,
  memberIds: z.array(Uuid).min(1).max(6),
  stops: z.array(Stop).max(60),
});
const Copy = z.object({ fromDate: Day, toDate: Day });
const DateQuery = z.object({ date: Day });
const Rule = z.object({ shift: z.enum(SHIFT_WINDOWS).nullable(), note: z.string().max(300).nullish() });
const AssetParam = z.object({ assetNo: z.coerce.number().int().min(1).max(99_999) });
const Start = z.object({ id: Uuid, machineAssetNo: Machine.nullish(), qrToken: Uuid.nullish(), deviceAt: At }).refine((b) => Boolean(b.machineAssetNo) !== Boolean(b.qrToken), {
  message: "Name the machine by its number or its sticker — one of the two.",
});
const AddEvidence = z.object({ kind: Evidence, mediaId: Uuid });
const EvidenceParam = z.object({ id: Uuid, evidenceId: Uuid });
const Tasks = z.object({ tasks: z.array(Task).max(STOP_TASKS.length) });
const Qty = z.union([z.number().finite().nonnegative(), z.string().regex(/^\d{1,11}(\.\d{1,3})?$/)]);
const Fill = z.object({ id: Uuid, lines: z.array(z.object({ itemId: Uuid, qty: Qty })).min(1).max(20), mediaIds: z.array(Uuid).max(6).optional() });
const Cash = z.object({ id: Uuid, amountFils: z.number().int().min(0).max(100_000_000), mediaIds: z.array(Uuid).min(1).max(4), note: Note });
const End = z.object({ note: Note });
const TokenParam = z.object({ token: Uuid });

/** One refusal shape, as the other portals': the status and the words core chose. */
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

const notFound = (req: FastifyRequest, reply: FastifyReply, what: string) =>
  reply.code(404).send({ error: { code: "not_found", message: `No such ${what}.`, correlationId: req.correlationId } });

export function registerRouteRoutes(app: FastifyInstance): void {
  const opts = (req: FastifyRequest) => ({ correlationId: req.correlationId });

  // ── reads ──────────────────────────────────────────────────────────────────
  /** What the person does now: their round, their open visit, and what they may do. */
  app.get("/dashboard/route/home", async (req, reply) => {
    const viewer = await resolveViewer(req);
    return answer(req, reply, async () => {
      const visits = viewer.status === "active" && can(viewer, "visits.record");
      const plan = viewer.status === "active" && can(viewer, "routes.plan");
      return {
        can: { plan, visit: visits, cash: viewer.status === "active" && can(viewer, "cash.hold"), machines: viewer.status === "active" && can(viewer, "televend.read") },
        round: visits ? await myRound(viewer) : { plans: [], days: [] },
        openVisit: visits ? await openVisitOf(viewer) : null,
      };
    });
  });
  app.get("/dashboard/route/plans", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { date } = DateQuery.parse(req.query);
    return answer(req, reply, () => plansOn(viewer, date));
  });
  app.get("/dashboard/route/plans/:id", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { id } = IdParam.parse(req.params);
    const r = await answer(req, reply, () => planById(viewer, id));
    return r === null ? notFound(req, reply, "plan") : r;
  });
  app.get("/dashboard/route/people", async (req, reply) => {
    const viewer = await resolveViewer(req);
    return answer(req, reply, () => routePeople(viewer));
  });
  app.get("/dashboard/route/machines", async (req, reply) => {
    const viewer = await resolveViewer(req);
    return answer(req, reply, () => routeMachines(viewer));
  });
  app.get("/dashboard/route/grid", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { date } = DateQuery.parse(req.query);
    return answer(req, reply, () => evidenceGrid(viewer, date));
  });
  app.get("/dashboard/route/visits/:id", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { id } = IdParam.parse(req.params);
    const r = await answer(req, reply, () => visitDetail(viewer, id));
    return r === null ? notFound(req, reply, "visit") : r;
  });
  /** The machine a sticker names — the page the sticker's link opens shows it before the visit starts. */
  app.get("/dashboard/route/sticker/:token", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { token } = TokenParam.parse(req.params);
    const r = await answer(req, reply, () => machineByToken(viewer, token));
    return r === null ? notFound(req, reply, "machine for this sticker") : r;
  });

  // ── plans ──────────────────────────────────────────────────────────────────
  app.post("/dashboard/route/plans", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const body = Plan.parse(req.body);
    return answer(req, reply, () =>
      savePlan(viewer, { ...defined(body), stops: body.stops.map((s) => defined(s)) }, opts(req)),
    );
  });
  app.post("/dashboard/route/plans/:id/cancel", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { id } = IdParam.parse(req.params);
    return answer(req, reply, () => cancelPlan(viewer, id, opts(req)));
  });
  app.post("/dashboard/route/plans/copy", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const body = Copy.parse(req.body);
    return answer(req, reply, () => copyPlans(viewer, body, opts(req)));
  });
  app.put("/dashboard/route/machines/:assetNo/rule", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { assetNo } = AssetParam.parse(req.params);
    const body = Rule.parse(req.body);
    return answer(req, reply, () => setMachineServiceRule(viewer, assetNo, defined(body), opts(req)));
  });

  // ── visits ─────────────────────────────────────────────────────────────────
  app.post("/dashboard/route/visits", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const body = Start.parse(req.body);
    return answer(req, reply, () => startVisit(viewer, defined(body), opts(req)));
  });
  app.post("/dashboard/route/visits/:id/evidence", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { id } = IdParam.parse(req.params);
    const body = AddEvidence.parse(req.body);
    return answer(req, reply, () => addEvidence(viewer, id, body, opts(req)));
  });
  app.post("/dashboard/route/visits/:id/evidence/:evidenceId/remove", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { id, evidenceId } = EvidenceParam.parse(req.params);
    return answer(req, reply, () => removeEvidence(viewer, id, evidenceId, opts(req)));
  });
  app.post("/dashboard/route/visits/:id/tasks", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { id } = IdParam.parse(req.params);
    const body = Tasks.parse(req.body);
    return answer(req, reply, () => setTasksDone(viewer, id, body));
  });
  app.post("/dashboard/route/visits/:id/fill", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { id } = IdParam.parse(req.params);
    const body = Fill.parse(req.body);
    return answer(req, reply, () => recordVisitFill(viewer, id, defined(body), opts(req)));
  });
  app.post("/dashboard/route/visits/:id/cash", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { id } = IdParam.parse(req.params);
    const body = Cash.parse(req.body);
    return answer(req, reply, () => recordVisitCash(viewer, id, defined(body), opts(req)));
  });
  app.post("/dashboard/route/visits/:id/end", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { id } = IdParam.parse(req.params);
    const body = End.parse(req.body ?? {});
    return answer(req, reply, () => endVisit(viewer, id, defined(body), opts(req)));
  });
}
