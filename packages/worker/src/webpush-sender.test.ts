import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { closeDb, getServiceSql, savePushSubscription } from "@freshnow/core";
import { RateLimitError } from "./outbox-relay.js";
import { makeWebPushSender } from "./webpush-sender.js";

/**
 * The web-push sender against a real HTTP server standing in for Google/Apple/Mozilla.
 * Nothing is mocked: `web-push` encrypts the payload and POSTs it, and this server answers
 * with the status codes the real services use. The cases that matter are the failures —
 * a 410 must DELETE the subscription, because a subscription that fails forever is how a
 * queue silently fills with notifications to phones that no longer exist.
 */

const TAG = "PUSHTEST";
const EMP = randomUUID();
// A throwaway pair generated for this file only — `web-push` validates that the private
// key really is 32 bytes, so an invented string is rejected before anything is encrypted.
// These are not used anywhere but here, and the server they authenticate to is a local
// stand-in that ignores them.
const VAPID = {
  public: "BDLrttR8oMPM0dSq70PXUmfdRo4QsxtZ0BvV0FnxekoQ5vOs5D2j2x_6FxHfY6R0DQHDYg0Vlx7iL8a5QNO9oZs",
  private: "Fw-Zlw66xusLbwuCld4tqM-ps8iW8k7btKLCaGZfkmk",
};

/**
 * The transport is injected, because `web-push` speaks HTTPS and only HTTPS and a test
 * cannot put a plain server in front of it. What is real here: the database, the
 * subscription rows, the error shapes the push services actually return (a `statusCode` on
 * the error, and a `retry-after` header on a 429), and every decision this sender makes.
 * What is not covered, and is said so in the task notes: the encryption and the HTTP call.
 */
const status = new Map<string, number>();
const saved: Record<string, string | undefined> = {};

class PushServiceError extends Error {
  constructor(readonly statusCode: number, readonly headers: Record<string, string> = {}) {
    super(`push service returned ${statusCode}`);
  }
}

const transport = async (sub: { endpoint: string }): Promise<unknown> => {
  const code = status.get(sub.endpoint) ?? 201;
  if (code >= 400) throw new PushServiceError(code, code === 429 ? { "retry-after": "7" } : {});
  return { statusCode: code };
};

function subscriptionFor(path: string): { endpoint: string; p256dh: string; auth: string } {
  return {
    endpoint: `https://push.example.invalid${path}`,
    // A real P-256 public point (65 bytes, uncompressed) and a 16-byte auth secret, both
    // base64url. Kept valid even though nothing encrypts here, so the fixture stays honest
    // if the transport is ever swapped back for a real one.
    p256dh: "BE3OH0s_6GSt1bt8gYM-w-YfJnK2tI06rJJqqZNCEQ8_Ag-QvLhmcYnH0Mr-T_FIrfUuHa2mqqJhWGPudtbmkgA",
    auth: "0pOMSqnjFATYrdImiNtUgw",
  };
}

beforeAll(async () => {
  for (const k of ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]) saved[k] = process.env[k];
  process.env.VAPID_PUBLIC_KEY = VAPID.public;
  process.env.VAPID_PRIVATE_KEY = VAPID.private;
  process.env.VAPID_SUBJECT = "mailto:test@example.invalid";
  await getServiceSql()`insert into employee (id, display_name, status, is_synthetic) values (${EMP}, ${`${TAG} person`}, 'active', true)`;
});

afterAll(async () => {
  for (const k of ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  const sql = getServiceSql();
  await sql`delete from push_subscription where employee_id = ${EMP}`;
  await sql`delete from audit_log where actor = ${`employee:${EMP}`} or (entity = 'push_subscription' and created_at > now() - interval '5 minutes')`;
  await sql`delete from employee where id = ${EMP}`;
  await closeDb();
});

const sender = () => makeWebPushSender(transport);

const msg = { chatId: null, payload: { title: "Blocker", text: "van 2 chiller", url: "/app/#tasks/alerts" }, recipientEmployeeId: EMP };

describe("the web push sender", () => {
  it("refuses to start without VAPID keys, rather than dropping every push silently", () => {
    const keep = process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    onTestFinished(() => {
      process.env.VAPID_PRIVATE_KEY = keep;
    });
    expect(() => makeWebPushSender()).toThrow(/VAPID/);
  });

  it("sends to every device the person has", async () => {
    const a = subscriptionFor(`/ok-a-${randomUUID()}`);
    const b = subscriptionFor(`/ok-b-${randomUUID()}`);
    await savePushSubscription({ employeeId: EMP, ...a });
    await savePushSubscription({ employeeId: EMP, ...b });
    status.set(a.endpoint, 201);
    status.set(b.endpoint, 201);

    await expect(sender()(msg)).resolves.toBeUndefined();

    // Both devices were marked as reached.
    const rows = await getServiceSql()<{ last_seen_at: Date | null }[]>`
      select last_seen_at from push_subscription where employee_id = ${EMP}`;
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.last_seen_at !== null)).toBe(true);
    await getServiceSql()`delete from push_subscription where employee_id = ${EMP}`;
  });

  it("deletes a subscription the push service says is gone (410), and does not fail the message", async () => {
    const dead = subscriptionFor(`/gone-${randomUUID()}`);
    const live = subscriptionFor(`/live-${randomUUID()}`);
    await savePushSubscription({ employeeId: EMP, ...dead });
    await savePushSubscription({ employeeId: EMP, ...live });
    status.set(dead.endpoint, 410);
    status.set(live.endpoint, 201);

    // The live device got it, so the row is delivered — a dead laptop must not make the
    // queue retry something the phone already showed.
    await expect(sender()(msg)).resolves.toBeUndefined();

    const left = await getServiceSql()<{ endpoint: string }[]>`
      select endpoint from push_subscription where employee_id = ${EMP}`;
    expect(left.map((r) => r.endpoint)).toEqual([live.endpoint]);
    await getServiceSql()`delete from push_subscription where employee_id = ${EMP}`;
  });

  it("treats every-device-gone as delivered-to-nobody rather than retrying forever", async () => {
    const dead = subscriptionFor(`/all-gone-${randomUUID()}`);
    await savePushSubscription({ employeeId: EMP, ...dead });
    status.set(dead.endpoint, 404);

    await expect(sender()(msg)).resolves.toBeUndefined();
    expect((await getServiceSql()`select 1 from push_subscription where employee_id = ${EMP}`).length).toBe(0);
  });

  it("raises RateLimitError on 429 so the relay backs off instead of burning an attempt", async () => {
    const limited = subscriptionFor(`/limited-${randomUUID()}`);
    await savePushSubscription({ employeeId: EMP, ...limited });
    status.set(limited.endpoint, 429);

    await expect(sender()(msg)).rejects.toBeInstanceOf(RateLimitError);
    // The device is NOT deleted — being rate-limited is not being gone.
    expect((await getServiceSql()`select 1 from push_subscription where employee_id = ${EMP}`).length).toBe(1);
    await getServiceSql()`delete from push_subscription where employee_id = ${EMP}`;
  });

  it("succeeds when the person has no devices, instead of queueing forever", async () => {
    await expect(sender()(msg)).resolves.toBeUndefined();
  });

  it("asks the push service to wake the phone now only for an urgent message", async () => {
    // A blocker must not wait for the phone's next scheduled wake-up; everything else should
    // not drain somebody's battery. The flag reaches the transport, which turns it into the
    // RFC 8030 Urgency header.
    const sub = subscriptionFor(`/urgency-${randomUUID()}`);
    await savePushSubscription({ employeeId: EMP, ...sub });
    const seen: { urgent: boolean | undefined; body: Record<string, unknown> }[] = [];
    const recording = async (_s: { endpoint: string }, body: string, opts?: { urgent: boolean }): Promise<unknown> => {
      seen.push({ urgent: opts?.urgent, body: JSON.parse(body) as Record<string, unknown> });
      return { statusCode: 201 };
    };
    await makeWebPushSender(recording)({ ...msg, payload: { ...msg.payload, urgent: true, tag: "blocker-1" } });
    await makeWebPushSender(recording)({ ...msg, payload: { title: "New task", text: "count crates", url: "/app/?task=x#tasks/mine" } });
    expect(seen.map((s) => s.urgent)).toEqual([true, false]);
    // What the device's service worker reads: a title, a body, where to go, the collapse tag.
    expect(seen[0]!.body).toMatchObject({ title: "Blocker", body: "van 2 chiller", url: "/app/#tasks/alerts", tag: "blocker-1", urgent: true });
    expect(seen[1]!.body).toMatchObject({ title: "New task", body: "count crates", url: "/app/?task=x#tasks/mine" });
    await getServiceSql()`delete from push_subscription where employee_id = ${EMP}`;
  });
});
