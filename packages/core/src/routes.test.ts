import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getServiceSql, withContext } from "./db.js";
import { PLACE, answerHandover, receiveDelivery, recordUse, startHandover } from "./inventory-ledger.js";
import { recordCollection } from "./cash.js";
import { DEMO_CEO_ID } from "./meta.js";
import { loadViewer, type ViewerOrg } from "./org.js";
import { cancelPlan, copyPlans, evidenceGrid, myRound, plansOn, roundDays, savePlan, setMachineServiceRule, shiftAt, type StopIn } from "./routes.js";
import { addEvidence, endVisit, recordVisitCash, recordVisitFill, removeEvidence, setTasksDone, startVisit, visitDetail } from "./visits.js";
import { exportPersonData } from "./compliance-evidence.js";
import { eraseEmployee, retentionSweep } from "./retention.js";

/**
 * Routes and visits (TASK-061 part 2), against real Postgres. What must hold — from the instruction sheet of 13 Oct
 * and the plan (§2, §6), not from reading the code:
 *   - a Supervisor (or the Ops Head, the CEO, an Admin) plans each team's shift; only people who visit machines are
 *     on a team; the same plan saved twice is one plan; a stop taken off is kept;
 *   - a visit names its machine by the sticker's link or its typed number, and says which; one visit at a time;
 *     it carries out the stop on the person's round; nothing changes once it has ended;
 *   - the proof is the person's own photos and videos, each as one kind; the fill and the cash go on their ledgers;
 *   - the planner sees the sheet's OK / NO worked out from the visits, and Televend's refill beside them; a driver
 *     sees the plans they are on and their own visits — never another team's.
 */

const TAG = `RT-${randomUUID().slice(0, 6)}`;
const PLAN = randomUUID(); // supervisor — the route planner
const DRV = randomUUID(); // driver on the team
const DRV2 = randomUUID(); // the other driver on the team
const TECH = randomUUID(); // technician, on no team
const KEEP = randomUUID(); // warehouse keeper — visits nothing
const OTHER = randomUUID(); // a driver on another team
const PLAN2 = randomUUID(); // a second supervisor — writes words another planner copies
const STAFF = [PLAN, DRV, DRV2, TECH, KEEP, OTHER, PLAN2];
const M1 = 99_911;
const M2 = 99_912;
const M3 = 99_913;
const TV1 = 990_911;
const ITEM = randomUUID();
const DAY = "2031-03-10"; // a Monday, far from any real data
const NIGHT = new Date(`${DAY}T22:00:00+04:00`);
const machineIds: Record<number, string> = {};
let qr2 = "";
const v: Record<string, ViewerOrg> = {};
const sql = () => getServiceSql();
const id = () => randomUUID();
let seq = 0;

/** A photo (or video) this person sent — at `at`: proof is taken at the visit, so its time is the visit's (2031 here). */
async function photo(by: string, mime: "image/jpeg" | "video/mp4" = "image/jpeg", at: Date = new Date(NIGHT.getTime() + 60_000)): Promise<string> {
  const sha = createHash("sha256").update(`${TAG}-${seq++}`).digest("hex");
  const [r] = await sql()<{ id: string }[]>`
    insert into media_object (sha256, kind, mime, bytes, storage_path, uploaded_by, uploaded_at, retention_class, retention_until, scan_status, is_synthetic)
    values (${sha}, ${mime === "video/mp4" ? "video" : "photo"}, ${mime}, 1000, ${`test/${sha}`}, ${by}, ${at},
            ${mime === "video/mp4" ? "video" : "evidence"}, now() + interval '1 day', 'not_scanned', true)
    returning id`;
  return r!.id;
}

async function refusal(p: Promise<unknown>): Promise<{ status: number; code: string; message: string }> {
  try {
    await p;
  } catch (err) {
    const e = err as { status?: number; code?: string; message: string };
    return { status: e.status ?? 0, code: e.code ?? "", message: e.message };
  }
  throw new Error("expected a refusal, but it was accepted");
}

const stop = (assetNo: number, over: Partial<StopIn> = {}): StopIn => ({
  id: id(),
  machineAssetNo: assetNo,
  tasks: ["full_service", "resort"],
  evidence: ["normal_photo", "resorting_photo"],
  ...over,
});

beforeAll(async () => {
  const s = sql();
  const people: [string, string, string][] = [
    [PLAN, "Planner", "supervisor"],
    [DRV, "Kiran", "vmo"],
    [DRV2, "Ananthu", "vmo"],
    [TECH, "Tech", "technician"],
    [KEEP, "Keeper", "warehouse_keeper"],
    [OTHER, "Lama", "vmo"],
  ];
  for (const [pid, name, role] of people) {
    await s`insert into employee (id, display_name, status, is_synthetic, access_role, manager_employee_id)
            values (${pid}, ${`${TAG} ${name}`}, 'active', true, ${role}, ${DEMO_CEO_ID})`;
  }
  for (const [n, label] of [[M1, "Dubai Marina"], [M2, "Oasis"], [M3, "Jlt"]] as const) {
    const [m] = await s<{ id: string; qr_token: string }[]>`
      insert into machine (asset_no, label, is_synthetic) values (${n}, ${`${TAG} ${label}`}, true) returning id, qr_token`;
    machineIds[n] = m!.id;
    if (n === M2) qr2 = m!.qr_token;
  }
  await s`insert into tv_machine (televend_id, caption, asset_no, enabled, region_caption, last_status, connection_status, raw, is_synthetic)
          values (${TV1}, ${`${TAG} Dubai Marina`}, ${M1}, true, 'Metro', 1, 1, '{}'::jsonb, true)`;
  await s`insert into machine_placement (machine_id, tv_machine_id, source, is_synthetic) values (${machineIds[M1]!}, ${TV1}, 'manual', true)`;
  await s`insert into inv_item (id, name, category, unit, step, count_tolerance, sort_order, is_synthetic)
          values (${ITEM}, ${`${TAG} oranges`}, 'oranges', 'carton', 1, 0, 1, true)`;
  for (const pid of STAFF) v[pid] = (await loadViewer(pid))!;
  // The driver holds 5 cartons to fill with (the stock ledger, TASK-060).
  const keeperOps = (await loadViewer(DEMO_CEO_ID))!;
  await receiveDelivery(keeperOps, { id: id(), lines: [{ itemId: ITEM, qty: 5 }] });
  const h = id();
  await startHandover(keeperOps, { id: h, from: { kind: "warehouse" }, to: { kind: "person", employeeId: DRV }, lines: [{ itemId: ITEM, qty: 5 }] });
  await answerHandover(v[DRV]!, h, { answer: "accept" });
});

afterAll(async () => {
  const s = sql();
  const visits = (await s<{ id: string }[]>`select id from visit where employee_id = any(${STAFF}::uuid[])`).map((r) => r.id);
  await s`select visit_purge(${visits}::uuid[])`;
  const shifts = (await s<{ id: string }[]>`select id from shift where employee_id = any(${STAFF}::uuid[])`).map((r) => r.id);
  await s`select cash_purge_shifts(${shifts}::uuid[])`;
  await s`delete from cash_account where employee_id = any(${STAFF}::uuid[]) or machine_id = any(${Object.values(machineIds)}::uuid[])`;
  await s.begin(async (tx) => {
    const docs = (await tx<{ id: string }[]>`select distinct d.id from stock_doc d join stock_doc_line l on l.doc_id = d.id where l.item_id = ${ITEM}`).map((r) => r.id);
    await tx`select inv_purge_docs(${docs}::uuid[])`;
    await tx`set local freshnow.ledger_purge = 'on'`;
    await tx`delete from stock_balance where item_id = ${ITEM}`;
    await tx`delete from inv_location where employee_id = any(${STAFF}::uuid[])`;
    await tx`delete from inv_item where id = ${ITEM}`;
  });
  const plans = (await s<{ id: string }[]>`select id from route_plan where created_by = any(${STAFF}::uuid[])`).map((r) => r.id);
  await s`delete from route_stop where plan_id = any(${plans}::uuid[])`;
  await s`delete from route_plan_member where plan_id = any(${plans}::uuid[])`;
  await s`update route_plan set copied_from = null where id = any(${plans}::uuid[])`;
  await s`delete from route_plan where id = any(${plans}::uuid[])`;
  await s`delete from media_object where uploaded_by = any(${STAFF}::uuid[])`;
  await s`delete from tv_refill where natural_key like ${`${TAG}-%`}`;
  await s`delete from tv_event where external_id like ${`${TAG}-%`}`;
  await s`delete from machine_placement where tv_machine_id = ${TV1}`;
  await s`delete from tv_machine where televend_id = ${TV1}`;
  await s`delete from machine where id = any(${Object.values(machineIds)}::uuid[])`;
  await s`delete from notification_outbox where recipient_employee_id = any(${STAFF}::uuid[])`;
  await s`delete from audit_log where actor = any(${STAFF.map((x) => `employee:${x}`)})`;
  await s`delete from employee where id = any(${STAFF}::uuid[])`;
  await closeDb();
});

const TEAM = randomUUID();
const S1 = id();
const S2 = id();

describe("a plan", () => {
  it("is made by a planner for one team's shift — and the team is told", async () => {
    const r = await savePlan(v[PLAN]!, {
      id: TEAM,
      businessDate: DAY,
      shiftWindow: "night",
      name: "Team Kiran / Ananthu",
      memberIds: [DRV, DRV2],
      stops: [
        stop(M1, { id: S1, tasks: ["full_service", "resort", "cash", "water_remove"], crates: 2 }),
        stop(M2, { id: S2, tasks: ["full_service", "resort", "cash"], crates: 1, evidence: ["normal_photo", "resorting_photo", "dispenser_video"] }),
      ],
    });
    expect(r).toMatchObject({ id: TEAM, created: true, crates: 3, warnings: [] });
    const told = await sql()<{ r: string }[]>`
      select distinct recipient_employee_id as r from notification_outbox where idempotency_key like ${`route.plan_made:${TEAM}:%`} and channel = 'inapp'`;
    expect(new Set(told.map((t) => t.r))).toEqual(new Set([DRV, DRV2]));
  });

  it("is refused in words: a driver planning, a keeper on a team, an unknown machine, a machine twice, 'other' unexplained", async () => {
    const base = { id: id(), businessDate: DAY, shiftWindow: "day" as const, name: "Team X", memberIds: [DRV], stops: [stop(M1)] };
    expect((await refusal(savePlan(v[DRV]!, base))).status).toBe(403);
    expect((await refusal(savePlan(v[PLAN]!, { ...base, memberIds: [KEEP] }))).code).toBe("not_a_visitor");
    expect((await refusal(savePlan(v[PLAN]!, { ...base, stops: [stop(12_345)] }))).code).toBe("no_machine");
    expect((await refusal(savePlan(v[PLAN]!, { ...base, stops: [stop(M1), stop(M1)] }))).code).toBe("duplicate_machine");
    expect((await refusal(savePlan(v[PLAN]!, { ...base, stops: [stop(M1, { tasks: ["other"] })] }))).code).toBe("instructions_needed");
    expect((await refusal(savePlan(v[PLAN]!, { ...base, stops: [stop(M1, { tasks: ["check"] })] }))).code).toBe("instructions_needed");
    expect((await refusal(savePlan(v[PLAN]!, { ...base, stops: [stop(M1, { crates: 2.5 })] }))).code).toBe("bad_crates");
    expect((await refusal(savePlan(v[PLAN]!, { ...base, name: "team kiran / ananthu", shiftWindow: "night" }))).code).toBe("name_taken");
  });

  it("saved again is the same plan; a stop taken off is kept, marked removed; the day and shift stay as made", async () => {
    const S3 = id();
    const change = {
      id: TEAM,
      businessDate: DAY,
      shiftWindow: "night" as const,
      name: "Team Kiran / Ananthu",
      memberIds: [DRV, DRV2],
      stops: [stop(M2, { id: S2, tasks: ["full_service", "resort", "cash"], crates: 1, evidence: ["normal_photo", "resorting_photo", "dispenser_video"] }), stop(M1, { id: S1, tasks: ["full_service", "resort", "cash", "water_remove"], crates: 2 }), stop(M3, { id: S3 })],
    };
    expect((await savePlan(v[PLAN]!, change)).created).toBe(false);
    await savePlan(v[PLAN]!, change);
    const plan = (await plansOn(v[PLAN]!, DAY)).find((p) => p.id === TEAM);
    expect(plan!.stops.map((s) => s.machine.assetNo)).toEqual([M2, M1, M3]);
    // M3 off again: kept, marked removed.
    await savePlan(v[PLAN]!, { ...change, stops: change.stops.slice(0, 2) });
    const [removed] = await sql()<{ removed: boolean }[]>`select removed_at is not null as removed from route_stop where id = ${S3}`;
    expect(removed!.removed).toBe(true);
    expect((await plansOn(v[PLAN]!, DAY)).find((p) => p.id === TEAM)!.stops.map((s) => s.machine.assetNo)).toEqual([M2, M1]);
    expect((await refusal(savePlan(v[PLAN]!, { ...change, shiftWindow: "day" }))).code).toBe("day_fixed");
  });

  it("warns — never refuses — when a night-only machine is put on a day plan (\"Schedule rashid always Night\")", async () => {
    await setMachineServiceRule(v[PLAN]!, M3, { shift: "night", note: "the hospital allows the trolley at night only" });
    const r = await savePlan(v[PLAN]!, { id: id(), businessDate: DAY, shiftWindow: "day", name: "Team Majid", memberIds: [OTHER], stops: [stop(M3)] });
    expect(r.created).toBe(true);
    expect(r.warnings).toEqual([expect.stringMatching(/night shift only — the hospital allows the trolley at night only/)]);
    expect((await refusal(setMachineServiceRule(v[DRV]!, M3, { shift: null }))).status).toBe(403);
    await setMachineServiceRule(v[PLAN]!, M3, { shift: null });
    await cancelPlan(v[PLAN]!, r.id); // only the warning was being shown
  });

  it("copied to the next day keeps the team, the machines and the instructions — and copying again copies nothing", async () => {
    const next = "2031-03-11";
    const r = await copyPlans(v[PLAN]!, { fromDate: DAY, toDate: next });
    expect(r.created).toHaveLength(1);
    const [copy] = await plansOn(v[PLAN]!, next);
    expect(copy).toMatchObject({ name: "Team Kiran / Ananthu", shiftWindow: "night" });
    expect(copy!.stops.map((s) => [s.machine.assetNo, s.tasks, s.crates])).toEqual([[M2, ["full_service", "resort", "cash"], 1], [M1, ["full_service", "resort", "cash", "water_remove"], 2]]);
    expect(copy!.crates).toBe(3);
    expect(copy!.members.map((m) => m.id).sort()).toEqual([DRV, DRV2].sort());
    expect(await copyPlans(v[PLAN]!, { fromDate: DAY, toDate: next })).toEqual({
      created: [],
      skipped: 1,
      skippedPlans: [{ name: "Team Kiran / Ananthu", shiftWindow: "night", why: "already_there" }],
    });
    await cancelPlan(v[PLAN]!, copy!.id);
    expect((await plansOn(v[PLAN]!, next))[0]!.state).toBe("cancelled");
    expect((await cancelPlan(v[PLAN]!, copy!.id)).replay).toBe(true);
  });
});

let V1 = "";
describe("a visit", () => {
  it("starts by the typed number, carries out the stop on the person's round, and is one at a time", async () => {
    V1 = id();
    const started = await startVisit(v[DRV]!, { id: V1, machineAssetNo: M1 }, { now: NIGHT });
    expect(started).toMatchObject({ visitId: V1, stopId: S1, replay: false, machine: { assetNo: M1 } });
    expect((await startVisit(v[DRV]!, { id: V1, machineAssetNo: M1 }, { now: NIGHT })).replay).toBe(true);
    expect((await refusal(startVisit(v[DRV]!, { id: id(), machineAssetNo: M2 }, { now: NIGHT }))).code).toBe("visit_open");
    // At the same machine again: the open visit carries on.
    expect((await startVisit(v[DRV]!, { id: id(), machineAssetNo: M1 }, { now: NIGHT })).visitId).toBe(V1);
    const [row] = await sql()<{ how: string }[]>`select started_how as how from visit where id = ${V1}`;
    expect(row!.how).toBe("typed");
  });

  it("takes the person's own photos as proof, each as one kind; a video's place is a video's", async () => {
    const normal = await photo(DRV);
    const d = await addEvidence(v[DRV]!, V1, { kind: "normal_photo", mediaId: normal });
    expect(d.evidence.map((e) => e.kind)).toEqual(["normal_photo"]);
    expect(d.missing).toEqual(["resorting_photo"]);
    expect((await refusal(addEvidence(v[DRV]!, V1, { kind: "dispenser_video", mediaId: await photo(DRV) }))).code).toBe("video_needed");
    expect((await refusal(addEvidence(v[DRV]!, V1, { kind: "resorting_photo", mediaId: await photo(DRV2) }))).code).toBe("not_your_photo");
    expect((await refusal(addEvidence(v[DRV]!, V1, { kind: "resorting_photo", mediaId: normal }))).code).toBe("already_added");
    // The wrong one, taken off again.
    const wrong = await addEvidence(v[DRV]!, V1, { kind: "resorting_photo", mediaId: await photo(DRV) });
    const off = await removeEvidence(v[DRV]!, V1, wrong.evidence.find((e) => e.kind === "resorting_photo")!.id);
    expect(off.missing).toEqual(["resorting_photo"]);
    expect((await refusal(addEvidence(v[DRV2]!, V1, { kind: "resorting_photo", mediaId: await photo(DRV2) }))).code).toBe("no_visit");
  });

  it("puts the fill and the cash on their ledgers, linked to the visit, and ticks them", async () => {
    let d = await recordVisitFill(v[DRV]!, V1, { id: id(), lines: [{ itemId: ITEM, qty: 2 }] });
    expect(d.fills).toHaveLength(1);
    expect(d.fills[0]!.items).toMatch(/2(\.000)? carton/);
        const [used] = await sql()<{ reason: string; machine_id: string }[]>`
      select d.reason, d.machine_id from stock_doc d join visit_doc vd on vd.stock_doc_id = d.id where vd.visit_id = ${V1}`;
    expect(used).toEqual({ reason: "machine_refill", machine_id: machineIds[M1] });
    const [held] = await sql()<{ q: string }[]>`
      select b.qty::text as q from stock_balance b join inv_location l on l.id = b.location_id where l.employee_id = ${DRV} and b.item_id = ${ITEM}`;
    expect(Number(held!.q)).toBe(3);
    d = await recordVisitCash(v[DRV]!, V1, { id: id(), amountFils: 3_000, mediaIds: [await photo(DRV)] });
    expect(d.cash).toEqual([{ docId: expect.any(String), amountFils: 3_000, state: "posted" }]);
    expect(d.tasksDone).toEqual(["cash"]); // the cash ticks itself; the service the person ticks
    d = await setTasksDone(v[DRV]!, V1, { tasks: ["full_service", "resort", "cash", "water_remove"] });
    expect(d.tasksDone).toEqual(["full_service", "resort", "cash", "water_remove"]);
  });

  it("ends saying what proof is missing — and then nothing about it changes", async () => {
    const r = await endVisit(v[DRV]!, V1, { note: "re-sorting photo forgotten" }, { now: new Date(NIGHT.getTime() + 20 * 60_000) });
    expect(r).toMatchObject({ missing: ["resorting_photo"], tasksLeft: [], replay: false });
    expect((await endVisit(v[DRV]!, V1)).replay).toBe(true);
    expect((await refusal(addEvidence(v[DRV]!, V1, { kind: "resorting_photo", mediaId: await photo(DRV) }))).code).toBe("visit_ended");
    await expect(sql()`update visit set tasks_done = '{}' where id = ${V1}`).rejects.toThrow(/not changed/);
    await expect(sql()`delete from visit where id = ${V1}`).rejects.toThrow(/never deleted/);
    await expect(sql()`delete from visit_doc where visit_id = ${V1}`).rejects.toThrow(/stays linked/);
    await expect(sql()`update visit_evidence set kind = 'other_photo' where visit_id = ${V1}`).rejects.toThrow(/never changed/);
  });

  it("starts by the sticker's link too, and says so; a machine off the plan is a visit off the plan", async () => {
    const byQr = await startVisit(v[DRV2]!, { id: id(), qrToken: qr2 }, { now: NIGHT });
    expect(byQr).toMatchObject({ stopId: S2, machine: { assetNo: M2 } });
    const [row] = await sql()<{ how: string }[]>`select started_how as how from visit where id = ${byQr.visitId}`;
    expect(row!.how).toBe("qr");
    await addEvidence(v[DRV2]!, byQr.visitId, { kind: "dispenser_video", mediaId: await photo(DRV2, "video/mp4") });
    await endVisit(v[DRV2]!, byQr.visitId);
    expect((await refusal(startVisit(v[DRV2]!, { id: id(), qrToken: randomUUID() }, { now: NIGHT }))).code).toBe("no_machine");
    // A technician on no team: a visit, off any plan.
    const t = await startVisit(v[TECH]!, { id: id(), machineAssetNo: M3 }, { now: NIGHT });
    expect(t.stopId).toBeNull();
    await endVisit(v[TECH]!, t.visitId);
    expect((await refusal(startVisit(v[KEEP]!, { id: id(), machineAssetNo: M3 }, { now: NIGHT }))).status).toBe(403);
  });
});

describe("the round, and the sheet's OK / NO", () => {
  it("shows last night's plan until noon, and not after", () => {
    expect(roundDays(new Date(`2031-03-11T09:00:00+04:00`))).toEqual([{ date: DAY, shifts: ["night"] }, { date: "2031-03-11", shifts: ["day", "night"] }]);
    expect(roundDays(new Date(`2031-03-11T13:00:00+04:00`))).toEqual([{ date: "2031-03-11", shifts: ["day", "night"] }]);
  });

  it("shows a driver the plans they are on with the team's progress — never another team's", async () => {
    await savePlan(v[PLAN]!, { id: id(), businessDate: DAY, shiftWindow: "night", name: "Team Lama", memberIds: [OTHER], stops: [stop(M3)] });
    const round = await myRound(v[DRV]!, NIGHT);
    expect(round.plans.map((p) => p.name)).toEqual(["Team Kiran / Ananthu"]);
    const s2 = round.plans[0]!.stops.find((s) => s.id === S2)!;
    expect(s2.visits.map((x) => x.employee.id)).toEqual([DRV2]); // the teammate's visit, seen by the team
    expect((await plansOn(v[DRV]!, DAY)).map((p) => p.name)).toEqual(["Team Kiran / Ananthu"]);
    expect((await plansOn(v[PLAN]!, DAY)).map((p) => p.name).sort()).toEqual(["Team Kiran / Ananthu", "Team Lama", "Team Majid"]);
    expect((await refusal(myRound(v[KEEP]!, NIGHT))).status).toBe(403);
  });

  it("works out each stop's proof from the visits, with the fill, the cash and Televend's refill beside it", async () => {
    await sql()`insert into tv_refill (source, natural_key, machine_tv_id, at, filled_by, action, quantity_change, origin, raw, is_synthetic) values
                ('bridge', ${`${TAG}-r1`}, ${TV1}, ${new Date(NIGHT.getTime() + 10 * 60_000)}, 'Test', 'filled', 40, 'mobile_app', '{}'::jsonb, true),
                ('bridge', ${`${TAG}-r2`}, ${TV1}, ${new Date(NIGHT.getTime() + 11 * 60_000)}, 'Test', 'filled', 23, 'mobile_app', '{}'::jsonb, true),
                ('bridge', ${`${TAG}-r3`}, ${TV1}, ${new Date(NIGHT.getTime() + 50 * 60_000)}, 'Test', 'corrected', -5, 'web_app', '{}'::jsonb, true)`;
    const g = await evidenceGrid(v[PLAN]!, DAY);
    const r1 = g.rows.find((r) => r.stop.id === S1)!;
    expect(r1.stop).toMatchObject({ proofComplete: false, missing: ["resorting_photo"] });
    expect(r1.fill?.items).toMatch(/carton/);
    expect(r1.cashCollected).toBe(true);
    expect(r1.televend).toMatchObject({ refillCups: 63, collectionAt: null });
    const r2 = g.rows.find((r) => r.stop.id === S2)!;
    expect(r2.stop.missing).toEqual(["normal_photo", "resorting_photo"]);
    expect(r2.televend).toMatchObject({ refillAt: null });
    expect(g.seesMachines).toBe(true);
    expect(g.unplanned).toEqual([]); // the technician is on no plan
    expect((await refusal(evidenceGrid(v[DRV]!, DAY))).status).toBe(403);
  });
});

describe("who sees what", () => {
  it("a driver sees their own visits, the planner everyone's — and the planner sees the proof's photos", async () => {
    const mine = await withContext(v[DRV]!, (tx) => tx<{ employee_id: string }[]>`select employee_id from visit`, { readOnly: true });
    expect(new Set(mine.map((x) => x.employee_id))).toEqual(new Set([DRV]));
    expect(await visitDetail(v[DRV]!, (await sql()<{ id: string }[]>`select id from visit where employee_id = ${DRV2} limit 1`)[0]!.id)).toBeNull();
    const all = await withContext(v[PLAN]!, (tx) => tx<{ n: number }[]>`select count(distinct employee_id)::int as n from visit where employee_id = any(${STAFF}::uuid[])`, { readOnly: true });
    expect(all[0]!.n).toBe(3);
    const [proof] = await sql()<{ media_id: string }[]>`select media_id from visit_evidence where visit_id = ${V1} and removed_at is null`;
    const seen = await withContext(v[PLAN]!, (tx) => tx<{ n: number }[]>`select count(*)::int as n from media_object where id = ${proof!.media_id}`, { readOnly: true });
    expect(seen[0]!.n).toBe(1);
    // The teammate sees the team's progress on the plan, not the other driver's photos.
    const notTheirs = await withContext(v[DRV2]!, (tx) => tx<{ n: number }[]>`select count(*)::int as n from media_object where id = ${proof!.media_id}`, { readOnly: true });
    expect(notTheirs[0]!.n).toBe(0);
  });

  it("gives the app role nothing but SELECT on every route and visit table", async () => {
    for (const t of ["route_plan", "route_plan_member", "route_stop", "visit", "visit_evidence", "visit_doc"]) {
      const [r] = await sql()<{ sel: boolean; ins: boolean; upd: boolean; del: boolean }[]>`
        select has_table_privilege('freshnow_app', ${t}, 'SELECT') as sel, has_table_privilege('freshnow_app', ${t}, 'INSERT') as ins,
               has_table_privilege('freshnow_app', ${t}, 'UPDATE') as upd, has_table_privilege('freshnow_app', ${t}, 'DELETE') as del`;
      expect({ t, ...r }).toEqual({ t, sel: true, ins: false, upd: false, del: false });
    }
  });

  it("keeps the record that proof was given when its file goes under the photo rules", async () => {
    const [proof] = await sql()<{ id: string; media_id: string }[]>`select id, media_id from visit_evidence where visit_id = ${V1} and removed_at is null`;
    await sql()`delete from media_object where id = ${proof!.media_id}`;
    const [after] = await sql()<{ media_id: string | null; kind: string }[]>`select media_id, kind from visit_evidence where id = ${proof!.id}`;
    expect(after).toEqual({ media_id: null, kind: "normal_photo" });
    expect(PLACE.used).toBeTruthy();
  });
});

describe("fixes from the review of 20 Oct", () => {
  // Days far from the others, a Tuesday on: D night, D+1 day and night, each with machine M3 on Lama's team.
  const D = "2031-03-25";
  const D1 = "2031-03-26";
  const at = (iso: string) => new Date(`${iso}+04:00`);
  const N1 = id();
  const N2 = id();
  const DD = id();
  const team = (planId: string, date: string, shift: "day" | "night", stops: StopIn[], name = "Team Lama 2") =>
    savePlan(v[PLAN]!, { id: planId, businessDate: date, shiftWindow: shift, name, memberIds: [OTHER], stops });

  it("knows the shift by the handovers: before 07:30 last night's, then the day, from 15:00 tonight's", () => {
    expect(shiftAt(at(`${D1}T02:00:00`))).toEqual({ date: D, shift: "night" });
    expect(shiftAt(at(`${D1}T07:29:00`))).toEqual({ date: D, shift: "night" });
    expect(shiftAt(at(`${D1}T07:30:00`))).toEqual({ date: D1, shift: "day" });
    expect(shiftAt(at(`${D1}T15:00:00`))).toEqual({ date: D1, shift: "night" });
  });

  it("after midnight, a second visit joins last night's stop — not tomorrow night's; in the morning, the day plan's (routes#1)", async () => {
    const sN1 = id();
    const sN2 = id();
    const sDD = id();
    await team(N1, D, "night", [stop(M3, { id: sN1 })]);
    await team(N2, D1, "night", [stop(M3, { id: sN2 })]);
    await team(DD, D1, "day", [stop(M3, { id: sDD })]);
    const first = await startVisit(v[OTHER]!, { id: id(), machineAssetNo: M3 }, { now: at(`${D1}T02:00:00`) });
    expect(first.stopId).toBe(sN1);
    await endVisit(v[OTHER]!, first.visitId, {}, { now: at(`${D1}T02:20:00`) });
    const second = await startVisit(v[OTHER]!, { id: id(), machineAssetNo: M3 }, { now: at(`${D1}T02:30:00`) });
    expect(second.stopId).toBe(sN1);
    await endVisit(v[OTHER]!, second.visitId, {}, { now: at(`${D1}T02:40:00`) });
    const morning = await startVisit(v[OTHER]!, { id: id(), machineAssetNo: M3 }, { now: at(`${D1}T10:00:00`) });
    expect(morning.stopId).toBe(sDD);
    await endVisit(v[OTHER]!, morning.visitId, {}, { now: at(`${D1}T10:10:00`) });
  });

  it("a visited stop keeps its machine — taken off and sent again too; the database says the same (routes#2)", async () => {
    const plan = (await plansOn(v[PLAN]!, D)).find((p) => p.id === N1)!;
    const visited = plan.stops[0]!;
    // Off the plan, then sent again with its old id and another machine: refused.
    await team(N1, D, "night", [stop(M2)]);
    expect((await refusal(team(N1, D, "night", [stop(M1, { id: visited.id })]))).code).toBe("stop_visited");
    await expect(sql()`update route_stop set machine_id = ${machineIds[M1]!} where id = ${visited.id}`).rejects.toThrow(/keeps its machine/);
    // Sent again with its own machine, it is back on the plan.
    await team(N1, D, "night", [stop(M3, { id: visited.id })]);
    expect((await plansOn(v[PLAN]!, D)).find((p) => p.id === N1)!.stops.map((s) => s.id)).toEqual([visited.id]);
  });

  it("the proof page lists visits to a stop taken off, or a plan cancelled, and each off-plan visit under one day only (routes#3, #7)", async () => {
    // Off the plans, at 09:15 the next morning: the next day's (its day shift), not this one's.
    const morning = await startVisit(v[OTHER]!, { id: id(), machineAssetNo: M1 }, { now: at(`${D1}T09:15:00`) });
    await endVisit(v[OTHER]!, morning.visitId, {}, { now: at(`${D1}T09:20:00`) });
    expect((await evidenceGrid(v[PLAN]!, D)).unplanned.some((u) => u.id === morning.visitId)).toBe(false);
    expect((await evidenceGrid(v[PLAN]!, D1)).unplanned.find((u) => u.id === morning.visitId)).toMatchObject({ why: "off_plan" });
    // The night stop with two visits taken off the plan: both visits are still listed, saying why.
    await team(N1, D, "night", [stop(M2)]);
    const off = (await evidenceGrid(v[PLAN]!, D)).unplanned.filter((u) => u.why === "stop_removed");
    expect(off).toHaveLength(2);
    await cancelPlan(v[PLAN]!, N1);
    expect((await evidenceGrid(v[PLAN]!, D)).unplanned.filter((u) => u.why === "plan_cancelled")).toHaveLength(2);
  });

  it("a stop's fill is every visit's fill added up; Televend's refill counts only from records placed in the machine then (routes#4, #14)", async () => {
    const P = id();
    const S = id();
    const D3 = "2031-03-27";
    await savePlan(v[PLAN]!, { id: P, businessDate: D3, shiftWindow: "night", name: "Team Kiran 3", memberIds: [DRV], stops: [stop(M1, { id: S })] });
    for (const t of ["22:00", "22:30"]) {
      const vis = await startVisit(v[DRV]!, { id: id(), machineAssetNo: M1 }, { now: at(`${D3}T${t}:00`) });
      expect(vis.stopId).toBe(S);
      await recordVisitFill(v[DRV]!, vis.visitId, { id: id(), lines: [{ itemId: ITEM, qty: 1 }] });
      await endVisit(v[DRV]!, vis.visitId, {}, { now: at(`${D3}T${t}:00`) });
    }
    // A Televend record placed in M1 until 20 Mar, now elsewhere, refills at the visit's time: not M1's.
    const TV2 = 990_919;
    await sql()`insert into tv_machine (televend_id, caption, asset_no, enabled, raw, is_synthetic) values (${TV2}, ${`${TAG} elsewhere`}, null, true, '{}'::jsonb, true)`;
    await sql()`insert into machine_placement (machine_id, tv_machine_id, valid_from, valid_to, source, is_synthetic)
                values (${machineIds[M1]!}, ${TV2}, ${at("2031-03-01T00:00:00")}, ${at("2031-03-20T00:00:00")}, 'manual', true)`;
    await sql()`insert into tv_refill (source, natural_key, machine_tv_id, at, filled_by, action, quantity_change, origin, raw, is_synthetic)
                values ('bridge', ${`${TAG}-r9`}, ${TV2}, ${at(`${D3}T22:40:00`)}, 'Test', 'filled', 30, 'mobile_app', '{}'::jsonb, true)`;
    try {
      const row = (await evidenceGrid(v[PLAN]!, D3)).rows.find((r) => r.stop.id === S)!;
      expect(row.fill?.items).toMatch(/^2(\.000)? cartons/);
      expect(row.televend).toMatchObject({ refillAt: null, refillCups: null });
    } finally {
      await sql()`delete from tv_refill where natural_key = ${`${TAG}-r9`}`;
      await sql()`delete from machine_placement where tv_machine_id = ${TV2}`;
      await sql()`delete from tv_machine where televend_id = ${TV2}`;
    }
  });

  it("a photo proves one visit, taken at it — not another visit's, nor one sent before the visit began (routes#5)", async () => {
    const t0 = at("2031-03-28T22:00:00");
    const a = await startVisit(v[OTHER]!, { id: id(), machineAssetNo: M2 }, { now: t0 });
    const P = await photo(OTHER, "image/jpeg", new Date(t0.getTime() + 60_000));
    await addEvidence(v[OTHER]!, a.visitId, { kind: "normal_photo", mediaId: P });
    await endVisit(v[OTHER]!, a.visitId, {}, { now: new Date(t0.getTime() + 10 * 60_000) });
    const b = await startVisit(v[OTHER]!, { id: id(), machineAssetNo: M3 }, { now: new Date(t0.getTime() + 30 * 60_000) });
    expect((await refusal(addEvidence(v[OTHER]!, b.visitId, { kind: "normal_photo", mediaId: P }))).code).toBe("photo_used");
    const old = await photo(OTHER, "image/jpeg", new Date(t0.getTime() - 24 * 3_600_000));
    expect((await refusal(addEvidence(v[OTHER]!, b.visitId, { kind: "normal_photo", mediaId: old }))).code).toBe("photo_too_old");
    const fresh = await photo(OTHER, "image/jpeg", new Date(t0.getTime() + 31 * 60_000));
    expect((await addEvidence(v[OTHER]!, b.visitId, { kind: "normal_photo", mediaId: fresh })).evidence).toHaveLength(1);
    // A planner ending it writes no words on it: the note is the visitor's own (routes#8).
    expect((await refusal(endVisit(v[PLAN]!, b.visitId, { note: "ended by me" }))).code).toBe("note_not_yours");
    expect((await endVisit(v[PLAN]!, b.visitId)).replay).toBe(false);
  });

  it("posts a fill or a cash entry with its link, or neither (routes#11)", async () => {
    const F = id();
    await expect(
      recordUse(v[DRV]!, { id: F, kind: "use", from: "mine", reason: "machine_refill", machineAssetNo: M1, lines: [{ itemId: ITEM, qty: 1 }] }, {
        within: async () => {
          throw new Error("the link failed");
        },
      }),
    ).rejects.toThrow("the link failed");
    expect((await sql()<{ n: number }[]>`select count(*)::int as n from stock_doc where id = ${F}`)[0]!.n).toBe(0);
    const C = id();
    await expect(
      recordCollection(v[DRV]!, { id: C, machineAssetNo: M1, amountFils: 100, mediaIds: [await photo(DRV)] }, {
        within: async () => {
          throw new Error("the link failed");
        },
      }),
    ).rejects.toThrow("the link failed");
    expect((await sql()<{ n: number }[]>`select count(*)::int as n from cash_doc where id = ${C}`)[0]!.n).toBe(0);
  });

  it("refuses renaming a plan to a name its shift already has (routes#13)", async () => {
    const D4 = "2031-03-29";
    await savePlan(v[PLAN]!, { id: id(), businessDate: D4, shiftWindow: "day", name: "Team Ali", memberIds: [OTHER], stops: [stop(M1)] });
    const B = id();
    await savePlan(v[PLAN]!, { id: B, businessDate: D4, shiftWindow: "day", name: "Team Omar", memberIds: [OTHER], stops: [stop(M2)] });
    expect((await refusal(savePlan(v[PLAN]!, { id: B, businessDate: D4, shiftWindow: "day", name: "team ali", memberIds: [OTHER], stops: [stop(M2)] }))).code).toBe(
      "name_taken",
    );
  });

  it("keeps who wrote a plan's words — copied plans too — for erasure and their download (routes#9)", async () => {
    await sql()`insert into employee (id, display_name, status, is_synthetic, access_role, manager_employee_id)
                values (${PLAN2}, ${`${TAG} Planner 2`}, 'active', true, 'supervisor', ${DEMO_CEO_ID})`;
    v[PLAN2] = (await loadViewer(PLAN2))!;
    const D5 = "2031-03-30";
    const W = id();
    await savePlan(v[PLAN2]!, {
      id: W, businessDate: D5, shiftWindow: "day", name: "Team Words", note: "Gate 3 after 10", memberIds: [OTHER],
      stops: [stop(M3, { tasks: ["check"], instructions: "check the cup sensor" })],
    });
    // Another planner changes only the team: the words stay Planner 2's.
    await savePlan(v[PLAN]!, {
      id: W, businessDate: D5, shiftWindow: "day", name: "Team Words", note: "Gate 3 after 10", memberIds: [OTHER, DRV2],
      stops: [stop(M3, { id: (await plansOn(v[PLAN]!, D5))[0]!.stops[0]!.id, tasks: ["check"], instructions: "check the cup sensor" })],
    });
    const copy = (await copyPlans(v[PLAN]!, { fromDate: D5, toDate: "2031-03-31" })).created[0]!;
    const by = await sql()<{ note_by: string; instructions_by: string }[]>`
      select p.note_by, s.instructions_by from route_plan p join route_stop s on s.plan_id = p.id where p.id in (${W}, ${copy})`;
    expect(by).toHaveLength(2);
    expect(by.every((r) => r.note_by === PLAN2 && r.instructions_by === PLAN2)).toBe(true);
    const out = (await exportPersonData({ employeeId: PLAN2, requestedBy: PLAN2 })) as Record<string, Record<string, unknown>[]>;
    expect(out.routeWordsYouWrote!.map((r) => r.your_words)).toEqual(expect.arrayContaining(["Gate 3 after 10", "check the cup sensor"]));
    await eraseEmployee({ employeeId: PLAN2, by: DEMO_CEO_ID, reason: "request" });
    const words = await sql()<{ note: string; instructions: string }[]>`
      select p.note, s.instructions from route_plan p join route_stop s on s.plan_id = p.id where p.id in (${W}, ${copy})`;
    expect(words.every((w) => w.note === "[erased]" && w.instructions === "[erased]")).toBe(true);
  });
});

describe("the review of the fixes, 20 Oct", () => {
  const at = (iso: string) => new Date(`${iso}+04:00`);

  it("a night team still out after the 07:30 handover adds a second visit to last night's stop, not tonight's", async () => {
    const D = "2031-04-07";
    const D1 = "2031-04-08";
    const sA = id();
    const sB = id();
    await savePlan(v[PLAN]!, { id: id(), businessDate: D, shiftWindow: "night", name: "Team Lama 4", memberIds: [OTHER], stops: [stop(M2, { id: sA })] });
    await savePlan(v[PLAN]!, { id: id(), businessDate: D1, shiftWindow: "night", name: "Team Lama 4", memberIds: [OTHER], stops: [stop(M2, { id: sB })] });
    const first = await startVisit(v[OTHER]!, { id: id(), machineAssetNo: M2 }, { now: at(`${D1}T07:10:00`) });
    expect(first.stopId).toBe(sA);
    await endVisit(v[OTHER]!, first.visitId, {}, { now: at(`${D1}T07:20:00`) });
    const second = await startVisit(v[OTHER]!, { id: id(), machineAssetNo: M2 }, { now: at(`${D1}T07:40:00`) });
    expect(second.stopId).toBe(sA);
    await endVisit(v[OTHER]!, second.visitId, {}, { now: at(`${D1}T07:50:00`) });
  });

  it("a visit off the plans by someone on the day before's plans only is still on a page — its own shift's day", async () => {
    const D = "2031-04-14";
    const D1 = "2031-04-15";
    await savePlan(v[PLAN]!, { id: id(), businessDate: D, shiftWindow: "night", name: "Team Lama 5", memberIds: [OTHER], stops: [stop(M2)] });
    const late = await startVisit(v[OTHER]!, { id: id(), machineAssetNo: M1 }, { now: at(`${D1}T08:15:00`) });
    await endVisit(v[OTHER]!, late.visitId, {}, { now: at(`${D1}T08:20:00`) });
    expect((await evidenceGrid(v[PLAN]!, D1)).unplanned.some((u) => u.id === late.visitId)).toBe(true);
    expect((await evidenceGrid(v[PLAN]!, D)).unplanned.some((u) => u.id === late.visitId)).toBe(false);
  });
});

describe("the words on visits and plans follow the person's other words", () => {
  const saved = process.env.RETENTION_DAYS;
  afterAll(() => {
    if (saved === undefined) delete process.env.RETENTION_DAYS;
    else process.env.RETENTION_DAYS = saved;
  });

  it("a person's own download lists the plans they were on and their visits, with their note", async () => {
    const out = (await exportPersonData({ employeeId: DRV, requestedBy: DRV })) as Record<string, Record<string, unknown>[]>;
    expect(out.routePlans!.some((p) => p.team === "Team Kiran / Ananthu")).toBe(true);
    const mine = out.visits!.find((x) => x.your_note === "re-sorting photo forgotten");
    expect(mine).toMatchObject({ machine: M1, started_how: "typed", proof: expect.stringContaining("normal_photo") });
  });

  it("the retention sweep removes old visit notes, plan notes and instructions — the visit stays; recent words stay", async () => {
    process.env.RETENTION_DAYS = "90";
    const OLDPLAN = id();
    const OLDSTOP = id();
    const OLDVISIT = id();
    await sql()`insert into route_plan (id, business_date, shift_window, name, note, created_by, updated_by, created_at, updated_at, is_synthetic)
                values (${OLDPLAN}, (now() - interval '121 days')::date, 'day', ${`${TAG} old team`}, 'old plan words', ${PLAN}, ${PLAN},
                        now() - interval '121 days', now() - interval '121 days', true)`;
    await sql()`insert into route_stop (id, plan_id, seq, machine_id, tasks, instructions, is_synthetic)
                values (${OLDSTOP}, ${OLDPLAN}, 1, ${machineIds[M3]!}, '{check}', 'old instructions', true)`;
    await sql()`insert into visit (id, machine_id, employee_id, stop_id, started_at, started_how, ended_at, tasks_done, note, request_hash, is_synthetic)
                values (${OLDVISIT}, ${machineIds[M3]!}, ${TECH}, ${OLDSTOP}, now() - interval '121 days', 'typed', now() - interval '121 days' + interval '10 minutes',
                        '{check}', 'old visit words', ${"0".repeat(64)}, true)`;
    await retentionSweep();
    const [p] = await sql()<{ note: string }[]>`select note from route_plan where id = ${OLDPLAN}`;
    const [st] = await sql()<{ instructions: string }[]>`select instructions from route_stop where id = ${OLDSTOP}`;
    const [vi] = await sql()<{ note: string; machine_id: string }[]>`select note, machine_id from visit where id = ${OLDVISIT}`;
    expect([p!.note, st!.instructions, vi!.note].every((w) => w.startsWith("[redacted"))).toBe(true);
    expect(vi!.machine_id).toBe(machineIds[M3]);
    const [fresh] = await sql()<{ note: string }[]>`select note from visit where id = ${V1}`;
    expect(fresh!.note).toBe("re-sorting photo forgotten");
  });

  it("erasing a person removes the words on their visits; which machine they visited, and when, stays", async () => {
    const [before] = await sql()<{ n: number }[]>`select count(*)::int as n from visit where employee_id = ${DRV}`;
    await eraseEmployee({ employeeId: DRV, by: DEMO_CEO_ID, reason: "request" });
    const notes = await sql()<{ note: string }[]>`select note from visit where employee_id = ${DRV} and note is not null`;
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.every((x) => x.note === "[erased]")).toBe(true);
    const [after] = await sql()<{ n: number }[]>`select count(*)::int as n from visit where employee_id = ${DRV}`;
    expect(after).toEqual(before);
  });
});
