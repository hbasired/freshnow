import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  answerQuery,
  auditShift,
  cashHome,
  cashMachines,
  cashShift,
  cashShifts,
  endShift,
  recordCollection,
  recordDeposit,
  recordExpense,
  recordTestVend,
  reverseCash,
  startShift,
} from "./cash.js";
import { exportPersonData } from "./compliance-evidence.js";
import { closeDb, getServiceSql, withContext } from "./db.js";
import { DEMO_CEO_ID } from "./meta.js";
import { loadViewer, type ViewerOrg } from "./org.js";
import { eraseEmployee, retentionSweep } from "./retention.js";

/**
 * Cash (TASK-061), against real Postgres. What it must guarantee — from the plan (§2, §4.5) and the
 * WhatsApp group it replaces, not from reading the code:
 *   - every dirham moves from one account to another: each account's balance equals its moves, all of
 *     them sum to zero, and a person never holds less than nothing;
 *   - the same entry twice posts once; an entry is never changed — a mistake is undone, by the person
 *     while their shift is open and unchecked, otherwise by an auditor;
 *   - the auditor checks whole shifts, never their own; a question reaches the person and the Ops Head,
 *     the answer reaches the auditor;
 *   - a driver sees only their own cash, the warehouse none, the auditor all — with the receipts, and
 *     with Televend's "should have found" beside each collection (D221).
 * Golden case — Kiran's list of 14 Oct (VF73): collected AED 1,540, fuel 165, deposited 1,375, holds 0.
 */

const TAG = `CASH-${randomUUID().slice(0, 6)}`;
const DRV = randomUUID(); // a driver (VMO)
const DRV2 = randomUUID(); // another driver
const DRV3 = randomUUID(); // a driver who forgets to end a shift
const AUD = randomUUID(); // the cash auditor
const OPS = randomUUID(); // the Ops Head — holds cash and checks it
const KEEP = randomUUID(); // a warehouse keeper — sees no cash
const STAFF = [DRV, DRV2, DRV3, AUD, OPS, KEEP];
const TV = 990_771; // a Televend record
const ASSET = 99_771; // its machine's sticker number
const ASSET2 = 99_772; // a machine Televend does not know
let MACHINE = "";
let MACHINE2 = "";
const v: Record<string, ViewerOrg> = {};
const sql = () => getServiceSql();
const id = () => randomUUID();
const dubaiToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(new Date());
let seq = 0;

/** A photo this person took (the media store is TASK-058's, tested there): only its record is needed here. */
async function photo(by: string): Promise<string> {
  const sha = createHash("sha256").update(`${TAG}-${seq++}`).digest("hex");
  const [r] = await sql()<{ id: string }[]>`
    insert into media_object (sha256, kind, mime, bytes, storage_path, uploaded_by, retention_class, retention_until, scan_status, is_synthetic)
    values (${sha}, 'photo', 'image/jpeg', 1000, ${`test/${sha}.jpg`}, ${by}, 'receipt', now() + interval '1 day', 'not_scanned', true)
    returning id`;
  return r!.id;
}

async function event(name: string, at: Date): Promise<void> {
  await sql()`insert into tv_event (source, external_id, machine_tv_id, level, kind, name, started_at, raw, is_synthetic)
              values ('bridge', ${`${TAG}-e${seq++}`}, ${TV}, 1, 'info', ${name}, ${at}, '{}'::jsonb, true)`;
}
async function vend(at: Date, paymentType: number): Promise<void> {
  await sql()`insert into tv_vend (source, external_id, machine_tv_id, at, payment_type, quantity, raw, is_synthetic)
              values ('bridge', ${`${TAG}-v${seq++}`}, ${TV}, ${at}, ${paymentType}, 1, '{}'::jsonb, true)`;
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

const held = async (who: string) => (await cashHome(v[who]!)).heldFils;
const told = async (keyPrefix: string) =>
  new Set(
    (await sql()<{ r: string }[]>`select distinct recipient_employee_id as r from notification_outbox where idempotency_key like ${`${keyPrefix}%`} and channel = 'inapp'`).map(
      (x) => x.r,
    ),
  );

beforeAll(async () => {
  const s = sql();
  const people: [string, string, string][] = [
    [DRV, "Kiran", "vmo"],
    [DRV2, "Kamran", "vmo"],
    [DRV3, "Yakup", "vmo"],
    [AUD, "Auditor", "cash_auditor"],
    [OPS, "Ops Head", "ops_head"],
    [KEEP, "Keeper", "warehouse_keeper"],
  ];
  for (const [pid, name, role] of people) {
    await s`insert into employee (id, display_name, status, is_synthetic, access_role, manager_employee_id)
            values (${pid}, ${`${TAG} ${name}`}, 'active', true, ${role}, ${DEMO_CEO_ID})`;
  }
  await s`insert into tv_machine (televend_id, caption, asset_no, enabled, region_caption, last_status, connection_status, raw, is_synthetic)
          values (${TV}, ${`${TAG} Mina-771`}, ${ASSET}, true, 'Metro', 1, 1, '{}'::jsonb, true)`;
  MACHINE = (await s<{ id: string }[]>`insert into machine (asset_no, label, cash_price_fils, is_synthetic) values (${ASSET}, ${`${TAG} Mina-771`}, 1000, true) returning id`)[0]!.id;
  MACHINE2 = (await s<{ id: string }[]>`insert into machine (asset_no, label, is_synthetic) values (${ASSET2}, ${`${TAG} Naif-772`}, true) returning id`)[0]!.id;
  await s`insert into machine_placement (machine_id, tv_machine_id, source, is_synthetic) values (${MACHINE}, ${TV}, 'manual', true)`;
  for (const pid of STAFF) v[pid] = (await loadViewer(pid))!;
});

afterAll(async () => {
  const s = sql();
  const shifts = (await s<{ id: string }[]>`select id from shift where employee_id = any(${STAFF}::uuid[])`).map((r) => r.id);
  await s`select cash_purge_shifts(${shifts}::uuid[])`;
  await s`delete from cash_account where employee_id = any(${STAFF}::uuid[]) or machine_id in (${MACHINE}, ${MACHINE2})`;
  await s`delete from media_object where uploaded_by = any(${STAFF}::uuid[])`;
  await s`delete from tv_vend where external_id like ${`${TAG}-%`}`;
  await s`delete from tv_event where external_id like ${`${TAG}-%`}`;
  await s`delete from machine_placement where machine_id = ${MACHINE}`;
  await s`delete from machine where id in (${MACHINE}, ${MACHINE2})`;
  await s`delete from tv_machine where televend_id = ${TV}`;
  await s`delete from notification_outbox where recipient_employee_id = any(${STAFF}::uuid[])`;
  await s`delete from audit_log where actor = any(${STAFF.map((x) => `employee:${x}`)})`;
  await s`delete from employee where id = any(${STAFF}::uuid[])`;
  await closeDb();
});

describe("a driver's shift", () => {
  it("Kiran's list of 14 Oct: collected 1,540, fuel 165, deposited 1,375 — and holds nothing at the end", async () => {
    const S = id();
    expect(await startShift(v[DRV]!, { id: S, vehicle: "Van 4" })).toEqual({ shiftId: S, opened: true });
    await recordCollection(v[DRV]!, { id: id(), machineAssetNo: ASSET, amountFils: 90_000, mediaIds: [await photo(DRV)] });
    await recordCollection(v[DRV]!, { id: id(), machineAssetNo: ASSET2, amountFils: 64_000, mediaIds: [await photo(DRV)] });
    await recordExpense(v[DRV]!, { id: id(), expenseKind: "fuel", amountFils: 16_500, litres: 55.5, mediaIds: [await photo(DRV)] });
    await recordDeposit(v[DRV]!, {
      id: id(),
      amountFils: 137_500,
      cdmTxnNo: "T-0001",
      denominations: { "1000": 1, "200": 1, "100": 1, "50": 1, "20": 1, "5": 1 },
      mediaIds: [await photo(DRV)],
    });
    const home = await cashHome(v[DRV]!);
    expect(home.heldFils).toBe(0);
    expect(home.openShift).toMatchObject({
      id: S,
      businessDate: dubaiToday(),
      vehicle: "Van 4",
      carriedInFils: 0,
      collectedFils: 154_000,
      fuelFils: 16_500,
      depositedFils: 137_500,
      leftFils: 0,
      collections: 2,
      withoutPhoto: 0,
    });
    expect(home.openShift!.entries.find((e) => e.kind === "deposit")!.deposit).toMatchObject({ txnNo: "T-0001", denominations: { "1000": 1, "5": 1 } });
    expect((await endShift(v[DRV]!, {})).heldFils).toBe(0);
  });

  it("opens a shift with the first entry when none is open; a test note goes back into the machine", async () => {
    await recordCollection(v[DRV2]!, { id: id(), machineAssetNo: ASSET, amountFils: 5_000, mediaIds: [await photo(DRV2)] });
    await recordTestVend(v[DRV2]!, { id: id(), machineAssetNo: ASSET, amountFils: 1_000, note: "cash test 10" });
    const home = await cashHome(v[DRV2]!);
    expect(home.openShift).toMatchObject({ collectedFils: 5_000, testFils: 1_000, leftFils: 4_000 });
    expect(home.heldFils).toBe(4_000);
  });

  it("records an empty box as a collection of 0 — with its photo — and moves no cash", async () => {
    const E = id();
    await recordCollection(v[DRV2]!, { id: E, machineAssetNo: ASSET2, amountFils: 0, mediaIds: [await photo(DRV2)] });
    const [n] = await sql()<{ n: number }[]>`select count(*)::int as n from cash_move where doc_id = ${E}`;
    expect(n!.n).toBe(0);
    expect(await held(DRV2)).toBe(4_000);
  });

  it("posts the same entry once, however often it is sent; a different entry under the same id is refused", async () => {
    const E = id();
    const req = { id: E, machineAssetNo: ASSET, amountFils: 2_000, mediaIds: [await photo(DRV2)] };
    expect((await recordCollection(v[DRV2]!, req)).replay).toBe(false);
    expect((await recordCollection(v[DRV2]!, req)).replay).toBe(true);
    expect((await refusal(recordCollection(v[DRV2]!, { ...req, amountFils: 3_000 }))).code).toBe("id_reused");
    const [n] = await sql()<{ n: number }[]>`select count(*)::int as n from cash_move where doc_id = ${E}`;
    expect(n!.n).toBe(1);
    expect(await held(DRV2)).toBe(6_000);
  });

  it("never lets a person spend or deposit more than they hold — and the database refuses it too", async () => {
    const has = await held(DRV2);
    expect((await refusal(recordDeposit(v[DRV2]!, { id: id(), amountFils: has + 100, mediaIds: [await photo(DRV2)] }))).code).toBe("not_enough_cash");
    expect((await refusal(recordExpense(v[DRV2]!, { id: id(), expenseKind: "other", amountFils: has + 100, note: "tyre", mediaIds: [await photo(DRV2)] }))).code).toBe(
      "not_enough_cash",
    );
    const [acc] = await sql()<{ id: string }[]>`select id from cash_account where kind = 'person' and employee_id = ${DRV2}`;
    const [doc] = await sql()<{ id: string }[]>`select id from cash_doc where created_by = ${DRV2} and kind = 'collection' limit 1`;
    await expect(
      sql()`insert into cash_move (doc_id, from_account_id, to_account_id, fils, step, posted_by)
            values (${doc!.id}, ${acc!.id}, '00000000-0000-0000-0000-00000000c003', ${has + 1}, 'post', ${DRV2})`,
    ).rejects.toThrow(/cash_balance_never_negative/);
  });

  it("asks for the photo — of the cash, of the receipt — and takes only the person's own", async () => {
    expect((await refusal(recordCollection(v[DRV2]!, { id: id(), machineAssetNo: ASSET, amountFils: 100 }))).code).toBe("photo_needed");
    expect((await refusal(recordCollection(v[DRV2]!, { id: id(), machineAssetNo: ASSET, amountFils: 100, mediaIds: [await photo(DRV)] }))).code).toBe("not_your_photo");
    expect((await refusal(recordDeposit(v[DRV2]!, { id: id(), amountFils: 100 }))).code).toBe("photo_needed");
    expect((await refusal(recordExpense(v[DRV2]!, { id: id(), expenseKind: "fuel", amountFils: 100 }))).code).toBe("photo_needed");
    expect((await refusal(recordCollection(v[DRV2]!, { id: id(), machineAssetNo: 12_345, amountFils: 100, mediaIds: [await photo(DRV2)] }))).code).toBe("no_machine");
  });

  it("takes one photo for one entry: the same picture on a second collection is refused (review, 20 Oct)", async () => {
    const P = await photo(DRV2);
    const E = id();
    await recordCollection(v[DRV2]!, { id: E, machineAssetNo: ASSET, amountFils: 100, mediaIds: [P] });
    expect((await refusal(recordCollection(v[DRV2]!, { id: id(), machineAssetNo: ASSET2, amountFils: 100, mediaIds: [P] }))).code).toBe("photo_used");
    expect((await refusal(recordDeposit(v[DRV2]!, { id: id(), amountFils: 100, mediaIds: [P] }))).code).toBe("photo_used");
    // Sending the first entry again is still the same entry, not a second use of its photo.
    expect((await recordCollection(v[DRV2]!, { id: E, machineAssetNo: ASSET, amountFils: 100, mediaIds: [P] })).replay).toBe(true);
    // Undone, the entry made again may carry its own photo — the cash is in the bag, it cannot be photographed again.
    await reverseCash(v[DRV2]!, E, { id: id(), reason: "wrong_amount" });
    const again = id();
    expect((await recordCollection(v[DRV2]!, { id: again, machineAssetNo: ASSET, amountFils: 90, mediaIds: [P] })).replay).toBe(false);
    expect((await refusal(recordCollection(v[DRV2]!, { id: id(), machineAssetNo: ASSET2, amountFils: 100, mediaIds: [P] }))).code).toBe("photo_used");
  });

  it("checks that a deposit's notes add up to its amount, and are real notes", async () => {
    expect((await refusal(recordDeposit(v[DRV2]!, { id: id(), amountFils: 2_000, denominations: { "10": 1 }, mediaIds: [await photo(DRV2)] }))).code).toBe(
      "notes_dont_add_up",
    );
    expect((await refusal(recordDeposit(v[DRV2]!, { id: id(), amountFils: 300, denominations: { "3": 1 }, mediaIds: [await photo(DRV2)] }))).code).toBe("bad_notes");
    // One note written two ways would add up here and be kept as only one of them (review, 20 Oct).
    expect((await refusal(recordDeposit(v[DRV2]!, { id: id(), amountFils: 80_000, denominations: { "100": 5, "0100": 3 }, mediaIds: [await photo(DRV2)] }))).code).toBe(
      "bad_notes",
    );
  });

  it("starts the next shift with what was still held — and the auditor ends a shift someone forgot, telling them to deposit", async () => {
    await recordCollection(v[DRV3]!, { id: id(), machineAssetNo: ASSET, amountFils: 3_000, mediaIds: [await photo(DRV3)] });
    const first = await endShift(v[DRV3]!, {});
    expect(first.heldFils).toBe(3_000);
    expect(await told(`cash.held_at_end:${first.shiftId}`)).toEqual(new Set([DRV3]));
    await recordDeposit(v[DRV3]!, { id: id(), amountFils: 3_000, mediaIds: [await photo(DRV3)] });
    const second = (await cashHome(v[DRV3]!)).openShift!;
    expect(second).toMatchObject({ carriedInFils: 3_000, collectedFils: 0, depositedFils: 3_000, leftFils: 0 });
    // Another driver may not end it; an auditor may.
    expect((await refusal(endShift(v[DRV2]!, { shiftId: second.id }))).status).toBe(403);
    expect(await endShift(v[AUD]!, { shiftId: second.id })).toMatchObject({ shiftId: second.id, heldFils: 0, replay: false });
    const [row] = await sql()<{ ended_by: string; state: string }[]>`select ended_by, state from shift where id = ${second.id}`;
    expect(row).toEqual({ ended_by: AUD, state: "closed" });
    expect((await endShift(v[AUD]!, { shiftId: second.id })).replay).toBe(true);
  });
});

describe("undoing an entry", () => {
  it("the person undoes their own slip while the shift is open: the opposite move, once", async () => {
    const E = id();
    await recordCollection(v[DRV2]!, { id: E, machineAssetNo: ASSET, amountFils: 7_000, mediaIds: [await photo(DRV2)] });
    const before = await held(DRV2);
    const R = id();
    await reverseCash(v[DRV2]!, E, { id: R, reason: "wrong_amount" });
    expect(await held(DRV2)).toBe(before - 7_000);
    expect((await reverseCash(v[DRV2]!, E, { id: R, reason: "wrong_amount" })).replay).toBe(true);
    expect((await refusal(reverseCash(v[DRV2]!, E, { id: id(), reason: "wrong_amount" }))).code).toBe("already_reversed");
    expect((await refusal(reverseCash(v[DRV2]!, R, { id: id(), reason: "other", note: "undo the undo" }))).code).toBe("not_reversible");
    expect((await refusal(reverseCash(v[DRV]!, E, { id: id(), reason: "duplicate" }))).status).toBe(403);
    const [d] = await sql()<{ state: string; amount: string }[]>`select state, amount_fils::text as amount from cash_doc where id = ${R}`;
    expect(d).toEqual({ state: "posted", amount: "7000" });
  });

  it("a collection whose cash was deposited since is not undone until the deposit is", async () => {
    const E = id();
    await recordCollection(v[DRV2]!, { id: E, machineAssetNo: ASSET, amountFils: 1_000, mediaIds: [await photo(DRV2)] });
    const D = id();
    await recordDeposit(v[DRV2]!, { id: D, amountFils: await held(DRV2), mediaIds: [await photo(DRV2)] });
    expect((await refusal(reverseCash(v[DRV2]!, E, { id: id(), reason: "duplicate" }))).code).toBe("not_enough_cash");
    await reverseCash(v[DRV2]!, D, { id: id(), reason: "entered_by_mistake" });
    await reverseCash(v[DRV2]!, E, { id: id(), reason: "duplicate" });
  });

  it("two auditors undoing the same entry at once: one undo, and 'already undone' for the other — never an error", async () => {
    const E = id();
    await recordCollection(v[DRV]!, { id: E, machineAssetNo: ASSET, amountFils: 400, mediaIds: [await photo(DRV)] });
    const both = await Promise.allSettled([
      reverseCash(v[AUD]!, E, { id: id(), reason: "duplicate" }),
      reverseCash(v[OPS]!, E, { id: id(), reason: "duplicate" }),
    ]);
    expect(both.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = both.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ status: 409, code: "already_reversed" });
    const [n] = await sql()<{ n: number }[]>`select count(*)::int as n from cash_doc where reverses_doc_id = ${E}`;
    expect(n!.n).toBe(1);
  });

  it("after the shift ends only an auditor undoes — and never an entry of their own", async () => {
    const E = id();
    await recordCollection(v[DRV2]!, { id: E, machineAssetNo: ASSET, amountFils: 500, mediaIds: [await photo(DRV2)] });
    await endShift(v[DRV2]!, {});
    expect((await refusal(reverseCash(v[DRV2]!, E, { id: id(), reason: "duplicate" }))).code).toBe("too_late");
    await reverseCash(v[AUD]!, E, { id: id(), reason: "duplicate", note: "same photo as the 7,000" });
    // The Ops Head holds cash too: their own entries follow the person's rule.
    const O = id();
    await recordCollection(v[OPS]!, { id: O, machineAssetNo: ASSET2, amountFils: 200, mediaIds: [await photo(OPS)] });
    await endShift(v[OPS]!, {});
    expect((await refusal(reverseCash(v[OPS]!, O, { id: id(), reason: "duplicate" }))).code).toBe("too_late");
  });
});

describe("the auditor's check", () => {
  it("checks ended shifts only, never their own; a question reaches the person and the Ops Head; the answer, the auditor; ok settles it", async () => {
    const s = (await cashHome(v[AUD]!)).toCheck.find((x) => x.employee.id === DRV2)!;
    expect(s).toBeDefined();
    expect((await cashHome(v[OPS]!)).toCheck.some((x) => x.employee.id === OPS)).toBe(false);
    const [own] = await sql()<{ id: string }[]>`select id from shift where employee_id = ${OPS} and state = 'closed' limit 1`;
    expect((await refusal(auditShift(v[OPS]!, own!.id, { outcome: "ok" }))).code).toBe("own_shift");
    const open = await startShift(v[DRV]!, { id: id() });
    expect((await refusal(auditShift(v[AUD]!, open.shiftId, { outcome: "ok" }))).code).toBe("shift_open");
    expect((await refusal(auditShift(v[DRV2]!, s.id, { outcome: "ok" }))).status).toBe(403);
    expect((await refusal(auditShift(v[AUD]!, s.id, { outcome: "query" }))).code).toBe("note_needed");

    await auditShift(v[AUD]!, s.id, { outcome: "query", note: "Where are the AED 5 from 771?" });
    const asked = await told(`cash.query`);
    expect(asked.has(DRV2)).toBe(true);
    expect(asked.has(OPS)).toBe(true);
    expect(asked.has(AUD)).toBe(false);
    expect((await cashShift(v[DRV2]!, s.id))!.may.answer).toBe(true);
    await answerQuery(v[DRV2]!, s.id, { note: "It was a test note — put back into the machine." });
    expect(await told(`cash.answer:${s.id}`)).toEqual(new Set([AUD]));
    expect((await cashShift(v[AUD]!, s.id))!.answer).toMatchObject({ note: "It was a test note — put back into the machine." });

    await auditShift(v[AUD]!, s.id, { outcome: "ok" });
    expect(await told(`cash.settled:${s.id}`)).toEqual(new Set([DRV2]));
    expect((await auditShift(v[AUD]!, s.id, { outcome: "ok" })).replay).toBe(true);
    expect((await refusal(auditShift(v[AUD]!, s.id, { outcome: "query", note: "one more?" }))).code).toBe("already_ok");
    expect((await cashHome(v[AUD]!)).toCheck.some((x) => x.id === s.id)).toBe(false);
  });
});

describe("questions that wait, and words that stay on the shift", () => {
  it("a question on a shift older than the 7 latest is still answered from Cash; a second question is unanswered until answered", async () => {
    const OLD = (await startShift(v[DRV3]!, { id: id() })).shiftId;
    await endShift(v[DRV3]!, {});
    for (let i = 0; i < 8; i++) {
      await startShift(v[DRV3]!, { id: id() });
      await endShift(v[DRV3]!, {});
    }
    await auditShift(v[AUD]!, OLD, { outcome: "query", note: "Q1 — where is the AED 20 from 771?" });
    const home = await cashHome(v[DRV3]!);
    expect(home.recentShifts.some((x) => x.id === OLD)).toBe(false);
    expect(home.questions.find((x) => x.id === OLD)).toMatchObject({ may: { answer: true }, answer: null });
    await answerQuery(v[DRV3]!, OLD, { note: "A1 — it was a test note" });
    expect((await cashShift(v[AUD]!, OLD))!.answer).toMatchObject({ note: "A1 — it was a test note" });
    // A second question: the first answer is not its answer.
    await new Promise((r) => setTimeout(r, 20));
    await auditShift(v[AUD]!, OLD, { outcome: "query", note: "Q2 — Televend shows 6 cash sales, recount?" });
    expect((await cashShift(v[AUD]!, OLD))!.answer).toBeNull();
    expect((await cashHome(v[DRV3]!)).questions.find((x) => x.id === OLD)!.answer).toBeNull();
    // An answer written to Q1 that arrives after Q2 is refused, to be read first (the card sends the question it showed).
    const shown = (await cashShift(v[DRV3]!, OLD))!.audit!.at;
    expect((await refusal(answerQuery(v[DRV3]!, OLD, { note: "A1 again", questionAt: new Date(Date.parse(shown) - 60_000).toISOString() }))).code).toBe(
      "question_changed",
    );
    await answerQuery(v[DRV3]!, OLD, { note: "A2 — recounted, 60", questionAt: shown });
    expect((await cashShift(v[AUD]!, OLD))!.answer).toMatchObject({ note: "A2 — recounted, 60" });
    await auditShift(v[AUD]!, OLD, { outcome: "ok" });
    // "All ok" keeps the question it settled, so the answer beside it still answers something.
    expect((await cashShift(v[AUD]!, OLD))!).toMatchObject({ audit: { outcome: "ok", note: "Q2 — Televend shows 6 cash sales, recount?" }, answer: { note: "A2 — recounted, 60" } });
    expect((await auditShift(v[AUD]!, OLD, { outcome: "ok" })).replay).toBe(true);
    expect((await cashHome(v[DRV3]!)).questions.some((x) => x.id === OLD)).toBe(false);
  });

  it("keeps the question's and the answer's words out of the audit trail and out of every notice — retention and erasure reach them only on the shift", async () => {
    const [shift] = await sql()<{ id: string }[]>`select id from shift where employee_id = ${DRV3} and answer_note like 'A2%'`;
    const trail = await sql()<{ action: string; detail: string }[]>`select action, detail::text as detail from audit_log where entity_id = ${shift!.id}`;
    expect(trail.map((t) => t.action)).toEqual(expect.arrayContaining(["cash.shift_query", "cash.query_answered", "cash.shift_ok"]));
    for (const t of trail) expect(t.detail).not.toMatch(/Q1|Q2|A1|A2|recount|test note/);
    const notices = await sql()<{ text: string }[]>`
      select coalesce(payload->>'text', payload::text) as text from notification_outbox
       where idempotency_key like ${`cash.query%:${shift!.id}:%`} or idempotency_key like ${`cash.answer:${shift!.id}:%`}`;
    expect(notices.length).toBeGreaterThan(0);
    for (const n of notices) expect(n.text).not.toMatch(/Q1|Q2|A1|A2|recount|test note/);
  });
});

describe("Televend's side", () => {
  it("matches an entry by the phone's time only when it is earlier than the server's — never later, never half a day out", async () => {
    const now = Date.now();
    const LATE = id();
    const EARLY = id();
    const FAR = id();
    await recordCollection(v[DRV]!, { id: LATE, machineAssetNo: ASSET2, amountFils: 100, deviceAt: new Date(now + 3 * 3_600_000), mediaIds: [await photo(DRV)] });
    await recordCollection(v[DRV]!, { id: EARLY, machineAssetNo: ASSET2, amountFils: 100, deviceAt: new Date(now - 3 * 3_600_000), mediaIds: [await photo(DRV)] });
    await recordCollection(v[DRV]!, { id: FAR, machineAssetNo: ASSET2, amountFils: 100, deviceAt: new Date(now - 13 * 3_600_000), mediaIds: [await photo(DRV)] });
    const entries = (await cashHome(v[DRV]!)).openShift!.entries;
    const at = (x: string) => entries.find((e) => e.id === x)!;
    expect(at(LATE).enteredAt).toBe(at(LATE).recordedAt);
    expect(Math.abs(Date.parse(at(EARLY).enteredAt) - (now - 3 * 3_600_000))).toBeLessThan(1_000);
    expect(at(FAR).enteredAt).toBe(at(FAR).recordedAt);
    await endShift(v[DRV]!, {});
  });


  it("shows beside each collection what the machine's own cash sales say it should have held; a machine it does not know is 'unmatched'", async () => {
    const now = Date.now();
    await event("Cash Collection", new Date(now - 26 * 3_600_000));
    for (const h of [20, 10, 3]) await vend(new Date(now - h * 3_600_000), 0);
    await vend(new Date(now - 5 * 3_600_000), 1); // a card sale: no cash
    await event("Cash Collection", new Date(now - 5 * 60_000));
    const E = id();
    await recordCollection(v[DRV]!, { id: E, machineAssetNo: ASSET, amountFils: 2_500, mediaIds: [await photo(DRV)] });
    const F = id();
    await recordCollection(v[DRV]!, { id: F, machineAssetNo: ASSET2, amountFils: 1_000, mediaIds: [await photo(DRV)] });
    const mine = (await cashHome(v[DRV]!)).openShift!;
    // The driver never sees it — a figure on their screen could be typed again to match (D237) …
    expect(mine.entries.find((e) => e.id === E)!.televend).toBeNull();
    expect(mine).toMatchObject({ differences: null, unmatched: null });
    // … the auditor does, without reading Televend's tables: 3 cash sales since the last collection, at
    // the machine's AED 10.
    const seen = (await cashShift(v[AUD]!, mine.id))!;
    expect(seen.entries.find((e) => e.id === E)!.televend).toMatchObject({ cashVends: 3, expectedFils: 3_000 });
    expect(seen.entries.find((e) => e.id === F)!.televend).toBeNull();
    expect(seen).toMatchObject({ differences: 1, unmatched: 1 });
    await endShift(v[DRV]!, {});
  });

  it("matches Televend's collection on the server's time, whatever time the phone sends (review of the fixes, 20 Oct)", async () => {
    // A collection near now on 771, sent with a phone time three hours earlier: still compared with the collection near now.
    await event("Cash Collection", new Date(Date.now() - 2 * 60_000));
    const E = id();
    await recordCollection(v[DRV]!, { id: E, machineAssetNo: ASSET, amountFils: 0, deviceAt: new Date(Date.now() - 3 * 3_600_000), mediaIds: [await photo(DRV)] });
    const mine = (await cashHome(v[DRV]!)).openShift!;
    expect((await cashShift(v[AUD]!, mine.id))!.entries.find((e) => e.id === E)!.televend).not.toBeNull();
    await endShift(v[DRV]!, {});
  });
});

describe("who sees what", () => {
  it("a driver sees only their own cash; the warehouse sees none; the auditor sees everyone's, with the receipts", async () => {
    const [theirs] = await sql()<{ id: string }[]>`select id from shift where employee_id = ${DRV2} order by started_at limit 1`;
    expect(await cashShift(v[DRV]!, theirs!.id)).toBeNull();
    expect((await refusal(cashHome(v[KEEP]!))).status).toBe(403);
    expect((await refusal(cashMachines(v[KEEP]!))).status).toBe(403);
    expect((await refusal(cashShifts(v[DRV]!))).status).toBe(403);
    const nothing = await withContext(
      v[KEEP]!,
      async (tx) => {
        const [r] = await tx<{ d: number; s: number; b: number; a: number }[]>`
          select (select count(*)::int from cash_doc) as d, (select count(*)::int from shift) as s,
                 (select count(*)::int from cash_balance) as b, (select count(*)::int from cash_account) as a`;
        return r!;
      },
      { readOnly: true },
    );
    expect(nothing).toEqual({ d: 0, s: 0, b: 0, a: 0 });
    const accounts = await withContext(v[DRV]!, (tx) => tx<{ kind: string; employee_id: string | null }[]>`select kind, employee_id from cash_account`, { readOnly: true });
    expect(accounts.filter((x) => x.kind === "person").map((x) => x.employee_id)).toEqual([DRV]);
    const balances = await withContext(v[DRV]!, (tx) => tx<{ n: number }[]>`select count(*)::int as n from cash_balance`, { readOnly: true });
    expect(balances[0]!.n).toBe(1);
    // The auditor reads everyone's shifts, and the photos on them — a driver is not someone they lead.
    expect((await cashShifts(v[AUD]!)).some((x) => x.employee.id === DRV2)).toBe(true);
    const detail = await cashShift(v[AUD]!, theirs!.id);
    expect(detail!.entries.some((e) => e.photos.length > 0)).toBe(true);
    // The machines to choose from, for anyone who handles cash.
    expect((await cashMachines(v[DRV]!)).find((m) => m.assetNo === ASSET)).toMatchObject({ label: `${TAG} Mina-771` });
  });
});

describe("whatever happens, the books balance", () => {
  it("each account's balance equals its moves, all of them sum to zero, and no person holds less than nothing", async () => {
    const drift = await sql()<{ account_id: string }[]>`
      with flows as (select to_account_id as a, fils from cash_move union all select from_account_id, -fils from cash_move)
      select b.account_id from cash_balance b left join flows f on f.a = b.account_id
       group by b.account_id, b.fils having b.fils <> coalesce(sum(f.fils), 0)`;
    expect(drift).toEqual([]);
    const [total] = await sql()<{ t: string }[]>`select coalesce(sum(fils), 0)::text as t from cash_balance`;
    expect(Number(total!.t)).toBe(0);
    const [neg] = await sql()<{ n: number }[]>`select count(*)::int as n from cash_balance where not is_virtual and fils < 0`;
    expect(neg!.n).toBe(0);
  });

  it("never changes a move, an entry's content, or a balance by hand", async () => {
    const [doc] = await sql()<{ id: string }[]>`select doc_id as id from cash_move where posted_by = ${DRV} limit 1`;
    await expect(sql()`update cash_move set fils = fils + 1 where doc_id = ${doc!.id}`).rejects.toThrow();
    await expect(sql()`delete from cash_move where doc_id = ${doc!.id}`).rejects.toThrow();
    await expect(sql()`update cash_doc set amount_fils = amount_fils + 1 where id = ${doc!.id}`).rejects.toThrow(/never changed/);
    await expect(sql()`update cash_doc set note = 'rewritten' where id = ${doc!.id}`).rejects.toThrow(/only ever removed/);
    await expect(sql()`update cash_balance set fils = 0 where account_id in (select id from cash_account where employee_id = ${DRV})`).rejects.toThrow(/kept by the ledger/);
    await expect(sql()`delete from shift where employee_id = ${DRV}`).rejects.toThrow(/never deleted/);
  });

  it("a person's own download lists their cash: what they hold, their shifts with the question and answer, their entries with their words", async () => {
    const out = (await exportPersonData({ employeeId: DRV, requestedBy: DRV })) as Record<string, Record<string, unknown>[]>;
    expect(out.cashHeldFils).toEqual([{ fils: expect.any(String) }]);
    expect(out.cashShifts!.length).toBeGreaterThan(1);
    expect(Object.keys(out.cashShifts![0]!)).toEqual(expect.arrayContaining(["business_date", "audit_outcome", "question_to_you", "your_answer"]));
    expect(out.cashEntries!.some((e) => e.kind === "deposit")).toBe(true);
    const audits = (await exportPersonData({ employeeId: AUD, requestedBy: AUD })) as Record<string, Record<string, unknown>[]>;
    expect(audits.cashChecksYouMade!.length).toBeGreaterThan(0);
  });

  it("gives the app role nothing but SELECT on every cash table", async () => {
    for (const t of ["cash_account", "shift", "cash_doc", "cash_move", "cash_balance"]) {
      const [r] = await sql()<{ sel: boolean; ins: boolean; upd: boolean; del: boolean }[]>`
        select has_table_privilege('freshnow_app', ${t}, 'SELECT') as sel, has_table_privilege('freshnow_app', ${t}, 'INSERT') as ins,
               has_table_privilege('freshnow_app', ${t}, 'UPDATE') as upd, has_table_privilege('freshnow_app', ${t}, 'DELETE') as del`;
      expect({ t, ...r }).toEqual({ t, sel: true, ins: false, upd: false, del: false });
    }
  });
});

describe("the words on cash records follow the person's other words", () => {
  const saved = process.env.RETENTION_DAYS;
  afterAll(() => {
    if (saved === undefined) delete process.env.RETENTION_DAYS;
    else process.env.RETENTION_DAYS = saved;
  });

  it("the retention sweep removes old notes, questions and answers, and keeps the amounts; recent words stay", async () => {
    process.env.RETENTION_DAYS = "90";
    const OLD = id();
    const OLDDOC = id();
    await sql()`insert into shift (id, employee_id, started_at, business_date, state, ended_at, ended_by, audit_outcome, audited_by, audited_at,
                                   audit_note, answer_note, answered_at, is_synthetic)
                values (${OLD}, ${DRV3}, now() - interval '121 days', (now() - interval '121 days')::date, 'closed', now() - interval '120 days', ${DRV3},
                        'query', ${AUD}, now() - interval '120 days', 'old question about Ali', 'old answer', now() - interval '119 days', true)`;
    await sql()`insert into cash_doc (id, kind, shift_id, created_by, machine_id, amount_fils, note, recorded_at, request_hash, is_synthetic)
                values (${OLDDOC}, 'collection', ${OLD}, ${DRV3}, ${MACHINE}, 0, 'old words', now() - interval '121 days', ${"0".repeat(64)}, true)`;
    const [fresh] = await sql()<{ id: string }[]>`select id from shift where employee_id = ${DRV2} and answer_note is not null limit 1`;
    await retentionSweep();
    const [s] = await sql()<{ audit_note: string; answer_note: string; audit_outcome: string }[]>`select audit_note, answer_note, audit_outcome from shift where id = ${OLD}`;
    expect(s).toMatchObject({ audit_note: expect.stringMatching(/^\[redacted/), answer_note: expect.stringMatching(/^\[redacted/), audit_outcome: "query" });
    const [d] = await sql()<{ note: string; amount: string }[]>`select note, amount_fils::text as amount from cash_doc where id = ${OLDDOC}`;
    expect(d).toMatchObject({ note: expect.stringMatching(/^\[redacted/), amount: "0" });
    const [kept] = await sql()<{ answer_note: string }[]>`select answer_note from shift where id = ${fresh!.id}`;
    expect(kept!.answer_note).toBe("It was a test note — put back into the machine.");
  });

  it("erasing a person removes the words on their cash — theirs, and the auditor's about them; the amounts stay", async () => {
    const [before] = await sql()<{ n: number; total: string }[]>`
      select count(*)::int as n, coalesce(sum(amount_fils), 0)::text as total from cash_doc d join shift s on s.id = d.shift_id where s.employee_id = ${DRV2}`;
    await eraseEmployee({ employeeId: DRV2, by: DEMO_CEO_ID, reason: "request" });
    const words = await sql()<{ note: string | null }[]>`
      select d.note from cash_doc d join shift s on s.id = d.shift_id where s.employee_id = ${DRV2} and d.note is not null`;
    expect(words.length).toBeGreaterThan(0); // "cash test 10", and the auditor's undo note
    expect(words.every((w) => w.note === "[erased]")).toBe(true);
    const shifts = await sql()<{ audit_note: string | null; answer_note: string | null }[]>`
      select audit_note, answer_note from shift where employee_id = ${DRV2} and (audit_note is not null or answer_note is not null)`;
    expect(shifts.length).toBeGreaterThan(0);
    for (const x of shifts) expect([x.audit_note ?? "[erased]", x.answer_note ?? "[erased]"]).toEqual(["[erased]", "[erased]"]);
    const [after] = await sql()<{ n: number; total: string }[]>`
      select count(*)::int as n, coalesce(sum(amount_fils), 0)::text as total from cash_doc d join shift s on s.id = d.shift_id where s.employee_id = ${DRV2}`;
    expect(after).toEqual(before);
  });
});
