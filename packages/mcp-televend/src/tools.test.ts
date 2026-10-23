import { describe, expect, it } from "vitest";
import type { DateRange, TelevendSource, TvEvent, TvMachine, TvRefill, TvVend } from "@freshnow/televend";
import { cashCollectionsDay, eventsDay, initials, machinesSummary, recordsForAsset, refillsDay, salesDay, MAX_ROWS } from "./tools.js";

const at = (s: string) => new Date(s);

function machine(i: number, enabled = true): TvMachine {
  return {
    televendId: 1000 + i,
    caption: `Site ${i}-${500 + i}-DXB`,
    enabled,
    pid: null,
    externalId: null,
    locationId: null,
    locationCaption: null,
    city: null,
    regionCaption: "Metro",
    machineTypeCaption: "Metro",
    stockTracking: true,
    lastVendAt: at("2026-10-12T08:00:00Z"),
    lastRefillAt: null,
    stockPercent: 50,
    lastStatus: 0,
    connectionStatus: 1,
    signalStrength: 20,
  };
}

function fake(parts: Partial<{ machines: TvMachine[]; vends: TvVend[]; events: TvEvent[]; refills: TvRefill[]; totals: number }>): TelevendSource {
  return {
    transport: "bridge",
    machines: async () => parts.machines ?? [],
    vends: async (r: DateRange) => ({ rows: (parts.vends ?? []).filter((v) => v.at >= r.from && v.at < r.to), complete: true }),
    vendTotals: async (r: DateRange) => ({ from: r.from, to: r.to, vends: parts.totals ?? 0, quantity: parts.totals ?? 0, revenue: null }),
    events: async (r: DateRange) => ({ rows: (parts.events ?? []).filter((e) => e.startedAt >= r.from && e.startedAt < r.to), complete: true }),
    refills: async () => parts.refills ?? [],
  };
}

const vend = (i: number, pay: string, machineCaption: string, iso: string): TvVend => ({
  televendId: i,
  machineTelevendId: 1,
  machineCaption,
  at: at(iso),
  product: "Orange Juice New",
  paymentType: 0,
  paymentTypeCaption: pay,
  value: null,
  column: 32767,
  quantity: 1,
  priceList: 1,
});

describe("tool answers are computed in code and bounded", () => {
  it("never returns more than 50 machine rows, but counts all of them", () => {
    const ms = Array.from({ length: 120 }, (_, i) => machine(i, i % 2 === 0));
    const r = machinesSummary(ms, { enabledOnly: false, limit: 999 });
    expect(r.rows).toHaveLength(MAX_ROWS);
    expect(r.totalMachines).toBe(120);
    expect(r.enabledMachines).toBe(60);
    expect(r.truncated).toBe(true);
    expect(machinesSummary(ms, { enabledOnly: true, search: "502", limit: 5 }).rows.map((x) => x.asset)).toEqual([502]);
  });

  it("totals sales by payment type and checks them against Televend's own count", async () => {
    const day = "2026-10-12";
    const vends = [
      vend(1, "Cash", "Site 1-501-DXB", "2026-10-12T00:30:00+04:00"),
      vend(2, "Cashless", "Site 1-501-DXB", "2026-10-12T12:00:00+04:00"),
      vend(3, "Cash", "Site 2-502-DXB", "2026-10-12T23:59:59+04:00"),
      vend(4, "Cash", "Site 2-502-DXB", "2026-10-13T00:00:00+04:00"), // next business day
    ];
    const r = await salesDay(fake({ vends, totals: 3 }), day);
    expect(r).toMatchObject({ cupsSold: 3, vendRecords: 3, televendOwnCount: 3, countsAgree: true, revenueAed: null });
    expect((r as { byPaymentType: Record<string, number> }).byPaymentType).toEqual({ Cash: 2, Cashless: 1 });
  });

  it("never prints a negative duration for an alarm Televend resolves before its latest start", async () => {
    const e: TvEvent = {
      televendId: 1,
      machineTelevendId: 1,
      machineCaption: "Site 1-501-DXB",
      level: 3,
      type: 0,
      source: 1,
      name: null,
      description: "Vending Machine Communication Interrupted",
      startedAt: at("2026-10-12T23:54:00+04:00"),
      resolvedAt: at("2026-10-12T23:45:00+04:00"),
      counter: 2,
    };
    const r = (await eventsDay(fake({ events: [e] }), "2026-10-12", { level: "alarm", limit: 10 })) as { rows: Record<string, unknown>[] };
    expect(r.rows[0]?.minutesOpen).toBeNull();
    expect(r.rows[0]?.note).toMatch(/resolved before/);
    expect(r.rows[0]?.repeats).toBe(2);
  });

  it("shows fillers as initials unless full names are asked for", async () => {
    const refill: TvRefill = {
      machineTelevendId: 1,
      machineCaption: "Site 1-501-DXB",
      at: at("2026-10-12T04:51:42+04:00"),
      filledBy: "Filler Person One",
      role: "Filler",
      column: 32767,
      product: "Orange Juice New",
      action: "filled",
      quantityChange: 46,
      quantityAfter: 63,
      capacity: 63,
      origin: "mobile_app",
    };
    const short = (await refillsDay(fake({ refills: [refill] }), "2026-10-12", { names: "initials", limit: 10 })) as Record<string, unknown>;
    expect(JSON.stringify(short)).not.toContain("Filler Person One");
    expect(short.cupsFilledByPerson).toEqual({ "F.P.O.": 46 });
    const full = (await refillsDay(fake({ refills: [refill] }), "2026-10-12", { names: "full", limit: 10 })) as Record<string, unknown>;
    expect(JSON.stringify(full)).toContain("Filler Person One");
    expect(initials("  ")).toBeNull();
  });

  it("finds cash collections in the machine events", async () => {
    const mk = (desc: string, iso: string, caption = "Site 9-693-DXB"): TvEvent => ({
      televendId: null,
      machineTelevendId: 9,
      machineCaption: caption,
      level: 1,
      type: 2,
      source: 1,
      name: null,
      description: desc,
      startedAt: at(iso),
      resolvedAt: null,
      counter: 1,
    });
    const r = (await cashCollectionsDay(
      fake({
        events: [
          mk("Cash has been collected from the machine.", "2026-10-14T15:40:00+04:00"),
          mk("Power OFF", "2026-10-14T15:41:00+04:00"),
          mk("Cash has been collected from the machine.", "2026-10-14T03:00:00+04:00", "Site 8-310-DXB"),
        ],
      }),
      "2026-10-14",
    )) as { collections: number; machines: number; rows: { asset: number; times: string[] }[] };
    expect(r.collections).toBe(2);
    expect(r.machines).toBe(2);
    expect(r.rows.find((x) => x.asset === 693)?.times).toEqual(["2026-10-14 15:40"]);
  });
});

describe("refills: a removal takes cups out, and a machine number selects all its records (review 2026-10-15)", () => {
  const row = (televendId: number, caption: string, action: TvRefill["action"], cups: number, iso: string): TvRefill => ({
    machineTelevendId: televendId,
    machineCaption: caption,
    at: at(iso),
    filledBy: "Filler Person One",
    role: "Filler",
    column: 32767,
    product: "Orange Juices",
    action,
    quantityChange: cups,
    quantityAfter: action === "removed" ? 0 : 63,
    capacity: 63,
    origin: action === "removed" ? "televend" : "mobile_app",
  });

  it("nets a removal against the cups filled; a row of unknown meaning is counted, not guessed", async () => {
    // The G160 machine: emptied on its old record (42 out), filled on its new one (64 in).
    const refills = [
      row(10, "Hall back-393-SHJ", "removed", 42, "2026-10-06T11:10:39+04:00"),
      row(11, "Mall Beta-393-DXB", "filled", 64, "2026-10-06T22:54:30+04:00"),
    ];
    const r = (await refillsDay(fake({ refills }), "2026-10-06", { names: "initials", limit: 10 })) as Record<string, unknown>;
    expect(r.cupsFilled).toBe(64);
    expect(r.netCupsChange).toBe(22);
    expect(r).not.toHaveProperty("rowsOfUnknownMeaning");

    const odd = [...refills, row(11, "Mall Beta-393-DXB", "unknown", 5, "2026-10-06T23:00:00+04:00")];
    const r2 = (await refillsDay(fake({ refills: odd }), "2026-10-06", { names: "initials", limit: 10 })) as Record<string, unknown>;
    expect(r2.netCupsChange).toBe(22);
    expect(r2.rowsOfUnknownMeaning).toBe(1);
  });

  it("selects every record carrying the number — enabled or not — and nothing else", () => {
    const ms: TvMachine[] = [
      { ...machine(1), televendId: 11, caption: "Mall Beta-393- Cashless 1-DXB" },
      { ...machine(2, false), televendId: 10, caption: "Hall back-393-aed15-card only-SHJ" },
      { ...machine(3), televendId: 12, caption: "Tower-1393-DXB" },
      { ...machine(4), televendId: 13, caption: "Metro 101-543-DXB" },
    ];
    expect(recordsForAsset(ms, 393)).toEqual([
      { televendId: 11, caption: "Mall Beta-393- Cashless 1-DXB", enabled: true },
      { televendId: 10, caption: "Hall back-393-aed15-card only-SHJ", enabled: false },
    ]);
    expect(recordsForAsset(ms, 7931)).toEqual([]); // a typo finds nothing — the tool then says so
  });
});
