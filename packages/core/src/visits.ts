import { recordCollection } from "./cash.js";
import { getServiceSql, withContext, type Tx } from "./db.js";
import { UUID_RE, correlationOf, requestHash, type LineIn } from "./inventory-common.js";
import { recordUse } from "./inventory-ledger.js";
import type { ViewerOrg } from "./org.js";
import { can } from "./permissions.js";
import { EVIDENCE_KINDS, RouteRefused, STOP_TASKS, currentPlanIds, shiftAt, type EvidenceKind, type StopTask } from "./routes.js";

/**
 * Visits (TASK-061 part 2, migration 0036): someone at a machine, with the proof the plan asks for.
 *
 *   startVisit     by the machine's sticker link (the phone's camera reads the code and opens it) or its number
 *                  typed in — the visit records which. It carries out the stop for this machine on the person's
 *                  current round, if there is one; otherwise it is a visit off the plan.
 *   addEvidence    a photo or video the person took, as one kind of proof (normal pic, re-sorting pic, the white
 *                  fruit dispenser's video, other); taken off again while the visit is open, never swapped
 *   setTasksDone   what was done, ticked
 *   recordVisitFill / recordVisitCash   the stock put into the machine and the cash taken out — posted on their
 *                  own ledgers (stock: used, into this machine; cash: collected from it) and linked to the visit
 *   endVisit       what proof is missing is said, not refused: the planner sees it as the sheet's red NO
 *
 * A visit records which machine and when — nothing about where anyone is in between. One visit at a time per
 * person; it never changes once ended.
 */

const PHOTO_KINDS: readonly EvidenceKind[] = ["normal_photo", "resorting_photo", "other_photo"];

function requireVisitor(viewer: ViewerOrg): void {
  if (viewer.status !== "active" || !can(viewer, "visits.record")) throw new RouteRefused("Visits are not part of your role.", 403, "not_allowed");
}

const cleanText = (s: string | null | undefined, max: number): string | null => {
  const t = s?.trim();
  return t ? t.slice(0, max) : null;
};

function deviceTime(at: string | Date | null | undefined): Date | null {
  if (at === null || at === undefined || at === "") return null;
  const d = at instanceof Date ? at : new Date(at);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function auditIn(tx: Tx, a: { correlationId: string; actor: string; action: string; visitId: string; detail: Record<string, unknown> }): Promise<void> {
  await tx`
    insert into audit_log (correlation_id, actor, action, entity, entity_id, detail)
    values (${a.correlationId}, ${a.actor}, ${a.action}, 'visit', ${a.visitId}, ${tx.json(a.detail as never)})`;
}

interface VisitRow {
  id: string;
  machine_id: string;
  employee_id: string;
  stop_id: string | null;
  started_at: Date;
  device_at: Date | null;
  ended_at: Date | null;
  tasks_done: StopTask[];
  asset_no: number | null;
  label: string;
}

/** The person's own visit, locked — open unless said otherwise. */
async function ownVisit(tx: Tx, viewer: ViewerOrg, visitId: string, opts: { open?: boolean } = {}): Promise<VisitRow> {
  if (!UUID_RE.test(visitId)) throw new RouteRefused("No such visit.", 404, "no_visit");
  const [v] = await tx<VisitRow[]>`
    select v.id, v.machine_id, v.employee_id, v.stop_id, v.started_at, v.device_at, v.ended_at, v.tasks_done, m.asset_no, m.label
      from visit v join machine m on m.id = v.machine_id where v.id = ${visitId} for update of v`;
  if (!v || v.employee_id !== viewer.employeeId) throw new RouteRefused("No such visit of yours.", 404, "no_visit");
  if (opts.open !== false && v.ended_at) throw new RouteRefused("This visit has ended — start a new one at the machine.", 409, "visit_ended");
  return v;
}

// ── starting ─────────────────────────────────────────────────────────────────
export interface VisitStarted {
  visitId: string;
  machine: { assetNo: number | null; label: string };
  stopId: string | null;
  replay: boolean;
}

export async function startVisit(
  viewer: ViewerOrg,
  req: { id: string; machineAssetNo?: number | null; qrToken?: string | null; deviceAt?: string | Date | null },
  opts: { correlationId?: string; now?: Date } = {},
): Promise<VisitStarted> {
  requireVisitor(viewer);
  if (!UUID_RE.test(req.id)) throw new RouteRefused("The visit's id must be a UUID made by the app.", 400, "bad_id");
  const how: "qr" | "typed" = req.qrToken ? "qr" : "typed";
  if (how === "qr" && !UUID_RE.test(req.qrToken!)) throw new RouteRefused("This sticker is not one of FreshNow's machines.", 404, "no_machine");
  if (how === "typed") {
    const n = req.machineAssetNo;
    if (n === null || n === undefined || !Number.isInteger(n) || n < 1 || n > 99_999) throw new RouteRefused("Type the number on the machine's sticker.", 400, "bad_machine");
  }
  const me = viewer.employeeId;
  const now = opts.now ?? new Date();
  const correlationId = correlationOf(opts.correlationId);
  return getServiceSql().begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`visit:${me}`}, 0))`;
    const [m] =
      how === "qr"
        ? await tx<{ id: string; asset_no: number | null; label: string }[]>`select id, asset_no, label from machine where qr_token = ${req.qrToken!}`
        : await tx<{ id: string; asset_no: number | null; label: string }[]>`select id, asset_no, label from machine where asset_no = ${req.machineAssetNo!}`;
    if (!m) throw new RouteRefused(how === "qr" ? "This sticker is not one of FreshNow's machines." : `No machine numbered ${req.machineAssetNo}.`, 404, "no_machine");
    const machine = { assetNo: m.asset_no, label: m.label };
    const hash = requestHash({ machine: m.id, how });
    const [old] = await tx<{ request_hash: string; stop_id: string | null }[]>`select request_hash, stop_id from visit where id = ${req.id}`;
    if (old) {
      if (old.request_hash !== hash) throw new RouteRefused("This visit id was already used for another machine.", 409, "id_reused");
      return { visitId: req.id, machine, stopId: old.stop_id, replay: true };
    }
    const [open] = await tx<{ id: string; machine_id: string; stop_id: string | null; label: string }[]>`
      select v.id, v.machine_id, v.stop_id, mm.label from visit v join machine mm on mm.id = v.machine_id
       where v.employee_id = ${me} and v.ended_at is null`;
    if (open) {
      // At the same machine: carry on with it. At another: one visit at a time.
      if (open.machine_id === m.id) return { visitId: open.id, machine, stopId: open.stop_id, replay: true };
      throw new RouteRefused(`You are still at ${open.label} — end that visit first.`, 409, "visit_open");
    }
    // The stop this visit carries out: this machine on the person's current round — on the plans of the shift being worked
    // first (a second visit at 02:00 adds to last night's stop, not tomorrow night's: review, 20 Oct), then on a shift already
    // begun before one still to come (a night team still out at 07:40 adds to last night's, not tonight's: review of the
    // fixes), then one nobody has visited yet, then the first. Locked until this visit is in, so a planner's save cannot
    // change its machine meanwhile.
    const planIds = await currentPlanIds(tx, me, now);
    const cur = shiftAt(now);
    const [stop] = planIds.length === 0
      ? []
      : await tx<{ id: string }[]>`
          select s.id from route_stop s join route_plan p on p.id = s.plan_id
           where s.plan_id = any(${planIds}::uuid[]) and s.machine_id = ${m.id} and s.removed_at is null
           order by (p.business_date = ${cur.date}::date and p.shift_window = ${cur.shift}) desc,
                    -- 'day' sorts before 'night': a later date, or tonight after today's day shift, is still to come.
                    (p.business_date, p.shift_window) > (${cur.date}::date, ${cur.shift}::text),
                    exists (select 1 from visit v where v.stop_id = s.id), array_position(${planIds}::uuid[], s.plan_id), s.seq
           limit 1
           for share of s`;
    const synthetic = (await tx<{ s: boolean }[]>`select is_synthetic as s from employee where id = ${me}`)[0]?.s ?? false;
    await tx`
      insert into visit (id, machine_id, employee_id, stop_id, started_at, started_how, device_at, request_hash, is_synthetic, correlation_id)
      values (${req.id}, ${m.id}, ${me}, ${stop?.id ?? null}, ${now}, ${how}, ${deviceTime(req.deviceAt)}, ${hash}, ${synthetic}, ${correlationId})`;
    await auditIn(tx, { correlationId, actor: `employee:${me}`, action: "visit.started", visitId: req.id, detail: { machineAssetNo: m.asset_no, how, stopId: stop?.id ?? null } });
    return { visitId: req.id, machine, stopId: stop?.id ?? null, replay: false };
  });
}

// ── during the visit ─────────────────────────────────────────────────────────
export async function addEvidence(viewer: ViewerOrg, visitId: string, req: { kind: EvidenceKind; mediaId: string }, opts: { correlationId?: string } = {}): Promise<VisitDetail> {
  requireVisitor(viewer);
  if (!(EVIDENCE_KINDS as readonly string[]).includes(req.kind)) throw new RouteRefused("Unknown kind of proof.", 400, "bad_evidence");
  if (!UUID_RE.test(req.mediaId)) throw new RouteRefused("A photo id is not valid.", 400, "bad_photo");
  const correlationId = correlationOf(opts.correlationId);
  await getServiceSql().begin(async (tx) => {
    const v = await ownVisit(tx, viewer, visitId);
    const [media] = await tx<{ mime: string; uploaded_by: string | null; uploaded_at: Date }[]>`
      select mime, uploaded_by, uploaded_at from media_object where id = ${req.mediaId}`;
    if (!media || media.uploaded_by !== viewer.employeeId) throw new RouteRefused("Add only photos and videos you took yourself.", 400, "not_your_photo");
    // Proof of this visit is taken at it: one picture never proves two visits, nor one sent before this visit began
    // (review, 20 Oct). "Began" is the phone's time when the start waited in its queue (at most 12 h earlier than it reached
    // FreshNow), with five minutes for an upload racing the start.
    const [elsewhere] = await tx<{ n: number }[]>`select count(*)::int as n from visit_evidence where media_id = ${req.mediaId} and visit_id <> ${v.id}`;
    if (elsewhere!.n > 0) throw new RouteRefused("That photo or video is already proof of another visit — take a new one here.", 400, "photo_used");
    const queued = v.device_at && v.device_at < v.started_at && v.started_at.getTime() - v.device_at.getTime() <= 12 * 3_600_000;
    const began = queued ? v.device_at! : v.started_at;
    if (media.uploaded_at.getTime() < began.getTime() - 5 * 60_000) {
      throw new RouteRefused("That photo or video was taken before this visit began — take a new one at the machine.", 400, "photo_too_old");
    }
    if (req.kind === "dispenser_video" && media.mime !== "video/mp4") throw new RouteRefused("The dispenser's proof is a short video.", 400, "video_needed");
    if (PHOTO_KINDS.includes(req.kind) && media.mime !== "image/jpeg") throw new RouteRefused("This proof is a photo.", 400, "photo_needed");
    const [there] = await tx<{ kind: string; removed_at: Date | null }[]>`
      select kind, removed_at from visit_evidence where visit_id = ${v.id} and media_id = ${req.mediaId}`;
    if (there) {
      if (there.kind !== req.kind || there.removed_at) throw new RouteRefused("This photo or video is already on the visit.", 409, "already_added");
      return;
    }
    const synthetic = (await tx<{ s: boolean }[]>`select is_synthetic as s from employee where id = ${viewer.employeeId}`)[0]?.s ?? false;
    await tx`
      insert into visit_evidence (visit_id, kind, media_id, added_by, is_synthetic)
      values (${v.id}, ${req.kind}, ${req.mediaId}, ${viewer.employeeId}, ${synthetic})`;
    await tx`
      insert into media_link (media_id, entity_type, entity_id, role, linked_by, correlation_id)
      values (${req.mediaId}, 'visit', ${v.id}, 'evidence', ${viewer.employeeId}, ${correlationId}) on conflict do nothing`;
    await auditIn(tx, { correlationId, actor: `employee:${viewer.employeeId}`, action: "visit.evidence_added", visitId: v.id, detail: { kind: req.kind } });
  });
  return (await visitDetail(viewer, visitId))!;
}

/** Take a photo or video off the visit (the wrong one), while it is open. */
export async function removeEvidence(viewer: ViewerOrg, visitId: string, evidenceId: string, opts: { correlationId?: string } = {}): Promise<VisitDetail> {
  requireVisitor(viewer);
  if (!UUID_RE.test(evidenceId)) throw new RouteRefused("No such proof.", 404, "no_evidence");
  const correlationId = correlationOf(opts.correlationId);
  await getServiceSql().begin(async (tx) => {
    const v = await ownVisit(tx, viewer, visitId);
    const r = await tx`update visit_evidence set removed_at = now() where id = ${evidenceId} and visit_id = ${v.id} and removed_at is null`;
    if (r.count > 0) await auditIn(tx, { correlationId, actor: `employee:${viewer.employeeId}`, action: "visit.evidence_removed", visitId: v.id, detail: { evidenceId } });
  });
  return (await visitDetail(viewer, visitId))!;
}

export async function setTasksDone(viewer: ViewerOrg, visitId: string, req: { tasks: readonly StopTask[] }): Promise<VisitDetail> {
  requireVisitor(viewer);
  const tasks = [...new Set(req.tasks)];
  if (tasks.some((t) => !(STOP_TASKS as readonly string[]).includes(t))) throw new RouteRefused("Unknown task.", 400, "bad_task");
  await getServiceSql().begin(async (tx) => {
    const v = await ownVisit(tx, viewer, visitId);
    await tx`update visit set tasks_done = ${tasks}::text[] where id = ${v.id}`;
  });
  return (await visitDetail(viewer, visitId))!;
}

/**
 * Link what a visit posted on a ledger — run inside the ledger's own transaction, so the post and its link commit together
 * (review, 20 Oct: a link that failed after the post left stock or cash with no visit). The visit must still be open, unless
 * this exact entry is already linked to it (a repeat of the same request). The cash also ticks "Cash" (a fill is part of a
 * full or half service the person ticks).
 */
const linkAndTick =
  (visitId: string, kind: "stock" | "cash", task: StopTask | null) =>
  async (tx: Tx, docId: string): Promise<void> => {
    const [v] = await tx<{ ended_at: Date | null }[]>`select ended_at from visit where id = ${visitId} for update`;
    const [linked] = await tx<{ n: number }[]>`
      select count(*)::int as n from visit_doc where visit_id = ${visitId} and ${tx(kind === "stock" ? "stock_doc_id" : "cash_doc_id")} = ${docId}`;
    if (linked!.n > 0) return;
    if (!v || v.ended_at) throw new RouteRefused("This visit has ended — start a new one at the machine.", 409, "visit_ended");
    await tx`
      insert into visit_doc (visit_id, stock_doc_id, cash_doc_id)
      values (${visitId}, ${kind === "stock" ? docId : null}, ${kind === "cash" ? docId : null}) on conflict do nothing`;
    if (task) await tx`update visit set tasks_done = array_append(tasks_done, ${task}) where id = ${visitId} and not (${task} = any(tasks_done))`;
  };

/**
 * The stock put into the machine, from what the person holds — on the stock ledger as "used, into a machine"
 * (TASK-060), linked to the visit. The same request twice posts once (the ledger's rule).
 */
export async function recordVisitFill(
  viewer: ViewerOrg,
  visitId: string,
  req: { id: string; lines: readonly LineIn[]; mediaIds?: readonly string[] },
  opts: { correlationId?: string } = {},
): Promise<VisitDetail> {
  requireVisitor(viewer);
  const v = await getServiceSql().begin((tx) => ownVisit(tx, viewer, visitId));
  await recordUse(
    viewer,
    {
      id: req.id,
      kind: "use",
      from: "mine",
      reason: "machine_refill",
      machineAssetNo: v.asset_no,
      lines: req.lines,
      ...(req.mediaIds ? { mediaIds: req.mediaIds } : {}),
    },
    { ...opts, within: linkAndTick(v.id, "stock", null) },
  );
  return (await visitDetail(viewer, visitId))!;
}

/** The cash taken out of the machine — on the cash ledger (TASK-061 part 1), with its photo, linked to the visit. */
export async function recordVisitCash(
  viewer: ViewerOrg,
  visitId: string,
  req: { id: string; amountFils: number; mediaIds: readonly string[]; note?: string | null },
  opts: { correlationId?: string } = {},
): Promise<VisitDetail> {
  requireVisitor(viewer);
  const v = await getServiceSql().begin((tx) => ownVisit(tx, viewer, visitId));
  if (v.asset_no === null) throw new RouteRefused("This machine has no number — record its cash in Cash.", 409, "machine_unnumbered");
  await recordCollection(
    viewer,
    { id: req.id, machineAssetNo: v.asset_no, amountFils: req.amountFils, mediaIds: req.mediaIds, ...(req.note ? { note: req.note } : {}) },
    { ...opts, within: linkAndTick(v.id, "cash", "cash") },
  );
  return (await visitDetail(viewer, visitId))!;
}

/**
 * End the visit. Missing proof is said, not refused — the planner sees it, as the sheet's red NO. A planner may
 * end someone's visit they forgot to end (it blocks their next one).
 */
export async function endVisit(
  viewer: ViewerOrg,
  visitId: string,
  req: { note?: string | null } = {},
  opts: { correlationId?: string; now?: Date } = {},
): Promise<{ visitId: string; missing: EvidenceKind[]; tasksLeft: StopTask[]; replay: boolean }> {
  if (!UUID_RE.test(visitId)) throw new RouteRefused("No such visit.", 404, "no_visit");
  const note = cleanText(req.note, 500);
  const correlationId = correlationOf(opts.correlationId);
  const r = await getServiceSql().begin(async (tx) => {
    const [v] = await tx<{ employee_id: string; ended_at: Date | null; stop_id: string | null; tasks_done: StopTask[] }[]>`
      select employee_id, ended_at, stop_id, tasks_done from visit where id = ${visitId} for update`;
    if (!v) throw new RouteRefused("No such visit.", 404, "no_visit");
    const own = v.employee_id === viewer.employeeId;
    if (own) requireVisitor(viewer);
    else if (viewer.status !== "active" || !can(viewer, "routes.plan")) throw new RouteRefused("No such visit of yours.", 404, "no_visit");
    // The note on a visit is the visitor's own words (their download lists it as theirs): a planner ending someone's visit
    // writes nothing on it (review, 20 Oct).
    if (!own && note) throw new RouteRefused("A note on someone else's visit is not kept — message them instead.", 400, "note_not_yours");
    if (v.ended_at) return { v, replay: true };
    await tx`update visit set ended_at = greatest(${opts.now ?? new Date()}::timestamptz, started_at), note = coalesce(${note}, note) where id = ${visitId}`;
    await auditIn(tx, { correlationId, actor: `employee:${viewer.employeeId}`, action: "visit.ended", visitId, detail: { forOther: !own } });
    return { v, replay: false };
  });
  const sql = getServiceSql();
  const [stop] = r.v.stop_id
    ? await sql<{ tasks: StopTask[]; evidence: EvidenceKind[] }[]>`select tasks, evidence from route_stop where id = ${r.v.stop_id}`
    : [];
  const have = new Set(
    (await sql<{ kind: EvidenceKind }[]>`select distinct kind from visit_evidence where visit_id = ${visitId} and removed_at is null`).map((x) => x.kind),
  );
  return {
    visitId,
    missing: (stop?.evidence ?? []).filter((k) => !have.has(k)),
    tasksLeft: (stop?.tasks ?? []).filter((t) => !r.v.tasks_done.includes(t)),
    replay: r.replay,
  };
}

// ── reading ──────────────────────────────────────────────────────────────────
export interface VisitDetail {
  id: string;
  employee: { id: string; name: string };
  machine: { id: string; assetNo: number | null; label: string };
  startedAt: string;
  startedHow: "qr" | "typed";
  endedAt: string | null;
  tasksDone: StopTask[];
  note: string | null;
  /** The plan's stop this visit carries out: what to do, and the proof asked for. */
  stop: { id: string; planId: string; team: string; tasks: StopTask[]; instructions: string | null; evidence: EvidenceKind[] } | null;
  evidence: { id: string; kind: EvidenceKind; mediaId: string | null; addedAt: string }[];
  /** The proof the stop asks for that the visit does not have yet. */
  missing: EvidenceKind[];
  fills: { docId: string; items: string; state: string }[];
  /** The cash taken out: the amount for the person themself and whoever sees all cash; that it was, for the rest. */
  cash: { docId: string; amountFils: number | null; state: string }[];
  may: { change: boolean; end: boolean };
}

export async function visitDetail(viewer: ViewerOrg, visitId: string): Promise<VisitDetail | null> {
  if (!UUID_RE.test(visitId)) return null;
  return withContext(
    viewer,
    async (tx) => {
      const [v] = await tx<{ id: string; employee_id: string; machine_id: string; started_at: Date; started_how: "qr" | "typed"; ended_at: Date | null; tasks_done: StopTask[]; note: string | null; stop_id: string | null }[]>`
        select id, employee_id, machine_id, started_at, started_how, ended_at, tasks_done, note, stop_id from visit where id = ${visitId}`;
      if (!v) return null;
      const sql = getServiceSql();
      const [stop] = v.stop_id
        ? await sql<{ id: string; plan_id: string; team: string; tasks: StopTask[]; instructions: string | null; evidence: EvidenceKind[] }[]>`
            select s.id, s.plan_id, p.name as team, s.tasks, s.instructions, s.evidence from route_stop s join route_plan p on p.id = s.plan_id where s.id = ${v.stop_id}`
        : [];
      const evidence = await tx<{ id: string; kind: EvidenceKind; media_id: string | null; added_at: Date }[]>`
        select id, kind, media_id, added_at from visit_evidence where visit_id = ${visitId} and removed_at is null order by added_at`;
      const docs = await sql<{ stock_doc_id: string | null; cash_doc_id: string | null }[]>`select stock_doc_id, cash_doc_id from visit_doc where visit_id = ${visitId}`;
      const stockIds = docs.map((d) => d.stock_doc_id).filter((x): x is string => x !== null);
      const cashIds = docs.map((d) => d.cash_doc_id).filter((x): x is string => x !== null);
      const fills = stockIds.length === 0 ? [] : await sql<{ id: string; state: string; items: string }[]>`
        select d.id, d.state, string_agg(trim_scale(l.qty)::text || ' ' || (case when l.qty = 1 then i.unit when i.unit ~ '(x|s|sh|ch)$' then i.unit || 'es' else i.unit || 's' end) || ' ' || i.name, ', ' order by i.sort_order) as items
          from stock_doc d join stock_doc_line l on l.doc_id = d.id join inv_item i on i.id = l.item_id
         where d.id = any(${stockIds}::uuid[]) group by d.id, d.state`;
      const cash = cashIds.length === 0 ? [] : await sql<{ id: string; state: string; amount_fils: string }[]>`
        select id, state, amount_fils::text from cash_doc where id = any(${cashIds}::uuid[])`;
      const [who] = await sql<{ n: string }[]>`select display_name as n from employee where id = ${v.employee_id}`;
      const [m] = await sql<{ asset_no: number | null; label: string }[]>`select asset_no, label from machine where id = ${v.machine_id}`;
      const own = v.employee_id === viewer.employeeId;
      const seesAmounts = own || (viewer.status === "active" && can(viewer, "cash.read"));
      const have = new Set(evidence.map((e) => e.kind));
      return {
        id: v.id,
        employee: { id: v.employee_id, name: who?.n ?? "—" },
        machine: { id: v.machine_id, assetNo: m?.asset_no ?? null, label: m?.label ?? "—" },
        startedAt: v.started_at.toISOString(),
        startedHow: v.started_how,
        endedAt: v.ended_at?.toISOString() ?? null,
        tasksDone: v.tasks_done,
        note: v.note,
        stop: stop ? { id: stop.id, planId: stop.plan_id, team: stop.team, tasks: stop.tasks, instructions: stop.instructions, evidence: stop.evidence } : null,
        evidence: evidence.map((e) => ({ id: e.id, kind: e.kind, mediaId: e.media_id, addedAt: e.added_at.toISOString() })),
        missing: (stop?.evidence ?? []).filter((k) => !have.has(k)),
        fills: fills.map((f) => ({ docId: f.id, items: f.items, state: f.state })),
        cash: cash.map((c) => ({ docId: c.id, amountFils: seesAmounts ? Number(c.amount_fils) : null, state: c.state })),
        may: {
          change: own && v.ended_at === null && viewer.status === "active",
          end: v.ended_at === null && viewer.status === "active" && (own || can(viewer, "routes.plan")),
        },
      };
    },
    { readOnly: true },
  );
}

/** The person's visit still open, if any. */
export async function openVisitOf(viewer: ViewerOrg): Promise<VisitDetail | null> {
  const [v] = await getServiceSql()<{ id: string }[]>`select id from visit where employee_id = ${viewer.employeeId} and ended_at is null`;
  return v ? visitDetail(viewer, v.id) : null;
}

/** A machine named by its sticker's token — for the page the sticker's link opens. */
export async function machineByToken(viewer: ViewerOrg, token: string): Promise<{ assetNo: number | null; label: string } | null> {
  requireVisitor(viewer);
  if (!UUID_RE.test(token)) return null;
  const [m] = await getServiceSql()<{ asset_no: number | null; label: string }[]>`select asset_no, label from machine where qr_token = ${token}`;
  return m ? { assetNo: m.asset_no, label: m.label } : null;
}
