import { RateLimitError, type Deliverer } from "./outbox-relay.js";

/**
 * Deliver an outbox row to a company chat server through an incoming webhook.
 *
 * No dependency and no vendor: an incoming webhook is a URL you POST JSON to, and
 * Mattermost, Rocket.Chat and anything Slack-compatible accept the same `{ text }` shape.
 * Standing the server up is a separate decision — see docs/MATTERMOST-SETUP-GUIDE.md —
 * and nothing here runs until `CHAT_WEBHOOK_URL` is set and the CEO switches the channel on.
 *
 * Note what this channel is NOT: it posts to a channel or a hook, not to a person. It is
 * for a team room ("#ops-alerts"), which is why it carries the same text as the in-app
 * inbox rather than anything addressed to an individual.
 */

const SEND_TIMEOUT_MS = 20_000;

interface ChatPayload {
  title?: string;
  text?: string;
  url?: string;
}

export function makeChatSender(): Deliverer {
  const url = process.env.CHAT_WEBHOOK_URL;
  if (!url) throw new Error("The chat channel needs CHAT_WEBHOOK_URL — see docs/MATTERMOST-SETUP-GUIDE.md");

  return async ({ payload }) => {
    const p = (payload ?? {}) as ChatPayload;
    const link = p.url ? ` ${new URL(p.url, process.env.PUBLIC_URL ?? "http://localhost:3001").toString()}` : "";
    const text = [p.title ? `**${p.title}**` : null, p.text, link.trim() || null].filter(Boolean).join("\n");

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      // Without this the worker waits forever inside the relay's open transaction, holding
      // row locks — the failure that cost the Telegram sender a 20-second fix (G95).
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"));
      throw new RateLimitError("Chat webhook 429", Number.isFinite(retryAfter) ? retryAfter : undefined);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Chat webhook ${res.status}: ${body.slice(0, 200)}`);
    }
  };
}
