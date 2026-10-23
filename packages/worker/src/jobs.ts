import { Queue, Worker, type Job } from "bullmq";
import { describeDayCheck, inboxConfig, runAnalyticsStore } from "@freshnow/core";
import { pollInbox, retryUnreadEmails } from "./email-inbox.js";
import { redisConnection } from "./redis.js";
import { runTelevendSyncJob, televendSyncConfig, televendSyncMinutes } from "./televend-job.js";

/**
 * Background jobs that talk to the outside world, on BullMQ job schedulers (TASK-053).
 *
 * Why BullMQ here, when the outbox and the sweeps run in the worker's own loop: those are fast
 * database work. Reading a mailbox is not — an IMAP server can take a minute to answer, or
 * never. Inside the loop, one slow poll would stop every Telegram message, push and SLA
 * escalation behind it. As a scheduled job it runs beside the loop, and BullMQ adds what a
 * hand-written timer lacks:
 *   - one run at a time (concurrency 1; a scheduler adds the next job only as the last one
 *     is taken), so a slow poll is never overlapped by the next;
 *   - retries with exponential backoff, capped (CLAUDE.md rule 4), when the mail server fails;
 *   - the schedule is upserted by id — restarting the worker never stacks duplicate timers;
 *   - recent runs are kept (bounded), so a failure is inspectable rather than a log line.
 * Postgres stays the record: what a run did is in email_message and job_run, not in Redis.
 *
 * Started without being awaited: if Redis is down, the jobs wait for it and the worker's loop
 * — the thing that delivers messages — runs regardless.
 */

const QUEUE = "freshnow-background";

const JOB_OPTS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 15_000 },
  removeOnComplete: 50,
  removeOnFail: 100,
};

/**
 * One attempt per scheduled Televend run: the connector already retries inside a run (bounded,
 * with backoff), and the next scheduled run is the retry. Re-attempting here could re-send a
 * refused sign-in, which the connector refuses to do anyway (D181).
 */
const TELEVEND_JOB_OPTS = { ...JOB_OPTS, attempts: 1 };

export interface BackgroundJobs {
  queue: Queue;
  worker: Worker;
  close(): Promise<void>;
}

export async function startBackgroundJobs(): Promise<BackgroundJobs> {
  const queue = new Queue(QUEUE, { connection: redisConnection() });
  // BullMQ reports a lost Redis connection as an "error" event; unheard, Node would exit (G174).
  queue.on("error", (err) => console.error(`[worker] background queue: ${err.message}`));
  const cfg = inboxConfig();
  if (cfg) {
    await queue.upsertJobScheduler("email-poll", { every: cfg.pollSeconds * 1000 }, { name: "email-poll", opts: JOB_OPTS });
    await queue.upsertJobScheduler("email-retry", { every: 5 * 60_000 }, { name: "email-retry", opts: JOB_OPTS });
  } else {
    // Inbound email switched off since the last start: stop its schedules too.
    await queue.removeJobScheduler("email-poll");
    await queue.removeJobScheduler("email-retry");
  }
  // Televend (TASK-056): reading Televend can take a minute (paced at 1 request/second), so it
  // runs here beside the loop, one run at a time, never overlapping the next.
  if (televendSyncConfig()) {
    await queue.upsertJobScheduler("televend-sync", { every: televendSyncMinutes() * 60_000 }, { name: "televend-sync", opts: TELEVEND_JOB_OPTS });
    // The analytics store (TASK-071): every hour, build the days the daily check or a backfill has completed since. Database
    // work only — Televend is not contacted — and at most 31 days a run, so a long backfill is built over a few runs.
    await queue.upsertJobScheduler("analytics-store", { every: 60 * 60_000 }, { name: "analytics-store", opts: JOB_OPTS });
  } else {
    await queue.removeJobScheduler("televend-sync");
    await queue.removeJobScheduler("analytics-store");
  }

  const worker = new Worker(
    QUEUE,
    async (job: Job) => {
      switch (job.name) {
        case "email-poll": {
          const r = await pollInbox();
          if (r.fresh > 0 || r.errors > 0) console.log(`[worker] email inbox: ${r.fresh} new — ${JSON.stringify(r.outcomes)}${r.errors ? `, ${r.errors} error(s)` : ""}`);
          return r;
        }
        case "email-retry":
          return retryUnreadEmails();
        case "televend-sync": {
          const r = await runTelevendSyncJob();
          if (r) {
            console.log(
              `[worker] televend: ${r.vends.fresh} new vends, ${r.events.fresh} new / ${r.events.changed} updated events, ` +
                `${r.refills?.fresh ?? 0} new refills${r.dailyCheck ? ` · daily check ${r.dailyCheck.day}: ${describeDayCheck(r.dailyCheck)}` : ""}`,
            );
          }
          return r ? { vends: r.vends.fresh, events: r.events.fresh, refills: r.refills?.fresh ?? 0 } : null;
        }
        case "analytics-store": {
          const r = await runAnalyticsStore();
          if (r.built.length > 0 || r.failed.length > 0) {
            const differs = r.built.filter((b) => b.agrees === false).map((b) => b.day);
            console.log(
              `[worker] analytics store: built ${r.built.length} day(s)${differs.length ? ` — ${differs.join(", ")} differ from Televend's count` : ""}` +
                `${r.failed.length ? `, ${r.failed.length} failed (${r.failed.map((f) => f.day).join(", ")})` : ""}`,
            );
          }
          return { built: r.built.length, failed: r.failed.length };
        }
        default:
          throw new Error(`unknown job ${job.name}`);
      }
    },
    { connection: redisConnection(), concurrency: 1 },
  );
  worker.on("error", (err) => console.error(`[worker] background jobs: ${err.message}`));
  worker.on("failed", (job, err) => console.error(`[worker] job ${job?.name ?? "?"} failed (attempt ${job?.attemptsMade ?? "?"}): ${err.message}`));

  return {
    queue,
    worker,
    async close() {
      await worker.close();
      await queue.close();
    },
  };
}
