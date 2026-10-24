import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AnalyticsRefused, categoryChoices, compareSales, machineDaily, machinePerformance, salesProfile, setMachineCategory, type CompareRequest, type ProfileScope } from "@freshnow/core";
import { resolveViewer } from "../viewer.js";

/**
 * The Analytics portal's API (TASK-070). Under /dashboard/*, so the sign-in hook guards every route (D71). Who may
 * read (televend.read) and who may correct a category (machines.manage) is decided in core and again by row-level
 * security; these routes only check the shape of what arrives.
 */

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Range = z.object({ from: Day, to: Day });
/** A machine: FreshNow's id (a machine whose Televend record moved), or a Televend record id. */
const MachineId = z.string().regex(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{1,15})$/i);
const MachineParam = z.object({ machine: MachineId });
const CategoryName = z.string().min(1).max(60);
/**
 * The categories chosen (TASK-075), as a JSON array of names in one query value — a category's name is free text, so no
 * separator is safe. Absent = every category. Core tidies and checks them again.
 */
const CategoryList = z
  .string()
  .max(8_000)
  .transform((s, ctx) => {
    try {
      return JSON.parse(s) as unknown;
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "categories is a JSON array of names" });
      return z.NEVER;
    }
  })
  .pipe(z.array(z.string().max(60)).max(100));
const PerformanceQuery = Range.extend({ categories: CategoryList.optional() });
const ProfileQuery = z.discriminatedUnion("scope", [
  Range.extend({ scope: z.literal("selection"), categories: CategoryList.optional() }),
  Range.extend({ scope: z.literal("category"), category: CategoryName }),
  Range.extend({ scope: z.literal("machine"), machine: MachineId }),
]);
const CompareQuery = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("days"), a: Day, b: Day, categories: CategoryList.optional() }),
  z.object({ mode: z.literal("periods"), aFrom: Day, aTo: Day, bFrom: Day, bTo: Day, categories: CategoryList.optional() }),
  z.object({ mode: z.literal("machines"), from: Day, to: Day, a: MachineId, b: MachineId }),
  z.object({ mode: z.literal("categories"), from: Day, to: Day, a: CategoryName, b: CategoryName }),
]);
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
    const q = PerformanceQuery.parse(req.query);
    return answer(req, reply, () => machinePerformance(viewer, { from: q.from, to: q.to }, new Date(), { categories: q.categories ?? null }));
  });
  /**
   * One scope's days (each beside the same weekday a week before), hours, weekdays, payments, income and sentences
   * (TASK-075): the categories chosen, one category, or one machine.
   */
  app.get("/dashboard/analytics/profile", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const q = ProfileQuery.parse(req.query);
    const scope: ProfileScope =
      q.scope === "selection"
        ? { kind: "selection", categories: q.categories ?? null }
        : q.scope === "category"
          ? { kind: "category", category: q.category }
          : { kind: "machine", machine: q.machine };
    const r = await answer(req, reply, () => salesProfile(viewer, { from: q.from, to: q.to }, scope));
    return r === null ? reply.code(404).send({ error: { code: "not_found", message: "No such machine.", correlationId: req.correlationId } }) : r;
  });
  /** Two days, two periods, two machines or two categories side by side, with the differences worked out (TASK-075). */
  app.get("/dashboard/analytics/compare", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const q = CompareQuery.parse(req.query);
    const request: CompareRequest =
      q.mode === "days"
        ? { mode: "days", a: q.a, b: q.b, categories: q.categories ?? null }
        : q.mode === "periods"
          ? { mode: "periods", a: { from: q.aFrom, to: q.aTo }, b: { from: q.bFrom, to: q.bTo }, categories: q.categories ?? null }
          : q.mode === "machines"
            ? { mode: "machines", range: { from: q.from, to: q.to }, a: q.a, b: q.b }
            : { mode: "categories", range: { from: q.from, to: q.to }, a: q.a, b: q.b };
    const r = await answer(req, reply, () => compareSales(viewer, request));
    return r === null ? reply.code(404).send({ error: { code: "not_found", message: "No such machine.", correlationId: req.correlationId } }) : r;
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
