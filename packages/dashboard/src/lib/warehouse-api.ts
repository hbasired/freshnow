import { ApiError, post, requestContext } from "./api";

/**
 * The warehouse documents' calls (TASK-086) — /dashboard/warehouse/* — and the shapes they return (core/warehouse.ts,
 * core/warehouse-reports.ts). Every write that creates something carries an id made here, so a tap sent twice creates once.
 */

export type OrderKind = "receipt" | "supplier_return";
export type OrderState = "draft" | "ready" | "done" | "cancelled";
export const RETURN_REASONS = ["quality", "wrong_item", "excess", "damaged_on_arrival", "expired", "other"] as const;
export type ReturnReason = (typeof RETURN_REASONS)[number];

export interface Supplier {
  id: string;
  name: string;
  code: string | null;
  leadDays: number | null;
  note: string | null;
  active: boolean;
  open: number;
  lastDelivery: string | null;
}

export interface OrderLine {
  itemId: string;
  name: string;
  unit: string;
  step: number;
  icon: string | null;
  expected: number;
  done: number | null;
  /** The note's kilograms, for everything expected. */
  expectedKg: number | null;
  /** Done: the note's kilograms for what came — what the scale is held to (8 of 10 cartons → 8/10). */
  expectedKgForDone: number | null;
  doneKg: number | null;
  variety: string | null;
  bestBefore: string | null;
  note: string | null;
  lot: string | null;
  returnable: number | null;
  available: number | null;
}

export interface OrderCard {
  id: string;
  kind: OrderKind;
  number: string;
  state: OrderState;
  supplier: { id: string; name: string; code: string | null };
  scheduledOn: string | null;
  priority: "normal" | "urgent";
  sourceRef: string | null;
  vehicle: string | null;
  reason: ReturnReason | null;
  note: string | null;
  createdBy: { id: string; name: string };
  createdAt: string;
  readyAt: string | null;
  doneBy: { id: string; name: string } | null;
  doneAt: string | null;
  cancelledAt: string | null;
  cancelNote: string | null;
  closedShort: boolean;
  stockDocId: string | null;
  stockDocState: string | null;
  backorderOf: { id: string; number: string } | null;
  returnOf: { id: string; number: string } | null;
  backorders: { id: string; number: string; state: OrderState }[];
  returns: { id: string; number: string; state: OrderState }[];
  lines: OrderLine[];
  totals: { lines: number; expectedKg: number | null; doneKg: number | null };
  short: boolean;
  overdue: boolean;
  may: { edit: boolean; ready: boolean; draft: boolean; validate: boolean; cancel: boolean; return: boolean };
}

export interface OrderRef {
  id: string;
  number: string;
  state: OrderState;
  replay: boolean;
}

export interface ShortLine {
  itemId: string;
  name: string;
  unit: string;
  expected: number;
  done: number;
  expectedKg: number | null;
  expectedKgForDone: number | null;
  doneKg: number | null;
  weightShort: boolean;
}

export interface Validated extends OrderRef {
  stockDocId: string;
  backorder: OrderRef | null;
  short: ShortLine[];
}

export interface OrderLineIn {
  itemId: string;
  qty: number;
  kg?: string | null;
  variety?: string | null;
  bestBefore?: string | null;
  note?: string | null;
}

export interface ItemRef {
  id: string;
  name: string;
  unit: string;
  step: number;
  icon: string | null;
}
export interface PlaceRef {
  id: string;
  kind: string;
  name: string;
  employeeId: string | null;
}

export interface ReorderRule {
  id: string;
  item: ItemRef;
  place: PlaceRef;
  min: number;
  max: number;
  multiple: number;
  supplier: { id: string; name: string } | null;
  active: boolean;
}

export interface Suggestion {
  rule: ReorderRule;
  onHand: number;
  incoming: number;
  forecast: number;
  suggest: number;
  leadDays: number | null;
}

export interface StockAt {
  at: string;
  date: string | null;
  items: (ItemRef & { warehouse: number; withPeople: number; inTransit: number; total: number })[];
  people: { employeeId: string; name: string; items: { itemId: string; qty: number }[] }[];
}

export interface MoveRow {
  id: number;
  at: string;
  docId: string;
  kind: string;
  reason: string | null;
  step: string;
  item: ItemRef;
  from: PlaceRef;
  to: PlaceRef;
  qty: number;
  by: { id: string; name: string };
  supplier: string | null;
  order: { id: string; number: string } | null;
}

export interface MovesReport {
  rows: MoveRow[];
  totals: (ItemRef & { into: number; outOf: number })[];
  more: boolean;
  cursor: number | null;
}

export interface ItemTracking {
  item: ItemRef & { category: string; active: boolean };
  now: { place: PlaceRef; qty: number }[];
  lots: { code: string; supplier: string; receivedOn: string; bestBefore: string | null; variety: string | null; qty: number; kg: number | null; order: { id: string; number: string } }[];
  moves: MoveRow[];
  more: boolean;
}

export interface SupplierRow {
  supplier: { id: string; name: string; code: string | null };
  receipts: number;
  scheduled: number;
  onTime: number;
  lines: number;
  linesComplete: number;
  kgExpected: number | null;
  kgReceived: number | null;
  linesLight: number;
  returns: number;
  returnLines: number;
  open: number;
  overdue: number;
}

/**
 * A read that keeps the server's own words on ANY refusal — "Hand in your count first", "At most 366 days" — where the shared
 * `get` keeps them only for a 403.
 */
async function read<T>(path: string, params: Record<string, string>): Promise<T> {
  const ctx = requestContext(params);
  const res = await fetch(`${path}?${ctx.query}`, { headers: ctx.headers });
  if (!res.ok) {
    let why: { code?: string; message?: string } = {};
    try {
      why = ((await res.json()) as { error?: { code?: string; message?: string } }).error ?? {};
    } catch {
      // Not JSON: say the status.
    }
    throw new ApiError(res.status, why.message ?? `Request failed (${res.status})`, why.code ?? null);
  }
  return (await res.json()) as T;
}

const P = (viewer: string) => ({ viewer });
const q = (viewer: string, o: Record<string, string | number | null | undefined>): Record<string, string> => {
  const out: Record<string, string> = { viewer };
  for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined && v !== "") out[k] = String(v);
  return out;
};

export const wh = {
  suppliers: (viewer: string) => read<Supplier[]>("/dashboard/warehouse/suppliers", P(viewer)),
  saveSupplier: (viewer: string, s: { id?: string; name: string; code?: string | null; leadDays?: number | null; note?: string | null; active?: boolean }) => {
    const { id, ...body } = s;
    return id
      ? post<{ id: string; created: boolean }>(`/dashboard/warehouse/suppliers/${id}`, body, P(viewer), "PUT")
      : post<{ id: string; created: boolean }>("/dashboard/warehouse/suppliers", body, P(viewer));
  },
  orders: (viewer: string, f: { kind?: OrderKind; state?: OrderState | "open"; supplierId?: string; search?: string; cursor?: string | null; limit?: number } = {}) =>
    read<{ orders: OrderCard[]; more: boolean; cursor: string | null }>("/dashboard/warehouse/orders", q(viewer, f)),
  order: (viewer: string, id: string) => read<OrderCard>(`/dashboard/warehouse/orders/${id}`, P(viewer)),
  create: (
    viewer: string,
    body: {
      id: string;
      kind: OrderKind;
      supplierId: string;
      scheduledOn?: string | null;
      priority?: "normal" | "urgent";
      sourceRef?: string | null;
      vehicle?: string | null;
      note?: string | null;
      reason?: ReturnReason | null;
      lines: OrderLineIn[];
      ready?: boolean;
    },
  ) => post<OrderRef>("/dashboard/warehouse/orders", body, P(viewer)),
  update: (
    viewer: string,
    id: string,
    body: { scheduledOn?: string | null; priority?: "normal" | "urgent"; sourceRef?: string | null; vehicle?: string | null; note?: string | null; reason?: ReturnReason | null; lines?: OrderLineIn[] },
  ) => post<OrderRef>(`/dashboard/warehouse/orders/${id}`, body, P(viewer), "PUT"),
  ready: (viewer: string, id: string) => post<OrderRef>(`/dashboard/warehouse/orders/${id}/ready`, undefined, P(viewer)),
  draft: (viewer: string, id: string) => post<OrderRef>(`/dashboard/warehouse/orders/${id}/draft`, undefined, P(viewer)),
  cancel: (viewer: string, id: string, note?: string) => post<OrderRef>(`/dashboard/warehouse/orders/${id}/cancel`, note ? { note } : {}, P(viewer)),
  validate: (
    viewer: string,
    id: string,
    body: { stockDocId: string; lines: { itemId: string; qty: number; kg?: string | null }[]; backorder?: boolean; backorderId?: string | null; mediaIds?: string[] },
  ) => post<Validated>(`/dashboard/warehouse/orders/${id}/validate`, body, P(viewer)),
  startReturn: (viewer: string, receiptId: string, body: { id: string; reason: ReturnReason; note?: string | null; lines: OrderLineIn[] }) =>
    post<OrderRef>(`/dashboard/warehouse/orders/${receiptId}/return`, body, P(viewer)),

  rules: (viewer: string) => read<ReorderRule[]>("/dashboard/warehouse/rules", P(viewer)),
  saveRule: (
    viewer: string,
    r: { id?: string; itemId: string; place: { kind: "warehouse" } | { kind: "person"; employeeId: string }; min: number; max: number; multiple?: number | null; supplierId?: string | null; active?: boolean },
  ) => {
    const { id, ...body } = r;
    return id
      ? post<{ id: string; created: boolean }>(`/dashboard/warehouse/rules/${id}`, body, P(viewer), "PUT")
      : post<{ id: string; created: boolean }>("/dashboard/warehouse/rules", body, P(viewer));
  },
  suggestions: (viewer: string) => read<{ hidden: boolean; warehouse: Suggestion[]; people: Suggestion[] }>("/dashboard/warehouse/suggestions", P(viewer)),

  stockAt: (viewer: string, date: string | null) => read<StockAt>("/dashboard/warehouse/stock-at", q(viewer, { date })),
  moves: (viewer: string, f: { from: string; to: string; itemId?: string; employeeId?: string; kind?: string; cursor?: number | null; limit?: number }) =>
    read<MovesReport>("/dashboard/warehouse/moves", q(viewer, f)),
  tracking: (viewer: string, itemId: string, from: string, to: string) => read<ItemTracking>(`/dashboard/warehouse/items/${itemId}/tracking`, q(viewer, { from, to })),
  /** The rows, and the share lighter than its note a line may come before it counts as lighter (the server's own figure). */
  supplierReport: (viewer: string, from: string, to: string) => read<{ lightShare: number; rows: SupplierRow[] }>("/dashboard/warehouse/suppliers/report", q(viewer, { from, to })),

  /** The movements as a CSV file, saved by the browser — fetched with the sign-in, which a plain link would not carry. */
  downloadMoves: async (viewer: string, f: { from: string; to: string; itemId?: string; employeeId?: string; kind?: string }) => {
    const ctx = requestContext(q(viewer, f));
    const res = await fetch(`/dashboard/warehouse/moves.csv?${ctx.query}`, { headers: ctx.headers });
    if (!res.ok) {
      let why: { message?: string; code?: string } = {};
      try {
        why = ((await res.json()) as { error?: { message?: string; code?: string } }).error ?? {};
      } catch {
        // Not JSON.
      }
      throw new ApiError(res.status, why.message ?? `Request failed (${res.status})`, why.code ?? null);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `freshnow-moves-${f.from}-to-${f.to}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  },
};

export const STATE_WORDS: Readonly<Record<OrderState, string>> = { draft: "Draft", ready: "Expected", done: "Done", cancelled: "Cancelled" };
export const RETURN_STATE_WORDS: Readonly<Record<OrderState, string>> = { draft: "Draft", ready: "Ready to go back", done: "Sent back", cancelled: "Cancelled" };
export const RETURN_REASON_WORDS: Readonly<Record<ReturnReason, string>> = {
  quality: "Bad quality",
  wrong_item: "Wrong item",
  excess: "More than ordered",
  damaged_on_arrival: "Damaged on arrival",
  expired: "Expired",
  other: "Other",
};
/** "18.5 kg", "342.5 kg". */
export const kg = (n: number | null): string => (n === null ? "—" : `${n.toLocaleString("en-GB", { maximumFractionDigits: 3 })} kg`);
/** The Dubai day, YYYY-MM-DD, `offset` days from today. */
export function dubaiDay(offset = 0): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(new Date(Date.now() + offset * 86_400_000));
}
/** "Fri 24 Oct". */
export const dayWords = (d: string): string =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(new Date(`${d}T00:00:00Z`));
