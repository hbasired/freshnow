import webpush from "web-push";
import { deletePushSubscription, markPushDelivered, pushSubscriptionsFor } from "@freshnow/core";
import { RateLimitError, type Deliverer } from "./outbox-relay.js";

/**
 * Deliver an outbox row to every browser a person has subscribed.
 *
 * Two things make this different from the Telegram sender:
 *
 *   * ONE ROW, MANY DEVICES. A person with a phone and a laptop has two subscriptions and
 *     both should buzz. The row is "sent" if any device accepted it — a dead laptop must
 *     not make the queue retry a notification the phone already showed.
 *
 *   * A 404 OR 410 IS PERMANENT AND MEANS DELETE. The push service is telling us the
 *     browser is gone — uninstalled, cleared, expired. Retrying is pointless and the
 *     subscription would otherwise sit there failing forever. This is the single most
 *     commonly skipped part of a web-push implementation.
 *
 * The payload is encrypted to the device's own keys (RFC 8291) before it leaves this
 * process, so Google, Apple or Mozilla carry ciphertext they cannot read.
 */

const SEND_TIMEOUT_MS = 20_000;

/**
 * The one call that reaches the network. Injectable because `web-push` speaks HTTPS and
 * only HTTPS — it `require`s the https module directly — so a test cannot stand a plain
 * HTTP server in front of it without a certificate. Everything this file actually decides
 * (fan out to every device, delete on 410, back off on 429, succeed when there is nobody
 * to tell) is above this line and is tested for real against a real database.
 *
 * What our tests therefore do NOT cover: the payload encryption and the HTTP transport,
 * both of which belong to `web-push`.
 */
export type PushTransport = (
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  body: string,
  opts?: { urgent: boolean },
) => Promise<unknown>;

interface PushPayload {
  title?: string;
  text?: string;
  url?: string;
  tag?: string;
  urgent?: boolean;
}

export function makeWebPushSender(transport?: PushTransport): Deliverer {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  // Fail at construction, not at the first message: a worker that starts and then silently
  // drops every push is worse than one that refuses to start.
  if (!publicKey || !privateKey || !subject) {
    throw new Error("Web push needs VAPID_SUBJECT, VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY — run `npx web-push generate-vapid-keys`");
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  // Urgency is the RFC 8030 header the push service reads to decide whether to wake a
  // sleeping phone now or batch the message for its next wake-up (Android Doze, iOS low
  // power). A blocker is the one thing here that should not wait for the phone's
  // convenience; everything else asks for "normal" and saves the recipient's battery.
  const send: PushTransport =
    transport ??
    ((sub, body, opts) =>
      webpush.sendNotification(sub, body, {
        TTL: 3600,
        timeout: SEND_TIMEOUT_MS,
        urgency: opts?.urgent ? "high" : "normal",
      }));

  return async ({ payload, recipientEmployeeId }) => {
    if (!recipientEmployeeId) throw new Error("web push needs a recipient_employee_id");
    const subs = await pushSubscriptionsFor(recipientEmployeeId);
    // Nobody on this channel: succeed rather than retry forever. The person turned their
    // devices off between the message being queued and the worker reaching it.
    if (subs.length === 0) return;

    const p = (payload ?? {}) as PushPayload;
    const body = JSON.stringify({
      title: p.title ?? "FreshNow",
      body: p.text ?? "",
      url: p.url ?? "/app/",
      ...(p.tag ? { tag: p.tag } : {}),
      ...(p.urgent ? { urgent: true } : {}),
    });

    let delivered = 0;
    let rateLimited: RateLimitError | null = null;
    let lastError: Error | null = null;

    for (const sub of subs) {
      try {
        await send({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, body, { urgent: p.urgent === true });
        delivered++;
        await markPushDelivered(sub.endpoint).catch(() => {});
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          // Gone for good. Delete it; this is not a failure of the message.
          await deletePushSubscription({ endpoint: sub.endpoint, reason: `push service returned ${status}` }).catch(() => {});
          continue;
        }
        if (status === 429) {
          const retryAfter = Number((err as { headers?: Record<string, string> }).headers?.["retry-after"]);
          rateLimited = new RateLimitError("Web push 429", Number.isFinite(retryAfter) ? retryAfter : undefined);
          continue;
        }
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }

    if (delivered > 0) return;
    // Every device that still exists rate-limited us: back off rather than burn an attempt.
    if (rateLimited) throw rateLimited;
    if (lastError) throw lastError;
    // Every subscription was stale and has now been deleted. There is nobody to tell, and
    // retrying would only delete nothing again — treat it as delivered-to-nobody.
  };
}
