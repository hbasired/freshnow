/**
 * Reading an email reply — pure functions, no database, no network, no model.
 *
 * Everything that decides what an inbound email MEANS for routing is here and deterministic:
 * which task it is about (the FN-42 key, the Jira pattern), what the person actually wrote
 * (their words, not the quoted history under them), what status words say (done / 40% /
 * blocked), and whether the receiving server vouched for the sender. The model only ever sees
 * the words; it never decides which task or whether a sender is genuine.
 */

export const TASK_KEY_PREFIX = "FN";

/** "FN-42" — the key people see in subjects, the dashboard and chat (migration 0021). */
export function formatTaskKey(taskNumber: number | string | bigint): string {
  return `${TASK_KEY_PREFIX}-${String(taskNumber)}`;
}

/** The first FN-<n> in a subject (Jira: the key in the subject wins over threading headers). */
export function taskNumberFromSubject(subject: string | null | undefined): number | null {
  const m = new RegExp(`(?:^|[^A-Za-z0-9])${TASK_KEY_PREFIX}-(\\d{1,12})(?![0-9])`, "i").exec(subject ?? "");
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Message-IDs are compared without angle brackets and whitespace, case-sensitively (RFC 5322). */
export function normaliseMessageId(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim().replace(/^<|>$/g, "").trim();
  return s.length >= 3 && s.length <= 998 ? s : null;
}

/** A References header → its Message-IDs, oldest first. */
export function parseReferences(raw: string | readonly string[] | null | undefined): string[] {
  const text = Array.isArray(raw) ? raw.join(" ") : ((raw as string | null | undefined) ?? "");
  return [...text.matchAll(/<([^<>\s]{3,998})>/g)].map((m) => m[1]!);
}

const MAX_REPLY_CHARS = 4000;

/**
 * What the person wrote, without the quoted message underneath. Gmail, Outlook and phone
 * clients each mark the start of the quote differently; the earliest marker wins. If nothing
 * is left (a reply with only a quote), the empty string — the caller then has nothing to file.
 */
export function extractReply(text: string): string {
  const t = text.replace(/\r\n?/g, "\n");
  const markers: RegExp[] = [
    // Gmail / Apple Mail: "On Mon, 5 Oct 2026 at 10:02, FreshNow <ops@x> wrote:" — may wrap.
    /^[ \t]*On [^\n]{0,250}(?:\n[^\n]{0,250})?\bwrote:[ \t]*$/m,
    // Gmail in other languages often keeps the shape "… <address> …:" on one line before ">".
    /^[ \t]*-{2,}\s*(?:Original Message|Forwarded message)\s*-{2,}[ \t]*$/im,
    // Outlook: a rule, then "From: … Sent: …".
    /^[ \t]*_{8,}[ \t]*$/m,
    /^[ \t]*From:[^\n]*\n[ \t]*(?:Sent|Date):/im,
    // A plain quote block.
    /^[ \t]*>/m,
  ];
  let cut = t.length;
  for (const re of markers) {
    const m = re.exec(t);
    if (m && m.index < cut) cut = m.index;
  }
  let body = t.slice(0, cut).trimEnd();
  // Signatures: the standard "-- " delimiter, and the phone footers people never remove.
  body = body.replace(/\n-- ?\n[\s\S]*$/, "\n");
  body = body.replace(/\n[ \t]*(?:Sent from my [^\n]{1,40}|Get Outlook for [^\n]{1,40})[ \t]*$/i, "\n");
  return body.replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_REPLY_CHARS);
}

export interface EmailStatus {
  status: "done" | "in_progress" | "blocker" | "pending";
  /** A percentage the person wrote ("40%", "about 70 percent"), when they wrote one. */
  percent: number | null;
}

/**
 * What a reply says about the task, from its first line — deterministic keywords, the same idea
 * as the Telegram buttons. A problem is not decided here: the words still go to the blocker
 * parser, which is what raises a blocker. "blocked" here only marks the update's status.
 */
export function parseEmailStatus(reply: string): EmailStatus {
  const first = (reply.split("\n").find((l) => l.trim().length > 0) ?? "").toLowerCase();
  const pct = /(\d{1,3})\s*(?:%|percent\b|per cent\b)/.exec(first);
  const percent = pct && Number(pct[1]) <= 100 ? Number(pct[1]) : null;
  if (/\b(not done|not finished|not completed|undone)\b/.test(first)) {
    return { status: "in_progress", percent };
  }
  if (/\b(blocked|stuck|can'?t|cannot|problem|issue|broken|waiting for|no (?:parts|stock|power))\b/.test(first)) {
    return { status: "blocker", percent };
  }
  // A number under 100 is progress, even next to the word "done": "40% done" is not finished.
  if (percent !== null && percent < 100) return { status: "in_progress", percent };
  if (percent === 100 || /\b(done|finished|completed?|complete|fixed|delivered|closed)\b/.test(first)) {
    return { status: "done", percent: percent ?? 100 };
  }
  if (/\b(started|working on|in progress|on it|halfway)\b/.test(first)) {
    return { status: "in_progress", percent };
  }
  return { status: "pending", percent: null };
}

export interface AuthVerdict {
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
  /** The authserv-id of the header the verdicts were read from. */
  by: string | null;
}

/**
 * The SPF / DKIM / DMARC verdicts the receiving server recorded (RFC 8601
 * Authentication-Results). Only a header from the TRUSTED server is read — Google's own
 * receiving servers say "mx.google.com" — and only the first one, which is the one Google added
 * on arrival: a sender can write their own Authentication-Results lower down, so any other
 * header is ignored rather than believed.
 */
export function readAuthResults(headers: readonly string[], trustedAuthserv: string): AuthVerdict {
  const want = trustedAuthserv.trim().toLowerCase();
  for (const h of headers) {
    const flat = h.replace(/\s+/g, " ").trim();
    const authserv = flat.split(";")[0]?.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    if (authserv !== want) continue;
    const v = (k: string) => new RegExp(`\\b${k}=([a-z]+)`, "i").exec(flat)?.[1]?.toLowerCase() ?? null;
    return { spf: v("spf"), dkim: v("dkim"), dmarc: v("dmarc"), by: authserv };
  }
  return { spf: null, dkim: null, dmarc: null, by: null };
}

/** All three pass — the bar the existing inbound route already sets (inbound-email.ts). */
export function authPasses(v: AuthVerdict): boolean {
  return v.spf === "pass" && v.dkim === "pass" && v.dmarc === "pass";
}

/** Lower-cased address out of `"Name <a@b.c>"`, or the string itself. */
export function emailAddressOf(raw: string): string {
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(raw);
  return (m?.[1] ?? raw).trim().toLowerCase();
}
