import { randomUUID } from "node:crypto";

/**
 * Langfuse tracing for LLM calls — optional, off by default, and incapable of breaking a
 * model call.
 *
 * ── Why there is no SDK here ─────────────────────────────────────────────────
 * Langfuse publishes an HTTP ingestion endpoint that takes a batch of JSON events with basic
 * auth. That is all this needs. Adding the SDK would mean a dependency (and its transitive
 * tree) on a box where every process competes with Postgres for 8 shared vCPUs, to wrap one
 * `fetch`. `CLAUDE.md`: do not add dependencies without a stated reason.
 *
 * ── The privacy decision ─────────────────────────────────────────────────────
 * Prompts here contain employees' own words — what they typed about their shift, in Hindi,
 * Malayalam or English. Sending that to an observability tool is a data-protection decision,
 * not a technical one, so it is OFF unless somebody turns it on deliberately:
 *
 *   LANGFUSE_CAPTURE_CONTENT unset  → model, provider, tokens, cost, latency, success.
 *                                     Useful for every question about cost and reliability.
 *   LANGFUSE_CAPTURE_CONTENT=1      → the above plus prompt and completion text.
 *
 * With content capture on and a hosted Langfuse, employee free text leaves the company. That
 * needs the same lawful basis, notice and consent as any other processing (see
 * `uae-compliance`), which is why the default is the one that cannot create that problem.
 *
 * ── It can never break a model call ──────────────────────────────────────────
 * Every send is fire-and-forget behind its own short timeout, failures are counted and never
 * thrown, and the queue is bounded — a Langfuse outage costs observability, never an
 * employee's update.
 */

export interface LangfuseConfig {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
  captureContent: boolean;
  release?: string | undefined;
}

/** Events pile up here and are flushed in batches; bounded so an outage cannot grow it. */
const MAX_QUEUE = 200;
/** Long enough to batch a burst, short enough that a trace appears while you are looking. */
const FLUSH_INTERVAL_MS = 2_000;
/** A tracing call must never hold up anything. */
const SEND_TIMEOUT_MS = 5_000;

interface IngestionEvent {
  id: string;
  type: string;
  timestamp: string;
  body: Record<string, unknown>;
}

let queue: IngestionEvent[] = [];
let timer: ReturnType<typeof setInterval> | undefined;
let dropped = 0;
let failed = 0;
let sent = 0;

/**
 * Read the configuration from the environment. Returns null — meaning "tracing is off" —
 * unless both keys are present, so the feature is opt-in by configuration rather than by a
 * flag somebody has to remember.
 */
export function langfuseConfig(): LangfuseConfig | null {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) return null;
  return {
    // Self-hosted by default: the instance on this machine, where nothing leaves the box.
    baseUrl: (process.env.LANGFUSE_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, ""),
    publicKey,
    secretKey,
    captureContent: process.env.LANGFUSE_CAPTURE_CONTENT === "1",
    release: process.env.LANGFUSE_RELEASE,
  };
}

export function isTracingEnabled(): boolean {
  return langfuseConfig() !== null;
}

function enqueue(event: IngestionEvent): void {
  if (queue.length >= MAX_QUEUE) {
    // Drop rather than grow without bound. Observability is the thing that may be lost here.
    dropped++;
    return;
  }
  queue.push(event);
  timer ??= setInterval(() => void flushTraces(), FLUSH_INTERVAL_MS);
  // Never hold the process open for a trace: the flush timer is not a reason to stay alive.
  timer.unref?.();
}

/**
 * What a model call looked like. Content fields are only read when capture is switched on,
 * so a caller may always pass them and the policy is applied in exactly one place.
 */
export interface TracedCall {
  correlationId?: string | undefined;
  /** What this call was for — "parse_update", "plan_document". Becomes the trace name. */
  operation: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  latencyMs: number;
  success: boolean;
  attempt: number;
  /** Only sent when LANGFUSE_CAPTURE_CONTENT=1. */
  input?: unknown;
  /** Only sent when LANGFUSE_CAPTURE_CONTENT=1. */
  output?: string | undefined;
  /** Why it failed, when it did. Never contains employee text. */
  errorMessage?: string | undefined;
}

/**
 * Record one model call as a Langfuse trace with a single generation inside it.
 *
 * The trace id is derived from the correlation id when there is one, so every model call made
 * during one run — a parse, a retry on a fallback provider, a summary — lands under the same
 * trace and can be read as one story. That is the whole reason this is worth having: the
 * `llm_call` table already answers "what did it cost", but not "what happened, in order".
 */
export function traceLlmCall(call: TracedCall): void {
  const cfg = langfuseConfig();
  if (!cfg) return;

  const traceId = call.correlationId ?? randomUUID();
  const now = new Date();
  const startedAt = new Date(now.getTime() - call.latencyMs);

  // Idempotent per (run, provider, model, attempt): re-tracing the same call overwrites
  // rather than duplicating, which matters because the retry path can call this twice.
  const observationId = `${traceId}-${call.provider}-${call.model}-${call.attempt}`.slice(0, 200);

  enqueue({
    id: randomUUID(),
    type: "trace-create",
    timestamp: now.toISOString(),
    body: {
      id: traceId,
      name: call.operation,
      timestamp: startedAt.toISOString(),
      ...(cfg.release ? { release: cfg.release } : {}),
      tags: ["freshnow", call.operation],
      // Deliberately no userId: tying a trace to an employee would make this a per-person
      // record of what they wrote, which is precisely what CLAUDE.md forbids building.
      metadata: { correlationId: call.correlationId ?? null },
    },
  });

  enqueue({
    id: randomUUID(),
    type: "generation-create",
    timestamp: now.toISOString(),
    body: {
      id: observationId,
      traceId,
      name: `${call.operation}:${call.provider}`,
      startTime: startedAt.toISOString(),
      endTime: now.toISOString(),
      model: call.model,
      usage: {
        input: call.promptTokens,
        output: call.completionTokens,
        total: call.promptTokens + call.completionTokens,
        unit: "TOKENS",
        totalCost: call.costUsd,
      },
      level: call.success ? "DEFAULT" : "ERROR",
      ...(call.errorMessage ? { statusMessage: call.errorMessage.slice(0, 1000) } : {}),
      metadata: {
        provider: call.provider,
        attempt: call.attempt,
        latencyMs: call.latencyMs,
        success: call.success,
        // Says out loud whether the content fields below are absent by policy or by accident.
        contentCaptured: cfg.captureContent,
      },
      ...(cfg.captureContent
        ? { input: call.input ?? null, output: call.output ?? null }
        : {}),
    },
  });
}

/**
 * Send whatever has queued up. Safe to call at any time; never throws.
 *
 * Called on a timer, and worth calling directly at the end of a batch job so a short-lived
 * process does not exit with traces still queued.
 */
export async function flushTraces(): Promise<{ sent: number; failed: number }> {
  const cfg = langfuseConfig();
  if (!cfg || queue.length === 0) return { sent: 0, failed: 0 };

  const batch = queue;
  queue = [];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const auth = Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`).toString("base64");
    const res = await fetch(`${cfg.baseUrl}/api/public/ingestion`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
      body: JSON.stringify({ batch }),
      signal: controller.signal,
    });
    if (!res.ok) {
      failed += batch.length;
      return { sent: 0, failed: batch.length };
    }
    sent += batch.length;
    return { sent: batch.length, failed: 0 };
  } catch {
    // Deliberately swallowed. Losing a trace is acceptable; losing an employee's update
    // because an observability tool was down is not. The counter is how you find out.
    failed += batch.length;
    return { sent: 0, failed: batch.length };
  } finally {
    clearTimeout(timeout);
  }
}

/** Counters for /health, so a silently broken tracer is visible rather than assumed working. */
export function tracingStats(): { enabled: boolean; queued: number; sent: number; failed: number; dropped: number; captureContent: boolean } {
  const cfg = langfuseConfig();
  return {
    enabled: cfg !== null,
    queued: queue.length,
    sent,
    failed,
    dropped,
    captureContent: cfg?.captureContent ?? false,
  };
}

/** Stop the flush timer and clear the queue. Tests and shutdown only. */
export async function stopTracing(): Promise<void> {
  await flushTraces();
  if (timer) clearInterval(timer);
  timer = undefined;
  queue = [];
}

/** Reset counters — tests only. */
export function resetTracingStats(): void {
  sent = 0;
  failed = 0;
  dropped = 0;
  queue = [];
}
