import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, DEMO_CEO_ID, getServiceSql } from "@freshnow/core";
import { buildServer } from "./server.js";

/**
 * The alert routes over HTTP: the in-app inbox is the viewer's own and nobody else's;
 * an assignment made through the UI lands in the assignee's inbox with the reason; a
 * person changes only their own rules; watching a task is self-service; the ladder and
 * the SLA table read back as configuration.
 */

const app = buildServer(false);
const MGR = randomUUID();
const WORKER = randomUUID();
const STRANGER = randomUUID();

beforeAll(async () => {
  const sql = getServiceSql();
  await sql`insert into employee (id, display_name, status, is_synthetic, access_role, department, telegram_user_id) values
    (${MGR}, 'ALR-Mgr', 'active', true, 'manager', 'production', 9_700_000_000_001),
    (${STRANGER}, 'ALR-Stranger', 'active', true, 'employee', 'delivery', 9_700_000_000_003)`;
  await sql`insert into employee (id, display_name, status, is_synthetic, access_role, department, manager_employee_id, telegram_user_id) values
    (${WORKER}, 'ALR-Worker', 'active', true, 'employee', 'production', ${MGR}, 9_700_000_000_002)`;
});

afterAll(async () => {
  const sql = getServiceSql();
  const ids = [MGR, WORKER, STRANGER];
  await sql`delete from notification_outbox where recipient_employee_id = any(${ids})`;
  await sql`delete from assignment where assigned_to = any(${ids})`;
  await sql`delete from task_update where employee_id = any(${ids})`;
  await sql`delete from task where employee_id = any(${ids})`;
  await sql`delete from notification_pref where employee_id = any(${ids})`;
  await sql`delete from audit_log where actor = any(${ids.map((i) => `employee:${i}`)})`;
  await sql`delete from employee where id = any(${ids})`;
  await app.close();
  await closeDb();
});

const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) =>
  app.inject({ method, url, ...(payload ? { payload } : {}) });

interface Inbox { unread: number; items: { id: string; reason: string | null; text: string; kind: string | null; readAt: string | null }[] }

describe("the inbox", () => {
  it("an assignment from the UI lands in the assignee's inbox with the reason; the manager and a stranger see nothing of it", async () => {
    const r = await call("POST", `/dashboard/assignments?viewer=${MGR}`, { assignedTo: WORKER, title: "ALR count the crates" });
    expect(r.statusCode).toBe(201);

    const mine = (await call("GET", `/dashboard/notifications?viewer=${WORKER}`)).json() as Inbox;
    expect(mine.unread).toBeGreaterThanOrEqual(1);
    const item = mine.items.find((i) => i.text.includes("ALR count the crates"));
    expect(item).toMatchObject({ kind: "task.assigned", reason: "assignee", readAt: null });
    expect(item?.text).toContain("New task from ALR-Mgr");

    const theirs = (await call("GET", `/dashboard/notifications?viewer=${STRANGER}`)).json() as Inbox;
    expect(theirs.items.some((i) => i.text.includes("ALR count the crates"))).toBe(false);
    const mgr = (await call("GET", `/dashboard/notifications?viewer=${MGR}`)).json() as Inbox;
    expect(mgr.items.some((i) => i.text.includes("ALR count the crates"))).toBe(false);
  });

  it("marking read moves only the viewer's own rows; a stranger cannot mark them", async () => {
    const mine = (await call("GET", `/dashboard/notifications?viewer=${WORKER}&unread=1`)).json() as Inbox;
    const id = mine.items[0]!.id;
    const byStranger = (await call("POST", `/dashboard/notifications/read?viewer=${STRANGER}`, { ids: [id] })).json() as { marked: number };
    expect(byStranger.marked).toBe(0);
    const byMe = (await call("POST", `/dashboard/notifications/read?viewer=${WORKER}`, { ids: [id] })).json() as { marked: number };
    expect(byMe.marked).toBe(1);
    const after = (await call("GET", `/dashboard/notifications?viewer=${WORKER}&unread=1`)).json() as Inbox;
    expect(after.items.some((i) => i.id === id)).toBe(false);
  });

  it("a finished task tells the person who assigned it", async () => {
    const r = (await call("POST", `/dashboard/assignments?viewer=${MGR}`, { assignedTo: WORKER, title: "ALR wash the filler" })).json() as { taskId: string };
    const done = await call("POST", `/dashboard/task-updates?viewer=${WORKER}`, { taskId: r.taskId, status: "done", note: "all clean" });
    expect(done.statusCode).toBe(201);
    const mgr = (await call("GET", `/dashboard/notifications?viewer=${MGR}`)).json() as Inbox;
    const item = mgr.items.find((i) => i.text.includes("ALR wash the filler"));
    expect(item).toMatchObject({ kind: "task.done", reason: "assigned it" });
    expect(item?.text).toContain("ALR-Worker finished");
  });
});

describe("a person's own rules", () => {
  it("are set and read back for the viewer only, and validated", async () => {
    const bad = await call("PUT", `/dashboard/me/notification-prefs?viewer=${WORKER}`, { eventType: "nope", channel: "telegram", mode: "off" });
    expect(bad.statusCode).toBe(400);
    const ok = await call("PUT", `/dashboard/me/notification-prefs?viewer=${WORKER}`, { eventType: "task.assigned", channel: "telegram", mode: "immediate", delayMinutes: 15 });
    expect(ok.statusCode).toBe(200);
    const mine = (await call("GET", `/dashboard/me/notification-prefs?viewer=${WORKER}`)).json() as { prefs: { eventType: string; channel: string; mode: string; delayMinutes: number }[] };
    expect(mine.prefs).toEqual([{ eventType: "task.assigned", channel: "telegram", mode: "immediate", delayMinutes: 15 }]);
    const theirs = (await call("GET", `/dashboard/me/notification-prefs?viewer=${STRANGER}`)).json() as { prefs: unknown[] };
    expect(theirs.prefs).toEqual([]);

    // The rule is honoured on the next assignment: the Telegram row is held 15 minutes.
    const r = (await call("POST", `/dashboard/assignments?viewer=${MGR}`, { assignedTo: WORKER, title: "ALR delayed" })).json() as { assignmentId: string };
    const sql = getServiceSql();
    const row = await sql<{ held: boolean }[]>`
      select next_attempt_at > now() + interval '14 minutes' as held from notification_outbox
      where idempotency_key = ${`task.assigned:${r.assignmentId}:${WORKER}:telegram`}`;
    expect(row[0]?.held).toBe(true);
  });
});

describe("watching and configuration", () => {
  it("a person watches a task they can see, not one they cannot; watchers read back", async () => {
    const t = (await call("POST", `/dashboard/tasks?viewer=${WORKER}`, { title: "ALR watched" })).json() as { taskId: string };
    expect((await call("POST", `/dashboard/tasks/${t.taskId}/watch?viewer=${STRANGER}`)).statusCode).toBe(403);
    expect((await call("POST", `/dashboard/tasks/${t.taskId}/watch?viewer=${MGR}`)).statusCode).toBe(200);
    const w = (await call("GET", `/dashboard/tasks/${t.taskId}/watchers?viewer=${WORKER}`)).json() as { name: string; me: boolean }[];
    expect(w.map((x) => x.name)).toEqual(["ALR-Mgr"]);
    expect((await call("DELETE", `/dashboard/tasks/${t.taskId}/watch?viewer=${MGR}`)).statusCode).toBe(200);
    const after = (await call("GET", `/dashboard/tasks/${t.taskId}/watchers?viewer=${WORKER}`)).json() as unknown[];
    expect(after).toEqual([]);
  });

  it("the ladder and the SLA table read back as seeded", async () => {
    const ladder = (await call("GET", `/dashboard/escalation-policy?viewer=${WORKER}`)).json() as { level: number; afterMinutes: number; targets: string[] }[];
    expect(ladder).toEqual([
      { level: 1, afterMinutes: 0, targets: ["resolver", "manager_of_raiser"] },
      { level: 2, afterMinutes: 30, targets: ["ceo"] },
      { level: 3, afterMinutes: 60, targets: ["ceo"] },
    ]);
    const sla = (await call("GET", `/dashboard/sla-policy?viewer=ceo`)).json() as { severity: string; minutes: number }[];
    expect(sla).toEqual([
      { severity: "critical", minutes: 15 },
      { severity: "high", minutes: 60 },
      { severity: "medium", minutes: 240 },
      { severity: "low", minutes: 1440 },
    ]);
    expect(DEMO_CEO_ID).toBeTruthy();
  });
});

describe("channel switches", () => {
  type State = { channel: string; available: boolean; enabled: boolean; live: boolean; why: string };

  it("anyone may read the channel list, so the UI can explain itself", async () => {
    const r = await app.inject({ method: "GET", url: `/dashboard/channels?viewer=${WORKER}` });
    expect(r.statusCode).toBe(200);
    const { channels } = r.json() as { channels: State[] };
    expect(channels.map((c) => c.channel).sort()).toEqual(["chat", "email", "inapp", "telegram", "webpush"]);
    // A channel that is not live says WHICH gate is shut — that sentence is the whole point.
    const chat = channels.find((c) => c.channel === "chat")!;
    expect(chat.live).toBe(false);
    expect(chat.why.length).toBeGreaterThan(0);
  });

  it("only the CEO may flip one", async () => {
    const denied = await app.inject({ method: "PUT", url: `/dashboard/channels?viewer=${WORKER}`, payload: { channel: "email", enabled: true } });
    expect(denied.statusCode).toBe(403);

    const ok = await app.inject({ method: "PUT", url: "/dashboard/channels?viewer=ceo", payload: { channel: "email", enabled: true } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ channel: "email", enabled: true });

    // Switched on but with no SMTP host configured, it is still not live.
    expect((ok.json() as State).live).toBe(false);

    await app.inject({ method: "PUT", url: "/dashboard/channels?viewer=ceo", payload: { channel: "email", enabled: false } });
  });

  it("refuses a channel nobody has heard of", async () => {
    const r = await app.inject({ method: "PUT", url: "/dashboard/channels?viewer=ceo", payload: { channel: "smoke-signal", enabled: true } });
    expect(r.statusCode).toBe(400);
  });
});
