import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  listEmployees,
  planDocumentTasks,
  planningDirectory,
  recordInboundEmail,
  recordWebhookProposal,
  screenInboundEmail,
  secretMatches,
} from "@freshnow/core";

/**
 * Assigning work by email.
 *
 * Cloudflare Email Routing (free) receives on the company domain, and a small Email Worker
 * POSTs the message here. That makes this the one route in the system a stranger can reach,
 * which is why it lives outside `/dashboard/*` **deliberately and with its own guard**
 * rather than by accident: the dashboard's JWT hook would reject a machine, so this route
 * authenticates with a shared secret instead — and then puts the message through four more
 * checks in `core/inbound-email.ts` before a single word is read.
 *
 * The output is a PROPOSAL, stored for the CEO to confirm in the dashboard. An email never
 * creates a task on its own, however well authenticated it is.
 */

const InboundBody = z.object({
  from: z.string().min(3).max(320),
  to: z.string().max(320).optional(),
  subject: z.string().max(500).optional(),
  text: z.string().max(40_000),
  spf: z.string().max(40).optional(),
  dkim: z.string().max(40).optional(),
  dmarc: z.string().max(40).optional(),
  headers: z.record(z.string().max(2000)).optional(),
});

export function registerInboundRoutes(app: FastifyInstance): void {
  app.post("/inbound/email", async (req, reply) => {
    const expected = process.env.INBOUND_EMAIL_SECRET;
    // No secret configured means the feature is off. Refuse rather than accept anything:
    // an unconfigured write path that works is worse than one that does not exist.
    if (!expected || expected.length < 16) {
      return reply.code(404).send({ error: { code: "not_enabled", message: "Inbound email is not enabled", correlationId: req.correlationId } });
    }
    const supplied = req.headers["x-freshnow-inbound-secret"];
    if (!secretMatches(typeof supplied === "string" ? supplied : undefined, expected)) {
      // Never echo the guess, and never say which part was wrong.
      return reply.code(401).send({ error: { code: "unauthenticated", message: "Bad secret", correlationId: req.correlationId } });
    }

    const body = InboundBody.parse(req.body);
    const verdict = await screenInboundEmail(
      {
        from: body.from,
        to: body.to ?? null,
        subject: body.subject ?? null,
        text: body.text,
        spf: body.spf ?? null,
        dkim: body.dkim ?? null,
        dmarc: body.dmarc ?? null,
        headers: body.headers,
      },
      req.correlationId,
    );
    if (!verdict.accepted) {
      // 202 for "understood and deliberately ignored" (an auto-reply), 403 for refused, so
      // the mail edge does not retry something we will never accept.
      return reply.code(verdict.status).send({ accepted: false, reason: verdict.reason });
    }

    // The words are on disk before anything interprets them — the same rule as Telegram.
    await recordInboundEmail({
      from: body.from,
      subject: body.subject ?? null,
      text: body.text,
      senderEmployeeId: verdict.senderEmployeeId,
      correlationId: req.correlationId,
    });

    const plan = await planDocumentTasks({
      text: body.text,
      colleagues: await planningDirectory(verdict.senderEmployeeId),
      instruction: body.subject ?? null,
      uploadedBy: verdict.senderEmployeeId,
      correlationId: req.correlationId,
    });

    // A proposal, not a write — now STORED (email_proposal), so the CEO can confirm it in the
    // dashboard (Assign → From email). Until TASK-053 it was only returned to the mail edge.
    const { proposalId } = await recordWebhookProposal({
      from: body.from,
      to: body.to ?? null,
      subject: body.subject ?? null,
      text: body.text,
      senderEmployeeId: verdict.senderEmployeeId,
      plan,
      correlationId: req.correlationId,
    });
    return reply.code(202).send({
      accepted: true,
      from: verdict.senderName,
      proposed: plan.tasks.length,
      proposalId,
      plan,
    });
  });
}
