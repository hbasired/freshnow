import { assetNumber } from "./machine-names.js";
import type { TvRefill } from "./sources/types.js";

/**
 * The identity of a refill row. Televend's refill log has no id, so a row is recognised by the
 * machine (its asset number — names change, G150), the time to the second (the API gives
 * microseconds, exports give seconds), the machine COLUMN, the action and the quantity. The same
 * refill read from the API and from an export therefore gets the same key, and re-reading a day
 * adds nothing.
 *
 * The column is part of it because a two-column machine can log two genuine refills in the same
 * second with the same quantity — one per product (seen 11 Oct 2026: columns 511 and 767, 3 cups
 * each). Without the column the second refill was silently dropped (G159).
 *
 * Limitation (G162): a machine with no number in its name is keyed by its Televend id when read
 * from the API but by its name when read from an export, so the same refill from both would be
 * two rows. Keying API rows by name instead would duplicate them after every rename.
 */
export function refillKey(
  r: Pick<TvRefill, "machineTelevendId" | "machineCaption" | "at" | "action" | "quantityChange" | "column">,
): string {
  const machine = assetNumber(r.machineCaption) ?? r.machineTelevendId ?? (r.machineCaption ?? "?").trim();
  const second = new Date(Math.floor(r.at.getTime() / 1000) * 1000).toISOString();
  return `${machine}|${second}|c${r.column ?? "-"}|${r.action}|${r.quantityChange}`;
}
