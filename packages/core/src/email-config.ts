/**
 * Email configuration — read from the environment, never thrown on when absent (an optional
 * channel must not stop the system; gotcha G97).
 *
 * Out: SMTP (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, EMAIL_FROM) — already used by the worker.
 * In:  an IMAP mailbox the worker reads (EMAIL_IMAP_*), and the address replies go to
 *      (EMAIL_INBOX_ADDRESS). With Gmail and no company domain, that address is a "+" alias of
 *      the sending account — e.g. ops+freshnow@gmail.com delivers into ops@gmail.com — and the
 *      worker reads ONLY mail addressed to that alias.
 * Both ways: EMAIL_ALLOWLIST — when set, the only addresses email may go to or be accepted
 *      from. For the demo it holds exactly two addresses, the CEO's and one employee's, so a
 *      mistake can never email anyone else.
 */

export interface InboxConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  /** The folder to read. Gmail delivers to INBOX. */
  mailbox: string;
  /** The address people reply to — only mail TO this address is read. */
  inboxAddress: string;
  /** The receiving server whose Authentication-Results header is believed. */
  trustedAuthserv: string;
  pollSeconds: number;
}

const list = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(/[,;\s]+/)
    .map((a) => a.trim().toLowerCase())
    .filter((a) => a.includes("@"));

/** The allow-list, or null when none is set (then any employee's own address may be used). */
export function emailAllowlist(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> | null {
  const a = list(env.EMAIL_ALLOWLIST);
  return a.length ? new Set(a) : null;
}

/** May email go to (or be accepted from) this address? */
export function emailAddressAllowed(address: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const allow = emailAllowlist(env);
  return allow === null || allow.has(address.trim().toLowerCase());
}

/** Where replies should go: the inbox alias, when inbound email is set up. */
export function replyToAddress(env: NodeJS.ProcessEnv = process.env): string | null {
  return inboxConfig(env)?.inboxAddress ?? null;
}

/** The mailbox the worker reads, or null when inbound email is not configured. */
export function inboxConfig(env: NodeJS.ProcessEnv = process.env): InboxConfig | null {
  const host = env.EMAIL_IMAP_HOST?.trim();
  const user = env.EMAIL_IMAP_USER?.trim();
  const pass = env.EMAIL_IMAP_PASS;
  const inboxAddress = env.EMAIL_INBOX_ADDRESS?.trim().toLowerCase();
  if (!host || !user || !pass || !inboxAddress) return null;
  const port = Number(env.EMAIL_IMAP_PORT ?? 993);
  const poll = Number(env.EMAIL_POLL_SECONDS ?? 60);
  return {
    host,
    port: Number.isInteger(port) ? port : 993,
    secure: (env.EMAIL_IMAP_TLS ?? "true") !== "false",
    user,
    pass,
    mailbox: env.EMAIL_IMAP_MAILBOX?.trim() || "INBOX",
    inboxAddress,
    trustedAuthserv: env.EMAIL_TRUSTED_AUTHSERV?.trim().toLowerCase() || "mx.google.com",
    // Bounded both ways: never hammer the provider, never wait more than 10 minutes.
    pollSeconds: Number.isFinite(poll) ? Math.min(600, Math.max(30, Math.round(poll))) : 60,
  };
}

/**
 * State of the email channel. Counts only — no addresses — because /health is public; the
 * CEO's dashboard reads the addresses separately (`emailAllowlist`).
 */
export function emailStatus(env: NodeJS.ProcessEnv = process.env): {
  sending: boolean;
  receiving: boolean;
  allowlisted: number | null;
} {
  const allow = emailAllowlist(env);
  return {
    sending: Boolean(env.SMTP_HOST && env.EMAIL_FROM),
    receiving: inboxConfig(env) !== null,
    allowlisted: allow ? allow.size : null,
  };
}
