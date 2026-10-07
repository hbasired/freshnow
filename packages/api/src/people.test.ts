import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, currentNoticeHash, getServiceSql, recordConsent } from "@freshnow/core";
import { buildServer } from "./server.js";

/**
 * TASK-054 over HTTP: adding a person with an email, choosing how an assignee is told, the
 * reachability the Assign form shows, and the Overview's numbers.
 *
 * As in work.test.ts, the refusals matter as much as the happy path — core writes run as the
 * BYPASSRLS service role, so a handler that forgets a check fails silently and for ever.
 */

const app = buildServer(false);
const run = randomUUID().slice(0, 6);
const PREFIX = `PPL-${run}-`;
const M = randomUUID(); // a manager
const R = randomUUID(); // M's report, on Telegram, with an email
const N = randomUUID(); // M's report, no Telegram, no email
const E = randomUUID(); // an ordinary employee, not M's
const added: string[] = [];
const EMAIL_R = `ppl-${run}-r@example.com`;

const saved = { smtp: process.env.SMTP_HOST, from: process.env.EMAIL_FROM, allow: process.env.EMAIL_ALLOWLIST };
let emailWasEnabled = false;

async function seed(id: string, name: string, role: string, manager: string | null, telegram: number | null, email: string | null) {
  await getServiceSql()`
    insert into employee (id, display_name, status, is_synthetic, access_role, manager_employee_id, department, telegram_user_id, email)
    values (${id}, ${PREFIX + name}, 'active', true, ${role}, ${manager}, 'production', ${telegram}, ${email})`;
}

beforeAll(async () => {
  process.env.SMTP_HOST = "smtp.test";
  process.env.EMAIL_FROM = `FreshNow <ops-${run}@example.com>`;
  delete process.env.EMAIL_ALLOWLIST;
  const sql = getServiceSql();
  emailWasEnabled = (await sql<{ enabled: boolean }[]>`select enabled from channel_setting where channel = 'email'`)[0]?.enabled ?? false;
  await sql`update channel_setting set enabled = true where channel = 'email'`;
  await seed(M, "Mona", "manager", null, null, null);
  await seed(R, "Ravi", "employee", M, 9_810_000_000_000 + Math.floor(Math.random() * 1e5), EMAIL_R);
  await seed(N, "Nadia", "employee", M, null, null);
  await seed(E, "Eli", "employee", null, null, null);
  for (const id of [M, R, N, E]) await recordConsent({ employeeId: id, noticeHash: currentNoticeHash(), via: "app" });
});

afterAll(async () => {
  const sql = getServiceSql();
  const ids = [M, R, N, E, ...added];
  await sql`update channel_setting set enabled = ${emailWasEnabled} where channel = 'email'`;
  await sql`delete from blocker where raised_by = any(${ids})`;
  await sql`delete from task_update where employee_id = any(${ids})`;
  await sql`delete from assignment where assigned_to = any(${ids}) or assigned_by = any(${ids})`;
  await sql`delete from task where employee_id = any(${ids})`;
  await sql`delete from notification_outbox where recipient_employee_id = any(${ids})`;
  await sql`delete from invite_code where employee_id = any(${ids})`;
  await sql`delete from consent_record where employee_id = any(${ids})`;
  await sql`delete from employee where id = any(${ids})`;
  for (const [k, v] of [["SMTP_HOST", saved.smtp], ["EMAIL_FROM", saved.from], ["EMAIL_ALLOWLIST", saved.allow]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await app.close();
  await closeDb();
});

const post = (url: string, viewer: string, payload: unknown) =>
  app.inject({ method: "POST", url: `${url}?viewer=${viewer}`, payload: payload as Record<string, unknown> });
const get = (url: string, viewer: string, extra = "") => app.inject({ method: "GET", url: `${url}?viewer=${viewer}${extra}` });

describe("POST /dashboard/people — the CEO adds someone", () => {
  it("adds an active person with their email, under the CEO by default, with a Telegram invite bound to them", async () => {
    const res = await post("/dashboard/people", "ceo", { displayName: `${PREFIX}Farah Khan`, email: `  PPL-${run}-Farah@Example.com `, department: "Retail", roleTitle: "Kiosk lead" });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { employeeId: string; email: string; invite: { code: string } | null; consentRequested: boolean };
    added.push(body.employeeId);
    expect(body.email).toBe(`ppl-${run}-farah@example.com`);
    expect(body.invite?.code).toMatch(/^[A-Z2-9]{8}$/);
    // The notice went by email: the person has not agreed yet, and email is live.
    expect(body.consentRequested).toBe(true);
    const sql = getServiceSql();
    const [row] = await sql<{ status: string; department: string; access_role: string; manager_employee_id: string | null }[]>`
      select status, department, access_role, manager_employee_id from employee where id = ${body.employeeId}`;
    expect(row).toMatchObject({ status: "active", department: "Retail", access_role: "employee" });
    expect(row!.manager_employee_id).not.toBeNull();
    const inv = await sql<{ employee_id: string }[]>`select employee_id from invite_code where code = ${body.invite!.code}`;
    expect(inv[0]!.employee_id).toBe(body.employeeId);
    // The append-only log says what happened without keeping the name or the address.
    const audit = await sql<{ detail: Record<string, unknown> }[]>`select detail from audit_log where action = 'employee.added' and entity_id = ${body.employeeId}`;
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]!.detail)).not.toContain("Farah");
    expect(audit[0]!.detail).toMatchObject({ hasEmail: true, emailDomain: "example.com" });
    const notice = await sql<{ payload: { kind: string } }[]>`select payload from notification_outbox where recipient_employee_id = ${body.employeeId} and channel = 'email'`;
    expect(notice.map((n) => n.payload.kind)).toEqual(["consent.requested"]);
  });

  it("refuses — and writes nothing — for a bad address, someone else's address, an address off the allow-list, a CEO role, or no name", async () => {
    const sql = getServiceSql();
    const count = async () => (await sql<{ n: number }[]>`select count(*)::int as n from employee where display_name like ${`${PREFIX}%`}`)[0]!.n;
    const before = await count();
    const cases: Record<string, unknown>[] = [
      { displayName: `${PREFIX}Bad`, email: "not-an-address" },
      { displayName: `${PREFIX}Dup`, email: EMAIL_R.toUpperCase() },
      { displayName: `${PREFIX}Boss`, accessRole: "ceo" },
      { displayName: "   " },
    ];
    for (const c of cases) {
      const r = await post("/dashboard/people", "ceo", c);
      expect(r.statusCode, JSON.stringify(c)).toBe(400);
    }
    process.env.EMAIL_ALLOWLIST = `only-${run}@example.com`;
    try {
      const r = await post("/dashboard/people", "ceo", { displayName: `${PREFIX}Off`, email: `off-${run}@example.com` });
      expect(r.statusCode).toBe(400);
      expect((r.json() as { error: { message: string } }).error.message).toMatch(/EMAIL_ALLOWLIST/);
    } finally {
      delete process.env.EMAIL_ALLOWLIST;
    }
    expect(await count()).toBe(before);
  });

  it("is the CEO's alone — a manager is refused", async () => {
    const r = await post("/dashboard/people", M, { displayName: `${PREFIX}Sneaky` });
    expect(r.statusCode).toBe(403);
  });
});

describe("GET /dashboard/people/reach — what can reach whom, before choosing", () => {
  it("for a manager: only their own reports, each with the reason a channel cannot reach them", async () => {
    const res = await get("/dashboard/people/reach", M);
    expect(res.statusCode).toBe(200);
    const people = (res.json() as { people: { employeeId: string; telegram: { ok: boolean; why: string }; email: { ok: boolean; why: string }; app: { ok: boolean }; usual: string[] }[] }).people;
    expect(people.map((p) => p.employeeId).sort()).toEqual([R, N].sort());
    const ravi = people.find((p) => p.employeeId === R)!;
    expect(ravi.telegram.ok).toBe(true);
    expect(ravi.email.ok).toBe(true);
    expect(ravi.usual).toEqual(["telegram", "app"]); // email is opt-in for automatic messages
    const nadia = people.find((p) => p.employeeId === N)!;
    expect(nadia.telegram).toEqual({ ok: false, why: "not linked to the Telegram bot yet" });
    expect(nadia.email).toEqual({ ok: false, why: "no email address on file" });
    expect(nadia.app.ok).toBe(true);
    // Booleans and reasons only — never a chat id or an address.
    expect(res.body).not.toContain(EMAIL_R);
  });

  it("an employee gives no work, so sees nobody", async () => {
    const res = await get("/dashboard/people/reach", E);
    expect((res.json() as { people: unknown[] }).people).toEqual([]);
  });
});

describe("POST /dashboard/assignments with a channel choice", () => {
  const rowsFor = async (assignmentId: string) =>
    (await getServiceSql()<{ channel: string }[]>`select channel from notification_outbox where idempotency_key like ${`task.assigned:${assignmentId}:%`}`)
      .map((r) => r.channel)
      .sort();

  it("Email only: exactly one email, nothing on Telegram or in the app; the choice and origin are recorded", async () => {
    const res = await post("/dashboard/assignments", M, { assignedTo: R, title: `${PREFIX}restock kiosk 4`, channels: ["email"] });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { assignmentId: string; taskKey: string; notified: string[]; skipped: unknown[]; heldForConsent: boolean };
    expect(body.taskKey).toMatch(/^FN-\d+$/);
    expect(body.notified).toEqual(["email"]);
    expect(body.skipped).toEqual([]);
    expect(body.heldForConsent).toBe(false);
    expect(await rowsFor(body.assignmentId)).toEqual(["email"]);
    const [a] = await getServiceSql()<{ notify_channels: string[]; origin: string }[]>`select notify_channels, origin from assignment where id = ${body.assignmentId}`;
    expect(a).toEqual({ notify_channels: ["email"], origin: "dashboard" });
  });

  it("Telegram + App + Email to someone with only the app: the two that cannot reach are reported as skipped, with why", async () => {
    const res = await post("/dashboard/assignments", M, { assignedTo: N, title: `${PREFIX}sweep the yard`, channels: ["telegram", "app", "email"] });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { assignmentId: string; notified: string[]; skipped: { choice: string; why: string }[] };
    expect(body.notified).toEqual(["app"]);
    expect(body.skipped).toEqual([
      { choice: "telegram", why: "not linked to the Telegram bot yet" },
      { choice: "email", why: "no email address on file" },
    ]);
    expect(await rowsFor(body.assignmentId)).toEqual(["inapp"]);
  });

  it("a choice that cannot reach them at all is refused before anything is written", async () => {
    const sql = getServiceSql();
    const before = (await sql<{ n: number }[]>`select count(*)::int as n from task where employee_id = ${N}`)[0]!.n;
    const res = await post("/dashboard/assignments", M, { assignedTo: N, title: `${PREFIX}never told`, channels: ["telegram"] });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string; message: string } }).error).toMatchObject({ code: "no_channel", message: expect.stringMatching(/Telegram: not linked/) });
    expect((await sql<{ n: number }[]>`select count(*)::int as n from task where employee_id = ${N}`)[0]!.n).toBe(before);
  });

  it("no choice: their own rules, as before — and the record says nobody chose", async () => {
    const res = await post("/dashboard/assignments", M, { assignedTo: R, title: `${PREFIX}usual way` });
    const body = res.json() as { assignmentId: string; notified: string[] };
    expect(body.notified).toEqual(["telegram", "app"]);
    expect(await rowsFor(body.assignmentId)).toEqual(["inapp", "telegram"]);
    const [a] = await getServiceSql()<{ notify_channels: string[] | null }[]>`select notify_channels from assignment where id = ${body.assignmentId}`;
    expect(a!.notify_channels).toBeNull();
  });

  it("an unknown channel name is a 400, not a guess", async () => {
    const res = await post("/dashboard/assignments", M, { assignedTo: R, title: `${PREFIX}pigeon`, channels: ["pigeon"] });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /dashboard/summary and the Pending list agree", () => {
  it("counts exactly what this viewer's lists show, and the open-tasks row carries the progress and who reported it", async () => {
    const sql = getServiceSql();
    // Eli's own world: one task never started, one in progress at a self-reported 60%, one blocked, one done today.
    const t = async (title: string, status: string) =>
      (await sql<{ id: string }[]>`insert into task (employee_id, title, status, is_synthetic) values (${E}, ${PREFIX + title}, ${status}, true) returning id`)[0]!.id;
    await t("not started", "open");
    const going = await t("going", "in_progress");
    await sql`update task set progress_pct = 60, progress_source = 'self_reported', progress_note = 'two of three vans', progress_updated_at = now() where id = ${going}`;
    await sql`insert into progress_event (task_id, employee_id, pct, source, note) values (${going}, ${E}, 60, 'self_reported', 'two of three vans')`;
    const stuck = await t("stuck", "pending");
    const [u] = await sql<{ id: string }[]>`insert into task_update (task_id, employee_id, status, note_raw, is_synthetic) values (${stuck}, ${E}, 'blocker', 'pump broken', true) returning id`;
    await sql`insert into blocker (task_update_id, raised_by, category, severity, status, is_synthetic) values (${u!.id}, ${E}, 'equipment', 'high', 'open', true)`;
    const fin = await t("finished", "done");
    await sql`insert into task_update (task_id, employee_id, status, is_synthetic) values (${fin}, ${E}, 'done', true)`;

    const s = (await get("/dashboard/summary", E)).json() as Record<string, number>;
    expect(s).toMatchObject({ open_tasks: 3, in_progress: 2, not_started: 1, blocked_tasks: 1, completed: 1, open_blockers: 1, urgent_blockers: 1 });

    const open = (await get("/dashboard/open-tasks", E)).json() as { id: string; task_number: string; progress_pct: number; progress_source: string; progress_by: string; progress_note: string; open_blockers: number }[];
    expect(open).toHaveLength(3);
    const g = open.find((o) => o.id === going)!;
    expect(g).toMatchObject({ progress_pct: 60, progress_source: "self_reported", progress_by: `${PREFIX}Eli`, progress_note: "two of three vans" });
    expect(g.task_number).toMatch(/^\d+$/);
    expect(open.find((o) => o.id === stuck)!.open_blockers).toBe(1);
  });
});
