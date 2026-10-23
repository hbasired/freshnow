import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { DateRange, TelevendSource, TvEvent, TvMachine, TvRefill, TvVend } from "@freshnow/televend";
import { DEMO_CEO_ID } from "./meta.js";
import { closeDb, getServiceSql, withContext } from "./db.js";
import {
  TelevendSyncError,
  backfillDays,
  checkDay,
  dubaiDate,
  refreshOpenAlarms,
  refillDays,
  runIncrementalSync,
  syncEventsWindow,
  syncMachines,
  syncRefillsDay,
  syncVendsWindow,
  televendHealth,
  type SyncContext,
} from "./televend-sync.js";

/**
 * The Televend mirror against a real (throwaway) Postgres — never mocked. Televend itself is a
 * fake TelevendSource with fixed data, so every number below is known in advance.
 */

const T = (iso: string) => new Date(iso);
const day12 = { from: T("2026-10-12T00:00:00+04:00"), to: T("2026-10-13T00:00:00+04:00") };

function machine(id: number, caption: string, over: Partial<TvMachine> = {}): TvMachine {
  return {
    televendId: id,
    caption,
    enabled: true,
    pid: null,
    externalId: null,
    locationId: null,
    locationCaption: "Metro",
    city: "Dubai",
    regionCaption: "Metro",
    machineTypeCaption: "Metro",
    stockTracking: true,
    lastVendAt: null,
    lastRefillAt: null,
    stockPercent: 50,
    lastStatus: 0,
    connectionStatus: 1,
    signalStrength: 20,
    raw: { id, caption },
    ...over,
  };
}

const vend = (id: number, iso: string, machineId = 9001): TvVend => ({
  televendId: id,
  machineTelevendId: machineId,
  machineCaption: "Site A-901-DXB",
  at: T(iso),
  product: "Orange Juice New",
  paymentType: 1,
  paymentTypeCaption: "Cash",
  value: null,
  column: 32767,
  quantity: 1,
  priceList: 1,
  raw: { vend_id: id, televend_device_vend_id: id + 100 },
});

const alarm = (id: number, iso: string, resolved: string | null): TvEvent => ({
  televendId: id,
  machineTelevendId: 9001,
  machineCaption: "Site A-901-DXB",
  level: 3,
  type: "0",
  source: 1,
  name: null,
  description: "Bill / Cash Box Full",
  startedAt: T(iso),
  resolvedAt: resolved ? T(resolved) : null,
  counter: 1,
  raw: { id },
});

const refill = (iso: string, qty: number, caption = "Site A-901-DXB"): TvRefill => ({
  machineTelevendId: 9001,
  machineCaption: caption,
  at: T(iso),
  filledBy: "Filler Test",
  role: "Filler",
  column: 32767,
  product: "Orange Juice New",
  action: "filled",
  quantityChange: qty,
  quantityAfter: 63,
  capacity: 63,
  origin: "mobile_app",
  raw: { quantity_change: qty },
});

/** A scripted Televend. Mutate `state` between calls to simulate time passing. */
function fakeSource() {
  const state = {
    machines: [machine(9001, "Site A-901-DXB"), machine(9002, "Site B-902-SHJ", { enabled: false })],
    vends: [] as TvVend[],
    events: [] as TvEvent[],
    refills: [] as TvRefill[],
    /** Televend's own whole-day count; undefined = count the rows. */
    count: undefined as number | undefined,
    complete: true,
    requests: 0,
    refillCalls: [] as { day: string; ids: readonly number[] | undefined }[],
    /** Televend failing a stream (e.g. three 503s in a row): the call throws. */
    fail: { refills: false, vends: false, events: false },
  };
  const inRange = (d: Date, r: DateRange) => d >= r.from && d < r.to;
  const source: TelevendSource = {
    transport: "bridge",
    machines: async () => {
      state.requests += 3;
      return state.machines;
    },
    vends: async (r) => {
      state.requests++;
      if (state.fail.vends) throw new Error("vends: Televend answered 503");
      return { rows: state.vends.filter((v) => inRange(v.at, r)), complete: state.complete };
    },
    vendTotals: async (r) => {
      state.requests++;
      const n = state.count ?? state.vends.filter((v) => inRange(v.at, r)).length;
      return { from: r.from, to: r.to, vends: n, quantity: n, revenue: null };
    },
    events: async (r) => {
      state.requests++;
      if (state.fail.events) throw new Error("events: Televend answered 503");
      return { rows: state.events.filter((e) => inRange(e.startedAt, r)), complete: state.complete };
    },
    refills: async (day, ids) => {
      state.refillCalls.push({ day, ids });
      state.requests += ids ? ids.length : 1;
      if (state.fail.refills) throw new Error("refills: Televend answered 503");
      const r = { from: T(`${day}T00:00:00+04:00`), to: T(`${day}T00:00:00+04:00`) };
      r.to = new Date(r.from.getTime() + 86_400_000);
      return state.refills.filter((x) => inRange(x.at, r));
    },
  };
  return { source, state };
}

const TABLES = ["tv_sync_cursor", "tv_sync_run", "tv_refill", "tv_event", "tv_vend", "machine_placement", "machine", "tv_machine_caption", "tv_machine"];

async function wipe(): Promise<void> {
  const sql = getServiceSql();
  for (const t of TABLES) await sql.unsafe(`delete from ${t}`);
}

describe("Televend mirror (migration 0023 + televend-sync)", () => {
  beforeEach(wipe);
  afterAll(async () => {
    await wipe();
    await closeDb();
  });

  it("machines: one physical machine per asset number, names followed, disabled machines unplaced", async () => {
    const { source, state } = fakeSource();
    const c: SyncContext = { source, requests: () => state.requests };
    const r1 = await syncMachines(c);
    expect(r1).toMatchObject({ machines: 2, enabled: 1, renamed: 0 });
    const sql = getServiceSql();
    expect((await sql`select asset_no, label from machine`).map((x) => [x.asset_no, x.label])).toEqual([[901, "Site A-901-DXB"]]);
    expect(await sql`select 1 from machine_placement where valid_to is null`).toHaveLength(1);

    // Renamed in Televend: same machine, new name recorded, label follows.
    state.machines[0] = machine(9001, "Site A-901-Cashless 1-DXB");
    const r2 = await syncMachines(c);
    expect(r2.renamed).toBe(1);
    expect((await sql`select caption from tv_machine_caption where televend_id = 9001 order by caption`).map((x) => x.caption)).toEqual([
      "Site A-901-Cashless 1-DXB",
      "Site A-901-DXB",
    ]);
    expect((await sql`select label from machine where asset_no = 901`)[0]?.label).toBe("Site A-901-Cashless 1-DXB");

    // A label set by hand is never overwritten.
    await sql`update machine set label = 'Front of mall', label_manual = true where asset_no = 901`;
    state.machines[0] = machine(9001, "Site A-901-New name-DXB");
    await syncMachines(c);
    expect((await sql`select label from machine where asset_no = 901`)[0]?.label).toBe("Front of mall");

    // The Televend record now carries a different asset number: old placement closed, new opened.
    state.machines[0] = machine(9001, "Site A-955-DXB");
    await syncMachines(c);
    const open = await sql`select m.asset_no from machine_placement p join machine m on m.id = p.machine_id where p.tv_machine_id = 9001 and p.valid_to is null`;
    expect(open.map((x) => x.asset_no)).toEqual([955]);
    expect(await sql`select 1 from machine_placement where tv_machine_id = 9001 and valid_to is not null`).toHaveLength(1);
  });

  it("vends: re-reading inserts nothing twice; a whole day is complete only when it equals Televend's count", async () => {
    const { source, state } = fakeSource();
    state.vends = [vend(1, "2026-10-12T08:00:00+04:00"), vend(2, "2026-10-12T09:00:00+04:00"), vend(3, "2026-10-12T23:59:59+04:00")];
    const c: SyncContext = { source, requests: () => state.requests };
    const first = await syncVendsWindow(c, day12, "daily_check");
    expect(first).toMatchObject({ read: 3, fresh: 3, complete: true, televendCount: 3 });
    const again = await syncVendsWindow(c, day12, "daily_check");
    expect(again).toMatchObject({ read: 3, fresh: 0, complete: true });

    state.count = 4; // Televend counts a vend we did not get
    const short = await syncVendsWindow(c, day12, "daily_check");
    expect(short.complete).toBe(false);
    const runs = await getServiceSql()`select status, complete, televend_count, requests from tv_sync_run where stream = 'vends' order by started_at`;
    expect(runs.map((x) => [x.status, x.complete, x.televend_count])).toEqual([
      ["ok", true, 3],
      ["ok", true, 3],
      ["partial", false, 4],
    ]);
    expect(runs.every((x) => x.requests === 2)).toBe(true); // the list + the count
    expect((await getServiceSql()`select device_vend_id from tv_vend order by device_vend_id`).map((x) => Number(x.device_vend_id))).toEqual([101, 102, 103]);
  });

  it("events: a later read that brings the resolution updates the row instead of adding one", async () => {
    const { source, state } = fakeSource();
    state.events = [alarm(77, "2026-10-12T10:00:00+04:00", null)];
    const c: SyncContext = { source, requests: () => state.requests };
    expect(await syncEventsWindow(c, day12, "incremental")).toMatchObject({ fresh: 1, changed: 0 });
    expect(await syncEventsWindow(c, day12, "incremental")).toMatchObject({ fresh: 0, changed: 0 });
    state.events = [alarm(77, "2026-10-12T10:00:00+04:00", "2026-10-12T14:30:00+04:00")];
    expect(await syncEventsWindow(c, day12, "incremental")).toMatchObject({ fresh: 0, changed: 1 });
    const row = (await getServiceSql()`select kind, resolved_at from tv_event where external_id = '77'`)[0];
    expect(row?.kind).toBe("alarm");
    expect((row?.resolved_at as Date).toISOString()).toBe("2026-10-12T10:30:00.000Z");
  });

  it("refills: the same refill from the API (microseconds) and an export (seconds) is stored once", async () => {
    const { source, state } = fakeSource();
    state.refills = [refill("2026-10-12T04:51:42.370+04:00", 46)];
    const c: SyncContext = { source, requests: () => state.requests };
    expect((await syncRefillsDay(c, "2026-10-12", "daily_check")).fresh).toBe(1);
    // The export's copy: renamed machine, whole seconds.
    state.refills = [refill("2026-10-12T04:51:42+04:00", 46, "Site A-901-Cashless 1-DXB")];
    expect((await syncRefillsDay(c, "2026-10-12", "daily_check")).fresh).toBe(0);
    expect(await getServiceSql()`select 1 from tv_refill`).toHaveLength(1);
  });

  it("refills: two columns of one machine filled in the same second are two refills (G159)", async () => {
    const { source, state } = fakeSource();
    const a = { ...refill("2026-10-11T09:45:38+04:00", 3), column: 511, product: "Orange Juices" };
    const b = { ...refill("2026-10-11T09:45:38+04:00", 3), column: 767, product: "Orange Beetroot Juice" };
    state.refills = [a, b];
    const c: SyncContext = { source, requests: () => state.requests };
    expect((await syncRefillsDay(c, "2026-10-11", "daily_check")).fresh).toBe(2);
    expect((await syncRefillsDay(c, "2026-10-11", "daily_check")).fresh).toBe(0);
  });

  it("a record disabled since the last sync has today's refills read once — the machine was emptied before it moved (G160)", async () => {
    const { source, state } = fakeSource();
    const c: SyncContext = { source, requests: () => state.requests, now: () => T("2026-10-06T03:00:00+04:00") };
    await syncMachines(c); // 9001 enabled, 9002 disabled from the start
    // Televend drops last_refill from a disabled record; only the enabled → disabled flip shows it.
    state.machines[0] = machine(9001, "Site A-901-DXB", { enabled: false, lastRefillAt: null });
    state.refills = [{ ...refill("2026-10-06T02:40:00+04:00", 42), action: "removed", origin: "televend", quantityAfter: 0 }];
    const r = await runIncrementalSync(c);
    expect(state.refillCalls).toEqual([{ day: "2026-10-06", ids: [9001] }]);
    expect(r.refills?.fresh).toBe(1);

    state.refillCalls.length = 0;
    await runIncrementalSync(c); // already disabled: not asked again every 10 minutes
    expect(state.refillCalls).toEqual([]);
  });

  it("a refill read is complete only when every record was asked", async () => {
    const { source, state } = fakeSource();
    const c: SyncContext = { source, requests: () => state.requests };
    expect((await syncRefillsDay(c, "2026-10-12", "incremental", [9001])).complete).toBe(false);
    expect((await syncRefillsDay(c, "2026-10-12", "daily_check")).complete).toBe(true);
  });

  it("the first sync reads no log of a record that was already disabled", async () => {
    const { source, state } = fakeSource(); // 9002 is disabled from the start
    const c: SyncContext = { source, requests: () => state.requests, now: () => T("2026-10-12T03:00:00+04:00") };
    const r = await runIncrementalSync(c);
    expect(r.machines.refillReads).toEqual([]);
    expect(state.refillCalls).toEqual([]);
  });

  it("refill days run from the previous sync's day to today, at most two (review 2026-10-15)", () => {
    expect(refillDays(T("2026-10-15T23:50:00+04:00"), T("2026-10-16T00:05:00+04:00"))).toEqual(["2026-10-15", "2026-10-16"]);
    expect(refillDays(T("2026-10-16T00:05:00+04:00"), T("2026-10-15T23:50:00+04:00"))).toEqual(["2026-10-15", "2026-10-16"]);
    expect(refillDays(T("2026-10-16T09:00:00+04:00"), T("2026-10-16T09:10:00+04:00"))).toEqual(["2026-10-16"]);
    // The worker was down for days: the 10-minute sync reads the last two; older days are the daily check's or a backfill's.
    expect(refillDays(T("2026-10-10T09:00:00+04:00"), T("2026-10-16T09:10:00+04:00"))).toEqual(["2026-10-15", "2026-10-16"]);
  });

  it("a record emptied at 23:57 and disabled before the 00:05 sync is read on both days (G160)", async () => {
    const { source, state } = fakeSource();
    let now = T("2026-10-15T23:50:00+04:00");
    const c: SyncContext = { source, requests: () => state.requests, now: () => now };
    await syncMachines(c); // seen enabled at 23:50
    state.machines[0] = machine(9001, "Site A-901-DXB", { enabled: false, lastRefillAt: null });
    state.refills = [{ ...refill("2026-10-15T23:57:00+04:00", 42), action: "removed", origin: "televend", quantityAfter: 0 }];
    now = T("2026-10-16T00:05:00+04:00");
    const r = await runIncrementalSync(c);
    expect(state.refillCalls).toEqual([
      { day: "2026-10-15", ids: [9001] },
      { day: "2026-10-16", ids: [9001] },
    ]);
    expect(r.refills?.fresh).toBe(1);
  });

  it("a refill read that fails is asked for again next run — the machine's new state waits for it", async () => {
    const { source, state } = fakeSource();
    let now = T("2026-10-12T02:00:00+04:00");
    const c: SyncContext = { source, requests: () => state.requests, now: () => now };
    const sql = getServiceSql();
    await syncMachines(c);
    state.machines[0] = machine(9001, "Site A-901-DXB", { lastRefillAt: T("2026-10-12T02:05:00+04:00") });
    state.refills = [refill("2026-10-12T02:05:00+04:00", 30)];
    state.fail.refills = true;
    now = T("2026-10-12T02:10:00+04:00");
    await expect(runIncrementalSync(c)).rejects.toThrow(TelevendSyncError);
    // Vends and events of that run were still read and saved...
    expect(await sql`select 1 from tv_sync_run where stream = 'vends' and status = 'ok'`).toHaveLength(1);
    // ...but the machine still shows the state before the refill, so the read is asked for again.
    expect((await sql`select last_refill_at from tv_machine where televend_id = 9001`)[0]?.last_refill_at).toBeNull();

    state.fail.refills = false;
    now = T("2026-10-12T02:20:00+04:00");
    const r = await runIncrementalSync(c);
    expect(state.refillCalls.at(-1)).toEqual({ day: "2026-10-12", ids: [9001] });
    expect(r.refills?.fresh).toBe(1);
    expect((await sql`select last_refill_at from tv_machine where televend_id = 9001`)[0]?.last_refill_at).toEqual(T("2026-10-12T02:05:00+04:00"));
  });

  it("one stream failing does not stop the others; the run ends failed and names it", async () => {
    const { source, state } = fakeSource();
    const c: SyncContext = { source, requests: () => state.requests, now: () => T("2026-10-12T02:00:00+04:00") };
    state.vends = [vend(1, "2026-10-12T01:30:00+04:00")];
    state.events = [alarm(7, "2026-10-12T01:40:00+04:00", null)];
    state.fail.vends = true;
    await expect(runIncrementalSync(c)).rejects.toThrow(/vends: vends: Televend answered 503/);
    expect(await getServiceSql()`select 1 from tv_event`).toHaveLength(1); // events still read
    expect(await getServiceSql()`select stream from tv_sync_cursor`).toEqual([{ stream: "events" }]); // only events moved
  });

  it("the daily check retries a failed stream on its own, after the others completed (review 2026-10-15)", async () => {
    const { source, state } = fakeSource();
    let now = T("2026-10-13T04:10:00+04:00");
    const c: SyncContext = { source, requests: () => state.requests, now: () => now };
    state.vends = [vend(1, "2026-10-12T08:00:00+04:00")];
    state.fail.refills = true;
    await expect(runIncrementalSync(c)).rejects.toThrow(/daily check 2026-10-12 refills/);

    state.fail.refills = false;
    state.refillCalls.length = 0;
    now = T("2026-10-13T04:20:00+04:00");
    const r = await runIncrementalSync(c);
    expect(state.refillCalls).toEqual([{ day: "2026-10-12", ids: undefined }]); // refills alone, every record
    expect(r.dailyCheck?.vends.skipped).toBe(true);
    expect(r.dailyCheck?.events.skipped).toBe(true);
    expect(r.dailyCheck?.refills.complete).toBe(true);
    now = T("2026-10-13T04:30:00+04:00");
    expect((await runIncrementalSync(c)).dailyCheck).toBeNull(); // the day is complete
  });

  it("health shows yesterday's streams that are not complete yet, from 05:00", async () => {
    const { source, state } = fakeSource();
    const c: SyncContext = { source, requests: () => state.requests };
    expect((await televendHealth(true, T("2026-10-13T04:30:00+04:00"))).yesterdayIncomplete).toBeNull();
    expect((await televendHealth(true, T("2026-10-13T05:10:00+04:00"))).yesterdayIncomplete).toEqual(["vends", "events", "refills"]);
    state.fail.refills = true;
    await checkDay(c, "2026-10-12", "daily_check");
    expect((await televendHealth(true, T("2026-10-13T05:10:00+04:00"))).yesterdayIncomplete).toEqual(["refills"]);
  });

  it("a re-read after a record's name changes number stores nothing new — Televend's own identity holds (0024)", async () => {
    const { source, state } = fakeSource();
    const c: SyncContext = { source, requests: () => state.requests };
    const read = (caption: string): TvRefill => ({ ...refill("2026-10-12T09:00:00.123+04:00", 30, caption), raw: { fill_type: 0, quantity_change: 30 } });
    state.refills = [read("Site A-901-DXB")];
    expect((await syncRefillsDay(c, "2026-10-12", "daily_check")).fresh).toBe(1);
    state.refills = [read("Site A-955-DXB")]; // the record now carries another machine's number
    expect((await syncRefillsDay(c, "2026-10-12", "daily_check")).fresh).toBe(0);
    expect((await getServiceSql()`select natural_key from tv_refill`).map((r) => r.natural_key as string)).toEqual([
      expect.stringMatching(/^901\|/),
    ]);
  });

  it("a row stored while its code had no meaning takes the meaning, and the next read matches it (G161)", async () => {
    const { source, state } = fakeSource();
    const c: SyncContext = { source, requests: () => state.requests };
    // Stored the way it would have been before fill_type 4 / source 3 were known:
    const before: TvRefill = {
      ...refill("2026-10-08T22:05:33.558+04:00", 30),
      action: "unknown",
      origin: "unknown",
      quantityAfter: 0,
      raw: { fill_type: 4, source: 3, quantity_change: 30 },
    };
    state.refills = [before];
    await syncRefillsDay(c, "2026-10-08", "daily_check");
    // The same refill read now that the codes are mapped:
    state.refills = [{ ...before, action: "removed", origin: "televend" }];
    expect((await syncRefillsDay(c, "2026-10-08", "daily_check")).fresh).toBe(0);
    const rows = await getServiceSql()`select action, origin, natural_key from tv_refill`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "removed", origin: "televend" });
    expect(rows[0]?.natural_key as string).toContain("|removed|");
  });

  it("incremental sync: cursors move only after complete reads; refills read for the day they happened", async () => {
    const { source, state } = fakeSource();
    const c: SyncContext = { source, requests: () => state.requests, now: () => T("2026-10-13T00:05:00+04:00") };
    await syncMachines(c); // first sight
    // A refill at 23:55 on the 12th, seen by the 00:05 sync on the 13th.
    state.machines[0] = machine(9001, "Site A-901-DXB", { lastRefillAt: T("2026-10-12T23:55:00+04:00") });
    state.refills = [refill("2026-10-12T23:55:00+04:00", 30)];
    state.complete = false; // Televend hit a bound: incomplete
    const r1 = await runIncrementalSync(c);
    expect(r1.refills?.fresh).toBe(1);
    // Read under its own date — and the previous sync's (00:05 on the 13th): everything after that
    // sync is new, and a late upload can carry an older time.
    expect(state.refillCalls).toEqual([
      { day: "2026-10-12", ids: [9001] },
      { day: "2026-10-13", ids: [9001] },
    ]);
    expect(await getServiceSql()`select 1 from tv_sync_cursor`).toHaveLength(0); // incomplete → no cursor
    expect(r1.dailyCheck).toBeNull(); // 00:05 is before the daily check hour

    state.complete = true;
    await runIncrementalSync(c);
    const cursors = await getServiceSql()`select stream, read_until from tv_sync_cursor order by stream`;
    expect(cursors.map((x) => x.stream)).toEqual(["events", "vends"]);
    expect((cursors[0]?.read_until as Date).toISOString()).toBe("2026-10-12T20:03:00.000Z"); // now − 2 min settle
  });

  it("the daily check runs once after 04:00, and gives up after three incomplete tries", async () => {
    const { source, state } = fakeSource();
    let now = T("2026-10-13T04:10:00+04:00");
    const c: SyncContext = { source, requests: () => state.requests, now: () => now };
    state.vends = [vend(1, "2026-10-12T08:00:00+04:00")];
    const r = await runIncrementalSync(c);
    expect(r.dailyCheck?.day).toBe("2026-10-12");
    expect(r.dailyCheck?.vends.complete).toBe(true);
    now = T("2026-10-13T04:20:00+04:00");
    expect((await runIncrementalSync(c)).dailyCheck).toBeNull(); // done for the day

    // An incomplete day: tried at most three times.
    state.count = 99;
    const tries: (string | undefined)[] = [];
    for (let i = 0; i < 5; i++) {
      now = T(`2026-10-14T0${4 + i}:00:00+04:00`);
      tries.push((await runIncrementalSync(c)).dailyCheck?.day);
    }
    expect(tries).toEqual(["2026-10-13", "2026-10-13", "2026-10-13", undefined, undefined]);
  });

  it("backfill: newest day first, skips days already complete, stops at its request budget", async () => {
    const { source, state } = fakeSource();
    const c: SyncContext = { source, requests: () => state.requests };
    const lines: string[] = [];
    const r1 = await backfillDays(c, { from: "2026-10-10", to: "2026-10-12", streams: ["vends", "events"], maxRequests: 1_000, onDay: (l) => lines.push(l) });
    expect(r1).toEqual({ days: 3, stoppedAt: null });
    expect(lines[0]).toMatch(/^2026-10-12:/);
    const r2 = await backfillDays(c, { from: "2026-10-10", to: "2026-10-12", streams: ["vends", "events"], maxRequests: 1_000 });
    expect(r2.days).toBe(0); // all complete already
    const r3 = await backfillDays(c, { from: "2026-10-01", to: "2026-10-09", streams: ["vends"], maxRequests: 4 });
    expect(r3.days).toBe(2);
    expect(r3.stoppedAt).toBe("2026-10-07");
  });

  it("is readable by the CEO only (until the operations roles exist)", async () => {
    const { source, state } = fakeSource();
    state.vends = [vend(5, "2026-10-12T08:00:00+04:00")];
    await syncVendsWindow({ source, requests: () => state.requests }, day12, "incremental");
    const asCeo = await withContext({ employeeId: DEMO_CEO_ID, isCeo: true, accessRole: "ceo" }, (tx) => tx`select count(*)::int as n from tv_vend`);
    const asEmployee = await withContext({ employeeId: "00000000-0000-0000-0000-000000000099", isCeo: false, accessRole: "employee" }, (tx) => tx`select count(*)::int as n from tv_vend`);
    expect(asCeo[0]?.n).toBe(1);
    expect(asEmployee[0]?.n).toBe(0);
  });

  it("re-reads alarms still open here until Televend says they cleared — longest unchecked first, a few per run (review 2026-10-17, command-centre#1)", async () => {
    const { source, state } = fakeSource();
    const c: SyncContext = { source, requests: () => state.requests, now: () => T("2026-10-12T20:00:00+04:00") };
    state.events = [alarm(7101, "2026-10-12T09:00:00+04:00", null), alarm(7102, "2026-10-12T13:00:00+04:00", null)];
    await syncEventsWindow(c, { from: T("2026-10-12T08:00:00+04:00"), to: T("2026-10-12T14:00:00+04:00") }, "incremental");
    // Televend clears the 09:00 alarm at 15:00 — long after any window that starts later would see it.
    state.events[0] = alarm(7101, "2026-10-12T09:00:00+04:00", "2026-10-12T15:00:00+04:00");
    const before = T("2026-10-12T19:00:00+04:00");
    const sql = getServiceSql();
    const row = async (id: string) =>
      (await sql<{ resolved_at: Date | null; checked_at: Date | null }[]>`select resolved_at, checked_at from tv_event where external_id = ${id}`)[0]!;

    expect(await refreshOpenAlarms(c, before, { maxWindows: 1 })).toMatchObject({ windows: 1, checked: 1, cleared: 1 });
    expect((await row("7101")).resolved_at).toEqual(T("2026-10-12T15:00:00+04:00"));
    expect((await row("7102")).checked_at).toBeNull();
    // The next run takes the one never checked.
    expect(await refreshOpenAlarms(c, before, { maxWindows: 1 })).toMatchObject({ windows: 1, checked: 1, cleared: 0 });
    expect((await row("7102")).checked_at).not.toBeNull();
    // Alarms that started inside this run's own window are not re-read here — the incremental read has them.
    expect(await refreshOpenAlarms(c, T("2026-10-12T10:00:00+04:00"))).toMatchObject({ windows: 0 });
  });

  it("re-reads an alarm older than 14 days while a problem stands on it; one failing window does not stop the others (review 20 Oct, 059-fixes#2, #7)", async () => {
    const { source, state } = fakeSource();
    const c: SyncContext = { source, requests: () => state.requests, now: () => T("2026-11-05T20:00:00+04:00") };
    // An alarm three weeks old, behind an open problem; and a recent one.
    state.events = [alarm(7201, "2026-10-12T09:00:00+04:00", null), alarm(7202, "2026-11-05T10:00:00+04:00", null)];
    await syncEventsWindow(c, { from: T("2026-10-12T08:00:00+04:00"), to: T("2026-10-12T10:00:00+04:00") }, "incremental");
    await syncEventsWindow(c, { from: T("2026-11-05T09:00:00+04:00"), to: T("2026-11-05T11:00:00+04:00") }, "incremental");
    const sql = getServiceSql();
    const [b] = await sql<{ id: string }[]>`
      insert into blocker (raised_by, category, severity, affected_asset, risk, is_synthetic)
      values ('00000000-0000-0000-0000-0000000000a1', 'equipment', 'high', 'Site A', 'Connection lost', true) returning id`;
    await sql`insert into machine_alarm (event_source, event_id, machine_tv_id, alarm_name, started_at, blocker_id, is_synthetic)
              values ('bridge', '7201', 9001, 'Bill / Cash Box Full', ${T("2026-10-12T09:00:00+04:00")}, ${b!.id}, true)`;
    try {
      // Televend clears the old alarm. Its window is read although it started 24 days ago.
      state.events[0] = alarm(7201, "2026-10-12T09:00:00+04:00", "2026-11-05T12:00:00+04:00");
      expect(await refreshOpenAlarms(c, T("2026-11-05T19:00:00+04:00"))).toMatchObject({ windows: 2, cleared: 1, failed: 0 });
      expect((await sql<{ r: Date | null }[]>`select resolved_at as r from tv_event where external_id = '7201'`)[0]!.r).not.toBeNull();
      // Televend fails one window on every run (4 Nov's): the other (5 Nov's) is still read, and the run says it failed.
      state.events.push(alarm(7203, "2026-11-04T10:00:00+04:00", null));
      await syncEventsWindow(c, { from: T("2026-11-04T09:00:00+04:00"), to: T("2026-11-04T11:00:00+04:00") }, "incremental");
      await sql`update tv_event set checked_at = null`;
      state.events[1] = alarm(7202, "2026-11-05T10:00:00+04:00", "2026-11-05T13:00:00+04:00");
      const real = source.events;
      source.events = async (r, o) => {
        if (r.from.getTime() < T("2026-11-05T00:00:00+04:00").getTime()) throw new Error("events: Televend answered 502 for this window");
        return real(r, o);
      };
      await expect(refreshOpenAlarms(c, T("2026-11-05T19:00:00+04:00"))).rejects.toThrow(/1 of 2 open-alarm windows could not be read/);
      expect((await sql<{ r: Date | null }[]>`select resolved_at as r from tv_event where external_id = '7202'`)[0]!.r).not.toBeNull();
      // The failing window goes to the back of the queue: checked, still open.
      expect((await sql<{ c: Date | null; r: Date | null }[]>`select checked_at as c, resolved_at as r from tv_event where external_id = '7203'`)[0]).toMatchObject({ r: null });
      expect((await sql<{ c: Date | null }[]>`select checked_at as c from tv_event where external_id = '7203'`)[0]!.c).not.toBeNull();
    } finally {
      await sql`delete from machine_alarm where event_id = '7201'`;
      await sql`delete from blocker where id = ${b!.id}`;
    }
  });

  it("dubaiDate places an instant in its Asia/Dubai business day", () => {
    expect(dubaiDate(T("2026-10-12T20:30:00Z"))).toBe("2026-10-13");
    expect(dubaiDate(T("2026-10-12T19:59:59Z"))).toBe("2026-10-12");
  });
});
