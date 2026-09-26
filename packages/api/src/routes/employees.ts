import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createInvite, logAudit } from "@freshnow/core";
import { authEnabled } from "../auth.js";

const InviteBody = z.object({
  displayName: z.string().min(1).max(120),
});

export function registerEmployeeRoutes(app: FastifyInstance): void {
  // The CEO issues a single-use invite. With Supabase sign-in on, only the CEO's token gets
  // past the gate below; in demo mode the endpoint is open, exactly as the dashboard is.
  // Boundary validation is an explicit Zod parse; failures become a 400.
  app.post("/employees/invite", async (req, reply) => {
    if (authEnabled() && !req.viewerIsCeo) {
      return reply.code(403).send({ error: { code: "forbidden", message: "Only the CEO can create invites" } });
    }
    const body = InviteBody.parse(req.body);
    // The signed-in person, by their own id. "Was the CEO, so record the seeded CEO" was
    // wrong the moment the real CEO was a different row (audit 2026-09-18).
    const issuer = authEnabled() && req.viewerId ? req.viewerId : null;
    const invite = await createInvite({ displayName: body.displayName, ...(issuer ? { issuedBy: issuer } : {}) });
    await logAudit({
      correlationId: req.correlationId,
      actor: issuer ? `employee:${issuer}` : "api",
      action: "invite.created",
      entity: "invite_code",
      entityId: invite.code,
      detail: { displayName: body.displayName },
    });
    return reply.status(201).send({ code: invite.code, expiresAt: invite.expiresAt });
  });
}
