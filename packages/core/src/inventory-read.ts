import { getServiceSql, withContext, type Tx } from "./db.js";
import { finalFigure, type CountKind } from "./inventory-counts.js";
import { InventoryRefused, PLACE, mayConfirm, toMilli } from "./inventory-ledger.js";
import { figuresHiddenFrom } from "./inventory-notify.js";
import type { ViewerOrg } from "./org.js";
import { can, ROLE_INFO, isAccessRole } from "./permissions.js";
import { localDate } from "./time.js";

/**
 * What the Inventory portal shows (TASK-060) — every number summed by Postgres over the ledger, under the
 * viewer's row-level security: whoever sees all stock (inventory.read) sees every place; anyone else
 * sees their own stock and the handovers that concern them, and nothing more.
 *
 * Names come from the employee table, looked up for the people the viewer's own rows mention — never a
 * list of everyone — so an erased person's name is gone here too.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const num = (q: string | null | undefined): number => (q === null || q === undefined ? 0 : toMilli(q) / 1000);

export interface InventoryAbilities {
  read: boolean;
  hold: boolean;
  move: boolean;
  approve: boolean;
}

export function abilitiesOf(viewer: ViewerOrg): InventoryAbilities {
  const active = viewer.status === "active";
  return {
    read: active && can(viewer, "inventory.read"),
    hold: active && can(viewer, "inventory.hold"),
    move: active && can(viewer, "inventory.move"),
    approve: active && can(viewer, "inventory.approve"),
  };
}

function requireAny(viewer: ViewerOrg): InventoryAbilities {
  const a = abilitiesOf(viewer);
  if (!a.read && !a.hold) throw new InventoryRefused("Stock is not part of your role.", 403, "not_allowed");
  return a;
}

async function namesOf(ids: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((x): x is string => typeof x === "string"))];
  if (want.length === 0) return new Map();
  const rows = await getServiceSql()<{ id: string; display_name: string }[]>`select id, display_name from employee where id = any(${want}::uuid[])`;
  return new Map(rows.map((r) => [r.id, r.display_name]));
}

// ── shapes ───────────────────────────────────────────────────────────────────
export interface ItemNow {
  id: string;
  name: string;
  category: string;
  unit: string;
  step: number;
  icon: string | null;
  minLevel: number | null;
  countTolerance: number;
  active: boolean;
  /** In the warehouse now — null while this viewer is counting it (InventoryHome.figuresHidden). */
  warehouse: number | null;
  /** Held by people now (vans, pockets, machines not yet filled). */
  withPeople: number;
  /** Handed over and not yet confirmed by the other side. */
  inTransit: number;
  /** Below its minimum in the warehouse (🚨); false when no minimum is set. */
  low: boolean;
}

export interface Held {
  itemId: string;
  name: string;
  unit: string;
  /** The smallest amount anyone enters — the screens of a person who cannot see the catalogue need it too. */
  step: number;
  icon: string | null;
  qty: number;
}

export interface PlaceRef {
  kind: string;
  id: string;
  /** The person's name for a person's place; the place's own name otherwise. */
  name: string;
  employeeId: string | null;
}

export interface DocLine {
  itemId: string;
  name: string;
  unit: string;
  step: number;
  icon: string | null;
  /** As the document says: sent, received, used … */
  qty: number;
  /** A handover: what the receiver took, what is still in transit, what went back, what was written off. */
  accepted?: number;
  pending?: number;
  back?: number;
  writtenOff?: number;
  variety?: string | null;
  cartonKg?: number | null;
}

export interface DocCard {
  id: string;
  kind: string;
  state: string;
  from: PlaceRef;
  to: PlaceRef;
  createdBy: { id: string; name: string };
  confirm: { side: "person" | "warehouse"; person: { id: string; name: string } | null } | null;
  answeredBy: { id: string; name: string } | null;
  answeredAt: string | null;
  answerReason: string | null;
  answerNote: string | null;
  settledBy: { id: string; name: string } | null;
  settledAt: string | null;
  reason: string | null;
  note: string | null;
  supplier: string | null;
  invoiceNo: string | null;
  machine: { assetNo: number | null; label: string } | null;
  reversesDocId: string | null;
  reversedByDocId: string | null;
  countSessionId: string | null;
  recordedAt: string;
  lines: DocLine[];
  photos: string[];
  /** What this viewer may do with it now. */
  may: { answer: boolean; cancel: boolean; settle: boolean; reverse: boolean };
}

interface DocRow {
  id: string;
  kind: string;
  state: string;
  from_location_id: string;
  to_location_id: string;
  from_kind: string;
  to_kind: string;
  from_name: string | null;
  to_name: string | null;
  from_employee: string | null;
  to_employee: string | null;
  created_by: string;
  confirm_side: "person" | "warehouse" | null;
  confirm_by: string | null;
  answered_by: string | null;
  answered_at: Date | null;
  answer_reason: string | null;
  answer_note: string | null;
  settled_by: string | null;
  settled_at: Date | null;
  reason: string | null;
  note: string | null;
  supplier: string | null;
  invoice_no: string | null;
  machine_id: string | null;
  asset_no: number | null;
  machine_label: string | null;
  reverses_doc_id: string | null;
  reversed_by: string | null;
  count_session_id: string | null;
  recorded_at: Date;
}

/** Documents by id, under the viewer's row security, with lines, handover progress and photos. */
async function loadDocs(tx: Tx, viewer: ViewerOrg, ids: readonly string[]): Promise<DocCard[]> {
  if (ids.length === 0) return [];
  const rows = await tx<DocRow[]>`
    select d.id, d.kind, d.state, d.from_location_id, d.to_location_id,
           lf.kind as from_kind, lt.kind as to_kind, lf.name as from_name, lt.name as to_name,
           lf.employee_id as from_employee, lt.employee_id as to_employee,
           d.created_by, d.confirm_side, d.confirm_by, d.answered_by, d.answered_at, d.answer_reason, d.answer_note,
           d.settled_by, d.settled_at, d.reason, d.note, d.supplier, d.invoice_no, d.machine_id, null::int as asset_no, null::text as machine_label,
           d.reverses_doc_id, (select r.id from stock_doc r where r.reverses_doc_id = d.id) as reversed_by,
           d.count_session_id, d.recorded_at
      from stock_doc d
      join inv_location lf on lf.id = d.from_location_id
      join inv_location lt on lt.id = d.to_location_id
     where d.id = any(${ids}::uuid[])
     order by d.recorded_at desc`;
  if (rows.length === 0) return [];
  // The machine a document names, for documents the viewer may already read — through the service role: the keeper, a driver
  // and a technician do not read the machine table, and saw "used into a machine" with no machine (review, 20 Oct).
  const machineIds = [...new Set(rows.map((r) => r.machine_id).filter((x): x is string => x !== null))];
  if (machineIds.length > 0) {
    const ms = new Map(
      (await getServiceSql()<{ id: string; asset_no: number | null; label: string }[]>`select id, asset_no, label from machine where id = any(${machineIds}::uuid[])`).map(
        (m) => [m.id, m],
      ),
    );
    for (const r of rows) {
      const m = r.machine_id ? ms.get(r.machine_id) : undefined;
      if (m) {
        r.asset_no = m.asset_no;
        r.machine_label = m.label;
      }
    }
  }
  const docIds = rows.map((r) => r.id);
  const lines = await tx<{ doc_id: string; item_id: string; name: string; unit: string; step: string; icon: string | null; qty: string; variety: string | null; carton_kg: string | null }[]>`
    select l.doc_id, l.item_id, i.name, i.unit, i.step::text as step, i.icon, l.qty::text as qty, l.variety, l.carton_kg::text as carton_kg
      from stock_doc_line l join inv_item i on i.id = l.item_id
     where l.doc_id = any(${docIds}::uuid[])
     order by i.sort_order, lower(i.name)`;
  const steps = await tx<{ doc_id: string; item_id: string; step: string; qty: string }[]>`
    select doc_id, item_id, step, sum(qty)::text as qty from stock_move where doc_id = any(${docIds}::uuid[]) group by doc_id, item_id, step`;
  const photos = await tx<{ entity_id: string; media_id: string }[]>`
    select l.entity_id, l.media_id from media_link l
      join media_object o on o.id = l.media_id
     where l.entity_type = 'stock_doc' and l.entity_id = any(${docIds}::uuid[])
     order by l.linked_at`;
  const names = await namesOf(rows.flatMap((r) => [r.created_by, r.confirm_by, r.answered_by, r.settled_by, r.from_employee, r.to_employee]));
  const who = (id: string | null) => (id ? { id, name: names.get(id) ?? "—" } : null);
  const place = (kind: string, id: string, name: string | null, emp: string | null): PlaceRef => ({
    kind,
    id,
    name: emp ? (names.get(emp) ?? "—") : (name ?? kind),
    employeeId: emp,
  });
  const stepOf = (doc: string, item: string, step: string) => num(steps.find((s) => s.doc_id === doc && s.item_id === item && s.step === step)?.qty);
  const a = abilitiesOf(viewer);
  return rows.map((r) => {
    const isHandover = r.kind === "handover";
    const docLines: DocLine[] = lines
      .filter((l) => l.doc_id === r.id)
      .map((l) => {
        const base: DocLine = { itemId: l.item_id, name: l.name, unit: l.unit, step: Number(l.step), icon: l.icon, qty: num(l.qty) };
        if (l.variety) base.variety = l.variety;
        if (l.carton_kg) base.cartonKg = Number(l.carton_kg);
        if (!isHandover) return base;
        const sent = stepOf(r.id, l.item_id, "send");
        const accepted = stepOf(r.id, l.item_id, "accept");
        const back = stepOf(r.id, l.item_id, "refuse") + stepOf(r.id, l.item_id, "cancel") + stepOf(r.id, l.item_id, "settle_back");
        const writtenOff = stepOf(r.id, l.item_id, "write_off");
        return { ...base, accepted, back, writtenOff, pending: Math.round((sent - accepted - back - writtenOff) * 1000) / 1000 };
      });
    const d = { created_by: r.created_by, confirm_side: r.confirm_side, confirm_by: r.confirm_by, from_employee: r.from_employee, to_employee: r.to_employee };
    const parties = [r.created_by, r.answered_by, r.from_employee, r.to_employee];
    return {
      id: r.id,
      kind: r.kind,
      state: r.state,
      from: place(r.from_kind, r.from_location_id, r.from_name, r.from_employee),
      to: place(r.to_kind, r.to_location_id, r.to_name, r.to_employee),
      createdBy: who(r.created_by)!,
      confirm: r.confirm_side ? { side: r.confirm_side, person: who(r.confirm_by) } : null,
      answeredBy: who(r.answered_by),
      answeredAt: r.answered_at?.toISOString() ?? null,
      answerReason: r.answer_reason,
      answerNote: r.answer_note,
      settledBy: who(r.settled_by),
      settledAt: r.settled_at?.toISOString() ?? null,
      reason: r.reason,
      note: r.note,
      supplier: r.supplier,
      invoiceNo: r.invoice_no,
      machine: r.machine_label ? { assetNo: r.asset_no, label: r.machine_label } : null,
      reversesDocId: r.reverses_doc_id,
      reversedByDocId: r.reversed_by,
      countSessionId: r.count_session_id,
      recordedAt: r.recorded_at.toISOString(),
      lines: docLines,
      photos: photos.filter((p) => p.entity_id === r.id).map((p) => p.media_id),
      may: {
        answer: isHandover && r.state === "waiting" && mayConfirm(viewer, d),
        cancel: isHandover && r.state === "waiting" && r.created_by === viewer.employeeId && viewer.status === "active",
        settle: isHandover && r.state === "part_accepted" && a.approve && !parties.includes(viewer.employeeId),
        reverse: a.approve && r.state === "posted" && ["receipt", "use", "damage", "count_adjustment", "supplier_return"].includes(r.kind),
      },
    };
  });
}

// ── the home screen ──────────────────────────────────────────────────────────
export interface CountCard {
  id: string;
  kind: CountKind;
  state: string;
  startedBy: { id: string; name: string };
  startedAt: string;
  submittedAt: string | null;
  recountBy: { id: string; name: string } | null;
  /** Lines that differ from the ledger (shown once handed in). */
  differing: number | null;
  may: { submit: boolean; recount: boolean; waive: boolean; decide: boolean; cancel: boolean };
}

export interface InventoryHome {
  at: string;
  can: InventoryAbilities;
  /** Every item and where it is — for whoever sees all stock; empty otherwise. */
  items: ItemNow[];
  /** This viewer is counting the warehouse (or recounting it): its figures are not shown until they hand it in. */
  figuresHidden: boolean;
  /** What the viewer holds now. */
  mine: Held[];
  /** Handovers this viewer must confirm. */
  waitingForMe: DocCard[];
  /** Handovers this viewer started that the other side has not confirmed. */
  sentByMe: DocCard[];
  /** Other handovers still waiting (whoever sees all stock). */
  pending: DocCard[];
  /** Handovers where less arrived than was sent, until an approver settles them. */
  disputes: DocCard[];
  counts: CountCard[];
  /** For whoever runs the warehouse: today's counts, and what was handed out since the last one. */
  today: {
    date: string;
    opening: { at: string; by: string } | null;
    closing: { at: string; by: string } | null;
    lastCount: { at: string; kind: string; by: string } | null;
    handedOutSinceLastCount: { itemId: string; name: string; unit: string; icon: string | null; qty: number }[];
  } | null;
}

const dayStart = (date: string) => new Date(`${date}T00:00:00+04:00`);
const nextDay = (date: string) => new Date(dayStart(date).getTime() + 86_400_000);

export async function inventoryHome(viewer: ViewerOrg, now: Date = new Date()): Promise<InventoryHome> {
  const a = requireAny(viewer);
  const me = viewer.employeeId;
  const today = localDate(now);
  return withContext(
    viewer,
    async (tx) => {
      // While this person counts the warehouse, or recounts it, the stock screen does not show the
      // warehouse's figures: a count copied from the screen would always "match", and nobody would look
      // again (TASK-060 review). They could still have looked before starting; the control against that
      // is someone else's spot count (D228).
      const figuresHidden = await countingNow(tx, viewer);
      const items = a.read ? (await itemsNow(tx)).map((i) => (figuresHidden ? { ...i, warehouse: null, low: false } : i)) : [];
      const mine = (
        await tx<{ item_id: string; name: string; unit: string; step: string; icon: string | null; qty: string }[]>`
          select b.item_id, i.name, i.unit, i.step::text as step, i.icon, b.qty::text as qty
            from stock_balance b
            join inv_location l on l.id = b.location_id
            join inv_item i on i.id = b.item_id
           where l.kind = 'person' and l.employee_id = ${me} and b.qty <> 0
           order by i.sort_order, lower(i.name)`
      ).map((r) => ({ itemId: r.item_id, name: r.name, unit: r.unit, step: Number(r.step), icon: r.icon, qty: num(r.qty) }));

      const openIds = (await tx<{ id: string }[]>`
        select id from stock_doc where kind = 'handover' and state in ('waiting', 'part_accepted') order by recorded_at desc limit 200`).map((r) => r.id);
      const open = await loadDocs(tx, viewer, openIds);
      const waitingForMe = open.filter((d) => d.state === "waiting" && d.may.answer);
      const sentByMe = open.filter((d) => d.state === "waiting" && d.createdBy.id === me);
      const pending = open.filter((d) => d.state === "waiting" && !d.may.answer && d.createdBy.id !== me);
      const disputes = open.filter((d) => d.state === "part_accepted");

      const counts = a.read ? await countCards(tx, viewer, null) : [];
      let todayBlock: InventoryHome["today"] = null;
      if (a.move) {
        const done = await tx<{ kind: string; submitted_at: Date; started_by: string }[]>`
          select kind, submitted_at, started_by from count_session
           where location_id = ${PLACE.warehouse} and submitted_at >= ${dayStart(today)} and submitted_at < ${nextDay(today)}
             and state <> 'cancelled'
           order by submitted_at`;
        const last = done[done.length - 1] ?? null;
        const since = last ? last.submitted_at : dayStart(today);
        const out = await tx<{ item_id: string; name: string; unit: string; icon: string | null; qty: string }[]>`
          select m.item_id, i.name, i.unit, i.icon, sum(m.qty)::text as qty
            from stock_move m join inv_item i on i.id = m.item_id
           where m.from_location_id = ${PLACE.warehouse} and m.step = 'send' and m.posted_at > ${since}
           group by m.item_id, i.name, i.unit, i.icon, i.sort_order
           order by i.sort_order`;
        const names = await namesOf(done.map((d) => d.started_by));
        const at = (k: string) => {
          const c = done.find((d) => d.kind === k);
          return c ? { at: c.submitted_at.toISOString(), by: names.get(c.started_by) ?? "—" } : null;
        };
        todayBlock = {
          date: today,
          opening: at("opening"),
          closing: at("closing"),
          lastCount: last ? { at: last.submitted_at.toISOString(), kind: last.kind, by: names.get(last.started_by) ?? "—" } : null,
          handedOutSinceLastCount: out.map((r) => ({ itemId: r.item_id, name: r.name, unit: r.unit, icon: r.icon, qty: num(r.qty) })),
        };
      }
      return { at: now.toISOString(), can: a, items, figuresHidden, mine, waitingForMe, sentByMe, pending, disputes, counts, today: todayBlock };
    },
    { readOnly: true },
  );
}

/** Is this viewer counting the warehouse now — their own count open, or a recount they took? */
async function countingNow(tx: Tx, viewer: ViewerOrg): Promise<boolean> {
  // The notices' rule (D259): counting, a recount taken — or one waiting that this person may take.
  void tx;
  const a = abilitiesOf(viewer);
  if (!a.move) return false;
  return (await figuresHiddenFrom())(viewer.employeeId, a.move);
}

async function itemsNow(tx: Tx): Promise<ItemNow[]> {
  const rows = await tx<{
    id: string;
    name: string;
    category: string;
    unit: string;
    step: string;
    icon: string | null;
    min_level: string | null;
    count_tolerance: string;
    active: boolean;
    warehouse: string;
    with_people: string;
    in_transit: string;
  }[]>`
    select i.id, i.name, i.category, i.unit, i.step::text as step, i.icon, i.min_level::text as min_level,
           i.count_tolerance::text as count_tolerance, i.active,
           coalesce((select b.qty from stock_balance b where b.location_id = ${PLACE.warehouse} and b.item_id = i.id), 0)::text as warehouse,
           coalesce((select sum(b.qty) from stock_balance b join inv_location l on l.id = b.location_id
                      where l.kind = 'person' and b.item_id = i.id), 0)::text as with_people,
           coalesce((select b.qty from stock_balance b where b.location_id = ${PLACE.inTransit} and b.item_id = i.id), 0)::text as in_transit
      from inv_item i
     where i.active
        or exists (select 1 from stock_balance b join inv_location l on l.id = b.location_id
                    where b.item_id = i.id and not l.is_virtual and b.qty <> 0)
     order by i.sort_order, lower(i.name)`;
  return rows.map((r) => {
    const warehouse = num(r.warehouse);
    const minLevel = r.min_level === null ? null : num(r.min_level);
    return {
      id: r.id,
      name: r.name,
      category: r.category,
      unit: r.unit,
      step: Number(r.step),
      icon: r.icon,
      minLevel,
      countTolerance: num(r.count_tolerance),
      active: r.active,
      warehouse,
      withPeople: num(r.with_people),
      inTransit: num(r.in_transit),
      low: minLevel !== null && warehouse < minLevel,
    };
  });
}

/** Count cards — the open ones, or these ids — with what this viewer may do with each. */
async function countCards(tx: Tx, viewer: ViewerOrg, ids: readonly string[] | null): Promise<CountCard[]> {
  const rows = await tx<{
    id: string;
    kind: CountKind;
    state: string;
    started_by: string;
    started_at: Date;
    submitted_at: Date | null;
    recount_by: string | null;
    differing: number | null;
  }[]>`
    select s.id, s.kind, s.state, s.started_by, s.started_at, s.submitted_at, s.recount_by,
           case when s.submitted_at is null then null else
             (select count(*)::int from count_line l where l.session_id = s.id and (l.counted_qty <> l.expected_qty or l.moved_during)) end as differing
      from count_session s
     where ${ids === null ? tx`s.state in ('counting', 'recount', 'approval')` : tx`s.id = any(${ids}::uuid[])`}
     order by s.started_at desc`;
  const names = await namesOf(rows.flatMap((r) => [r.started_by, r.recount_by]));
  const a = abilitiesOf(viewer);
  const me = viewer.employeeId;
  return rows.map((r) => {
    const open = r.state === "counting" || r.state === "recount" || r.state === "approval";
    return {
      id: r.id,
      kind: r.kind,
      state: r.state,
      startedBy: { id: r.started_by, name: names.get(r.started_by) ?? "—" },
      startedAt: r.started_at.toISOString(),
      submittedAt: r.submitted_at?.toISOString() ?? null,
      recountBy: r.recount_by ? { id: r.recount_by, name: names.get(r.recount_by) ?? "—" } : null,
      differing: r.differing,
      may: {
        submit: r.state === "counting" && r.started_by === me,
        recount: r.state === "recount" && a.move && r.started_by !== me && (r.recount_by === null || r.recount_by === me),
        waive: r.state === "recount" && a.approve && r.started_by !== me && r.recount_by !== me,
        decide: r.state === "approval" && a.approve && r.started_by !== me && r.recount_by !== me,
        // The person who opened it while counting; an approver who did not count, before the decision.
        cancel: (r.state === "counting" && r.started_by === me) || (open && r.state !== "approval" && a.approve && r.started_by !== me),
      },
    };
  });
}

// ── one document ─────────────────────────────────────────────────────────────
export async function inventoryDoc(viewer: ViewerOrg, id: string): Promise<DocCard | null> {
  requireAny(viewer);
  if (!UUID_RE.test(id)) return null;
  return withContext(viewer, async (tx) => (await loadDocs(tx, viewer, [id]))[0] ?? null, { readOnly: true });
}

// ── the people who can be given stock ────────────────────────────────────────
export interface Holder {
  id: string;
  name: string;
  role: string;
  /** What they hold now (whoever sees all stock); empty for anyone else. */
  holds: { itemId: string; qty: number }[];
  /**
   * False for someone who still holds stock but can no longer be given any — their account is off, or their role no longer
   * holds stock: offered only to take it back (review, 20 Oct).
   */
  canReceive: boolean;
}

const FIELD_FIRST = ["vmo", "technician", "supervisor", "warehouse_keeper", "ops_head", "admin", "ceo"];

/**
 * Everyone who can be given stock — for the "give to" and "take back from" pickers. The names and roles
 * only (data minimisation); what each holds only for whoever sees all stock.
 */
export async function inventoryHolders(viewer: ViewerOrg): Promise<Holder[]> {
  const a = abilitiesOf(viewer);
  if (!a.move && !a.read && !a.hold) throw new InventoryRefused("Stock is not part of your role.", 403, "not_allowed");
  // Who can be given stock; and, for whoever runs the warehouse, anyone else who still holds some — a person who left, or
  // whose role changed, keeps their stock on the books until it is taken back, and only from here can it be.
  const rows = await getServiceSql()<{ id: string; display_name: string; access_role: string; can_receive: boolean }[]>`
    select e.id, e.display_name, e.access_role,
           (e.status = 'active' and exists (select 1 from role_capability rc where rc.role = e.access_role and rc.capability = 'inventory.hold')) as can_receive
      from employee e
     where not (e.id = '00000000-0000-0000-0000-0000000000a1')
       and ((e.status = 'active' and exists (select 1 from role_capability rc where rc.role = e.access_role and rc.capability = 'inventory.hold'))
            or (${a.move} and exists (select 1 from stock_balance b join inv_location l on l.id = b.location_id
                                       where l.kind = 'person' and l.employee_id = e.id and b.qty <> 0)))
     order by e.display_name`;
  const holds = a.read
    ? await withContext(
        viewer,
        (tx) => tx<{ employee_id: string; item_id: string; qty: string }[]>`
          select l.employee_id, b.item_id, b.qty::text as qty
            from stock_balance b join inv_location l on l.id = b.location_id
           where l.kind = 'person' and b.qty <> 0`,
        { readOnly: true },
      )
    : [];
  const rank = (r: string) => {
    const i = FIELD_FIRST.indexOf(r);
    return i < 0 ? FIELD_FIRST.length : i;
  };
  return rows
    .map((r) => ({
      id: r.id,
      name: r.display_name,
      role: isAccessRole(r.access_role) ? ROLE_INFO[r.access_role].label : r.access_role,
      holds: holds.filter((h) => h.employee_id === r.id).map((h) => ({ itemId: h.item_id, qty: num(h.qty) })),
      canReceive: r.can_receive,
      _rank: rank(r.access_role),
    }))
    .sort((x, y) => x._rank - y._rank || x.name.localeCompare(y.name))
    .map(({ _rank: _, ...h }) => h);
}

// ── the movements list ───────────────────────────────────────────────────────
export interface MovementsQuery {
  /** Dubai dates, inclusive. */
  from?: string;
  to?: string;
  itemId?: string;
  personId?: string;
  kind?: string;
  /**
   * Older than this (paging): the previous page's `cursor` — its last document's exact time, to the
   * microsecond, and id. (A time in milliseconds, as a browser keeps it, would skip a document recorded
   * within the same millisecond — TASK-060 review.)
   */
  before?: string;
  limit?: number;
}

const CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

export async function inventoryMovements(viewer: ViewerOrg, q: MovementsQuery = {}): Promise<{ docs: DocCard[]; more: boolean; cursor: string | null }> {
  requireAny(viewer);
  const limit = Math.min(Math.max(q.limit ?? 40, 1), 100);
  const from = q.from ? dayStart(q.from) : null;
  const to = q.to ? nextDay(q.to) : null;
  // The time stays text until Postgres reads it, so its microseconds survive: postgres.js turns a value
  // bound as timestamptz into a JavaScript Date first, which keeps milliseconds only (G202).
  const [atText, idText] = (q.before ?? "").split("|");
  const beforeAt = atText && CURSOR_AT.test(atText) ? atText : null;
  if (q.before && !beforeAt) return { docs: [], more: false, cursor: null };
  const beforeId = idText && UUID_RE.test(idText) ? idText : "ffffffff-ffff-ffff-ffff-ffffffffffff";
  if (q.itemId && !UUID_RE.test(q.itemId)) return { docs: [], more: false, cursor: null };
  if (q.personId && !UUID_RE.test(q.personId)) return { docs: [], more: false, cursor: null };
  return withContext(
    viewer,
    async (tx) => {
      const ids = await tx<{ id: string; at: string }[]>`
        select d.id, to_char(d.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at from stock_doc d
         where (${from}::timestamptz is null or d.recorded_at >= ${from})
           and (${to}::timestamptz is null or d.recorded_at < ${to})
           and (${beforeAt}::text is null or (d.recorded_at, d.id) < (${beforeAt}::text::timestamptz, ${beforeId}::uuid))
           and (${q.kind ?? null}::text is null or d.kind = ${q.kind ?? null})
           and (${q.itemId ?? null}::uuid is null or exists (select 1 from stock_doc_line l where l.doc_id = d.id and l.item_id = ${q.itemId ?? null}))
           and (${q.personId ?? null}::uuid is null
                or d.created_by = ${q.personId ?? null} or d.confirm_by = ${q.personId ?? null} or d.answered_by = ${q.personId ?? null}
                or exists (select 1 from inv_location l where l.id in (d.from_location_id, d.to_location_id) and l.employee_id = ${q.personId ?? null}))
         order by d.recorded_at desc, d.id desc
         limit ${limit + 1}`;
      const page = ids.slice(0, limit);
      const docs = await loadDocs(tx, viewer, page.map((r) => r.id));
      const last = page[page.length - 1];
      return { docs, more: ids.length > limit, cursor: last ? `${last.at}|${last.id}` : null };
    },
    { readOnly: true },
  );
}

// ── the end of a day ─────────────────────────────────────────────────────────
export interface DayItemRow {
  itemId: string;
  name: string;
  unit: string;
  icon: string | null;
  opening: number;
  received: number;
  givenOut: number;
  /** Handed out and come back unaccepted: refused, cancelled, or settled back. */
  cameBack: number;
  takenBack: number;
  used: number;
  damaged: number;
  /** Sent back to a supplier (TASK-086). */
  returned: number;
  /** Count adjustments and write-offs, signed: + found, − missing. */
  adjusted: number;
  /** Reversals, signed. */
  reversed: number;
  closing: number;
}

export interface DayPersonRow {
  employeeId: string;
  name: string;
  items: {
    itemId: string;
    name: string;
    unit: string;
    icon: string | null;
    opening: number;
    received: number;
    gaveOut: number;
    cameBack: number;
    used: number;
    damaged: number;
    /** Their documents undone that day, signed (an entry made by mistake): start + in − out + this = end. */
    reversed: number;
    closing: number;
  }[];
}

export interface InventoryDay {
  date: string;
  /** False while the day is still running: "closing" is "now". */
  complete: boolean;
  warehouse: DayItemRow[];
  people: DayPersonRow[];
  counts: { id: string; kind: string; state: string; at: string | null; by: string; differing: number }[];
}

export async function inventoryDay(viewer: ViewerOrg, date: string, now: Date = new Date()): Promise<InventoryDay> {
  const a = abilitiesOf(viewer);
  if (!a.read) throw new InventoryRefused("The day's stock balance is for the people who see all stock.", 403, "not_allowed");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(dayStart(date).getTime())) throw new InventoryRefused("A day is YYYY-MM-DD.", 400, "bad_day");
  const start = dayStart(date);
  const end = nextDay(date);
  if (start > now) throw new InventoryRefused("That day has not started yet.", 400, "bad_day");
  return withContext(
    viewer,
    async (tx) => {
      if (await countingNow(tx, viewer)) {
        throw new InventoryRefused("Hand in your count first — the day's figures are not shown while you count.", 409, "counting_now");
      }
      const W = PLACE.warehouse;
      const wh = await tx<{
        item_id: string;
        name: string;
        unit: string;
        icon: string | null;
        opening: string;
        received: string;
        given_out: string;
        came_back: string;
        taken_back: string;
        used: string;
        damaged: string;
        returned: string;
        adjusted: string;
        reversed: string;
        closing: string;
      }[]>`
        with m as (
          select sm.item_id, sm.from_location_id as f, sm.to_location_id as t, sm.qty, sm.step, sm.posted_at, d.kind
            from stock_move sm join stock_doc d on d.id = sm.doc_id
           where (sm.from_location_id = ${W} or sm.to_location_id = ${W}) and sm.posted_at < ${end}
        )
        select i.id as item_id, i.name, i.unit, i.icon,
               coalesce(sum(case when m.posted_at < ${start} then case when m.t = ${W} then m.qty else -m.qty end end), 0)::text as opening,
               coalesce(sum(case when m.posted_at >= ${start} and m.kind = 'receipt' and m.t = ${W} then m.qty end), 0)::text as received,
               coalesce(sum(case when m.posted_at >= ${start} and m.step = 'send' and m.f = ${W} then m.qty end), 0)::text as given_out,
               coalesce(sum(case when m.posted_at >= ${start} and m.step in ('refuse', 'cancel', 'settle_back') and m.t = ${W} then m.qty end), 0)::text as came_back,
               coalesce(sum(case when m.posted_at >= ${start} and m.step = 'accept' and m.t = ${W} then m.qty end), 0)::text as taken_back,
               coalesce(sum(case when m.posted_at >= ${start} and m.kind = 'use' and m.f = ${W} then m.qty end), 0)::text as used,
               coalesce(sum(case when m.posted_at >= ${start} and m.kind = 'damage' and m.f = ${W} then m.qty end), 0)::text as damaged,
               coalesce(sum(case when m.posted_at >= ${start} and m.kind = 'supplier_return' and m.f = ${W} then m.qty end), 0)::text as returned,
               coalesce(sum(case when m.posted_at >= ${start} and m.kind = 'count_adjustment' then case when m.t = ${W} then m.qty else -m.qty end end), 0)::text as adjusted,
               coalesce(sum(case when m.posted_at >= ${start} and m.kind = 'reversal' then case when m.t = ${W} then m.qty else -m.qty end end), 0)::text as reversed,
               coalesce(sum(case when m.t = ${W} then m.qty else -m.qty end), 0)::text as closing
          from inv_item i left join m on m.item_id = i.id
         group by i.id, i.name, i.unit, i.icon, i.sort_order, i.active
        having i.active or coalesce(sum(case when m.t = ${W} then m.qty else -m.qty end), 0) <> 0 or count(m.item_id) > 0
         order by i.sort_order, lower(i.name)`;
      const ppl = await tx<{
        employee_id: string;
        item_id: string;
        name: string;
        unit: string;
        icon: string | null;
        opening: string;
        received: string;
        gave_out: string;
        came_back: string;
        used: string;
        damaged: string;
        reversed: string;
        closing: string;
      }[]>`
        with m as (
          select sm.item_id, sm.from_location_id as f, sm.to_location_id as t, sm.qty, sm.step, sm.posted_at, d.kind, l.id as place, l.employee_id
            from stock_move sm
            join stock_doc d on d.id = sm.doc_id
            join inv_location l on l.kind = 'person' and l.id in (sm.from_location_id, sm.to_location_id)
           where sm.posted_at < ${end}
        )
        select m.employee_id, m.item_id, i.name, i.unit, i.icon,
               coalesce(sum(case when m.posted_at < ${start} then case when m.t = m.place then m.qty else -m.qty end end), 0)::text as opening,
               coalesce(sum(case when m.posted_at >= ${start} and m.step = 'accept' and m.t = m.place then m.qty end), 0)::text as received,
               coalesce(sum(case when m.posted_at >= ${start} and m.step = 'send' and m.f = m.place then m.qty end), 0)::text as gave_out,
               coalesce(sum(case when m.posted_at >= ${start} and m.step in ('refuse', 'cancel', 'settle_back') and m.t = m.place then m.qty end), 0)::text as came_back,
               coalesce(sum(case when m.posted_at >= ${start} and m.kind = 'use' and m.f = m.place then m.qty end), 0)::text as used,
               coalesce(sum(case when m.posted_at >= ${start} and m.kind = 'damage' and m.f = m.place then m.qty end), 0)::text as damaged,
               coalesce(sum(case when m.posted_at >= ${start} and m.kind = 'reversal' then case when m.t = m.place then m.qty else -m.qty end end), 0)::text as reversed,
               coalesce(sum(case when m.t = m.place then m.qty else -m.qty end), 0)::text as closing
          from m join inv_item i on i.id = m.item_id
         group by m.employee_id, m.item_id, i.name, i.unit, i.icon, i.sort_order
        having sum(case when m.t = m.place then m.qty else -m.qty end) <> 0
            or count(*) filter (where m.posted_at >= ${start}) > 0
         order by i.sort_order`;
      const counts = await tx<{ id: string; kind: string; state: string; submitted_at: Date | null; started_by: string; differing: number }[]>`
        select s.id, s.kind, s.state, s.submitted_at, s.started_by,
               (select count(*)::int from count_line l where l.session_id = s.id and (l.counted_qty <> l.expected_qty or l.moved_during)) as differing
          from count_session s
         where s.location_id = ${W} and s.started_at >= ${start} and s.started_at < ${end} and s.state <> 'cancelled'
         order by s.started_at`;
      const names = await namesOf([...ppl.map((p) => p.employee_id), ...counts.map((c) => c.started_by)]);
      const people = new Map<string, DayPersonRow>();
      for (const p of ppl) {
        const row = people.get(p.employee_id) ?? { employeeId: p.employee_id, name: names.get(p.employee_id) ?? "—", items: [] };
        row.items.push({
          itemId: p.item_id,
          name: p.name,
          unit: p.unit,
          icon: p.icon,
          opening: num(p.opening),
          received: num(p.received),
          gaveOut: num(p.gave_out),
          cameBack: num(p.came_back),
          used: num(p.used),
          damaged: num(p.damaged),
          reversed: num(p.reversed),
          closing: num(p.closing),
        });
        people.set(p.employee_id, row);
      }
      return {
        date,
        complete: end <= now,
        warehouse: wh.map((r) => ({
          itemId: r.item_id,
          name: r.name,
          unit: r.unit,
          icon: r.icon,
          opening: num(r.opening),
          received: num(r.received),
          givenOut: num(r.given_out),
          cameBack: num(r.came_back),
          takenBack: num(r.taken_back),
          used: num(r.used),
          damaged: num(r.damaged),
          returned: num(r.returned),
          adjusted: num(r.adjusted),
          reversed: num(r.reversed),
          closing: num(r.closing),
        })),
        people: [...people.values()].sort((x, y) => x.name.localeCompare(y.name)),
        counts: counts.map((c) => ({ id: c.id, kind: c.kind, state: c.state, at: c.submitted_at?.toISOString() ?? null, by: names.get(c.started_by) ?? "—", differing: c.differing })),
      };
    },
    { readOnly: true },
  );
}

// ── one count ────────────────────────────────────────────────────────────────
export interface CountDetail extends CountCard {
  recountWaivedReason: string | null;
  decidedBy: { id: string; name: string } | null;
  decidedAt: string | null;
  decisionNote: string | null;
  adjustmentDocId: string | null;
  /** Whether this viewer is shown the ledger's figures (approvers who did not count; anyone once closed). */
  figuresShown: boolean;
  lines: {
    itemId: string;
    name: string;
    unit: string;
    icon: string | null;
    /** Null when hidden from this viewer. */
    counted: number | null;
    expected: number | null;
    movedDuring: boolean | null;
    recount: number | null;
    recountExpected: number | null;
    recountMovedDuring: boolean | null;
    /** On the recount list (beyond tolerance, or moved). */
    needsRecount: boolean;
    /** The figure decided on differs from its ledger figure (or it moved): it needs a decision. */
    needsDecision: boolean | null;
    decision: string | null;
    decisionReason: string | null;
  }[];
}

/**
 * One count. The ledger's figures stay hidden from the people who counted until it is closed, and the
 * recounter sees neither the ledger nor the first count — the second count must be their own.
 */
export async function inventoryCount(viewer: ViewerOrg, id: string): Promise<CountDetail | null> {
  const a = abilitiesOf(viewer);
  if (!a.read) throw new InventoryRefused("Counts are for the people who see all stock.", 403, "not_allowed");
  if (!UUID_RE.test(id)) return null;
  return withContext(
    viewer,
    async (tx) => {
      const cards = (await countCards(tx, viewer, [id]))[0];
      if (!cards) return null;
      const [s] = await tx<{ recount_waived_reason: string | null; decided_by: string | null; decided_at: Date | null; decision_note: string | null; started_by: string; recount_by: string | null; state: string }[]>`
        select recount_waived_reason, decided_by, decided_at, decision_note, started_by, recount_by, state from count_session where id = ${id}`;
      const rows = await tx<{
        item_id: string;
        name: string;
        unit: string;
        icon: string | null;
        counted_qty: string;
        expected_qty: string;
        moved_during: boolean;
        recount_qty: string | null;
        recount_expected_qty: string | null;
        recount_moved_during: boolean | null;
        decision: string | null;
        decision_reason: string | null;
        tol: string;
      }[]>`
        select l.item_id, i.name, i.unit, i.icon, l.counted_qty::text, l.expected_qty::text, l.moved_during,
               l.recount_qty::text, l.recount_expected_qty::text, l.recount_moved_during, l.decision, l.decision_reason,
               i.count_tolerance::text as tol
          from count_line l join inv_item i on i.id = l.item_id
         where l.session_id = ${id}
         order by i.sort_order, lower(i.name)`;
      const [adj] = await tx<{ id: string }[]>`select id from stock_doc where count_session_id = ${id} and kind = 'count_adjustment'`;
      const me = viewer.employeeId;
      const closed = s!.state === "closed" || s!.state === "cancelled";
      const counted = s!.started_by === me || s!.recount_by === me;
      // Until someone takes the recount, anyone who may still take it — a keeper, or an approver, who did
      // not count first — sees neither the first count nor the ledger: the recount must be their own
      // (TASK-060 review).
      const mayStillRecount = s!.state === "recount" && s!.recount_by === null && a.move && s!.started_by !== me;
      const figuresShown = closed || (a.approve && !counted && !mayStillRecount);
      const isRecounter = (s!.recount_by === me && !closed) || mayStillRecount;
      const names = await namesOf([s!.decided_by]);
      return {
        ...cards,
        recountWaivedReason: s!.recount_waived_reason,
        decidedBy: s!.decided_by ? { id: s!.decided_by, name: names.get(s!.decided_by) ?? "—" } : null,
        decidedAt: s!.decided_at?.toISOString() ?? null,
        decisionNote: s!.decision_note,
        adjustmentDocId: adj?.id ?? null,
        figuresShown,
        lines: rows.map((r) => {
          const needsRecount = r.moved_during || Math.abs(toMilli(r.counted_qty) - toMilli(r.expected_qty)) > toMilli(r.tol);
          const f = finalFigure(r);
          return {
            itemId: r.item_id,
            name: r.name,
            unit: r.unit,
            icon: r.icon,
            counted: isRecounter && !figuresShown ? null : num(r.counted_qty),
            expected: figuresShown ? num(r.expected_qty) : null,
            movedDuring: figuresShown ? r.moved_during : null,
            recount: figuresShown || s!.recount_by === me ? (r.recount_qty === null ? null : num(r.recount_qty)) : null,
            recountExpected: figuresShown ? (r.recount_expected_qty === null ? null : num(r.recount_expected_qty)) : null,
            recountMovedDuring: figuresShown ? r.recount_moved_during : null,
            needsRecount,
            needsDecision: figuresShown ? f.moved || f.counted !== f.expected : null,
            decision: r.decision,
            decisionReason: r.decision_reason,
          };
        }),
      };
    },
    { readOnly: true },
  );
}

/** The recent counts of the warehouse, newest first. */
export async function inventoryCounts(viewer: ViewerOrg, limit = 30): Promise<CountCard[]> {
  const a = abilitiesOf(viewer);
  if (!a.read) throw new InventoryRefused("Counts are for the people who see all stock.", 403, "not_allowed");
  return withContext(
    viewer,
    async (tx) => {
      const ids = await tx<{ id: string }[]>`select id from count_session order by started_at desc limit ${Math.min(Math.max(limit, 1), 100)}`;
      return countCards(tx, viewer, ids.map((r) => r.id));
    },
    { readOnly: true },
  );
}
