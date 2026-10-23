import { randomUUID } from "node:crypto";
import { notifyPeople } from "./alerts.js";
import { loadConfig } from "./config.js";
import { getServiceSql, withContext, type Tx } from "./db.js";
import { InventoryRefused, UUID_RE, correlationOf, requestHash } from "./inventory-common.js";
import { ceoEmployeeId, type ViewerOrg } from "./org.js";
import { can, type Capability } from "./permissions.js";
import { localDate } from "./time.js";

/**
 * Cash (TASK-061, migration 0035): every dirham from a machine's cash box to the cash-deposit machine,
 * on a ledger with the same rules as stock, replacing the "CASH COLLECTION" WhatsApp group — and the
 * auditor's check of each shift, with Televend's own "should have found" beside every collection (D221).
 *
 *   collection   machine → person   what the driver took out (0 is a real answer: the box was empty)
 *   test_vend    person → machine   a note put back in to test the acceptor ("cash test 10", "juice try 10")
 *   expense      person → fuel / other, with its receipt
 *   deposit      person → cdm        with the cash-deposit machine's receipt
 *   reversal     the opposite moves — the person's own entry while their shift is open and unchecked;
 *                any entry of someone else's, for an auditor
 *
 * A person never holds less than nothing: spending or depositing more than they hold is refused in words
 * before the database's CHECK has to. Every entry belongs to its person's open shift; the first entry
 * opens one if none is open. The auditor checks a whole shift — ok, or a question the person answers —
 * and never their own.
 */

export const CASH_ACCOUNT = {
  fuel: "00000000-0000-0000-0000-00000000c001",
  other: "00000000-0000-0000-0000-00000000c002",
  cdm: "00000000-0000-0000-0000-00000000c003",
  bank: "00000000-0000-0000-0000-00000000c004",
  overShort: "00000000-0000-0000-0000-00000000c005",
} as const;

export const CASH_REVERSE_REASONS = ["entered_by_mistake", "wrong_amount", "wrong_machine", "duplicate", "other"] as const;
export type CashReverseReason = (typeof CASH_REVERSE_REASONS)[number];
/** AED notes, as the cash-deposit machine's receipt lists them (VF73). */
export const AED_NOTES = [1000, 500, 200, 100, 50, 20, 10, 5] as const;

type EntryKind = "collection" | "expense" | "test_vend" | "deposit";

/**
 * Which entries carry a photo: as the WhatsApp group does today — each machine's cash, the fuel
 * receipt, the deposit machine's receipt — and as decided for field work (photos mandatory, 2026-10-15).
 * A "test" note needs none. Which entries exactly is FreshNow's to confirm (A-T61.3).
 */
export const CASH_PHOTO_NEEDED: Readonly<Record<EntryKind, boolean>> = { collection: true, expense: true, deposit: true, test_vend: false };
const PHOTO_WORDS: Record<EntryKind, string> = {
  collection: "Add a photo of the cash you took out — or of the empty box.",
  expense: "Add a photo of the receipt.",
  deposit: "Add a photo of the deposit machine's receipt.",
  test_vend: "",
};

export class CashRefused extends InventoryRefused {
  constructor(message: string, status: 400 | 403 | 404 | 409 = 403, code = "refused") {
    super(message, status, code);
    this.name = "CashRefused";
  }
}

export interface CashPosted {
  docId: string;
  shiftId: string;
  /** True when this exact entry had been posted before: nothing was posted again. */
  replay: boolean;
}

/** "AED 1,540", "AED 12.5" — as people write it. */
export const aed = (fils: number): string => `AED ${(fils / 100).toLocaleString("en-GB", { maximumFractionDigits: 2 })}`;

function requireCap(viewer: ViewerOrg, capability: Capability, message: string): void {
  if (viewer.status !== "active" || !can(viewer, capability)) throw new CashRefused(message, 403, "not_allowed");
}

/** Whole fils, at most AED 1,000,000. */
function wholeFils(n: unknown, what: string, allowZero = false): number {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 100_000_000 || (!allowZero && n === 0)) {
    throw new CashRefused(`The ${what} must be a whole number of fils${allowZero ? "" : ", more than zero"}.`, 400, "bad_amount");
  }
  return n;
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

async function auditIn(tx: Tx, a: { correlationId: string; actor: string; action: string; entity: string; entityId: string; detail: Record<string, unknown> }): Promise<void> {
  await tx`
    insert into audit_log (correlation_id, actor, action, entity, entity_id, detail)
    values (${a.correlationId}, ${a.actor}, ${a.action}, ${a.entity}, ${a.entityId}, ${tx.json(a.detail as never)})`;
}

const isSynthetic = async (tx: Tx, employeeId: string): Promise<boolean> =>
  (await tx<{ s: boolean }[]>`select is_synthetic as s from employee where id = ${employeeId}`)[0]?.s ?? false;

/** The person's own cash account — made the first time they hold any. */
async function personAccount(tx: Tx, employeeId: string): Promise<string> {
  await tx`
    insert into cash_account (kind, employee_id, is_synthetic)
    select 'person', e.id, e.is_synthetic from employee e where e.id = ${employeeId}
    on conflict (employee_id) where kind = 'person' do nothing`;
  const [r] = await tx<{ id: string }[]>`select id from cash_account where kind = 'person' and employee_id = ${employeeId}`;
  if (!r) throw new CashRefused("No such person.", 404, "no_person");
  return r.id;
}

/** A machine's cash box, by the number on its sticker. */
async function machineAccount(tx: Tx, assetNo: number): Promise<{ accountId: string; machineId: string }> {
  if (!Number.isInteger(assetNo) || assetNo < 1 || assetNo > 99_999) throw new CashRefused("A machine number is 1 to 99999.", 400, "bad_machine");
  const [m] = await tx<{ id: string; is_synthetic: boolean }[]>`select id, is_synthetic from machine where asset_no = ${assetNo}`;
  if (!m) throw new CashRefused(`No machine numbered ${assetNo}.`, 404, "no_machine");
  await tx`
    insert into cash_account (kind, machine_id, is_synthetic) values ('machine', ${m.id}, ${m.is_synthetic})
    on conflict (machine_id) where kind = 'machine' do nothing`;
  const [a] = await tx<{ id: string }[]>`select id from cash_account where kind = 'machine' and machine_id = ${m.id}`;
  return { accountId: a!.id, machineId: m.id };
}

/** One person's cash one posting at a time: what they hold is checked and changed in one step. */
async function lockPerson(tx: Tx, employeeId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtextextended(${`cash:${employeeId}`}, 0))`;
}

async function heldFils(tx: Tx, accountId: string): Promise<number> {
  const [b] = await tx<{ fils: string }[]>`select fils::text from cash_balance where account_id = ${accountId}`;
  return b ? Number(b.fils) : 0;
}

/** The person's open shift — opened now if there is none (their first entry of the day starts it). */
async function openShift(tx: Tx, employeeId: string, now: Date, correlationId: string, newId?: string): Promise<{ id: string; opened: boolean }> {
  const [open] = await tx<{ id: string }[]>`select id from shift where employee_id = ${employeeId} and state = 'open'`;
  if (open) return { id: open.id, opened: false };
  const id = newId ?? randomUUID();
  await tx`
    insert into shift (id, employee_id, started_at, business_date, is_synthetic, correlation_id)
    values (${id}, ${employeeId}, ${now}, ${localDate(now)}, ${await isSynthetic(tx, employeeId)}, ${correlationId})`;
  await auditIn(tx, { correlationId, actor: `employee:${employeeId}`, action: "cash.shift_started", entity: "shift", entityId: id, detail: {} });
  return { id, opened: true };
}

/**
 * Photos the poster took themself — the cash, a receipt — attached to the entry. A photo proves one entry that stands:
 * the same picture on a second collection would let one pile of cash stand for ten machines (review, 20 Oct); on an
 * entry since undone it may prove the entry made again ("undo, then enter it again, right").
 */
async function linkPhotos(tx: Tx, docId: string, ids: readonly string[], by: string, role: "evidence" | "receipt", correlationId: string): Promise<void> {
  if (ids.length === 0) return;
  const own = await tx<{ id: string }[]>`select id from media_object where id = any(${ids}::uuid[]) and uploaded_by = ${by}`;
  if (own.length !== ids.length) throw new CashRefused("Attach only photos you took yourself.", 400, "not_your_photo");
  const [used] = await tx<{ n: number }[]>`
    select count(*)::int as n from media_link l join cash_doc d on d.id = l.entity_id
     where l.media_id = any(${ids}::uuid[]) and l.entity_type = 'cash_doc' and l.entity_id <> ${docId} and d.state = 'posted'`;
  if (used!.n > 0) throw new CashRefused("That photo is already on another cash entry — take a new one for this one.", 400, "photo_used");
  for (const id of ids) {
    await tx`
      insert into media_link (media_id, entity_type, entity_id, role, linked_by, correlation_id)
      values (${id}, 'cash_doc', ${docId}, ${role}, ${by}, ${correlationId}) on conflict do nothing`;
  }
}

/** The Ops Head (who answers for cash with the auditor); with none, the CEO — never the person excluded. */
async function opsHeads(except: readonly string[]): Promise<string[]> {
  const rows = await getServiceSql()<{ id: string }[]>`
    select id from employee where status = 'active' and access_role = 'ops_head' and not (id = any(${except}::uuid[]))`;
  if (rows.length > 0) return rows.map((r) => r.id);
  const ceo = await ceoEmployeeId();
  return except.includes(ceo) ? [] : [ceo];
}

async function nameOf(id: string): Promise<string> {
  return (await getServiceSql()<{ n: string }[]>`select display_name as n from employee where id = ${id}`)[0]?.n ?? "Someone";
}

/** Best effort, like every notice: the cash has moved whether or not a phone hears of it. */
async function tell(p: { to: readonly string[]; key: string; kind: string; text: string; title: string; tag: string; urgent?: boolean; reason: string; correlationId: string }): Promise<void> {
  if (p.to.length === 0) return;
  try {
    await notifyPeople({
      recipients: p.to.map((employeeId) => ({ employeeId, reason: p.reason })),
      keyFor: (employeeId, channel) => `${p.key}:${employeeId}:${channel}`,
      text: p.text,
      kind: p.kind,
      presentation: { title: p.title, url: "/app/#cash", tag: p.tag, urgent: p.urgent ?? false },
      telegram: "fallback",
      correlationId: p.correlationId,
    });
  } catch (err) {
    console.error("[cash] a notice failed", err);
  }
}

// ── entries ──────────────────────────────────────────────────────────────────
interface EntryIn {
  /** Made by the phone or browser: the same entry sent twice posts once. */
  id: string;
  kind: EntryKind;
  amountFils: number;
  machineAssetNo?: number | null;
  expenseKind?: "fuel" | "other" | null;
  litres?: number | null;
  cdmTxnNo?: string | null;
  cdmOperator?: string | null;
  cdsId?: string | null;
  bagNo?: string | null;
  /** Notes by face value: {"100": 8, "50": 1} — they must add up to the amount. */
  denominations?: Record<string, number> | null;
  /** The time printed on the receipt. */
  receiptAt?: string | Date | null;
  note?: string | null;
  deviceAt?: string | Date | null;
  mediaIds?: readonly string[];
}

/** The one way an entry is posted: checks, the person's lock, their shift, the move, the photos, the audit row. */
async function post(viewer: ViewerOrg, d: EntryIn, opts: Opts = {}): Promise<CashPosted> {
  requireCap(viewer, "cash.hold", "Your role does not handle cash.");
  if (!UUID_RE.test(d.id)) throw new CashRefused("The entry's id must be a UUID made by the app.", 400, "bad_id");
  const amount = wholeFils(d.amountFils, "amount", d.kind === "collection");
  const note = cleanText(d.note, 500);
  const machineNo = d.kind === "collection" || d.kind === "test_vend" ? (d.machineAssetNo ?? null) : null;
  if ((d.kind === "collection" || d.kind === "test_vend") && machineNo === null) throw new CashRefused("Which machine? Type the number on its sticker.", 400, "machine_needed");
  const expenseKind = d.kind === "expense" ? (d.expenseKind ?? null) : null;
  if (d.kind === "expense" && expenseKind !== "fuel" && expenseKind !== "other") throw new CashRefused("Fuel, or something else?", 400, "bad_expense");
  if (expenseKind === "other" && !note) throw new CashRefused("Say what the money was spent on.", 400, "note_needed");
  let litres: number | null = null;
  if (d.litres !== null && d.litres !== undefined) {
    if (expenseKind !== "fuel") throw new CashRefused("Litres go with fuel only.", 400, "bad_litres");
    if (typeof d.litres !== "number" || !(d.litres > 0 && d.litres < 1000)) throw new CashRefused("Litres must be more than 0 and less than 1000.", 400, "bad_litres");
    litres = Math.round(d.litres * 100) / 100;
  }
  let denominations: Record<string, number> | null = null;
  if (d.kind === "deposit" && d.denominations && Object.keys(d.denominations).length > 0) {
    let sum = 0;
    denominations = {};
    for (const [k, count] of Object.entries(d.denominations)) {
      const face = Number(k);
      // "0100" is AED 100 too: two keys for one note would add up here and overwrite each other below.
      if (String(face) !== k || !(AED_NOTES as readonly number[]).includes(face) || !Number.isInteger(count) || count < 0 || count > 100_000) {
        throw new CashRefused("Notes are AED 5, 10, 20, 50, 100, 200, 500 or 1000, each a whole count.", 400, "bad_notes");
      }
      if (count > 0) denominations[String(face)] = count;
      sum += face * 100 * count;
    }
    if (sum !== amount) throw new CashRefused(`The notes add up to ${aed(sum)}, not ${aed(amount)}.`, 400, "notes_dont_add_up");
  }
  const deposit =
    d.kind === "deposit"
      ? { txn: cleanText(d.cdmTxnNo, 40), op: cleanText(d.cdmOperator, 60), cds: cleanText(d.cdsId, 40), bag: cleanText(d.bagNo, 40) }
      : { txn: null, op: null, cds: null, bag: null };
  const media = [...new Set(d.mediaIds ?? [])].sort();
  if (media.length > 4) throw new CashRefused("At most 4 photos on one entry.", 400, "too_many_photos");
  if (media.some((x) => !UUID_RE.test(x))) throw new CashRefused("A photo id is not valid.", 400, "bad_photo");
  if (CASH_PHOTO_NEEDED[d.kind] && media.length === 0) throw new CashRefused(PHOTO_WORDS[d.kind], 400, "photo_needed");
  const receiptAt = deviceTime(d.receiptAt);
  const correlationId = correlationOf(opts.correlationId);
  const now = opts.now ?? new Date();
  const hash = requestHash({
    k: d.kind, amount, machine: machineNo, expense: expenseKind, litres, ...deposit, notes: denominations,
    receiptAt: receiptAt?.toISOString() ?? null, note, media,
  });

  return getServiceSql().begin(async (tx) => {
    const me = viewer.employeeId;
    await lockPerson(tx, me);
    // A repeat of an entry already posted is answered before anything else is checked.
    const [old] = await tx<{ request_hash: string; shift_id: string }[]>`select request_hash, shift_id from cash_doc where id = ${d.id}`;
    if (old) {
      if (old.request_hash !== hash) throw new CashRefused("This entry id was already used for something else.", 409, "id_reused");
      if (opts.within) await opts.within(tx, d.id);
      return { docId: d.id, shiftId: old.shift_id, replay: true };
    }
    const person = await personAccount(tx, me);
    const machine = machineNo === null ? null : await machineAccount(tx, machineNo);
    // Out of a person's hands: never more than they hold.
    if (d.kind !== "collection") {
      const held = await heldFils(tx, person);
      if (held < amount) {
        throw new CashRefused(`You hold ${aed(held)} — this is ${aed(amount)}. Record the cash you collected first.`, 409, "not_enough_cash");
      }
    }
    const shift = await openShift(tx, me, now, correlationId);
    const synthetic = await isSynthetic(tx, me);
    await tx`
      insert into cash_doc (id, kind, shift_id, created_by, machine_id, amount_fils, expense_kind, litres, cdm_txn_no, cdm_operator, cds_id,
                            bag_no, denominations, receipt_at, note, device_at, request_hash, is_synthetic, correlation_id)
      values (${d.id}, ${d.kind}, ${shift.id}, ${me}, ${machine?.machineId ?? null}, ${amount}, ${expenseKind}, ${litres}, ${deposit.txn}, ${deposit.op},
              ${deposit.cds}, ${deposit.bag}, ${denominations ? tx.json(denominations) : null}, ${receiptAt}, ${note}, ${deviceTime(d.deviceAt)},
              ${hash}, ${synthetic}, ${correlationId})`;
    const [from, to] =
      d.kind === "collection"
        ? [machine!.accountId, person]
        : d.kind === "test_vend"
          ? [person, machine!.accountId]
          : d.kind === "deposit"
            ? [person, CASH_ACCOUNT.cdm]
            : [person, expenseKind === "fuel" ? CASH_ACCOUNT.fuel : CASH_ACCOUNT.other];
    if (amount > 0) {
      await tx`
        insert into cash_move (doc_id, from_account_id, to_account_id, fils, step, posted_by, is_synthetic, correlation_id)
        values (${d.id}, ${from}, ${to}, ${amount}, 'post', ${me}, ${synthetic}, ${correlationId})`;
    }
    await linkPhotos(tx, d.id, media, me, d.kind === "collection" ? "evidence" : "receipt", correlationId);
    await auditIn(tx, {
      correlationId, actor: `employee:${me}`, action: `cash.${d.kind}`, entity: "cash_doc", entityId: d.id,
      detail: { amountFils: amount, machineAssetNo: machineNo, expenseKind, shiftId: shift.id },
    });
    if (opts.within) await opts.within(tx, d.id);
    return { docId: d.id, shiftId: shift.id, replay: false };
  });
}

type Opts = {
  correlationId?: string;
  now?: Date;
  /** The caller's own step, in the same transaction, once the entry is posted (or found posted): a visit links its cash here. */
  within?: (tx: Tx, docId: string) => Promise<void>;
};

/** Cash taken out of a machine — 0 when the box was empty. */
export const recordCollection = (
  viewer: ViewerOrg,
  d: { id: string; machineAssetNo: number; amountFils: number; note?: string | null; deviceAt?: string | Date | null; mediaIds?: readonly string[] },
  opts?: Opts,
) => post(viewer, { ...d, kind: "collection" }, opts);

/** A note put back into a machine to test it ("cash test 10", "juice try 10"). */
export const recordTestVend = (
  viewer: ViewerOrg,
  d: { id: string; machineAssetNo: number; amountFils: number; note?: string | null; deviceAt?: string | Date | null },
  opts?: Opts,
) => post(viewer, { ...d, kind: "test_vend" }, opts);

/** Fuel, or something else, paid from the cash held — with its receipt. */
export const recordExpense = (
  viewer: ViewerOrg,
  d: { id: string; expenseKind: "fuel" | "other"; amountFils: number; litres?: number | null; receiptAt?: string | Date | null; note?: string | null; deviceAt?: string | Date | null; mediaIds?: readonly string[] },
  opts?: Opts,
) => post(viewer, { ...d, kind: "expense" }, opts);

/** Cash paid into the cash-deposit machine — with what its receipt says. */
export const recordDeposit = (
  viewer: ViewerOrg,
  d: {
    id: string;
    amountFils: number;
    cdmTxnNo?: string | null;
    cdmOperator?: string | null;
    cdsId?: string | null;
    bagNo?: string | null;
    denominations?: Record<string, number> | null;
    receiptAt?: string | Date | null;
    note?: string | null;
    deviceAt?: string | Date | null;
    mediaIds?: readonly string[];
  },
  opts?: Opts,
) => post(viewer, { ...d, kind: "deposit" }, opts);

// ── shifts ───────────────────────────────────────────────────────────────────
/** Start a shift (or carry on the open one). */
export async function startShift(viewer: ViewerOrg, req: { id: string; vehicle?: string | null }, opts: Opts = {}): Promise<{ shiftId: string; opened: boolean }> {
  requireCap(viewer, "cash.hold", "Your role does not handle cash.");
  if (!UUID_RE.test(req.id)) throw new CashRefused("The shift id must be a UUID made by the app.", 400, "bad_id");
  const correlationId = correlationOf(opts.correlationId);
  return getServiceSql().begin(async (tx) => {
    await lockPerson(tx, viewer.employeeId);
    const s = await openShift(tx, viewer.employeeId, opts.now ?? new Date(), correlationId, req.id);
    const vehicle = cleanText(req.vehicle, 40);
    if (s.opened && vehicle) await tx`update shift set vehicle = ${vehicle} where id = ${s.id}`;
    return { shiftId: s.id, opened: s.opened };
  });
}

/**
 * End a shift: the person's own — or, for someone who forgot, an auditor (never their own that way).
 * Cash still held stays held, carried to the next shift, and the person is told to deposit it.
 */
export async function endShift(viewer: ViewerOrg, req: { shiftId?: string }, opts: Opts = {}): Promise<{ shiftId: string; heldFils: number; replay: boolean }> {
  const correlationId = correlationOf(opts.correlationId);
  if (req.shiftId !== undefined && !UUID_RE.test(req.shiftId)) throw new CashRefused("No such shift.", 404, "no_shift");
  const sql = getServiceSql();
  const owner = req.shiftId ? (await sql<{ e: string }[]>`select employee_id as e from shift where id = ${req.shiftId}`)[0]?.e : viewer.employeeId;
  if (!owner) throw new CashRefused("No such shift.", 404, "no_shift");
  const forOther = owner !== viewer.employeeId;
  if (forOther) requireCap(viewer, "cash.audit", "Only the person, or an auditor, ends a shift.");
  else requireCap(viewer, "cash.hold", "Your role does not handle cash.");
  const r = await sql.begin(async (tx) => {
    await lockPerson(tx, owner);
    const [s] = req.shiftId
      ? await tx<{ id: string; state: string }[]>`select id, state from shift where id = ${req.shiftId} for update`
      : await tx<{ id: string; state: string }[]>`select id, state from shift where employee_id = ${owner} and state = 'open' for update`;
    if (!s) throw new CashRefused("You have no shift open.", 404, "no_shift");
    const held = await heldFils(tx, await personAccount(tx, owner));
    if (s.state === "closed") return { shiftId: s.id, heldFils: held, replay: true };
    await tx`update shift set state = 'closed', ended_at = ${opts.now ?? new Date()}, ended_by = ${viewer.employeeId} where id = ${s.id}`;
    await auditIn(tx, { correlationId, actor: `employee:${viewer.employeeId}`, action: "cash.shift_ended", entity: "shift", entityId: s.id, detail: { heldFils: held, forOther } });
    return { shiftId: s.id, heldFils: held, replay: false };
  });
  if (!r.replay && r.heldFils > 0) {
    await tell({
      to: [owner], key: `cash.held_at_end:${r.shiftId}`, kind: "cash.held_at_end", tag: `shift-${r.shiftId}`, reason: "your shift ended with cash in hand",
      title: `You hold ${aed(r.heldFils)}`,
      text: `🏧 Your shift has ended and you still hold ${aed(r.heldFils)}. Deposit it at the cash-deposit machine and record the receipt in FreshNow → Cash.`,
      correlationId,
    });
  }
  return r;
}

// ── undo ─────────────────────────────────────────────────────────────────────
/**
 * Undo an entry: the person's own while their shift is open and nobody has checked it (a typing slip);
 * an auditor, any entry of someone else's. The opposite move is posted; the entry stays, marked undone.
 */
export async function reverseCash(viewer: ViewerOrg, docId: string, req: { id: string; reason: CashReverseReason; note?: string | null }, opts: Opts = {}): Promise<CashPosted> {
  if (!UUID_RE.test(docId)) throw new CashRefused("No such entry.", 404, "no_doc");
  if (!UUID_RE.test(req.id)) throw new CashRefused("The undo's id must be a UUID made by the app.", 400, "bad_id");
  if (!(CASH_REVERSE_REASONS as readonly string[]).includes(req.reason)) throw new CashRefused("Choose why it is undone.", 400, "bad_reason");
  const note = cleanText(req.note, 500);
  if (req.reason === "other" && !note) throw new CashRefused("Say what was wrong.", 400, "note_needed");
  const correlationId = correlationOf(opts.correlationId);
  const hash = requestHash({ k: "reversal", of: docId, reason: req.reason, note });
  return getServiceSql().begin(async (tx) => {
    // Whose cash it is first, then their lock, then every check on rows read under it: ending the shift or a
    // second undo at the same moment waits here instead of slipping past a check made a moment earlier.
    const [o] = await tx<{ owner: string }[]>`select s.employee_id as owner from cash_doc d join shift s on s.id = d.shift_id where d.id = ${docId}`;
    if (!o) throw new CashRefused("No such entry.", 404, "no_doc");
    await lockPerson(tx, o.owner);
    const [d] = await tx<{ kind: string; state: string; created_by: string; amount_fils: string; shift_id: string; owner: string; shift_state: string; audited: boolean; is_synthetic: boolean }[]>`
      select d.kind, d.state, d.created_by, d.amount_fils::text, d.shift_id, s.employee_id as owner, s.state as shift_state,
             s.audit_outcome is not null as audited, d.is_synthetic
        from cash_doc d join shift s on s.id = d.shift_id where d.id = ${docId}
         for update of d, s`;
    if (!d) throw new CashRefused("No such entry.", 404, "no_doc");
    const active = viewer.status === "active";
    // An auditor undoes other people's entries; their own follow the person's rule, like anyone's.
    const asAuditor = active && can(viewer, "cash.audit") && d.owner !== viewer.employeeId;
    if (!asAuditor) {
      if (!(active && can(viewer, "cash.hold") && d.created_by === viewer.employeeId)) {
        throw new CashRefused("Only the person who made the entry, or an auditor, undoes it.", 403, "not_allowed");
      }
      if (d.shift_state !== "open" || d.audited) throw new CashRefused("That shift has ended or been checked — ask the cash auditor to undo it.", 409, "too_late");
    }
    const [again] = await tx<{ request_hash: string; reverses_doc_id: string | null }[]>`select request_hash, reverses_doc_id from cash_doc where id = ${req.id}`;
    if (again) {
      if (again.request_hash === hash && again.reverses_doc_id === docId) return { docId: req.id, shiftId: d.shift_id, replay: true };
      throw new CashRefused("This entry id was already used for something else.", 409, "id_reused");
    }
    if (d.kind === "reversal") throw new CashRefused("An undo is not undone — make the entry again.", 409, "not_reversible");
    if (d.state !== "posted") throw new CashRefused("This entry was already undone.", 409, "already_reversed");
    const moves = await tx<{ from_account_id: string; to_account_id: string; fils: string; virtual: boolean }[]>`
      select m.from_account_id, m.to_account_id, m.fils::text, a.is_virtual as virtual
        from cash_move m join cash_account a on a.id = m.to_account_id where m.doc_id = ${docId}`;
    // Undoing a collection takes the cash back out of the person's hands: it must still be there.
    for (const m of moves) {
      if (!m.virtual && (await heldFils(tx, m.to_account_id)) < Number(m.fils)) {
        throw new CashRefused("That cash has been spent or deposited since — undo those entries first.", 409, "not_enough_cash");
      }
    }
    await tx`
      insert into cash_doc (id, kind, shift_id, created_by, amount_fils, reason, note, reverses_doc_id, request_hash, is_synthetic, correlation_id)
      values (${req.id}, 'reversal', ${d.shift_id}, ${viewer.employeeId}, ${Number(d.amount_fils)}, ${req.reason}, ${note}, ${docId}, ${hash},
              ${d.is_synthetic}, ${correlationId})`;
    for (const m of moves) {
      await tx`
        insert into cash_move (doc_id, from_account_id, to_account_id, fils, step, posted_by, is_synthetic, correlation_id)
        values (${req.id}, ${m.to_account_id}, ${m.from_account_id}, ${Number(m.fils)}, 'reverse', ${viewer.employeeId}, ${d.is_synthetic}, ${correlationId})`;
    }
    await tx`update cash_doc set state = 'reversed' where id = ${docId}`;
    await auditIn(tx, { correlationId, actor: `employee:${viewer.employeeId}`, action: "cash.reversed", entity: "cash_doc", entityId: docId, detail: { reversal: req.id, reason: req.reason } });
    return { docId: req.id, shiftId: d.shift_id, replay: false };
  });
}

// ── the auditor's check, and the answer ──────────────────────────────────────
/**
 * Check an ended shift: "ok", or a question in words — the person and the Ops Head are told; the person
 * answers in the app. "Ok" after a question settles it. Nobody checks their own shift.
 */
export async function auditShift(viewer: ViewerOrg, shiftId: string, req: { outcome: "ok" | "query"; note?: string | null }, opts: Opts = {}): Promise<{ shiftId: string; outcome: "ok" | "query"; replay: boolean }> {
  requireCap(viewer, "cash.audit", "Only the cash auditor, the Ops Head, the CEO or an Admin checks a shift.");
  if (!UUID_RE.test(shiftId)) throw new CashRefused("No such shift.", 404, "no_shift");
  if (req.outcome !== "ok" && req.outcome !== "query") throw new CashRefused("Ok, or a question.", 400, "bad_outcome");
  const note = cleanText(req.note, 500);
  if (req.outcome === "query" && !note) throw new CashRefused("Write the question.", 400, "note_needed");
  const correlationId = correlationOf(opts.correlationId);
  const r = await getServiceSql().begin(async (tx) => {
    const [s] = await tx<{ employee_id: string; state: string; audit_outcome: string | null; audited_by: string | null; audit_note: string | null }[]>`
      select employee_id, state, audit_outcome, audited_by, audit_note from shift where id = ${shiftId} for update`;
    if (!s) throw new CashRefused("No such shift.", 404, "no_shift");
    if (s.employee_id === viewer.employeeId) throw new CashRefused("Nobody checks their own shift.", 403, "own_shift");
    if (s.state !== "closed") throw new CashRefused("The shift is still open — it is checked once it has ended.", 409, "shift_open");
    // The same check sent twice changes nothing; an "ok" stands. (An "ok" without words keeps the question it settled.)
    const same = s.audit_outcome === req.outcome && s.audited_by === viewer.employeeId && (s.audit_note === note || (req.outcome === "ok" && note === null));
    if (same) return { employeeId: s.employee_id, before: s.audit_outcome, replay: true };
    if (s.audit_outcome === "ok") throw new CashRefused("This shift was already checked and found ok.", 409, "already_ok");
    // "All ok" with no words of its own keeps the question it settles, so the answer kept beside it still answers something
    // — the shift is the only place the question is kept (D255; review of the fixes, 20 Oct).
    await tx`
      update shift set audit_outcome = ${req.outcome}, audited_by = ${viewer.employeeId}, audited_at = now(),
                       audit_note = coalesce(${note}::text, case when audit_outcome = 'query' then audit_note end)
       where id = ${shiftId}`;
    // The question's words stay on the shift, where retention and erasure reach them — never in the audit trail (D255).
    await auditIn(tx, {
      correlationId, actor: `employee:${viewer.employeeId}`, action: `cash.shift_${req.outcome}`, entity: "shift", entityId: shiftId,
      detail: { hasNote: note !== null, before: s.audit_outcome },
    });
    return { employeeId: s.employee_id, before: s.audit_outcome, replay: false };
  });
  if (!r.replay) {
    const who = await nameOf(viewer.employeeId);
    if (req.outcome === "query") {
      await tell({
        to: [r.employeeId], key: `cash.query:${shiftId}:${correlationId}`, kind: "cash.query", tag: `shift-${shiftId}`, urgent: true,
        reason: "your shift's cash has a question", title: "A question about your cash",
        text: `❓ ${who} has a question about your shift's cash. Read it and answer in FreshNow → Cash.`, correlationId,
      });
      const person = await nameOf(r.employeeId);
      await tell({
        to: await opsHeads([viewer.employeeId, r.employeeId]), key: `cash.query_ops:${shiftId}:${correlationId}`, kind: "cash.query", tag: `shift-${shiftId}`,
        reason: "you answer for cash with the auditor", title: `A question about ${person}'s cash`,
        text: `❓ ${who} asked ${person} a question about a shift's cash — it is in FreshNow → Cash.`, correlationId,
      });
    } else if (r.before === "query") {
      await tell({
        to: [r.employeeId], key: `cash.settled:${shiftId}:${correlationId}`, kind: "cash.settled", tag: `shift-${shiftId}`,
        reason: "your shift's cash had a question", title: "Your cash is checked", text: `✅ ${who} checked your shift's cash: all ok now.`, correlationId,
      });
    }
  }
  return { shiftId, outcome: req.outcome, replay: r.replay };
}

/** The person answers the auditor's question about their shift, in their own words. */
export async function answerQuery(
  viewer: ViewerOrg,
  shiftId: string,
  req: {
    note: string;
    /** When the question shown was asked (ShiftSummary.audit.at): a newer question is read before it is answered. */
    questionAt?: string | null;
  },
  opts: Opts = {},
): Promise<{ shiftId: string; replay: boolean }> {
  requireCap(viewer, "cash.hold", "Your role does not handle cash.");
  if (!UUID_RE.test(shiftId)) throw new CashRefused("No such shift.", 404, "no_shift");
  const note = cleanText(req.note, 500);
  if (!note) throw new CashRefused("Write your answer.", 400, "note_needed");
  const correlationId = correlationOf(opts.correlationId);
  const r = await getServiceSql().begin(async (tx) => {
    const [s] = await tx<{ employee_id: string; audit_outcome: string | null; audited_by: string | null; audited_at: Date | null; answer_note: string | null; answered_at: Date | null }[]>`
      select employee_id, audit_outcome, audited_by, audited_at, answer_note, answered_at from shift where id = ${shiftId} for update`;
    if (!s || s.employee_id !== viewer.employeeId) throw new CashRefused("No such shift of yours.", 404, "no_shift");
    if (s.audit_outcome !== "query") throw new CashRefused("There is no question about this shift.", 409, "no_question");
    // An answer written to an earlier question is never stored as the answer to a newer one (review of the fixes, 20 Oct).
    if (req.questionAt && s.audited_at && s.audited_at.toISOString() !== new Date(req.questionAt).toISOString()) {
      throw new CashRefused("The auditor has asked a new question — read it, then answer.", 409, "question_changed");
    }
    // Answered after the question was asked: the same words again change nothing.
    if (s.answered_at && s.audited_at && s.answered_at > s.audited_at && s.answer_note === note) return { auditor: s.audited_by, replay: true };
    await tx`update shift set answer_note = ${note}, answered_at = now() where id = ${shiftId}`;
    await auditIn(tx, { correlationId, actor: `employee:${viewer.employeeId}`, action: "cash.query_answered", entity: "shift", entityId: shiftId, detail: {} });
    return { auditor: s.audited_by, replay: false };
  });
  if (!r.replay && r.auditor) {
    await tell({
      to: [r.auditor], key: `cash.answer:${shiftId}:${correlationId}`, kind: "cash.answer", tag: `shift-${shiftId}`, reason: "you asked about this shift's cash",
      title: "Your question is answered", text: `💬 ${await nameOf(viewer.employeeId)} answered your question about their cash — read it in FreshNow → Cash.`, correlationId,
    });
  }
  return { shiftId, replay: r.replay };
}

// ── reads ────────────────────────────────────────────────────────────────────
export interface CashAbilities {
  hold: boolean;
  read: boolean;
  audit: boolean;
}

export function cashAbilitiesOf(viewer: ViewerOrg): CashAbilities {
  const on = viewer.status === "active";
  return { hold: on && can(viewer, "cash.hold"), read: on && can(viewer, "cash.read"), audit: on && can(viewer, "cash.audit") };
}

export interface CashEntry {
  id: string;
  kind: string;
  state: string;
  amountFils: number;
  machine: { assetNo: number | null; label: string } | null;
  expenseKind: string | null;
  litres: number | null;
  deposit: { txnNo: string | null; operator: string | null; cdsId: string | null; bagNo: string | null; denominations: Record<string, number> | null } | null;
  receiptAt: string | null;
  note: string | null;
  reason: string | null;
  reversesId: string | null;
  recordedAt: string;
  /** When the phone says it was made, if plausible, else recordedAt — shown beside it; Televend is matched on recordedAt. */
  enteredAt: string;
  photos: string[];
  /**
   * A collection: what Televend's own cash sales say the box held (D221) — null when Televend saw no
   * collection near it, and always null for anyone who does not see all cash (D237).
   */
  televend: { collectedAt: string; previousAt: string | null; cashVends: number; expectedFils: number } | null;
  may: { undo: boolean };
}

export interface ShiftSummary {
  id: string;
  employee: { id: string; name: string };
  businessDate: string;
  state: string;
  startedAt: string;
  endedAt: string | null;
  vehicle: string | null;
  /** Held from earlier shifts when this one started (as the books stand now). */
  carriedInFils: number;
  collectedFils: number;
  testFils: number;
  fuelFils: number;
  otherFils: number;
  depositedFils: number;
  /** carried in + collected − test notes − spent − deposited: what the person held at the end of it. */
  leftFils: number;
  collections: number;
  /**
   * Collections whose amount differs from Televend's "should have found" — null for anyone who does not
   * see all cash: like a blind count, a driver shown the expected figure could undo an entry and type it
   * again to match (D237).
   */
  differences: number | null;
  /** Collections Televend saw no collection for, within 90 minutes — null as above. */
  unmatched: number | null;
  /** Collections, expenses and deposits without a photo. */
  withoutPhoto: number;
  audit: { outcome: string; by: string; at: string; note: string | null } | null;
  /** The person's answer — while a question stands, only one given after it (null until they answer). */
  answer: { note: string; at: string } | null;
  may: { end: boolean; audit: boolean; answer: boolean };
}

export interface ShiftDetail extends ShiftSummary {
  entries: CashEntry[];
}

export interface CashHome {
  can: CashAbilities;
  /** What the viewer holds now, across shifts. */
  heldFils: number;
  openShift: ShiftDetail | null;
  /** Their last ended shifts, newest first. */
  recentShifts: ShiftSummary[];
  /** Their shifts with a question standing — however old — newest first: each one is answered from here. */
  questions: ShiftSummary[];
  /** For auditors: ended shifts not yet checked ok, oldest first — never their own. */
  toCheck: ShiftSummary[];
}

export interface CashMachine {
  assetNo: number;
  label: string;
}

const num = (s: string | number | null | undefined): number => (s === null || s === undefined ? 0 : Number(s));

/** Names of people from rows the viewer may see (read with the service role, only for those ids). */
async function namesOf(ids: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((x): x is string => typeof x === "string"))];
  if (want.length === 0) return new Map();
  const rows = await getServiceSql()<{ id: string; display_name: string }[]>`select id, display_name from employee where id = any(${want}::uuid[])`;
  return new Map(rows.map((r) => [r.id, r.display_name]));
}

/** A machine's number and name for the machines of rows the viewer may see — a driver does not read the machine table. */
async function machinesOf(ids: readonly (string | null)[]): Promise<Map<string, { assetNo: number | null; label: string }>> {
  const want = [...new Set(ids.filter((x): x is string => typeof x === "string"))];
  if (want.length === 0) return new Map();
  const rows = await getServiceSql()<{ id: string; asset_no: number | null; label: string }[]>`select id, asset_no, label from machine where id = any(${want}::uuid[])`;
  return new Map(rows.map((r) => [r.id, { assetNo: r.asset_no, label: r.label }]));
}

/**
 * Televend's side of each collection (D221): the "Cash Collection" event on the same machine nearest the
 * entry (within 90 minutes), and the cash sales since the one before it, times the machine's price (every
 * sale in the mirror is one cup — checked 19 Oct). One query for all of them. Read with the service role: an
 * auditor sees this one derived figure, not Televend's tables.
 */
async function televendSide(entries: readonly { id: string; machineId: string; at: Date }[]): Promise<Map<string, CashEntry["televend"]>> {
  const out = new Map<string, CashEntry["televend"]>();
  if (entries.length === 0) return out;
  const price = loadConfig().OPS_DEFAULT_CASH_PRICE_FILS;
  const rows = await getServiceSql()<{ doc_id: string; at: Date; prev_at: Date | null; cash_vends: number; price_fils: number }[]>`
    select e.doc_id, x.at, x.prev_at, x.cash_vends, x.price_fils
      from unnest(${entries.map((e) => e.id)}::uuid[], ${entries.map((e) => e.machineId)}::uuid[], ${entries.map((e) => e.at.toISOString())}::text[])
           as e (doc_id, machine_id, at_text)
     cross join lateral (
       select c.at, c.prev_at,
              (select count(*) from tv_vend v
                where v.machine_tv_id = any(c.tv_ids) and v.payment_type = 0
                  and v.at >= coalesce(c.prev_at, c.at - interval '30 days') + interval '1 minute'
                  and v.at < c.at + interval '1 minute')::int as cash_vends,
              coalesce((select m.cash_price_fils from machine m where m.id = e.machine_id), ${price}) as price_fils
         from (select ev.started_at as at, lag(ev.started_at) over (order by ev.started_at) as prev_at, t.tv_ids
                 from (select array_agg(p.tv_machine_id) as tv_ids from machine_placement p where p.machine_id = e.machine_id) t
                 join tv_event ev on ev.machine_tv_id = any(t.tv_ids)
                where ev.name = 'Cash Collection'
                  and ev.started_at > e.at_text::timestamptz - interval '120 days'
                  and ev.started_at <= e.at_text::timestamptz + interval '90 minutes') c
        where abs(extract(epoch from (c.at - e.at_text::timestamptz))) <= 5400
        order by abs(extract(epoch from (c.at - e.at_text::timestamptz)))
        limit 1) x`;
  for (const r of rows) {
    out.set(r.doc_id, { collectedAt: r.at.toISOString(), previousAt: r.prev_at?.toISOString() ?? null, cashVends: r.cash_vends, expectedFils: r.cash_vends * r.price_fils });
  }
  return out;
}

interface ShiftRow {
  id: string;
  employee_id: string;
  business_date: string;
  state: string;
  started_at: Date;
  ended_at: Date | null;
  vehicle: string | null;
  audit_outcome: string | null;
  audited_by: string | null;
  audited_at: Date | null;
  audit_note: string | null;
  answer_note: string | null;
  answered_at: Date | null;
}

/**
 * When the phone says an entry was made, for the auditor to read beside the server's time: the phone's time when it is
 * plausible (an offline phone only delays an entry: up to 12 h earlier, never more than 5 minutes later), else the server's.
 * It is shown, never matched: matching Televend's collections uses the server's time, which a crafted request cannot move
 * (review of the fixes, 20 Oct — no client sends a phone time yet; the Android app's offline queue will need its own rule).
 */
const entryTime = (d: { device_at: Date | null; recorded_at: Date }): Date => {
  if (!d.device_at) return d.recorded_at;
  const ahead = d.device_at.getTime() - d.recorded_at.getTime();
  return ahead <= 5 * 60_000 && ahead >= -12 * 3_600_000 ? d.device_at : d.recorded_at;
};

const SHIFT_COLUMNS =
  "id, employee_id, business_date::text, state, started_at, ended_at, vehicle, audit_outcome, audited_by, audited_at, audit_note, answer_note, answered_at";

/** Shifts under the viewer's row security, summed — and with their entries, when asked. */
async function summaries(tx: Tx, viewer: ViewerOrg, shifts: readonly ShiftRow[], withEntries: boolean): Promise<ShiftDetail[]> {
  if (shifts.length === 0) return [];
  const ids = shifts.map((s) => s.id);
  const docs = await tx<{
    id: string;
    shift_id: string;
    kind: string;
    state: string;
    created_by: string;
    amount_fils: string;
    machine_id: string | null;
    expense_kind: string | null;
    litres: string | null;
    cdm_txn_no: string | null;
    cdm_operator: string | null;
    cds_id: string | null;
    bag_no: string | null;
    denominations: Record<string, number> | null;
    receipt_at: Date | null;
    note: string | null;
    reason: string | null;
    reverses_doc_id: string | null;
    device_at: Date | null;
    recorded_at: Date;
    photos: number;
  }[]>`
    select d.id, d.shift_id, d.kind, d.state, d.created_by, d.amount_fils::text, d.machine_id, d.expense_kind, d.litres::text, d.cdm_txn_no,
           d.cdm_operator, d.cds_id, d.bag_no, d.denominations, d.receipt_at, d.note, d.reason, d.reverses_doc_id, d.device_at, d.recorded_at,
           (select count(*)::int from media_link l where l.entity_type = 'cash_doc' and l.entity_id = d.id) as photos
      from cash_doc d
     where d.shift_id = any(${ids}::uuid[])
     order by d.recorded_at`;
  const carried = new Map(
    (
      await tx<{ id: string; carried: string }[]>`
        select s.id,
               coalesce((select sum(case when m.to_account_id = a.id then m.fils else -m.fils end)
                           from cash_move m
                           join cash_doc d on d.id = m.doc_id
                           join shift s2 on s2.id = d.shift_id
                          where s2.employee_id = s.employee_id and s2.started_at < s.started_at
                            and a.id in (m.from_account_id, m.to_account_id)), 0)::text as carried
          from shift s
          left join cash_account a on a.kind = 'person' and a.employee_id = s.employee_id
         where s.id = any(${ids}::uuid[])`
    ).map((r) => [r.id, Number(r.carried)]),
  );
  const live = docs.filter((d) => d.state === "posted" && d.kind !== "reversal");
  const a = cashAbilitiesOf(viewer);
  const tv = a.read
    ? await televendSide(live.filter((d) => d.kind === "collection" && d.machine_id).map((d) => ({ id: d.id, machineId: d.machine_id!, at: d.recorded_at })))
    : new Map<string, CashEntry["televend"]>();
  const photoIds = withEntries
    ? await tx<{ entity_id: string; media_id: string }[]>`
        select l.entity_id, l.media_id from media_link l join media_object o on o.id = l.media_id
         where l.entity_type = 'cash_doc' and l.entity_id = any(${docs.map((d) => d.id)}::uuid[])
         order by l.linked_at`
    : [];
  const names = await namesOf(shifts.flatMap((s) => [s.employee_id, s.audited_by]));
  const machines = await machinesOf(docs.map((d) => d.machine_id));
  const me = viewer.employeeId;
  return shifts.map((s) => {
    const mine = live.filter((d) => d.shift_id === s.id);
    const sum = (pred: (d: (typeof mine)[number]) => boolean) => mine.filter(pred).reduce((t, d) => t + num(d.amount_fils), 0);
    const collections = mine.filter((d) => d.kind === "collection");
    const collected = sum((d) => d.kind === "collection");
    const test = sum((d) => d.kind === "test_vend");
    const fuel = sum((d) => d.kind === "expense" && d.expense_kind === "fuel");
    const other = sum((d) => d.kind === "expense" && d.expense_kind === "other");
    const deposited = sum((d) => d.kind === "deposit");
    const carriedIn = carried.get(s.id) ?? 0;
    const own = s.employee_id === me;
    const detail: ShiftDetail = {
      id: s.id,
      employee: { id: s.employee_id, name: names.get(s.employee_id) ?? "—" },
      businessDate: s.business_date,
      state: s.state,
      startedAt: s.started_at.toISOString(),
      endedAt: s.ended_at?.toISOString() ?? null,
      vehicle: s.vehicle,
      carriedInFils: carriedIn,
      collectedFils: collected,
      testFils: test,
      fuelFils: fuel,
      otherFils: other,
      depositedFils: deposited,
      leftFils: carriedIn + collected - test - fuel - other - deposited,
      collections: collections.length,
      differences: a.read
        ? collections.filter((d) => {
            const t = tv.get(d.id);
            return t !== undefined && t !== null && t.expectedFils !== num(d.amount_fils);
          }).length
        : null,
      unmatched: a.read ? collections.filter((d) => !tv.get(d.id)).length : null,
      withoutPhoto: mine.filter((d) => CASH_PHOTO_NEEDED[d.kind as EntryKind] && d.photos === 0).length,
      audit: s.audit_outcome ? { outcome: s.audit_outcome, by: names.get(s.audited_by!) ?? "—", at: s.audited_at!.toISOString(), note: s.audit_note } : null,
      // While a question stands, only an answer given after it is its answer: a second question is unanswered until answered.
      answer:
        s.answer_note && s.answered_at && (s.audit_outcome !== "query" || (s.audited_at !== null && s.answered_at > s.audited_at))
          ? { note: s.answer_note, at: s.answered_at.toISOString() }
          : null,
      may: {
        end: s.state === "open" && (own ? a.hold : a.audit),
        audit: s.state === "closed" && a.audit && !own && s.audit_outcome !== "ok",
        answer: own && a.hold && s.audit_outcome === "query",
      },
      entries: [],
    };
    if (withEntries) {
      const auditorHere = a.audit && !own;
      const openUnchecked = s.state === "open" && s.audit_outcome === null;
      detail.entries = docs
        .filter((d) => d.shift_id === s.id)
        .map((d) => ({
          id: d.id,
          kind: d.kind,
          state: d.state,
          amountFils: num(d.amount_fils),
          machine: d.machine_id ? (machines.get(d.machine_id) ?? null) : null,
          expenseKind: d.expense_kind,
          litres: d.litres === null ? null : Number(d.litres),
          deposit: d.kind === "deposit" ? { txnNo: d.cdm_txn_no, operator: d.cdm_operator, cdsId: d.cds_id, bagNo: d.bag_no, denominations: d.denominations } : null,
          receiptAt: d.receipt_at?.toISOString() ?? null,
          note: d.note,
          reason: d.reason,
          reversesId: d.reverses_doc_id,
          recordedAt: d.recorded_at.toISOString(),
          enteredAt: entryTime(d).toISOString(),
          photos: photoIds.filter((p) => p.entity_id === d.id).map((p) => p.media_id),
          televend: d.kind === "collection" ? (tv.get(d.id) ?? null) : null,
          may: { undo: d.state === "posted" && d.kind !== "reversal" && (auditorHere || (own && a.hold && d.created_by === me && openUnchecked)) },
        }));
    }
    return detail;
  });
}

function requireSome(viewer: ViewerOrg): CashAbilities {
  const a = cashAbilitiesOf(viewer);
  if (!a.hold && !a.read) throw new CashRefused("Cash is not part of your role.", 403, "not_allowed");
  return a;
}

export async function cashHome(viewer: ViewerOrg): Promise<CashHome> {
  const a = requireSome(viewer);
  return withContext(
    viewer,
    async (tx) => {
      const me = viewer.employeeId;
      const [held] = await tx<{ fils: string }[]>`
        select b.fils::text from cash_balance b join cash_account c on c.id = b.account_id where c.kind = 'person' and c.employee_id = ${me}`;
      const open = await tx.unsafe<ShiftRow[]>(`select ${SHIFT_COLUMNS} from shift where employee_id = $1 and state = 'open'`, [me]);
      const recent = await tx.unsafe<ShiftRow[]>(`select ${SHIFT_COLUMNS} from shift where employee_id = $1 and state = 'closed' order by started_at desc limit 7`, [me]);
      const asked = await tx.unsafe<ShiftRow[]>(
        `select ${SHIFT_COLUMNS} from shift where employee_id = $1 and audit_outcome = 'query' order by started_at desc limit 50`,
        [me],
      );
      const toCheck = a.audit
        ? await tx.unsafe<ShiftRow[]>(
            `select ${SHIFT_COLUMNS} from shift where state = 'closed' and audit_outcome is distinct from 'ok' and employee_id <> $1 order by started_at limit 50`,
            [me],
          )
        : [];
      return {
        can: a,
        heldFils: held ? Number(held.fils) : 0,
        openShift: (await summaries(tx, viewer, open, true))[0] ?? null,
        recentShifts: await summaries(tx, viewer, recent, false),
        questions: await summaries(tx, viewer, asked, false),
        toCheck: await summaries(tx, viewer, toCheck, false),
      };
    },
    { readOnly: true },
  );
}

/** One shift with its entries — the person's own, or anyone's for whoever sees all cash. */
export async function cashShift(viewer: ViewerOrg, shiftId: string): Promise<ShiftDetail | null> {
  requireSome(viewer);
  if (!UUID_RE.test(shiftId)) return null;
  return withContext(
    viewer,
    async (tx) => {
      const rows = await tx.unsafe<ShiftRow[]>(`select ${SHIFT_COLUMNS} from shift where id = $1`, [shiftId]);
      return (await summaries(tx, viewer, rows, true))[0] ?? null;
    },
    { readOnly: true },
  );
}

/** Shifts by business date (Dubai), newest first — for whoever sees all cash. */
export async function cashShifts(viewer: ViewerOrg, q: { from?: string; to?: string; employeeId?: string } = {}, now: Date = new Date()): Promise<ShiftSummary[]> {
  if (!cashAbilitiesOf(viewer).read) throw new CashRefused("Everyone's cash is for the cash auditor, the Ops Head, the CEO and Admins.", 403, "not_allowed");
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const from = q.from && day.test(q.from) ? q.from : localDate(new Date(now.getTime() - 7 * 86_400_000));
  const to = q.to && day.test(q.to) ? q.to : localDate(now);
  const emp = q.employeeId && UUID_RE.test(q.employeeId) ? q.employeeId : null;
  return withContext(
    viewer,
    async (tx) => {
      const rows = await tx.unsafe<ShiftRow[]>(
        `select ${SHIFT_COLUMNS} from shift where business_date between $1::date and $2::date and ($3::uuid is null or employee_id = $3)
          order by business_date desc, started_at desc limit 200`,
        [from, to, emp],
      );
      return summaries(tx, viewer, rows, false);
    },
    { readOnly: true },
  );
}

/** The machines by the number on their sticker — for choosing one when collecting. */
export async function cashMachines(viewer: ViewerOrg): Promise<CashMachine[]> {
  requireSome(viewer);
  const rows = await getServiceSql()<{ asset_no: number; label: string }[]>`
    select asset_no, label from machine where status = 'active' and asset_no is not null order by asset_no`;
  return rows.map((r) => ({ assetNo: r.asset_no, label: r.label }));
}
