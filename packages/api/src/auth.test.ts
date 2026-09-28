import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, DEMO_CEO_ID, getServiceSql, seedDemo, IS_DEMO } from "@freshnow/core";
import { buildServer } from "./server.js";

/**
 * Dashboard sign-in through the real HTTP layer.
 *
 * A local endpoint publishes a key set the way Supabase Auth does at
 * /auth/v1/.well-known/jwks.json, so the verifier runs its production path — ES256
 * signatures checked against published keys — with nothing mocked. Each refusal case is a
 * token someone could actually present.
 */

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

const PRIYA = "d0000000-0000-0000-0000-000000000002"; // exactly 1 blocker in the seed
const DISABLED = "d0000000-0000-0000-0000-000000000003";
const SEED_CORR = "5eed5eed-5eed-5eed-5eed-5eed5eed5eed";
const IDS = [
  "d0000000-0000-0000-0000-000000000001", PRIYA, DISABLED,
  "d0000000-0000-0000-0000-000000000004", "d0000000-0000-0000-0000-000000000005",
];
// Auth user ids as Supabase would issue them — random, so nothing collides with real links.
const AUTH = { ceo: randomUUID(), priya: randomUUID(), disabled: randomUUID(), stranger: randomUUID() };
const KID = "freshnow-test-key";
const ANON = "test-anon-key-public-by-design";
const ENV = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_JWT_SECRET"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

const app = buildServer(false);
let keys: Server;
let port = 0;
let issuer = "";
let signing: PrivateKey;
let foreign: PrivateKey;

async function token(
  sub: string,
  o: { key?: PrivateKey; iss?: string; aud?: string; expired?: boolean } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ role: "authenticated" })
    .setProtectedHeader({ alg: "ES256", kid: KID })
    .setSubject(sub)
    .setIssuer(o.iss ?? issuer)
    .setAudience(o.aud ?? "authenticated")
    .setIssuedAt(o.expired ? now - 7200 : now)
    .setExpirationTime(o.expired ? now - 3600 : now + 3600)
    .sign(o.key ?? signing);
}

const as = (t: string) => ({ authorization: `Bearer ${t}` });

async function status(url: string, headers: Record<string, string> = {}): Promise<number> {
  return (await app.inject({ method: "GET", url, headers })).statusCode;
}

async function post(url: string, headers: Record<string, string>, payload?: object): Promise<number> {
  return (await app.inject({ method: "POST", url, headers, ...(payload ? { payload } : {}) })).statusCode;
}

beforeAll(async () => {
  const pair = await generateKeyPair("ES256");
  signing = pair.privateKey;
  foreign = (await generateKeyPair("ES256")).privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: "ES256", use: "sig" };
  keys = createServer((req, res) => {
    if (req.url === "/auth/v1/.well-known/jwks.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => keys.listen(0, "127.0.0.1", resolve));
  port = (keys.address() as AddressInfo).port;
  issuer = `http://127.0.0.1:${port}/auth/v1`;
  process.env.SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_ANON_KEY = ANON;
  delete process.env.SUPABASE_JWT_SECRET;

  await seedDemo();
  const sql = getServiceSql();
  await sql`update employee set auth_user_id = ${AUTH.ceo} where id = ${DEMO_CEO_ID}`;
  await sql`update employee set auth_user_id = ${AUTH.priya} where id = ${PRIYA}`;
  await sql`update employee set auth_user_id = ${AUTH.disabled}, status = 'disabled' where id = ${DISABLED}`;
});

afterAll(async () => {
  for (const k of ENV) {
    const was = saved[k];
    if (was === undefined) delete process.env[k];
    else process.env[k] = was;
  }
  const sql = getServiceSql();
  await sql`update employee set auth_user_id = null where id = ${DEMO_CEO_ID}`;
  await sql`delete from escalation where blocker_id in (select id from blocker where raised_by in ${sql(IDS)})`;
  await sql`delete from blocker where raised_by in ${sql(IDS)}`;
  await sql`delete from task_update where employee_id in ${sql(IDS)}`;
  await sql`delete from task where employee_id in ${sql(IDS)}`;
  await sql`delete from run_trace where correlation_id = ${SEED_CORR}`;
  await sql`delete from audit_log where correlation_id = ${SEED_CORR}`;
  await sql`delete from notification_outbox where idempotency_key like 'blocker-%'`;
  await sql`delete from employee where id in ${sql(IDS)}`;
  await app.close();
  await closeDb();
  await new Promise<void>((resolve) => keys.close(() => resolve()));
});

describe("dashboard sign-in with a Supabase JWT", () => {
  it("sends the old page, which cannot sign in, to the React app, which can", async () => {
    const r = await app.inject({ method: "GET", url: "/" });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe("/app/");
  });

  it("tells the app sign-in is required, pointing it at the host it was reached on", async () => {
    // A phone reaches the API by its LAN address; 127.0.0.1 would mean the phone itself.
    const r = await app.inject({ method: "GET", url: "/app-config", headers: { host: "192.168.1.50:3001" } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      authRequired: true,
      // The dashboard badges synthetic content from this, rather than hardcoding a DEMO
      // chip that would keep claiming demo once the build carried real company data.
      isDemo: IS_DEMO,
      supabaseUrl: `http://192.168.1.50:${port}`,
      // A local Supabase is signed in to through this server (routes/auth-proxy.ts), so the
      // browser uses its own origin — one address for the page and sign-in, which is what lets
      // an HTTPS tunnel serve a phone. supabaseUrl stays for an older dashboard build.
      supabaseSameOrigin: true,
      supabaseAnonKey: ANON,
      // The VAPID PUBLIC key, so the browser can subscribe to push. Public by design, like
      // the anon key above; null when web push is not configured on this server.
      vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? null,
    });
  });

  it("refuses a request with no token, and ?viewer=ceo is not a way round it", async () => {
    expect(await status("/dashboard/blockers")).toBe(401);
    expect(await status("/dashboard/blockers?viewer=ceo")).toBe(401);
    expect(await status("/dashboard/me")).toBe(401);
  });

  it("refuses tokens that are malformed, unpublished-key, expired, other-project or other-audience", async () => {
    const bad: [string, string][] = [
      ["not a JWT", "not-a-jwt"],
      ["signed by an unpublished key", await token(AUTH.priya, { key: foreign })],
      ["expired", await token(AUTH.priya, { expired: true })],
      ["issued by another project", await token(AUTH.priya, { iss: "https://attacker.example/auth/v1" })],
      ["meant for another audience", await token(AUTH.priya, { aud: "anon" })],
    ];
    for (const [label, t] of bad) {
      expect({ label, status: await status("/dashboard/blockers", as(t)) }).toEqual({ label, status: 401 });
    }
  });

  it("refuses a real account that is not linked to an employee, or whose employee is disabled", async () => {
    expect(await status("/dashboard/blockers", as(await token(AUTH.stranger)))).toBe(403);
    expect(await status("/dashboard/blockers", as(await token(AUTH.disabled)))).toBe(403);
  });

  it("an employee sees only their own rows, whatever ?viewer= says", async () => {
    const t = as(await token(AUTH.priya));
    const me = (await app.inject({ method: "GET", url: "/dashboard/me?viewer=ceo", headers: t })).json() as {
      viewer: string;
      isCeo: boolean;
      displayName: string;
    };
    expect(me.viewer).toBe(PRIYA);
    expect(me.isCeo).toBe(false);
    expect(me.displayName).toContain("Priya");
    const rows = (await app.inject({ method: "GET", url: "/dashboard/blockers?viewer=ceo", headers: t })).json() as {
      raised_by_name: string;
    }[];
    expect(rows.length).toBe(1);
    expect(rows[0]?.raised_by_name).toContain("Priya");
  });

  it("the CEO's account sees everyone", async () => {
    const t = as(await token(AUTH.ceo));
    const me = (await app.inject({ method: "GET", url: "/dashboard/me", headers: t })).json() as {
      viewer: string;
      employeeId: string;
      isCeo: boolean;
    };
    // The CEO is identified by their OWN id, not collapsed to a "ceo" label. The label made
    // every real CEO's writes audit as the seeded demo employee (audit 2026-09-18).
    expect(me).toMatchObject({ viewer: DEMO_CEO_ID, employeeId: DEMO_CEO_ID, isCeo: true });
    const rows = (await app.inject({ method: "GET", url: "/dashboard/blockers", headers: t })).json() as unknown[];
    expect(rows.length).toBeGreaterThanOrEqual(3);

    // A write by the CEO is audited as the CEO's real id.
    const created = await app.inject({
      method: "POST", url: "/dashboard/tasks", headers: t, payload: { title: "AUTHTEST ceo audit actor" },
    });
    expect(created.statusCode).toBe(201);
    const sql = getServiceSql();
    const audit = await sql<{ actor: string }[]>`
      select actor from audit_log where action = 'task.created' and detail->>'title' = 'AUTHTEST ceo audit actor'`;
    expect(audit[0]?.actor).toBe(`employee:${DEMO_CEO_ID}`);
    await sql`delete from task where title = 'AUTHTEST ceo audit actor'`;
    await sql`delete from audit_log where detail->>'title' = 'AUTHTEST ceo audit actor'`;
  });

  it("keeps the question box, report generation and invites for the CEO", async () => {
    const emp = as(await token(AUTH.priya));
    expect(await post("/dashboard/query", emp, { question: "how many blockers are open?" })).toBe(403);
    expect(await post("/dashboard/eod/generate", emp)).toBe(403);
    expect(await post("/employees/invite", emp, { displayName: "Auth Test" })).toBe(403);
    expect(await post("/employees/invite", {}, { displayName: "Auth Test" })).toBe(401);
    // The CEO gets past the gate. An invalid body proves it — the 400 comes from validation,
    // which runs after the gate — without spending a model call or minting an invite.
    const ceo = as(await token(AUTH.ceo));
    expect(await post("/dashboard/query", ceo, { question: "x" })).toBe(400);
    expect(await post("/employees/invite", ceo, { displayName: "" })).toBe(400);
  });

  it("accepts a legacy HS256 token only when the project's shared secret is configured", async () => {
    const secret = "legacy-project-shared-secret-000000";
    const legacy = await new SignJWT({ role: "authenticated" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(AUTH.priya)
      .setIssuer(issuer)
      .setAudience("authenticated")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(secret));
    expect(await status("/dashboard/me", as(legacy))).toBe(401);
    process.env.SUPABASE_JWT_SECRET = secret;
    try {
      expect(await status("/dashboard/me", as(legacy))).toBe(200);
      // Having a secret on file does not make a forged asymmetric token acceptable.
      expect(await status("/dashboard/me", as(await token(AUTH.priya, { key: foreign })))).toBe(401);
    } finally {
      delete process.env.SUPABASE_JWT_SECRET;
    }
  });
});
