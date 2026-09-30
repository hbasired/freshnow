import type { ZodType } from "zod";
import { loadConfig } from "../config.js";
import { getServiceSql } from "../db.js";
import { llmSemaphore } from "../concurrency.js";
import { estimateCost } from "./cost.js";
import { extractJson } from "./extract.js";
import { traceLlmCall } from "./langfuse.js";
import { redactMessages } from "./redact.js";
import { openRouterDataPolicy } from "../compliance-registry.js";

/** Raised when the daily LLM budget is spent — callers must degrade to rules-only. */
export class LlmBudgetExceededError extends Error {}
/** Raised when every provider/attempt failed (bounded — never loops forever). */
export class LlmError extends Error {}

/**
 * Total time one `llmComplete` call may spend waiting out rate limits, across every
 * provider and attempt. Bounds the worst case a person can experience while still
 * surviving the short, self-clearing limits a per-minute token budget produces.
 */
const RATE_LIMIT_WAIT_BUDGET_MS = 25_000;

/** Raised on HTTP 429 so the caller can wait rather than fail over to another provider. */
export class LlmRateLimitError extends Error {
  constructor(
    message: string,
    readonly retryAfterSec: number | undefined,
  ) {
    super(message);
    this.name = "LlmRateLimitError";
  }
}

/**
 * How long a provider says to wait. Groq sends `x-ratelimit-reset-tokens: 12.495s`;
 * the OpenAI-compatible convention is `retry-after` in whole seconds.
 *
 * Capped at 30s: past that the person on the other end has given up, and failing over to
 * another provider (or degrading to rules-only) serves them better than a long sleep.
 */
export function retryAfterSeconds(headers: Headers): number | undefined {
  const raw =
    headers.get("retry-after") ??
    headers.get("x-ratelimit-reset-tokens") ??
    headers.get("x-ratelimit-reset-requests");
  if (!raw) return undefined;
  // Values arrive as "12.495s", "1m26.4s" or a bare number of seconds.
  const m = /^(?:(\d+(?:\.\d+)?)m)?(\d+(?:\.\d+)?)s?$/.exec(raw.trim());
  if (!m) return undefined;
  const secs = (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2]);
  return Number.isFinite(secs) ? Math.min(secs, 30) : undefined;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmCompleteOpts<T> {
  messages: LlmMessage[];
  schema: ZodType<T>;
  correlationId?: string;
  maxTokens?: number;
  timeoutMs?: number;
  /**
   * What this call is for — "parse_update", "plan_document", "answer_question". Names the
   * trace, so a Langfuse timeline reads as operations rather than as a list of model calls.
   * Only used for tracing; it changes nothing about the call itself.
   */
  operation?: string;
}

interface ProviderCfg {
  name: "groq" | "openrouter" | "nvidia";
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface RawCompletion {
  content: string;
  promptTokens: number;
  completionTokens: number;
  /** What the provider itself says the call cost. OpenRouter reports it; Groq does not. */
  costUsd?: number;
}

function providers(): ProviderCfg[] {
  const c = loadConfig();
  const available: Record<string, ProviderCfg> = {};
  if (c.GROQ_API_KEY)
    available.groq = { name: "groq", baseUrl: c.GROQ_BASE_URL, apiKey: c.GROQ_API_KEY, model: c.GROQ_MODEL };
  if (c.OPENROUTER_API_KEY)
    available.openrouter = {
      name: "openrouter", baseUrl: c.OPENROUTER_BASE_URL,
      apiKey: c.OPENROUTER_API_KEY, model: c.OPENROUTER_MODEL,
    };
  if (c.NVIDIA_API_KEY)
    available.nvidia = { name: "nvidia", baseUrl: c.NVIDIA_BASE_URL, apiKey: c.NVIDIA_API_KEY, model: c.NVIDIA_MODEL };

  // Order is configuration, not code, so the primary can be swapped without a deploy.
  // BENCHMARKED 2026-09-07 on the real multilingual extraction set:
  //   groq/gpt-oss-120b       100% correct,  ~861ms  <- primary
  //   openrouter/gpt-4o-mini  100% correct, ~1612ms  <- fallback, INDEPENDENT provider
  //   nvidia/nemotron-3-super flaky (503),   ~6.7s   <- last resort
  // The fallback is deliberately a DIFFERENT provider: a second Groq model would go
  // down with Groq. Rejected groq/gpt-oss-20b — 546ms but only 67% correct, missing
  // real problems (a shortage stated after good news, a 20->5 short delivery).
  const order = (process.env.LLM_PROVIDER_ORDER ?? "groq,openrouter,nvidia")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const list: ProviderCfg[] = [];
  for (const name of order) {
    const p = available[name];
    if (p && !list.includes(p)) list.push(p);
  }
  // Anything configured but not named in the order still acts as a last resort.
  for (const p of Object.values(available)) if (!list.includes(p)) list.push(p);
  return list;
}

async function dailySpendUsd(): Promise<number> {
  const sql = getServiceSql();
  const rows = await sql<{ sum: string }[]>`
    select coalesce(sum(cost_usd), 0)::text as sum
    from llm_call
    where created_at >= date_trunc('day', now())`;
  return Number(rows[0]?.sum ?? 0);
}

async function callProvider(
  p: ProviderCfg,
  messages: LlmMessage[],
  maxTokens: number,
  timeoutMs: number,
): Promise<RawCompletion> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${p.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${p.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: p.model,
        messages,
        temperature: 0,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
        // OpenRouter will put its own bill for the call in `usage.cost`. Ask for it, so the
        // cost log records what was charged rather than an estimate.
        ...(p.name === "openrouter" ? { usage: { include: true } } : {}),
        // Rule R4: route only to endpoints that keep nothing / collect nothing — sent only once
        // the registry says a person confirmed it (compliance/processors.json).
        ...(p.name === "openrouter" && openRouterDataPolicy() ? { provider: openRouterDataPolicy() } : {}),
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 429) {
        // A rate limit is "come back shortly", not "this provider is broken". Retrying
        // immediately — which is what the generic path did — burns both attempts in
        // milliseconds and drops through to the fallback provider for a limit that
        // would have cleared in seconds. Measured on Groq's on-demand tier: the token
        // budget is 8 000/minute and `x-ratelimit-reset-tokens` said 12.5s.
        throw new LlmRateLimitError(
          `${p.name} HTTP 429: ${body.slice(0, 160)}`,
          retryAfterSeconds(res.headers),
        );
      }
      throw new Error(`${p.name} HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    };
    const billed = data.usage?.cost;
    return {
      content: data.choices?.[0]?.message?.content ?? "",
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      ...(typeof billed === "number" && Number.isFinite(billed) ? { costUsd: billed } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function logLlmCall(
  p: ProviderCfg,
  raw: RawCompletion,
  latencyMs: number,
  success: boolean,
  correlationId?: string,
  trace?: { operation: string; attempt: number; messages: LlmMessage[]; errorMessage?: string | undefined },
  /** Identifiers taken out of this call's prompt before it left (rule R7). */
  redacted = 0,
): Promise<void> {
  const sql = getServiceSql();
  // The provider's own bill when it sends one; otherwise list price x tokens.
  const cost = raw.costUsd ?? estimateCost(p.model, raw.promptTokens, raw.completionTokens);
  await sql`
    insert into llm_call
      (correlation_id, provider, model, prompt_tokens, completion_tokens, cost_usd, latency_ms, success, redacted)
    values (${correlationId ?? null}, ${p.name}, ${p.model}, ${raw.promptTokens},
            ${raw.completionTokens}, ${cost}, ${latencyMs}, ${success}, ${redacted})`;

  // `llm_call` stays the record of what things cost — it is queried by the budget cap and
  // must not depend on a third party. Langfuse is the timeline on top of it: same facts,
  // arranged so one run reads as a story. It is fire-and-forget and cannot fail this call.
  if (trace) {
    traceLlmCall({
      correlationId,
      operation: trace.operation,
      provider: p.name,
      model: p.model,
      promptTokens: raw.promptTokens,
      completionTokens: raw.completionTokens,
      costUsd: cost,
      latencyMs,
      success,
      attempt: trace.attempt,
      input: trace.messages,
      output: raw.content,
      errorMessage: trace.errorMessage,
    });
  }
}

/**
 * The single LLM entrypoint. The model TRANSLATES free text into a schema-validated
 * object; it never computes numbers or decides routing. Bounded by design: a 10 s
 * timeout, one retry per provider, then the fallback provider — never an unbounded
 * loop. Every call is logged to llm_call. Over the daily budget it throws
 * LlmBudgetExceededError so the caller degrades to rules-only.
 */
export async function llmComplete<T>(opts: LlmCompleteOpts<T>): Promise<T> {
  // Every model call in the system funnels through here, which makes this the one place
  // concurrency can be capped honestly. Without it, processing updates concurrently just
  // converts a queue of employees into a burst of 429s from the provider.
  return llmSemaphore.run(() => llmCompleteInner(opts));
}

async function llmCompleteInner<T>(opts: LlmCompleteOpts<T>): Promise<T> {
  const c = loadConfig();
  const spend = await dailySpendUsd();
  if (spend >= c.LLM_DAILY_BUDGET_USD) {
    throw new LlmBudgetExceededError(
      `Daily LLM budget reached (${spend} >= ${c.LLM_DAILY_BUDGET_USD}); degrade to rules-only`,
    );
  }

  const maxTokens = opts.maxTokens ?? 512;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const operation = opts.operation ?? "llm_complete";
  const provs = providers();
  if (provs.length === 0) throw new LlmError("No LLM provider configured");

  // Rule R7: phone numbers, emails, Emirates IDs, IBANs and card numbers never leave. Done once,
  // here, so every caller and every provider (and the trace) sees the same redacted words.
  const outbound = redactMessages(opts.messages);

  // Collect EVERY provider's failure. Reporting only the last one hid the real cause:
  // the primary was rejecting the response in ~1.5 s while the slow fallback's timeout
  // was the only error anyone ever saw.
  const errors: string[] = [];
  let waitedMs = 0;
  for (const p of provs) {
    for (let attempt = 0; attempt < 2; attempt++) {
      // 2 attempts = one retry
      const started = Date.now();
      let raw: RawCompletion | undefined;
      try {
        raw = await callProvider(p, outbound.messages, maxTokens, timeoutMs);
        // Validated as the model wrote it, then the real values are put back on OUR side, so
        // "call [phone-1]" reaches the assignee as the number the CEO wrote (redact.ts).
        const parsed = outbound.names.restoreDeep(opts.schema.parse(extractJson(raw.content)));
        await logLlmCall(p, raw, Date.now() - started, true, opts.correlationId, {
          operation,
          attempt: attempt + 1,
          messages: outbound.messages,
        }, outbound.total);
        return parsed;
      } catch (err) {
        const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        errors.push(`${p.name}(${p.model}) attempt ${attempt + 1} — ${detail}`);

        // A rate limit is temporary and self-clearing, so WAIT rather than immediately
        // burning the retry and falling through to a fallback provider. On 2026-09-10
        // the whole chain failed this way in seconds: Groq 429 twice, OpenRouter 401
        // (dead key), NVIDIA timeout — for a limit that reset in 12 seconds.
        //
        // Waiting is budgeted across the WHOLE call, not per attempt, so a busy minute
        // costs a slow answer rather than no answer, while a person waiting on a reply
        // never waits longer than RATE_LIMIT_WAIT_BUDGET_MS in total.
        if (err instanceof LlmRateLimitError && waitedMs < RATE_LIMIT_WAIT_BUDGET_MS) {
          const asked = Math.round((err.retryAfterSec ?? 5) * 1000);
          const waitMs = Math.min(asked, RATE_LIMIT_WAIT_BUDGET_MS - waitedMs);
          waitedMs += waitMs;
          await new Promise((r) => setTimeout(r, waitMs));
        }
        await logLlmCall(
          p,
          raw ?? { content: "", promptTokens: 0, completionTokens: 0 },
          Date.now() - started,
          false,
          opts.correlationId,
          { operation, attempt: attempt + 1, messages: outbound.messages, errorMessage: detail },
          outbound.total,
        ).catch(() => {
          /* logging failure must not mask the original error */
        });
      }
    }
  }
  throw new LlmError(`All LLM providers failed: ${errors.join(" | ")}`);
}
