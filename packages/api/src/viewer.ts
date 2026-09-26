import type { FastifyReply, FastifyRequest } from "fastify";
import { DEMO_CEO_ID, loadViewer, type ViewerOrg } from "@freshnow/core";

/**
 * Who is asking, and what they are allowed to do.
 *
 * These four functions are the single answer to that question for the whole API. They
 * used to live privately inside `routes/dashboard.ts`; the write routes need exactly the
 * same answer, and two copies of "who is the viewer" is the kind of split truth this
 * codebase is built to avoid.
 *
 * Reads are protected by Postgres: `withContext(await resolveViewer(req), ...)` sets the RLS
 * variables and the policies decide. Writes cannot be, because every core write runs as
 * the BYPASSRLS service role — so a write route must check permission itself, before it
 * calls core. Every such check has a test that proves the refusal.
 */

/**
 * With Supabase configured this is the employee behind a VERIFIED JWT, set on the request
 * by the auth hook — `?viewer=` is ignored entirely, because a parameter the caller
 * controls is not an identity. Without Supabase the dashboard is in demo mode and the
 * parameter is still honoured, exactly as before.
 */
export function viewerOf(req: { query: unknown; viewerId?: string }): string {
  if (req.viewerId) return req.viewerId;
  return String((req.query as { viewer?: string }).viewer ?? "ceo");
}

/**
 * The employee uuid to record as the actor of a write. `"ceo"` is a viewer label, not an
 * id; the audit log and the rate limiter both key on `employee:<uuid>`.
 */
export function actorOf(req: { query: unknown; viewerId?: string }): string {
  const v = viewerOf(req);
  return v === "ceo" ? DEMO_CEO_ID : v;
}

/** True for the CEO in both modes — a verified token, or `?viewer=ceo` in the demo. */
export function isCeo(req: { query: unknown; viewerId?: string; viewerIsCeo?: boolean }): boolean {
  return req.viewerIsCeo ?? viewerOf(req) === "ceo";
}

/**
 * Refuse, in the same shape the central error handler produces — including the
 * correlation id, so a refusal can be traced like any other outcome. Ad-hoc 403s that
 * omitted it were a small inconsistency worth removing while adding seven more of them.
 */
export function forbid(req: FastifyRequest, reply: FastifyReply, message: string): FastifyReply {
  return reply
    .code(403)
    .send({ error: { code: "forbidden", message, correlationId: req.correlationId } });
}

/**
 * The full viewer — identity plus org position — which is what both RLS and the write
 * routes need since migration 0009. Under real sign-in the hook has already verified and
 * fetched everything; in demo mode the person is looked up by the id the caller named.
 * An id that matches nobody gets the most restrictive context and sees nothing.
 */
export async function resolveViewer(req: {
  query: unknown;
  viewerId?: string;
  viewerIsCeo?: boolean;
  viewerName?: string;
  viewerRole?: ViewerOrg["accessRole"];
  viewerDepartment?: string | null;
}): Promise<ViewerOrg> {
  if (req.viewerId && req.viewerRole !== undefined) {
    return {
      employeeId: req.viewerId === "ceo" ? DEMO_CEO_ID : req.viewerId,
      isCeo: req.viewerIsCeo === true,
      accessRole: req.viewerRole,
      department: req.viewerDepartment ?? null,
      displayName: req.viewerName ?? "",
      status: "active",
    };
  }
  const id = actorOf(req);
  const v = await loadViewer(id);
  return v ?? { employeeId: id, isCeo: false, accessRole: "employee", department: null, displayName: "", status: "unknown" };
}
