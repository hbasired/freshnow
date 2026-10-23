import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import {
  FileSource,
  parseDubaiLocal,
  parseEventList,
  parseHistoryLog,
  parseMachineList,
  parseRefillLog,
} from "./files.js";

/**
 * Synthetic exports with the EXACT layout of the real ones (profiled 2026-10-15) — built in
 * memory, so no real machine, person or sale is committed to this public repository.
 */
function book(rows: unknown[][], bookType: XLSX.BookType, sheet = "Sheet1"): Uint8Array {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheet);
  return new Uint8Array(XLSX.write(wb, { bookType, type: "array" }) as ArrayBuffer);
}

const EVENT_HEADER = ["Type", "Name", "Definition", "Start", "Location", "Machine", "Source", "Resolved", "Assigned", "Machine mode"];
const eventListXls = (data: unknown[][]): Uint8Array =>
  book(
    [
      ["PERIOD", "07.10.2026. - 13.10.2026."],
      ["TYPE", "Alarm"],
      ["HIDDEN", "False"],
      ["KEYWORD", null],
      ["STATUS", "All"],
      ["ASSIGNED", "All"],
      ["SOURCE", "EventSource object"],
      ["NAME", "0"],
      [],
      EVENT_HEADER,
      ...data,
    ],
    "biff8",
    "event_list",
  );

const REFILL_HEADER =
  "Date,Time,Region,Location,Routing Cluster,Client,Machine Type,Machine,Machine External ID,Employee,Employee External ID,Route,Stock,Filling percentage,Column,Product,Product External ID,Product Barcode,Action,Quantity,Current quantity,Capacity,Fill qty,Empty,Source";

describe("parseDubaiLocal", () => {
  it("reads Televend's dotted dates as Asia/Dubai (UTC+4) local time", () => {
    expect(parseDubaiLocal("12.10.2026.", "04:51:42")?.toISOString()).toBe("2026-10-12T00:51:42.000Z");
    expect(parseDubaiLocal("13.10.2026.", "09:44")?.toISOString()).toBe("2026-10-13T05:44:00.000Z");
    expect(parseDubaiLocal("1.9.2026", "0:05")?.toISOString()).toBe("2026-08-31T20:05:00.000Z");
    expect(parseDubaiLocal("2026-10-12", "04:51")).toBeNull();
    expect(parseDubaiLocal("32.13.2026.", "99:00")).toBeNull();
  });
});

describe("event list export (legacy .xls)", () => {
  it("skips the filter rows, finds the header, and reads every alarm", () => {
    const parsed = parseEventList(
      eventListXls([
        ["Alarm", "No communication with Cashless 3", "No communication with Cashless 3", "13.10.2026. 09:44", "Metro", "Mall Alpha-543-DXB", "Machine", "Not resolved", null, "Live"],
        ["Alarm", "Cashless device", "A communication error has occurred", "13.10.2026. 09:12", "Mall", "Hall-403 -Card only- AED15-Cashless 1-SHJ", "Machine", "13.10.2026. 09:03", null, "Live"],
        [null, null, null, null, null, null, null, null, null, null],
      ]),
    );
    expect(parsed.period).toBe("07.10.2026. - 13.10.2026.");
    expect(parsed.type).toBe("Alarm");
    expect(parsed.rows).toHaveLength(2);
    const [a, b] = parsed.rows;
    expect(a?.machineCaption).toBe("Mall Alpha-543-DXB");
    expect(a?.startedAt.toISOString()).toBe("2026-10-13T05:44:00.000Z");
    expect(a?.resolvedAt).toBeNull();
    expect(a?.type).toBe("Alarm");
    expect(a?.source).toBe("Machine");
    expect(b?.resolvedAt?.toISOString()).toBe("2026-10-13T05:03:00.000Z");
    expect(a?.televendId).toBeNull(); // exports carry no Televend ids
  });

  it("refuses a file that is not an event export", () => {
    expect(() => parseEventList(book([["Something", "else"]], "biff8"))).toThrow(/not a recognised Televend export/);
  });
});

describe("refill log export (.csv)", () => {
  it("reads fills and corrections with their origin", () => {
    const csv = [
      REFILL_HEADER,
      "12.10.2026.,04:51:42,Metro,Metro,,,RTA Metro Stations,Mall Alpha-543-DXB,,Filler One,,,100,73.02,32767,Orange Juice New,,,Filled,46,63,63,63,0,Mobile app",
      "28.09.2026.,08:44:35,Metro,Metro,,,RTA Metro Stations,Mall Alpha-543-DXB,,Manager Two,,,71.43,,32767,Orange Juice New,,,Corrected,-18,45,63,63,0,Web app",
      "06.10.2026.,11:10:39,Events,Events,,,Exhibition Center,\"Hall, back-393-SHJ\",,Manager Two,,,DefaultValue,,32767,Orange Juices,,,Removed,42,0,63,63,0,Televend",
    ].join("\n");
    const rows = parseRefillLog(new TextEncoder().encode(csv));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      machineCaption: "Mall Alpha-543-DXB",
      action: "filled",
      quantityChange: 46,
      quantityAfter: 63,
      capacity: 63,
      origin: "mobile_app",
      filledBy: "Filler One",
    });
    expect(rows[0]?.at.toISOString()).toBe("2026-10-12T00:51:42.000Z");
    expect(rows[1]).toMatchObject({ action: "corrected", quantityChange: -18, origin: "web_app" });
    expect(rows[2]).toMatchObject({ action: "removed", origin: "televend", machineCaption: "Hall, back-393-SHJ" });
  });
});

describe("machine list export (.xlsx)", () => {
  it("reads names, enabled flags and last vend/refill as Dubai time", () => {
    const bytes = book(
      [
        ["Name", "Location", "Machine external ID", "Region", "Machine Type", "Pid", "Last vend", "Last refill", "Uses stock tracking", "Enabled"],
        ["Mall Alpha-543-DXB", "Metro", null, "Metro", "RTA Metro Stations", "2202635903", "2026-10-13 10:45:06", "2026-10-12 22:16:45.123", true, true],
        ["Old Site-401-D6", "Metro", null, "Metro", "Shopping Malls", null, "2023-01-28 21:16:05", null, false, false],
      ],
      "xlsx",
      "Machines",
    );
    const m = parseMachineList(bytes);
    expect(m).toHaveLength(2);
    expect(m[0]).toMatchObject({ caption: "Mall Alpha-543-DXB", enabled: true, pid: "2202635903", regionCaption: "Metro", stockTracking: true });
    expect(m[0]?.lastVendAt?.toISOString()).toBe("2026-10-13T06:45:06.000Z");
    expect(m[1]?.enabled).toBe(false);
    expect(m[1]?.lastRefillAt).toBeNull();
  });
});

describe("history log export (.xlsx)", () => {
  it("reads machine renames in order", () => {
    const h = parseHistoryLog(
      book(
        [
          ["Modification date", "User name", "Machine name", "Client name"],
          ["2026-10-06 19:41:17.595000", null, "Mall Alpha-543-DXB", "No Client"],
          ["2025-11-03 16:15:16.663000", "Manager Two", "Hall-392-2202648910", "No Client"],
        ],
        "xlsx",
      ),
    );
    expect(h).toHaveLength(2);
    expect(h[0]?.at.toISOString()).toBe("2026-10-06T15:41:17.000Z");
    expect(h[1]?.userName).toBe("Manager Two");
  });
});

describe("FileSource — a folder of exports", () => {
  const dir = mkdtempSync(join(tmpdir(), "televend-files-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("de-duplicates overlapping exports and filters by business day", async () => {
    const row = ["Alarm", "Cashless device", "x", "12.10.2026. 23:59", "Mall", "Mall Alpha-543-DXB", "Machine", "Not resolved", null, "Live"];
    const next = ["Alarm", "Cashless device", "x", "13.10.2026. 00:00", "Mall", "Mall Alpha-543-DXB", "Machine", "Not resolved", null, "Live"];
    writeFileSync(join(dir, "event_list (1).xls"), eventListXls([row, next]));
    writeFileSync(join(dir, "event_list (2).xls"), eventListXls([row])); // overlapping export
    writeFileSync(
      join(dir, "refill_log.csv"),
      [REFILL_HEADER, "12.10.2026.,23:30:00,M,M,,,T,Mall Alpha-543-DXB,,F,,,100,50,32767,P,,,Filled,30,63,63,63,0,Mobile app"].join("\n"),
    );
    writeFileSync(join(dir, "refill_log (1).csv"), [REFILL_HEADER, "12.10.2026.,23:30:00,M,M,,,T,Mall Alpha-543-DXB,,F,,,100,50,32767,P,,,Filled,30,63,63,63,0,Mobile app"].join("\n"));
    writeFileSync(join(dir, "notes.txt"), "ignored");

    const src = new FileSource(dir);
    const day = { from: new Date("2026-10-12T00:00:00+04:00"), to: new Date("2026-10-13T00:00:00+04:00") };
    const ev = await src.events(day);
    expect(ev.rows).toHaveLength(1); // 23:59 on the 12th, once; 00:00 on the 13th excluded
    expect(ev.complete).toBe(false); // a folder of exports never proves completeness
    expect(await src.refills("2026-10-12")).toHaveLength(1);
    expect(await src.refills("2026-10-13")).toHaveLength(0);
    expect(await src.vends()).toBeNull();
    expect(src.list()).toEqual(["event_list (1).xls", "event_list (2).xls", "refill_log (1).csv", "refill_log.csv"]);
  });

  it("keeps two same-second refills of one machine that differ only in column (G159)", async () => {
    const sub = mkdtempSync(join(dir, "columns-"));
    const a = "11.10.2026.,09:45:38,M,M,,,T,Mall Alpha-543-DXB,,F,,,100,50,511,Orange Juices,,,Filled,3,63,63,63,0,Mobile app";
    const b = "11.10.2026.,09:45:38,M,M,,,T,Mall Alpha-543-DXB,,F,,,100,50,767,Orange Beetroot Juice,,,Filled,3,63,63,63,0,Mobile app";
    writeFileSync(join(sub, "refill_log.csv"), [REFILL_HEADER, a, b].join("\n"));
    writeFileSync(join(sub, "refill_log (1).csv"), [REFILL_HEADER, b].join("\n")); // overlapping export
    const columns = (await new FileSource(sub).refills("2026-10-11")).map((r) => r.column);
    expect(columns).toHaveLength(2);
    expect(columns).toEqual(expect.arrayContaining([511, 767]));
  });

  it("returns nothing (not an error) for a missing folder", async () => {
    const src = new FileSource(join(dir, "does-not-exist"));
    expect(await src.machines()).toEqual([]);
    expect(src.list()).toEqual([]);
  });
});
