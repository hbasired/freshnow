import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, DEMO_CEO_ID, getServiceSql, recordComplianceSnapshot } from "@freshnow/core";
import { buildServer } from "./server.js";

/**
 * Rule R8 and the right to a copy of one's data: who may open what, that the file holds the
 * person's own records and nobody else's, that every export is audited, and that the daily
 * snapshot is written once per day.
 */

const app = buildServer(false);
const ME = randomUUID();
const OTHER = randomUUID();
let myTask = "";
let otherTask = "";

beforeAll(async () => {
  const sql = getServiceSql();
  await sql`insert into employee (id, display_name, status, is_synthetic, access_role) values
    (${ME}, 'CMP-Me', 'active', true, 'employee'), (${OTHER}, 'CMP-Other', 'active', true, 'employee')`;
  myTask = (await sql<{ id: string }[]>`insert into task (employee_id, title, is_synthetic) values (${ME}, 'CMP my task', true) returning id`)[0]!.id;
  otherTask = (await sql<{ id: string }[]>`insert into task (employee_id, title, is_synthetic) values (${OTHER}, 'CMP their task', true) returning id`)[0]!.id;
  await sql`insert into task_update (task_id, employee_id, status, note_raw, is_synthetic) values (${myTask}, ${ME}, 'pending', 'my own words', true)`;
  await sql`insert into task_update (task_id, employee_id, status, note_raw, is_synthetic) values (${otherTask}, ${OTHER}, 'pending', 'their private words', true)`;
});

afterAll(async () => {
  const sql = getServiceSql();
  const ids = [ME, OTHER];
  await sql`delete from task_update where employee_id = any(${ids})`;
  await sql`delete from task where employee_id = any(${ids})`;
  await sql`delete from audit_log where action = 'data.exported' and entity_id = any(${ids})`;
  await sql`delete from employee where id = any(${ids})`;
  await app.close();
  await closeDb();
});

const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: "GET", url, headers });

describe("the compliance record", () => {
  it("is the CEO's to open, and says which rules would stop production", async () => {
    expect((await get(`/dashboard/compliance?viewer=${ME}`)).statusCode).toBe(403);
    const r = await get("/dashboard/compliance?viewer=ceo");
    expect(r.statusCode).toBe(200);
    const body = r.json() as { policy: { production: boolean; refuse: boolean; findings: { rule: string }[] }; consent: { version: string }; registry: { services: unknown[] } | null };
    expect(body.policy.production).toBe(false); // the tests run as the demo
    expect(body.policy.refuse).toBe(false);
    expect(body.registry?.services.length).toBeGreaterThan(0);
    expect(body.consent.version).toMatch(/^2\./);
  });

  it("names a Cloudflare quick tunnel when the page came through one", async () => {
    const r = await get("/dashboard/compliance?viewer=ceo", { host: "funny-words.trycloudflare.com" });
    const findings = (r.json() as { policy: { findings: { service?: string }[] } }).policy.findings;
    expect(findings.some((f) => f.service === "cloudflare_quick_tunnel")).toBe(true);
  });
});

describe("a copy of your own data", () => {
  it("contains your records and not another person's, arrives as a file, and is audited", async () => {
    const r = await get(`/dashboard/me/export?viewer=${ME}`);
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-disposition"]).toMatch(/attachment; filename="freshnow-my-data-\d{4}-\d{2}-\d{2}\.json"/);
    const data = r.json() as { person: { id: string }; tasks: { title: string }[]; updates: { your_words: string }[]; devices: Record<string, unknown>[] };
    expect(data.person.id).toBe(ME);
    expect(data.tasks.map((t) => t.title)).toEqual(["CMP my task"]);
    expect(data.updates.map((u) => u.your_words)).toEqual(["my own words"]);
    expect(r.body).not.toContain("their private words");
    expect(r.body).not.toContain("p256dh"); // push keys are secrets, never in the file

    const audit = await getServiceSql()`select actor from audit_log where action = 'data.exported' and entity_id = ${ME}`;
    expect(audit.map((a) => a.actor)).toContain(`employee:${ME}`);
  });

  it("another person's data is the CEO's to export, nobody else's", async () => {
    expect((await get(`/dashboard/people/${OTHER}/export?viewer=${ME}`)).statusCode).toBe(403);
    const r = await get(`/dashboard/people/${OTHER}/export?viewer=ceo`);
    expect(r.statusCode).toBe(200);
    expect((r.json() as { person: { id: string } }).person.id).toBe(OTHER);
    const audit = await getServiceSql()`select actor from audit_log where action = 'data.exported' and entity_id = ${OTHER}`;
    expect(audit.map((a) => a.actor)).toContain(`employee:${DEMO_CEO_ID}`);
    expect((await get(`/dashboard/people/${randomUUID()}/export?viewer=ceo`)).statusCode).toBe(404);
  });
});

describe("the daily snapshot", () => {
  it("is written once per company day, counts only", async () => {
    const sql = getServiceSql();
    await sql`delete from audit_log where action = 'compliance.snapshot'`;
    expect(await recordComplianceSnapshot()).toEqual({ recorded: true });
    expect(await recordComplianceSnapshot()).toEqual({ recorded: false });
    const [row] = await sql<{ detail: { consent: unknown; reachable: unknown } }[]>`select detail from audit_log where action = 'compliance.snapshot'`;
    expect(row?.detail).toHaveProperty("consent");
    expect(JSON.stringify(row?.detail)).not.toMatch(/their private words|my own words/);
  });
});
