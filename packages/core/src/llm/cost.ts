// List prices, USD per 1M tokens, for the models this system is configured to call.
//
// Two jobs. The daily budget cap needs a real number to count against — an empty table
// made every call cost $0, so the cap could never trip. And the cost log should say what
// this workload would cost on a paid tier. When a provider reports its own bill
// (OpenRouter's usage.cost), client.ts records that instead of this estimate.
//
// Keyed by model id only, so one model on two providers shares a price here — another
// reason the provider's own bill wins. The Groq account is on the free tier today, so
// what Groq calls actually cost is $0; what gets logged is the paid-tier list price.
//
// Checked 2026-09-12: Groq's published on-demand rates; OpenRouter's catalogue
// (/api/v1/models), which passes provider prices through without a per-token markup.
// NVIDIA's hosted NIM endpoints publish no per-token price and stay at 0.
const PRICE_PER_MTOK: Record<string, { in: number; out: number }> = {
  "openai/gpt-oss-120b": { in: 0.15, out: 0.6 }, // Groq on-demand
  "openai/gpt-oss-20b": { in: 0.075, out: 0.3 }, // Groq on-demand
  "openai/gpt-4o-mini": { in: 0.15, out: 0.6 }, // OpenAI list, passed through by OpenRouter
};

/** Models seen with no published price, so the warning is logged once each, not per call. */
const warned = new Set<string>();

/**
 * Whether this model's cost is a real estimate or a zero standing in for "unknown".
 *
 * The daily budget cap counts `llm_call.cost_usd`. An unpriced model logs $0, so the cap
 * can never trip — the circuit breaker fails OPEN, silently, and the model ids are all
 * env-configurable. Callers use this to record that the number is not trustworthy.
 */
export function isPriced(model: string): boolean {
  return PRICE_PER_MTOK[model] !== undefined;
}

export function estimateCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const p = PRICE_PER_MTOK[model];
  if (!p) {
    // Say it once, loudly. A silent zero here is the difference between a budget cap and
    // the appearance of one (found by audit 2026-09-18).
    if (!warned.has(model)) {
      warned.add(model);
      console.warn(
        `[cost] No published price for "${model}" — its calls log $0 and DO NOT count ` +
          `towards LLM_DAILY_BUDGET_USD. Add it to PRICE_PER_MTOK in core/src/llm/cost.ts.`,
      );
    }
    return 0;
  }
  return (promptTokens / 1_000_000) * p.in + (completionTokens / 1_000_000) * p.out;
}
