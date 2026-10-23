import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import * as XLSX from "xlsx";
import type {
  DateRange,
  RefillAction,
  TelevendSource,
  TvEvent,
  TvMachine,
  TvRefill,
} from "./types.js";
import { dubaiDay } from "./bridge.js";
// The mirror's refill identity, so overlapping exports collapse exactly as the database does
// (a key without the column merged two genuine same-second refills, G159).
import { refillKey } from "../keys.js";

/**
 * File transport: the exports people already download from Televend's web portal, dropped into
 * a git-ignored folder (TELEVEND_IMPORT_DIR, default private-data/televend-imports/).
 *
 * Formats (profiled from real exports, 2026-10-15):
 *   event_list*.xls      legacy Excel. Rows 1–8 are filter metadata (PERIOD, TYPE, …), row 10
 *                        is the header: Type, Name, Definition, Start, Location, Machine, Source,
 *                        Resolved, Assigned, Machine mode. Dates "13.10.2026. 09:44" (local time).
 *   refill_log*.csv      Date "12.10.2026.", Time "04:51:42", Machine, Employee, Action
 *                        (Filled/Corrected/Removed), Quantity, Current quantity, Capacity, Source.
 *   VendingMachines*.xlsx  one sheet "Machines", 49 columns incl. Name, Region, Machine Type,
 *                        Pid, Enabled, Last vend, Last refill.
 *   *History_log*.xlsx / History log exports: Modification date, User name, Machine name.
 *
 * Exports carry NO Televend ids (only names), so file rows have `televendId: null` and are
 * matched to machines by caption downstream. Local times are Asia/Dubai (UTC+4, no DST) —
 * [believed]: the portal is set to the company timezone (ACL `timezone: Asia/Dubai`); the
 * TASK-055 verification compares them with the API's UTC timestamps.
 *
 * These are files from outside the system: size- and row-capped, parsed as data only.
 */

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_ROWS = 200_000;

export interface TvHistoryEntry {
  readonly at: Date;
  readonly userName: string | null;
  readonly machineCaption: string;
  readonly clientName: string | null;
}

type Cell = string | number | boolean | null;

function readRows(bytes: Uint8Array, opts: { csv?: boolean } = {}): Cell[][] {
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error(`export is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
  const wb = opts.csv
    ? XLSX.read(new TextDecoder("utf-8").decode(bytes), { type: "string", raw: true, cellDates: false })
    : XLSX.read(bytes, { type: "array", cellDates: false });
  const first = wb.SheetNames[0];
  const sheet = first ? wb.Sheets[first] : undefined;
  if (!sheet) return [];
  const rows = XLSX.utils.sheet_to_json<Cell[]>(sheet, { header: 1, raw: true, defval: null, blankrows: false });
  if (rows.length > MAX_ROWS) throw new Error(`export has more than ${MAX_ROWS} rows`);
  return rows;
}

const text = (c: Cell | undefined): string | null => {
  if (c === null || c === undefined) return null;
  const s = String(c).trim();
  return s === "" ? null : s;
};

const num = (c: Cell | undefined): number | null => {
  if (c === null || c === undefined || c === "") return null;
  const n = typeof c === "number" ? c : Number(String(c).trim());
  return Number.isFinite(n) ? n : null;
};

/** "13.10.2026." / "13.10.2026" + optional "09:44" or "04:51:42" → Date (Asia/Dubai local). */
export function parseDubaiLocal(dateText: string, timeText = "00:00:00"): Date | null {
  const d = /^(\d{1,2})\.(\d{1,2})\.(\d{4})\.?$/.exec(dateText.trim());
  const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(timeText.trim());
  if (!d || !t) return null;
  const [, dd, mm, yyyy] = d;
  const [, hh, mi, ss] = t;
  const iso = `${yyyy}-${mm!.padStart(2, "0")}-${dd!.padStart(2, "0")}T${hh!.padStart(2, "0")}:${mi}:${(ss ?? "00").padStart(2, "0")}+04:00`;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** "2026-10-12 19:54:08(.123)" (Excel text, local) → Date. */
function parseIsoLocal(c: Cell | undefined): Date | null {
  const s = text(c);
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(s);
  if (!m) return null;
  const at = new Date(`${m[1]}T${m[2]}+04:00`);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** A row as {column header: value} — kept as the record's `raw`. */
function rowRecord(col: Map<string, number>, row: Cell[]): Record<string, Cell> {
  return Object.fromEntries([...col.entries()].filter(([name]) => name !== "").map(([name, j]) => [name, row[j] ?? null]));
}

function headerIndex(rows: Cell[][], mustHave: readonly string[], scan = 30): { at: number; col: Map<string, number> } {
  for (let i = 0; i < Math.min(rows.length, scan); i++) {
    const names = (rows[i] ?? []).map((c) => text(c) ?? "");
    if (mustHave.every((h) => names.includes(h))) {
      return { at: i, col: new Map(names.map((n, j) => [n, j] as const)) };
    }
  }
  throw new Error(`not a recognised Televend export (missing columns ${mustHave.join(", ")})`);
}

export interface EventListExport {
  readonly period: string | null;
  readonly type: string | null;
  readonly rows: TvEvent[];
}

export function parseEventList(bytes: Uint8Array): EventListExport {
  const rows = readRows(bytes);
  const h = headerIndex(rows, ["Type", "Name", "Start", "Machine"]);
  // Metadata is only what sits ABOVE the header. Blank rows are dropped when reading, so the
  // header's position varies — reading a fixed number of rows once picked up the header's own
  // "Type | Name" as TYPE=Name (caught by files.test.ts).
  const meta = new Map<string, string>();
  for (const r of rows.slice(0, h.at)) {
    const k = text(r[0]);
    const v = text(r[1]);
    if (k && v) meta.set(k.toUpperCase(), v);
  }
  const c = (row: Cell[], name: string): Cell | undefined => {
    const j = h.col.get(name);
    return j === undefined ? undefined : row[j];
  };
  const out: TvEvent[] = [];
  for (const row of rows.slice(h.at + 1)) {
    const start = text(c(row, "Start"));
    const machine = text(c(row, "Machine"));
    if (!start || !machine) continue;
    const [sd, st] = start.split(/\s+/);
    const startedAt = sd ? parseDubaiLocal(sd, st ?? "00:00") : null;
    if (!startedAt) continue;
    const resolvedText = text(c(row, "Resolved"));
    let resolvedAt: Date | null = null;
    if (resolvedText && resolvedText.toLowerCase() !== "not resolved") {
      const [rd, rt] = resolvedText.split(/\s+/);
      resolvedAt = rd ? parseDubaiLocal(rd, rt ?? "00:00") : null;
    }
    out.push({
      televendId: null,
      machineTelevendId: null,
      machineCaption: machine,
      level: null,
      type: text(c(row, "Type")),
      source: text(c(row, "Source")),
      name: text(c(row, "Name")),
      description: text(c(row, "Definition")),
      startedAt,
      resolvedAt,
      counter: null,
      raw: rowRecord(h.col, row),
    });
  }
  return { period: meta.get("PERIOD") ?? null, type: meta.get("TYPE") ?? null, rows: out };
}

const ACTIONS: Readonly<Record<string, RefillAction>> = { filled: "filled", corrected: "corrected", removed: "removed" };
const ORIGINS: Readonly<Record<string, TvRefill["origin"]>> = {
  "mobile app": "mobile_app",
  "web app": "web_app",
  televend: "televend",
};

export function parseRefillLog(bytes: Uint8Array): TvRefill[] {
  const rows = readRows(bytes, { csv: true });
  const h = headerIndex(rows, ["Date", "Time", "Machine", "Employee", "Action", "Quantity"], 3);
  const c = (row: Cell[], name: string): Cell | undefined => {
    const j = h.col.get(name);
    return j === undefined ? undefined : row[j];
  };
  const out: TvRefill[] = [];
  for (const row of rows.slice(h.at + 1)) {
    const d = text(c(row, "Date"));
    const t = text(c(row, "Time"));
    const machine = text(c(row, "Machine"));
    const qty = num(c(row, "Quantity"));
    if (!d || !t || !machine || qty === null) continue;
    const at = parseDubaiLocal(d, t);
    if (!at) continue;
    out.push({
      machineTelevendId: null,
      machineCaption: machine,
      at,
      filledBy: text(c(row, "Employee")),
      role: null,
      column: num(c(row, "Column")),
      product: text(c(row, "Product")),
      action: ACTIONS[(text(c(row, "Action")) ?? "").toLowerCase()] ?? "unknown",
      quantityChange: qty,
      quantityAfter: num(c(row, "Current quantity")),
      capacity: num(c(row, "Capacity")),
      origin: ORIGINS[(text(c(row, "Source")) ?? "").toLowerCase()] ?? "unknown",
      raw: rowRecord(h.col, row),
    });
  }
  return out;
}

export function parseMachineList(bytes: Uint8Array): TvMachine[] {
  const rows = readRows(bytes);
  const h = headerIndex(rows, ["Name", "Enabled", "Region"], 3);
  const c = (row: Cell[], name: string): Cell | undefined => {
    const j = h.col.get(name);
    return j === undefined ? undefined : row[j];
  };
  const out: TvMachine[] = [];
  for (const row of rows.slice(h.at + 1)) {
    const caption = text(c(row, "Name"));
    if (!caption) continue;
    const enabled = c(row, "Enabled");
    out.push({
      televendId: null,
      caption,
      enabled: enabled === true || String(enabled).toLowerCase() === "true",
      pid: text(c(row, "Pid")),
      externalId: text(c(row, "Machine external ID")),
      locationId: null,
      locationCaption: text(c(row, "Location")),
      city: null,
      regionCaption: text(c(row, "Region")),
      machineTypeCaption: text(c(row, "Machine Type")),
      stockTracking: c(row, "Uses stock tracking") === null ? null : String(c(row, "Uses stock tracking")).toLowerCase() === "true",
      lastVendAt: parseIsoLocal(c(row, "Last vend")),
      lastRefillAt: parseIsoLocal(c(row, "Last refill")),
      stockPercent: null,
      lastStatus: null,
      connectionStatus: null,
      signalStrength: null,
      raw: rowRecord(h.col, row),
    });
  }
  return out;
}

export function parseHistoryLog(bytes: Uint8Array): TvHistoryEntry[] {
  const rows = readRows(bytes);
  const h = headerIndex(rows, ["Modification date", "Machine name"], 3);
  const c = (row: Cell[], name: string): Cell | undefined => {
    const j = h.col.get(name);
    return j === undefined ? undefined : row[j];
  };
  const out: TvHistoryEntry[] = [];
  for (const row of rows.slice(h.at + 1)) {
    const at = parseIsoLocal(c(row, "Modification date"));
    const machine = text(c(row, "Machine name"));
    if (!at || !machine) continue;
    out.push({ at, userName: text(c(row, "User name")), machineCaption: machine, clientName: text(c(row, "Client name")) });
  }
  return out;
}

const eventKey = (e: TvEvent): string => `${e.machineCaption}|${e.name}|${e.startedAt.toISOString()}`;

/** Reads every recognised export in a folder. Overlapping exports are de-duplicated. */
export class FileSource implements TelevendSource {
  readonly transport = "files" as const;

  constructor(private readonly dir: string) {}

  private files(pattern: RegExp): string[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    return names
      .filter((n) => pattern.test(n))
      .map((n) => join(this.dir, n))
      .filter((p) => statSync(p).isFile())
      .sort();
  }

  async machines(): Promise<TvMachine[]> {
    // The newest machine list wins: it is a snapshot, not a log.
    const latest = this.files(/^VendingMachines.*\.xlsx$/i)
      .map((p) => ({ p, t: statSync(p).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0];
    return latest ? parseMachineList(readFileSync(latest.p)) : [];
  }

  async vends(): Promise<null> {
    return null; // no vends export format profiled yet
  }

  async vendTotals(): Promise<null> {
    return null;
  }

  async events(range: DateRange): Promise<{ rows: TvEvent[]; complete: boolean }> {
    const seen = new Map<string, TvEvent>();
    for (const p of this.files(/^event_list.*\.xls$/i)) {
      for (const e of parseEventList(readFileSync(p)).rows) seen.set(eventKey(e), e);
    }
    const rows = [...seen.values()].filter((e) => e.startedAt >= range.from && e.startedAt < range.to);
    // "complete" cannot be known from files: an export covers whatever period someone chose.
    return { rows, complete: false };
  }

  async refills(day: string): Promise<TvRefill[]> {
    const range = dubaiDay(day);
    const seen = new Map<string, TvRefill>();
    for (const p of this.files(/^refill_log.*\.csv$/i)) {
      for (const r of parseRefillLog(readFileSync(p))) seen.set(refillKey(r), r);
    }
    return [...seen.values()].filter((r) => r.at >= range.from && r.at < range.to).sort((a, b) => a.at.getTime() - b.at.getTime());
  }

  /** For reports: which export files were read. */
  list(): string[] {
    return [
      ...this.files(/^event_list.*\.xls$/i),
      ...this.files(/^refill_log.*\.csv$/i),
      ...this.files(/^VendingMachines.*\.xlsx$/i),
    ].map((p) => basename(p));
  }
}
