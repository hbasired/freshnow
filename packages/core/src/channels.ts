import { logAudit } from "./audit.js";
import { getServiceSql } from "./db.js";

/**
 * Whether a channel may carry a message, and why not when it may not.
 *
 * Three gates, and all three must be open. They answer different questions and belong to
 * different people, which is exactly why they are separate:
 *
 *   1. AVAILABLE — does this deployment have the keys and the infrastructure? A developer's
 *      answer, in the environment. No VAPID keys, no web push; no SMTP host, no email.
 *   2. ENABLED — is the company using this channel? The CEO's answer, in `channel_setting`,
 *      flipped in the dashboard and written to the audit log. A channel can be perfectly
 *      configured and still be off because nobody has decided to use it yet.
 *   3. PREFERRED — does this person want it? Their answer, in `notification_pref`
 *      (`alerts.ts`): opt-out for Telegram, opt-in for everything except the in-app inbox.
 *
 * The order matters for the error message. "Web push is not configured on this server" and
 * "the company has not switched web push on" are different problems with different fixes,
 * and a toggle that silently does nothing is worse than a toggle that says which it is.
 */

/** Every channel the outbox understands. `inapp` has no sender — the row is the message. */
export const CHANNELS = ["telegram", "inapp", "email", "webpush", "chat"] as const;
export type Channel = (typeof CHANNELS)[number];

export interface ChannelState {
  channel: Channel;
  /** Configured on this box: the keys and the URLs exist. */
  available: boolean;
  /** The company has switched it on. */
  enabled: boolean;
  /** Both of the above — the only thing the sending path cares about. */
  live: boolean;
  /** Plain English, for the dashboard. Empty when the channel is live. */
  why: string;
}

/**
 * Is this channel configured on this machine? Reads the environment directly rather than
 * `loadConfig()`, following `retentionDays()` and `langfuseConfig()` — a missing optional
 * key must never throw, and `loadConfig()` runs on every model call (gotcha G97).
 */
export function channelAvailability(channel: Channel, env: NodeJS.ProcessEnv = process.env): { available: boolean; why: string } {
  switch (channel) {
    case "telegram":
      return env.BOT_TOKEN
        ? { available: true, why: "" }
        : { available: false, why: "No BOT_TOKEN — the bot is not configured on this server." };
    case "inapp":
      // Nothing to configure: the notification_outbox row IS the notification, and the
      // dashboard reads it. This is the one channel that cannot fail for want of a key.
      return { available: true, why: "" };
    case "email":
      return env.SMTP_HOST && env.EMAIL_FROM
        ? { available: true, why: "" }
        : { available: false, why: "No SMTP_HOST / EMAIL_FROM — see docs/EMAIL-SETUP-GUIDE.md." };
    case "webpush":
      return env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT
        ? { available: true, why: "" }
        : { available: false, why: "No VAPID keys — run `npx web-push generate-vapid-keys` and put them in .env." };
    case "chat":
      return env.CHAT_WEBHOOK_URL
        ? { available: true, why: "" }
        : { available: false, why: "No CHAT_WEBHOOK_URL — see docs/MATTERMOST-SETUP-GUIDE.md." };
  }
}

/** Every channel with both gates resolved, for the dashboard's Channels card. */
export async function channelStates(): Promise<ChannelState[]> {
  const sql = getServiceSql();
  const rows = await sql<{ channel: string; enabled: boolean }[]>`
    select channel, enabled from channel_setting`;
  const enabledBy = new Map(rows.map((r) => [r.channel, r.enabled]));
  return CHANNELS.map((channel) => {
    const { available, why } = channelAvailability(channel);
    const enabled = enabledBy.get(channel) ?? false;
    const live = available && enabled;
    return {
      channel,
      available,
      enabled,
      live,
      why: live ? "" : !available ? why : "Configured, but the company has not switched it on.",
    };
  });
}

/**
 * The channels a message may actually go out on. This replaces the environment-only check
 * that used to live in `alerts.ts`: a person's "email me" preference now produces no row at
 * all unless email is both configured AND switched on, rather than a row that waits for a
 * sender that will never come.
 */
export async function liveChannels(): Promise<readonly Channel[]> {
  const states = await channelStates();
  return states.filter((s) => s.live).map((s) => s.channel);
}

/** Is this one channel live? Used by the outbox as a last check before a row is written. */
export async function isChannelLive(channel: string): Promise<boolean> {
  if (!(CHANNELS as readonly string[]).includes(channel)) return false;
  const { available } = channelAvailability(channel as Channel);
  if (!available) return false;
  const sql = getServiceSql();
  const rows = await sql<{ enabled: boolean }[]>`
    select enabled from channel_setting where channel = ${channel}`;
  return rows[0]?.enabled ?? false;
}

/**
 * Switch a channel on or off. The CEO's decision, so it is audited with their id — "who
 * turned email on, and when" is a question that gets asked after the first complaint about
 * an unexpected message. Permission is checked by the caller: core writes run as the
 * BYPASSRLS service role and Postgres will not refuse them.
 */
export async function setChannelEnabled(p: {
  channel: Channel;
  enabled: boolean;
  by: string;
  correlationId?: string;
}): Promise<ChannelState> {
  const sql = getServiceSql();
  const before = await sql<{ enabled: boolean }[]>`
    select enabled from channel_setting where channel = ${p.channel}`;
  if (!before[0]) throw new Error(`unknown channel ${p.channel}`);

  await sql`
    update channel_setting set enabled = ${p.enabled}, updated_by = ${p.by}, updated_at = now()
    where channel = ${p.channel}`;

  await logAudit({
    correlationId: p.correlationId,
    actor: `employee:${p.by}`,
    action: "channel.toggled",
    entity: "channel_setting",
    entityId: p.channel,
    detail: { before: before[0].enabled, after: p.enabled },
  });

  const { available, why } = channelAvailability(p.channel);
  const live = available && p.enabled;
  return {
    channel: p.channel,
    available,
    enabled: p.enabled,
    live,
    why: live ? "" : !available ? why : "Configured, but the company has not switched it on.",
  };
}
