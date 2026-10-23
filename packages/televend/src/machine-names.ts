/**
 * Machine names in Televend follow a loose pattern — "<site>-<asset no>-<flags>-<emirate>" —
 * typed by people and renamed over time. Measured 2026-10-15: between the 13 Oct export and a
 * live read two days later, 9 of the 87 enabled machines had been renamed
 * ("Oasis Mall DXB-543-DXB" → "Oasis Mall DXB-543-Cashless 1-DXB"). Captions are therefore
 * never an identity. The 3–4 digit asset number inside the name survives renames and is what
 * staff write in WhatsApp ("Mina 793"), so it is the human key; Televend's numeric machine id
 * is the system key.
 *
 * The full parser and the machine ↔ site ↔ Televend placement history are TASK-056; this is the
 * piece the connector needs to line up exports with live data.
 */

const ASSET = /(?:^|[\s-])(\d{3,4})(?=$|[\s-])/;

/** The asset number in a Televend machine name, or null (e.g. "Oranfresh-ITALY"). */
export function assetNumber(caption: string | null | undefined): number | null {
  if (!caption) return null;
  const m = ASSET.exec(caption);
  return m?.[1] ? Number(m[1]) : null;
}

const EMIRATES: Readonly<Record<string, string>> = { DXB: "Dubai", SHJ: "Sharjah", AJM: "Ajman", UAQ: "Umm Al Quwain" };

/** The emirate code at the end of a name ("…-DXB"), when present. */
export function emirateCode(caption: string | null | undefined): keyof typeof EMIRATES | null {
  const m = /-\s*(DXB|SHJ|AJM|UAQ)\s*$/i.exec(caption ?? "");
  return m?.[1] ? (m[1].toUpperCase() as keyof typeof EMIRATES) : null;
}
