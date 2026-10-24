import { get, post, postForm } from "./api";

/**
 * The Inventory portal's calls (TASK-060) — /dashboard/inventory/* — and the shapes they return. Every
 * write carries an id made here (crypto.randomUUID), so a tap that is sent twice posts once.
 */

export interface InventoryAbilities {
  read: boolean;
  hold: boolean;
  move: boolean;
  approve: boolean;
}

export interface ItemNow {
  id: string;
  name: string;
  category: string;
  unit: string;
  step: number;
  icon: string | null;
  minLevel: number | null;
  countTolerance: number;
  active: boolean;
  /** Null while this viewer is counting the warehouse (InventoryHome.figuresHidden). */
  warehouse: number | null;
  withPeople: number;
  inTransit: number;
  low: boolean;
}

export interface Held {
  itemId: string;
  name: string;
  unit: string;
  step: number;
  icon: string | null;
  qty: number;
}

export interface PlaceRef {
  kind: string;
  id: string;
  name: string;
  employeeId: string | null;
}

export interface DocLine {
  itemId: string;
  name: string;
  unit: string;
  step: number;
  icon: string | null;
  qty: number;
  accepted?: number;
  pending?: number;
  back?: number;
  writtenOff?: number;
  variety?: string | null;
  cartonKg?: number | null;
}

export interface DocCard {
  id: string;
  kind: "receipt" | "handover" | "use" | "damage" | "count_adjustment" | "reversal" | "supplier_return";
  state: string;
  from: PlaceRef;
  to: PlaceRef;
  createdBy: { id: string; name: string };
  confirm: { side: "person" | "warehouse"; person: { id: string; name: string } | null } | null;
  answeredBy: { id: string; name: string } | null;
  answeredAt: string | null;
  answerReason: string | null;
  answerNote: string | null;
  settledBy: { id: string; name: string } | null;
  settledAt: string | null;
  reason: string | null;
  note: string | null;
  supplier: string | null;
  invoiceNo: string | null;
  machine: { assetNo: number | null; label: string } | null;
  reversesDocId: string | null;
  reversedByDocId: string | null;
  countSessionId: string | null;
  recordedAt: string;
  lines: DocLine[];
  photos: string[];
  may: { answer: boolean; cancel: boolean; settle: boolean; reverse: boolean };
}

export interface CountCard {
  id: string;
  kind: "opening" | "after_handout" | "closing" | "spot";
  state: "counting" | "recount" | "approval" | "closed" | "cancelled";
  startedBy: { id: string; name: string };
  startedAt: string;
  submittedAt: string | null;
  recountBy: { id: string; name: string } | null;
  differing: number | null;
  may: { submit: boolean; recount: boolean; waive: boolean; decide: boolean; cancel: boolean };
}

export interface InventoryHome {
  at: string;
  can: InventoryAbilities;
  items: ItemNow[];
  /** This viewer is counting the warehouse: its figures stay hidden until they hand it in. */
  figuresHidden: boolean;
  mine: Held[];
  waitingForMe: DocCard[];
  sentByMe: DocCard[];
  pending: DocCard[];
  disputes: DocCard[];
  counts: CountCard[];
  today: {
    date: string;
    opening: { at: string; by: string } | null;
    closing: { at: string; by: string } | null;
    lastCount: { at: string; kind: string; by: string } | null;
    handedOutSinceLastCount: { itemId: string; name: string; unit: string; icon: string | null; qty: number }[];
  } | null;
}

export interface Holder {
  id: string;
  name: string;
  role: string;
  holds: { itemId: string; qty: number }[];
  /** False for someone who left, or whose role no longer holds stock — offered only to take their stock back. */
  canReceive: boolean;
}

export interface CountItem {
  id: string;
  name: string;
  unit: string;
  step: number;
  icon: string | null;
}

export interface CountDetail extends CountCard {
  recountWaivedReason: string | null;
  decidedBy: { id: string; name: string } | null;
  decidedAt: string | null;
  decisionNote: string | null;
  adjustmentDocId: string | null;
  figuresShown: boolean;
  lines: {
    itemId: string;
    name: string;
    unit: string;
    icon: string | null;
    counted: number | null;
    expected: number | null;
    movedDuring: boolean | null;
    recount: number | null;
    recountExpected: number | null;
    recountMovedDuring: boolean | null;
    needsRecount: boolean;
    needsDecision: boolean | null;
    decision: string | null;
    decisionReason: string | null;
  }[];
}

export interface DayItemRow {
  itemId: string;
  name: string;
  unit: string;
  icon: string | null;
  opening: number;
  received: number;
  givenOut: number;
  cameBack: number;
  takenBack: number;
  used: number;
  damaged: number;
  /** Sent back to a supplier (TASK-086). */
  returned: number;
  adjusted: number;
  reversed: number;
  closing: number;
}

export interface InventoryDay {
  date: string;
  complete: boolean;
  warehouse: DayItemRow[];
  people: {
    employeeId: string;
    name: string;
    items: { itemId: string; name: string; unit: string; icon: string | null; opening: number; received: number; gaveOut: number; cameBack: number; used: number; damaged: number; reversed: number; closing: number }[];
  }[];
  counts: { id: string; kind: string; state: string; at: string | null; by: string; differing: number }[];
}

export interface CatalogueItem {
  id: string;
  name: string;
  category: string;
  unit: string;
  step: number;
  minLevel: number | null;
  countTolerance: number;
  icon: string | null;
  sortOrder: number;
  active: boolean;
  hasMoved: boolean;
}

export interface Posted {
  docId: string;
  state: string;
  replay: boolean;
}

export type Side = { kind: "warehouse" } | { kind: "person"; employeeId: string };
export interface LineIn {
  itemId: string;
  qty: number;
  variety?: string | null;
  cartonKg?: number | null;
}

const P = (viewer: string) => ({ viewer });

export const inv = {
  home: (viewer: string) => get<InventoryHome>("/dashboard/inventory/home", P(viewer)),
  holders: (viewer: string) => get<Holder[]>("/dashboard/inventory/holders", P(viewer)),
  items: (viewer: string) => get<CatalogueItem[]>("/dashboard/inventory/items", P(viewer)),
  movements: (viewer: string, q: Record<string, string> = {}) => get<{ docs: DocCard[]; more: boolean; cursor: string | null }>("/dashboard/inventory/movements", { ...q, viewer }),
  doc: (viewer: string, id: string) => get<DocCard>(`/dashboard/inventory/docs/${id}`, P(viewer)),
  day: (viewer: string, date: string) => get<InventoryDay>("/dashboard/inventory/day", { viewer, date }),
  counts: (viewer: string) => get<CountCard[]>("/dashboard/inventory/counts", P(viewer)),
  count: (viewer: string, id: string) => get<CountDetail>(`/dashboard/inventory/counts/${id}`, P(viewer)),

  receive: (viewer: string, body: { id: string; supplier?: string; invoiceNo?: string; note?: string; lines: LineIn[]; mediaIds?: string[] }) =>
    post<Posted>("/dashboard/inventory/receipts", body, P(viewer)),
  handover: (viewer: string, body: { id: string; from: Side; to: Side; lines: LineIn[]; note?: string; mediaIds?: string[] }) =>
    post<Posted>("/dashboard/inventory/handovers", body, P(viewer)),
  answer: (viewer: string, id: string, body: { answer: "accept" | "counted" | "refuse"; lines?: { itemId: string; qty: number }[]; reason?: string; note?: string }) =>
    post<Posted>(`/dashboard/inventory/handovers/${id}/answer`, body, P(viewer)),
  cancel: (viewer: string, id: string) => post<Posted>(`/dashboard/inventory/handovers/${id}/cancel`, undefined, P(viewer)),
  settle: (viewer: string, id: string, body: { lines: { itemId: string; outcome: "back" | "write_off"; reason?: string }[]; note?: string }) =>
    post<Posted>(`/dashboard/inventory/handovers/${id}/settle`, body, P(viewer)),
  use: (
    viewer: string,
    body: { id: string; kind: "use" | "damage"; from: "warehouse" | "mine"; reason: string; machineAssetNo?: number; lines: LineIn[]; note?: string; mediaIds?: string[] },
  ) => post<Posted>("/dashboard/inventory/uses", body, P(viewer)),
  reverse: (viewer: string, id: string, body: { id: string; reason: string; note?: string }) =>
    post<Posted>(`/dashboard/inventory/docs/${id}/reverse`, body, P(viewer)),

  startCount: (viewer: string, body: { id: string; kind: CountCard["kind"] }) =>
    post<{ sessionId: string; state: string; replay: boolean; resumed: boolean; kind: CountCard["kind"]; startedAt: string; items: CountItem[] }>("/dashboard/inventory/counts", body, P(viewer)),
  submitCount: (viewer: string, id: string, lines: { itemId: string; qty: number }[]) =>
    post<{ sessionId: string; state: CountCard["state"]; lines: number; matched: number; small: number; recount: number }>(`/dashboard/inventory/counts/${id}/submit`, { lines }, P(viewer)),
  startRecount: (viewer: string, id: string) => post<{ sessionId: string; state: string; items: CountItem[] }>(`/dashboard/inventory/counts/${id}/recount`, undefined, P(viewer)),
  submitRecount: (viewer: string, id: string, lines: { itemId: string; qty: number }[]) =>
    post<{ sessionId: string; state: string }>(`/dashboard/inventory/counts/${id}/recount/submit`, { lines }, P(viewer)),
  waive: (viewer: string, id: string, reason: string) => post<{ state: string }>(`/dashboard/inventory/counts/${id}/waive`, { reason }, P(viewer)),
  decide: (viewer: string, id: string, body: { docId: string; lines: { itemId: string; decision: "accept_count" | "keep_ledger"; reason?: string }[]; note?: string }) =>
    post<{ state: string; adjustmentDocId: string | null }>(`/dashboard/inventory/counts/${id}/decide`, body, P(viewer)),
  cancelCount: (viewer: string, id: string) => post<{ state: string }>(`/dashboard/inventory/counts/${id}/cancel`, undefined, P(viewer)),

  saveItem: (
    viewer: string,
    item: { id?: string; name: string; category: string; unit: string; step: number; minLevel?: number | null; countTolerance?: number; icon?: string | null; sortOrder?: number; active?: boolean },
  ) => {
    const { id, ...body } = item;
    return id ? post<{ id: string; created: boolean }>(`/dashboard/inventory/items/${id}`, body, P(viewer), "PUT") : post<{ id: string; created: boolean }>("/dashboard/inventory/items", body, P(viewer));
  },

  /** One photo, cleaned on the server (no location) — its id goes on the document. */
  uploadPhoto: (viewer: string, file: File, retention: "evidence" | "receipt") => {
    const form = new FormData();
    form.append("file", file);
    return postForm<{ id: string }>("/dashboard/media", form, { viewer, retention });
  },
};

/** "boxes", "cartons", "pieces" — a unit said of more than one. */
export const units = (unit: string): string => (/(x|s|sh|ch)$/.test(unit) ? `${unit}es` : `${unit}s`);

/** "1 box", "1.5 boxes", "12 cartons". */
export function amount(qty: number, unit: string): string {
  const n = Math.round(qty * 1000) / 1000;
  return `${n.toLocaleString("en-GB")} ${n === 1 ? unit : units(unit)}`;
}

export const REASON_WORDS: Readonly<Record<string, string>> = {
  machine_refill: "Put into a machine",
  cleaning: "Cleaning",
  shift_use: "Used on the round",
  repair: "Fitted in a repair",
  spoiled: "Spoiled",
  broken: "Broken",
  expired: "Expired",
  sorting_waste: "Sorted out",
  other: "Other",
  not_received: "Did not arrive",
  wrong_items: "Wrong items",
  wrong_count: "Different count",
  damaged: "Damaged",
  entered_by_mistake: "Entered by mistake",
  wrong_quantity: "Wrong amount",
  wrong_item: "Wrong item",
  duplicate: "Entered twice",
  opening_balance: "Opening stock",
  used_unrecorded: "Used, not recorded",
  damaged_unrecorded: "Damaged, not recorded",
  delivery_difference: "A delivery was different",
  earlier_miscount: "An earlier count was wrong",
  found: "Found stock",
  unexplained: "No explanation yet",
  // A return to the supplier's reasons (TASK-086); wrong_item, expired and other are above.
  quality: "Bad quality",
  excess: "More than ordered",
  damaged_on_arrival: "Damaged on arrival",
};

export const KIND_WORDS: Readonly<Record<string, string>> = {
  receipt: "Delivery",
  handover: "Handover",
  use: "Used",
  damage: "Damaged",
  count_adjustment: "Count adjustment",
  reversal: "Reversal",
  supplier_return: "Returned to supplier",
};

export const COUNT_KIND_WORDS: Readonly<Record<string, string>> = {
  opening: "Opening count",
  after_handout: "After the team left",
  closing: "Closing count",
  spot: "Spot check",
};

export const newId = (): string => crypto.randomUUID();
