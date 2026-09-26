import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  flushTraces,
  isTracingEnabled,
  langfuseConfig,
  resetTracingStats,
  traceLlmCall,
  tracingStats,
} from "./langfuse.js";

/**
 * Tracing is optional, must never break a model call, and must not leak employee text by
 * default. Each of those is a test, because each is a promise made in the module's comments
 * and in the knowledge base, and a promise nobody checks is a wish.
 *
 * No database and no network: `fetch` is stubbed, so these assert on exactly what would be
 * sent to Langfuse rather than on whether Langfuse liked it.
 */

const ENV_KEYS = [
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_BASE_URL",
  "LANGFUSE_CAPTURE_CONTENT",
  "LANGFUSE_RELEASE",
] as const;

let saved: Record<string, string | undefined> = {};

function enable(extra: Record<string, string> = {}): void {
  process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test";
  process.env.LANGFUSE_SECRET_KEY = "sk-lf-test";
  process.env.LANGFUSE_BASE_URL = "http://localhost:3000";
  for (const [k, v] of Object.entries(extra)) process.env[k] = v;
}

const CALL = {
  correlationId: "11111111-1111-4111-8111-111111111111",
  operation: "parse_update",
  provider: "groq",
  model: "llama-3.3-70b",
  promptTokens: 120,
  completionTokens: 30,
  costUsd: 0.00042,
  latencyMs: 850,
  success: true,
  attempt: 1,
  input: [{ role: "user", content: "van 2 ka chiller theek nahi hai" }],
  output: '{"is_blocker":true}',
};

/** The parsed batch from the last stubbed fetch. */
function sentBatch(fetchMock: ReturnType<typeof vi.fn>): { type: string; body: Record<string, unknown> }[] {
  const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
  return (JSON.parse(init.body) as { batch: { type: string; body: Record<string, unknown> }[] }).batch;
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  resetTracingStats();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
  resetTracingStats();
});

describe("tracing is off unless it is configured", () => {
  it("is disabled with no keys, and enabling needs BOTH of them", () => {
    expect(isTracingEnabled()).toBe(false);
    expect(langfuseConfig()).toBeNull();

    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test";
    expect(isTracingEnabled()).toBe(false); // a public key alone is not configuration

    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test";
    expect(isTracingEnabled()).toBe(true);
  });

  it("queues nothing and sends nothing while disabled", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    traceLlmCall(CALL);
    expect(tracingStats().queued).toBe(0);
    expect(await flushTraces()).toEqual({ sent: 0, failed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("defaults to the self-hosted instance rather than anyone's cloud", () => {
    enable();
    delete process.env.LANGFUSE_BASE_URL;
    expect(langfuseConfig()?.baseUrl).toBe("http://localhost:3000");
  });
});

describe("what is actually sent", () => {
  it("writes a trace and a generation, with the cost and token counts", async () => {
    enable();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    traceLlmCall(CALL);
    expect(tracingStats().queued).toBe(2);
    const r = await flushTraces();
    expect(r).toEqual({ sent: 2, failed: 0 });

    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string>; method: string }];
    expect(url).toBe("http://localhost:3000/api/public/ingestion");
    expect(init.method).toBe("POST");
    expect(init.headers["Authorization"]).toBe(`Basic ${Buffer.from("pk-lf-test:sk-lf-test").toString("base64")}`);

    const batch = sentBatch(fetchMock);
    expect(batch.map((e) => e.type)).toEqual(["trace-create", "generation-create"]);

    const trace = batch[0]!.body;
    // The correlation id IS the trace id, so every model call in one run groups together.
    expect(trace["id"]).toBe(CALL.correlationId);
    expect(trace["name"]).toBe("parse_update");

    const gen = batch[1]!.body as Record<string, unknown>;
    expect(gen["traceId"]).toBe(CALL.correlationId);
    expect(gen["model"]).toBe("llama-3.3-70b");
    expect(gen["level"]).toBe("DEFAULT");
    expect(gen["usage"]).toMatchObject({ input: 120, output: 30, total: 150, unit: "TOKENS", totalCost: 0.00042 });
  });

  it("marks a failed call as an error and carries the reason, not the employee's text", async () => {
    enable();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    traceLlmCall({ ...CALL, success: false, errorMessage: "ZodError: expected boolean" });
    await flushTraces();

    const gen = sentBatch(fetchMock)[1]!.body;
    expect(gen["level"]).toBe("ERROR");
    expect(gen["statusMessage"]).toBe("ZodError: expected boolean");
  });

  it("gives retries on the same run distinct observation ids, so nothing overwrites anything", async () => {
    enable();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    traceLlmCall({ ...CALL, attempt: 1 });
    traceLlmCall({ ...CALL, attempt: 2, provider: "openrouter" });
    await flushTraces();

    const gens = sentBatch(fetchMock).filter((e) => e.type === "generation-create");
    const ids = gens.map((g) => g.body["id"]);
    expect(new Set(ids).size).toBe(2);
    // Both still hang off the one trace: one run, read as a story.
    expect(new Set(gens.map((g) => g.body["traceId"])).size).toBe(1);
  });
});

describe("the privacy default", () => {
  it("sends NO prompt or completion text unless capture is explicitly switched on", async () => {
    enable();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    traceLlmCall(CALL);
    await flushTraces();

    const body = JSON.stringify(sentBatch(fetchMock));
    // The employee's own words must not appear anywhere in what was sent.
    expect(body).not.toContain("chiller theek nahi hai");
    expect(body).not.toContain('{"is_blocker":true}');
    const gen = sentBatch(fetchMock)[1]!.body as Record<string, unknown>;
    expect(gen["input"]).toBeUndefined();
    expect(gen["output"]).toBeUndefined();
    // And it says WHY they are missing, so absent-by-policy is not mistaken for a bug.
    expect((gen["metadata"] as Record<string, unknown>)["contentCaptured"]).toBe(false);
  });

  it("sends them only when LANGFUSE_CAPTURE_CONTENT=1", async () => {
    enable({ LANGFUSE_CAPTURE_CONTENT: "1" });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    traceLlmCall(CALL);
    await flushTraces();

    const gen = sentBatch(fetchMock)[1]!.body as Record<string, unknown>;
    expect(JSON.stringify(gen["input"])).toContain("chiller theek nahi hai");
    expect(gen["output"]).toBe('{"is_blocker":true}');
    expect((gen["metadata"] as Record<string, unknown>)["contentCaptured"]).toBe(true);
  });
});

describe("it can never break a model call", () => {
  it("swallows a network failure, counts it, and never throws", async () => {
    enable();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    traceLlmCall(CALL);
    await expect(flushTraces()).resolves.toEqual({ sent: 0, failed: 2 });
    // The counter is how a silently broken tracer is noticed; /health reports it.
    expect(tracingStats().failed).toBe(2);
  });

  it("treats a rejected batch as failed rather than as success", async () => {
    enable();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));

    traceLlmCall(CALL);
    expect(await flushTraces()).toEqual({ sent: 0, failed: 2 });
  });

  it("drops events rather than growing without bound when nothing can be sent", async () => {
    enable();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));

    // Two events per call, so 200 calls is well past the 200-event cap.
    for (let i = 0; i < 200; i++) traceLlmCall(CALL);
    const stats = tracingStats();
    expect(stats.queued).toBe(200);
    expect(stats.dropped).toBeGreaterThan(0);
  });
});
