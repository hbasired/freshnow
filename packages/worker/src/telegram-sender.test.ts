import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTelegramSender } from "./telegram-sender.js";

/**
 * The Telegram sender runs inside the relay's open transaction. A call that never returns
 * would hold row locks and stop the worker loop dead — no delivery, no sweeps. The audit
 * found the fetch had no timeout at all; this proves the one added actually fires, against
 * a real socket that accepts the connection and then says nothing.
 */
let blackhole: Server;
let port = 0;
const savedToken = process.env.BOT_TOKEN;

beforeAll(async () => {
  // Accept the request, never respond. This is what a black-holed link looks like to fetch.
  blackhole = createServer(() => {
    /* deliberately never writes a response */
  });
  await new Promise<void>((r) => blackhole.listen(0, "127.0.0.1", r));
  port = (blackhole.address() as AddressInfo).port;
  process.env.BOT_TOKEN = "0:test";
});

afterAll(async () => {
  if (savedToken === undefined) delete process.env.BOT_TOKEN;
  else process.env.BOT_TOKEN = savedToken;
  blackhole.closeAllConnections?.();
  await new Promise<void>((r) => blackhole.close(() => r()));
});

describe("the Telegram sender", () => {
  it("gives up on a socket that never answers, instead of hanging the worker forever", async () => {
    // Point the sender at the black hole by overriding fetch's destination: the sender
    // builds its URL from the token, so we intercept and redirect to the local port.
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input).replace(/^https:\/\/api\.telegram\.org/, `http://127.0.0.1:${port}`);
      return realFetch(url, init);
    }) as typeof fetch;

    // Shorten the wait for the test by racing against the sender's own timeout: if the
    // timeout is wired, the promise rejects; if it is not, this test hits its own 30 s
    // ceiling and fails — which is exactly the hang being guarded against.
    const deliver = makeTelegramSender();
    const started = Date.now();
    try {
      await expect(deliver({ chatId: 1, payload: { text: "hello" } })).rejects.toThrow(/abort|timeout|TimeoutError/i);
    } finally {
      globalThis.fetch = realFetch;
    }
    const elapsed = Date.now() - started;
    // It must have waited for the real timeout, not failed instantly for another reason.
    expect(elapsed).toBeGreaterThan(15_000);
    expect(elapsed).toBeLessThan(28_000);
  }, 35_000);
});
