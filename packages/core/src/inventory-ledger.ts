import { getServiceSql, type Tx } from "./db.js";
import { loadViewer, type ViewerOrg } from "./org.js";
import { can } from "./permissions.js";
import { figuresHiddenFrom, noticeHandoverAnswered, noticeHandoverWaiting, noticeLowStock, warehouseItemsOf } from "./inventory-notify.js";
import {
  PLACE,
  USE_REASONS,
  DAMAGE_REASONS,
  REFUSE_REASONS,
  REVERSE_REASONS,
  WRITE_OFF_REASONS,
  InventoryRefused,
  correlationOf,
  toMilli,
  fromMilli,
  qtyNumber,
  parseQty,
  fmt,
  requireCan,
  requestHash,
  UUID_RE,
  type UseReason,
  type DamageReason,
  type RefuseReason,
  type ReverseReason,
  type WriteOffReason,
  type LineIn,
  type Posted,
  type Side,
} from "./inventory-common.js";
export {
  PLACE,
  USE_REASONS,
  DAMAGE_REASONS,
  REFUSE_REASONS,
  REVERSE_REASONS,
  WRITE_OFF_REASONS,
  InventoryRefused,
  correlationOf,
  toMilli,
  fromMilli,
  qtyNumber,
  parseQty,
  fmt,
  requireCan,
  requestHash,
  type UseReason,
  type DamageReason,
  type RefuseReason,
  type ReverseReason,
  type WriteOffReason,
  type LineIn,
  type Posted,
  type Side,
} from "./inventory-common.js";

/**
 * The stock ledger (TASK-060, migration 0032): every change of stock is a document with moves, posted
 * here in one transaction with its audit row — or not at all.
 *
 *   receiveDelivery   suppliers → warehouse
 *   startHandover     giver → in transit, waiting for the OTHER side to confirm
 *   answerHandover    in transit → receiver (all or what they counted), or back to the giver
 *   cancelHandover    in transit → giver, before anyone answered
 *   settleHandover    what a receiver did not count: back to the giver, or written off (an approver)
 *   recordUse         warehouse or own stock → used / damaged, with a reason
 *   reverseDocument   the opposite moves of a delivery, a use, a damage or a count adjustment (an approver)
 *
 * The database refuses the rest: a move is never changed or deleted, a real place never goes below
 * zero, a document's content never changes and its state only moves forward (0032's triggers). Here we
 * decide WHO may post WHAT — the capabilities in permissions.ts — and say "not enough" in words before
 * the CHECK has to.
 *
 * Every document id comes from the phone or browser: sending the same request twice posts it once, and
 * the same id with a different request is refused (request_hash). The offline app (TASK-063) relies on it.
 */

/** Someone stock can be given to: active, and their role holds stock (inventory.hold). */
async function holderOrRefuse(employeeId: string): Promise<ViewerOrg> {
  const person = await loadViewer(employeeId);
  if (!person) throw new InventoryRefused("No such person.", 404, "no_person");
  if (person.status !== "active" || !can(person, "inventory.hold")) {
    throw new InventoryRefused(`${person.displayName || "That person"} cannot be given stock: their account is not active or their role does not hold stock.`, 409, "not_a_holder");
  }
  return person;
}

/** The place that is this person's own stock — made the first time they hold anything. */
export async function personPlace(tx: Tx, employeeId: string): Promise<string> {
  await tx`
    insert into inv_location (kind, employee_id, is_synthetic)
    select 'person', e.id, e.is_synthetic from employee e where e.id = ${employeeId}
    on conflict (employee_id) where kind = 'person' do nothing`;
  const [r] = await tx<{ id: string }[]>`select id from inv_location where kind = 'person' and employee_id = ${employeeId}`;
  if (!r) throw new InventoryRefused("No such person.", 404, "no_person");
  return r.id;
}

// ── the posting machinery ────────────────────────────────────────────────────
interface ItemRow {
  id: string;
  name: string;
  unit: string;
  step: string;
  active: boolean;
}

/**
 * One lock per item, always taken in the same order, so two documents moving the same items never wait
 * on each other in a circle. The balance row's own lock would keep the numbers right without it; this
 * keeps a deadlock from refusing a hand-out at the counter.
 */
async function lockItems(tx: Tx, itemIds: readonly string[]): Promise<void> {
  for (const id of [...new Set(itemIds)].sort()) {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`inventory:${id}`}, 0))`;
  }
}

async function loadItems(tx: Tx, ids: readonly string[]): Promise<Map<string, ItemRow>> {
  const rows = await tx<ItemRow[]>`select id, name, unit, step::text as step, active from inv_item where id = any(${ids}::uuid[])`;
  return new Map(rows.map((r) => [r.id, r]));
}

interface CheckedLine {
  item: ItemRow;
  milli: number;
  variety: string | null;
  cartonKg: number | null;
}

/**
 * One line per item, every item known and in use, every amount a whole number of the item's steps. The
 * items are locked before they are read: an item's unit and step cannot change between this check and
 * the posting (saveItem takes the same lock).
 */
async function checkLines(tx: Tx, lines: readonly LineIn[], opts: { requireActive?: boolean } = {}): Promise<CheckedLine[]> {
  if (lines.length === 0) throw new InventoryRefused("Add at least one item.", 400, "no_lines");
  if (lines.length > 60) throw new InventoryRefused("At most 60 items on one document.", 400, "too_many_lines");
  const ids = lines.map((l) => l.itemId);
  if (ids.some((id) => !UUID_RE.test(id))) throw new InventoryRefused("An item id is not valid.", 400, "bad_item");
  if (new Set(ids).size !== ids.length) throw new InventoryRefused("Each item once per document — add the amounts together.", 400, "duplicate_item");
  await lockItems(tx, ids);
  const items = await loadItems(tx, ids);
  return lines.map((l) => {
    const item = items.get(l.itemId);
    if (!item) throw new InventoryRefused("An item on this document does not exist.", 404, "no_item");
    if (opts.requireActive !== false && !item.active) throw new InventoryRefused(`${item.name} is no longer in use.`, 409, "item_inactive");
    const milli = parseQty(l.qty, `amount of ${item.name}`);
    if (milli % toMilli(item.step) !== 0) {
      throw new InventoryRefused(`${item.name} is counted in steps of ${fmt(toMilli(item.step), item.unit)}.`, 400, "bad_step");
    }
    const variety = l.variety?.trim() ? l.variety.trim().slice(0, 40) : null;
    const cartonKg = l.cartonKg === undefined || l.cartonKg === null ? null : Number(l.cartonKg);
    if (cartonKg !== null && !(cartonKg > 0 && cartonKg < 100)) throw new InventoryRefused("A carton's weight must be between 0 and 100 kg.", 400, "bad_weight");
    return { item, milli, variety, cartonKg };
  });
}

async function placeName(tx: Tx, placeId: string): Promise<string> {
  const [r] = await tx<{ name: string | null; display_name: string | null }[]>`
    select l.name, e.display_name from inv_location l left join employee e on e.id = l.employee_id where l.id = ${placeId}`;
  return r?.name ?? r?.display_name ?? "that place";
}

/** What `placeId` holds of each item, in thousandths (0 when it never held any). */
async function balances(tx: Tx, placeId: string, itemIds: readonly string[]): Promise<Map<string, number>> {
  const rows = await tx<{ item_id: string; qty: string }[]>`
    select item_id, qty::text as qty from stock_balance where location_id = ${placeId} and item_id = any(${itemIds}::uuid[])`;
  return new Map(rows.map((r) => [r.item_id, toMilli(r.qty)]));
}

/** Refuse, in words, any line the place does not hold enough of — before the CHECK has to. */
async function requireEnough(tx: Tx, placeId: string, lines: readonly { item: ItemRow; milli: number }[], whose?: string, hideFigure = false): Promise<void> {
  const have = await balances(tx, placeId, lines.map((l) => l.item.id));
  for (const l of lines) {
    const h = have.get(l.item.id) ?? 0;
    if (h < l.milli) {
      // Asking for too much must not tell someone counting the warehouse its figure (D236; review, 20 Oct).
      if (hideFigure) throw new InventoryRefused(`Not enough ${l.item.name} in the warehouse for this.`, 409, "not_enough");
      const where = whose ?? (await placeName(tx, placeId));
      const has = where === "you" ? "have" : "has";
      throw new InventoryRefused(
        `Not enough ${l.item.name}: ${where} ${h === 0 ? `${has} none` : `${has} ${fmt(h, l.item.unit)}`}, this needs ${fmt(l.milli, l.item.unit)}.`,
        409,
        "not_enough",
      );
    }
  }
}

interface MoveIn {
  itemId: string;
  from: string;
  to: string;
  milli: number;
  step: "post" | "send" | "accept" | "refuse" | "cancel" | "settle_back" | "write_off" | "reverse";
  reason?: WriteOffReason | null;
}

async function postMoves(tx: Tx, docId: string, moves: readonly MoveIn[], by: string, correlationId: string, isSynthetic: boolean): Promise<void> {
  for (const m of moves) {
    if (m.milli <= 0) continue;
    try {
      await tx`
        insert into stock_move (doc_id, item_id, from_location_id, to_location_id, qty, step, posted_by, reason, is_synthetic, correlation_id)
        values (${docId}, ${m.itemId}, ${m.from}, ${m.to}, ${fromMilli(m.milli)}::numeric, ${m.step}, ${by}, ${m.reason ?? null},
                ${isSynthetic}, ${correlationId})`;
    } catch (err) {
      // The CHECK behind requireEnough: a move that got past it (a writer that skipped core) is refused all the same.
      if ((err as { constraint_name?: string }).constraint_name === "stock_balance_never_negative") {
        throw new InventoryRefused("Not enough stock for this — someone moved it a moment ago. Look again and retry.", 409, "not_enough");
      }
      throw err;
    }
  }
}

async function auditIn(
  tx: Tx,
  a: { correlationId: string; actor: string; action: string; entity: string; entityId: string; detail: Record<string, unknown> },
): Promise<void> {
  await tx`
    insert into audit_log (correlation_id, actor, action, entity, entity_id, detail)
    values (${a.correlationId}, ${a.actor}, ${a.action}, ${a.entity}, ${a.entityId}, ${tx.json(a.detail as never)})`;
}

/**
 * Insert the document unless this id exists: the same request again is a replay (nothing posted), a
 * different one under the same id is refused. Concurrent twins meet on the primary key.
 */
/**
 * A request already posted under this id is answered as a replay before anything else is checked: the
 * item may have been switched off, or the person deactivated, since — and the offline app must hear
 * "done", not a refusal of what it already did (TASK-060 review). The same id with a different request
 * is refused.
 */
async function replayOf(tx: Tx, id: string, hash: string): Promise<Posted | null> {
  if (!UUID_RE.test(id)) throw new InventoryRefused("The document id must be a UUID made by the app.", 400, "bad_id");
  const [old] = await tx<{ request_hash: string; state: string }[]>`select request_hash, state from stock_doc where id = ${id}`;
  if (!old) return null;
  if (old.request_hash !== hash) throw new InventoryRefused("This document id was already used for something else.", 409, "id_reused");
  return { docId: id, state: old.state, replay: true };
}

async function insertDoc(
  tx: Tx,
  d: {
    id: string;
    kind: string;
    from: string;
    to: string;
    state: string;
    createdBy: string;
    confirmSide?: "person" | "warehouse" | null;
    confirmBy?: string | null;
    reason?: string | null;
    note?: string | null;
    supplier?: string | null;
    invoiceNo?: string | null;
    machineId?: string | null;
    reversesDocId?: string | null;
    countSessionId?: string | null;
    deviceAt?: Date | null;
    hash: string;
    isSynthetic: boolean;
    correlationId: string;
  },
): Promise<{ inserted: true } | { inserted: false; state: string }> {
  if (!UUID_RE.test(d.id)) throw new InventoryRefused("The document id must be a UUID made by the app.", 400, "bad_id");
  const r = await tx`
    insert into stock_doc (id, kind, from_location_id, to_location_id, state, created_by, confirm_side, confirm_by, reason, note,
                           supplier, invoice_no, machine_id, reverses_doc_id, count_session_id, device_at, request_hash,
                           is_synthetic, correlation_id)
    values (${d.id}, ${d.kind}, ${d.from}, ${d.to}, ${d.state}, ${d.createdBy}, ${d.confirmSide ?? null}, ${d.confirmBy ?? null},
            ${d.reason ?? null}, ${d.note ?? null}, ${d.supplier ?? null}, ${d.invoiceNo ?? null}, ${d.machineId ?? null},
            ${d.reversesDocId ?? null}, ${d.countSessionId ?? null}, ${d.deviceAt ?? null}, ${d.hash}, ${d.isSynthetic}, ${d.correlationId})
    on conflict (id) do nothing`;
  if (r.count > 0) return { inserted: true };
  const [old] = await tx<{ request_hash: string; state: string }[]>`select request_hash, state from stock_doc where id = ${d.id}`;
  if (!old || old.request_hash !== d.hash) {
    throw new InventoryRefused("This document id was already used for something else.", 409, "id_reused");
  }
  return { inserted: false, state: old.state };
}

async function insertLines(tx: Tx, docId: string, lines: readonly CheckedLine[]): Promise<void> {
  for (const l of lines) {
    await tx`
      insert into stock_doc_line (doc_id, item_id, qty, variety, carton_kg)
      values (${docId}, ${l.item.id}, ${fromMilli(l.milli)}::numeric, ${l.variety}, ${l.cartonKg})`;
  }
}

/** Photos the poster took themself — never someone else's — attached to the document. */
async function linkPhotos(tx: Tx, docId: string, mediaIds: readonly string[] | undefined, by: string, role: "evidence" | "receipt", correlationId: string): Promise<void> {
  const ids = [...new Set(mediaIds ?? [])];
  if (ids.length === 0) return;
  if (ids.length > 6) throw new InventoryRefused("At most 6 photos on one document.", 400, "too_many_photos");
  if (ids.some((id) => !UUID_RE.test(id))) throw new InventoryRefused("A photo id is not valid.", 400, "bad_photo");
  const own = await tx<{ id: string }[]>`select id from media_object where id = any(${ids}::uuid[]) and uploaded_by = ${by}`;
  if (own.length !== ids.length) throw new InventoryRefused("Attach only photos you took yourself.", 400, "not_your_photo");
  for (const id of ids) {
    await tx`
      insert into media_link (media_id, entity_type, entity_id, role, linked_by, correlation_id)
      values (${id}, 'stock_doc', ${docId}, ${role}, ${by}, ${correlationId})
      on conflict do nothing`;
  }
}

const cleanText = (s: string | null | undefined, max: number): string | null => {
  const t = s?.trim();
  return t ? t.slice(0, max) : null;
};

const isSyntheticPerson = async (tx: Tx, employeeId: string): Promise<boolean> =>
  ((await tx<{ s: boolean }[]>`select is_synthetic as s from employee where id = ${employeeId}`)[0]?.s ?? false);

function deviceTime(at: string | Date | null | undefined): Date | null {
  if (at === null || at === undefined || at === "") return null;
  const d = at instanceof Date ? at : new Date(at);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * After a document commits: who is told (inventory-notify.ts). Best effort — the stock has moved, and a
 * notice that fails is logged, never allowed to undo or hide it. A replay tells nobody twice.
 */
async function afterPost(posted: Posted, what: "handover" | "answer" | "stock", correlationId: string): Promise<Posted> {
  if (posted.replay) return posted;
  try {
    if (what === "handover") await noticeHandoverWaiting(posted.docId, correlationId);
    if (what === "answer") await noticeHandoverAnswered(posted.docId, correlationId);
    await noticeLowStock(await warehouseItemsOf(posted.docId), { correlationId });
  } catch (err) {
    console.error("[inventory] a stock notice failed", err);
  }
  return posted;
}

// ── receive a delivery ───────────────────────────────────────────────────────
export async function receiveDelivery(
  viewer: ViewerOrg,
  req: {
    id: string;
    supplier?: string | null;
    invoiceNo?: string | null;
    note?: string | null;
    deviceAt?: string | Date | null;
    lines: readonly LineIn[];
    mediaIds?: readonly string[];
  },
  opts: { correlationId?: string } = {},
): Promise<Posted> {
  requireCan(viewer, "inventory.move", "Only the warehouse records deliveries.");
  const correlationId = correlationOf(opts.correlationId);
  const supplier = cleanText(req.supplier, 80);
  const invoiceNo = cleanText(req.invoiceNo, 40);
  const note = cleanText(req.note, 500);
  const hash = requestHash({ k: "receipt", supplier, invoiceNo, note, lines: req.lines, media: [...(req.mediaIds ?? [])].sort() });
  const done = await getServiceSql().begin(async (tx) => {
    const again = await replayOf(tx, req.id, hash);
    if (again) return again;
    const lines = await checkLines(tx, req.lines);
    const synthetic = await isSyntheticPerson(tx, viewer.employeeId);
    const doc = await insertDoc(tx, {
      id: req.id, kind: "receipt", from: PLACE.suppliers, to: PLACE.warehouse, state: "posted", createdBy: viewer.employeeId,
      note, supplier, invoiceNo, deviceAt: deviceTime(req.deviceAt), hash, isSynthetic: synthetic, correlationId,
    });
    if (!doc.inserted) return { docId: req.id, state: doc.state, replay: true };
    await insertLines(tx, req.id, lines);
    await postMoves(tx, req.id, lines.map((l) => ({ itemId: l.item.id, from: PLACE.suppliers, to: PLACE.warehouse, milli: l.milli, step: "post" as const })), viewer.employeeId, correlationId, synthetic);
    await linkPhotos(tx, req.id, req.mediaIds, viewer.employeeId, "receipt", correlationId);
    await auditIn(tx, {
      correlationId, actor: `employee:${viewer.employeeId}`, action: "stock.received", entity: "stock_doc", entityId: req.id,
      detail: { supplier, invoiceNo, lines: lines.map((l) => ({ item: l.item.name, qty: fromMilli(l.milli) })) },
    });
    return { docId: req.id, state: "posted", replay: false };
  });
  return afterPost(done, "stock", correlationId);
}

// ── handovers ────────────────────────────────────────────────────────────────
/**
 * Give stock to someone, or take it back. The stock leaves the giver at once (into "in transit") and
 * reaches the receiver only when the other side confirms:
 *   warehouse → person   by someone who runs the warehouse; the person confirms
 *   person → warehouse   by the person (their own stock; the warehouse confirms) or by the warehouse
 *                        taking it back at the desk (the person confirms)
 *   person → person      by the giver, from their own stock; the receiver confirms
 * Nobody confirms their own handover, and nobody gives stock to themself.
 */
export async function startHandover(
  viewer: ViewerOrg,
  req: { id: string; from: Side; to: Side; lines: readonly LineIn[]; note?: string | null; deviceAt?: string | Date | null; mediaIds?: readonly string[] },
  opts: { correlationId?: string } = {},
): Promise<Posted> {
  if (viewer.status !== "active") throw new InventoryRefused("Your account is not active.", 403, "not_allowed");
  const me = viewer.employeeId;
  const { from, to } = req;
  if (from.kind === "warehouse" && to.kind === "warehouse") throw new InventoryRefused("Stock already in the warehouse stays there.", 400, "same_place");
  if (from.kind === "person" && to.kind === "person" && from.employeeId === to.employeeId) throw new InventoryRefused("Giver and receiver are the same person.", 400, "same_place");

  let confirmSide: "person" | "warehouse";
  let confirmBy: string | null = null;
  // Whoever receives must still be able to hold stock — checked once a repeat of a request already
  // posted has been answered (replayOf).
  let receiver: string | null = null;
  if (from.kind === "warehouse" && to.kind === "person") {
    requireCan(viewer, "inventory.move", "Only the warehouse gives out stock.");
    if (to.employeeId === me) throw new InventoryRefused("Someone else must give you stock: nobody hands stock to themself.", 409, "self_handover");
    receiver = to.employeeId;
    confirmSide = "person";
    confirmBy = to.employeeId;
  } else if (from.kind === "person" && to.kind === "warehouse") {
    if (from.employeeId === me) {
      requireCan(viewer, "inventory.hold", "Your role does not hold stock.");
      confirmSide = "warehouse";
    } else {
      requireCan(viewer, "inventory.move", "Only the warehouse takes stock back from someone else.");
      confirmSide = "person";
      confirmBy = from.employeeId;
    }
  } else if (from.kind === "person" && to.kind === "person") {
    if (from.employeeId !== me) throw new InventoryRefused("Only the person who holds the stock can hand it to someone else.", 403, "not_allowed");
    requireCan(viewer, "inventory.hold", "Your role does not hold stock.");
    receiver = to.employeeId;
    confirmSide = "person";
    confirmBy = to.employeeId;
  } else {
    throw new InventoryRefused("Unknown handover.", 400, "bad_handover");
  }

  const correlationId = correlationOf(opts.correlationId);
  const note = cleanText(req.note, 500);
  const hash = requestHash({ k: "handover", from, to, note, lines: req.lines, media: [...(req.mediaIds ?? [])].sort() });
  const result = await getServiceSql().begin(async (tx) => {
    const again = await replayOf(tx, req.id, hash);
    if (again) return again;
    if (receiver) await holderOrRefuse(receiver);
    // Taking stock back from someone who cannot confirm it — their account is off, or their role no longer holds stock, so
    // Stock does not open for them: someone else at the warehouse does — never the person taking it back (TASK-060 review;
    // the role case, review of the fixes, 20 Oct).
    if (from.kind === "person" && confirmBy === from.employeeId) {
      const holder = await loadViewer(from.employeeId);
      if (!holder || holder.status !== "active" || !can(holder, "inventory.hold")) {
        confirmSide = "warehouse";
        confirmBy = null;
      }
    }
    const lines = await checkLines(tx, req.lines);
    const fromPlace = from.kind === "warehouse" ? PLACE.warehouse : await personPlace(tx, from.employeeId);
    const toPlace = to.kind === "warehouse" ? PLACE.warehouse : await personPlace(tx, to.employeeId);
    const synthetic = await isSyntheticPerson(tx, me);
    const doc = await insertDoc(tx, {
      id: req.id, kind: "handover", from: fromPlace, to: toPlace, state: "waiting", createdBy: me, confirmSide, confirmBy,
      note, deviceAt: deviceTime(req.deviceAt), hash, isSynthetic: synthetic, correlationId,
    });
    if (!doc.inserted) return { docId: req.id, state: doc.state, replay: true };
    const hide = from.kind === "warehouse" && (await figuresHiddenFrom())(me, can(viewer, "inventory.move"));
    await requireEnough(tx, fromPlace, lines, from.kind === "warehouse" ? "the warehouse" : from.employeeId === me ? "you" : undefined, hide);
    await insertLines(tx, req.id, lines);
    await postMoves(tx, req.id, lines.map((l) => ({ itemId: l.item.id, from: fromPlace, to: PLACE.inTransit, milli: l.milli, step: "send" as const })), me, correlationId, synthetic);
    await linkPhotos(tx, req.id, req.mediaIds, me, "evidence", correlationId);
    await auditIn(tx, {
      correlationId, actor: `employee:${me}`, action: "stock.handover_sent", entity: "stock_doc", entityId: req.id,
      detail: { from, to, confirmSide, confirmBy, lines: lines.map((l) => ({ item: l.item.name, qty: fromMilli(l.milli) })) },
    });
    return { docId: req.id, state: "waiting", replay: false };
  });
  return afterPost(result, "handover", correlationId);
}

interface HandoverRow {
  id: string;
  kind: string;
  state: string;
  from_location_id: string;
  to_location_id: string;
  created_by: string;
  confirm_side: "person" | "warehouse" | null;
  confirm_by: string | null;
  answered_by: string | null;
  from_employee: string | null;
  to_employee: string | null;
  is_synthetic: boolean;
}

async function lockHandover(tx: Tx, docId: string): Promise<HandoverRow> {
  if (!UUID_RE.test(docId)) throw new InventoryRefused("No such handover.", 404, "no_doc");
  const [d] = await tx<HandoverRow[]>`
    select d.id, d.kind, d.state, d.from_location_id, d.to_location_id, d.created_by, d.confirm_side, d.confirm_by, d.answered_by,
           lf.employee_id as from_employee, lt.employee_id as to_employee, d.is_synthetic
      from stock_doc d
      join inv_location lf on lf.id = d.from_location_id
      join inv_location lt on lt.id = d.to_location_id
     where d.id = ${docId}
     for update of d`;
  if (!d || d.kind !== "handover") throw new InventoryRefused("No such handover.", 404, "no_doc");
  return d;
}

/** May this viewer confirm (or refuse) this handover? The named person, or — for the warehouse side — anyone who runs it but the giver. */
export function mayConfirm(
  viewer: ViewerOrg,
  d: { created_by: string; confirm_side: string | null; confirm_by: string | null; from_employee: string | null; to_employee?: string | null },
): boolean {
  if (viewer.status !== "active") return false;
  if (viewer.employeeId === d.created_by) return false;
  if (d.confirm_side === "person") return d.confirm_by === viewer.employeeId;
  if (d.confirm_side === "warehouse") return can(viewer, "inventory.move") && d.from_employee !== viewer.employeeId;
  return false;
}

/** What each item of a handover still has in transit, in thousandths. */
async function pendingOf(tx: Tx, docId: string): Promise<Map<string, number>> {
  const rows = await tx<{ item_id: string; pending: string }[]>`
    select item_id,
           (sum(case when to_location_id = ${PLACE.inTransit} then qty else 0 end)
          - sum(case when from_location_id = ${PLACE.inTransit} then qty else 0 end))::text as pending
      from stock_move where doc_id = ${docId} group by item_id`;
  return new Map(rows.map((r) => [r.item_id, toMilli(r.pending)]));
}

/**
 * The other side answers: everything arrived ("accept"), or this much of each item ("counted" — the
 * rest stays in transit for an approver to settle), or nothing is taken ("refuse" — back to the giver).
 * Answering the same way twice is not an error; answering differently after an answer is.
 */
export async function answerHandover(
  viewer: ViewerOrg,
  docId: string,
  a: { answer: "accept" | "counted" | "refuse"; lines?: readonly LineIn[]; reason?: RefuseReason | null; note?: string | null },
  opts: { correlationId?: string } = {},
): Promise<Posted> {
  const correlationId = correlationOf(opts.correlationId);
  const note = cleanText(a.note, 500);
  if (a.answer === "refuse" && !a.reason) throw new InventoryRefused("Say why you are refusing it.", 400, "reason_needed");
  if (a.reason && !(REFUSE_REASONS as readonly string[]).includes(a.reason)) throw new InventoryRefused("Unknown reason.", 400, "bad_reason");
  const done = await getServiceSql().begin(async (tx) => {
    const d = await lockHandover(tx, docId);
    if (!mayConfirm(viewer, d)) throw new InventoryRefused("This handover is not yours to confirm.", 403, "not_allowed");
    if (d.state !== "waiting") {
      const same = d.answered_by === viewer.employeeId &&
        ((a.answer === "accept" && d.state === "accepted") || (a.answer === "refuse" && d.state === "refused") ||
         (a.answer === "counted" && (d.state === "accepted" || d.state === "part_accepted" || d.state === "settled")));
      if (same) return { docId, state: d.state, replay: true };
      throw new InventoryRefused(`This handover was already ${d.state.replace("_", " ")}.`, 409, "already_answered");
    }
    // Taking stock in needs a role that holds stock (it may have changed since the handover was sent);
    // refusing it never does.
    if (a.answer !== "refuse" && d.to_employee === viewer.employeeId && !can(viewer, "inventory.hold")) {
      throw new InventoryRefused("Your role no longer holds stock — refuse it, and the giver keeps it.", 403, "not_a_holder");
    }
    const pending = await pendingOf(tx, docId);
    const itemIds = [...pending.keys()];
    await lockItems(tx, itemIds);
    const items = await loadItems(tx, itemIds);
    const toPlace = d.to_location_id;
    const fromPlace = d.from_location_id;
    let state: string;
    let reason: string | null = a.reason ?? null;
    const moves: MoveIn[] = [];
    if (a.answer === "accept") {
      for (const [itemId, milli] of pending) moves.push({ itemId, from: PLACE.inTransit, to: toPlace, milli, step: "accept" });
      state = "accepted";
      reason = null;
    } else if (a.answer === "refuse") {
      for (const [itemId, milli] of pending) moves.push({ itemId, from: PLACE.inTransit, to: fromPlace, milli, step: "refuse" });
      state = "refused";
    } else {
      const counted = new Map<string, number>();
      for (const l of a.lines ?? []) {
        const item = items.get(l.itemId);
        if (!item || !pending.has(l.itemId)) throw new InventoryRefused("Count only the items on this handover.", 400, "bad_item");
        if (counted.has(l.itemId)) throw new InventoryRefused("Each item once.", 400, "duplicate_item");
        const milli = parseQty(l.qty, `amount of ${item.name}`, true);
        if (milli % toMilli(item.step) !== 0) throw new InventoryRefused(`${item.name} is counted in steps of ${fmt(toMilli(item.step), item.unit)}.`, 400, "bad_step");
        if (milli > pending.get(l.itemId)!) {
          throw new InventoryRefused(`More ${item.name} than was sent (${fmt(pending.get(l.itemId)!, item.unit)}): accept what was sent and tell the giver about the rest.`, 400, "more_than_sent");
        }
        counted.set(l.itemId, milli);
      }
      if (counted.size !== pending.size) throw new InventoryRefused("Give a count for every item on the handover (0 if it did not arrive).", 400, "count_every_item");
      const short = [...counted].some(([id, m]) => m < pending.get(id)!);
      if (short && !reason) throw new InventoryRefused("Say why less arrived.", 400, "reason_needed");
      for (const [itemId, milli] of counted) moves.push({ itemId, from: PLACE.inTransit, to: toPlace, milli, step: "accept" });
      state = short ? "part_accepted" : "accepted";
      if (!short) reason = null;
    }
    await postMoves(tx, docId, moves, viewer.employeeId, correlationId, d.is_synthetic);
    await tx`
      update stock_doc set state = ${state}, answered_by = ${viewer.employeeId}, answered_at = now(),
                           answer_reason = ${reason}, answer_note = ${note}
       where id = ${docId}`;
    await auditIn(tx, {
      correlationId, actor: `employee:${viewer.employeeId}`, action: `stock.handover_${state}`, entity: "stock_doc", entityId: docId,
      detail: { answer: a.answer, reason, moved: moves.map((m) => ({ item: items.get(m.itemId)?.name, qty: fromMilli(m.milli), step: m.step })) },
    });
    return { docId, state, replay: false };
  });
  return afterPost(done, "answer", correlationId);
}

/** The giver takes it back before anyone answered — a mistake caught in time. */
export async function cancelHandover(viewer: ViewerOrg, docId: string, opts: { correlationId?: string } = {}): Promise<Posted> {
  const correlationId = correlationOf(opts.correlationId);
  const done = await getServiceSql().begin(async (tx) => {
    const d = await lockHandover(tx, docId);
    if (viewer.status !== "active") throw new InventoryRefused("Only the person who started this handover can cancel it.", 403, "not_allowed");
    if (d.created_by !== viewer.employeeId) {
      // Stuck for good otherwise: whoever started it has left, or whoever must confirm it can no longer. An approver who was
      // neither side cancels it, so the stock goes back where it came from (review of the fixes, 20 Oct).
      const starter = await loadViewer(d.created_by);
      const confirmer = d.confirm_by ? await loadViewer(d.confirm_by) : null;
      const stuck =
        d.state === "waiting" &&
        (!starter || starter.status !== "active" || (d.confirm_side === "person" && (!confirmer || confirmer.status !== "active" || !can(confirmer, "inventory.hold"))));
      const party = [d.created_by, d.confirm_by, d.from_employee, d.to_employee].includes(viewer.employeeId);
      if (!(stuck && can(viewer, "inventory.approve") && !party)) {
        throw new InventoryRefused("Only the person who started this handover can cancel it.", 403, "not_allowed");
      }
    }
    if (d.state === "cancelled") return { docId, state: d.state, replay: true };
    if (d.state !== "waiting") throw new InventoryRefused(`Too late to cancel: it was already ${d.state.replace("_", " ")}.`, 409, "already_answered");
    const pending = await pendingOf(tx, docId);
    await lockItems(tx, [...pending.keys()]);
    await postMoves(tx, docId, [...pending].map(([itemId, milli]) => ({ itemId, from: PLACE.inTransit, to: d.from_location_id, milli, step: "cancel" as const })), viewer.employeeId, correlationId, d.is_synthetic);
    await tx`update stock_doc set state = 'cancelled' where id = ${docId}`;
    await auditIn(tx, { correlationId, actor: `employee:${viewer.employeeId}`, action: "stock.handover_cancelled", entity: "stock_doc", entityId: docId, detail: {} });
    return { docId, state: "cancelled", replay: false };
  });
  return afterPost(done, "stock", correlationId);
}

/**
 * What a receiver did not count is settled by an approver who was neither side of it: back to the
 * giver (they miscounted, it is still there) or written off, with a reason. Every item at once.
 */
export async function settleHandover(
  viewer: ViewerOrg,
  docId: string,
  s: { lines: readonly { itemId: string; outcome: "back" | "write_off"; reason?: WriteOffReason | null }[]; note?: string | null },
  opts: { correlationId?: string } = {},
): Promise<Posted> {
  requireCan(viewer, "inventory.approve", "Only the Ops Head, the CEO or an Admin settles a handover.");
  const correlationId = correlationOf(opts.correlationId);
  const note = cleanText(s.note, 500);
  const done = await getServiceSql().begin(async (tx) => {
    const d = await lockHandover(tx, docId);
    const parties = [d.created_by, d.answered_by, d.from_employee, d.to_employee];
    if (parties.includes(viewer.employeeId)) throw new InventoryRefused("Someone who was not part of this handover settles it.", 403, "party_settles");
    if (d.state === "settled") return { docId, state: d.state, replay: true };
    if (d.state !== "part_accepted") throw new InventoryRefused("Only a handover with something still in transit is settled.", 409, "nothing_to_settle");
    const pending = new Map([...(await pendingOf(tx, docId))].filter(([, m]) => m > 0));
    const given = new Map(s.lines.map((l) => [l.itemId, l]));
    if (given.size !== s.lines.length || given.size !== pending.size || [...pending.keys()].some((id) => !given.has(id))) {
      throw new InventoryRefused("Settle every item still in transit, once each.", 400, "settle_every_item");
    }
    await lockItems(tx, [...pending.keys()]);
    const moves: MoveIn[] = [];
    for (const [itemId, milli] of pending) {
      const l = given.get(itemId)!;
      if (l.outcome === "back") {
        moves.push({ itemId, from: PLACE.inTransit, to: d.from_location_id, milli, step: "settle_back" });
      } else {
        if (!l.reason || !(WRITE_OFF_REASONS as readonly string[]).includes(l.reason)) throw new InventoryRefused("Say why it is written off.", 400, "reason_needed");
        moves.push({ itemId, from: PLACE.inTransit, to: PLACE.adjustments, milli, step: "write_off", reason: l.reason });
      }
    }
    await postMoves(tx, docId, moves, viewer.employeeId, correlationId, d.is_synthetic);
    await tx`update stock_doc set state = 'settled', settled_by = ${viewer.employeeId}, settled_at = now(), settle_note = ${note} where id = ${docId}`;
    await auditIn(tx, {
      correlationId, actor: `employee:${viewer.employeeId}`, action: "stock.handover_settled", entity: "stock_doc", entityId: docId,
      detail: { lines: moves.map((m) => ({ itemId: m.itemId, qty: fromMilli(m.milli), outcome: m.step, reason: m.reason ?? null })) },
    });
    return { docId, state: "settled", replay: false };
  });
  return afterPost(done, "stock", correlationId);
}

// ── used and damaged ─────────────────────────────────────────────────────────
/**
 * Stock that is used up (put into a machine, used for cleaning …) or damaged (spoiled oranges, a
 * broken bottle …), from the warehouse (who runs it) or from the poster's own stock.
 */
export async function recordUse(
  viewer: ViewerOrg,
  req: {
    id: string;
    kind: "use" | "damage";
    from: "warehouse" | "mine";
    reason: UseReason | DamageReason;
    machineAssetNo?: number | null;
    lines: readonly LineIn[];
    note?: string | null;
    deviceAt?: string | Date | null;
    mediaIds?: readonly string[];
  },
  opts: {
    correlationId?: string;
    /**
     * The caller's own step, in the same transaction, once the document is posted (or found already posted): a visit links
     * its fill here, so the fill and its link commit together or not at all (review, 20 Oct).
     */
    within?: (tx: Tx, docId: string) => Promise<void>;
  } = {},
): Promise<Posted> {
  if (req.from === "warehouse") requireCan(viewer, "inventory.move", "Only the warehouse records what the warehouse used.");
  else requireCan(viewer, "inventory.hold", "Your role does not hold stock.");
  const allowed: readonly string[] = req.kind === "use" ? USE_REASONS : DAMAGE_REASONS;
  if (!allowed.includes(req.reason)) throw new InventoryRefused("Choose a reason from the list.", 400, "bad_reason");
  if (req.reason === "other" && !req.note?.trim()) throw new InventoryRefused("Say what happened in the note.", 400, "note_needed");
  const correlationId = correlationOf(opts.correlationId);
  const note = cleanText(req.note, 500);
  const hash = requestHash({ k: req.kind, from: req.from, reason: req.reason, machine: req.machineAssetNo ?? null, note, lines: req.lines, media: [...(req.mediaIds ?? [])].sort() });
  const done = await getServiceSql().begin(async (tx) => {
    const again = await replayOf(tx, req.id, hash);
    if (again) {
      if (opts.within) await opts.within(tx, req.id);
      return again;
    }
    let machineId: string | null = null;
    if (req.machineAssetNo !== undefined && req.machineAssetNo !== null) {
      if (req.kind !== "use" || req.reason !== "machine_refill") throw new InventoryRefused("A machine is named only for stock put into a machine.", 400, "bad_machine");
      const [m] = await tx<{ id: string }[]>`select id from machine where asset_no = ${req.machineAssetNo}`;
      if (!m) throw new InventoryRefused(`No machine numbered ${req.machineAssetNo}.`, 404, "no_machine");
      machineId = m.id;
    }
    const lines = await checkLines(tx, req.lines);
    const fromPlace = req.from === "warehouse" ? PLACE.warehouse : await personPlace(tx, viewer.employeeId);
    const toPlace = req.kind === "use" ? PLACE.used : PLACE.damaged;
    const synthetic = await isSyntheticPerson(tx, viewer.employeeId);
    const doc = await insertDoc(tx, {
      id: req.id, kind: req.kind, from: fromPlace, to: toPlace, state: "posted", createdBy: viewer.employeeId, reason: req.reason,
      note, machineId, deviceAt: deviceTime(req.deviceAt), hash, isSynthetic: synthetic, correlationId,
    });
    if (!doc.inserted) {
      if (opts.within) await opts.within(tx, req.id);
      return { docId: req.id, state: doc.state, replay: true };
    }
    const hide = req.from === "warehouse" && (await figuresHiddenFrom())(viewer.employeeId, true);
    await requireEnough(tx, fromPlace, lines, req.from === "warehouse" ? "the warehouse" : "you", hide);
    await insertLines(tx, req.id, lines);
    await postMoves(tx, req.id, lines.map((l) => ({ itemId: l.item.id, from: fromPlace, to: toPlace, milli: l.milli, step: "post" as const })), viewer.employeeId, correlationId, synthetic);
    await linkPhotos(tx, req.id, req.mediaIds, viewer.employeeId, "evidence", correlationId);
    await auditIn(tx, {
      correlationId, actor: `employee:${viewer.employeeId}`, action: req.kind === "use" ? "stock.used" : "stock.damaged", entity: "stock_doc", entityId: req.id,
      detail: { from: req.from, reason: req.reason, machineAssetNo: req.machineAssetNo ?? null, lines: lines.map((l) => ({ item: l.item.name, qty: fromMilli(l.milli) })) },
    });
    if (opts.within) await opts.within(tx, req.id);
    return { docId: req.id, state: "posted", replay: false };
  });
  return afterPost(done, "stock", correlationId);
}

// ── reversal ─────────────────────────────────────────────────────────────────
/**
 * Undo a delivery, a use, a damage or a count adjustment entered by mistake: a new document whose moves
 * are the original's, the other way round. The original stays, marked reversed. A handover is never
 * reversed — the stock goes back by a new handover the other side confirms.
 */
export async function reverseDocument(
  viewer: ViewerOrg,
  docId: string,
  req: { id: string; reason: ReverseReason; note?: string | null },
  opts: { correlationId?: string } = {},
): Promise<Posted> {
  requireCan(viewer, "inventory.approve", "Only the Ops Head, the CEO or an Admin reverses a stock document.");
  if (!(REVERSE_REASONS as readonly string[]).includes(req.reason)) throw new InventoryRefused("Choose a reason from the list.", 400, "bad_reason");
  if (req.reason === "other" && !req.note?.trim()) throw new InventoryRefused("Say what was wrong in the note.", 400, "note_needed");
  if (!UUID_RE.test(docId)) throw new InventoryRefused("No such document.", 404, "no_doc");
  const correlationId = correlationOf(opts.correlationId);
  const note = cleanText(req.note, 500);
  const hash = requestHash({ k: "reversal", of: docId, reason: req.reason, note });
  const done = await getServiceSql().begin(async (tx) => {
    const [orig] = await tx<{ id: string; kind: string; state: string; from_location_id: string; to_location_id: string; is_synthetic: boolean }[]>`
      select id, kind, state, from_location_id, to_location_id, is_synthetic from stock_doc where id = ${docId} for update`;
    if (!orig) throw new InventoryRefused("No such document.", 404, "no_doc");
    if (!["receipt", "use", "damage", "count_adjustment"].includes(orig.kind)) {
      throw new InventoryRefused(orig.kind === "handover" ? "A handover is undone by a handover back, which the other side confirms." : "This document cannot be reversed.", 409, "not_reversible");
    }
    const replay = await tx<{ request_hash: string; reverses_doc_id: string | null }[]>`select request_hash, reverses_doc_id from stock_doc where id = ${req.id}`;
    if (replay[0]) {
      if (replay[0].request_hash === hash && replay[0].reverses_doc_id === docId) return { docId: req.id, state: "posted", replay: true };
      throw new InventoryRefused("This document id was already used for something else.", 409, "id_reused");
    }
    if (orig.state !== "posted") throw new InventoryRefused("This document was already reversed.", 409, "already_reversed");
    const moves = await tx<{ item_id: string; from_location_id: string; to_location_id: string; qty: string }[]>`
      select item_id, from_location_id, to_location_id, qty::text as qty from stock_move where doc_id = ${docId} order by id`;
    await lockItems(tx, moves.map((m) => m.item_id));
    // The way back must be there: a delivery whose cartons have been handed out cannot be undone.
    const back = moves.map((m) => ({ itemId: m.item_id, from: m.to_location_id, to: m.from_location_id, milli: toMilli(m.qty) }));
    const items = await loadItems(tx, back.map((b) => b.itemId));
    const virtual = new Set((await tx<{ id: string }[]>`select id from inv_location where is_virtual and id = any(${back.map((b) => b.from)}::uuid[])`).map((r) => r.id));
    const need = new Map<string, Map<string, number>>();
    for (const b of back) {
      if (virtual.has(b.from)) continue;
      const per = need.get(b.from) ?? new Map<string, number>();
      per.set(b.itemId, (per.get(b.itemId) ?? 0) + b.milli);
      need.set(b.from, per);
    }
    // Not enough in the warehouse, said to someone counting it, or who may take its recount: no figure (D259).
    const hidden = need.has(PLACE.warehouse) ? (await figuresHiddenFrom())(viewer.employeeId, can(viewer, "inventory.move")) : false;
    for (const [place, per] of need) {
      await requireEnough(tx, place, [...per].map(([itemId, milli]) => ({ item: items.get(itemId)!, milli })), undefined, place === PLACE.warehouse && hidden);
    }
    const doc = await insertDoc(tx, {
      id: req.id, kind: "reversal", from: orig.to_location_id, to: orig.from_location_id, state: "posted", createdBy: viewer.employeeId,
      reason: req.reason, note, reversesDocId: docId, hash, isSynthetic: orig.is_synthetic, correlationId,
    });
    if (!doc.inserted) return { docId: req.id, state: doc.state, replay: true };
    const sums = new Map<string, number>();
    for (const b of back) sums.set(b.itemId, (sums.get(b.itemId) ?? 0) + b.milli);
    for (const [itemId, milli] of sums) {
      await tx`insert into stock_doc_line (doc_id, item_id, qty) values (${req.id}, ${itemId}, ${fromMilli(milli)}::numeric)`;
    }
    await postMoves(tx, req.id, back.map((b) => ({ ...b, step: "reverse" as const })), viewer.employeeId, correlationId, orig.is_synthetic);
    await tx`update stock_doc set state = 'reversed' where id = ${docId}`;
    await auditIn(tx, {
      correlationId, actor: `employee:${viewer.employeeId}`, action: "stock.reversed", entity: "stock_doc", entityId: docId,
      detail: { reversal: req.id, kind: orig.kind, reason: req.reason },
    });
    return { docId: req.id, state: "posted", replay: false };
  });
  return afterPost(done, "stock", correlationId);
}
