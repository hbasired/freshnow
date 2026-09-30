import type { LlmMessage } from "./client.js";

/**
 * Rule R7 — identifiers are removed before a prompt leaves the building.
 *
 * CLAUDE.md: "Prompts contain the minimum necessary — never phone numbers, never full records."
 * Until now that was a rule people had to remember. Here it is applied to every model call, in
 * the one wrapper every call goes through, so a document full of phone numbers or an update that
 * quotes an Emirates ID reaches the provider as "[phone]" and "[emirates-id]".
 *
 * What is removed: email addresses, Emirates ID numbers (784-YYYY-NNNNNNN-C), IBANs that pass
 * the ISO 13616 mod-97 check, card numbers that pass the Luhn check, international phone
 * numbers (+… or 00…) and UAE local numbers (05X XXX XXXX, 0X XXX XXXX).
 *
 * What is NOT removed, deliberately: names. The document planner routes work BY name ("Priya to
 * check the chiller") and the blocker parser needs to know who is affected; replacing names would
 * break both. Not removed either: a bare 10-digit Indian mobile with no +91 — indistinguishable
 * from the long batch and order numbers this business writes. Voice notes go to Groq as audio and
 * cannot be redacted; their transcript is, when it is parsed.
 *
 * Every pattern has word boundaries on both sides, so nothing is cut out of the middle of a
 * longer token — including the random fence that spotlights untrusted text (injection.ts).
 * Only `user` messages are touched: system prompts are ours and carry no one's identifiers.
 */

export type IdentifierKind = "email" | "emirates_id" | "iban" | "card" | "phone";

export interface Redacted {
  text: string;
  counts: Record<IdentifierKind, number>;
  total: number;
}

const B = "(?<![A-Za-z0-9_@])"; // not in the middle of a word, number or address
const E = "(?![A-Za-z0-9_])";

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const EMIRATES_ID = new RegExp(`${B}784[- ]?\\d{4}[- ]?\\d{7}[- ]?\\d${E}`, "g");
const IBAN = new RegExp(`${B}[A-Z]{2}\\d{2}(?: ?[A-Z0-9]){11,30}${E}`, "g");
const CARD = new RegExp(`${B}\\d(?:[ -]?\\d){12,18}${E}`, "g");
const PHONE_INTL = new RegExp(`${B.replace("_@", "_@+")}(?:\\+|00)\\d(?:[ \\-()]{0,2}\\d){6,15}${E}`, "g");
const PHONE_UAE = new RegExp(`${B}0(?:5\\d|[2-9])(?:[ -]?\\d){7}${E}`, "g");

/** ISO 13616: move the first four characters to the end, letters to numbers, remainder 97 = 1. */
function validIban(raw: string): boolean {
  const s = raw.replace(/ /g, "");
  if (s.length < 15 || s.length > 34) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

function digitCount(s: string): number {
  return s.replace(/\D/g, "").length;
}

export function redactIdentifiers(input: string): Redacted {
  const counts: Record<IdentifierKind, number> = { email: 0, emirates_id: 0, iban: 0, card: 0, phone: 0 };
  let text = input;
  const swap = (re: RegExp, kind: IdentifierKind, keep: (m: string) => boolean = () => true) => {
    text = text.replace(re, (m) => {
      if (!keep(m)) return m;
      counts[kind]++;
      return `[${kind.replace("_", "-")}]`;
    });
  };
  // Order matters: the more specific shapes first, so an Emirates ID is not called a card.
  swap(EMAIL, "email");
  swap(EMIRATES_ID, "emirates_id");
  swap(IBAN, "iban", validIban);
  swap(CARD, "card", (m) => luhn(m.replace(/\D/g, "")));
  swap(PHONE_INTL, "phone", (m) => {
    const n = digitCount(m) - (m.startsWith("00") ? 2 : 0);
    return n >= 8 && n <= 15;
  });
  swap(PHONE_UAE, "phone");
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { text, counts, total };
}

/** The messages as they will leave, and how many identifiers were taken out of them. */
export function redactMessages(messages: readonly LlmMessage[]): { messages: LlmMessage[]; total: number } {
  let total = 0;
  const out = messages.map((m) => {
    if (m.role !== "user") return m;
    const r = redactIdentifiers(m.content);
    total += r.total;
    return r.total ? { ...m, content: r.text } : m;
  });
  return { messages: out, total };
}
