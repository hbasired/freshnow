import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  addTaskWatcher,
  blockerAlias,
  mayAcknowledgeBlocker,
  notify,
  openAlert,
  resolveAlertRecipients,
  setNotificationPref,
} from "./alerts.js";
import { closeDb, getServiceSql, withContext } from "./db.js";
import { DEMO_CEO_ID } from "./meta.js";
import { resolveBlocker } from "./progress.js";
import { acknowledgeBlocker, routeAndAlert } from "./routing.js";

/**
 * Every recipient is a rule. These tests take each rule on its own — who is named, on
 * which channel, and why — the way the routing tests take each routing rule, because a
 * wrong answer here is somebody not told about a broken chiller.
 */
const CORR = "a1e47000-0000-4000-8000-00000000a1e7";
const TAG = "ALERTTEST";

async function person(p: { name: string; telegram?: number | null; manager?: string | null; department?: string | null; role?: string }): Promise<string> {
  const id = randomUUID();
  const sql = getServiceSql();
  await sql`insert into employee (id, display_name, status, telegram_user_id, manager_employee_id, department, access_role, is_synthetic)
            values (${id}, ${`${TAG} ${p.name}`}, 'active', ${p.telegram === undefined ? 9_600_000_000_000 + Math.floor(Math.random() * 1e6) : p.telegram},
                    ${p.manager ?? null}, ${p.department ?? null}, ${p.role ?? "employee"}, true)`;
  return id;
}

async function blocker(p: { raisedBy: string; resolver?: string | null; taskId?: string | null; category?: string; asset?: string | null }): Promise<string> {
  const sql = getServiceSql();
  const id = randomUUID();
  let updateId: string | null = null;
  if (p.taskId) {
    const u = await sql<{ id: string }[]>`
      insert into task_update (task_id, employee_id, status, note_raw, channel, correlation_id, is_synthetic)
      values (${p.taskId}, ${p.raisedBy}, 'blocker', 'test', 'telegram', ${CORR}, true) returning id`;
    updateId = u[0]!.id;
  }
  await sql`insert into blocker (id, task_update_id, raised_by, assigned_resolver, category, severity, status, affected_asset, correlation_id, is_synthetic)
            values (${id}, ${updateId}, ${p.raisedBy}, ${p.resolver ?? null}, ${p.category ?? "equipment"}, 'high', 'open', ${p.asset ?? null}, ${CORR}, true)`;
  return id;
}

async function task(owner: string): Promise<string> {
  const sql = getServiceSql();
  const rows = await sql<{ id: string }[]>`
    insert into task (employee_id, title, status, is_synthetic) values (${owner}, ${`${TAG} task`}, 'open', true) returning id`;
  return rows[0]!.id;
}

afterEach(async () => {
  const sql = getServiceSql();
  const tag = `${TAG} %`;
  await sql`delete from notification_outbox
            where recipient_employee_id in (select id from employee where display_name like ${tag})
               or idempotency_key in (
                 select 'blocker.raised:' || b.id::text || ':' || ${DEMO_CEO_ID} || ':' || c.ch
                 from blocker b, (values ('telegram'), ('inapp')) as c(ch) where b.correlation_id = ${CORR})`;
  await sql`delete from escalation where blocker_id in (select id from blocker where correlation_id = ${CORR})`;
  await sql`delete from blocker where correlation_id = ${CORR}`;
  await sql`delete from alert where correlation_id = ${CORR} or alias like 'alerttest:%'`;
  await sql`delete from task_update where correlation_id = ${CORR}`;
  await sql`delete from task where title = ${`${TAG} task`}`;
  await sql`delete from notification_pref where employee_id in (select id from employee where display_name like ${tag})`;
  await sql`delete from employee where display_name like ${`${TAG} %`}`;
  await sql`delete from audit_log where correlation_id = ${CORR}`;
});
afterAll(async () => {
  await closeDb();
});

describe("who is told (one rule at a time)", () => {
  it("blocker.raised → the resolver, on Telegram and in-app by default", async () => {
    const raiser = await person({ name: "raiser" });
    const resolver = await person({ name: "resolver" });
    const b = await blocker({ raisedBy: raiser, resolver });
    const r = await resolveAlertRecipients({ type: "blocker.raised", blockerId: b });
    expect(r.map((x) => [x.employeeId, x.channel, x.reason])).toEqual([
      [resolver, "telegram", "resolver"],
      [resolver, "inapp", "resolver"],
    ]);
  });

  it("blocker.raised → watchers of the task too, but never the raiser", async () => {
    const raiser = await person({ name: "raiser" });
    const resolver = await person({ name: "resolver" });
    const watcher = await person({ name: "watcher" });
    const t = await task(raiser);
    await addTaskWatcher({ taskId: t, employeeId: watcher });
    await addTaskWatcher({ taskId: t, employeeId: raiser }); // watching your own task tells you nothing new
    const b = await blocker({ raisedBy: raiser, resolver, taskId: t });
    const r = await resolveAlertRecipients({ type: "blocker.raised", blockerId: b });
    const people = [...new Set(r.map((x) => x.employeeId))];
    expect(people).toEqual([resolver, watcher]);
    expect(r.find((x) => x.employeeId === watcher)?.reason).toBe("watcher of the task");
  });

  it("no Telegram link → in-app only; disabled → nobody", async () => {
    const raiser = await person({ name: "raiser" });
    const unlinked = await person({ name: "unlinked", telegram: null });
    const b = await blocker({ raisedBy: raiser, resolver: unlinked });
    const r = await resolveAlertRecipients({ type: "blocker.raised", blockerId: b });
    expect(r.map((x) => x.channel)).toEqual(["inapp"]);

    await getServiceSql()`update employee set status = 'disabled' where id = ${unlinked}`;
    expect(await resolveAlertRecipients({ type: "blocker.raised", blockerId: b })).toEqual([]);
  });

  it("blocker.escalated L1 → resolver and the raiser's manager; L2 → the CEO", async () => {
    const manager = await person({ name: "manager", role: "manager" });
    const raiser = await person({ name: "raiser", manager });
    const resolver = await person({ name: "resolver" });
    const b = await blocker({ raisedBy: raiser, resolver });
    const l1 = await resolveAlertRecipients({ type: "blocker.escalated", blockerId: b, level: 1 });
    expect([...new Set(l1.map((x) => x.employeeId))]).toEqual([resolver, manager]);
    expect(l1.find((x) => x.employeeId === manager)?.reason).toBe("escalation level 1 → manager of raiser");
    expect(l1.every((x) => x.ruleId)).toBe(true); // every level recipient names its escalation_target row

    const l2 = await resolveAlertRecipients({ type: "blocker.escalated", blockerId: b, level: 2 });
    expect([...new Set(l2.map((x) => x.employeeId))]).toEqual([DEMO_CEO_ID]);
    expect(await resolveAlertRecipients({ type: "blocker.escalated", blockerId: b, level: 9 })).toEqual([]);
  });

  it("the same person named by two rules is told once", async () => {
    const manager = await person({ name: "manager", role: "manager" });
    const raiser = await person({ name: "raiser", manager });
    const b = await blocker({ raisedBy: raiser, resolver: manager }); // resolver AND manager
    const l1 = await resolveAlertRecipients({ type: "blocker.escalated", blockerId: b, level: 1 });
    expect(l1.map((x) => x.employeeId)).toEqual([manager, manager]); // two channels, one person
    expect(l1[0]?.reason).toBe("escalation level 1 → resolver");
  });

  it("blocker.resolved → the raiser, not the person who resolved it", async () => {
    const raiser = await person({ name: "raiser" });
    const resolver = await person({ name: "resolver" });
    const b = await blocker({ raisedBy: raiser, resolver });
    const r = await resolveAlertRecipients({ type: "blocker.resolved", blockerId: b, resolvedBy: resolver });
    expect([...new Set(r.map((x) => x.employeeId))]).toEqual([raiser]);
    const self = await resolveAlertRecipients({ type: "blocker.resolved", blockerId: b, resolvedBy: raiser });
    expect([...new Set(self.map((x) => x.employeeId))]).toEqual([resolver]);
  });

  it("task.done → whoever assigned it and the watchers, not the reporter", async () => {
    const boss = await person({ name: "boss", role: "manager" });
    const worker = await person({ name: "worker", manager: boss });
    const watcher = await person({ name: "watcher" });
    const t = await task(worker);
    const sql = getServiceSql();
    await sql`insert into assignment (task_id, assigned_by, assigned_to, status, is_synthetic) values (${t}, ${boss}, ${worker}, 'assigned', true)`;
    await addTaskWatcher({ taskId: t, employeeId: watcher });
    const r = await resolveAlertRecipients({ type: "task.done", taskId: t, employeeId: worker });
    expect([...new Set(r.map((x) => x.employeeId))]).toEqual([boss, watcher]);
    expect(r.find((x) => x.employeeId === boss)?.reason).toBe("assigned it");
    await sql`delete from assignment where task_id = ${t}`;
  });
});

describe("how they are told (a person's own rules)", () => {
  it("Telegram off → in-app only; a delay is carried onto the row", async () => {
    const raiser = await person({ name: "raiser" });
    const resolver = await person({ name: "resolver" });
    const b = await blocker({ raisedBy: raiser, resolver });
    await setNotificationPref({ employeeId: resolver, eventType: "blocker.raised", channel: "telegram", mode: "off" });
    let r = await resolveAlertRecipients({ type: "blocker.raised", blockerId: b });
    expect(r.map((x) => x.channel)).toEqual(["inapp"]);

    await setNotificationPref({ employeeId: resolver, eventType: "blocker.raised", channel: "telegram", mode: "immediate", delayMinutes: 10 });
    r = await resolveAlertRecipients({ type: "blocker.raised", blockerId: b });
    const tg = r.find((x) => x.channel === "telegram");
    expect(tg?.delayMinutes).toBe(10);

    const sent = await notify({ type: "blocker.raised", blockerId: b }, { text: "t", correlationId: CORR });
    expect(sent.enqueued).toBe(2);
    const sql = getServiceSql();
    const row = await sql<{ due: boolean; reason: string }[]>`
      select next_attempt_at > now() + interval '9 minutes' as due, reason from notification_outbox
      where idempotency_key = ${`blocker.raised:${b}:${resolver}:telegram`}`;
    expect(row[0]?.due).toBe(true);
    expect(row[0]?.reason).toBe("resolver");
  });

  it("email is opt-in and produces nothing until the channel is switched on", async () => {
    const raiser = await person({ name: "raiser" });
    const resolver = await person({ name: "resolver" });
    const b = await blocker({ raisedBy: raiser, resolver });
    await setNotificationPref({ employeeId: resolver, eventType: "blocker.raised", channel: "email", mode: "immediate" });
    const r = await resolveAlertRecipients({ type: "blocker.raised", blockerId: b });
    expect(r.map((x) => x.channel).sort()).toEqual(["inapp", "telegram"]);
  });

  it("sending twice enqueues nothing twice, and the audit row names every recipient and rule", async () => {
    const raiser = await person({ name: "raiser" });
    const resolver = await person({ name: "resolver" });
    const b = await blocker({ raisedBy: raiser, resolver });
    const a = await notify({ type: "blocker.raised", blockerId: b }, { text: "t", correlationId: CORR });
    const again = await notify({ type: "blocker.raised", blockerId: b }, { text: "t", correlationId: CORR });
    expect(a.enqueued).toBe(2);
    expect(again.enqueued).toBe(0);
    const sql = getServiceSql();
    const audit = await sql<{ detail: { recipients: { employeeId: string; channel: string; reason: string }[] } }[]>`
      select detail from audit_log where correlation_id = ${CORR} and action = 'alert.enqueued' order by created_at limit 1`;
    expect(audit[0]?.detail.recipients).toEqual([
      { employeeId: resolver, channel: "telegram", reason: "resolver", ruleId: null, delayMinutes: 0 },
      { employeeId: resolver, channel: "inapp", reason: "resolver", ruleId: null, delayMinutes: 0 },
    ]);
  });
});

describe("one alert per problem", () => {
  it("the alias is the person, category and asset — or the blocker alone without an asset", () => {
    expect(blockerAlias({ id: "b1", raised_by: "p", category: "equipment", affected_asset: "  Chiller  Van 2 " })).toBe("blocker:p:equipment:chiller van 2");
    expect(blockerAlias({ id: "b1", raised_by: "p", category: "equipment", affected_asset: null })).toBe("blocker:b1");
  });

  it("a repeat while the first is open is counted, not paged; a retry of the same blocker is not counted", async () => {
    const first = await openAlert({ alias: "alerttest:x", kind: "blocker", entity: "blocker", entityId: "one", employeeId: null, correlationId: CORR });
    const retry = await openAlert({ alias: "alerttest:x", kind: "blocker", entity: "blocker", entityId: "one", employeeId: null, correlationId: CORR });
    const second = await openAlert({ alias: "alerttest:x", kind: "blocker", entity: "blocker", entityId: "two", employeeId: null, correlationId: CORR });
    expect(first.isNew).toBe(true);
    expect(retry).toMatchObject({ alertId: first.alertId, count: 1, isNew: false });
    expect(second).toMatchObject({ alertId: first.alertId, count: 2, isNew: false });

    const sql = getServiceSql();
    await sql`update alert set state = 'resolved', resolved_at = now() where id = ${first.alertId}`;
    const fresh = await openAlert({ alias: "alerttest:x", kind: "blocker", entity: "blocker", entityId: "three", employeeId: null, correlationId: CORR });
    expect(fresh.isNew).toBe(true); // once resolved, the next report is a new problem
  });

  it("the same asset reported twice pages once, and one acknowledgement covers both", async () => {
    const raiser = await person({ name: "raiser" });
    const b1 = await blocker({ raisedBy: raiser, asset: "Chiller 2" });
    const b2 = await blocker({ raisedBy: raiser, asset: "chiller 2" });
    const r1 = await routeAndAlert(b1, CORR);
    const r2 = await routeAndAlert(b2, CORR);
    expect(r1.deduplicated).toBe(false);
    expect(r2).toMatchObject({ alerted: false, deduplicated: true, alertCount: 2 });

    await acknowledgeBlocker(b1, CORR, { by: DEMO_CEO_ID });
    const sql = getServiceSql();
    const rows = await sql<{ id: string; status: string }[]>`select id, status from blocker where id in (${b1}, ${b2})`;
    expect(rows.map((r) => r.status)).toEqual(["acknowledged", "acknowledged"]);
    const alert = await sql<{ state: string; acked_by: string }[]>`select state, acked_by from alert where id = (select alert_id from blocker where id = ${b1})`;
    expect(alert[0]).toMatchObject({ state: "acknowledged", acked_by: DEMO_CEO_ID });
  });

  it("resolving the last live blocker resolves the alert and tells the raiser", async () => {
    const raiser = await person({ name: "raiser" });
    const b = await blocker({ raisedBy: raiser, asset: "Filler" });
    await routeAndAlert(b, CORR);
    await resolveBlocker({ blockerId: b, resolvedBy: DEMO_CEO_ID, note: "Replaced the seal", correlationId: CORR });
    const sql = getServiceSql();
    const alert = await sql<{ state: string }[]>`select state from alert where id = (select alert_id from blocker where id = ${b})`;
    expect(alert[0]?.state).toBe("resolved");
    const told = await sql<{ channel: string; reason: string }[]>`
      select channel, reason from notification_outbox where idempotency_key like ${`blocker.resolved:${b}:${raiser}:%`} order by channel`;
    expect(told.map((t) => [t.channel, t.reason])).toEqual([["inapp", "raised it"], ["telegram", "raised it"]]);
  });
});

describe("who may acknowledge", () => {
  it("the CEO, the resolver, or the raiser's manager — not the raiser, not a stranger", async () => {
    const manager = await person({ name: "manager", role: "manager" });
    const raiser = await person({ name: "raiser", manager });
    const resolver = await person({ name: "resolver" });
    const stranger = await person({ name: "stranger" });
    const b = await blocker({ raisedBy: raiser, resolver });
    expect(await mayAcknowledgeBlocker(DEMO_CEO_ID, b)).toBe(true);
    expect(await mayAcknowledgeBlocker(resolver, b)).toBe(true);
    expect(await mayAcknowledgeBlocker(manager, b)).toBe(true);
    expect(await mayAcknowledgeBlocker(raiser, b)).toBe(false);
    expect(await mayAcknowledgeBlocker(stranger, b)).toBe(false);
  });
});

describe("row-level security on the new tables", () => {
  it("a person reads their own inbox and alerts about their own reports; a stranger reads neither", async () => {
    const raiser = await person({ name: "raiser" });
    const resolver = await person({ name: "resolver" });
    const stranger = await person({ name: "stranger" });
    const b = await blocker({ raisedBy: raiser, resolver });
    await notify({ type: "blocker.raised", blockerId: b }, { text: "t", correlationId: CORR });
    await openAlert({ alias: `alerttest:${b}`, kind: "blocker", entity: "blocker", entityId: b, employeeId: raiser, correlationId: CORR });

    const asResolver = await withContext({ employeeId: resolver, isCeo: false }, (sql) => sql`select 1 from notification_outbox where recipient_employee_id = ${resolver}`);
    expect(asResolver.length).toBeGreaterThan(0);
    const asStranger = await withContext({ employeeId: stranger, isCeo: false }, (sql) => sql`select 1 from notification_outbox where recipient_employee_id = ${resolver}`);
    expect(asStranger.length).toBe(0);

    const ownAlert = await withContext({ employeeId: raiser, isCeo: false }, (sql) => sql`select 1 from alert where entity_id = ${b}`);
    expect(ownAlert.length).toBe(1);
    const strangerAlert = await withContext({ employeeId: stranger, isCeo: false }, (sql) => sql`select 1 from alert where entity_id = ${b}`);
    expect(strangerAlert.length).toBe(0);
    const ceoAlert = await withContext({ employeeId: DEMO_CEO_ID, isCeo: true }, (sql) => sql`select 1 from alert where entity_id = ${b}`);
    expect(ceoAlert.length).toBe(1);
  });
});
