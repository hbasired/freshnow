import { get, post } from "./api";

/**
 * The Cash portal's calls (TASK-061) — /dashboard/cash/* — and the shapes they return. Amounts travel in
 * whole fils (100 fils = AED 1) and are shown in AED. Every entry carries an id made here, so a tap that
 * is sent twice posts once.
 */

export interface CashAbilities {
  hold: boolean;
  read: boolean;
  audit: boolean;
}

export interface CashEntry {
  id: string;
  kind: "collection" | "test_vend" | "expense" | "deposit" | "reversal";
  state: "posted" | "reversed";
  amountFils: number;
  machine: { assetNo: number | null; label: string } | null;
  expenseKind: "fuel" | "other" | null;
  litres: number | null;
  deposit: { txnNo: string | null; operator: string | null; cdsId: string | null; bagNo: string | null; denominations: Record<string, number> | null } | null;
  receiptAt: string | null;
  note: string | null;
  reason: string | null;
  reversesId: string | null;
  recordedAt: string;
  /** When the phone says it was made, if plausible, else recordedAt — shown beside it. */
  enteredAt: string;
  photos: string[];
  /** A collection: what Televend's own cash sales say the box held — null when Televend saw no collection near it. */
  televend: { collectedAt: string; previousAt: string | null; cashVends: number; expectedFils: number } | null;
  may: { undo: boolean };
}

export interface ShiftSummary {
  id: string;
  employee: { id: string; name: string };
  businessDate: string;
  state: "open" | "closed";
  startedAt: string;
  endedAt: string | null;
  vehicle: string | null;
  carriedInFils: number;
  collectedFils: number;
  testFils: number;
  fuelFils: number;
  otherFils: number;
  depositedFils: number;
  leftFils: number;
  collections: number;
  /** Null for anyone who does not see all cash — a driver never sees Televend's figure (D237). */
  differences: number | null;
  unmatched: number | null;
  withoutPhoto: number;
  audit: { outcome: "ok" | "query"; by: string; at: string; note: string | null } | null;
  /** While a question stands, only an answer given after it — null until they answer. */
  answer: { note: string; at: string } | null;
  may: { end: boolean; audit: boolean; answer: boolean };
}

export interface ShiftDetail extends ShiftSummary {
  entries: CashEntry[];
}

export interface CashHome {
  can: CashAbilities;
  heldFils: number;
  openShift: ShiftDetail | null;
  recentShifts: ShiftSummary[];
  /** Their shifts with a question standing, however old. */
  questions: ShiftSummary[];
  toCheck: ShiftSummary[];
}

export interface CashMachine {
  assetNo: number;
  label: string;
}

export interface CashPosted {
  docId: string;
  shiftId: string;
  replay: boolean;
}

const P = (viewer: string) => ({ viewer });

export const cash = {
  home: (viewer: string) => get<CashHome>("/dashboard/cash/home", P(viewer)),
  machines: (viewer: string) => get<CashMachine[]>("/dashboard/cash/machines", P(viewer)),
  shifts: (viewer: string, q: { from?: string; to?: string } = {}) => get<ShiftSummary[]>("/dashboard/cash/shifts", { ...q, viewer }),
  shift: (viewer: string, id: string) => get<ShiftDetail>(`/dashboard/cash/shifts/${id}`, P(viewer)),

  startShift: (viewer: string, body: { id: string; vehicle?: string }) => post<{ shiftId: string; opened: boolean }>("/dashboard/cash/shifts", body, P(viewer)),
  endShift: (viewer: string, body: { shiftId?: string } = {}) => post<{ shiftId: string; heldFils: number }>("/dashboard/cash/shifts/end", body, P(viewer)),
  audit: (viewer: string, id: string, body: { outcome: "ok" | "query"; note?: string }) =>
    post<{ outcome: string }>(`/dashboard/cash/shifts/${id}/audit`, body, P(viewer)),
  /** `questionAt`: when the question shown was asked — a newer one is refused, to be read first. */
  answer: (viewer: string, id: string, note: string, questionAt: string | null) =>
    post<{ shiftId: string }>(`/dashboard/cash/shifts/${id}/answer`, { note, questionAt }, P(viewer)),

  collect: (viewer: string, body: { id: string; machineAssetNo: number; amountFils: number; note?: string; mediaIds?: string[] }) =>
    post<CashPosted>("/dashboard/cash/collections", body, P(viewer)),
  testVend: (viewer: string, body: { id: string; machineAssetNo: number; amountFils: number; note?: string }) =>
    post<CashPosted>("/dashboard/cash/test-vends", body, P(viewer)),
  expense: (viewer: string, body: { id: string; expenseKind: "fuel" | "other"; amountFils: number; litres?: number; note?: string; mediaIds?: string[] }) =>
    post<CashPosted>("/dashboard/cash/expenses", body, P(viewer)),
  deposit: (
    viewer: string,
    body: { id: string; amountFils: number; cdmTxnNo?: string; cdmOperator?: string; cdsId?: string; bagNo?: string; denominations?: Record<string, number>; note?: string; mediaIds?: string[] },
  ) => post<CashPosted>("/dashboard/cash/deposits", body, P(viewer)),
  reverse: (viewer: string, id: string, body: { id: string; reason: string; note?: string }) => post<CashPosted>(`/dashboard/cash/entries/${id}/reverse`, body, P(viewer)),
};

/** "AED 1,540", "AED 12.50" — how the receipts and the WhatsApp lists write it. */
export function aed(fils: number): string {
  const n = fils / 100;
  return `AED ${n.toLocaleString("en-GB", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/** What a person typed in AED ("1540", "12.5", "12,50") as whole fils — or null when it is not an amount. */
export function filsOf(text: string): number | null {
  const t = text.trim().replace(",", ".");
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

/** AED notes, as the cash-deposit machine's receipt lists them. */
export const AED_NOTES = [1000, 500, 200, 100, 50, 20, 10, 5] as const;

export const CASH_REVERSE_WORDS: Record<string, string> = {
  entered_by_mistake: "Entered by mistake",
  wrong_amount: "Wrong amount",
  wrong_machine: "Wrong machine",
  duplicate: "Entered twice",
  other: "Something else",
};

export const ENTRY_WORDS: Record<CashEntry["kind"], { icon: string; label: string }> = {
  collection: { icon: "🏧", label: "Collected" },
  test_vend: { icon: "🔟", label: "Test note" },
  expense: { icon: "⛽", label: "Spent" },
  deposit: { icon: "🏦", label: "Deposited" },
  reversal: { icon: "↩️", label: "Undone" },
};
