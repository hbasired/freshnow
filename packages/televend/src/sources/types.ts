/**
 * The connector's own vocabulary — what every transport (bridge, official API, export files)
 * normalises Televend's records into. The pipeline (TASK-056), the MCP server and the probes
 * only ever see these types, so swapping the bridge for the official API changes nothing
 * downstream.
 *
 * Personal data: refills carry the filler's name (Televend shows who filled a machine). It is
 * needed to match Televend's records to FreshNow employees, so it is kept — but only here and
 * in the mirror tables, never in a log line, a prompt or an MCP summary by default.
 */

export type Transport = "bridge" | "official" | "files";

export interface TvMachine {
  readonly televendId: number | null;
  readonly caption: string;
  readonly enabled: boolean;
  readonly pid: string | null;
  readonly externalId: string | null;
  readonly locationId: number | null;
  readonly locationCaption: string | null;
  readonly city: string | null;
  readonly regionCaption: string | null;
  readonly machineTypeCaption: string | null;
  readonly stockTracking: boolean | null;
  readonly lastVendAt: Date | null;
  readonly lastRefillAt: Date | null;
  /** Televend's stock level, percent of capacity (0–100). */
  readonly stockPercent: number | null;
  readonly lastStatus: number | null;
  readonly connectionStatus: number | null;
  readonly signalStrength: number | null;
  /** Televend's own record, as received — kept so a normalisation can be replayed. */
  readonly raw?: unknown;
}

export interface TvVend {
  readonly televendId: number;
  readonly machineTelevendId: number;
  readonly machineCaption: string | null;
  readonly at: Date;
  readonly product: string | null;
  readonly paymentType: number;
  readonly paymentTypeCaption: string | null;
  /** AED. null when the account lacks Televend's vend-revenue permission. */
  readonly value: number | null;
  readonly column: number | null;
  readonly quantity: number;
  readonly priceList: number | null;
  /** Televend's own record, as received — kept so a normalisation can be replayed. */
  readonly raw?: unknown;
}

export interface VendTotals {
  readonly from: Date;
  readonly to: Date;
  readonly vends: number;
  readonly quantity: number;
  /** AED; null without the vend-revenue permission. */
  readonly revenue: number | null;
}

export interface TvEvent {
  readonly televendId: number | null;
  readonly machineTelevendId: number | null;
  readonly machineCaption: string | null;
  /** Televend's numeric level/type/source codes, kept as-is (meanings in EVENT_CODES). */
  readonly level: number | null;
  readonly type: string | number | null;
  readonly source: number | string | null;
  readonly name: string | null;
  readonly description: string | null;
  readonly startedAt: Date;
  readonly resolvedAt: Date | null;
  readonly counter: number | null;
  /** Televend's own record, as received — kept so a normalisation can be replayed. */
  readonly raw?: unknown;
}

export type RefillAction = "filled" | "corrected" | "removed" | "unknown";

export interface TvRefill {
  readonly machineTelevendId: number | null;
  readonly machineCaption: string | null;
  readonly at: Date;
  /** "First Last" as Televend shows it — personal data, used only to map to an employee. */
  readonly filledBy: string | null;
  readonly role: string | null;
  readonly column: number | null;
  readonly product: string | null;
  readonly action: RefillAction;
  /**
   * Televend's quantity, as given. For "filled" and "corrected": cups added (negative for a
   * downward correction). For "removed": the number of cups TAKEN OUT, as a positive number (the
   * export's "Removed, 42, 0 left"). Never sum it across actions — use `refillCupsDelta`.
   */
  readonly quantityChange: number;
  readonly quantityAfter: number | null;
  readonly capacity: number | null;
  readonly origin: "mobile_app" | "web_app" | "televend" | "unknown";
  /** Televend's own record, as received — kept so a normalisation can be replayed. */
  readonly raw?: unknown;
}

/**
 * Code meanings, each with how it was established. Only codes seen in real data are mapped;
 * anything else stays numeric and shows as "unknown" rather than being guessed.
 */
export const REFILL_FILL_TYPE: Readonly<Record<number, RefillAction>> = {
  // 2026-10-15: Emirates Towers-315 on 28 Sep — fill_type 0 rows are the CSV's "Filled"
  // (Filler, mobile app), fill_type 1 rows are its "Corrected" (CompanyManager, web app).
  0: "filled",
  1: "corrected",
  // 2026-10-15: Expo-544 on 8 Oct — the API's fill_type 4 / source 3 row (30 cups, 0 left) is the
  // CSV's "Removed" / "Televend" row. Codes 2 and 3 have not been seen; they stay "unknown".
  4: "removed",
};

/**
 * The change in cups a refill row made to its machine: a removal counts against it. Null for a row
 * whose code has no known meaning yet — its direction cannot be told, so it is never guessed.
 */
export function refillCupsDelta(r: Pick<TvRefill, "action" | "quantityChange">): number | null {
  if (r.action === "removed") return -r.quantityChange;
  if (r.action === "unknown") return null;
  return r.quantityChange;
}

export const REFILL_SOURCE: Readonly<Record<number, TvRefill["origin"]>> = {
  // Same evidence: source 2 = CSV "Mobile app", source 1 = CSV "Web app", source 3 = CSV "Televend".
  1: "web_app",
  2: "mobile_app",
  3: "televend",
};

/**
 * Event levels. [verified] 2026-10-15 by `pnpm televend:verify`: every row of the portal's
 * alarm exports matched a live event of level 3 (65/65 on 12 Oct, 78/78 on 5 Oct) and every
 * warning row a level-2 event (9/9 on 5 Oct). Level 1 holds everything else the export never
 * shows — machine info codes (ORF_*), "Power OFF", cash-collected notices — [believed] "info".
 */
export const EVENT_LEVEL: Readonly<Record<number, "alarm" | "warning" | "info">> = {
  3: "alarm",
  2: "warning",
  1: "info",
};

/** Event description that marks a cash collection at the machine (seen 2026-10-15, level 1, type 2). */
export const CASH_COLLECTED_DESCRIPTION = "Cash has been collected from the machine.";

export interface DateRange {
  readonly from: Date;
  readonly to: Date;
}

/**
 * What every transport offers. A transport that cannot provide something returns `null`
 * (e.g. the file transport has no vend totals; the bridge has no cash collections without the
 * cash-centre permission) — never an empty list that would read as "nothing happened".
 */
export interface TelevendSource {
  readonly transport: Transport;
  machines(): Promise<TvMachine[]>;
  vends(range: DateRange, opts?: { maxRows?: number }): Promise<{ rows: TvVend[]; complete: boolean } | null>;
  vendTotals(range: DateRange): Promise<VendTotals | null>;
  events(range: DateRange, opts?: { maxRows?: number }): Promise<{ rows: TvEvent[]; complete: boolean } | null>;
  /** Refills on one business day (Asia/Dubai), for the given machines (all when omitted). */
  refills(day: string, machineTelevendIds?: readonly number[]): Promise<TvRefill[] | null>;
}
