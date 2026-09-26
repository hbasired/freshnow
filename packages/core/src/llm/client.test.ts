import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { closeDb, getServiceSql } from "../db.js";
import { LlmBudgetExceededError, llmComplete, retryAfterSeconds } from "./client.js";
import { estimateCost } from "./cost.js";

// The wrapper's logic is tested with a STUBBED fetch (deterministic, no network)
// against the real test database. A live call to Groq was verified manually
// (2026-09-04) and returned valid JSON; see TASK-004 HTML.
const CORR = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"; // valid uuid for correlation_id

const Schema = z.object({
  status: z.enum(["done", "pending", "blocker"]),
  category: z.string(),
  severity: z.enum(["low", "medium", "high", "critical"]),
});

function fakeResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function completion(content: string): unknown {
  return {
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 10, completion_tokens: 6 },
  };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await getServiceSql()`delete from llm_call where correlation_id = ${CORR}`;
});

afterAll(async () => {
  await closeDb();
});

describe("llmComplete", () => {
  it("returns schema-validated JSON and logs a successful llm_call", async () => {
    const content = JSON.stringify({ status: "blocker", category: "equipment", severity: "high" });
    vi.stubGlobal("fetch", vi.fn(async () => fakeResponse(completion(content))));

    const out = await llmComplete({
      messages: [{ role: "user", content: "chiller in van 2 not holding temp" }],
      schema: Schema,
      correlationId: CORR,
    });
    expect(out).toEqual({ status: "blocker", category: "equipment", severity: "high" });

    const rows =
      await getServiceSql()`select success from llm_call where correlation_id = ${CORR} and success = true`;
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("falls back to the next provider when the first fails", async () => {
    // Pin the order so the test does not depend on .env. Asserting a SPECIFIC second
    // provider was brittle: adding OpenRouter between Groq and NVIDIA broke it even
    // though failover still worked. What matters is that a failing primary is skipped
    // and the NEXT configured provider succeeds.
    const previousOrder = process.env.LLM_PROVIDER_ORDER;
    process.env.LLM_PROVIDER_ORDER = "groq,nvidia";

    const good = JSON.stringify({ status: "pending", category: "supply", severity: "low" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) =>
        String(url).includes("groq")
          ? fakeResponse({ error: "boom" }, false, 500)
          : fakeResponse(completion(good)),
      ),
    );

    try {
      const out = await llmComplete({
        messages: [{ role: "user", content: "x" }],
        schema: Schema,
        correlationId: CORR,
      });
      expect(out.category).toBe("supply");

      const sql = getServiceSql();
      // The primary was tried and failed...
      const groqFailures =
        await sql`select 1 from llm_call where correlation_id = ${CORR} and provider = 'groq' and success = false`;
      expect(groqFailures.length).toBeGreaterThanOrEqual(1);
      // ...and a later provider succeeded.
      const succeeded =
        await sql`select provider from llm_call where correlation_id = ${CORR} and success = true`;
      expect(succeeded.length).toBe(1);
      expect(succeeded[0]?.provider).not.toBe("groq");
    } finally {
      if (previousOrder === undefined) delete process.env.LLM_PROVIDER_ORDER;
      else process.env.LLM_PROVIDER_ORDER = previousOrder;
    }
  });

  it("throws LlmBudgetExceededError (degrade to rules-only) when the daily cap is hit", async () => {
    await getServiceSql()`
      insert into llm_call (correlation_id, provider, model, cost_usd, success)
      values (${CORR}, 'groq', 'x', 999, true)`;
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);

    await expect(
      llmComplete({ messages: [{ role: "user", content: "x" }], schema: Schema, correlationId: CORR }),
    ).rejects.toBeInstanceOf(LlmBudgetExceededError);
    expect(spy).not.toHaveBeenCalled(); // budget checked before any network call
  });
});

describe("rate limits are waited out, not failed over", () => {
  it("parses the provider's own reset hint in every format it sends", () => {
    // Groq sends "12.495s" and "1m26.4s"; the OpenAI convention is a bare integer.
    const h = (v: string) => new Headers({ "retry-after": v });
    expect(retryAfterSeconds(h("12.495s"))).toBeCloseTo(12.495, 2);
    expect(retryAfterSeconds(h("1m26.4s"))).toBeCloseTo(86.4 > 30 ? 30 : 86.4, 2);
    expect(retryAfterSeconds(h("5"))).toBe(5);
    expect(retryAfterSeconds(new Headers())).toBeUndefined();
  });

  it("caps the wait, because a long sleep is worse than degrading", () => {
    // Past ~30s the person has given up; failing over serves them better than waiting.
    expect(retryAfterSeconds(new Headers({ "retry-after": "600" }))).toBe(30);
  });

  it("prefers x-ratelimit-reset-tokens when retry-after is absent", () => {
    const h = new Headers({ "x-ratelimit-reset-tokens": "9.787s" });
    expect(retryAfterSeconds(h)).toBeCloseTo(9.787, 2);
  });
});

describe("cost is recorded, not assumed to be zero", () => {
  // Set env vars for one test and put them back, so a test never depends on .env.
  async function withEnv(vars: Record<string, string>, fn: () => Promise<void>): Promise<void> {
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    Object.assign(process.env, vars);
    try {
      await fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it("records the provider's own bill when it sends one (OpenRouter usage.cost)", async () => {
    const content = JSON.stringify({ status: "done", category: "other", severity: "low" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        fakeResponse({
          choices: [{ message: { content } }],
          usage: { prompt_tokens: 812, completion_tokens: 64, cost: 0.000161 },
        }),
      ),
    );
    // fetch is stubbed, so the key is never sent anywhere; it only has to be configured.
    await withEnv(
      { LLM_PROVIDER_ORDER: "openrouter", OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? "test-key" },
      async () => {
        await llmComplete({ messages: [{ role: "user", content: "all done" }], schema: Schema, correlationId: CORR });
      },
    );
    const [row] = await getServiceSql()<{ provider: string; cost_usd: string }[]>`
      select provider, cost_usd from llm_call where correlation_id = ${CORR} and success = true`;
    expect(row?.provider).toBe("openrouter");
    expect(Number(row?.cost_usd)).toBe(0.000161);
  });

  it("falls back to list price x tokens when the provider sends no bill", async () => {
    const content = JSON.stringify({ status: "done", category: "other", severity: "low" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        fakeResponse({ choices: [{ message: { content } }], usage: { prompt_tokens: 100_000, completion_tokens: 10_000 } }),
      ),
    );
    await withEnv(
      {
        LLM_PROVIDER_ORDER: "groq",
        GROQ_API_KEY: process.env.GROQ_API_KEY ?? "test-key",
        GROQ_MODEL: "openai/gpt-oss-120b",
      },
      async () => {
        await llmComplete({ messages: [{ role: "user", content: "all done" }], schema: Schema, correlationId: CORR });
      },
    );
    const [row] = await getServiceSql()<{ cost_usd: string }[]>`
      select cost_usd from llm_call where correlation_id = ${CORR} and success = true`;
    // 100k in x $0.15/M + 10k out x $0.60/M = $0.015 + $0.006
    expect(Number(row?.cost_usd)).toBeCloseTo(0.021, 6);
  });

  it("prices the configured models — a zero here silently disables the budget cap", () => {
    expect(estimateCost("openai/gpt-oss-120b", 1_000_000, 1_000_000)).toBeCloseTo(0.75, 6);
    expect(estimateCost("openai/gpt-4o-mini", 1_000_000, 1_000_000)).toBeCloseTo(0.75, 6);
    expect(estimateCost("some/unpriced-model", 1_000_000, 1_000_000)).toBe(0);
  });
});
