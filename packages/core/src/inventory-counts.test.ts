import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getServiceSql } from "./db.js";
import {
  cancelCount,
  decideCount,
  startCount,
  startRecount,
  submitCount,
  submitRecount,
  waiveRecount,
  type CountItem,
} from "./inventory-counts.js";
import { saveItem } from "./inventory-catalogue.js";
import { PLACE, answerHandover, cancelHandover, receiveDelivery, recordUse, reverseDocument, startHandover } from "./inventory-ledger.js";
import { inventoryCount, inventoryDay, inventoryDoc, inventoryHolders, inventoryHome } from "./inventory-read.js";
import { createHash } from "node:crypto";
import { withContext } from "./db.js";
import { DEMO_CEO_ID } from "./meta.js";
import { loadViewer, type ViewerOrg } from "./org.js";

/**
 * Counting the warehouse (TASK-060, D218), against real Postgres. The rules under test, as decided:
 *   - the count screen never shows the ledger's figure;
 *   - a difference beyond the item's tolerance is counted again by SOMEONE ELSE, also blind;
 *   - the Ops Head, the CEO or an Admin decides — never anyone who counted; accepting a count posts an
 *     adjustment, keeping the ledger moves nothing;
 *   - an item that moved while it was counted is never "accepted as counted".
 */

const TAG = `CNT-${randomUUID().slice(0, 6)}`;
const KEEP = randomUUID();
const KEEP2 = randomUUID();
const OPS = randomUUID();
const OPS2 = randomUUID();
const VMO = randomUUID();
const AUD = randomUUID(); // the cash auditor: no stock at all
const LEFT = randomUUID(); // a driver who leaves holding stock
const MOVED = randomUUID(); // a driver whose role changes to one that holds no stock
const KEEP3 = randomUUID(); // a keeper who leaves while a handover of theirs waits
const LEFT2 = randomUUID(); // the driver it waits for, who leaves too
const STAFF = [KEEP, KEEP2, OPS, OPS2, VMO, AUD, LEFT, MOVED, KEEP3, LEFT2];
const ORANGES = randomUUID();
const STRAWS = randomUUID();
const NEWITEM = randomUUID();
// One item per finding of the TASK-060 review, so each test starts from a ledger it knows.
const TWICE = randomUUID();
const UNDONE = randomUUID();
const TRANSIT = randomUUID();
const WAIVED = randomUUID();
const AGAIN = randomUUID();
const UNIT = randomUUID();
const BLIND = randomUUID();
// The review of 20 Oct.
const NET = randomUUID();
const PA = randomUUID();
const PB = randomUUID();
const FRESH = randomUUID();
const LOW = randomUUID();
const KEPT = randomUUID();
// The review of the fixes, 20 Oct.
const ADJ = randomUUID();
const REV = randomUUID();
const STUCK = randomUUID();
const ITEMS: string[] = [ORANGES, STRAWS, NEWITEM];
const REVIEW_ITEMS: string[] = [TWICE, UNDONE, TRANSIT, WAIVED, AGAIN, UNIT, BLIND, NET, PA, PB, FRESH, LOW, KEPT, ADJ, REV, STUCK];
let MACHINE = "";
const ASSET = 99_871;
const sql = () => getServiceSql();
const v: Record<string, ViewerOrg> = {};
const id = () => randomUUID();

const inWarehouse = async (itemId: string): Promise<number> => {
  const [r] = await sql()<{ q: string }[]>`select qty::text as q from stock_balance where location_id = ${PLACE.warehouse} and item_id = ${itemId}`;
  return r ? Number(r.q) : 0;
};

async function refusal(p: Promise<unknown>): Promise<{ status: number; code: string; message: string }> {
  try {
    await p;
  } catch (err) {
    const e = err as { status?: number; code?: string; message: string };
    return { status: e.status ?? 0, code: e.code ?? "", message: e.message };
  }
  throw new Error("expected a refusal, but it was accepted");
}

/**
 * A full count: every active item gets a number. Ours as given; any other item (the catalogue seeded
 * by 0032) as the ledger has it — those are not what these tests are about.
 */
async function fullLines(items: readonly CountItem[], ours: Record<string, number | string>): Promise<{ itemId: string; qty: number | string }[]> {
  const out: { itemId: string; qty: number | string }[] = [];
  for (const i of items) out.push({ itemId: i.id, qty: ours[i.id] ?? (await inWarehouse(i.id)) });
  return out;
}

beforeAll(async () => {
  const s = sql();
  const people: [string, string, string][] = [
    [KEEP, "Keeper", "warehouse_keeper"],
    [KEEP2, "Keeper Two", "warehouse_keeper"],
    [OPS, "Ops Head", "ops_head"],
    [OPS2, "Ops Head Two", "ops_head"],
    [VMO, "Driver", "vmo"],
    [AUD, "Cash auditor", "cash_auditor"],
    [LEFT, "Leaver", "vmo"],
    [MOVED, "Moved", "vmo"],
    [KEEP3, "Keeper Three", "warehouse_keeper"],
    [LEFT2, "Leaver Two", "vmo"],
  ];
  for (const [pid, name, role] of people) {
    await s`insert into employee (id, display_name, status, is_synthetic, access_role, manager_employee_id)
            values (${pid}, ${`${TAG} ${name}`}, 'active', true, ${role}, ${DEMO_CEO_ID})`;
  }
  await s`insert into inv_item (id, name, category, unit, step, count_tolerance, sort_order, is_synthetic) values
          (${ORANGES}, ${`${TAG} oranges`}, 'oranges', 'carton', 1, 0, 1, true),
          (${STRAWS}, ${`${TAG} straws`}, 'cups_packaging', 'box', 0.5, 0.5, 2, true),
          (${NEWITEM}, ${`${TAG} new item`}, 'other', 'piece', 1, 0, 3, true)`;
  for (const [n, itemId] of REVIEW_ITEMS.entries()) {
    await s`insert into inv_item (id, name, category, unit, step, count_tolerance, sort_order, is_synthetic)
            values (${itemId}, ${`${TAG} review ${n}`}, 'other', 'box', 1, 0, ${10 + n}, true)`;
  }
  await s`update inv_item set min_level = 5 where id = ${LOW}`;
  MACHINE = (await s<{ id: string }[]>`insert into machine (asset_no, label, is_synthetic) values (${ASSET}, ${`${TAG} Mall-${ASSET}`}, true) returning id`)[0]!.id;
  for (const pid of STAFF) v[pid] = (await loadViewer(pid))!;
  await receiveDelivery(v[KEEP]!, { id: id(), lines: [{ itemId: ORANGES, qty: 10 }, { itemId: STRAWS, qty: 2 }] });
});

afterAll(async () => {
  await sql().begin(async (tx) => {
    const docs = (await tx<{ id: string }[]>`select id from stock_doc where created_by = any(${STAFF}::uuid[])`).map((r) => r.id);
    await tx`select inv_purge_docs(${docs}::uuid[])`;
    await tx`set local freshnow.ledger_purge = 'on'`;
    await tx`delete from count_line where session_id in (select id from count_session where started_by = any(${STAFF}::uuid[]))`;
    await tx`delete from count_session where started_by = any(${STAFF}::uuid[])`;
    await tx`delete from stock_balance where item_id = any(${[...ITEMS, ...REVIEW_ITEMS]}::uuid[])`;
    await tx`delete from inv_location where employee_id = any(${STAFF}::uuid[])`;
    await tx`delete from inv_item where id = any(${[...ITEMS, ...REVIEW_ITEMS]}::uuid[])`;
  });
  await sql()`delete from media_object where uploaded_by = any(${STAFF}::uuid[])`;
  await sql()`delete from machine where id = ${MACHINE}`;
  await sql()`delete from notification_outbox where idempotency_key like ${"stock.%"}`;
  await sql()`delete from audit_log where actor = any(${STAFF.map((s) => `employee:${s}`)}) or action in (${"stock.low_alerted"}, ${"stock.handover_reminded"}, ${"stock.count_reminded"})`;
  await sql()`delete from employee where id = any(${STAFF}::uuid[])`;
  await closeDb();
});

describe("a count", () => {
  it("lists what to count and never the ledger's figures; when everything matches it closes with nothing to decide", async () => {
    const S = id();
    const r = await startCount(v[KEEP]!, { id: S, kind: "opening" });
    expect(r.state).toBe("counting");
    const ours = r.items.filter((i) => ITEMS.includes(i.id));
    expect(ours.map((i) => i.name)).toEqual([`${TAG} oranges`, `${TAG} straws`, `${TAG} new item`]);
    for (const i of r.items) expect(Object.keys(i).sort()).toEqual(["icon", "id", "name", "step", "unit"]);
    const out = await submitCount(v[KEEP]!, S, { lines: await fullLines(r.items, { [ORANGES]: 10, [STRAWS]: 2, [NEWITEM]: 0 }) });
    expect(out.state).toBe("closed");
    expect(out.recount + out.small).toBe(0);
    const home = await inventoryHome(v[KEEP]!);
    expect(home.today?.opening).not.toBeNull();
  });

  it("is one at a time, handed in by whoever opened it; opening it again resumes it", async () => {
    const S = id();
    const r = await startCount(v[KEEP]!, { id: S, kind: "spot" });
    expect((await refusal(startCount(v[KEEP2]!, { id: id(), kind: "spot" }))).code).toBe("count_open");
    expect((await refusal(submitCount(v[KEEP2]!, S, { lines: [{ itemId: ORANGES, qty: 10 }] }))).status).toBe(403);
    expect((await startCount(v[KEEP]!, { id: id(), kind: "spot" })).sessionId).toBe(S);
    expect((await startCount(v[KEEP]!, { id: S, kind: "spot" })).resumed).toBe(true);
    // A full count needs every item; a spot count, the items counted.
    const full = id();
    await cancelCount(v[KEEP]!, S);
    await startCount(v[KEEP]!, { id: full, kind: "closing" });
    expect((await refusal(submitCount(v[KEEP]!, full, { lines: [{ itemId: ORANGES, qty: 10 }] }))).code).toBe("count_every_item");
    await cancelCount(v[KEEP]!, full);
    expect(r.items.length).toBeGreaterThan(0);
  });

  it("with only a small difference goes straight to an approver, and the person who counted cannot decide it", async () => {
    const S = id();
    await startCount(v[KEEP]!, { id: S, kind: "spot" });
    const out = await submitCount(v[KEEP]!, S, { lines: [{ itemId: STRAWS, qty: "1.5" }] }); // ledger 2, tolerance 0.5
    expect(out).toMatchObject({ state: "approval", small: 1, recount: 0 });
    expect((await refusal(decideCount(v[KEEP]!, S, { docId: id(), lines: [{ itemId: STRAWS, decision: "accept_count", reason: "used_unrecorded" }] }))).status).toBe(403);
    expect((await refusal(decideCount(v[OPS]!, S, { docId: id(), lines: [{ itemId: STRAWS, decision: "accept_count" }] }))).code).toBe("reason_needed");
    const doc = id();
    const d = await decideCount(v[OPS]!, S, { docId: doc, lines: [{ itemId: STRAWS, decision: "accept_count", reason: "used_unrecorded" }] });
    expect(d).toMatchObject({ state: "closed", adjustmentDocId: doc });
    expect(await inWarehouse(STRAWS)).toBe(1.5);
    // The same decision sent again changes nothing.
    expect((await decideCount(v[OPS]!, S, { docId: doc, lines: [{ itemId: STRAWS, decision: "accept_count", reason: "used_unrecorded" }] })).replay).toBe(true);
    expect(await inWarehouse(STRAWS)).toBe(1.5);
  });

  it("with a big difference is counted again by someone else, who sees neither the ledger nor the first count", async () => {
    const S = id();
    await startCount(v[KEEP]!, { id: S, kind: "spot" });
    expect((await submitCount(v[KEEP]!, S, { lines: [{ itemId: ORANGES, qty: 7 }] })).state).toBe("recount");
    expect((await refusal(startRecount(v[KEEP]!, S))).code).toBe("own_count");
    expect((await refusal(decideCount(v[OPS]!, S, { docId: id(), lines: [] }))).code).toBe("not_for_decision");
    const rc = await startRecount(v[KEEP2]!, S);
    expect(rc.items.map((i) => i.id)).toEqual([ORANGES]);
    const seenByRecounter = await inventoryCount(v[KEEP2]!, S);
    expect(seenByRecounter!.lines[0]).toMatchObject({ counted: null, expected: null });
    const seenByCounter = await inventoryCount(v[KEEP]!, S);
    expect(seenByCounter!.lines[0]).toMatchObject({ counted: 7, expected: null });
    expect((await refusal(startRecount(v[OPS]!, S))).code).toBe("recount_taken");
    expect((await submitRecount(v[KEEP2]!, S, { lines: [{ itemId: ORANGES, qty: 7 }] })).state).toBe("approval");

    const seenByApprover = await inventoryCount(v[OPS]!, S);
    expect(seenByApprover!.lines[0]).toMatchObject({ counted: 7, expected: 10, recount: 7, recountExpected: 10, needsDecision: true });
    expect((await refusal(decideCount(v[OPS]!, S, { docId: id(), lines: [] }))).code).toBe("decide_every_line");
    await decideCount(v[OPS]!, S, { docId: id(), lines: [{ itemId: ORANGES, decision: "accept_count", reason: "unexplained" }], note: "both counts say 7" });
    expect(await inWarehouse(ORANGES)).toBe(7);
    const closed = await inventoryCount(v[KEEP]!, S);
    expect(closed!.lines[0]).toMatchObject({ counted: 7, expected: 10 });
  });

  it("can show the first count was wrong: the ledger is kept and nothing moves", async () => {
    const S = id();
    await startCount(v[KEEP]!, { id: S, kind: "spot" });
    await submitCount(v[KEEP]!, S, { lines: [{ itemId: ORANGES, qty: 5 }] });
    await startRecount(v[KEEP2]!, S);
    await submitRecount(v[KEEP2]!, S, { lines: [{ itemId: ORANGES, qty: 7 }] });
    // The recount agrees with the ledger: nothing differs any more, nothing to decide.
    const d = await decideCount(v[OPS]!, S, { docId: id(), lines: [] });
    expect(d).toMatchObject({ state: "closed", adjustmentDocId: null });
    expect(await inWarehouse(ORANGES)).toBe(7);
  });

  it("of an item that moved while it was counted is counted again, and is never accepted as counted", async () => {
    const S = id();
    const H1 = id();
    const H2 = id();
    await startCount(v[KEEP]!, { id: S, kind: "spot" });
    await startHandover(v[OPS]!, { id: H1, from: { kind: "warehouse" }, to: { kind: "person", employeeId: VMO }, lines: [{ itemId: ORANGES, qty: 1 }] });
    // 6 is right by now — but the count and the ledger are from different moments.
    expect((await submitCount(v[KEEP]!, S, { lines: [{ itemId: ORANGES, qty: 6 }] })).state).toBe("recount");
    await startRecount(v[KEEP2]!, S);
    await startHandover(v[OPS]!, { id: H2, from: { kind: "warehouse" }, to: { kind: "person", employeeId: VMO }, lines: [{ itemId: ORANGES, qty: 1 }] });
    await submitRecount(v[KEEP2]!, S, { lines: [{ itemId: ORANGES, qty: 4 }] });
    expect((await refusal(decideCount(v[OPS2]!, S, { docId: id(), lines: [{ itemId: ORANGES, decision: "accept_count", reason: "unexplained" }] }))).code).toBe("moved_during");
    await decideCount(v[OPS2]!, S, { docId: id(), lines: [{ itemId: ORANGES, decision: "keep_ledger" }] });
    expect(await inWarehouse(ORANGES)).toBe(5);
    // The driver collects both: nothing of it is on its way any more.
    await answerHandover(v[VMO]!, H1, { answer: "accept" });
    await answerHandover(v[VMO]!, H2, { answer: "accept" });
  });

  it("of a new item's opening stock: an approver may let the recount go, with a reason, and approve it", async () => {
    const S = id();
    await startCount(v[KEEP]!, { id: S, kind: "spot" });
    expect((await submitCount(v[KEEP]!, S, { lines: [{ itemId: NEWITEM, qty: 12 }] })).state).toBe("recount");
    expect((await refusal(waiveRecount(v[KEEP]!, S, { reason: "only me on shift" }))).status).toBe(403);
    expect((await refusal(waiveRecount(v[OPS]!, S, { reason: "" }))).code).toBe("reason_needed");
    expect((await waiveRecount(v[OPS]!, S, { reason: "first count of a new item" })).state).toBe("approval");
    await decideCount(v[OPS]!, S, { docId: id(), lines: [{ itemId: NEWITEM, decision: "accept_count", reason: "opening_balance" }] });
    expect(await inWarehouse(NEWITEM)).toBe(12);
    const [adj] = await sql()<{ q: string }[]>`select qty::text as q from stock_balance where location_id = ${PLACE.adjustments} and item_id = ${NEWITEM}`;
    expect(Number(adj!.q)).toBe(-12);
  });

  it("refuses a shortage the warehouse no longer holds — stock handed out since must be counted again", async () => {
    const S = id();
    await startCount(v[KEEP]!, { id: S, kind: "spot" });
    await submitCount(v[KEEP]!, S, { lines: [{ itemId: ORANGES, qty: 1 }] }); // ledger 5: short 4
    await startRecount(v[KEEP2]!, S);
    await submitRecount(v[KEEP2]!, S, { lines: [{ itemId: ORANGES, qty: 1 }] });
    await startHandover(v[OPS]!, { id: id(), from: { kind: "warehouse" }, to: { kind: "person", employeeId: VMO }, lines: [{ itemId: ORANGES, qty: 3 }] });
    expect((await refusal(decideCount(v[OPS2]!, S, { docId: id(), lines: [{ itemId: ORANGES, decision: "accept_count", reason: "unexplained" }] }))).code).toBe("moved_since");
    await decideCount(v[OPS2]!, S, { docId: id(), lines: [{ itemId: ORANGES, decision: "keep_ledger" }] });
    expect(await inWarehouse(ORANGES)).toBe(2);
  });

  it("is never decided by anyone who counted it — not even an approver who recounted", async () => {
    const S = id();
    await startCount(v[KEEP]!, { id: S, kind: "spot" });
    await submitCount(v[KEEP]!, S, { lines: [{ itemId: ORANGES, qty: 0 }] });
    await startRecount(v[OPS]!, S);
    await submitRecount(v[OPS]!, S, { lines: [{ itemId: ORANGES, qty: 0 }] });
    expect((await refusal(decideCount(v[OPS]!, S, { docId: id(), lines: [{ itemId: ORANGES, decision: "keep_ledger" }] }))).code).toBe("own_count");
    expect((await refusal(waiveRecount(v[OPS2]!, S, { reason: "too late" }))).code).toBe("no_recount");
    await decideCount(v[OPS2]!, S, { docId: id(), lines: [{ itemId: ORANGES, decision: "keep_ledger" }] });
    // And the database itself refuses a decision by the person who counted.
    await expect(sql()`update count_session set decided_by = started_by where id = ${S}`).rejects.toThrow();
  });
});

describe("the TASK-060 review's findings, fixed", () => {
  /** One item counted, then counted again by someone else with the same figure: waiting for a decision. */
  async function toApproval(itemId: string, qty: number): Promise<string> {
    const S = id();
    await startCount(v[KEEP]!, { id: S, kind: "spot" });
    await submitCount(v[KEEP]!, S, { lines: [{ itemId, qty }] });
    await startRecount(v[KEEP2]!, S);
    await submitRecount(v[KEEP2]!, S, { lines: [{ itemId, qty }] });
    return S;
  }
  const accept = (itemId: string, reason: "unexplained" | "delivery_difference" | "found" | "used_unrecorded" = "unexplained") => [
    { itemId, decision: "accept_count" as const, reason },
  ];
  const keep = (itemId: string) => [{ itemId, decision: "keep_ledger" as const }];

  it("two counts of the same gap both waiting: the gap is corrected once, and the second is refused", async () => {
    await receiveDelivery(v[KEEP]!, { id: id(), lines: [{ itemId: TWICE, qty: 10 }] });
    const morning = await toApproval(TWICE, 8);
    const evening = await toApproval(TWICE, 8); // the shelf still holds 8; both wait for the Ops Head
    await decideCount(v[OPS]!, morning, { docId: id(), lines: accept(TWICE) });
    expect(await inWarehouse(TWICE)).toBe(8);
    expect((await refusal(decideCount(v[OPS]!, evening, { docId: id(), lines: accept(TWICE) }))).code).toBe("changed_since");
    await decideCount(v[OPS]!, evening, { docId: id(), lines: keep(TWICE) });
    expect(await inWarehouse(TWICE)).toBe(8);
  });

  it("a gap closed meanwhile by an undone document is not corrected again", async () => {
    await receiveDelivery(v[KEEP]!, { id: id(), lines: [{ itemId: UNDONE, qty: 10 }] });
    const duplicate = id();
    await receiveDelivery(v[KEEP]!, { id: duplicate, lines: [{ itemId: UNDONE, qty: 10 }] }); // the same delivery entered twice
    const S = await toApproval(UNDONE, 10); // the shelf says 10, the books 20
    await reverseDocument(v[OPS]!, duplicate, { id: id(), reason: "duplicate" });
    expect(await inWarehouse(UNDONE)).toBe(10);
    expect((await refusal(decideCount(v[OPS2]!, S, { docId: id(), lines: accept(UNDONE, "delivery_difference") }))).code).toBe("changed_since");
    await decideCount(v[OPS2]!, S, { docId: id(), lines: keep(UNDONE) });
    expect(await inWarehouse(UNDONE)).toBe(10);
  });

  it("an item on its way out while counted is counted again and never accepted as counted; once collected, the books are right", async () => {
    await receiveDelivery(v[KEEP]!, { id: id(), lines: [{ itemId: TRANSIT, qty: 10 }] });
    const H = id();
    await startHandover(v[KEEP]!, { id: H, from: { kind: "warehouse" }, to: { kind: "person", employeeId: VMO }, lines: [{ itemId: TRANSIT, qty: 4 }] });
    // Not collected yet: all 10 are on the shelf, the books say 6.
    const S = id();
    await startCount(v[KEEP2]!, { id: S, kind: "spot" });
    expect((await submitCount(v[KEEP2]!, S, { lines: [{ itemId: TRANSIT, qty: 10 }] })).state).toBe("recount");
    await startRecount(v[KEEP]!, S);
    await submitRecount(v[KEEP]!, S, { lines: [{ itemId: TRANSIT, qty: 10 }] });
    expect((await refusal(decideCount(v[OPS]!, S, { docId: id(), lines: accept(TRANSIT, "found") }))).code).toBe("moved_during");
    await decideCount(v[OPS]!, S, { docId: id(), lines: keep(TRANSIT) });
    await answerHandover(v[VMO]!, H, { answer: "accept" });
    expect(await inWarehouse(TRANSIT)).toBe(6);
    // A count that matches the books while some is on its way is clear: that stock has left.
    const H2 = id();
    await startHandover(v[KEEP]!, { id: H2, from: { kind: "warehouse" }, to: { kind: "person", employeeId: VMO }, lines: [{ itemId: TRANSIT, qty: 1 }] });
    const S2 = id();
    await startCount(v[KEEP2]!, { id: S2, kind: "spot" });
    expect((await submitCount(v[KEEP2]!, S2, { lines: [{ itemId: TRANSIT, qty: 5 }] })).state).toBe("closed");
    await answerHandover(v[VMO]!, H2, { answer: "accept" });
  });

  it("a recount handed in after an approver let it go is refused in words — never answered as recorded", async () => {
    await receiveDelivery(v[KEEP]!, { id: id(), lines: [{ itemId: WAIVED, qty: 5 }] });
    const S = id();
    await startCount(v[KEEP]!, { id: S, kind: "spot" });
    await submitCount(v[KEEP]!, S, { lines: [{ itemId: WAIVED, qty: 3 }] });
    await startRecount(v[KEEP2]!, S);
    await waiveRecount(v[OPS]!, S, { reason: "the truck is waiting" });
    expect((await refusal(submitRecount(v[KEEP2]!, S, { lines: [{ itemId: WAIVED, qty: 3 }] }))).code).toBe("recount_waived");
    await decideCount(v[OPS2]!, S, { docId: id(), lines: keep(WAIVED) });
  });

  it("the same hand-in or decision sent twice is answered as before; a different one is refused, never reported as done", async () => {
    await receiveDelivery(v[KEEP]!, { id: id(), lines: [{ itemId: AGAIN, qty: 4 }] });
    const S = id();
    await startCount(v[KEEP]!, { id: S, kind: "spot" });
    expect((await submitCount(v[KEEP]!, S, { lines: [{ itemId: AGAIN, qty: 4 }] })).state).toBe("closed");
    expect(await submitCount(v[KEEP]!, S, { lines: [{ itemId: AGAIN, qty: "4" }] })).toMatchObject({ replay: true, lines: 1, matched: 1 });
    expect((await refusal(submitCount(v[KEEP]!, S, { lines: [{ itemId: AGAIN, qty: 5 }] }))).code).toBe("already_handed_in");
    const T = await toApproval(AGAIN, 3);
    const doc = id();
    await decideCount(v[OPS]!, T, { docId: doc, lines: accept(AGAIN, "used_unrecorded") });
    expect((await decideCount(v[OPS]!, T, { docId: doc, lines: accept(AGAIN, "used_unrecorded") })).replay).toBe(true);
    expect((await refusal(decideCount(v[OPS]!, T, { docId: doc, lines: keep(AGAIN) }))).code).toBe("already_decided");
    expect((await refusal(decideCount(v[OPS]!, T, { docId: id(), lines: accept(AGAIN, "used_unrecorded") }))).code).toBe("already_decided");
    expect(await inWarehouse(AGAIN)).toBe(3);
  });

  it("an item counted but never moved keeps its unit and step while the count is open", async () => {
    const S = id();
    await startCount(v[KEEP]!, { id: S, kind: "spot" });
    await submitCount(v[KEEP]!, S, { lines: [{ itemId: UNIT, qty: 12 }] }); // its opening stock, not decided yet
    const change = (unit: string) => saveItem(v[KEEP]!, { id: UNIT, name: `${TAG} review 5`, category: "other", unit, step: 1 });
    expect((await refusal(change("piece"))).code).toBe("unit_fixed");
    await cancelCount(v[OPS]!, S);
    // Cancelled, nothing of it was recorded: the unit may change again.
    expect((await change("piece")).created).toBe(false);
  });

  it("opening a count while one of yours is open carries that one on — and says which kind it is", async () => {
    const S = id();
    await startCount(v[KEEP]!, { id: S, kind: "spot" });
    expect(await startCount(v[KEEP]!, { id: id(), kind: "closing" })).toMatchObject({ sessionId: S, kind: "spot", resumed: true });
    await cancelCount(v[KEEP]!, S);
  });

  it("until someone takes the recount, nobody who may still take it sees the first count or the ledger", async () => {
    await receiveDelivery(v[KEEP]!, { id: id(), lines: [{ itemId: BLIND, qty: 9 }] });
    const S = id();
    await startCount(v[KEEP]!, { id: S, kind: "spot" });
    await submitCount(v[KEEP]!, S, { lines: [{ itemId: BLIND, qty: 7 }] });
    for (const who of [KEEP2, OPS]) {
      expect((await inventoryCount(v[who]!, S))!.lines[0], who).toMatchObject({ counted: null, expected: null, recount: null });
    }
    expect((await inventoryCount(v[KEEP]!, S))!.lines[0]).toMatchObject({ counted: 7, expected: null });
    await startRecount(v[KEEP2]!, S);
    // Taken: the Ops Head may look now — they can no longer recount it.
    expect((await inventoryCount(v[OPS]!, S))!.lines[0]).toMatchObject({ counted: 7, expected: 9 });
    expect((await inventoryCount(v[KEEP2]!, S))!.lines[0]).toMatchObject({ counted: null, expected: null });
    await submitRecount(v[KEEP2]!, S, { lines: [{ itemId: BLIND, qty: 7 }] });
    await decideCount(v[OPS]!, S, { docId: id(), lines: keep(BLIND) });
  });

  it("the person counting does not see the warehouse's figures until they hand the count in", async () => {
    const S = id();
    await startCount(v[KEEP]!, { id: S, kind: "spot" });
    const during = await inventoryHome(v[KEEP]!);
    expect(during.figuresHidden).toBe(true);
    expect(during.items.every((i) => i.warehouse === null && !i.low)).toBe(true);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(new Date());
    expect((await refusal(inventoryDay(v[KEEP]!, today))).code).toBe("counting_now");
    // Everyone else sees them as before.
    expect((await inventoryHome(v[KEEP2]!)).items.find((i) => i.id === BLIND)?.warehouse).toBe(9);
    await submitCount(v[KEEP]!, S, { lines: [{ itemId: BLIND, qty: 9 }] });
    const after = await inventoryHome(v[KEEP]!);
    expect(after.figuresHidden).toBe(false);
    expect(after.items.find((i) => i.id === BLIND)?.warehouse).toBe(9);
  });
});

describe("the review of 20 Oct, fixed", () => {
  const accept = (itemId: string) => [{ itemId, decision: "accept_count" as const, reason: "unexplained" as const }];
  async function toApproval(itemId: string, qty: number): Promise<string> {
    const S = id();
    await startCount(v[KEEP]!, { id: S, kind: "spot" });
    await submitCount(v[KEEP]!, S, { lines: [{ itemId, qty }] });
    await startRecount(v[KEEP2]!, S);
    await submitRecount(v[KEEP2]!, S, { lines: [{ itemId, qty }] });
    return S;
  }
  let seq = 0;
  async function photo(by: string): Promise<string> {
    const sha = createHash("sha256").update(`${TAG}-p${seq++}`).digest("hex");
    const [r] = await sql()<{ id: string }[]>`
      insert into media_object (sha256, kind, mime, bytes, storage_path, uploaded_by, retention_class, retention_until, scan_status, is_synthetic)
      values (${sha}, 'photo', 'image/jpeg', 1000, ${`test/${sha}.jpg`}, ${by}, 'evidence', now() + interval '1 day', 'not_scanned', true)
      returning id`;
    return r!.id;
  }
  const textFor = async (keyPrefix: string, who: string) =>
    (await sql()<{ text: string }[]>`
      select payload->>'text' as text from notification_outbox where idempotency_key like ${`${keyPrefix}:%`} and recipient_employee_id = ${who} and channel = 'inapp'`)[0]?.text ?? null;

  it("a mistake entered after the count and undone again does not stop accepting it — it never touched the counted figure", async () => {
    await receiveDelivery(v[KEEP]!, { id: id(), lines: [{ itemId: NET, qty: 10 }] });
    const S = await toApproval(NET, 8); // 2 really missing
    const dup = id();
    await receiveDelivery(v[KEEP]!, { id: dup, lines: [{ itemId: NET, qty: 10 }] }); // the same delivery entered twice, after the count
    await reverseDocument(v[OPS]!, dup, { id: id(), reason: "duplicate" });
    await decideCount(v[OPS]!, S, { docId: id(), lines: accept(NET) });
    expect(await inWarehouse(NET)).toBe(8);
  });

  it("a partly accepted handover keeps only its short item in transit — a count of the item that arrived in full is clear", async () => {
    await receiveDelivery(v[KEEP]!, { id: id(), lines: [{ itemId: PA, qty: 10 }, { itemId: PB, qty: 5 }] });
    const H = id();
    await startHandover(v[KEEP]!, { id: H, from: { kind: "warehouse" }, to: { kind: "person", employeeId: VMO }, lines: [{ itemId: PA, qty: 4 }, { itemId: PB, qty: 5 }] });
    await answerHandover(v[VMO]!, H, { answer: "counted", lines: [{ itemId: PA, qty: 4 }, { itemId: PB, qty: 3 }], reason: "wrong_count" });
    // PA: the books say 6, the shelf 4 (2 really missing). PB's dispute has nothing to do with it.
    const S = await toApproval(PA, 4);
    await decideCount(v[OPS]!, S, { docId: id(), lines: accept(PA) });
    expect(await inWarehouse(PA)).toBe(4);
  });

  it("an item's unit stays as it is while the warehouse is being counted — even one never recorded", async () => {
    const S = id();
    await startCount(v[KEEP]!, { id: S, kind: "spot" });
    const change = (unit: string) => saveItem(v[OPS]!, { id: FRESH, name: `${TAG} review fresh`, category: "other", unit, step: 1 });
    expect((await refusal(change("piece"))).code).toBe("count_open");
    await cancelCount(v[KEEP]!, S);
    expect((await change("piece")).created).toBe(false);
  });

  it("someone counting hears an item is low, not how many are left — and asking for too much tells them nothing either", async () => {
    const S = id();
    await startCount(v[KEEP]!, { id: S, kind: "spot" });
    try {
      await receiveDelivery(v[OPS]!, { id: id(), lines: [{ itemId: LOW, qty: 3 }] }); // below its minimum of 5
      const counting = await textFor(`stock.low:${LOW}`, KEEP);
      const free = await textFor(`stock.low:${LOW}`, KEEP2);
      expect(counting).toMatch(/is below its minimum in the warehouse/);
      expect(counting).not.toMatch(/left in the warehouse|\b3\b/);
      expect(free).toMatch(/3 boxes left in the warehouse/);
      const tooMuch = await refusal(
        startHandover(v[KEEP]!, { id: id(), from: { kind: "warehouse" }, to: { kind: "person", employeeId: VMO }, lines: [{ itemId: LOW, qty: 20 }] }),
      );
      expect(tooMuch.message).toBe(`Not enough ${TAG} review 11 in the warehouse for this.`);
      const other = await refusal(
        startHandover(v[KEEP2]!, { id: id(), from: { kind: "warehouse" }, to: { kind: "person", employeeId: VMO }, lines: [{ itemId: LOW, qty: 20 }] }),
      );
      expect(other.message).toMatch(/has 3 boxes/);
    } finally {
      await cancelCount(v[KEEP]!, S);
    }
  });

  it("while a recount waits to be taken, an approver who may take it gets the closed count's news without the figures", async () => {
    await receiveDelivery(v[KEEP]!, { id: id(), lines: [{ itemId: KEPT, qty: 6 }] });
    const S1 = id();
    await startCount(v[KEEP]!, { id: S1, kind: "spot" });
    expect((await submitCount(v[KEEP]!, S1, { lines: [{ itemId: KEPT, qty: 1 }] })).state).toBe("recount"); // waits for someone else
    const S2 = id();
    await startCount(v[KEEP2]!, { id: S2, kind: "spot" });
    expect((await submitCount(v[KEEP2]!, S2, { lines: [{ itemId: ORANGES, qty: await inWarehouse(ORANGES) }] })).state).toBe("closed");
    const toOps = await textFor(`stock.counted:${S2}`, OPS);
    expect(toOps).toMatch(/not in this message while you count, or may take a recount/);
    expect(toOps).not.toMatch(/oranges/);
    await startRecount(v[KEEP2]!, S1);
    await submitRecount(v[KEEP2]!, S1, { lines: [{ itemId: KEPT, qty: 6 }] });
    // The recount matched the books: nothing differs, nothing to decide line by line.
    await decideCount(v[OPS]!, S1, { docId: id(), lines: [] });
  });

  it("a person who left still holding stock is offered for taking back — never for giving to (review 060-fixes#1)", async () => {
    const H = id();
    await startHandover(v[KEEP]!, { id: H, from: { kind: "warehouse" }, to: { kind: "person", employeeId: LEFT }, lines: [{ itemId: ORANGES, qty: 1 }] });
    await answerHandover(v[LEFT]!, H, { answer: "accept" });
    await sql()`update employee set status = 'disabled' where id = ${LEFT}`;
    const forKeeper = (await inventoryHolders(v[KEEP]!)).find((h) => h.id === LEFT);
    expect(forKeeper).toMatchObject({ canReceive: false, holds: [{ itemId: ORANGES, qty: 1 }] });
    expect((await inventoryHolders(v[VMO]!)).some((h) => h.id === LEFT)).toBe(false);
    expect((await inventoryHolders(v[KEEP]!)).find((h) => h.id === VMO)).toMatchObject({ canReceive: true });
    // Taken back at the desk: the warehouse confirms, since the person cannot (D236).
    const back = id();
    expect((await startHandover(v[KEEP]!, { id: back, from: { kind: "person", employeeId: LEFT }, to: { kind: "warehouse" }, lines: [{ itemId: ORANGES, qty: 1 }] })).state).toBe(
      "waiting",
    );
    await answerHandover(v[KEEP2]!, back, { answer: "accept" });
    expect((await inventoryHolders(v[KEEP]!)).some((h) => h.id === LEFT)).toBe(false);
  });

  it("a stock document's photo is seen by whoever may read the document — not the cash auditor; its machine by the driver too (roles#1, #3)", async () => {
    await receiveDelivery(v[KEEP]!, { id: id(), lines: [{ itemId: STRAWS, qty: 2 }] });
    const P = await photo(KEEP);
    const H = id();
    await startHandover(v[KEEP]!, { id: H, from: { kind: "warehouse" }, to: { kind: "person", employeeId: VMO }, lines: [{ itemId: STRAWS, qty: 1 }], mediaIds: [P] });
    const sees = async (who: string) =>
      (await withContext(v[who]!, (tx) => tx<{ n: number }[]>`select count(*)::int as n from media_object where id = ${P}`, { readOnly: true }))[0]!.n;
    expect(await sees(VMO)).toBe(1); // the receiver, who must confirm it
    expect(await sees(OPS)).toBe(1); // sees all stock
    expect(await sees(AUD)).toBe(0); // no stock at all
    expect((await inventoryDoc(v[VMO]!, H))!.photos).toEqual([P]);
    await answerHandover(v[VMO]!, H, { answer: "accept" });
    // The driver puts it into a machine: the driver and the keeper see which one, though neither reads the machine table.
    const U = id();
    await recordUse(v[VMO]!, { id: U, kind: "use", from: "mine", reason: "machine_refill", machineAssetNo: ASSET, lines: [{ itemId: STRAWS, qty: 1 }] });
    expect((await inventoryDoc(v[VMO]!, U))!.machine).toEqual({ assetNo: ASSET, label: `${TAG} Mall-${ASSET}` });
    expect((await inventoryDoc(v[KEEP]!, U))!.machine).toEqual({ assetNo: ASSET, label: `${TAG} Mall-${ASSET}` });
  });

  it("stamps a move's time when it is written, under its item's lock (0040)", async () => {
    const [col] = await sql()<{ d: string }[]>`
      select column_default as d from information_schema.columns where table_name = 'stock_move' and column_name = 'posted_at'`;
    expect(col!.d).toMatch(/clock_timestamp/);
  });
});

describe("the review of the fixes, 20 Oct", () => {
  const accept = (itemId: string) => [{ itemId, decision: "accept_count" as const, reason: "unexplained" as const }];
  async function toApproval(itemId: string, qty: number): Promise<string> {
    const S = id();
    await startCount(v[KEEP]!, { id: S, kind: "spot" });
    await submitCount(v[KEEP]!, S, { lines: [{ itemId, qty }] });
    await startRecount(v[KEEP2]!, S);
    await submitRecount(v[KEEP2]!, S, { lines: [{ itemId, qty }] });
    return S;
  }

  it("a take-back from someone still active whose role no longer holds stock is confirmed at the warehouse, and says whose stock it was", async () => {
    const H = id();
    await startHandover(v[KEEP]!, { id: H, from: { kind: "warehouse" }, to: { kind: "person", employeeId: MOVED }, lines: [{ itemId: ORANGES, qty: 1 }] });
    await answerHandover(v[MOVED]!, H, { answer: "accept" });
    await sql()`update employee set access_role = 'cash_auditor' where id = ${MOVED}`;
    v[MOVED] = (await loadViewer(MOVED))!;
    const back = id();
    await startHandover(v[KEEP]!, { id: back, from: { kind: "person", employeeId: MOVED }, to: { kind: "warehouse" }, lines: [{ itemId: ORANGES, qty: 1 }] });
    expect((await inventoryDoc(v[KEEP]!, back))!.confirm).toMatchObject({ side: "warehouse", person: null });
    const told = await sql()<{ text: string }[]>`
      select payload->>'text' as text from notification_outbox where idempotency_key like ${`stock.handover:${back}:%`} and channel = 'inapp' limit 1`;
    expect(told[0]?.text).toMatch(new RegExp(`took back ${TAG} Moved's stock`));
    await answerHandover(v[KEEP2]!, back, { answer: "accept" });
  });

  it("while a recount waits, the Stock screen hides the figures from whoever may take it too", async () => {
    await receiveDelivery(v[KEEP]!, { id: id(), lines: [{ itemId: ADJ, qty: 10 }] });
    const S = id();
    await startCount(v[KEEP]!, { id: S, kind: "spot" });
    expect((await submitCount(v[KEEP]!, S, { lines: [{ itemId: ADJ, qty: 8 }] })).state).toBe("recount");
    expect((await inventoryHome(v[OPS]!)).figuresHidden).toBe(true); // may take the recount
    await startRecount(v[KEEP2]!, S);
    expect((await inventoryHome(v[OPS]!)).figuresHidden).toBe(false); // taken: the Ops Head can no longer recount it
    await submitRecount(v[KEEP2]!, S, { lines: [{ itemId: ADJ, qty: 8 }] });
    await decideCount(v[OPS]!, S, { docId: id(), lines: [{ itemId: ADJ, decision: "keep_ledger" as const }] });
  });

  it("a count adjustment posted after the count and undone again nets out: accepting the count still works", async () => {
    // ADJ: the books 10, the shelf 8, counted twice.
    const S1 = await toApproval(ADJ, 8);
    const S2 = await toApproval(ADJ, 8);
    const first = id();
    await decideCount(v[OPS]!, S1, { docId: first, lines: accept(ADJ) }); // −2
    await reverseDocument(v[OPS2]!, first, { id: id(), reason: "entered_by_mistake" }); // back to 10
    await decideCount(v[OPS]!, S2, { docId: id(), lines: accept(ADJ) });
    expect(await inWarehouse(ADJ)).toBe(8);
  });

  it("undoing a delivery tells someone counting the warehouse no figure", async () => {
    const D = id();
    await receiveDelivery(v[KEEP]!, { id: D, lines: [{ itemId: REV, qty: 10 }] });
    const H = id();
    await startHandover(v[KEEP]!, { id: H, from: { kind: "warehouse" }, to: { kind: "person", employeeId: VMO }, lines: [{ itemId: REV, qty: 8 }] });
    await answerHandover(v[VMO]!, H, { answer: "accept" }); // the warehouse has 2
    const S = id();
    await startCount(v[OPS]!, { id: S, kind: "spot" });
    try {
      const r = await refusal(reverseDocument(v[OPS]!, D, { id: id(), reason: "duplicate" }));
      expect(r.code).toBe("not_enough");
      expect(r.message).not.toMatch(/\b2\b/);
    } finally {
      await cancelCount(v[OPS]!, S);
    }
  });

  it("a handover nobody can answer any more — its keeper and its driver both left — is cancelled by an approver, and the stock goes back", async () => {
    await receiveDelivery(v[KEEP]!, { id: id(), lines: [{ itemId: STUCK, qty: 5 }] });
    const H = id();
    await startHandover(v[KEEP3]!, { id: H, from: { kind: "warehouse" }, to: { kind: "person", employeeId: LEFT2 }, lines: [{ itemId: STUCK, qty: 5 }] });
    expect(await inWarehouse(STUCK)).toBe(0);
    await sql()`update employee set status = 'disabled' where id in (${KEEP3}, ${LEFT2})`;
    expect((await refusal(cancelHandover(v[VMO]!, H))).status).toBe(403); // not an approver
    expect((await cancelHandover(v[OPS]!, H)).state).toBe("cancelled");
    expect(await inWarehouse(STUCK)).toBe(5);
  });
});
