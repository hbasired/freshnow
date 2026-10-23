import { HOSTS } from "../allowlist.js";
import { TelevendClient } from "../client.js";
import {
  eventsPage,
  machinesPage,
  refillDetails,
  vendAggregates,
  vendsPage,
} from "../schemas.js";
import {
  REFILL_FILL_TYPE,
  REFILL_SOURCE,
  type DateRange,
  type TelevendSource,
  type TvEvent,
  type TvMachine,
  type TvRefill,
  type TvVend,
  type VendTotals,
} from "./types.js";
import type { z } from "zod";

/**
 * Bridge transport: the same read endpoints Televend's own web app calls, signed in as a web
 * user. Chosen by the user (2026-10-15) until Televend issues an official read-only API client.
 *
 * Every loop here is bounded (CLAUDE.md rule 4): pages are capped, row counts are capped, and a
 * result that hit a cap says so (`complete: false`) instead of passing for the whole picture.
 */

const PAGE = 100;
const MAX_MACHINE_PAGES = 20; // 2,000 machines — FreshNow has 221 records
const DEFAULT_MAX_ROWS = 5_000;
const ROW_CEILING = 50_000; // one call never pulls more than this, whatever the caller asks
/** Requests one windowed read may make (≈ 3,200 events/day needs ≈ 40–70 at 100 per slice). */
const MAX_REQUESTS_PER_READ = 600;
/** A slice is never split below one second (Televend timestamps are whole seconds). */
const MIN_SLICE_MS = 1_000;

/** Asia/Dubai is UTC+4 all year (the UAE has no daylight saving), so the offset is constant. */
export function dubaiIso(d: Date): string {
  const shifted = new Date(d.getTime() + 4 * 3_600_000);
  return `${shifted.toISOString().slice(0, 19)}+04:00`;
}

/** The business day `YYYY-MM-DD` as a [from, to) range in Asia/Dubai. */
export function dubaiDay(day: string): DateRange {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`not a date: ${day}`);
  const from = new Date(`${day}T00:00:00+04:00`);
  if (Number.isNaN(from.getTime())) throw new Error(`not a date: ${day}`);
  return { from, to: new Date(from.getTime() + 86_400_000) };
}

const date = (s: string | null | undefined): Date | null => {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
};

export function normaliseMachine(m: z.infer<typeof machinesPage>["content"][number]): TvMachine {
  return {
    televendId: m.id,
    caption: m.caption,
    enabled: m.enabled,
    pid: m.pid ?? null,
    externalId: m.external_id ?? null,
    locationId: m.location?.id ?? null,
    locationCaption: m.location?.caption ?? null,
    city: m.location?.city ?? null,
    regionCaption: m.region?.caption ?? null,
    machineTypeCaption: m.machine_type?.caption ?? null,
    stockTracking: m.stock_tracking ?? null,
    lastVendAt: date(m.last_vend_utc),
    lastRefillAt: date(m.last_refill_utc),
    stockPercent: m.stock ?? null,
    lastStatus: m.last_status ?? null,
    connectionStatus: m.connection_details?.connection_status ?? null,
    signalStrength: m.connection_details?.signal_strength ?? null,
    raw: m,
  };
}

export function normaliseVend(v: z.infer<typeof vendsPage>["content"][number]): TvVend {
  return {
    televendId: v.vend_id,
    machineTelevendId: v.machine_id,
    machineCaption: v.machine_caption ?? null,
    at: new Date(v.timestamp),
    product: v.product_caption ?? null,
    paymentType: v.payment_type,
    paymentTypeCaption: v.payment_type_caption ?? null,
    value: v.value ?? null,
    column: v.column_index ?? null,
    quantity: v.quantity,
    priceList: v.price_list_number ?? null,
    raw: v,
  };
}

export function normaliseEvent(e: z.infer<typeof eventsPage>["content"][number]): TvEvent {
  return {
    televendId: e.id,
    machineTelevendId: e.machine.id,
    machineCaption: e.machine.caption ?? null,
    level: e.level,
    type: e.type,
    source: e.source,
    name: e.name ?? null,
    description: e.description ?? null,
    startedAt: new Date(e.start_time),
    resolvedAt: date(e.resolved_time),
    counter: e.counter ?? null,
    raw: e,
  };
}

export function normaliseRefill(
  machine: { televendId: number; caption: string | null },
  l: z.infer<typeof refillDetails>["content"][number]["logs"][number],
): TvRefill {
  const name = [l.first_name, l.last_name].filter((x): x is string => Boolean(x && x.trim())).join(" ").trim();
  return {
    machineTelevendId: machine.televendId,
    machineCaption: machine.caption,
    at: new Date(l.timestamp),
    filledBy: name || null,
    role: l.role_name ?? null,
    column: l.column_index ?? null,
    product: l.caption ?? null,
    action: REFILL_FILL_TYPE[l.fill_type] ?? "unknown",
    quantityChange: l.quantity_change,
    quantityAfter: l.quantity ?? null,
    capacity: l.max_quantity ?? null,
    origin: (l.source !== null && l.source !== undefined && REFILL_SOURCE[l.source]) || "unknown",
    raw: l,
  };
}

export class BridgeSource implements TelevendSource {
  readonly transport = "bridge" as const;
  private readonly T: string;

  constructor(
    private readonly client: TelevendClient,
    private readonly ids: { tenantId: number; companyId: number },
  ) {
    this.T = `tenants/${ids.tenantId}/companies/${ids.companyId}`;
  }

  private url(path: string, query?: Parameters<typeof TelevendClient.url>[2]): string {
    return TelevendClient.url(HOSTS.cloudApi, path, query);
  }

  async machines(): Promise<TvMachine[]> {
    const out: TvMachine[] = [];
    for (let page = 1; page <= MAX_MACHINE_PAGES; page++) {
      const r = await this.client.get(this.url(`/machinist/api/v1/${this.T}/machines`, { page, page_size: PAGE }), machinesPage);
      out.push(...r.content.map(normaliseMachine));
      if (!r.meta.has_next_page) return out;
    }
    throw new Error(`more than ${MAX_MACHINE_PAGES * PAGE} machines — raise MAX_MACHINE_PAGES deliberately`);
  }

  /**
   * Reads a time window WITHOUT paging across it.
   *
   * GOTCHA (measured 2026-10-15): Televend's offset paging is not stable on large windows.
   * Reading the same 23-hour event window twice, the second read returned 95 duplicate rows
   * and silently skipped 95 others (incl. 2 cash collections) — rows move between pages while
   * the list is read. A 3-hour window (2 pages) read identically twice.
   *
   * So a window is asked for as one page; if Televend says there is a next page, the window is
   * split in half and each half asked again, until every slice fits in one page. Rows are
   * de-duplicated by Televend id (slice edges are inclusive) and kept only inside [from, to). Bounded: at most
   * MAX_REQUESTS_PER_READ requests, and a one-second slice that still overflows is paged as a
   * last resort and the result marked incomplete.
   */
  private async sliced<R>(
    path: string,
    schema: z.ZodType<{ meta: { has_next_page?: boolean | undefined }; content: R[] }, z.ZodTypeDef, unknown>,
    idOf: (r: R) => number,
    timeOf: (r: R) => number,
    range: DateRange,
    cap: number,
  ): Promise<{ rows: R[]; complete: boolean }> {
    const seen = new Map<number, R>();
    let complete = true;
    let requests = 0;
    const stack: DateRange[] = [range];
    const ask = async (s: DateRange, page: number) => {
      requests++;
      return this.client.get(
        this.url(path, { page, page_size: PAGE, from_timestamp: dubaiIso(s.from), to_timestamp: dubaiIso(s.to) }),
        schema,
      );
    };
    while (stack.length > 0) {
      if (requests >= MAX_REQUESTS_PER_READ || seen.size >= cap) {
        complete = false;
        break;
      }
      const s = stack.pop() as DateRange;
      const first = await ask(s, 1);
      if (!first.meta.has_next_page) {
        for (const x of first.content) seen.set(idOf(x), x);
        continue;
      }
      const span = s.to.getTime() - s.from.getTime();
      if (span > MIN_SLICE_MS) {
        // Whole seconds: Televend's timestamps are second-resolution.
        const mid = new Date(s.from.getTime() + Math.floor(span / 2 / 1000) * 1000);
        stack.push({ from: mid, to: s.to }, { from: s.from, to: mid });
        continue;
      }
      // More than a page of rows inside one second — not seen in practice. Page it, keep what
      // arrives, and say the result may be incomplete.
      for (const x of first.content) seen.set(idOf(x), x);
      for (let page = 2; page <= 20 && requests < MAX_REQUESTS_PER_READ; page++) {
        const r = await ask(s, page);
        for (const x of r.content) seen.set(idOf(x), x);
        if (!r.meta.has_next_page) break;
      }
      complete = false;
    }
    // The window is half-open, [from, to), like a business day. Televend's edges are inclusive, so a sale stamped exactly at
    // midnight also came back in the day before: one more than Televend's own count, and that day never checked complete
    // (11 Jul and 15 Sep, found 20 Oct). The row is read again in the window that starts at it.
    const lo = range.from.getTime();
    const hi = range.to.getTime();
    const rows = [...seen.values()].filter((x) => timeOf(x) >= lo && timeOf(x) < hi).sort((a, b) => timeOf(a) - timeOf(b));
    return { rows: rows.slice(0, cap), complete: complete && rows.length <= cap };
  }

  async vends(range: DateRange, opts: { maxRows?: number } = {}): Promise<{ rows: TvVend[]; complete: boolean }> {
    const cap = Math.min(opts.maxRows ?? DEFAULT_MAX_ROWS, ROW_CEILING);
    const r = await this.sliced(
      `/machinist/api/v1/${this.T}/vends`,
      vendsPage,
      (v) => v.vend_id,
      (v) => Date.parse(v.timestamp),
      range,
      cap,
    );
    return { rows: r.rows.map(normaliseVend), complete: r.complete };
  }

  /**
   * Televend's own vend count for whole business days.
   *
   * GOTCHA (measured 2026-10-15): the aggregates endpoint — and the `number_of_items` count on
   * the vends list — ignore the time of day and INCLUDE the end date. "12 Oct 06:00–07:00"
   * returns all 1,570 vends of 12 Oct; "12 Oct 00:00 → 13 Oct 00:00" returns 3,182 (12 + 13 Oct).
   * So only whole days are accepted, and the end is sent as the last second of the last day.
   * The vends LIST itself respects timestamps exactly (1,570 rows for 12 Oct).
   */
  async vendTotals(range: DateRange): Promise<VendTotals> {
    const dayMs = 86_400_000;
    const offset = 4 * 3_600_000;
    const wholeDays =
      (range.from.getTime() + offset) % dayMs === 0 && (range.to.getTime() + offset) % dayMs === 0 && range.to > range.from;
    if (!wholeDays) throw new Error("vendTotals counts whole Asia/Dubai days only (Televend ignores the time of day)");
    const r = await this.client.get(
      this.url(`/machinist/api/v1/${this.T}/vends/aggregates`, {
        from_timestamp: dubaiIso(range.from),
        to_timestamp: dubaiIso(new Date(range.to.getTime() - 1_000)),
      }),
      vendAggregates,
    );
    return {
      from: range.from,
      to: range.to,
      vends: r.number_of_sale_vends,
      quantity: r.total_quantity,
      revenue: r.total_revenue,
    };
  }

  async events(range: DateRange, opts: { maxRows?: number } = {}): Promise<{ rows: TvEvent[]; complete: boolean }> {
    const cap = Math.min(opts.maxRows ?? DEFAULT_MAX_ROWS, ROW_CEILING);
    const r = await this.sliced(
      `/machinist/api/v1/${this.T}/events`,
      eventsPage,
      (e) => e.id,
      (e) => Date.parse(e.start_time),
      range,
      cap,
    );
    return { rows: r.rows.map(normaliseEvent), complete: r.complete };
  }

  /**
   * Refills on one business day. Televend's refill log is per machine, so this is one request
   * per machine record — the sync asks only for machines whose `lastRefillAt` moved; a whole day
   * (no ids) asks EVERY record, enabled or not.
   *
   * GOTCHA (measured 2026-10-15, G160): a machine moved to a new site gets a new Televend record
   * and the old one is disabled. The old record keeps its refill log — including the row of the
   * machine being emptied — but the machines list drops its `last_refill`, so nothing in the list
   * says which disabled record had refills on a given day. Asking enabled machines only lost a
   * moved machine's rows of 4 and 6 Oct.
   */
  async refills(day: string, machineTelevendIds?: readonly number[]): Promise<TvRefill[]> {
    const range = dubaiDay(day);
    const machines = await this.machines();
    const wanted = machineTelevendIds
      ? machines.filter((m) => m.televendId !== null && machineTelevendIds.includes(m.televendId))
      : machines;
    const out: TvRefill[] = [];
    for (const m of wanted) {
      if (m.televendId === null) continue;
      const r = await this.client.get(
        this.url(`/refillator/api/v1/refill-log-list/${m.televendId}/details`, { date: dubaiIso(range.from) }),
        refillDetails,
      );
      for (const group of r.content) {
        for (const log of group.logs) {
          const row = normaliseRefill({ televendId: m.televendId, caption: m.caption }, log);
          // The endpoint returned exactly the requested day in every probe; the filter keeps it
          // that way if Televend ever widens its window.
          if (row.at >= range.from && row.at < range.to) out.push(row);
        }
      }
    }
    return out.sort((a, b) => a.at.getTime() - b.at.getTime());
  }
}
