import { describe, expect, it } from "vitest";
import type { FetchLike, TokenProvider } from "../auth.js";
import { TelevendClient } from "../client.js";
import { BridgeSource, dubaiDay, dubaiIso } from "./bridge.js";

const token: TokenProvider = { latched: false, token: async () => "t", invalidate: () => {} };
const DAY = dubaiDay("2026-10-12");

/** `n` events spread over the day, plus a dense burst so some slices need splitting. */
function dataset(n: number) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const t = i < n - 150 ? DAY.from.getTime() + Math.floor((i / (n - 150)) * 86_000_000) : DAY.from.getTime() + 43_200_000 + (i % 150) * 2_000;
    rows.push({
      id: i + 1,
      level: 1,
      type: 2,
      source: 1,
      start_time: new Date(Math.floor(t / 1000) * 1000).toISOString(),
      counter: 1,
      description: "ORF_RST",
      machine: { id: 7, caption: "Mall Alpha-543-DXB" },
    });
  }
  return rows;
}

/**
 * A fake Televend whose OFFSET PAGING DRIFTS: page 2+ comes back shifted, duplicating some rows
 * and skipping others — what the real events list did on 2026-10-15. Window edges are inclusive
 * on both ends, the less convenient assumption.
 */
function driftingServer(rows: ReturnType<typeof dataset>) {
  let calls = 0;
  const fetch: FetchLike = async (url) => {
    calls++;
    const u = new URL(url);
    const from = Date.parse(u.searchParams.get("from_timestamp") ?? "");
    const to = Date.parse(u.searchParams.get("to_timestamp") ?? "");
    const page = Number(u.searchParams.get("page"));
    const size = Number(u.searchParams.get("page_size"));
    const inWindow = rows.filter((r) => Date.parse(r.start_time) >= from && Date.parse(r.start_time) <= to);
    const drift = page > 1 ? 7 : 0;
    const start = (page - 1) * size - drift;
    const content = inWindow.slice(Math.max(0, start), Math.max(0, start) + size);
    const body = { meta: { code: 200, page, page_size: size, has_next_page: page * size < inWindow.length, number_of_items: null }, content };
    return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  return { fetch, calls: () => calls };
}

describe("BridgeSource — windowed reads that survive Televend's paging drift", () => {
  it("returns every event exactly once, never paging across a big window", async () => {
    const rows = dataset(1_200);
    const server = driftingServer(rows);
    const client = new TelevendClient(token, { tenantId: 5, companyId: 3334, fetch: server.fetch, minIntervalMs: 0 });
    const src = new BridgeSource(client, { tenantId: 5, companyId: 3334 });
    const r = await src.events(DAY, { maxRows: 20_000 });
    expect(r.complete).toBe(true);
    expect(r.rows).toHaveLength(1_200);
    expect(new Set(r.rows.map((e) => e.televendId)).size).toBe(1_200);
    // Sorted by time, first to last.
    expect(r.rows[0]!.startedAt.getTime()).toBeLessThanOrEqual(r.rows.at(-1)!.startedAt.getTime());
    expect(server.calls()).toBeLessThan(200);
  });

  it("says incomplete when it hits its row cap instead of pretending", async () => {
    const server = driftingServer(dataset(600));
    const client = new TelevendClient(token, { tenantId: 5, companyId: 3334, fetch: server.fetch, minIntervalMs: 0 });
    const r = await new BridgeSource(client, { tenantId: 5, companyId: 3334 }).events(DAY, { maxRows: 100 });
    expect(r.complete).toBe(false);
    expect(r.rows.length).toBeLessThanOrEqual(100);
  });

  it("formats windows in Asia/Dubai with whole seconds", () => {
    expect(dubaiIso(new Date("2026-10-11T20:00:00Z"))).toBe("2026-10-12T00:00:00+04:00");
    expect(DAY.to.getTime() - DAY.from.getTime()).toBe(86_400_000);
    expect(() => dubaiDay("12.10.2026")).toThrow();
  });

  it("keeps a sale stamped exactly at midnight in the day it starts, never also in the day before", async () => {
    // Televend's edges are inclusive: on 15 Sep a 00:00:00 sale of 16 Sep came back in 15 Sep's read too — one more than
    // Televend's own count, so the day never checked complete (20 Oct).
    const sale = (id: number, at: Date) => ({ vend_id: id, machine_id: 7, timestamp: at.toISOString(), payment_type: 1, quantity: 1 });
    const next = dubaiDay("2026-10-13");
    const rows = [sale(1, DAY.from), sale(2, new Date(DAY.from.getTime() + 3_600_000)), sale(3, DAY.to), sale(4, new Date(DAY.to.getTime() + 60_000))];
    const fetch: FetchLike = async (url) => {
      const u = new URL(url);
      const from = Date.parse(u.searchParams.get("from_timestamp") ?? "");
      const to = Date.parse(u.searchParams.get("to_timestamp") ?? "");
      const content = rows.filter((r) => Date.parse(r.timestamp) >= from && Date.parse(r.timestamp) <= to);
      const body = { meta: { code: 200, page: 1, page_size: 100, has_next_page: false, number_of_items: null }, content };
      return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
    };
    const src = new BridgeSource(new TelevendClient(token, { tenantId: 5, companyId: 3334, fetch, minIntervalMs: 0 }), { tenantId: 5, companyId: 3334 });
    expect((await src.vends(DAY)).rows.map((v) => v.televendId)).toEqual([1, 2]);
    expect((await src.vends(next)).rows.map((v) => v.televendId)).toEqual([3, 4]);
  });

  it("refuses vend totals for anything but whole days (Televend ignores the time of day)", async () => {
    const client = new TelevendClient(token, {
      tenantId: 5,
      companyId: 3334,
      fetch: async () => ({ status: 200, headers: { get: () => null }, text: async () => "{}" }),
      minIntervalMs: 0,
    });
    const src = new BridgeSource(client, { tenantId: 5, companyId: 3334 });
    await expect(src.vendTotals({ from: new Date("2026-10-12T06:00:00+04:00"), to: new Date("2026-10-12T07:00:00+04:00") })).rejects.toThrow(
      /whole Asia\/Dubai days/,
    );
  });
});

describe("BridgeSource.refills — a whole day asks every machine record (G160)", () => {
  /**
   * A machine moved to a new site on 6 Oct: its old record (10) was emptied and disabled, kept its
   * refill log, and lost `last_refill` from the machines list; the new record (11) is enabled.
   */
  function refillServer() {
    const asked: number[] = [];
    const machines = [
      { id: 11, caption: "Mall Beta-393-DXB", enabled: true, last_refill_utc: "2026-10-06T18:54:30+00:00" },
      { id: 10, caption: "Hall back-393-SHJ", enabled: false, last_refill_utc: null },
    ];
    const logs: Record<number, unknown[]> = {
      10: [{ timestamp: "2026-10-06T11:10:39.120000+04:00", column_index: 32767, fill_type: 4, source: 3, quantity_change: 42, quantity: 0 }],
      11: [{ timestamp: "2026-10-06T22:54:30.500000+04:00", column_index: 511, fill_type: 1, source: 1, quantity_change: 64, quantity: 64 }],
    };
    const fetch: FetchLike = async (url) => {
      const id = /refill-log-list\/(\d+)\/details$/.exec(new URL(url).pathname)?.[1];
      if (id) asked.push(Number(id));
      const body = id
        ? { meta: { code: 200 }, content: [{ logs: logs[Number(id)] ?? [] }] }
        : { meta: { code: 200, has_next_page: false }, content: machines };
      return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
    };
    const client = new TelevendClient(token, { tenantId: 5, companyId: 3334, fetch, minIntervalMs: 0 });
    return { src: new BridgeSource(client, { tenantId: 5, companyId: 3334 }), asked };
  }

  it("reads disabled records too — their refill log outlives last_refill — and names the removal", async () => {
    const { src, asked } = refillServer();
    const rows = await src.refills("2026-10-06");
    expect(asked).toEqual([11, 10]);
    expect(rows.map((r) => [r.machineTelevendId, r.action, r.origin, r.quantityChange])).toEqual([
      [10, "removed", "televend", 42],
      [11, "corrected", "web_app", 64],
    ]);
  });

  it("asks only the named records when given ids (the 10-minute sync)", async () => {
    const { src, asked } = refillServer();
    expect(await src.refills("2026-10-06", [11])).toHaveLength(1);
    expect(asked).toEqual([11]);
  });
});
