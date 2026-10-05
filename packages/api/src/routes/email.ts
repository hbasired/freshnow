import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  assignTask,
  canAssignTo,
  checkRateLimit,
  decideEmailProposal,
  EmailAddressError,
  emailOverview,
  listPendingEmailProposals,
  pendingEmailProposal,
  setEmployeeEmail,
} from "@freshnow/core";
import { forbid, resolveViewer } from "../viewer.js";

/**
 * Email in the dashboard (TASK-053): the CEO's view of the channel and who has which address,
 * and the proposals read out of emails — applied or dismissed by a person, never automatically.
 */

const IdParams = z.object({ id: z.string().uuid() });
const EmailBody = z.object({ email: z.string().max(254).nullable() });
const ApplyBody = z.object({
  tasks: z
    .array(z.object({ title: z.string().min(1).max(160), detail: z.string().max(600).nullable().optional(), assignedTo: z.string().uuid() }))
    .min(1)
    .max(20),
});

export function registerEmailRoutes(app: FastifyInstance): void {
  /** The channel's state, addresses and the last 30 emails. The CEO's. */
  app.get("/dashboard/email", async (req, reply) => {
    const viewer = await resolveViewer(req);
    if (!viewer.isCeo) return forbid(req, reply, "Only the CEO can open the email settings");
    return emailOverview();
  });

  /** Set or clear one person's address. The CEO's; refused off the allow-list. */
  app.put("/dashboard/employees/:id/email", async (req, reply) => {
    const viewer = await resolveViewer(req);
    if (!viewer.isCeo) return forbid(req, reply, "Only the CEO can change email addresses");
    const { id } = IdParams.parse(req.params);
    const { email } = EmailBody.parse(req.body);
    try {
      return await setEmployeeEmail({ employeeId: id, email, by: viewer.employeeId, correlationId: req.correlationId });
    } catch (err) {
      if (err instanceof EmailAddressError) {
        return reply.code(400).send({ error: { code: "bad_email", message: err.message, correlationId: req.correlationId } });
      }
      throw err;
    }
  });

  /** Pending proposals: all of them for the CEO, a manager's own otherwise. */
  app.get("/dashboard/email/proposals", async (req) => {
    const viewer = await resolveViewer(req);
    if (viewer.accessRole === "employee" && !viewer.isCeo) return { proposals: [] };
    return { proposals: await listPendingEmailProposals(20, viewer.isCeo ? undefined : viewer.employeeId) };
  });

  /** Apply: assign the tasks as the person confirmed them — owners may have been changed. */
  app.post("/dashboard/email/proposals/:id/apply", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { id } = IdParams.parse(req.params);
    const body = ApplyBody.parse(req.body);
    const proposal = await pendingEmailProposal(id);
    if (!proposal) return reply.code(404).send({ error: { code: "not_found", message: "No pending proposal with that id", correlationId: req.correlationId } });
    if (!viewer.isCeo && proposal.proposedBy !== viewer.employeeId) return forbid(req, reply, "Only the CEO or the sender can apply this");
    // Every row checked before any is written: no half-applied email.
    for (const t of body.tasks) {
      if (!(await canAssignTo(viewer, t.assignedTo))) return forbid(req, reply, "One of these tasks is for somebody outside your team");
    }
    const rl = await checkRateLimit({ key: "assignment", employeeId: viewer.employeeId });
    if (!rl.allowed) return reply.code(429).send({ error: { code: "rate_limited", message: rl.message, correlationId: req.correlationId } });
    // Decide first: a second tap (or a second tab) finds it already applied and assigns nothing.
    if (!(await decideEmailProposal({ proposalId: id, by: viewer.employeeId, status: "applied", correlationId: req.correlationId }))) {
      return reply.code(409).send({ error: { code: "already_decided", message: "Already applied or dismissed", correlationId: req.correlationId } });
    }
    const provenance = `(from email${proposal.subject ? `: ${proposal.subject.slice(0, 120)}` : ""})`;
    const assigned = [];
    for (const t of body.tasks) {
      const res = await assignTask({
        assignedBy: viewer.employeeId,
        assignedTo: t.assignedTo,
        title: t.title,
        note: t.detail ? `${t.detail}\n\n${provenance}` : provenance,
        correlationId: req.correlationId,
      });
      assigned.push({ taskId: res.taskId, assignmentId: res.assignmentId, assignedTo: t.assignedTo, queued: res.delivered });
    }
    return reply.code(201).send({ assigned });
  });

  app.post("/dashboard/email/proposals/:id/dismiss", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { id } = IdParams.parse(req.params);
    const proposal = await pendingEmailProposal(id);
    if (!proposal) return reply.code(404).send({ error: { code: "not_found", message: "No pending proposal with that id", correlationId: req.correlationId } });
    if (!viewer.isCeo && proposal.proposedBy !== viewer.employeeId) return forbid(req, reply, "Only the CEO or the sender can dismiss this");
    await decideEmailProposal({ proposalId: id, by: viewer.employeeId, status: "dismissed", correlationId: req.correlationId });
    return { dismissed: true };
  });
}
