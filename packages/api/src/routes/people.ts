import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ACCESS_ROLES,
  addPerson,
  AddPersonError,
  canAssignTo,
  EmailAddressError,
  reachOf,
  withContext,
} from "@freshnow/core";
import { forbid, resolveViewer } from "../viewer.js";

/**
 * People, from the dashboard (TASK-054): the CEO adds someone — with an email address, so they
 * can be given work by email even without Telegram — and whoever gives work can see, per person,
 * which ways of telling them actually work before choosing one.
 *
 * Under `/dashboard/*` like every other data route, so the shared-secret and sign-in hooks in
 * dashboard.ts cover these by prefix. Permission is explicit in each handler: core writes run as
 * the BYPASSRLS service role.
 */

const AddBody = z.object({
  displayName: z.string().trim().min(1).max(120),
  email: z.string().trim().max(254).nullable().optional(),
  department: z.string().trim().max(60).nullable().optional(),
  roleTitle: z.string().trim().max(120).nullable().optional(),
  site: z.string().trim().max(120).nullable().optional(),
  shift: z.string().trim().max(60).nullable().optional(),
  accessRole: z.enum(ACCESS_ROLES as [string, ...string[]]).optional(),
  managerEmployeeId: z.string().uuid().nullable().optional(),
  telegramInvite: z.boolean().optional(),
});

/** At most this many people are checked per call — far above any team this dashboard shows. */
const REACH_LIMIT = 500;

export function registerPeopleRoutes(app: FastifyInstance): void {
  /** Add a person. The CEO's: who exists in the company has one author, as roles do. */
  app.post("/dashboard/people", async (req, reply) => {
    const viewer = await resolveViewer(req);
    if (!viewer.isCeo) return forbid(req, reply, "Only the CEO can add people");
    const body = AddBody.parse(req.body);
    try {
      const r = await addPerson({
        displayName: body.displayName,
        email: body.email ?? null,
        department: body.department ?? null,
        roleTitle: body.roleTitle ?? null,
        site: body.site ?? null,
        shift: body.shift ?? null,
        ...(body.accessRole ? { accessRole: body.accessRole as (typeof ACCESS_ROLES)[number] } : {}),
        managerEmployeeId: body.managerEmployeeId ?? null,
        ...(body.telegramInvite !== undefined ? { telegramInvite: body.telegramInvite } : {}),
        by: viewer.employeeId,
        correlationId: req.correlationId,
      });
      return reply.code(201).send(r);
    } catch (err) {
      // The caller's mistake, said plainly; nothing was written.
      if (err instanceof EmailAddressError || err instanceof AddPersonError) {
        return reply.code(400).send({ error: { code: "bad_person", message: err.message, correlationId: req.correlationId } });
      }
      throw err;
    }
  });

  /**
   * For each person this viewer may give work to: can Telegram, the app and email reach them,
   * what their own rules would use, and whether they have agreed to the notice yet. Booleans and
   * reasons only — never a chat id or an address.
   */
  app.get("/dashboard/people/reach", async (req) => {
    const viewer = await resolveViewer(req);
    if (viewer.accessRole === "employee" && !viewer.isCeo) return { people: [] };
    // The people this viewer can SEE (RLS), then only those they may assign to (canAssignTo,
    // the same predicate the assignment route enforces).
    const visible = await withContext(viewer, (sql) => sql<{ id: string }[]>`
      select id from employee where status = 'active' order by display_name limit ${REACH_LIMIT}`);
    const allowed: string[] = [];
    for (const v of visible) {
      if (v.id !== viewer.employeeId && (await canAssignTo(viewer, v.id))) allowed.push(v.id);
    }
    const reach = await reachOf(allowed);
    return { people: allowed.map((id) => reach.get(id)).filter((r) => r !== undefined) };
  });
}
