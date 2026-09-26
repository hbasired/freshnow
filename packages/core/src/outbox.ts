import { logAudit } from "./audit.js";
import { CHANNELS, isChannelLive, type Channel } from "./channels.js";
import { getServiceSql } from "./db.js";

/**
 * The channel vocabulary lives in `channels.ts`, which also decides whether each one is
 * live. Re-exported here because every caller that queues a message already imports from
 * this file, and two lists that must agree are one list that eventually will not.
 */
export const OUTBOX_CHANNELS = CHANNELS;
export type OutboxChannel = Channel;

export interface OutboxMessage {
  idempotencyKey: string;
  chatId?: bigint | number | null;
  payload: unknown;
  humanApproved?: boolean;
  isSynthetic?: boolean;
  /** Which sender delivers it. Telegram unless said otherwise — every older caller. */
  channel?: OutboxChannel;
  /** The person this is for, so a channel other than Telegram can find them later. */
  recipientEmployeeId?: string | null;
  /** The rule that chose this recipient, in plain words. Shown in their inbox. */
  reason?: string | null;
  /** Hold delivery this long (a person's own "tell me after N minutes" rule). */
  delayMinutes?: number;
  /**
   * The run that produced this message. Without it, "the CEO received this alert — what
   * caused it?" was unanswerable, which is the one question the correlation id exists for.
   */
  correlationId?: string | undefined;
}

/**
 * Queue an outbound message. The worker delivers it — exactly-once from the
 * recipient's view via the UNIQUE idempotency_key. Business logic NEVER calls
 * Telegram directly; it writes here (the transactional outbox). A duplicate
 * enqueue of the same key is a no-op.
 *
 * A message on a channel that is not live is DROPPED here, and audited. `notify()` already
 * filters by `liveChannels()`, but several callers queue a channel directly — the
 * needs-review alert, attachment forwarding, project alerts — and would otherwise keep
 * posting to Telegram after the CEO had switched it off. One check, in the one place every
 * outbound message passes through, rather than four that can drift apart.
 */
export async function enqueueNotification(
  m: OutboxMessage,
): Promise<{ enqueued: boolean }> {
  const channel = m.channel ?? "telegram";
  if (!(await isChannelLive(channel))) {
    await logAudit({
      correlationId: m.correlationId,
      actor: "system",
      action: "notification.channel_disabled",
      entity: "notification_outbox",
      entityId: m.idempotencyKey,
      // The key, not the payload: this row says a message was not sent, and to whom — it is
      // not a copy of what the message said.
      detail: { channel, recipientEmployeeId: m.recipientEmployeeId ?? null, reason: m.reason ?? null },
    }).catch(() => {});
    return { enqueued: false };
  }
  const sql = getServiceSql();
  // Telegram ids fit in a JS number (< 2^53); postgres.js won't bind a raw bigint.
  const chatId = m.chatId == null ? null : Number(m.chatId);
  const delay = Math.max(0, Math.min(1440, Math.trunc(m.delayMinutes ?? 0)));
  const rows = await sql`
    insert into notification_outbox
      (idempotency_key, chat_id, payload, human_approved, is_synthetic,
       channel, recipient_employee_id, reason, correlation_id, next_attempt_at)
    values (${m.idempotencyKey}, ${chatId}, ${sql.json(m.payload as never)},
            ${m.humanApproved ?? false}, ${m.isSynthetic ?? false},
            ${channel}, ${m.recipientEmployeeId ?? null}, ${m.reason ?? null},
            ${m.correlationId ?? null}, now() + make_interval(mins => ${delay}))
    on conflict (idempotency_key) do nothing
    returning id`;
  return { enqueued: rows.length > 0 };
}
