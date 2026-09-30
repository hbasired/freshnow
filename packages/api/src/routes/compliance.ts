import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { companyToday, complianceEvidence, exportPersonData } from "@freshnow/core";
import { forbid, resolveViewer } from "../viewer.js";

/**
 * Compliance you can open: the policy checks and their evidence (rule R8), and a person's own
 * data as a file they can keep — the PDPL rights to information and to a machine-readable copy
 * (Art. 13–14 [believed]). Reads only; the one thing written is the audit row for an export.
 */

const IdParams = z.object({ id: z.string().uuid() });

function sendAsFile(reply: FastifyReply, data: unknown, name: string): FastifyReply {
  return reply
    .header("Content-Type", "application/json; charset=utf-8")
    .header("Content-Disposition", `attachment; filename="${name}"`)
    .header("Cache-Control", "no-store")
    .send(JSON.stringify(data, null, 2));
}

export function registerComplianceRoutes(app: FastifyInstance): void {
  /** The CEO's view: every rule, where data goes, and the counts that prove it. */
  app.get("/dashboard/compliance", async (req, reply) => {
    const viewer = await resolveViewer(req);
    if (!viewer.isCeo) return forbid(req, reply, "Only the CEO can open the compliance record");
    const forwarded = req.headers["x-forwarded-host"];
    const host = (Array.isArray(forwarded) ? forwarded[0] : forwarded) ?? req.headers.host ?? null;
    return complianceEvidence({ days: 30, requestHost: host, viaCloudflare: typeof req.headers["cf-ray"] === "string" });
  });

  /** Everything held about the person asking. Their right, so no role or fresh consent needed. */
  app.get("/dashboard/me/export", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const data = await exportPersonData({ employeeId: viewer.employeeId, requestedBy: viewer.employeeId, correlationId: req.correlationId });
    return sendAsFile(reply, data, `freshnow-my-data-${companyToday()}.json`);
  });

  /** For a request that arrives some other way — someone who has left, or asked in person. */
  app.get("/dashboard/people/:id/export", async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const viewer = await resolveViewer(req);
    if (!viewer.isCeo) return forbid(req, reply, "Only the CEO can export another person's data");
    try {
      const data = await exportPersonData({ employeeId: id, requestedBy: viewer.employeeId, correlationId: req.correlationId });
      return sendAsFile(reply, data, `freshnow-data-${id.slice(0, 8)}-${companyToday()}.json`);
    } catch (e) {
      if (e instanceof Error && e.message === "No such person") return reply.code(404).send({ error: { code: "not_found", message: "No such person", correlationId: req.correlationId } });
      throw e;
    }
  });
}
