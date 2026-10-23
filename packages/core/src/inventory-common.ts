import { createHash, randomUUID } from "node:crypto";
import type { ViewerOrg } from "./org.js";
import { can, type Capability } from "./permissions.js";

/**
 * What every part of the stock ledger shares (TASK-060): the fixed places, the reasons, the refusal,
 * amounts as whole thousandths, and the request hash. Its own module so the ledger, the counts, the
 * reads and the notices can all use it without importing one another in a circle.
 */

export const PLACE = {
  warehouse: "00000000-0000-0000-0000-00000000b001",
  inTransit: "00000000-0000-0000-0000-00000000b002",
  suppliers: "00000000-0000-0000-0000-00000000b003",
  used: "00000000-0000-0000-0000-00000000b004",
  damaged: "00000000-0000-0000-0000-00000000b005",
  adjustments: "00000000-0000-0000-0000-00000000b006",
} as const;

export const USE_REASONS = ["machine_refill", "cleaning", "shift_use", "repair", "other"] as const;
export const DAMAGE_REASONS = ["spoiled", "broken", "expired", "sorting_waste", "other"] as const;
export const REFUSE_REASONS = ["not_received", "wrong_items", "wrong_count", "damaged", "other"] as const;
export const REVERSE_REASONS = ["entered_by_mistake", "wrong_quantity", "wrong_item", "duplicate", "other"] as const;
export const WRITE_OFF_REASONS = ["damaged_unrecorded", "unexplained"] as const;
export type UseReason = (typeof USE_REASONS)[number];
export type DamageReason = (typeof DAMAGE_REASONS)[number];
export type RefuseReason = (typeof REFUSE_REASONS)[number];
export type ReverseReason = (typeof REVERSE_REASONS)[number];
export type WriteOffReason = (typeof WRITE_OFF_REASONS)[number];

export class InventoryRefused extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 403,
    readonly code: string = "refused",
  ) {
    super(message);
    this.name = "InventoryRefused";
  }
}

export interface LineIn {
  itemId: string;
  /** In the item's unit; a multiple of its step (1 carton, half a box). */
  qty: number | string;
  /** A delivery of oranges: the variety and the carton's weight, as the carton says. */
  variety?: string | null;
  cartonKg?: number | null;
}

export interface Posted {
  docId: string;
  state: string;
  /** True when this exact request had been posted before: nothing was posted again. */
  replay: boolean;
}

/** Who the other side of a handover is: the warehouse, or one person. */
export type Side = { kind: "warehouse" } | { kind: "person"; employeeId: string };

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const correlationOf = (c?: string): string => (c && UUID_RE.test(c) ? c : randomUUID());

// ── amounts ───────────────────────────────────────────────────────────────────
// Quantities travel as text into numeric(14,3); in here they are whole thousandths, so 1.5 boxes is
// 1500 and arithmetic is exact.
export const toMilli = (q: string | number): number => Math.round(Number(q) * 1000);
export const fromMilli = (m: number): string => (m / 1000).toFixed(3);
export const qtyNumber = (q: string | number): number => toMilli(q) / 1000;

/** A positive amount with at most three decimals, as thousandths — or a refusal in words. */
export function parseQty(q: number | string, what = "amount", allowZero = false): number {
  // A JSON number is read as it was sent: 2.4996 is refused like the text "2.4996", never rounded to 2.5.
  // (The 1e-6 allows for binary floating point: 1.005 × 1000 is 1004.9999999999999.)
  const whole = typeof q === "number" && Number.isFinite(q) && Math.abs(q * 1000 - Math.round(q * 1000)) < 1e-6;
  const s = typeof q === "number" ? (whole ? String(Math.round(q * 1000) / 1000) : "") : q.trim();
  if (!/^\d{1,11}(\.\d{1,3})?$/.test(s)) throw new InventoryRefused(`The ${what} must be a number with at most three decimals.`, 400, "bad_qty");
  const m = toMilli(s);
  if (m < 0 || (!allowZero && m === 0)) throw new InventoryRefused(`The ${what} must be more than zero.`, 400, "bad_qty");
  return m;
}

/** "1 box", "1.5 boxes", "12 cartons" — the amount in words a person reads at a glance. */
export function fmt(milli: number, unit: string): string {
  const n = Number((milli / 1000).toFixed(3));
  const plural = n === 1 ? unit : /(x|s|sh|ch)$/.test(unit) ? `${unit}es` : `${unit}s`;
  return `${n.toLocaleString("en-GB")} ${plural}`;
}

// ── who ──────────────────────────────────────────────────────────────────────
export function requireCan(viewer: ViewerOrg, capability: Capability, message: string): void {
  if (viewer.status !== "active" || !can(viewer, capability)) throw new InventoryRefused(message, 403, "not_allowed");
}

/** sha256 of the request as it means — the same request in any key order hashes the same. */
export function requestHash(x: unknown): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([, val]) => val !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, val]) => [k, canon(val)]),
      );
    }
    return v;
  };
  return createHash("sha256").update(JSON.stringify(canon(x))).digest("hex");
}
