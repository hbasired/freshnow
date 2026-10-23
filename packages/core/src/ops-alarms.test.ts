import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getServiceSql, withContext } from "./db.js";
import { DEMO_CEO_ID } from "./meta.js";
import { alarmDecision, alarmsNow, OpsRefused, SYSTEM_ACTOR_ID, syncMachineAlarms, UNCLASSIFIED } from "./ops-alarms.js";
import { loadViewer, type ViewerOrg } from "./org.js";

/**
 * Machine alarms → problems (TASK-059) — against the real (throwaway) Postgres, never mocked. The
 * clock is fixed in Nov 2023 so no other test's Televend rows fall in the window; every outcome is
 * worked out by hand from the rows inserted below.
 *
 *   machine 990601 "Test Metro-601-DXB"   Product level low ×2 (repeat), open since 2 h   → ONE problem
 *                                          Cashless device, open 10 min                      → waits (noise, 30-min on-delay)
 *   machine 990602 "Test Mall-602-SHJ"    Cashless device, open 40 min                      → a problem (outlasted its on-delay)
 *                                          "Martian landing", open 45 min                    → a problem (unclassified: 30 min)
 *                                          Connection lost, opened 2 h ago, resolved 1 h ago  → ignored
 */
const NOW = new Date("2023-11-20T12:00:00+04:00");
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const TAG = `ALARM-${randomUUID().slice(0, 6)}`;
const SUP = randomUUID();
const VMO = randomUUID();
const M1 = 990601;
const M2 = 990602;
let sup: ViewerOrg;
let vmo: ViewerOrg;
const saved = process.env.OPS_ALARM_PROBLEMS;
const sql = () => getServiceSql();

async function event(id: string, machine: number, name: string, startedMinsAgo: number, resolvedMinsAgo: number | null = null) {
  await sql()`
    insert into tv_event (source, external_id, machine_tv_id, level, kind, name, started_at, resolved_at, raw, is_synthetic)
    values ('bridge', ${`${TAG}-${id}`}, ${machine}, 3, 'alarm', ${name}, ${minsAgo(startedMinsAgo)},
            ${resolvedMinsAgo === null ? null : minsAgo(resolvedMinsAgo)}, '{}'::jsonb, true)`;
}

beforeAll(async () => {
  const s = sql();
  await s`insert into employee (id, display_name, status, is_synthetic, access_role, manager_employee_id)
          values (${SUP}, ${`${TAG} Sup`}, 'active', true, 'supervisor', ${DEMO_CEO_ID}),
                 (${VMO}, ${`${TAG} Vmo`}, 'active', true, 'vmo', ${DEMO_CEO_ID})`;
  sup = (await loadViewer(SUP))!;
  vmo = (await loadViewer(VMO))!;
  for (const [id, caption] of [[M1, "Test Metro-601-DXB"], [M2, "Test Mall-602-SHJ"]] as const) {
    await s`insert into tv_machine (televend_id, caption, asset_no, enabled, raw, is_synthetic)
            values (${id}, ${caption}, ${id - 990000}, true, '{}'::jsonb, true)`;
  }
  await event("p1", M1, "Product level low", 120);
  await event("p2", M1, "Product level low", 90);
  await event("c1", M1, "Cashless device", 10);
  await event("c2", M2, "Cashless device", 40);
  await event("x1", M2, "Martian landing", 45);
  await event("r1", M2, "Connection lost", 120, 60);
});

afterAll(async () => {
  const s = sql();
  const blockers = (await s<{ id: string }[]>`select blocker_id as id from machine_alarm where event_id like ${`${TAG}-%`} and blocker_id is not null`).map((r) => r.id);
  await s`delete from machine_alarm where event_id like ${`${TAG}-%`}`;
  if (blockers.length > 0) {
    await s`delete from notification_outbox where payload->>'blockerId' = any(${blockers})`;
    await s`update blocker set alert_id = null where id = any(${blockers})`;
    await s`delete from alert where entity = 'blocker' and entity_id = any(${blockers})`;
    await s`delete from escalation where blocker_id = any(${blockers})`;
    await s`delete from blocker where id = any(${blockers})`;
  }
  await s`delete from tv_event where external_id like ${`${TAG}-%`}`;
  await s`delete from tv_machine where televend_id in (${M1}, ${M2})`;
  await s`delete from employee where id in (${SUP}, ${VMO})`;
  if (saved === undefined) delete process.env.OPS_ALARM_PROBLEMS;
  else process.env.OPS_ALARM_PROBLEMS = saved;
  await closeDb();
});

describe("which alarms need someone — a rule and the clock, nothing else", () => {
  it("waits out the on-delay, then raises; a cleared alarm or an info rule never does", () => {
    const actionable = { class: "actionable" as const, onDelayMinutes: 15 };
    expect(alarmDecision(actionable, { startedAt: minsAgo(14), resolvedAt: null }, NOW)).toBe("wait");
    expect(alarmDecision(actionable, { startedAt: minsAgo(15), resolvedAt: null }, NOW)).toBe("raise");
    expect(alarmDecision(actionable, { startedAt: minsAgo(60), resolvedAt: minsAgo(30) }, NOW)).toBe("ignore");
    expect(alarmDecision({ class: "info", onDelayMinutes: 0 }, { startedAt: minsAgo(600), resolvedAt: null }, NOW)).toBe("ignore");
    // Noise is a problem too once it outlasts its on-delay — it is the blip that clears itself that is not.
    expect(alarmDecision({ class: "noise", onDelayMinutes: 30 }, { startedAt: minsAgo(31), resolvedAt: null }, NOW)).toBe("raise");
  });

  it("an alarm nobody has classified needs someone after 30 minutes — hiding it would be the worse failure", () => {
    expect(UNCLASSIFIED).toMatchObject({ class: "actionable", onDelayMinutes: 30 });
    expect(alarmDecision(undefined, { startedAt: minsAgo(29), resolvedAt: null }, NOW)).toBe("wait");
    expect(alarmDecision(undefined, { startedAt: minsAgo(30), resolvedAt: null }, NOW)).toBe("raise");
  });
});

describe("alarms become problems — only when switched on", () => {
  it("off: nothing is raised, and the switch says so", async () => {
    process.env.OPS_ALARM_PROBLEMS = "off";
    expect(await syncMachineAlarms({ now: NOW })).toMatchObject({ enabled: false, raised: 0 });
    expect((await sql()`select 1 from machine_alarm where event_id like ${`${TAG}-%`}`).length).toBe(0);
  });

  it("on: one problem per machine and alarm, routed; repeats join it; blips wait; the cleared one is left alone", async () => {
    process.env.OPS_ALARM_PROBLEMS = "on";
    const r = await syncMachineAlarms({ now: NOW });
    // Product level low (M1), Cashless device (M2), Martian landing (M2): three problems; p2 joins p1's.
    expect(r).toMatchObject({ enabled: true, raised: 3, joined: 1, waiting: 1, unrouted: 0 });
    const rows = await sql()<{ event_id: string; blocker_id: string | null; category: string; severity: string; raised_by: string; assigned_resolver: string | null; sla_due_at: Date | null }[]>`
      select ma.event_id, ma.blocker_id, b.category, b.severity, b.raised_by, b.assigned_resolver, b.sla_due_at
        from machine_alarm ma join blocker b on b.id = ma.blocker_id where ma.event_id like ${`${TAG}-%`} order by ma.event_id`;
    const by = Object.fromEntries(rows.map((x) => [x.event_id.replace(`${TAG}-`, ""), x]));
    expect(Object.keys(by).sort()).toEqual(["c2", "p1", "p2", "x1"]);
    expect(by.p1!.blocker_id).toBe(by.p2!.blocker_id);
    expect(by.p1).toMatchObject({ category: "stock", severity: "high", raised_by: SYSTEM_ACTOR_ID, assigned_resolver: DEMO_CEO_ID });
    expect(by.p1!.sla_due_at).not.toBeNull();
    expect(by.c2).toMatchObject({ category: "equipment", severity: "medium" });
    expect(by.x1).toMatchObject({ category: "equipment", severity: "medium" }); // unclassified → the default rule
    const [blocker] = await sql()<{ affected_asset: string; risk: string }[]>`select affected_asset, risk from blocker where id = ${by.p1!.blocker_id}`;
    expect(blocker).toMatchObject({ affected_asset: "Test Metro-601-DXB" });
    expect(blocker!.risk).toMatch(/^Product level low: /);
  });

  it("running again changes nothing", async () => {
    const before = (await sql()<{ n: number }[]>`select count(*)::int as n from blocker where raised_by = ${SYSTEM_ACTOR_ID}`)[0]!.n;
    const r = await syncMachineAlarms({ now: NOW });
    expect(r).toMatchObject({ raised: 0, joined: 0 });
    expect((await sql()<{ n: number }[]>`select count(*)::int as n from blocker where raised_by = ${SYSTEM_ACTOR_ID}`)[0]!.n).toBe(before);
  });

  it("the people who run the machines see the problems and the list; a VMO sees neither", async () => {
    const list = await alarmsNow(sup, NOW);
    const mine = list.needsAction.filter((a) => a.machineTvId === M1 || a.machineTvId === M2);
    expect(mine.map((a) => a.alarm).sort()).toEqual(["Cashless device", "Martian landing", "Product level low"]);
    const low = mine.find((a) => a.alarm === "Product level low")!;
    expect(low).toMatchObject({ assetNo: 601, severity: "high", repeats: 2, classified: true });
    expect(low.problem).toMatchObject({ status: "open" });
    expect(mine.find((a) => a.alarm === "Martian landing")!.classified).toBe(false);
    // Most severe first.
    expect(mine[0]!.alarm).toBe("Product level low");
    await expect(alarmsNow(vmo, NOW)).rejects.toBeInstanceOf(OpsRefused);

    // Row-level security on blocker itself (0031): the supervisor reads the system's problems, the VMO does not.
    const seen = (v: ViewerOrg) =>
      withContext(v, (s) => s<{ n: number }[]>`select count(*)::int as n from blocker where raised_by = ${SYSTEM_ACTOR_ID} and id = ${low.problem!.blockerId}`);
    expect((await seen(sup))[0]!.n).toBe(1);
    expect((await seen(vmo))[0]!.n).toBe(0);
  });

  it("when Televend clears every alarm behind a problem, the problem closes itself — and says so", async () => {
    await sql()`update tv_event set resolved_at = ${minsAgo(5)} where external_id in (${`${TAG}-p1`}, ${`${TAG}-p2`})`;
    const r = await syncMachineAlarms({ now: NOW });
    expect(r.cleared).toBe(2);
    expect(r.resolved).toBe(1);
    const [b] = await sql()<{ status: string; resolved_by: string; resolution_note: string }[]>`
      select b.status, b.resolved_by, b.resolution_note from blocker b
       where b.id = (select blocker_id from machine_alarm where event_id = ${`${TAG}-p1`})`;
    expect(b).toMatchObject({ status: "resolved", resolved_by: SYSTEM_ACTOR_ID });
    expect(b!.resolution_note).toMatch(/^Cleared in Televend/);
    // Its line leaves the list; the others stay.
    const left = (await alarmsNow(sup, NOW)).needsAction.filter((a) => a.machineTvId === M1 || a.machineTvId === M2).map((a) => a.alarm);
    expect(left.sort()).toEqual(["Cashless device", "Martian landing"]);
  });
});

describe("after the independent review (2026-10-17)", () => {
  const M3 = 990603;
  const M4 = 990604;
  const M5 = 990605;
  const INFO_RULE = `${TAG} door opened`;
  const blockerOf = async (id: string) =>
    (await sql()<{ blocker_id: string | null }[]>`select blocker_id from machine_alarm where event_id = ${`${TAG}-${id}`}`)[0]?.blocker_id ?? null;

  beforeAll(async () => {
    process.env.OPS_ALARM_PROBLEMS = "on";
    for (const [id, enabled] of [[M3, true], [M4, false], [M5, true]] as const) {
      await sql()`insert into tv_machine (televend_id, caption, asset_no, enabled, raw, is_synthetic)
                  values (${id}, ${`Test Review-${id - 990000}-DXB`}, ${id - 990000}, ${enabled}, '{}'::jsonb, true)`;
    }
    await sql()`insert into alarm_rule (name, class, on_delay_minutes, category, severity, advice)
                values (${INFO_RULE}, 'info', 0, 'equipment', 'low', 'Information only.')`;
  });

  afterAll(async () => {
    await sql()`delete from alarm_rule where name = ${INFO_RULE}`;
    await sql()`delete from tv_machine where televend_id in (${M3}, ${M4}, ${M5})`;
  });

  it("gives every machine problem its own alert: two alarms on one machine both page (command-centre#2)", async () => {
    // c2 (Cashless device) and x1 (Martian landing) are both 'equipment' problems on Test Mall-602-SHJ.
    const ids = [await blockerOf("c2"), await blockerOf("x1")];
    const alerts = await sql()<{ alert_id: string | null }[]>`select alert_id from blocker where id = any(${ids})`;
    expect(alerts.map((a) => a.alert_id).filter(Boolean)).toHaveLength(2);
    expect(new Set(alerts.map((a) => a.alert_id)).size).toBe(2);
  });

  it("a repeat inside its on-delay joins the open problem at once, and the problem stays open while it does (command-centre#3)", async () => {
    await event("cl1", M3, "Connection lost", 60);
    await event("cl2", M3, "Connection lost", 5); // inside the 30-minute on-delay
    const r = await syncMachineAlarms({ now: NOW });
    expect(r.raised).toBeGreaterThanOrEqual(1);
    const b = await blockerOf("cl1");
    expect(b).not.toBeNull();
    expect(await blockerOf("cl2")).toBe(b);
    // The first clears; the repeat is still open — the problem must not close.
    await sql()`update tv_event set resolved_at = ${minsAgo(1)} where external_id = ${`${TAG}-cl1`}`;
    await syncMachineAlarms({ now: NOW });
    expect((await sql()<{ status: string }[]>`select status from blocker where id = ${b}`)[0]!.status).toBe("open");
    // The repeat clears too: now it closes.
    await sql()`update tv_event set resolved_at = ${minsAgo(0)} where external_id = ${`${TAG}-cl2`}`;
    await syncMachineAlarms({ now: NOW });
    expect((await sql()<{ status: string }[]>`select status from blocker where id = ${b}`)[0]!.status).toBe("resolved");
  });

  it("a switched-off Televend record raises nothing, and a problem whose record is switched off closes, saying why (command-centre#5)", async () => {
    await event("off1", M4, "Connection lost", 120);
    await event("on1", M5, "Connection lost", 120);
    await syncMachineAlarms({ now: NOW });
    expect(await blockerOf("off1")).toBeNull();
    const b = await blockerOf("on1");
    expect(b).not.toBeNull();
    await sql()`update tv_machine set enabled = false where televend_id = ${M5}`;
    await syncMachineAlarms({ now: NOW });
    const [row] = await sql()<{ status: string; resolution_note: string }[]>`select status, resolution_note from blocker where id = ${b}`;
    expect(row).toMatchObject({ status: "resolved" });
    expect(row!.resolution_note).toMatch(/switched this machine record off/);
  });

  it("never links an info alarm — it would otherwise sit at the head of every batch (command-centre#8)", async () => {
    await event("info1", M3, INFO_RULE, 600);
    await syncMachineAlarms({ now: NOW });
    expect((await sql()`select 1 from machine_alarm where event_id = ${`${TAG}-info1`}`).length).toBe(0);
  });

  it("a record switched back on raises its alarm still open again — a problem behind it, not 'needs action' with none (review 20 Oct, 059-fixes#6)", async () => {
    // on1 (M5) was closed above because its record was switched off; the alarm is still open.
    const closed = await blockerOf("on1");
    const [link] = await sql()<{ released_at: Date | null }[]>`select released_at from machine_alarm where event_id = ${`${TAG}-on1`}`;
    expect(link!.released_at).not.toBeNull();
    await sql()`update tv_machine set enabled = true where televend_id = ${M5}`;
    const r = await syncMachineAlarms({ now: NOW });
    expect(r.raised).toBeGreaterThanOrEqual(1);
    const again = await blockerOf("on1");
    expect(again).not.toBeNull();
    expect(again).not.toBe(closed);
    expect((await sql()<{ status: string }[]>`select status from blocker where id = ${again}`)[0]!.status).toBe("open");
    expect((await sql()<{ n: number }[]>`select count(*)::int as n from machine_alarm where event_id = ${`${TAG}-on1`}`)[0]!.n).toBe(1);
  });
});

describe("after the independent review (2026-10-20)", () => {
  const M6 = 990606;
  const FLAKY = `${TAG} flaky sensor`;
  const blockerOf = async (id: string) =>
    (await sql()<{ blocker_id: string | null }[]>`select blocker_id from machine_alarm where event_id = ${`${TAG}-${id}`}`)[0]?.blocker_id ?? null;

  beforeAll(async () => {
    process.env.OPS_ALARM_PROBLEMS = "on";
    await sql()`insert into tv_machine (televend_id, caption, asset_no, enabled, raw, is_synthetic)
                values (${M6}, 'Test Review-606-DXB', 606, true, '{}'::jsonb, true)`;
  });

  afterAll(async () => {
    await sql()`delete from alarm_rule where name = ${FLAKY}`;
    await sql()`delete from tv_machine where televend_id = ${M6}`;
  });

  it("an alarm whose own linked occurrence is reclassified as info and stays open: the problem closes, saying why", async () => {
    const NAME = `${TAG} chatty door`;
    await event("cd1", M6, NAME, 60);
    await syncMachineAlarms({ now: NOW });
    const b = await blockerOf("cd1");
    expect(b).not.toBeNull();
    await sql()`insert into alarm_rule (name, class, on_delay_minutes, category, severity, advice)
                values (${NAME}, 'info', 0, 'equipment', 'low', 'Information only.')`;
    try {
      await syncMachineAlarms({ now: NOW });
      const [row] = await sql()<{ status: string; resolution_note: string }[]>`select status, resolution_note from blocker where id = ${b}`;
      expect(row).toMatchObject({ status: "resolved" });
      expect(row!.resolution_note).toMatch(/information only/);
    } finally {
      await sql()`delete from alarm_rule where name = ${NAME}`;
    }
  });

  it("the command centre keeps an alarm older than 14 days while the problem behind it is open", async () => {
    await event("old1", M6, "Bill / Cash Box Full", 20 * 24 * 60);
    const [b] = await sql()<{ id: string }[]>`
      insert into blocker (raised_by, category, severity, affected_asset, risk, is_synthetic)
      values (${SYSTEM_ACTOR_ID}, 'cash', 'high', 'Test Review-606-DXB', 'Bill / Cash Box Full', true) returning id`;
    await sql()`insert into machine_alarm (event_source, event_id, machine_tv_id, alarm_name, started_at, blocker_id, is_synthetic)
                values ('bridge', ${`${TAG}-old1`}, ${M6}, 'Bill / Cash Box Full', ${minsAgo(20 * 24 * 60)}, ${b!.id}, true)`;
    const now = await alarmsNow(sup, NOW);
    expect(now.needsAction.some((x) => x.machineTvId === M6 && x.alarm === "Bill / Cash Box Full")).toBe(true);
  });

  it("an alarm reclassified as info: its open repeat no longer holds the problem open (059-fixes#5)", async () => {
    await event("fl1", M6, FLAKY, 60); // unclassified: a problem after 30 minutes
    await syncMachineAlarms({ now: NOW });
    const b = await blockerOf("fl1");
    expect(b).not.toBeNull();
    // The Ops Head classifies it as information only; Televend keeps a repeat open, as info alarms do.
    await sql()`insert into alarm_rule (name, class, on_delay_minutes, category, severity, advice)
                values (${FLAKY}, 'info', 0, 'equipment', 'low', 'Information only.')`;
    await event("fl2", M6, FLAKY, 10);
    await sql()`update tv_event set resolved_at = ${minsAgo(1)} where external_id = ${`${TAG}-fl1`}`;
    await syncMachineAlarms({ now: NOW });
    expect((await sql()<{ status: string }[]>`select status from blocker where id = ${b}`)[0]!.status).toBe("resolved");
  });
});
