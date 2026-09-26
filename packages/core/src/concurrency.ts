/**
 * A counting semaphore with a bounded wait queue.
 *
 * Processing updates concurrently does not by itself make a system scale — it moves the
 * bottleneck. Ten employees reporting at once become ten simultaneous model calls, and
 * the provider answers with 429s; ten simultaneous document parses, and Postgres is
 * starved of CPU on a box that has eight cores for everything.
 *
 * So concurrency is admitted deliberately, at a width this box can actually serve, and
 * everything else waits its turn. Waiting is the correct behaviour: an employee whose
 * message takes four seconds instead of two still gets an answer, whereas one whose
 * message is dropped has learned not to trust the bot.
 *
 * The queue itself is bounded (CLAUDE.md rule 4). An unbounded queue under sustained
 * overload is just a slower way to run out of memory, and it holds work so long that the
 * person has given up before it runs. Past the cap we fail fast and say so.
 */

export class QueueFullError extends Error {
  constructor(name: string, depth: number) {
    super(`${name} is saturated (${depth} already waiting)`);
    this.name = "QueueFullError";
  }
}

interface Waiter {
  resolve: () => void;
  reject: (e: Error) => void;
}

export class Semaphore {
  private active = 0;
  private readonly waiting: Waiter[] = [];

  /** Highest concurrent count seen, for the load report. */
  peakActive = 0;
  /** Deepest the wait queue has been. */
  peakWaiting = 0;
  /** How many were rejected because the queue was full. */
  rejected = 0;

  constructor(
    readonly name: string,
    readonly limit: number,
    readonly maxWaiting: number,
  ) {}

  get stats(): SemaphoreStats {
    return {
      active: this.active,
      waiting: this.waiting.length,
      peakActive: this.peakActive,
      peakWaiting: this.peakWaiting,
      rejected: this.rejected,
    };
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      this.peakActive = Math.max(this.peakActive, this.active);
      return Promise.resolve();
    }
    if (this.waiting.length >= this.maxWaiting) {
      this.rejected++;
      return Promise.reject(new QueueFullError(this.name, this.waiting.length));
    }
    return new Promise<void>((resolve, reject) => {
      this.waiting.push({ resolve, reject });
      this.peakWaiting = Math.max(this.peakWaiting, this.waiting.length);
    });
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) {
      // Hand the slot straight to the next waiter; `active` never drops, so a burst
      // cannot slip past the limit in the gap between one finishing and one starting.
      next.resolve();
      return;
    }
    this.active--;
  }

  /** Run `fn` once a slot is free. The slot is always released, including on throw. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/**
 * Sized to the PROVIDER's limit, not to this box's CPU.
 *
 * The original 6 was reasoned from the machine's shape, which was the wrong constraint by
 * a wide margin. Measured from Groq's own response headers on 2026-09-10:
 *
 *   x-ratelimit-limit-tokens:   8000   (per minute, on-demand tier)
 *   x-ratelimit-limit-requests: 1000   (per day)
 *
 * A document plan costs up to ~2 350 tokens, so six concurrent plans is ~14 000 tokens —
 * nearly 2x the per-minute budget. Under load the system 429'd, and because the client
 * had no backoff it burned both retries in milliseconds and fell through to a dead
 * fallback. That is not a hypothetical: it took out a full test run.
 *
 * Two therefore, so a burst cannot instantly blow the token budget, with `llmComplete`
 * now waiting on a 429 rather than failing over. On a paid tier with a higher TPM this
 * should be raised — it is a provider ceiling, not a code one.
 *
 * ── This cap is PER PROCESS, and two processes call the model ────────────────
 * The semaphore is in-process memory. The API (question box, document plans, web status
 * reports) and the bot (every employee message) each hold their own, so the real ceiling
 * against the provider is the SUM: with the default of 2 each, up to 4 concurrent calls,
 * twice what the paragraph above reasons for. The worker makes no model calls. An audit on
 * 2026-09-18 found the comment claiming a global bound it never had.
 *
 * `LLM_CONCURRENCY` sets the per-process limit. A truly global cap needs shared state (a
 * Redis counter, or Postgres advisory locks) and has deliberately not been added: it would
 * put a network round-trip in front of every model call and a new failure mode in the
 * path of an employee's message, to enforce a bound that the 429 backoff in `llmComplete`
 * already handles gracefully. Set the env var per process if the sum matters.
 */
const perProcessLimit = Math.max(1, Math.min(16, Number(process.env.LLM_CONCURRENCY ?? 2) || 2));
export const llmSemaphore = new Semaphore("model calls", perProcessLimit, 200);

/** Document work is far heavier than a chat turn — download, parse, then a large prompt. */
export const documentSemaphore = new Semaphore("document reads", 2, 50);

export interface SemaphoreStats {
  active: number;
  waiting: number;
  peakActive: number;
  peakWaiting: number;
  rejected: number;
}

/** A snapshot for the health endpoint, so saturation is observable rather than guessed. */
export function concurrencyStats(): Record<string, SemaphoreStats> {
  return {
    llm: llmSemaphore.stats,
    documents: documentSemaphore.stats,
  };
}
