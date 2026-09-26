import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getServiceSql } from "@freshnow/core";
import { buildServer } from "./server.js";

/**
 * The one route a stranger can reach. Every test here is a refusal except the last, because
 * that is the honest ratio: inbound email is a write path into the task table and the
 * interesting cases are all the ways it must say no.
 *
 * The happy path deliberately stops at "a proposal was made" — nothing is written to `task`
 * until a human confirms it in the dashboard, which is the whole safety argument.
 */

const app = buildServer(false);
const SECRET = "test-inbound-secret-at-least-16";
const TAG = "INBOUND";
const CEO_EMAIL = `${TAG.toLowerCase()}-boss@example.invalid`;
const WORKER_EMAIL = `${TAG.toLowerCase()}-worker@example.invalid`;
const BOSS = randomUUID();
const WORKER = randomUUID();
let savedSecret: string | undefined;

const pass = { spf: "pass", dkim: "pass", dmarc: "pass" };

const post = (payload: object, secret: string | null = SECRET) =>
  app.inject({
    method: "POST",
    url: "/inbound/email",
    ...(secret ? { headers: { "x-freshnow-inbound-secret": secret } } : {}),
    payload,
  });

beforeAll(async () => {
  savedSecret = process.env.INBOUND_EMAIL_SECRET;
  process.env.INBOUND_EMAIL_SECRET = SECRET;
  const sql = getServiceSql();
  await sql`insert into employee (id, display_name, status, is_synthetic, access_role, email) values
    (${BOSS}, ${`${TAG} Boss`}, 'active', true, 'manager', ${CEO_EMAIL}),
    (${WORKER}, ${`${TAG} Worker`}, 'active', true, 'employee', ${WORKER_EMAIL})`;
});

afterAll(async () => {
  if (savedSecret === undefined) delete process.env.INBOUND_EMAIL_SECRET;
  else process.env.INBOUND_EMAIL_SECRET = savedSecret;
  const sql = getServiceSql();
  await sql`delete from audit_log where action like 'inbound_email.%' and created_at > now() - interval '10 minutes'`;
  await sql`delete from employee where id in (${BOSS}, ${WORKER})`;
  await app.close();
  await closeDb();
});

describe("POST /inbound/email — the gates", () => {
  it("refuses a request with no secret, and never says what was wrong", async () => {
    const r = await post({ from: CEO_EMAIL, text: "hello", ...pass }, null);
    expect(r.statusCode).toBe(401);
    expect(r.body).not.toContain(SECRET);
  });

  it("refuses a wrong secret of the same length", async () => {
    expect((await post({ from: CEO_EMAIL, text: "hello", ...pass }, "x".repeat(SECRET.length))).statusCode).toBe(401);
  });

  it("refuses anything that fails SPF, DKIM or DMARC — the spoofing gate", async () => {
    for (const bad of [{ ...pass, dmarc: "fail" }, { ...pass, spf: "softfail" }, { ...pass, dkim: "none" }]) {
      const r = await post({ from: CEO_EMAIL, text: "Ask Priya to check van 2", ...bad });
      expect(r.statusCode).toBe(403);
      expect(r.json()).toMatchObject({ accepted: false });
    }
  });

  it("treats a missing verdict as a failure, not as permission", async () => {
    const r = await post({ from: CEO_EMAIL, text: "Ask Priya to check van 2" });
    expect(r.statusCode).toBe(403);
  });

  it("refuses an address nobody in the company owns", async () => {
    const r = await post({ from: "stranger@example.invalid", text: "Do this", ...pass });
    expect(r.statusCode).toBe(403);
    expect((r.json() as { reason: string }).reason).toMatch(/no active employee/);
  });

  it("refuses an ordinary employee — they cannot assign work in the dashboard either", async () => {
    const r = await post({ from: WORKER_EMAIL, text: "Do this", ...pass });
    expect(r.statusCode).toBe(403);
    expect((r.json() as { reason: string }).reason).toMatch(/manager, lead or the CEO/);
  });

  it("drops an out-of-office instead of turning it into a task", async () => {
    const r = await post({ from: CEO_EMAIL, text: "I am on leave until Sunday", ...pass, headers: { "auto-submitted": "auto-replied" } });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({ accepted: false });
  });

  it("drops bulk mail", async () => {
    const r = await post({ from: CEO_EMAIL, text: "Newsletter", ...pass, headers: { precedence: "bulk" } });
    expect(r.statusCode).toBe(202);
  });

  it("records every refusal, with the reason but never the body", async () => {
    await post({ from: "stranger@example.invalid", text: "SECRET-BODY-TEXT", ...pass });
    const [row] = await getServiceSql()<{ detail: Record<string, unknown> }[]>`
      select detail from audit_log where action = 'inbound_email.refused' order by created_at desc limit 1`;
    expect(row?.detail).toMatchObject({ from: "stranger@example.invalid" });
    expect(JSON.stringify(row?.detail)).not.toContain("SECRET-BODY-TEXT");
  });

  it("is invisible when the feature is not configured", async () => {
    const keep = process.env.INBOUND_EMAIL_SECRET;
    delete process.env.INBOUND_EMAIL_SECRET;
    try {
      expect((await post({ from: CEO_EMAIL, text: "hello", ...pass })).statusCode).toBe(404);
    } finally {
      process.env.INBOUND_EMAIL_SECRET = keep;
    }
  });
});

describe("POST /inbound/email — an accepted message", () => {
  it("stores the words before parsing, and returns a proposal rather than writing tasks", async () => {
    const before = await getServiceSql()<{ n: number }[]>`select count(*)::int as n from task`;

    const r = await post({
      from: `${TAG} Boss <${CEO_EMAIL}>`,
      subject: "Jobs for tomorrow",
      text: "Please ask the team to check the chiller on van 2 and restock the Deira machines.",
      ...pass,
    });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({ accepted: true });

    // The message was recorded before the model saw it.
    const [audit] = await getServiceSql()<{ detail: Record<string, unknown> }[]>`
      select detail from audit_log where action = 'inbound_email.received' order by created_at desc limit 1`;
    expect(audit?.detail).toMatchObject({ from: CEO_EMAIL, subject: "Jobs for tomorrow" });

    // And nothing was assigned: a proposal is not a write.
    const after = await getServiceSql()<{ n: number }[]>`select count(*)::int as n from task`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });
});
