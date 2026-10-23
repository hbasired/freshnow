import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  OpsAccessRefused,
  OpsDayRefused,
  OpsRefused,
  alarmsNow,
  companyToday,
  dayReport,
  fleetNow,
  machineDetail,
  machinePage,
  refillsOn,
  salesByHour,
  salesList,
} from "@freshnow/core";
import { forbid, resolveViewer } from "../viewer.js";

/**
 * The Operations portal's reads (TASK-058: sales by hour; TASK-059: the command centre — the fleet,
 * the alarms that need someone, one machine, a day's report). Under /dashboard/*, so the auth hook
 * guards them (D71). Whether the viewer may read Televend data is decided in core (`televend.read`)
 * and again by row-level security on every table read.
 */

const DayQuery = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
const AssetParam = z.object({ asset: z.coerce.number().int().min(1).max(99_999) });
const SalesQuery = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  machine: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  category: z.string().max(60).optional(),
  payment: z.string().max(40).optional(),
  before: z.string().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** One refusal shape for every ops read: 403 for the wrong role, 400 for a bad day. */
async function answer<T>(req: FastifyRequest, reply: FastifyReply, run: () => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof OpsAccessRefused || err instanceof OpsRefused) return forbid(req, reply, err.message);
    if (err instanceof OpsDayRefused) {
      return reply.code(400).send({ error: { code: "bad_day", message: err.message, correlationId: req.correlationId } });
    }
    throw err;
  }
}

export function registerOpsRoutes(app: FastifyInstance): void {
  /** Cups sold by Dubai hour, against the same weekday a week earlier — counted by Postgres. */
  app.get("/dashboard/ops/sales-by-hour", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { date } = DayQuery.parse(req.query);
    return answer(req, reply, () => salesByHour(viewer, date ?? companyToday()));
  });

  /** Every enabled machine now: its state, today's cups, its last collection and the cash waiting since. */
  app.get("/dashboard/ops/fleet", async (req, reply) => {
    const viewer = await resolveViewer(req);
    return answer(req, reply, () => fleetNow(viewer));
  });

  /** The alarms that need someone now — past their on-delay, one line per machine and alarm. */
  app.get("/dashboard/ops/alarms", async (req, reply) => {
    const viewer = await resolveViewer(req);
    return answer(req, reply, () => alarmsNow(viewer));
  });

  /** One machine: today by hour, its alarms, its last collections with the cash each should have found, its refills. */
  app.get("/dashboard/ops/machines/:asset", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { asset } = AssetParam.parse(req.params);
    const r = await answer(req, reply, () => machineDetail(viewer, asset));
    if (r === null) return reply.code(404).send({ error: { code: "not_found", message: "No machine with that number.", correlationId: req.correlationId } });
    return r;
  });

  /** One machine as a full page (TASK-072): everything about it, across every Televend record it has had. */
  app.get("/dashboard/ops/machines/:asset/page", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { asset } = AssetParam.parse(req.params);
    const r = await answer(req, reply, () => machinePage(viewer, asset));
    if (r === null) return reply.code(404).send({ error: { code: "not_found", message: "No machine with that number.", correlationId: req.correlationId } });
    return r;
  });

  /** A day's refills, row by row: which machine, by whom, how much, how full after (TASK-072). */
  app.get("/dashboard/ops/refills", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { date } = DayQuery.parse(req.query);
    return answer(req, reply, () => refillsOn(viewer, date ?? companyToday()));
  });

  /** A day's sales, newest first, filtered and paged, with the day's totals under the same filters (TASK-072, R10). */
  app.get("/dashboard/ops/sales", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const q = SalesQuery.parse(req.query);
    return answer(req, reply, () =>
      salesList(viewer, {
        date: q.date ?? companyToday(),
        ...(q.machine !== undefined ? { machineTvId: q.machine } : {}),
        ...(q.category ? { category: q.category } : {}),
        ...(q.payment ? { payment: q.payment } : {}),
        ...(q.before ? { before: q.before } : {}),
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
      }),
    );
  });

  /** A day's report: cups by payment, each cash collection with the cash Televend says it should have found, refills, alarms. */
  app.get("/dashboard/ops/day-report", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { date } = DayQuery.parse(req.query);
    return answer(req, reply, () => dayReport(viewer, date ?? companyToday()));
  });
}
