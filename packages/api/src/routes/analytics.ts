import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AnalyticsRefused, categoryChoices, machineDaily, machinePerformance, setMachineCategory } from "@freshnow/core";
import { resolveViewer } from "../viewer.js";

/**
 * The Analytics portal's API (TASK-070). Under /dashboard/*, so the sign-in hook guards every route (D71). Who may
 * read (televend.read) and who may correct a category (machines.manage) is decided in core and again by row-level
 * security; these routes only check the shape of what arrives.
 */

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Range = z.object({ from: Day, to: Day });
/** A machine: FreshNow's id (a machine whose Televend record moved), or a Televend record id. */
const MachineParam = z.object({ machine: z.string().regex(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{1,15})$/i) });
const Category = z.object({ category: z.string().max(60).nullable(), note: z.string().max(300).nullish() });

async function answer<T>(req: FastifyRequest, reply: FastifyReply, run: () => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof AnalyticsRefused) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, correlationId: req.correlationId } });
    }
    throw err;
  }
}

export function registerAnalyticsRoutes(app: FastifyInstance): void {
  /** Machines against the fleet average, the categories, and what they say — for whole days. */
  app.get("/dashboard/analytics/performance", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const range = Range.parse(req.query);
    return answer(req, reply, () => machinePerformance(viewer, range));
  });
  /** One machine's cups each day, beside the same weekday a week before. */
  app.get("/dashboard/analytics/machines/:machine/daily", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { machine } = MachineParam.parse(req.params);
    const range = Range.parse(req.query);
    const r = await answer(req, reply, () => machineDaily(viewer, machine, range));
    return r === null ? reply.code(404).send({ error: { code: "not_found", message: "No such machine.", correlationId: req.correlationId } }) : r;
  });
  /** The categories a machine can be put in. */
  app.get("/dashboard/analytics/categories", async (req, reply) => {
    const viewer = await resolveViewer(req);
    return answer(req, reply, () => categoryChoices(viewer));
  });
  /** Correct a machine's category in FreshNow (null = back to Televend's region). Televend is never changed. */
  app.put("/dashboard/analytics/machines/:machine/category", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { machine } = MachineParam.parse(req.params);
    const body = Category.parse(req.body);
    return answer(req, reply, () =>
      setMachineCategory(viewer, machine, { category: body.category, ...(body.note ? { note: body.note } : {}) }, { correlationId: req.correlationId }),
    );
  });
}
