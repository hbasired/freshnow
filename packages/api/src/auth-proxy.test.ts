import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "@freshnow/core";
import { resetSignInThrottle, SIGNIN_LIMIT } from "./routes/auth-proxy.js";
import { buildServer } from "./server.js";

/**
 * Sign-in on the dashboard's own origin, for a local Supabase (routes/auth-proxy.ts).
 *
 * What must hold:
 *   - the three calls the dashboard makes (sign in, refresh, sign out) reach Supabase Auth
 *     unchanged — path, query, the apikey/authorization headers and the body — and the answer
 *     comes back unchanged;
 *   - sign-out's empty JSON body is not rejected on the way (supabase-js sends one);
 *   - everything else — sign-up, the admin API, other grant types — is refused here and never
 *     reaches Supabase, because accounts are created only by `pnpm link:user`;
 *   - with a hosted (non-local) Supabase the route is off, and /app-config says which.
 *
 * Supabase Auth is stood in for by a local HTTP server that records what it receives.
 */

interface Seen { method: string; url: string; headers: IncomingMessage["headers"]; body: string }
const seen: Seen[] = [];
let upstream: Server;
let upstreamUrl = "";
// The config requires an anon key of at least 20 characters.
const ANON = "sb_publishable_test_anon_key_0001";
const app = buildServer(false);
const saved = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_ANON_KEY };

beforeAll(async () => {
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      if (req.url?.startsWith("/auth/v1/token") && Buffer.concat(chunks).toString("utf8").includes('"wrong"')) {
        // What GoTrue answers for a wrong email or password.
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_grant", error_description: "Invalid login credentials" }));
      } else if (req.url?.startsWith("/auth/v1/token")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: "tok", refresh_token: "ref", token_type: "bearer" }));
      } else if (req.url?.startsWith("/auth/v1/logout")) {
        res.writeHead(204);
        res.end();
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "user-1" }));
      }
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});

afterEach(() => {
  seen.length = 0;
  resetSignInThrottle();
  if (saved.url === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = saved.url;
  if (saved.key === undefined) delete process.env.SUPABASE_ANON_KEY;
  else process.env.SUPABASE_ANON_KEY = saved.key;
});

afterAll(async () => {
  await app.close();
  await new Promise<void>((r) => upstream.close(() => r()));
  await closeDb();
});

function local(): void {
  process.env.SUPABASE_URL = upstreamUrl;
  process.env.SUPABASE_ANON_KEY = ANON;
}

describe("the three calls the dashboard makes pass through unchanged", () => {
  it("sign-in: path, grant type, apikey and body reach Supabase; the tokens come back", async () => {
    local();
    const r = await app.inject({
      method: "POST",
      url: "/auth/v1/token?grant_type=password",
      headers: { apikey: ANON, "content-type": "application/json;charset=UTF-8", "x-client-info": "supabase-js-web/2" },
      payload: JSON.stringify({ email: "ceo@freshnow.local", password: "pw" }),
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ access_token: "tok", refresh_token: "ref" });
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "POST", url: "/auth/v1/token?grant_type=password" });
    expect(seen[0]!.headers.apikey).toBe(ANON);
    expect(JSON.parse(seen[0]!.body)).toEqual({ email: "ceo@freshnow.local", password: "pw" });
  });

  it("refresh uses the same route with the refresh grant", async () => {
    local();
    const r = await app.inject({
      method: "POST",
      url: "/auth/v1/token?grant_type=refresh_token",
      headers: { apikey: ANON, "content-type": "application/json" },
      payload: JSON.stringify({ refresh_token: "ref" }),
    });
    expect(r.statusCode).toBe(200);
    expect(seen[0]!.url).toBe("/auth/v1/token?grant_type=refresh_token");
  });

  it("sign-out with a JSON content type and an empty body is passed on, not rejected", async () => {
    local();
    const r = await app.inject({
      method: "POST",
      url: "/auth/v1/logout?scope=global",
      headers: { apikey: ANON, authorization: "Bearer tok", "content-type": "application/json;charset=UTF-8" },
    });
    expect(r.statusCode).toBe(204);
    expect(seen[0]).toMatchObject({ method: "POST", url: "/auth/v1/logout?scope=global" });
    expect(seen[0]!.headers.authorization).toBe("Bearer tok");
  });

  it("reading the user passes the bearer token through", async () => {
    local();
    const r = await app.inject({ method: "GET", url: "/auth/v1/user", headers: { apikey: ANON, authorization: "Bearer tok" } });
    expect(r.statusCode).toBe(200);
    expect(seen[0]!.headers.authorization).toBe("Bearer tok");
  });
});

describe("everything else is refused before it reaches Supabase", () => {
  it.each([
    ["POST", "/auth/v1/signup"],
    ["GET", "/auth/v1/admin/users"],
    ["POST", "/auth/v1/recover"],
    ["POST", "/auth/v1/otp"],
    ["POST", "/auth/v1/token?grant_type=id_token"],
    ["POST", "/auth/v1/token"],
    ["GET", "/auth/v1/token?grant_type=password"],
  ])("%s %s → 404", async (method, url) => {
    local();
    const r = await app.inject({ method: method as "GET" | "POST", url, headers: { apikey: ANON, "content-type": "application/json" }, payload: method === "POST" ? "{}" : undefined });
    expect(r.statusCode).toBe(404);
    expect(seen).toHaveLength(0);
  });

  it("is off for a hosted Supabase, which is HTTPS on its own domain already", async () => {
    process.env.SUPABASE_URL = "https://abcdefgh.supabase.co";
    process.env.SUPABASE_ANON_KEY = ANON;
    const r = await app.inject({ method: "POST", url: "/auth/v1/token?grant_type=password", headers: { "content-type": "application/json" }, payload: "{}" });
    expect(r.statusCode).toBe(404);
    expect(seen).toHaveLength(0);
  });

  it("says so plainly when Supabase is not running", async () => {
    process.env.SUPABASE_URL = "http://127.0.0.1:9"; // nothing listens on the discard port
    const r = await app.inject({ method: "POST", url: "/auth/v1/token?grant_type=password", headers: { "content-type": "application/json" }, payload: "{}" });
    expect(r.statusCode).toBe(502);
    expect((r.json() as { error: { message: string } }).error.message).toMatch(/Supabase/);
  });
});

describe("/app-config tells the browser which address to sign in on", () => {
  it("same origin for a local Supabase", async () => {
    local();
    const r = await app.inject({ method: "GET", url: "/app-config" });
    expect(r.json()).toMatchObject({ authRequired: true, supabaseSameOrigin: true });
  });

  it("the project's own URL for a hosted one", async () => {
    process.env.SUPABASE_URL = "https://abcdefgh.supabase.co";
    process.env.SUPABASE_ANON_KEY = ANON;
    const r = await app.inject({ method: "GET", url: "/app-config" });
    expect(r.json()).toMatchObject({ supabaseSameOrigin: false, supabaseUrl: "https://abcdefgh.supabase.co" });
  });
});

describe("password guessing is braked per device (TASK-051)", () => {
  const signIn = (password: string, headers: Record<string, string> = {}, remoteAddress?: string) =>
    app.inject({
      method: "POST",
      url: "/auth/v1/token?grant_type=password",
      headers: { apikey: ANON, "content-type": "application/json", ...headers },
      payload: JSON.stringify({ email: "ceo@freshnow.local", password }),
      ...(remoteAddress ? { remoteAddress } : {}),
    });

  it(`after ${SIGNIN_LIMIT.maxFailures} wrong passwords the next attempt is refused here, without reaching Supabase`, async () => {
    local();
    for (let i = 0; i < SIGNIN_LIMIT.maxFailures; i++) expect((await signIn("wrong")).statusCode).toBe(400);
    const before = seen.length;
    const r = await signIn("pw"); // even the right password waits — otherwise guessing just continues
    expect(r.statusCode).toBe(429);
    expect(Number(r.headers["retry-after"])).toBeGreaterThan(0);
    expect(seen.length).toBe(before);
  });

  it("a person who types it right is never slowed down, and a success clears earlier slips", async () => {
    local();
    for (let i = 0; i < SIGNIN_LIMIT.maxFailures - 1; i++) await signIn("wrong");
    expect((await signIn("pw")).statusCode).toBe(200);
    for (let i = 0; i < SIGNIN_LIMIT.maxFailures - 1; i++) await signIn("wrong");
    expect((await signIn("pw")).statusCode).toBe(200);
  });

  it("through the tunnel, each phone is counted separately — one guesser does not lock out everyone", async () => {
    local();
    for (let i = 0; i < SIGNIN_LIMIT.maxFailures; i++) await signIn("wrong", { "cf-connecting-ip": "203.0.113.7" });
    expect((await signIn("pw", { "cf-connecting-ip": "203.0.113.7" })).statusCode).toBe(429);
    const other = await signIn("pw", { "cf-connecting-ip": "198.51.100.20" });
    expect(other.statusCode).toBe(200);
    // Supabase's own limit sees the phone, not the tunnel.
    expect(seen.at(-1)!.headers["x-forwarded-for"]).toBe("198.51.100.20");
  });

  it("the tunnel header is believed only from this machine — a device on the Wi-Fi cannot pick its own identity", async () => {
    local();
    await signIn("pw", { "cf-connecting-ip": "203.0.113.99" }, "192.168.1.50");
    expect(seen.at(-1)!.headers["x-forwarded-for"]).toBe("192.168.1.50");
  });

  it("other grants (refresh) are not counted as guesses", async () => {
    local();
    for (let i = 0; i < SIGNIN_LIMIT.maxFailures; i++) await signIn("wrong");
    const r = await app.inject({
      method: "POST",
      url: "/auth/v1/token?grant_type=refresh_token",
      headers: { apikey: ANON, "content-type": "application/json" },
      payload: JSON.stringify({ refresh_token: "ref" }),
    });
    expect(r.statusCode).toBe(200);
  });
});
