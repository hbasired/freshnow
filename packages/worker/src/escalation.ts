import { Queue, Worker } from "bullmq";
import { escalateBlocker, getServiceSql } from "@freshnow/core";
import { redisConnection } from "./redis.js";

const QUEUE = "escalation";

let queue: Queue | undefined;
export function escalationQueue(): Queue {
  if (!queue) {
    queue = new Queue(QUEUE, { connection: redisConnection() });
    // A lost Redis connection is an "error" event; unheard, Node would exit (G174).
    queue.on("error", (err) => console.error(`[worker] escalation queue: ${err.message}`));
  }
  return queue;
}

/**
 * Arm a delayed escalation. The jobId is keyed by blocker, so arming twice is a
 * no-op (dedupe) and cancelling is a single remove. This is what makes "escalate
 * in N minutes unless acknowledged" survive a restart — a setTimeout would not.
 */
export async function armEscalation(blockerId: string, delayMs: number): Promise<void> {
  await escalationQueue().add(
    "escalate",
    { blockerId },
    { delay: delayMs, jobId: `esc-${blockerId}`, removeOnComplete: true, removeOnFail: true },
  );
}

/** Cancel a blocker's armed escalation (called when it is acknowledged/resolved). */
export async function cancelEscalation(blockerId: string): Promise<void> {
  const job = await escalationQueue().getJob(`esc-${blockerId}`);
  if (job) await job.remove();
}

/** Worker that, when a timer fires, escalates only if the blocker is still open. */
export function startEscalationWorker(): Worker {
  const worker = new Worker(
    QUEUE,
    async (job) => {
      const { blockerId } = job.data as { blockerId: string };
      const sql = getServiceSql();
      // Still open AND not already escalated. Escalating does not close a blocker, so
      // "status is open" alone is not enough: if the sweep got there first, this timer
      // would escalate the same blocker a second time and the CEO would be told twice.
      // `slaSweep` carries the same guard; both paths must, or neither is safe.
      const rows = await sql<{ status: string; already: boolean }[]>`
        select b.status,
               exists (select 1 from escalation e where e.blocker_id = b.id) as already
        from blocker b where b.id = ${blockerId}`;
      if (rows[0]?.status === "open" && !rows[0].already) {
        await escalateBlocker(blockerId, "SLA breach (timer)");
      }
    },
    { connection: redisConnection() },
  );
  worker.on("error", (err) => console.error(`[worker] escalation worker: ${err.message}`));
  return worker;
}

export async function closeEscalation(): Promise<void> {
  await queue?.close();
  queue = undefined;
}
