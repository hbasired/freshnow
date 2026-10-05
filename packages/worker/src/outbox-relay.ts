import { CONSENT_POLICY_VERSION, currentNoticeHashes, getServiceSql, logAudit } from "@freshnow/core";

/** Thrown by a deliverer on a provider rate-limit (Telegram 429). Never abandons. */
export class RateLimitError extends Error {
  readonly retryAfterSec: number | undefined;
  constructor(message: string, retryAfterSec?: number) {
    super(message);
    this.retryAfterSec = retryAfterSec;
  }
}

/**
 * Delay before a failed row is retried: 2s, 4s, 8s, 16s, 32s, capped at 5 minutes.
 *
 * Capped because this is a message somebody is waiting for, not a background job — an
 * hour-long backoff on the fifth attempt would be indistinguishable from losing it.
 */
export function backoffSeconds(attempt: number): number {
  return Math.min(2 ** attempt, 300);
}

export type Deliverer = (msg: {
  chatId: string | number | null;
  payload: unknown;
  recipientEmployeeId?: string | null;
  /** The outbox row being delivered — email uses it for a stable Message-ID across retries. */
  outboxId?: string;
  correlationId?: string | null;
}) => Promise<void>;

/**
 * One sender per channel. A row whose channel has no sender here is never claimed —
 * it waits, unclaimed and undelivered, until a sender exists (email, web push), which is
 * the honest state for a channel that is not switched on.
 */
export type Senders = Partial<Record<"telegram" | "inapp" | "email" | "webpush" | "chat", Deliverer>>;

/**
 * The in-app inbox: the outbox row IS the notification, so "sending" is nothing more
 * than marking it sent. No network, no token, no third party — the channel that still
 * works when every external one is down.
 */
export const inAppSender: Deliverer = async () => {};

export interface OutboxResult {
  sent: number;
  abandoned: number;
  retried: number;
  total: number;
}

interface OutboxRow {
  id: string;
  chat_id: string | number | null;
  payload: unknown;
  attempts: number;
  channel: string;
  recipient_employee_id: string | null;
  idempotency_key: string;
  correlation_id: string | null;
}

/** One permanently-undelivered message, for the audit written after the batch commits. */
interface AbandonedRow {
  id: string;
  channel: string;
  recipient: string | null;
  key: string;
  correlationId: string | null;
  lastError: string;
}

/**
 * Claim a batch of pending outbox rows with FOR UPDATE SKIP LOCKED (so parallel
 * workers never grab the same row), deliver each, and mark the result. Delivery
 * happens inside the transaction so the row stays locked until it is resolved —
 * fine at demo volume; for scale, claim-then-deliver outside the lock. Rows are
 * only marked 'sent' after the deliverer returns, giving at-least-once delivery;
 * the recipient sees each logical message once because the enqueue key is UNIQUE.
 */
export async function deliverOutboxBatch(
  deliver: Deliverer | Senders,
  opts: { batchSize?: number; maxAttempts?: number } = {},
): Promise<OutboxResult> {
  const batchSize = opts.batchSize ?? 5;
  const maxAttempts = opts.maxAttempts ?? 5;
  const sql = getServiceSql();
  // A bare function is the Telegram sender (every older caller and test); a map names
  // a sender per channel. The in-app inbox is always served.
  const senders: Senders = typeof deliver === "function" ? { telegram: deliver, inapp: inAppSender } : { inapp: inAppSender, ...deliver };
  const channels = Object.keys(senders).filter((k) => senders[k as keyof Senders]);

  const abandonedRows: AbandonedRow[] = [];
  const hashes = currentNoticeHashes();
  const result = await (sql.begin(async (tx) => {
    // Only rows that are DUE. Without this filter a permanently-failing row is
    // re-claimed on every poll, and `batchSize` such rows fill the batch forever —
    // head-of-line blocking that stops all outbound delivery while the relay spins on
    // the same failures every 3 seconds.
    //
    // And only rows whose recipient has agreed to the notice as it reads today. Sending a
    // person's work to Telegram, a push relay or an email provider is a transfer of their
    // data, and consent to an older notice that never named those services does not cover it
    // (consent.ts). Held rows are simply not claimed: they stay pending, cost nothing to skip,
    // cannot block the batch, and go out on the first poll after the person agrees. Never held:
    // the in-app inbox (our own database — it is where the person finds the request), the
    // consent request itself, and rows with no recipient on record.
    const rows = await tx<OutboxRow[]>`
      select o.id, o.chat_id, o.payload, o.attempts, o.channel, o.recipient_employee_id,
             o.idempotency_key, o.correlation_id
      from notification_outbox o
      where o.status = 'pending' and o.next_attempt_at <= now()
        and o.channel = any(${channels})
        and (
          o.channel = 'inapp'
          or o.recipient_employee_id is null
          or o.payload->>'kind' = 'consent.requested'
          or exists (
            select 1 from consent_record c
            where c.employee_id = o.recipient_employee_id
              and c.policy_version = ${CONSENT_POLICY_VERSION}
              and c.notice_hash = any(${hashes})
          )
        )
      order by o.created_at
      limit ${batchSize}
      for update of o skip locked`;

    let sent = 0;
    let abandoned = 0;
    let retried = 0;

    for (const row of rows) {
      const attempts = row.attempts + 1;
      try {
        const send = senders[row.channel as keyof Senders]!;
        await send({ chatId: row.chat_id, payload: row.payload, recipientEmployeeId: row.recipient_employee_id, outboxId: row.id, correlationId: row.correlation_id });
        await tx`update notification_outbox
                 set status = 'sent', sent_at = now(), attempts = ${attempts}
                 where id = ${row.id}`;
        sent++;
      } catch (err) {
        if (err instanceof RateLimitError) {
          // Rate limits never abandon — the message is still wanted, Telegram just wants
          // us to wait. Honour the server's own retry_after when it gives one; that is
          // the only number that actually knows when the limit clears.
          const waitSec = err.retryAfterSec ?? backoffSeconds(attempts);
          await tx`update notification_outbox
                   set attempts = ${attempts},
                       next_attempt_at = now() + (${waitSec} * interval '1 second')
                   where id = ${row.id}`;
          retried++;
        } else if (attempts >= maxAttempts) {
          await tx`update notification_outbox
                   set status = 'abandoned', attempts = ${attempts}
                   where id = ${row.id}`;
          abandoned++;
          // Giving up on a message is a decision, and it was previously recorded ONLY as a
          // console line — including for escalation alerts to the CEO, which is exactly the
          // message you most need to know did not arrive. Found by audit 2026-09-18.
          //
          // Written outside this transaction's concerns via the service client, and never
          // allowed to fail the batch: losing the audit row is bad, rolling back a delivery
          // batch because of it is worse.
          abandonedRows.push({
            id: row.id,
            channel: row.channel,
            recipient: row.recipient_employee_id,
            key: row.idempotency_key,
            correlationId: row.correlation_id,
            lastError: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
          });
        } else {
          // Exponential backoff, so a row failing for its own reasons (a blocked chat,
          // a bad file id) stops competing for batch slots with everyone else's messages.
          await tx`update notification_outbox
                   set attempts = ${attempts},
                       next_attempt_at = now() + (${backoffSeconds(attempts)} * interval '1 second')
                   where id = ${row.id}`;
          retried++;
        }
      }
    }
    return { sent, abandoned, retried, total: rows.length };
  }) as Promise<OutboxResult>);

  // After the batch commits, so an audit failure cannot roll back real deliveries.
  for (const a of abandonedRows) {
    await logAudit({
      correlationId: a.correlationId ?? undefined,
      actor: "system",
      action: "notification.abandoned",
      entity: "notification_outbox",
      entityId: a.id,
      detail: {
        channel: a.channel,
        recipientEmployeeId: a.recipient,
        idempotencyKey: a.key,
        lastError: a.lastError,
        note: "delivery gave up after the attempt limit; this message was never received",
      },
    }).catch(() => {
      /* the delivery result stands even if the record of the failure does not */
    });
  }
  return result;
}
