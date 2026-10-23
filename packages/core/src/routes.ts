import { randomUUID } from "node:crypto";
import { notifyPeople } from "./alerts.js";
import { getServiceSql, withContext, type Tx } from "./db.js";
import { shiftHandovers } from "./device-auth.js";
import { InventoryRefused, UUID_RE, correlationOf } from "./inventory-common.js";
import { loadViewer, type ViewerOrg } from "./org.js";
import { can } from "./permissions.js";
import { localDate } from "./time.js";

/**
 * Each team's route (TASK-061 part 2, migration 0036) — the team × machine instruction sheet posted to the
 * "Freshnow Service Team" group (13 Oct), as a plan the team sees in the app.
 *
 *   savePlan     a Supervisor, the Ops Head, the CEO or an Admin makes or changes one team's plan for one shift:
 *                who is on the team, the machines in order, what to do at each, the proof wanted
 *   copyPlans    yesterday's plans as the start of tomorrow's (the sheet is much the same day to day)
 *   cancelPlan   a plan nobody will carry out
 *   plansOn      the day's plans — all of them for whoever plans, the person's own otherwise
 *   myRound      what the person has to do now: today's plans, and last night's until noon (A-T61.9)
 *   evidenceGrid the sheet's OK / NO columns, worked out from the visits themselves (visits.ts records them)
 *
 * The words are the sheet's of 18 Oct: "full service", "half service", "resort", "water remove", "kachara remove",
 * "clean with hot water", "make free vend", the 🚨 checks (cup failure, orange stuck, connection, upper belt), and
 * "(2 crates)" of oranges to load; the proof columns NORMAL PIC, RESORTING PIC, VIDEO OF WHITE FRUIT DISPENSER, OTHER.
 */

export const STOP_TASKS = [
  "full_service",
  "half_service",
  "resort",
  "cash",
  "water_remove",
  "garbage_remove",
  "hot_water_clean",
  "deep_clean",
  "free_vend",
  "check",
  "other",
] as const;
export type StopTask = (typeof STOP_TASKS)[number];
export const EVIDENCE_KINDS = ["normal_photo", "resorting_photo", "dispenser_video", "other_photo"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
export const SHIFT_WINDOWS = ["day", "night"] as const;
export type ShiftWindow = (typeof SHIFT_WINDOWS)[number];

/** The sheet's own words for each task and each kind of proof. */
export const TASK_WORDS: Readonly<Record<StopTask, string>> = {
  full_service: "Full service",
  half_service: "Half service",
  resort: "Resort",
  cash: "Cash",
  water_remove: "Water remove",
  garbage_remove: "Kachara remove",
  hot_water_clean: "Clean with hot water",
  deep_clean: "Deep clean",
  free_vend: "Make free vend",
  check: "Check 🚨",
  other: "Other",
};
export const EVIDENCE_WORDS: Readonly<Record<EvidenceKind, string>> = {
  normal_photo: "Normal pic",
  resorting_photo: "Re-sorting pic",
  dispenser_video: "Video of the white fruit dispenser",
  other_photo: "Other",
};

/** A night shift's round is shown until noon the next day (A-T61.9). */
const NIGHT_ENDS_HOUR = 12;
const MAX_STOPS = 60;
const MAX_MEMBERS = 6;

export class RouteRefused extends InventoryRefused {
  constructor(message: string, status: 400 | 403 | 404 | 409 = 403, code = "refused") {
    super(message, status, code);
    this.name = "RouteRefused";
  }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const cleanText = (s: string | null | undefined, max: number): string | null => {
  const t = s?.trim();
  return t ? t.slice(0, max) : null;
};

function requirePlanner(viewer: ViewerOrg): void {
  if (viewer.status !== "active" || !can(viewer, "routes.plan")) throw new RouteRefused("Only a Supervisor, the Ops Head, the CEO or an Admin plans routes.", 403, "not_allowed");
}

/** "Mon 20 Oct, night shift". */
const planWhen = (date: string, shift: ShiftWindow) =>
  `${new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`))}, ${shift} shift`;

// ── making plans ─────────────────────────────────────────────────────────────
export interface StopIn {
  /** Made by the planner's browser, for a new stop too: the same plan saved twice keeps one copy of each stop. */
  id: string;
  machineAssetNo: number;
  tasks: readonly StopTask[];
  /** Crates of oranges to load here — the sheet's "(2 crates)". */
  crates?: number | null;
  instructions?: string | null;
  evidence: readonly EvidenceKind[];
}

export interface PlanIn {
  id: string;
  businessDate: string;
  shiftWindow: ShiftWindow;
  name: string;
  note?: string | null;
  memberIds: readonly string[];
  stops: readonly StopIn[];
}

/**
 * Make one team's plan, or change it. The day and the shift are fixed once made — another day is another plan.
 * Stops taken off are kept, marked removed (a visit may already point at one); a stop's machine is fixed once
 * someone has visited it for this plan. Members are told when a plan is first made; a change reaches their
 * screen through the live updates.
 */
export async function savePlan(
  viewer: ViewerOrg,
  req: PlanIn,
  opts: { correlationId?: string } = {},
): Promise<{ id: string; created: boolean; warnings: string[]; crates: number }> {
  requirePlanner(viewer);
  if (!UUID_RE.test(req.id)) throw new RouteRefused("The plan's id must be a UUID made by the app.", 400, "bad_id");
  if (!DAY.test(req.businessDate)) throw new RouteRefused("A day is YYYY-MM-DD.", 400, "bad_day");
  if (!(SHIFT_WINDOWS as readonly string[]).includes(req.shiftWindow)) throw new RouteRefused("Day or night shift?", 400, "bad_shift");
  const name = cleanText(req.name, 80);
  if (!name) throw new RouteRefused("Name the team, as the sheet does: “Team Kiran / Ananthu”.", 400, "name_needed");
  const note = cleanText(req.note, 500);
  const memberIds = [...new Set(req.memberIds)];
  if (memberIds.length === 0) throw new RouteRefused("Who is on the team?", 400, "members_needed");
  if (memberIds.length > MAX_MEMBERS) throw new RouteRefused(`At most ${MAX_MEMBERS} people on one team.`, 400, "too_many_members");
  if (memberIds.some((x) => !UUID_RE.test(x))) throw new RouteRefused("A person's id is not valid.", 400, "bad_person");
  if (req.stops.length > MAX_STOPS) throw new RouteRefused(`At most ${MAX_STOPS} machines on one plan.`, 400, "too_many_stops");
  const stops = req.stops.map((s, i) => {
    if (!UUID_RE.test(s.id)) throw new RouteRefused("A stop's id must be a UUID made by the app.", 400, "bad_id");
    if (!Number.isInteger(s.machineAssetNo) || s.machineAssetNo < 1 || s.machineAssetNo > 99_999) throw new RouteRefused("A machine number is 1 to 99999.", 400, "bad_machine");
    const tasks = [...new Set(s.tasks)];
    const evidence = [...new Set(s.evidence)];
    if (tasks.some((t) => !(STOP_TASKS as readonly string[]).includes(t))) throw new RouteRefused("Unknown task.", 400, "bad_task");
    if (evidence.some((e) => !(EVIDENCE_KINDS as readonly string[]).includes(e))) throw new RouteRefused("Unknown kind of proof.", 400, "bad_evidence");
    if (tasks.length === 0) throw new RouteRefused(`Say what to do at machine ${s.machineAssetNo}.`, 400, "tasks_needed");
    const instructions = cleanText(s.instructions, 300);
    if ((tasks.includes("other") || tasks.includes("check")) && !instructions) {
      throw new RouteRefused(`Machine ${s.machineAssetNo}: write what to ${tasks.includes("check") ? "check" : "do"}.`, 400, "instructions_needed");
    }
    const crates = s.crates === null || s.crates === undefined ? null : s.crates;
    if (crates !== null && (!Number.isInteger(crates) || crates < 0 || crates > 20)) throw new RouteRefused("Crates are a whole number, 0 to 20.", 400, "bad_crates");
    return { id: s.id, seq: i + 1, assetNo: s.machineAssetNo, tasks, evidence, instructions, crates };
  });
  const seenMachines = new Set<number>();
  for (const s of stops) {
    if (seenMachines.has(s.assetNo)) throw new RouteRefused(`Machine ${s.assetNo} is on this plan twice.`, 400, "duplicate_machine");
    seenMachines.add(s.assetNo);
  }
  // Everyone on the team can record visits — checked as they are now.
  for (const id of memberIds) {
    const p = await loadViewer(id);
    if (!p) throw new RouteRefused("No such person.", 404, "no_person");
    if (p.status !== "active" || !can(p, "visits.record")) {
      throw new RouteRefused(`${p.displayName || "That person"} cannot be on a route: their account is not active or their role does not visit machines.`, 409, "not_a_visitor");
    }
  }
  const correlationId = correlationOf(opts.correlationId);
  const warnings: string[] = [];
  const created = await getServiceSql().begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`route_plan:${req.id}`}, 0))`;
    const found = await tx<{ id: string; asset_no: number; label: string; service_shift: ShiftWindow | null; service_note: string | null }[]>`
      select id, asset_no, label, service_shift, service_note from machine where asset_no = any(${stops.map((s) => s.assetNo)}::int[])`;
    const machines = new Map(found.map((m) => [m.asset_no, m.id]));
    for (const s of stops) if (!machines.has(s.assetNo)) throw new RouteRefused(`No machine numbered ${s.assetNo}.`, 404, "no_machine");
    // A machine's own rule ("Schedule rashid always Night"): said, not refused — the planner may know better today.
    for (const m of found) {
      if (m.service_shift && m.service_shift !== req.shiftWindow) {
        warnings.push(`${m.label} (${m.asset_no}) is serviced on the ${m.service_shift} shift only${m.service_note ? ` — ${m.service_note}` : ""}.`);
      }
    }
    const [old] = await tx<{ business_date: string; shift_window: string; state: string; note: string | null; note_by: string | null }[]>`
      select business_date::text, shift_window, state, note, note_by from route_plan where id = ${req.id} for update`;
    const synthetic = (await tx<{ s: boolean }[]>`select is_synthetic as s from employee where id = ${viewer.employeeId}`)[0]?.s ?? false;
    if (old) {
      if (old.state === "cancelled") throw new RouteRefused("This plan was cancelled — make a new one.", 409, "cancelled");
      if (old.business_date !== req.businessDate || old.shift_window !== req.shiftWindow) {
        throw new RouteRefused("A plan keeps its day and shift — make a new plan for another.", 409, "day_fixed");
      }
    }
    // Two active plans of one shift never share a name — renaming too: copying the day skips a name already there (review, 20 Oct).
    const [clash] = await tx<{ id: string }[]>`
      select id from route_plan where business_date = ${req.businessDate} and shift_window = ${req.shiftWindow}
         and lower(btrim(name)) = lower(${name}) and state = 'active' and id <> ${req.id}`;
    if (clash) throw new RouteRefused(`There is already a plan called ${name} for this shift.`, 409, "name_taken");
    // The words' author: whoever wrote them — kept while they stay as they are (0039).
    const noteBy = note === null ? null : old && old.note === note ? old.note_by : viewer.employeeId;
    if (!old) {
      await tx`
        insert into route_plan (id, business_date, shift_window, name, note, note_by, created_by, updated_by, is_synthetic, correlation_id)
        values (${req.id}, ${req.businessDate}, ${req.shiftWindow}, ${name}, ${note}, ${noteBy}, ${viewer.employeeId}, ${viewer.employeeId}, ${synthetic}, ${correlationId})`;
    }
    // The stops: those sent, in order; the rest taken off (kept for the visits that point at them). Locked, so a visit starting
    // at one now waits for this save, and this save for it (startVisit locks the stop it picks).
    const existing = await tx<{ id: string; machine_id: string; visited: boolean; removed: boolean; instructions: string | null; instructions_by: string | null }[]>`
      select s.id, s.machine_id, exists (select 1 from visit v where v.stop_id = s.id) as visited, s.removed_at is not null as removed,
             s.instructions, s.instructions_by
        from route_stop s where s.plan_id = ${req.id}
         for update of s`;
    const before = new Map(existing.map((e) => [e.id, e]));
    for (const s of stops) {
      const machineId = machines.get(s.assetNo)!;
      const was = before.get(s.id);
      // A visited stop keeps its machine — one taken off and sent again too (review, 20 Oct); 0039's guard says the same.
      if (was && was.machine_id !== machineId && was.visited) {
        throw new RouteRefused(`Machine ${s.assetNo}'s stop was already visited — take it off and add a new one instead of changing its machine.`, 409, "stop_visited");
      }
      const instructionsBy = s.instructions === null ? null : was && was.instructions === s.instructions ? was.instructions_by : viewer.employeeId;
      if (was) {
        await tx`
          update route_stop set seq = ${s.seq}, machine_id = ${machineId}, tasks = ${s.tasks}::text[], crates = ${s.crates},
                                instructions = ${s.instructions}, instructions_by = ${instructionsBy}, evidence = ${s.evidence}::text[], removed_at = null
           where id = ${s.id}`;
      } else {
        const [other] = await tx<{ plan_id: string }[]>`select plan_id from route_stop where id = ${s.id}`;
        if (other) throw new RouteRefused("A stop's id was already used on another plan.", 409, "id_reused");
        await tx`
          insert into route_stop (id, plan_id, seq, machine_id, tasks, crates, instructions, instructions_by, evidence, is_synthetic)
          values (${s.id}, ${req.id}, ${s.seq}, ${machineId}, ${s.tasks}::text[], ${s.crates}, ${s.instructions}, ${instructionsBy}, ${s.evidence}::text[], ${synthetic})`;
      }
    }
    const keep = new Set(stops.map((s) => s.id));
    const gone = existing.filter((e) => !e.removed && !keep.has(e.id)).map((e) => e.id);
    if (gone.length > 0) await tx`update route_stop set removed_at = now() where id = any(${gone}::uuid[])`;
    // The team, then the plan itself last: its live update reaches the team as it is now.
    await tx`delete from route_plan_member where plan_id = ${req.id}`;
    for (const id of memberIds) await tx`insert into route_plan_member (plan_id, employee_id) values (${req.id}, ${id})`;
    await tx`update route_plan set name = ${name}, note = ${note}, note_by = ${noteBy}, updated_by = ${viewer.employeeId}, updated_at = now() where id = ${req.id}`;
    await tx`
      insert into audit_log (correlation_id, actor, action, entity, entity_id, detail)
      values (${correlationId}, ${`employee:${viewer.employeeId}`}, ${old ? "route.plan_changed" : "route.plan_made"}, 'route_plan', ${req.id},
              ${tx.json({ date: req.businessDate, shift: req.shiftWindow, members: memberIds.length, stops: stops.length, removed: gone.length } as never)})`;
    return !old;
  });
  const crates = stops.reduce((t, s) => t + (s.crates ?? 0), 0);
  if (created) {
    await tellTeam(
      req.id,
      memberIds,
      `🗺️ Your route for ${planWhen(req.businessDate, req.shiftWindow)} is ready: ${stops.length} machine${stops.length === 1 ? "" : "s"}` +
        `${crates > 0 ? `, ${crates} crate${crates === 1 ? "" : "s"} of oranges to take from the warehouse` : ""}. Open FreshNow → Route.`,
      "route.plan_made",
      correlationId,
    );
  }
  return { id: req.id, created, warnings, crates };
}

/** A plan nobody will carry out. Its visits stay. */
export async function cancelPlan(viewer: ViewerOrg, planId: string, opts: { correlationId?: string } = {}): Promise<{ id: string; replay: boolean }> {
  requirePlanner(viewer);
  if (!UUID_RE.test(planId)) throw new RouteRefused("No such plan.", 404, "no_plan");
  const correlationId = correlationOf(opts.correlationId);
  const r = await getServiceSql().begin(async (tx) => {
    const [p] = await tx<{ state: string; business_date: string; shift_window: ShiftWindow }[]>`
      select state, business_date::text, shift_window from route_plan where id = ${planId} for update`;
    if (!p) throw new RouteRefused("No such plan.", 404, "no_plan");
    if (p.state === "cancelled") return { replay: true, p, members: [] as string[] };
    const members = (await tx<{ id: string }[]>`select employee_id as id from route_plan_member where plan_id = ${planId}`).map((m) => m.id);
    await tx`update route_plan set state = 'cancelled', updated_by = ${viewer.employeeId}, updated_at = now() where id = ${planId}`;
    await tx`
      insert into audit_log (correlation_id, actor, action, entity, entity_id, detail)
      values (${correlationId}, ${`employee:${viewer.employeeId}`}, 'route.plan_cancelled', 'route_plan', ${planId}, '{}'::jsonb)`;
    return { replay: false, p, members };
  });
  if (!r.replay) await tellTeam(planId, r.members, `🗺️ Your route for ${planWhen(r.p.business_date, r.p.shift_window)} was cancelled.`, "route.plan_cancelled", correlationId);
  return { id: planId, replay: r.replay };
}

/** A plan copyPlans left out, and why: its team's name is already on that day, or nobody on it can visit any more. */
export interface SkippedPlan {
  name: string;
  shiftWindow: ShiftWindow;
  why: "already_there" | "nobody_left";
}

/**
 * Yesterday's plans as the start of another day's: the same teams, the same machines and instructions. A plan
 * whose team name is already on that day for that shift is left alone, so copying twice copies once. What was left
 * out is said, by team (review, 20 Oct: a plan dropped silently left a team with no route).
 */
export async function copyPlans(
  viewer: ViewerOrg,
  req: { fromDate: string; toDate: string },
  opts: { correlationId?: string } = {},
): Promise<{ created: string[]; skipped: number; skippedPlans: SkippedPlan[] }> {
  requirePlanner(viewer);
  if (!DAY.test(req.fromDate) || !DAY.test(req.toDate)) throw new RouteRefused("A day is YYYY-MM-DD.", 400, "bad_day");
  if (req.fromDate === req.toDate) throw new RouteRefused("Copy to another day.", 400, "same_day");
  const correlationId = correlationOf(opts.correlationId);
  const sql = getServiceSql();
  const plans = await sql<{ id: string; shift_window: ShiftWindow; name: string; note: string | null; note_by: string | null }[]>`
    select id, shift_window, name, note, note_by from route_plan where business_date = ${req.fromDate} and state = 'active' order by shift_window, name`;
  const created: string[] = [];
  const skippedPlans: SkippedPlan[] = [];
  for (const p of plans) {
    const [there] = await sql<{ id: string }[]>`
      select id from route_plan where business_date = ${req.toDate} and shift_window = ${p.shift_window}
         and lower(btrim(name)) = lower(btrim(${p.name})) and state = 'active'`;
    if (there) {
      skippedPlans.push({ name: p.name, shiftWindow: p.shift_window, why: "already_there" });
      continue;
    }
    // Only the people who may still visit; only the stops still on the plan.
    const members: string[] = [];
    for (const m of await sql<{ id: string }[]>`select employee_id as id from route_plan_member where plan_id = ${p.id}`) {
      const who = await loadViewer(m.id);
      if (who && who.status === "active" && can(who, "visits.record")) members.push(m.id);
    }
    const stops = await sql<{ asset_no: number | null; tasks: StopTask[]; crates: number | null; instructions: string | null; evidence: EvidenceKind[] }[]>`
      select m.asset_no, s.tasks, s.crates, s.instructions, s.evidence from route_stop s join machine m on m.id = s.machine_id
       where s.plan_id = ${p.id} and s.removed_at is null and m.asset_no is not null order by s.seq`;
    if (members.length === 0) {
      skippedPlans.push({ name: p.name, shiftWindow: p.shift_window, why: "nobody_left" });
      continue;
    }
    const id = randomUUID();
    await savePlan(
      viewer,
      {
        id,
        businessDate: req.toDate,
        shiftWindow: p.shift_window,
        name: p.name,
        note: p.note,
        memberIds: members,
        stops: stops.map((s) => ({ id: randomUUID(), machineAssetNo: s.asset_no!, tasks: s.tasks, crates: s.crates, instructions: s.instructions, evidence: s.evidence })),
      },
      { correlationId },
    );
    // The words are still the author's, not the copier's (0039).
    await sql`update route_plan set copied_from = ${p.id}, note_by = ${p.note_by} where id = ${id}`;
    await sql`
      update route_stop t set instructions_by = f.instructions_by
        from route_stop f
       where t.plan_id = ${id} and f.plan_id = ${p.id} and f.removed_at is null and f.machine_id = t.machine_id
         and t.instructions is not distinct from f.instructions`;
    created.push(id);
  }
  return { created, skipped: skippedPlans.length, skippedPlans };
}

async function tellTeam(planId: string, members: readonly string[], text: string, kind: string, correlationId: string): Promise<void> {
  if (members.length === 0) return;
  try {
    await notifyPeople({
      recipients: members.map((employeeId) => ({ employeeId, reason: "you are on this route" })),
      keyFor: (id, ch) => `${kind}:${planId}:${id}:${ch}`,
      text,
      kind,
      presentation: { title: "Your route", url: "/app/#route", tag: `route-${planId}`, urgent: false },
      telegram: "fallback",
      correlationId,
    });
  } catch (err) {
    console.error("[routes] a notice failed", err);
  }
}

// ── reading plans ────────────────────────────────────────────────────────────
export interface StopVisit {
  id: string;
  employee: { id: string; name: string };
  startedAt: string;
  startedHow: "qr" | "typed";
  endedAt: string | null;
  tasksDone: StopTask[];
  /** The kinds of proof on the visit (taken-off ones not counted). */
  evidence: EvidenceKind[];
}

export interface PlanStop {
  id: string;
  seq: number;
  machine: { id: string; assetNo: number | null; label: string; serviceShift: ShiftWindow | null };
  tasks: StopTask[];
  /** Crates of oranges to load here. */
  crates: number | null;
  instructions: string | null;
  evidence: EvidenceKind[];
  visits: StopVisit[];
  /** Every kind of proof asked for is on one of its visits. */
  proofComplete: boolean;
  /** The proof asked for that no visit has. */
  missing: EvidenceKind[];
}

export interface PlanCard {
  id: string;
  businessDate: string;
  shiftWindow: ShiftWindow;
  name: string;
  note: string | null;
  state: "active" | "cancelled";
  members: { id: string; name: string }[];
  stops: PlanStop[];
  /** Crates of oranges the team takes from the warehouse for this plan: the stops' crates added up. */
  crates: number;
  updatedBy: { id: string; name: string };
  updatedAt: string;
  may: { edit: boolean };
}

async function namesOf(ids: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((x): x is string => typeof x === "string"))];
  if (want.length === 0) return new Map();
  const rows = await getServiceSql()<{ id: string; display_name: string }[]>`select id, display_name from employee where id = any(${want}::uuid[])`;
  return new Map(rows.map((r) => [r.id, r.display_name]));
}

/** Machines' numbers, names and service rule — read with the service role: a driver does not read the machine table. */
export async function machinesOf(ids: readonly (string | null | undefined)[]): Promise<Map<string, { assetNo: number | null; label: string; serviceShift: ShiftWindow | null }>> {
  const want = [...new Set(ids.filter((x): x is string => typeof x === "string"))];
  if (want.length === 0) return new Map();
  const rows = await getServiceSql()<{ id: string; asset_no: number | null; label: string; service_shift: ShiftWindow | null }[]>`
    select id, asset_no, label, service_shift from machine where id = any(${want}::uuid[])`;
  return new Map(rows.map((r) => [r.id, { assetNo: r.asset_no, label: r.label, serviceShift: r.service_shift }]));
}

/**
 * A machine's own service rule, set by a planner: the shift it may be serviced on ("Schedule rashid always Night")
 * and a line of why. A plan of the other shift is warned about when saved.
 */
export async function setMachineServiceRule(
  viewer: ViewerOrg,
  assetNo: number,
  rule: { shift: ShiftWindow | null; note?: string | null },
  opts: { correlationId?: string } = {},
): Promise<{ assetNo: number; shift: ShiftWindow | null; note: string | null }> {
  requirePlanner(viewer);
  if (!Number.isInteger(assetNo) || assetNo < 1 || assetNo > 99_999) throw new RouteRefused("A machine number is 1 to 99999.", 400, "bad_machine");
  if (rule.shift !== null && !(SHIFT_WINDOWS as readonly string[]).includes(rule.shift)) throw new RouteRefused("Day, night, or any shift.", 400, "bad_shift");
  const note = cleanText(rule.note, 300);
  const correlationId = correlationOf(opts.correlationId);
  return getServiceSql().begin(async (tx) => {
    const [m] = await tx<{ id: string }[]>`update machine set service_shift = ${rule.shift}, service_note = ${note}, updated_at = now() where asset_no = ${assetNo} returning id`;
    if (!m) throw new RouteRefused(`No machine numbered ${assetNo}.`, 404, "no_machine");
    await tx`
      insert into audit_log (correlation_id, actor, action, entity, entity_id, detail)
      values (${correlationId}, ${`employee:${viewer.employeeId}`}, 'route.machine_rule_set', 'machine', ${m.id}, ${tx.json({ shift: rule.shift, note } as never)})`;
    return { assetNo, shift: rule.shift, note };
  });
}

/** Plans by id, under the viewer's row security, with their teams, stops and the visits to each stop. */
async function loadPlans(tx: Tx, viewer: ViewerOrg, ids: readonly string[]): Promise<PlanCard[]> {
  if (ids.length === 0) return [];
  const plans = await tx<{ id: string; business_date: string; shift_window: ShiftWindow; name: string; note: string | null; state: "active" | "cancelled"; updated_by: string; updated_at: Date }[]>`
    select id, business_date::text, shift_window, name, note, state, updated_by, updated_at from route_plan where id = any(${ids}::uuid[])
     order by business_date, shift_window, lower(name)`;
  const members = await tx<{ plan_id: string; employee_id: string }[]>`select plan_id, employee_id from route_plan_member where plan_id = any(${ids}::uuid[])`;
  const stops = await tx<{ id: string; plan_id: string; seq: number; machine_id: string; tasks: StopTask[]; crates: number | null; instructions: string | null; evidence: EvidenceKind[] }[]>`
    select id, plan_id, seq, machine_id, tasks, crates, instructions, evidence from route_stop
     where plan_id = any(${ids}::uuid[]) and removed_at is null order by plan_id, seq`;
  // Visits to these stops — through the service role: a driver sees the whole team's progress on the plans
  // they are on (who did which machine), not only their own visits.
  const visits = stops.length === 0 ? [] : await getServiceSql()<{
    id: string;
    stop_id: string;
    employee_id: string;
    started_at: Date;
    started_how: "qr" | "typed";
    ended_at: Date | null;
    tasks_done: StopTask[];
    kinds: EvidenceKind[] | null;
  }[]>`
    select v.id, v.stop_id, v.employee_id, v.started_at, v.started_how, v.ended_at, v.tasks_done,
           (select array_agg(distinct e.kind) from visit_evidence e where e.visit_id = v.id and e.removed_at is null) as kinds
      from visit v where v.stop_id = any(${stops.map((s) => s.id)}::uuid[]) order by v.started_at`;
  const names = await namesOf([...members.map((m) => m.employee_id), ...plans.map((p) => p.updated_by), ...visits.map((v) => v.employee_id)]);
  const machines = await machinesOf(stops.map((s) => s.machine_id));
  const planner = viewer.status === "active" && can(viewer, "routes.plan");
  return plans.map((p) => ({
    id: p.id,
    businessDate: p.business_date,
    shiftWindow: p.shift_window,
    name: p.name,
    note: p.note,
    state: p.state,
    members: members.filter((m) => m.plan_id === p.id).map((m) => ({ id: m.employee_id, name: names.get(m.employee_id) ?? "—" })),
    updatedBy: { id: p.updated_by, name: names.get(p.updated_by) ?? "—" },
    updatedAt: p.updated_at.toISOString(),
    may: { edit: planner && p.state === "active" },
    crates: stops.filter((s) => s.plan_id === p.id).reduce((t, s) => t + (s.crates ?? 0), 0),
    stops: stops
      .filter((s) => s.plan_id === p.id)
      .map((s) => {
        const sv = visits.filter((v) => v.stop_id === s.id);
        const have = new Set(sv.flatMap((v) => v.kinds ?? []));
        const missing = s.evidence.filter((k) => !have.has(k));
        return {
          id: s.id,
          seq: s.seq,
          machine: { id: s.machine_id, ...(machines.get(s.machine_id) ?? { assetNo: null, label: "—", serviceShift: null }) },
          tasks: s.tasks,
          crates: s.crates,
          instructions: s.instructions,
          evidence: s.evidence,
          visits: sv.map((v) => ({
            id: v.id,
            employee: { id: v.employee_id, name: names.get(v.employee_id) ?? "—" },
            startedAt: v.started_at.toISOString(),
            startedHow: v.started_how,
            endedAt: v.ended_at?.toISOString() ?? null,
            tasksDone: v.tasks_done,
            evidence: v.kinds ?? [],
          })),
          proofComplete: sv.length > 0 && missing.length === 0,
          missing,
        };
      }),
  }));
}

/** The day's plans: all of them for whoever plans; the plans a person is on, otherwise. */
export async function plansOn(viewer: ViewerOrg, date: string): Promise<PlanCard[]> {
  if (viewer.status !== "active" || !(can(viewer, "routes.plan") || can(viewer, "visits.record"))) throw new RouteRefused("Routes are not part of your role.", 403, "not_allowed");
  if (!DAY.test(date)) throw new RouteRefused("A day is YYYY-MM-DD.", 400, "bad_day");
  return withContext(
    viewer,
    async (tx) => {
      const ids = (await tx<{ id: string }[]>`select id from route_plan where business_date = ${date}`).map((r) => r.id);
      return loadPlans(tx, viewer, ids);
    },
    { readOnly: true },
  );
}

/** One plan, for its editor. */
export async function planById(viewer: ViewerOrg, id: string): Promise<PlanCard | null> {
  if (!UUID_RE.test(id)) return null;
  return withContext(viewer, async (tx) => (await loadPlans(tx, viewer, [id]))[0] ?? null, { readOnly: true });
}

/** The days a person's current round covers: today, and last night's until noon (A-T61.9). */
export function roundDays(now: Date): { date: string; shifts: ShiftWindow[] }[] {
  const today = localDate(now);
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: "Asia/Dubai" }).format(now));
  const days: { date: string; shifts: ShiftWindow[] }[] = [{ date: today, shifts: ["day", "night"] }];
  if (hour < NIGHT_ENDS_HOUR) days.unshift({ date: localDate(new Date(now.getTime() - 86_400_000)), shifts: ["night"] });
  return days;
}

/**
 * The shift the clock is in, by the handovers (A-T58.4: 07:30 and 15:00, APP_SHIFT_HANDOVERS): before the first, last
 * night's; between them, today's day shift; from the second, tonight's. A visit carries out a stop of this shift's plans
 * first, and a visit off the plans is listed under this shift's day (review, 20 Oct).
 */
export function shiftAt(at: Date, times: readonly string[] = shiftHandovers()): { date: string; shift: ShiftWindow } {
  const [first, second] = [...times].sort();
  const hm = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Dubai" }).format(at);
  const today = localDate(at);
  if (first !== undefined && hm < first) return { date: localDate(new Date(at.getTime() - 86_400_000)), shift: "night" };
  if (second === undefined || hm < second) return { date: today, shift: "day" };
  return { date: today, shift: "night" };
}

/** The active plans of the person's current round, oldest first. */
export async function currentPlanIds(q: Tx, employeeId: string, now: Date): Promise<string[]> {
  const out: string[] = [];
  for (const d of roundDays(now)) {
    const rows = await q<{ id: string }[]>`
      select p.id from route_plan p join route_plan_member m on m.plan_id = p.id
       where m.employee_id = ${employeeId} and p.state = 'active' and p.business_date = ${d.date} and p.shift_window = any(${d.shifts}::text[])
       order by p.business_date, p.shift_window, lower(p.name)`;
    out.push(...rows.map((r) => r.id));
  }
  return out;
}

/** What the person has to do now: the plans of their round, with the team's progress at each stop. */
export async function myRound(viewer: ViewerOrg, now: Date = new Date()): Promise<{ plans: PlanCard[]; days: string[] }> {
  if (viewer.status !== "active" || !can(viewer, "visits.record")) throw new RouteRefused("Visits are not part of your role.", 403, "not_allowed");
  return withContext(
    viewer,
    async (tx) => {
      const ids = await currentPlanIds(tx, viewer.employeeId, now);
      return { plans: await loadPlans(tx, viewer, ids), days: roundDays(now).map((d) => d.date) };
    },
    { readOnly: true },
  );
}

/** The machines to choose from — number, name and service rule — for whoever plans or visits. */
export async function routeMachines(viewer: ViewerOrg): Promise<{ assetNo: number; label: string; serviceShift: ShiftWindow | null; serviceNote: string | null }[]> {
  if (viewer.status !== "active" || !(can(viewer, "routes.plan") || can(viewer, "visits.record"))) throw new RouteRefused("Routes are not part of your role.", 403, "not_allowed");
  const rows = await getServiceSql()<{ asset_no: number; label: string; service_shift: ShiftWindow | null; service_note: string | null }[]>`
    select asset_no, label, service_shift, service_note from machine where status = 'active' and asset_no is not null order by asset_no`;
  return rows.map((r) => ({ assetNo: r.asset_no, label: r.label, serviceShift: r.service_shift, serviceNote: r.service_note }));
}

/** People who can be put on a route — active, and their role visits machines. */
export async function routePeople(viewer: ViewerOrg): Promise<{ id: string; name: string; role: string }[]> {
  requirePlanner(viewer);
  const rows = await getServiceSql()<{ id: string; display_name: string; access_role: string }[]>`
    select id, display_name, access_role from employee where status = 'active' order by display_name`;
  const out: { id: string; name: string; role: string }[] = [];
  for (const r of rows) {
    const p = await loadViewer(r.id);
    if (p && can(p, "visits.record")) out.push({ id: r.id, name: r.display_name, role: r.access_role });
  }
  return out;
}

// ── the sheet's OK / NO, from the visits ─────────────────────────────────────
/** A visit the grid lists apart: at a machine on no stop of the day's plans, or on a stop since taken off, or a plan since cancelled. */
export type OffPlanVisit = StopVisit & { machine: { assetNo: number | null; label: string }; why: "off_plan" | "stop_removed" | "plan_cancelled" };

export interface GridRow {
  planId: string;
  team: string;
  shiftWindow: ShiftWindow;
  stop: PlanStop;
  /** For whoever sees the machines (televend.read): Televend's own record near the visit — the refill and the collection. */
  televend: { refillAt: string | null; refillCups: number | null; collectionAt: string | null } | null;
  /** The visit's fill and cash, from their ledgers: cartons (or whatever was put in) and whether cash was collected. */
  fill: { items: string; at: string } | null;
  cashCollected: boolean;
}

/**
 * The instruction sheet's OK / NO columns, worked out from the visits: for each stop of each plan of the day,
 * which proof is there, which is missing, the fill and the cash recorded at the visit, and — for the people who
 * run the machines — Televend's own refill and collection near it.
 */
export async function evidenceGrid(
  viewer: ViewerOrg,
  date: string,
): Promise<{ date: string; rows: GridRow[]; unplanned: OffPlanVisit[]; seesMachines: boolean }> {
  requirePlanner(viewer);
  if (!DAY.test(date)) throw new RouteRefused("A day is YYYY-MM-DD.", 400, "bad_day");
  const plans = await plansOn(viewer, date);
  const active = plans.filter((p) => p.state === "active");
  const sql = getServiceSql();
  const visitIds = active.flatMap((p) => p.stops.flatMap((s) => s.visits.map((v) => v.id)));
  // Everything put in at a stop, by every visit to it, item by item (review, 20 Oct: only the first visit's fill was shown).
  const fills = visitIds.length === 0 ? [] : await sql<{ stop_id: string; items: string; at: Date }[]>`
    select x.stop_id,
           string_agg(trim_scale(x.qty)::text || ' ' || (case when x.qty = 1 then x.unit when x.unit ~ '(x|s|sh|ch)$' then x.unit || 'es' else x.unit || 's' end) || ' ' || x.name, ', ' order by x.sort_order) as items,
           max(x.at) as at
      from (select v.stop_id, i.name, i.unit, i.sort_order, sum(l.qty) as qty, max(d.recorded_at) as at
              from visit_doc vd join visit v on v.id = vd.visit_id join stock_doc d on d.id = vd.stock_doc_id
              join stock_doc_line l on l.doc_id = d.id join inv_item i on i.id = l.item_id
             where vd.visit_id = any(${visitIds}::uuid[]) and d.state = 'posted'
             group by v.stop_id, i.id, i.name, i.unit, i.sort_order) x
     group by x.stop_id`;
  const cash = visitIds.length === 0 ? [] : await sql<{ visit_id: string }[]>`
    select vd.visit_id from visit_doc vd join cash_doc d on d.id = vd.cash_doc_id where vd.visit_id = any(${visitIds}::uuid[]) and d.state = 'posted'`;
  const seesMachines = can(viewer, "televend.read");
  const rows: GridRow[] = [];
  for (const p of active) {
    for (const s of p.stops) {
      const v = s.visits[s.visits.length - 1];
      let televend: GridRow["televend"] = null;
      if (seesMachines && v) {
        const at = new Date(v.startedAt);
        // Televend's log has a row per column filled, and corrections made later in the web app: the fills only,
        // summed, from an hour before the visit to two hours after — on the Televend records placed in this machine at
        // that time only (review, 20 Oct: a record moved to another machine brought that machine's refills along).
        const [ref] = await sql<{ at: Date | null; cups: string | null }[]>`
          select min(r.at) as at, sum(r.quantity_change)::text as cups from tv_refill r
           where r.machine_tv_id in (select p.tv_machine_id from machine_placement p
                                      where p.machine_id = ${s.machine.id} and p.valid_from <= ${at}::timestamptz + interval '120 minutes'
                                        and (p.valid_to is null or p.valid_to > ${at}::timestamptz - interval '60 minutes'))
             and r.action = 'filled'
             and r.at between ${at}::timestamptz - interval '60 minutes' and ${at}::timestamptz + interval '120 minutes'`;
        const [col] = await sql<{ at: Date }[]>`
          select e.started_at as at from tv_event e
           where e.machine_tv_id in (select p.tv_machine_id from machine_placement p
                                      where p.machine_id = ${s.machine.id} and p.valid_from <= ${at}::timestamptz + interval '120 minutes'
                                        and (p.valid_to is null or p.valid_to > ${at}::timestamptz - interval '60 minutes'))
             and e.name = 'Cash Collection'
             and e.started_at between ${at}::timestamptz - interval '60 minutes' and ${at}::timestamptz + interval '120 minutes'
           order by abs(extract(epoch from (e.started_at - ${at}::timestamptz))) limit 1`;
        televend = { refillAt: ref?.at?.toISOString() ?? null, refillCups: ref?.cups == null ? null : Number(ref.cups), collectionAt: col?.at.toISOString() ?? null };
      }
      const f = fills.find((y) => y.stop_id === s.id);
      rows.push({
        planId: p.id,
        team: p.name,
        shiftWindow: p.shiftWindow,
        stop: s,
        televend,
        fill: f ? { items: f.items, at: f.at.toISOString() } : null,
        cashCollected: s.visits.some((x) => cash.some((c) => c.visit_id === x.id)),
      });
    }
  }
  // Visits that no active stop of this day shows: at a machine on no stop, or on a stop since taken off, or on a plan since
  // cancelled (review, 20 Oct: those vanished from the page). A visit on a stop belongs to its plan's day; a visit off the plans
  // to the day of the shift it was made in — so none is listed under two days, and none under no day: its visitor may be on the
  // plans of the day before or after only (review of the fixes, 20 Oct).
  const around = await withContext(
    viewer,
    (tx) => tx<{ employee_id: string }[]>`
      select distinct m.employee_id from route_plan_member m join route_plan p on p.id = m.plan_id
       where p.business_date between ${date}::date - 1 and ${date}::date + 1`,
    { readOnly: true },
  );
  const memberIds = [...new Set([...plans.flatMap((p) => p.members.map((m) => m.id)), ...around.map((r) => r.employee_id)])];
  const extra = memberIds.length === 0 ? [] : await withContext(
    viewer,
    (tx) => tx<{ id: string; machine_id: string; employee_id: string; started_at: Date; started_how: "qr" | "typed"; ended_at: Date | null; tasks_done: StopTask[]; kinds: EvidenceKind[] | null; why: OffPlanVisit["why"]; plan_date: string | null }[]>`
      select v.id, v.machine_id, v.employee_id, v.started_at, v.started_how, v.ended_at, v.tasks_done,
             (select array_agg(distinct e.kind) from visit_evidence e where e.visit_id = v.id and e.removed_at is null) as kinds,
             case when v.stop_id is null then 'off_plan' when p.state = 'cancelled' then 'plan_cancelled' else 'stop_removed' end as why,
             p.business_date::text as plan_date
        from visit v
        left join route_stop s on s.id = v.stop_id
        left join route_plan p on p.id = s.plan_id
       where v.employee_id = any(${memberIds}::uuid[])
         and ((v.stop_id is null
               and v.started_at >= (${date}::date::timestamp at time zone 'Asia/Dubai')
               and v.started_at < ((${date}::date + 1)::timestamp at time zone 'Asia/Dubai') + interval '12 hours')
              or ((s.removed_at is not null or p.state = 'cancelled') and p.business_date = ${date}::date))
       order by v.started_at`,
    { readOnly: true },
  ).then((rows) => rows.filter((x) => x.why !== "off_plan" || shiftAt(x.started_at).date === date));
  const names = await namesOf(extra.map((x) => x.employee_id));
  const machines = await machinesOf(extra.map((x) => x.machine_id));
  return {
    date,
    rows,
    seesMachines,
    unplanned: extra.map((x) => ({
      id: x.id,
      employee: { id: x.employee_id, name: names.get(x.employee_id) ?? "—" },
      startedAt: x.started_at.toISOString(),
      startedHow: x.started_how,
      endedAt: x.ended_at?.toISOString() ?? null,
      tasksDone: x.tasks_done,
      evidence: x.kinds ?? [],
      machine: machines.get(x.machine_id) ?? { assetNo: null, label: "—" },
      why: x.why,
    })),
  };
}
