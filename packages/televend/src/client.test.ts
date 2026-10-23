import { describe, expect, it } from "vitest";
import { ClientCredentials, PasswordSession, type FetchLike, type TokenProvider } from "./auth.js";
import { TelevendClient, type CallRecord } from "./client.js";
import {
  TelevendAuthError,
  TelevendCircuitOpenError,
  TelevendHttpError,
  TelevendRefusedError,
  TelevendSchemaError,
} from "./errors.js";
import { z } from "zod";

const API = "https://api-cloud.televendcloud.com";
const TC = "tenants/5/companies/3334";
const VENDS = `${API}/machinist/api/v1/${TC}/vends`;
const PASSWORD = "s3cret-Passw0rd!";
const USERNAME = "integration@example.invalid";

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

/** A fake Televend: answers from a script, records every request, fails the test if over-asked. */
function fakeServer(script: Reply[] | ((url: string, init: { method: string; body?: string }) => Reply)) {
  const requests: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
  const fetch: FetchLike = async (url, init) => {
    requests.push({ url, method: init.method, headers: init.headers, ...(init.body !== undefined && { body: init.body }) });
    const reply = Array.isArray(script) ? script.shift() : script(url, init);
    if (!reply) throw new Error(`unexpected request #${requests.length}: ${init.method} ${url}`);
    const text = reply.body === undefined ? "" : JSON.stringify(reply.body);
    return {
      status: reply.status,
      headers: { get: (n: string) => reply.headers?.[n.toLowerCase()] ?? null },
      text: async () => text,
    };
  };
  return { fetch, requests };
}

/** A token provider that never touches the network. */
function staticToken(): TokenProvider & { calls: number; invalidations: number } {
  let n = 0;
  return {
    calls: 0,
    invalidations: 0,
    latched: false,
    async token() {
      this.calls++;
      return `token-${++n}`;
    },
    invalidate() {
      this.invalidations++;
    },
  };
}

function clock(start = 1_000_000) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    sleeps,
  };
}

const base = { tenantId: 5, companyId: 3334 };

describe("TelevendClient — nothing leaves unless the allow-list says so", () => {
  it("refuses a write path before asking for a token or touching the network", async () => {
    const server = fakeServer([]);
    const auth = staticToken();
    const c = new TelevendClient(auth, { ...base, fetch: server.fetch, minIntervalMs: 0 });
    await expect(c.get(`${API}/machinist/api/v1/${TC}/events/1/resolve`)).rejects.toBeInstanceOf(TelevendRefusedError);
    await expect(c.get("https://cloud-cloud-web-app.televendcloud.com/api/vend/v1/3334/export/xlsx")).rejects.toBeInstanceOf(
      TelevendRefusedError,
    );
    expect(server.requests).toHaveLength(0);
    expect(auth.calls).toBe(0);
    expect(c.sent).toBe(0);
  });

  it("refuses the offset commit unless it was switched on", async () => {
    const server = fakeServer([{ status: 200, body: {} }]);
    const off = new TelevendClient(staticToken(), { ...base, fetch: server.fetch, minIntervalMs: 0 });
    await expect(
      off.commitOffsets("https://uat-api.televendcloud.com/televend-api/data-streaming/vends/api/v1/offsets"),
    ).rejects.toBeInstanceOf(TelevendRefusedError);
    expect(server.requests).toHaveLength(0);

    const on = new TelevendClient(staticToken(), { ...base, fetch: server.fetch, minIntervalMs: 0, commitOffsets: true });
    await on.commitOffsets("https://uat-api.televendcloud.com/televend-api/data-streaming/vends/api/v1/offsets");
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.method).toBe("POST");
    expect(server.requests[0]?.body).toBeUndefined();
    // Reset is never allowed, even with commits switched on.
    await expect(
      on.commitOffsets("https://uat-api.televendcloud.com/televend-api/data-streaming/vends/api/v1/offsets/reset"),
    ).rejects.toBeInstanceOf(TelevendRefusedError);
  });

  it("sends a read with the bearer token and only GET", async () => {
    const server = fakeServer([{ status: 200, body: { content: [] } }]);
    const c = new TelevendClient(staticToken(), { ...base, fetch: server.fetch, minIntervalMs: 0 });
    await c.get(TelevendClient.url("api-cloud.televendcloud.com", `/machinist/api/v1/${TC}/vends`, { page: 1, page_size: 10 }));
    expect(server.requests[0]?.method).toBe("GET");
    expect(server.requests[0]?.headers.Authorization).toBe("Bearer token-1");
    expect(server.requests[0]?.url).toContain("page_size=10");
  });

  it("adds the tenant headers the refill service needs", async () => {
    const server = fakeServer([{ status: 200, body: [] }]);
    const c = new TelevendClient(staticToken(), { ...base, fetch: server.fetch, minIntervalMs: 0 });
    await c.get(`${API}/refillator/api/v1/refill-log-list/3334/details`);
    expect(server.requests[0]?.headers["x-tenant-id"]).toBe("5");
    expect(server.requests[0]?.headers["company-id"]).toBe("3334");
  });
});

describe("TelevendClient — bounded, paced, and honest about failure", () => {
  it("keeps at least the minimum gap between requests", async () => {
    const server = fakeServer([
      { status: 200, body: {} },
      { status: 200, body: {} },
      { status: 200, body: {} },
    ]);
    const k = clock();
    const c = new TelevendClient(staticToken(), { ...base, fetch: server.fetch, minIntervalMs: 1_000, now: k.now, sleep: k.sleep });
    await c.get(VENDS);
    await c.get(VENDS);
    await c.get(VENDS);
    expect(k.sleeps).toEqual([1_000, 1_000]);
  });

  it("retries 503 with exponential backoff and records every exchange", async () => {
    const server = fakeServer([{ status: 503 }, { status: 503 }, { status: 200, body: { ok: 1 } }]);
    const k = clock();
    const calls: CallRecord[] = [];
    const c = new TelevendClient(staticToken(), {
      ...base,
      fetch: server.fetch,
      minIntervalMs: 0,
      now: k.now,
      sleep: k.sleep,
      onCall: (x) => calls.push(x),
    });
    await expect(c.get(VENDS)).resolves.toEqual({ ok: 1 });
    expect(k.sleeps).toEqual([1_000, 2_000]);
    expect(calls.map((x) => x.status)).toEqual([503, 503, 200]);
    expect(calls.every((x) => x.ruleId === "vends.list")).toBe(true);
  });

  it("honours Retry-After on 429", async () => {
    const server = fakeServer([{ status: 429, headers: { "retry-after": "5" } }, { status: 200, body: {} }]);
    const k = clock();
    const c = new TelevendClient(staticToken(), { ...base, fetch: server.fetch, minIntervalMs: 0, now: k.now, sleep: k.sleep });
    await c.get(VENDS);
    expect(k.sleeps).toEqual([5_000]);
  });

  it("gives up after the attempt limit", async () => {
    const server = fakeServer([{ status: 502 }, { status: 502 }, { status: 502 }]);
    const k = clock();
    const c = new TelevendClient(staticToken(), { ...base, fetch: server.fetch, minIntervalMs: 0, now: k.now, sleep: k.sleep });
    const err = await c.get(VENDS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TelevendHttpError);
    expect((err as TelevendHttpError).attempts).toBe(3);
    expect(server.requests).toHaveLength(3);
  });

  it("does not retry a 404 or a 403", async () => {
    for (const status of [404, 403]) {
      const server = fakeServer([{ status }]);
      const c = new TelevendClient(staticToken(), { ...base, fetch: server.fetch, minIntervalMs: 0 });
      await expect(c.get(VENDS)).rejects.toBeInstanceOf(TelevendHttpError);
      expect(server.requests).toHaveLength(1);
    }
  });

  it("fetches one fresh token after a 401, and stops on a second", async () => {
    const auth = staticToken();
    const server = fakeServer([{ status: 401 }, { status: 200, body: { a: 1 } }]);
    const c = new TelevendClient(auth, { ...base, fetch: server.fetch, minIntervalMs: 0 });
    await expect(c.get(VENDS)).resolves.toEqual({ a: 1 });
    expect(auth.invalidations).toBe(1);
    expect(server.requests[1]?.headers.Authorization).toBe("Bearer token-2");

    const twice = fakeServer([{ status: 401 }, { status: 401 }]);
    const c2 = new TelevendClient(staticToken(), { ...base, fetch: twice.fetch, minIntervalMs: 0 });
    await expect(c2.get(VENDS)).rejects.toBeInstanceOf(TelevendAuthError);
    expect(twice.requests).toHaveLength(2);
  });

  it("opens the circuit after repeated failures and closes it after the cool-down", async () => {
    const server = fakeServer(() => ({ status: 500 }));
    const k = clock();
    const c = new TelevendClient(staticToken(), {
      ...base,
      fetch: server.fetch,
      minIntervalMs: 0,
      now: k.now,
      sleep: k.sleep,
      circuitThreshold: 3,
      circuitCooldownMs: 60_000,
    });
    for (let i = 0; i < 3; i++) await expect(c.get(VENDS)).rejects.toBeInstanceOf(TelevendHttpError);
    expect(c.circuit.open).toBe(true);
    const before = server.requests.length;
    await expect(c.get(VENDS)).rejects.toBeInstanceOf(TelevendCircuitOpenError);
    expect(server.requests.length).toBe(before);
    k.advance(60_001);
    expect(c.circuit.open).toBe(false);
  });

  it("checks the response shape when a schema is given", async () => {
    const server = fakeServer([{ status: 200, body: { content: "not a list" } }]);
    const c = new TelevendClient(staticToken(), { ...base, fetch: server.fetch, minIntervalMs: 0 });
    await expect(c.get(VENDS, z.object({ content: z.array(z.unknown()) }))).rejects.toBeInstanceOf(TelevendSchemaError);
  });
});

describe("PasswordSession — the account can never be locked by the connector", () => {
  const TOKEN_OK = { access_token: "access-token-aaaaaaaa", expires_in: 600, refresh_token: "refresh-token-bbbbbbbb", refresh_expires_in: 900 };

  it("signs in once, reuses the token, then lives on the refresh token", async () => {
    const k = clock();
    const server = fakeServer([
      { status: 200, body: TOKEN_OK },
      { status: 200, body: { ...TOKEN_OK, access_token: "access-token-second" } },
    ]);
    const s = new PasswordSession({ username: USERNAME, password: PASSWORD }, { fetch: server.fetch, now: k.now });
    expect(await s.token()).toBe("access-token-aaaaaaaa");
    expect(await s.token()).toBe("access-token-aaaaaaaa");
    expect(server.requests).toHaveLength(1);
    expect(new URLSearchParams(server.requests[0]?.body).get("grant_type")).toBe("password");

    k.advance(590_000); // inside the 30 s early-renewal window of the 600 s token
    expect(await s.token()).toBe("access-token-second");
    expect(new URLSearchParams(server.requests[1]?.body).get("grant_type")).toBe("refresh_token");
    expect(s.passwordSignIns).toBe(1);
  });

  it("latches after a refused password and never sends it again", async () => {
    const server = fakeServer([{ status: 401, body: { error: "invalid_grant", error_description: "Invalid user credentials" } }]);
    const s = new PasswordSession({ username: USERNAME, password: PASSWORD }, { fetch: server.fetch, now: () => 0 });
    const first = await s.token().catch((e: unknown) => e);
    expect(first).toBeInstanceOf(TelevendAuthError);
    expect(s.latched).toBe(true);
    await expect(s.token()).rejects.toBeInstanceOf(TelevendAuthError);
    await expect(s.token()).rejects.toBeInstanceOf(TelevendAuthError);
    expect(server.requests).toHaveLength(1);
    expect(s.passwordSignIns).toBe(1);
  });

  it("does not latch when Televend itself is failing (5xx)", async () => {
    const server = fakeServer([{ status: 503 }, { status: 200, body: TOKEN_OK }]);
    const s = new PasswordSession({ username: USERNAME, password: PASSWORD }, { fetch: server.fetch, now: () => 0 });
    await expect(s.token()).rejects.toBeInstanceOf(TelevendHttpError);
    expect(s.latched).toBe(false);
    expect(await s.token()).toBe("access-token-aaaaaaaa");
  });

  it("sends the password only to the allow-listed token endpoint", async () => {
    const server = fakeServer([{ status: 200, body: TOKEN_OK }]);
    const s = new PasswordSession({ username: USERNAME, password: PASSWORD }, { fetch: server.fetch, now: () => 0 });
    await s.token();
    expect(server.requests[0]?.url).toBe("https://auth.televendcloud.com/auth/realms/televend/protocol/openid-connect/token");

    const evil = new PasswordSession({ username: USERNAME, password: PASSWORD }, { fetch: server.fetch, now: () => 0 }, "https://evil.example/token");
    await expect(evil.token()).rejects.toBeInstanceOf(TelevendRefusedError);
    expect(server.requests).toHaveLength(1);
  });

  it("never puts a credential or token into an error message", async () => {
    const messages: string[] = [];
    const refused = fakeServer([{ status: 401, body: { error: "invalid_grant", error_description: `bad password ${PASSWORD} for ${USERNAME}` } }]);
    const s = new PasswordSession({ username: USERNAME, password: PASSWORD }, { fetch: refused.fetch, now: () => 0 });
    await s.token().catch((e: Error) => messages.push(e.message));
    await s.token().catch((e: Error) => messages.push(e.message));

    // sign-in → API 401 → refresh grant → API 401 again → TelevendAuthError from the client.
    const ok = fakeServer([
      { status: 200, body: TOKEN_OK },
      { status: 401 },
      { status: 200, body: { ...TOKEN_OK, access_token: "access-token-cccccccc" } },
      { status: 401 },
    ]);
    const s2 = new PasswordSession({ username: USERNAME, password: PASSWORD }, { fetch: ok.fetch, now: () => 0 });
    const c = new TelevendClient(s2, { ...base, fetch: ok.fetch, minIntervalMs: 0 });
    await c.get(VENDS).catch((e: Error) => messages.push(e.message));

    expect(messages.length).toBe(3);
    expect(ok.requests.map((r) => r.method)).toEqual(["POST", "GET", "POST", "GET"]);
    for (const m of messages) {
      expect(m).not.toContain(PASSWORD);
      expect(m).not.toContain(USERNAME);
      expect(m).not.toContain("access-token-aaaaaaaa");
      expect(m).not.toContain("access-token-cccccccc");
      expect(m).not.toContain("refresh-token-bbbbbbbb");
    }
  });
});

describe("ClientCredentials — the official API client", () => {
  it("renews at 80 % of the token's lifetime and latches when refused", async () => {
    const k = clock();
    const tokenUrl = "https://uat-auth.televendcloud.com/auth/realms/gravitee3/protocol/openid-connect/token";
    const server = fakeServer([
      { status: 200, body: { access_token: "official-token-1111", expires_in: 7200 } },
      { status: 200, body: { access_token: "official-token-2222", expires_in: 7200 } },
      { status: 401, body: { error: "invalid_client" } },
    ]);
    const cc = new ClientCredentials({ clientId: "id", clientSecret: "secret-xyz" }, tokenUrl, { fetch: server.fetch, now: k.now });
    expect(await cc.token()).toBe("official-token-1111");
    k.advance(7200 * 1000 * 0.79);
    expect(await cc.token()).toBe("official-token-1111");
    k.advance(7200 * 1000 * 0.02);
    expect(await cc.token()).toBe("official-token-2222");
    k.advance(7200 * 1000);
    await expect(cc.token()).rejects.toBeInstanceOf(TelevendAuthError);
    expect(cc.latched).toBe(true);
    await expect(cc.token()).rejects.toBeInstanceOf(TelevendAuthError);
    expect(server.requests).toHaveLength(3);
  });
});
