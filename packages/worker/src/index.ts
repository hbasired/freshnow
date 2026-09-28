import "dotenv/config";
import {
  CONSENT_POLICY_VERSION,
  loadConfig,
  noticeTag,
  projectSweep,
  requestConsentFromEveryone,
  retentionSweep,
  slaSweep,
  sweepUnroutedBlockers,
} from "@freshnow/core";
import { startEscalationWorker } from "./escalation.js";
import { deliverOutboxBatch, inAppSender , type Senders } from "./outbox-relay.js";
import { makeTelegramSender } from "./telegram-sender.js";
import { makeWebPushSender } from "./webpush-sender.js";
import { makeEmailSender } from "./email-sender.js";
import { makeChatSender } from "./chat-sender.js";

// The worker: deliver the outbox and escalate blockers whose SLA has expired.
//
// ── How escalation actually happens, stated plainly ──────────────────────────
//
// `slaSweep` is THE live mechanism. The BullMQ delayed-timer path in `escalation.ts`
// exists, has a running consumer, and is tested — but nothing ever ARMS it, because
// `armEscalation` lives in the worker while the code that routes a blocker lives in
// core, and core must not depend on the worker. So the timer is real but idle, and the
// bot used to tell the CEO "the escalation timer is cancelled", which was not true.
//
// Rather than invert that dependency, the sweep interval is tightened to 60s. Escalation
// is then at most a minute late instead of up to five, which for a 15-minute critical SLA
// is the difference that matters, and it costs one indexed query a minute. Arming the
// timer properly would mean moving the queue into core — worth doing if escalation ever
// needs to be exact, and recorded as not done rather than implied.
async function main(): Promise<void> {
  loadConfig();
  // One sender per channel. A channel with no sender here is never claimed by the relay,
  // so an unconfigured channel is inert rather than broken — and `channel_setting` decides
  // separately whether the company is using it at all.
  //
  // Each sender throws at construction when its keys are missing, which is why they are
  // built conditionally: the worker must start and keep delivering Telegram even when web
  // push has not been set up.
  //
  // Telegram is conditional too, since the company can run app-only (in-app inbox + web push,
  // `setDeliveryMode("app")`). A worker that refused to start without BOT_TOKEN made that
  // mode impossible to deploy: no token, no worker, no push, no SLA sweep.
  const senders: Senders = { inapp: inAppSender };
  if (process.env.BOT_TOKEN) {
    senders.telegram = makeTelegramSender();
    console.log("[worker] telegram sender ready");
  } else {
    console.log("[worker] no BOT_TOKEN — Telegram messages will not be delivered (app-only deployment)");
  }
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT) {
    senders.webpush = makeWebPushSender();
    console.log("[worker] web push sender ready");
  }
  if (process.env.SMTP_HOST && process.env.EMAIL_FROM) {
    senders.email = makeEmailSender();
    console.log("[worker] email sender ready");
  }
  if (process.env.CHAT_WEBHOOK_URL) {
    senders.chat = makeChatSender();
    console.log("[worker] chat sender ready");
  }
  startEscalationWorker();

  const intervalMs = Number(process.env.OUTBOX_POLL_MS ?? 3000);
  const sweepEveryMs = Number(process.env.SLA_SWEEP_MS ?? 60_000); // 1 min
  const projectSweepEveryMs = Number(process.env.PROJECT_SWEEP_MS ?? 3_600_000); // 1 hour
  let lastSweep = 0;
  let lastProjectSweep = 0;

  console.log(`[worker] outbox relay every ${intervalMs}ms; sla_sweep every ${sweepEveryMs}ms; project_sweep every ${projectSweepEveryMs}ms`);
  console.log(`[worker] consent notice ${CONSENT_POLICY_VERSION} (${noticeTag()}): anyone who has not agreed is asked, and their messages wait`);
  for (;;) {
    try {
      const r = await deliverOutboxBatch(senders);
      if (r.total > 0) {
        console.log(`[worker] outbox: sent=${r.sent} retried=${r.retried} abandoned=${r.abandoned}`);
      }
      if (Date.now() - lastSweep > sweepEveryMs) {
        lastSweep = Date.now();
        const s = await slaSweep();
        if (s.escalated > 0) console.log(`[worker] sla_sweep escalated ${s.escalated}`);
        // A blocker that failed routing has no SLA, so the sweep above cannot see it — it
        // would sit open forever with nobody told. This is the net below that.
        const u = await sweepUnroutedBlockers();
        if (u.found > 0) {
          console.log(`[worker] unrouted sweep: ${u.routed} routed, ${u.stillUnrouted} still unroutable`);
        }
        // Ask anyone who has not agreed to the notice as it reads today — once per version of
        // the words (the idempotency key carries it), so a new person linked since the last
        // run is asked within a minute and nobody is asked twice.
        const c = await requestConsentFromEveryone();
        if (c.enqueued > 0) console.log(`[worker] consent: asked ${c.people} person(s) to agree to notice ${CONSENT_POLICY_VERSION}`);
      }
      // Projects move in days, not minutes, and their sweep tells the same people the same
      // thing once per day (the date is in the idempotency key). Running it hourly is enough
      // to catch a date passing, and costs three indexed queries.
      if (Date.now() - lastProjectSweep > projectSweepEveryMs) {
        lastProjectSweep = Date.now();
        const p = await projectSweep();
        if (p.milestonesOverdue + p.projectsStale + p.issuesOverdue > 0) {
          console.log(`[worker] project_sweep: ${p.milestonesOverdue} milestone(s) overdue, ${p.projectsStale} stale, ${p.issuesOverdue} issue(s) past date`);
        }
        // PDPL retention. Does nothing until RETENTION_DAYS is set — that number is the data
        // controller's decision, not a developer default — and says so once per hour so an
        // unset window is a visible state, not a silent one.
        const r = await retentionSweep();
        if (!r.enabled) console.log("[worker] retention sweep: disabled (RETENTION_DAYS not set) — free text is kept indefinitely");
        else if (r.notesAged > 0) console.log(`[worker] retention sweep: aged out ${r.notesAged} note(s) older than ${r.days} days`);
      }
    } catch (err) {
      console.error("[worker] loop error", err);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
