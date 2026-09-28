import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ALERT_EVENT_TYPES,
  CHANNELS,
  ConsentNoticeChangedError,
  DELIVERY_MODES,
  DeliveryModeError,
  PREF_MODES,
  addTaskWatcher,
  consentNotice,
  channelStates,
  consentStatus,
  deletePushSubscription,
  deliveryModeOf,
  enqueueNotification,
  isChannelLive,
  noticeHash,
  pushSubscriptionsFor,
  recordConsent,
  setDeliveryMode,
  withdrawConsent,
  listMyDevices,
  loadEscalationLadder,
  markNotificationsRead,
  removeTaskWatcher,
  savePushSubscription,
  setChannelEnabled,
  setNotificationPref,
  withContext,
  type AlertEventType,
  type Channel,
  type DeliveryMode,
} from "@freshnow/core";
import { forbid, resolveViewer } from "../viewer.js";

/**
 * Who was told, what, and why — read back; plus the few things a person may change about
 * how they are told. Every list here is RLS-scoped: a person's inbox is their own rows,
 * alerts are visible to whoever may see the person they are about, and the escalation
 * ladder is configuration anyone may read.
 */

const IdParams = z.object({ id: z.string().uuid() });
const ReadBody = z.object({ ids: z.array(z.string().uuid()).max(200).optional() });
const PrefBody = z.object({
  eventType: z.enum(ALERT_EVENT_TYPES as [AlertEventType, ...AlertEventType[]]),
  channel: z.enum(["telegram", "email", "webpush", "chat"]),
  mode: z.enum(PREF_MODES),
  delayMinutes: z.number().int().min(0).max(1440).optional(),
});
const ChannelBody = z.object({
  channel: z.enum(CHANNELS as unknown as [Channel, ...Channel[]]),
  enabled: z.boolean(),
});
/** What `PushSubscription.toJSON()` gives the browser, which is what we store. */
const PushBody = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(200) }),
  userAgent: z.string().max(300).optional(),
});
const PushDeleteBody = z.object({ endpoint: z.string().url().max(2000) });
const ModeBody = z.object({ mode: z.enum(DELIVERY_MODES as unknown as [DeliveryMode, ...DeliveryMode[]]) });
const ConsentBody = z.object({ noticeHash: z.string().regex(/^[0-9a-f]{64}$/) });
const InboxQuery = z.object({ unread: z.enum(["1", "0"]).optional(), limit: z.coerce.number().int().min(1).max(100).optional() });

export function registerAlertRoutes(app: FastifyInstance): void {
  /** The viewer's in-app inbox: one row per thing they were told, with the rule that chose them. */
  app.get("/dashboard/notifications", async (req) => {
    const viewer = await resolveViewer(req);
    const q = InboxQuery.parse(req.query ?? {});
    const limit = q.limit ?? 50;
    const rows = await withContext(viewer, (sql) => sql<
      { id: string; created_at: Date; read_at: Date | null; reason: string | null; status: string; payload: { text?: string; kind?: string; blockerId?: string; taskId?: string; assignmentId?: string; level?: number } }[]
    >`
      select id, created_at, read_at, reason, status, payload
      from notification_outbox
      where channel = 'inapp' and recipient_employee_id = ${viewer.employeeId}
        ${q.unread === "1" ? sql`and read_at is null` : sql``}
      order by created_at desc
      limit ${limit}`);
    const unread = await withContext(viewer, (sql) => sql<{ n: number }[]>`
      select count(*)::int as n from notification_outbox
      where channel = 'inapp' and recipient_employee_id = ${viewer.employeeId} and read_at is null`);
    return {
      unread: unread[0]?.n ?? 0,
      items: rows.map((r) => ({
        id: r.id,
        at: r.created_at,
        readAt: r.read_at,
        reason: r.reason,
        text: r.payload?.text ?? "",
        kind: r.payload?.kind ?? null,
        blockerId: r.payload?.blockerId ?? null,
        taskId: r.payload?.taskId ?? null,
        level: r.payload?.level ?? null,
      })),
    };
  });

  /** Mark some (or all) of the viewer's own notifications read. */
  app.post("/dashboard/notifications/read", async (req) => {
    const viewer = await resolveViewer(req);
    const body = ReadBody.parse(req.body ?? {});
    return markNotificationsRead({ employeeId: viewer.employeeId, ...(body.ids ? { ids: body.ids } : {}) });
  });

  /** Open alerts the viewer may see: one row per problem, however many times it was reported. */
  app.get("/dashboard/alerts", async (req) => {
    const viewer = await resolveViewer(req);
    const rows = await withContext(viewer, (sql) => sql<
      {
        id: string; alias: string; kind: string; entity_id: string; state: string; count: number;
        first_seen: Date; last_seen: Date; acked_at: Date | null; acked_by_name: string | null;
        about_name: string | null; category: string | null; severity: string | null; asset: string | null;
        level: number | null;
      }[]
    >`
      select a.id, a.alias, a.kind, a.entity_id, a.state, a.count, a.first_seen, a.last_seen, a.acked_at,
             employee_display_name(a.acked_by) as acked_by_name,
             employee_display_name(a.employee_id) as about_name,
             b.category, b.severity, b.affected_asset as asset,
             (select max(level) from escalation e where e.blocker_id = b.id) as level
      from alert a
      left join blocker b on b.id::text = a.entity_id
      where a.state <> 'resolved'
      order by a.last_seen desc
      limit 50`);
    return rows.map((r) => ({
      id: r.id,
      state: r.state,
      count: r.count,
      blockerId: r.kind === "blocker" ? r.entity_id : null,
      about: r.about_name,
      category: r.category,
      severity: r.severity,
      asset: r.asset,
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
      ackedAt: r.acked_at,
      ackedBy: r.acked_by_name,
      escalationLevel: r.level,
    }));
  });

  /** The default ladder, for display: who is told at each rung and after how long. */
  app.get("/dashboard/escalation-policy", async (req) => {
    await resolveViewer(req);
    const ladder = await loadEscalationLadder();
    return ladder.map((l) => ({
      level: l.levelNo,
      afterMinutes: l.timeoutMinutes,
      targets: l.targets.map((t) => t.type),
    }));
  });

  /** SLA windows per severity, for display. */
  app.get("/dashboard/sla-policy", async (req) => {
    const viewer = await resolveViewer(req);
    const rows = await withContext(viewer, (sql) => sql<{ severity: string; minutes: number }[]>`
      select severity, minutes from sla_policy
      order by case severity when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end`);
    return rows;
  });

  /** The viewer's own notification rules. */
  app.get("/dashboard/me/notification-prefs", async (req) => {
    const viewer = await resolveViewer(req);
    const rows = await withContext(viewer, (sql) => sql<{ event_type: string; channel: string; mode: string; delay_minutes: number }[]>`
      select event_type, channel, mode, delay_minutes from notification_pref
      where employee_id = ${viewer.employeeId} order by event_type, channel`);
    return { events: ALERT_EVENT_TYPES, prefs: rows.map((r) => ({ eventType: r.event_type, channel: r.channel, mode: r.mode, delayMinutes: r.delay_minutes })) };
  });

  /** Set one of the viewer's own rules. Nobody sets anyone else's. */
  app.put("/dashboard/me/notification-prefs", async (req) => {
    const viewer = await resolveViewer(req);
    const body = PrefBody.parse(req.body);
    await setNotificationPref({
      employeeId: viewer.employeeId,
      eventType: body.eventType,
      channel: body.channel,
      mode: body.mode,
      ...(body.delayMinutes !== undefined ? { delayMinutes: body.delayMinutes } : {}),
      correlationId: req.correlationId,
    });
    return { ok: true };
  });

  /**
   * Which channels exist, whether each is configured, whether the company has switched it
   * on, and — when it is not live — which of the two is missing. Readable by anyone,
   * because the dashboard explains to each person why an option is or is not offered, and
   * that explanation would be a lie if the state were hidden.
   */
  app.get("/dashboard/channels", async () => {
    const channels = await channelStates();
    return { channels, mode: deliveryModeOf(channels) };
  });

  /**
   * The one toggle: Telegram, Telegram + app, or app only. Sets the underlying switches
   * (each audited as `channel.toggled`) plus one `channel.mode_set` row for the decision.
   * 409 when "app only" is asked for on a server without web push — see setDeliveryMode.
   */
  app.put("/dashboard/channels/mode", async (req, reply) => {
    const viewer = await resolveViewer(req);
    if (!viewer.isCeo) return forbid(req, reply, "Only the CEO can change how the company sends messages");
    const body = ModeBody.parse(req.body);
    try {
      return await setDeliveryMode({ mode: body.mode, by: viewer.employeeId, correlationId: req.correlationId });
    } catch (err) {
      if (err instanceof DeliveryModeError) {
        return reply.code(409).send({ error: { code: "conflict", message: err.message, correlationId: req.correlationId } });
      }
      throw err;
    }
  });

  /**
   * Switch a channel on or off. The CEO's decision: it changes what every employee
   * receives, so it should have exactly one author, and it is audited with their id.
   */
  app.put("/dashboard/channels", async (req, reply) => {
    const viewer = await resolveViewer(req);
    if (!viewer.isCeo) return forbid(req, reply, "Only the CEO can switch a channel on or off");
    const body = ChannelBody.parse(req.body);
    const state = await setChannelEnabled({
      channel: body.channel,
      enabled: body.enabled,
      by: viewer.employeeId,
      correlationId: req.correlationId,
    });
    return reply.send(state);
  });

  /**
   * Register this browser for push. Self-only and needs no permission check: the resource
   * is the viewer's own device, exactly like their notification preferences. The endpoint
   * is the push service's URL for this browser — re-subscribing returns the same one, so
   * this is safe to call on every load.
   */
  app.post("/dashboard/me/push-subscriptions", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const body = PushBody.parse(req.body);
    const r = await savePushSubscription(
      {
        employeeId: viewer.employeeId,
        endpoint: body.endpoint,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
        userAgent: body.userAgent ?? (req.headers["user-agent"] ?? null),
      },
      req.correlationId,
    );
    return reply.code(201).send(r);
  });

  /** Turn this device off. A person may only remove their own. */
  app.delete("/dashboard/me/push-subscriptions", async (req) => {
    const viewer = await resolveViewer(req);
    const body = PushDeleteBody.parse(req.body);
    return deletePushSubscription({ employeeId: viewer.employeeId, endpoint: body.endpoint, reason: "the person turned it off" });
  });

  /**
   * Send a test notification to the viewer's own devices — the demo button, and the first
   * thing to try when somebody says "my phone never buzzes". Goes through the real outbox
   * and the real worker, so a banner proves the whole path rather than the browser alone.
   * Self-only, and the key is bucketed to ten seconds so a held-down button sends one.
   */
  app.post("/dashboard/me/push-test", async (req, reply) => {
    const viewer = await resolveViewer(req);
    if (!(await isChannelLive("webpush"))) {
      return reply.code(409).send({
        error: { code: "conflict", message: "Web push is not live — it needs VAPID keys on the server and the CEO's switch on.", correlationId: req.correlationId },
      });
    }
    if ((await pushSubscriptionsFor(viewer.employeeId)).length === 0) {
      return reply.code(409).send({
        error: { code: "conflict", message: "No device is turned on for you yet — tap “Turn on for this device” first.", correlationId: req.correlationId },
      });
    }
    const bucket = Math.floor(Date.now() / 10_000);
    const r = await enqueueNotification({
      idempotencyKey: `push-test:${viewer.employeeId}:${bucket}`,
      channel: "webpush",
      recipientEmployeeId: viewer.employeeId,
      reason: "you asked for a test",
      correlationId: req.correlationId,
      payload: {
        kind: "test",
        title: "FreshNow test notification",
        text: "If you can read this, notifications reach this device — even with the app closed.",
        url: "/app/#tasks/alerts",
        tag: "push-test",
      },
    });
    return reply.code(202).send({ queued: r.enqueued });
  });

  /**
   * The viewer's consent state, with the exact notice the app shows and its hash. The hash
   * travels back on accept so what is recorded is provably what was on screen. It is the same
   * notice the bot shows (consent.ts) — one set of words, whichever door a person uses.
   */
  app.get("/dashboard/me/consent", async (req) => {
    const viewer = await resolveViewer(req);
    const notice = consentNotice("en");
    return { ...(await consentStatus(viewer.employeeId)), notice, noticeHash: noticeHash(notice) };
  });

  app.post("/dashboard/me/consent", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const body = ConsentBody.parse(req.body);
    try {
      return await recordConsent({ employeeId: viewer.employeeId, noticeHash: body.noticeHash, via: "app", correlationId: req.correlationId });
    } catch (err) {
      if (err instanceof ConsentNoticeChangedError) {
        return reply.code(409).send({ error: { code: "conflict", message: err.message, correlationId: req.correlationId } });
      }
      throw err;
    }
  });

  /**
   * Withdraw consent — the app's equivalent of the bot's /withdraw, with the same effect:
   * the person is disabled, nothing more is collected, and history is kept (erasure is a
   * separate, CEO-run step). The CEO cannot do this to themselves here: it would lock the
   * company out of its own system, and handing over the role is an erasure-and-handover
   * decision, not a button.
   */
  app.post("/dashboard/me/consent/withdraw", async (req, reply) => {
    const viewer = await resolveViewer(req);
    if (viewer.isCeo) return forbid(req, reply, "The CEO account cannot withdraw here — hand the CEO role to someone else first");
    await withdrawConsent(viewer.employeeId);
    return { withdrawn: true };
  });

  /** The viewer's own devices, so they can see what is subscribed and revoke one. */
  app.get("/dashboard/me/devices", async (req) => {
    const viewer = await resolveViewer(req);
    return { devices: await listMyDevices(viewer.employeeId) };
  });

  /** Follow a task the viewer can see; unfollow it. Watching is always about yourself. */
  app.post("/dashboard/tasks/:id/watch", async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const viewer = await resolveViewer(req);
    const visible = await withContext(viewer, (sql) => sql`select 1 from task where id = ${id}`);
    if (!visible[0]) return forbid(req, reply, "That task is not visible to you");
    return addTaskWatcher({ taskId: id, employeeId: viewer.employeeId });
  });

  app.delete("/dashboard/tasks/:id/watch", async (req) => {
    const { id } = IdParams.parse(req.params);
    const viewer = await resolveViewer(req);
    await removeTaskWatcher({ taskId: id, employeeId: viewer.employeeId });
    return { ok: true };
  });

  /** Who follows a task (RLS: the viewer sees watchers of tasks they may see). */
  app.get("/dashboard/tasks/:id/watchers", async (req) => {
    const { id } = IdParams.parse(req.params);
    const viewer = await resolveViewer(req);
    const rows = await withContext(viewer, (sql) => sql<{ employee_id: string; reason: string; name: string }[]>`
      select w.employee_id, w.reason, employee_display_name(w.employee_id) as name
      from task_watcher w where w.task_id = ${id} order by w.created_at`);
    return rows.map((r) => ({ employeeId: r.employee_id, reason: r.reason, name: r.name, me: r.employee_id === viewer.employeeId }));
  });
}
