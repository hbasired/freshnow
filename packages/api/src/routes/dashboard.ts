import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  IS_DEMO,
  answerQuestion,
  companyToday,
  generateAllEodReports,
  loadConfig,
  withContext,
} from "@freshnow/core";
import { DASHBOARD_HTML } from "../dashboard-page.js";
import { AuthError, authEnabled, viewerFromToken } from "../auth.js";
// Reads run under the viewer's RLS context via withContext (the app role,
// RLS-enforced), so an employee sees only their own rows and the CEO sees all —
// enforced by Postgres, not by the handler. See ../viewer.ts for who the viewer is.
import { resolveViewer, viewerOf } from "../viewer.js";
import { BEHIND_THRESHOLD_POINTS } from "./tasks.js";
import { isLocalSupabase } from "./auth-proxy.js";

/**
 * The most rows any board list returns.
 *
 * `/dashboard/employees`, `/blockers` and `/tasks` had no LIMIT at all: they grew
 * monotonically with the company's whole history and were re-fetched on every live-sync
 * refresh. CLAUDE.md rule 4 says result sets are bounded, and these were the exception.
 * 500 is far above anything a dashboard can usefully show and far below anything that
 * hurts — if a list ever truncates in practice, the answer is a filter, not a bigger number.
 */
const LIST_LIMIT = 500;

export function registerDashboardRoutes(app: FastifyInstance): void {
  /**
   * Optional shared-secret gate.
   *
   * The API binds to 0.0.0.0 so a phone can reach it, and there is no login — so without
   * this, anyone on the same wifi can read every employee's data and run the NL-query
   * box, which executes generated SQL as the BYPASSRLS service role. Set
   * `DASHBOARD_TOKEN` and every dashboard request must carry it; leave it unset and the
   * demo behaves as before. A gate that can be turned on is worth more than a comment
   * saying one is needed.
   */
  app.addHook("onRequest", async (req, reply) => {
    const expected = loadConfig().DASHBOARD_TOKEN;
    if (!expected) return;
    if (!req.url.startsWith("/dashboard") && req.url !== "/") return;

    const supplied =
      (req.headers["x-dashboard-key"] as string | undefined) ??
      new URL(req.url, "http://x").searchParams.get("k") ??
      undefined;
    // Length-independent compare is overkill for a demo token, but constant-time is free
    // here and removes the question.
    if (!supplied || supplied.length !== expected.length || !timingSafeEqualStr(supplied, expected)) {
      return reply.code(401).send({ error: { code: "unauthorized", message: "Dashboard key required" } });
    }
  });

  // Public bootstrap for the React app: whether sign-in is required, and the Supabase URL
  // plus anon key to sign in with. Both are public by design — the anon key is what every
  // Supabase browser client ships — so this route needs no authentication.
  app.get("/app-config", async (req) => {
    const c = loadConfig();
    let supabaseUrl = c.SUPABASE_URL ?? null;
    // A local Supabase is published on 127.0.0.1, which on a phone means the phone itself.
    // Hand the browser the host it reached THIS server on, so sign-in works over the LAN.
    // Tokens are still issued under the configured issuer, so verification is unaffected;
    // a hosted project URL passes through untouched.
    if (supabaseUrl) {
      const u = new URL(supabaseUrl);
      if (u.hostname === "127.0.0.1" || u.hostname === "localhost") {
        u.hostname = req.hostname.split(":")[0] ?? u.hostname;
      }
      supabaseUrl = u.toString().replace(/\/$/, "");
    }
    // `isDemo` comes from core's IS_DEMO, which is what it was always for: badging
    // synthetic content honestly. The dashboard used to hardcode a DEMO chip, which would
    // have gone on lying once this build carried real company data.
    return {
      authRequired: authEnabled(),
      isDemo: IS_DEMO,
      supabaseUrl,
      // For a local Supabase, sign in through this server (routes/auth-proxy.ts) so the page
      // and its sign-in share one origin — the only way an HTTPS tunnel to port 3001 lets a
      // phone both sign in and receive push. The browser then uses its own address.
      supabaseSameOrigin: isLocalSupabase(c.SUPABASE_URL),
      supabaseAnonKey: c.SUPABASE_ANON_KEY ?? null,
      // The VAPID PUBLIC key, which is what `pushManager.subscribe` needs. Public by
      // design — like the Supabase anon key above, it identifies the sender rather than
      // authorising anything. The private key never leaves .env.
      vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? null,
    };
  });

  // Identity for every dashboard data call and the invite endpoint. A hook rather than
  // per-route code so no route can forget it, and it resolves the viewer from a verified
  // Supabase JWT — never from a value the caller controls. A no-op in demo mode (no
  // SUPABASE_URL). Registered on the root instance, so it covers /employees too.
  app.addHook("preHandler", async (req, reply) => {
    const guarded = req.url.startsWith("/dashboard") || req.url.startsWith("/employees");
    if (!authEnabled() || !guarded) return;
    try {
      const v = await viewerFromToken(req.headers.authorization);
      // The REAL employee id, always — never the "ceo" label. Collapsing a signed-in CEO to
      // "ceo" made `actorOf` resolve them to DEMO_CEO_ID, so every write by any real CEO
      // was audited as the seeded demo employee and shared its rate-limit counter. The one
      // question the audit log exists to answer — "who did this" — was wrong for the one
      // person it matters most for. `viewerIsCeo` carries the role separately.
      // (Audit 2026-09-18.)
      req.viewerId = v.employeeId;
      req.viewerIsCeo = v.isCeo;
      req.viewerName = v.displayName;
      req.viewerRole = v.accessRole;
      req.viewerDepartment = v.department;
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.code(err.status).send({
          error: { code: err.status === 401 ? "unauthenticated" : "forbidden", message: err.message },
        });
      }
      throw err;
    }
  });

  app.get("/dashboard/me", async (req) => {
    const v = await resolveViewer(req);
    // Whether this person can be reached on Telegram at all — the preferences card offers a
    // Telegram column only to people who have one, instead of a switch that does nothing.
    const linked = await withContext(v, (sql) => sql<{ linked: boolean }[]>`
      select telegram_user_id is not null as linked from employee where id = ${v.employeeId}`);
    return {
      telegramLinked: linked[0]?.linked ?? false,
      viewer: viewerOf(req),
      // The actual employee uuid behind the viewer. "ceo" is a label, and the browser needs
      // the id to tell its own tasks apart from everyone else's.
      employeeId: v.employeeId,
      isCeo: v.isCeo,
      // What the browser may offer: a manager or lead gets the assign form, an employee
      // does not. The API refuses either way; this only avoids buttons that can only fail.
      accessRole: v.accessRole,
      department: v.department,
      displayName: req.viewerName ?? (v.displayName || null),
      authRequired: authEnabled(),
    };
  });

  // The original page has no sign-in, so under real auth every call it makes would be
  // refused. Send people to the React app, which signs in. Demo mode keeps the old page.
  app.get("/", async (_req, reply) =>
    authEnabled() ? reply.redirect("/app/") : reply.type("text/html").send(DASHBOARD_HTML),
  );

  app.get("/dashboard/employees", async (req) =>
    withContext(await resolveViewer(req), (sql) =>
      // `linked` — whether the bot can reach them — without exposing the Telegram id itself.
      sql`select id, display_name, department, role_title, site, shift, status, is_synthetic,
                 (telegram_user_id is not null) as linked,
                 access_role, manager_employee_id,
                 employee_display_name(manager_employee_id) as manager_name
          from employee order by display_name
          limit ${LIST_LIMIT}`),
  );

  app.get("/dashboard/blockers", async (req) =>
    withContext(await resolveViewer(req), (sql) =>
      sql`select b.id, b.category, b.severity, b.status, b.affected_asset, b.raised_at, b.is_synthetic,
                 e.display_name as raised_by_name
          from blocker b join employee e on e.id = b.raised_by
          order by b.raised_at desc
          limit ${LIST_LIMIT}`),
  );

  app.get("/dashboard/tasks", async (req) =>
    withContext(await resolveViewer(req), (sql) =>
      sql`select t.id, t.title, t.status, t.is_synthetic, e.display_name as employee_name
          from task t join employee e on e.id = t.employee_id
          order by t.created_at desc
          limit ${LIST_LIMIT}`),
  );

  // What people actually SAID. Without this the employee's own words are stored but
  // invisible — which is what made a real status report look like it had vanished.
  app.get("/dashboard/updates", async (req) =>
    withContext(await resolveViewer(req), (sql) =>
      sql`select u.id, u.task_id, u.status, u.note_raw, u.note_parsed->>'summary' as summary,
                 u.submitted_at, u.is_synthetic, u.channel,
                 e.display_name as employee_name,
                 t.title as task_title
          from task_update u
          join employee e on e.id = u.employee_id
          left join task t on t.id = u.task_id
          order by u.submitted_at desc
          limit 50`),
  );

  // Updates the parser could not read. These must be visible to a human — otherwise
  // needs_review is a silent delete for the least literate employees.
  app.get("/dashboard/needs-review", async (req) =>
    withContext(await resolveViewer(req), (sql) =>
      sql`select u.id, u.note_raw, u.submitted_at, e.display_name as employee_name
          from task_update u join employee e on e.id = u.employee_id
          where u.note_parsed->>'needs_review' = 'true'
          order by u.submitted_at desc limit 25`),
  );

  // Recent activity, so the CEO can see the system actually working.
  app.get("/dashboard/activity", async (req) =>
    withContext(await resolveViewer(req), (sql) =>
      // `id` is selected so the browser can key rows on it. Keying on
      // (created_at, action, actor) collided for batch writes, which share a timestamp to
      // the millisecond — React then reused the wrong row's DOM node.
      sql`select id, action, actor, entity, created_at, correlation_id
          from audit_log order by created_at desc limit 40`),
  );

  function dayOf(req: { query: unknown }): string {
    const d = String((req.query as { date?: string }).date ?? "");
    // Company time, not UTC — after 20:00 in Dubai the UTC date is still yesterday, so
    // the dashboard would open on the wrong day exactly when the shift is ending.
    return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : companyToday();
  }

  // Everything reported on one day, with who said it and their exact words. The UI
  // splits this into completed / pending / blocked — one query, three tables.
  app.get("/dashboard/day", async (req) =>
    withContext(await resolveViewer(req), (sql) =>
      sql`select u.id, u.status, u.note_raw, u.note_parsed->>'summary' as summary,
                 u.submitted_at, u.is_synthetic,
                 e.display_name as employee_name, e.department,
                 t.id as task_id, t.title as task_title, t.status as task_status,
                 b.id as blocker_id, b.severity, b.category, b.status as blocker_status,
                 (select count(*)::int from attachment f where f.task_update_id = u.id) as files
          from task_update u
          join employee e on e.id = u.employee_id
          left join task t on t.id = u.task_id
          left join blocker b on b.task_update_id = u.id
          where u.submitted_at >= ${dayOf(req)}::date
            and u.submitted_at <  (${dayOf(req)}::date + interval '1 day')
          order by u.submitted_at desc
          limit ${LIST_LIMIT}`),
  );

  // The last seven company days as three counts each — computed by Postgres, under the
  // viewer's row-level rules, so the chart on the home view shows exactly what this
  // person may see and never a number the browser added up itself. Days with nothing
  // reported still appear (generate_series), because a silent day is information.
  // Day boundaries are Dubai midnight, not UTC: an update at 22:00 Dubai belongs to that
  // day, not to the next UTC one.
  app.get("/dashboard/week", async (req) =>
    withContext(await resolveViewer(req), (sql) =>
      sql`with days as (
             select generate_series(${dayOf(req)}::date - 6, ${dayOf(req)}::date, interval '1 day')::date as day),
           counted as (
             select (u.submitted_at at time zone 'Asia/Dubai')::date as day,
                    count(*) filter (where u.status = 'done')::int as completed,
                    count(*) filter (where u.status in ('pending', 'in_progress'))::int as pending,
                    count(*) filter (where u.status = 'blocker')::int as blocked
             from task_update u
             where u.submitted_at >= ((${dayOf(req)}::date - 6)::timestamp at time zone 'Asia/Dubai')
               and u.submitted_at <  ((${dayOf(req)}::date + 1)::timestamp at time zone 'Asia/Dubai')
             group by 1)
           select to_char(d.day, 'YYYY-MM-DD') as day,
                  coalesce(c.completed, 0) as completed,
                  coalesce(c.pending, 0) as pending,
                  coalesce(c.blocked, 0) as blocked
           from days d left join counted c on c.day = d.day
           order by d.day`),
  );

  // Work still open, with its AGE — this is the carry-over view: what is outstanding
  // from earlier days, who owns it, and the last thing they said about it.
  app.get("/dashboard/open-tasks", async (req) => {
    const rows = await withContext(await resolveViewer(req), (sql) =>
      sql`select t.id, t.title, t.status, t.created_at, t.is_synthetic,
                 t.employee_id, t.progress_pct, t.progress_source, t.priority, t.due_at, t.started_at,
                 case when t.started_at is not null and t.due_at is not null and t.due_at > t.started_at
                      then greatest(0, least(100, round(100 * extract(epoch from (now() - t.started_at))
                                                          / extract(epoch from (t.due_at - t.started_at)))))::int
                      else null end as elapsed_pct,
                 e.display_name as employee_name, e.department,
                 date_trunc('day', t.created_at)::date as opened_on,
                 greatest(0, (current_date - t.created_at::date))::int as age_days,
                 (select u.note_raw from task_update u
                   where u.task_id = t.id and u.note_raw is not null
                   order by u.submitted_at desc limit 1) as last_note,
                 (select u.submitted_at from task_update u
                   where u.task_id = t.id
                   order by u.submitted_at desc limit 1) as last_reported_at
          from task t join employee e on e.id = t.employee_id
          where t.status not in ('done','cancelled')
          order by t.created_at`,
    );
    // The behind flag is one rule in one place (tasks.ts); the board gets the same answer
    // as the detail panel.
    return rows.map((r) => ({
      ...r,
      behind: r.elapsed_pct != null && Number(r.elapsed_pct) - Number(r.progress_pct) > BEHIND_THRESHOLD_POINTS,
    }));
  });

  // Who was given what, by whom, and whether it was delivered. Names come from
  // employee_display_name() rather than a join: an employee cannot read the CEO's row, so
  // a join would drop every assignment the CEO gave them (migration 0008 explains).
  app.get("/dashboard/assignments", async (req) =>
    withContext(await resolveViewer(req), (sql) =>
      sql`select a.id, a.status, a.note, a.created_at, a.is_synthetic,
                 t.title as task_title, t.status as task_status,
                 employee_display_name(a.assigned_by) as assigned_by,
                 employee_display_name(a.assigned_to) as assigned_to,
                 (select count(*)::int from attachment f where f.assignment_id = a.id) as files,
                 (select string_agg(coalesce(f.file_name, f.kind), ', ')
                    from attachment f where f.assignment_id = a.id) as file_names
          from assignment a
          left join task t on t.id = a.task_id
          order by a.created_at desc limit 50`),
  );

  // Stored end-of-day reports.
  app.get("/dashboard/eod", async (req) =>
    withContext(await resolveViewer(req), (sql) =>
      // `r.id` so the browser can key on it: two employees may share a display name, and
      // keying cards on the name made them share a DOM node.
      sql`select r.id, r.report_date, r.completed, r.pending, r.blockers, r.reports_made,
                 r.summary, r.detail, r.generated_at, r.is_synthetic,
                 e.display_name as employee_name
          from daily_report r join employee e on e.id = r.employee_id
          where r.report_date = ${dayOf(req)}::date
          order by e.display_name`),
  );

  // Generate today's reports on demand, so the CEO is never looking at a stale board.
  app.post("/dashboard/eod/generate", async (req, reply) => {
    // Generating writes a report for every employee and spends model calls, so with real
    // sign-in it is the CEO's action. In demo mode there is no identity to check.
    if (authEnabled() && !req.viewerIsCeo) {
      return reply.code(403).send({ error: { code: "forbidden", message: "Only the CEO can generate reports" } });
    }
    const reports = await generateAllEodReports();
    return { generated: reports.length, date: reports[0]?.reportDate ?? null };
  });

  const QueryBody = z.object({ question: z.string().min(3).max(300) });
  app.post("/dashboard/query", async (req, reply) => {
    // Generated SQL runs as the service role (see the note below), so once sign-in is real
    // this box belongs to the CEO alone. In demo mode there is no identity to check.
    if (authEnabled() && !req.viewerIsCeo) {
      return reply.code(403).send({ error: { code: "forbidden", message: "Only the CEO can ask questions here" } });
    }
    const body = QueryBody.parse(req.body);
    // The query runs behind the asker's own RLS context, not the service role, so the
    // answer is bounded by what this person may actually see (audit 2026-09-18).
    return answerQuestion(body.question, req.correlationId, await resolveViewer(req));
  });
}

/** Constant-time string compare, so a token cannot be recovered by timing. */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
