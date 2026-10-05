import { Queue, Worker, type Job } from "bullmq";
import { inboxConfig } from "@freshnow/core";
import { pollInbox, retryUnreadEmails } from "./email-inbox.js";

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

function connection(): { host: string; port: number; maxRetriesPerRequest: null } {
  const url = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
  return { host: url.hostname, port: Number(url.port || 6379), maxRetriesPerRequest: null };
}

const JOB_OPTS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 15_000 },
  removeOnComplete: 50,
  removeOnFail: 100,
};

export interface BackgroundJobs {
  queue: Queue;
  worker: Worker;
  close(): Promise<void>;
}

export async function startBackgroundJobs(): Promise<BackgroundJobs> {
  const queue = new Queue(QUEUE, { connection: connection() });
  const cfg = inboxConfig();
  if (cfg) {
    await queue.upsertJobScheduler("email-poll", { every: cfg.pollSeconds * 1000 }, { name: "email-poll", opts: JOB_OPTS });
    await queue.upsertJobScheduler("email-retry", { every: 5 * 60_000 }, { name: "email-retry", opts: JOB_OPTS });
  } else {
    // Inbound email switched off since the last start: stop its schedules too.
    await queue.removeJobScheduler("email-poll");
    await queue.removeJobScheduler("email-retry");
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
        default:
          throw new Error(`unknown job ${job.name}`);
      }
    },
    { connection: connection(), concurrency: 1 },
  );
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
