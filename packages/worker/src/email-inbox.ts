import { ImapFlow } from "imapflow";
import { simpleParser, type AddressObject } from "mailparser";
import {
  getServiceSql,
  inboxConfig,
  normaliseMessageId,
  processInboundEmail,
  screenAndRoute,
  storedInboundMessage,
  unreadInboundEmails,
  type InboundEmailMessage,
  type InboxConfig,
} from "@freshnow/core";

/**
 * Reading the FreshNow inbox over IMAP — the only way to receive email with Gmail and no
 * company domain (Gmail: imap.gmail.com:993 with an App Password; docs/EMAIL-SETUP-GUIDE.md).
 *
 * The adapter is thin on purpose: it finds new messages and hands each to core, which records,
 * screens and routes it (core/email-inbound.ts). What it guarantees on its own:
 *   - it reads ONLY mail addressed to the inbox alias (an IMAP search), never the rest of the
 *     mailbox — and core checks the To: header again;
 *   - it never changes the mailbox: no \Seen flag, nothing moved or deleted (fetches use
 *     BODY.PEEK), so the account owner's Gmail looks exactly as before;
 *   - it asks the database first which messages it already has, so a message is downloaded and
 *     processed once however many polls see it;
 *   - it is bounded: the last 7 days, at most 50 messages per poll, a socket timeout.
 */

export const POLL_LOOKBACK_DAYS = 7;
export const MAX_PER_POLL = 50;

export interface PollResult {
  found: number;
  fresh: number;
  outcomes: Record<string, number>;
  errors: number;
}

function addresses(v: AddressObject | AddressObject[] | undefined): string[] {
  const all = Array.isArray(v) ? v : v ? [v] : [];
  return all.flatMap((a) => a.value.map((x) => (x.address ?? "").toLowerCase())).filter(Boolean);
}

/** One raw RFC 5322 message → the shape core understands. Exported for tests. */
export async function toInboundMessage(source: Buffer, labels?: ReadonlySet<string>): Promise<InboundEmailMessage> {
  const m = await simpleParser(source, { skipHtmlToText: false, skipTextLinks: true });
  const header = (k: string) => {
    const v = m.headers.get(k);
    return typeof v === "string" ? v : null;
  };
  // Every Authentication-Results line, in order — the first trusted one is the receiving
  // server's (email-reply.ts readAuthResults).
  const authResults = m.headerLines
    .filter((h) => h.key.toLowerCase() === "authentication-results")
    .map((h) => h.line.replace(/^[^:]*:\s*/, ""));
  const refs = m.references;
  return {
    messageId: m.messageId ?? null,
    inReplyTo: m.inReplyTo ?? null,
    references: (Array.isArray(refs) ? refs : refs ? [refs] : []).map((r) => r.replace(/^<|>$/g, "")),
    from: m.from?.value[0]?.address ?? "",
    to: [...addresses(m.to), ...addresses(m.cc)],
    subject: m.subject ?? null,
    text: m.text ?? "",
    date: m.date ?? null,
    autoSubmitted: header("auto-submitted"),
    precedence: header("precedence"),
    authResults,
    // Gmail's own label: only someone signed in to this account can put a message in Sent.
    sentByMailboxOwner: Boolean(labels && [...labels].some((l) => l.toLowerCase() === "\\sent")),
  };
}

export async function pollInbox(cfg: InboxConfig | null = inboxConfig()): Promise<PollResult> {
  const result: PollResult = { found: 0, fresh: 0, outcomes: {}, errors: 0 };
  if (!cfg) return result;
  const started = new Date();
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
    connectionTimeout: 15_000,
    socketTimeout: 90_000,
  });
  let failure: string | null = null;
  try {
    await client.connect();
    const lock = await client.getMailboxLock(cfg.mailbox, { readOnly: true });
    try {
      const since = new Date(Date.now() - POLL_LOOKBACK_DAYS * 86_400_000);
      const found = (await client.search({ since, to: cfg.inboxAddress }, { uid: true })) || [];
      result.found = found.length;
      const recent = found.slice(-MAX_PER_POLL);
      if (recent.length > 0) {
        // Which of these do we already have? Envelopes are cheap; whole messages are not.
        const seen: { uid: number; id: string | null }[] = [];
        for await (const msg of client.fetch(recent, { envelope: true, uid: true }, { uid: true })) {
          seen.push({ uid: msg.uid, id: normaliseMessageId(msg.envelope?.messageId ?? null) });
        }
        const ids = seen.map((s) => s.id).filter((x): x is string => !!x);
        const known = new Set(
          ids.length
            ? (await getServiceSql()<{ message_id: string }[]>`
                select message_id from email_message where direction = 'in' and message_id = any(${ids})`).map((r) => r.message_id)
            : [],
        );
        for (const s of seen) {
          if (s.id && known.has(s.id)) continue;
          result.fresh++;
          try {
            const full = await client.fetchOne(String(s.uid), { source: true, labels: true }, { uid: true });
            if (!full || !full.source) continue;
            const outcome = await processInboundEmail(await toInboundMessage(full.source, full.labels));
            result.outcomes[outcome.kind] = (result.outcomes[outcome.kind] ?? 0) + 1;
          } catch (err) {
            // One bad message must not stop the rest; it is retried on the next poll because
            // nothing was recorded for it.
            result.errors++;
            console.error("[worker] email: could not process one message", err instanceof Error ? err.message : err);
          }
        }
      }
    } finally {
      lock.release();
    }
  } catch (err) {
    // The server's reason ("[AUTHENTICATIONFAILED] …") is what tells someone what to fix.
    failure = (err as { responseText?: string }).responseText ?? (err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    await client.logout().catch(() => client.close());
    await recordRun("email_poll", started, failure, { ...result });
  }
  return result;
}

/** Emails a model outage left unread, read again (bounded by MAX_EMAIL_ATTEMPTS in core). */
export async function retryUnreadEmails(): Promise<{ retried: number; outcomes: Record<string, number> }> {
  const started = new Date();
  const outcomes: Record<string, number> = {};
  const rows = await unreadInboundEmails(10);
  for (const r of rows) {
    const msg = await storedInboundMessage(r.id);
    if (!msg) continue;
    const o = await screenAndRoute(r.id, msg);
    outcomes[o.kind] = (outcomes[o.kind] ?? 0) + 1;
  }
  if (rows.length > 0) await recordRun("email_retry", started, null, { retried: rows.length, outcomes });
  return { retried: rows.length, outcomes };
}

/**
 * One job_run row per run — what /health and the dashboard read to say "the inbox was last
 * checked at …". Kept for three days; the table must not grow with every poll forever.
 */
async function recordRun(job: string, started: Date, failure: string | null, detail: Record<string, unknown>): Promise<void> {
  const sql = getServiceSql();
  await sql`insert into job_run (job_name, status, detail, started_at, finished_at)
            values (${job}, ${failure ? "error" : "ok"}, ${sql.json({ ...detail, ...(failure ? { error: failure.slice(0, 300) } : {}) } as never)}, ${started}, now())`.catch(() => {});
  await sql`delete from job_run where job_name = ${job} and created_at < now() - interval '3 days'`.catch(() => {});
}
