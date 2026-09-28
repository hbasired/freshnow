import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, currentNoticeHash, enqueueNotification, getServiceSql, noticeHash, recordConsent } from "@freshnow/core";
import { RateLimitError, deliverOutboxBatch, type Deliverer } from "./outbox-relay.js";

const key = (s: string) => `outbox-test-${s}`;

// The relay claims from the WHOLE queue, so these tests cannot assert on counts unless
// the queue starts empty. Any other suite that leaves a pending row — an assignment, an
// attachment — would otherwise be silently counted here and fail an unrelated assertion.
beforeEach(async () => {
  await getServiceSql()`delete from notification_outbox where status = 'pending'`;
});
afterEach(async () => {
  await getServiceSql()`delete from notification_outbox where idempotency_key like 'outbox-test-%'`;
});
afterAll(async () => {
  await closeDb();
});

describe("outbox relay", () => {
  it("delivers pending messages and marks them sent", async () => {
    await enqueueNotification({ idempotencyKey: key("a"), chatId: 111, payload: { text: "hi" } });
    await enqueueNotification({ idempotencyKey: key("b"), chatId: 222, payload: { text: "yo" } });

    const calls: unknown[] = [];
    const deliver: Deliverer = async (m) => {
      calls.push(m);
    };
    const r = await deliverOutboxBatch(deliver, { batchSize: 10 });

    expect(r.sent).toBe(2);
    expect(calls.length).toBe(2);
    const rows =
      await getServiceSql()`select status from notification_outbox where idempotency_key like 'outbox-test-%'`;
    expect(rows.every((x) => x.status === "sent")).toBe(true);
  });

  it("is idempotent on the key (duplicate enqueue = one row, delivered once)", async () => {
    const first = await enqueueNotification({ idempotencyKey: key("dup"), chatId: 1, payload: { text: "once" } });
    const second = await enqueueNotification({ idempotencyKey: key("dup"), chatId: 1, payload: { text: "once" } });
    expect(first.enqueued).toBe(true);
    expect(second.enqueued).toBe(false);

    let count = 0;
    await deliverOutboxBatch(async () => {
      count++;
    }, { batchSize: 10 });
    expect(count).toBe(1);
  });

  it("does not re-deliver an already-sent message (exactly-once for the recipient)", async () => {
    await enqueueNotification({ idempotencyKey: key("send1"), chatId: 1, payload: { text: "x" } });
    let count = 0;
    const deliver: Deliverer = async () => {
      count++;
    };
    await deliverOutboxBatch(deliver, { batchSize: 10 });
    await deliverOutboxBatch(deliver, { batchSize: 10 }); // second poll finds nothing pending
    expect(count).toBe(1);
  });

  it("abandons a message after maxAttempts of hard failures", async () => {
    await enqueueNotification({ idempotencyKey: key("fail"), chatId: 1, payload: { text: "x" } });
    const deliver: Deliverer = async () => {
      throw new Error("boom");
    };
    for (let i = 0; i < 3; i++) {
      await deliverOutboxBatch(deliver, { batchSize: 10, maxAttempts: 3 });
      // A failed row now backs off, so it is not due again immediately. Wind the clock
      // forward rather than sleeping — the point of the test is the abandon rule, not
      // the delay, and the delay itself is covered separately.
      await getServiceSql()`
        update notification_outbox set next_attempt_at = now()
        where idempotency_key = ${key("fail")}`;
    }
    const rows =
      await getServiceSql()`select status from notification_outbox where idempotency_key = ${key("fail")}`;
    expect(rows[0]?.status).toBe("abandoned");
  });

  it("keeps a message pending on a 429 rate limit — never abandons", async () => {
    await enqueueNotification({ idempotencyKey: key("rl"), chatId: 1, payload: { text: "x" } });
    const deliver: Deliverer = async () => {
      throw new RateLimitError("429", 1);
    };
    for (let i = 0; i < 4; i++) {
      await deliverOutboxBatch(deliver, { batchSize: 10, maxAttempts: 2 });
    }
    const rows =
      await getServiceSql()`select status from notification_outbox where idempotency_key = ${key("rl")}`;
    expect(rows[0]?.status).toBe("pending");
  });
});

describe("a failing row does not starve the queue", () => {
  it("backs off instead of being re-claimed on every poll", async () => {
    await enqueueNotification({ idempotencyKey: key("bo"), chatId: 1, payload: { text: "x" } });
    const deliver: Deliverer = async () => { throw new Error("boom"); };

    await deliverOutboxBatch(deliver, { batchSize: 10, maxAttempts: 9 });
    // Second poll immediately after: the row is not due, so nothing is attempted.
    const second = await deliverOutboxBatch(deliver, { batchSize: 10, maxAttempts: 9 });
    expect(second.total).toBe(0);

    const [row] = await getServiceSql()<{ due_in: number }[]>`
      select extract(epoch from (next_attempt_at - now()))::int as due_in
      from notification_outbox where idempotency_key = ${key("bo")}`;
    expect(row!.due_in).toBeGreaterThan(0);
  });

  it("honours Telegram's own retry_after on a 429", async () => {
    await enqueueNotification({ idempotencyKey: key("ra"), chatId: 1, payload: { text: "x" } });
    const deliver: Deliverer = async () => { throw new RateLimitError("429", 120); };

    await deliverOutboxBatch(deliver, { batchSize: 10 });

    const [row] = await getServiceSql()<{ due_in: number; status: string }[]>`
      select extract(epoch from (next_attempt_at - now()))::int as due_in, status
      from notification_outbox where idempotency_key = ${key("ra")}`;
    // The server is the only thing that knows when its own limit clears.
    expect(row!.due_in).toBeGreaterThan(100);
    // And a rate limit never abandons — the message is still wanted.
    expect(row!.status).toBe("pending");
  });

  it("delivers everyone else's messages while one row is failing", async () => {
    // The bug this guards: the relay claims the oldest `batchSize` PENDING rows. A row
    // that keeps failing stayed pending and was re-claimed every poll, so `batchSize`
    // such rows filled every batch and NOTHING else was ever delivered.
    await enqueueNotification({ idempotencyKey: key("stuck"), chatId: 1, payload: { text: "bad" } });
    await enqueueNotification({ idempotencyKey: key("good1"), chatId: 2, payload: { text: "ok" } });
    await enqueueNotification({ idempotencyKey: key("good2"), chatId: 3, payload: { text: "ok" } });

    const seen: string[] = [];
    const deliver: Deliverer = async ({ payload }) => {
      const t = (payload as { text: string }).text;
      if (t === "bad") throw new Error("boom");
      seen.push(t);
    };

    // batchSize 1 makes the starvation obvious: with no backoff the bad row would be the
    // only thing ever claimed.
    for (let i = 0; i < 3; i++) await deliverOutboxBatch(deliver, { batchSize: 1, maxAttempts: 9 });
    expect(seen.length).toBe(2);
  });
});

/**
 * Consent notice 2.0 (core/src/consent.ts): sending someone's work to Telegram, a push relay or
 * an email provider moves their data abroad, and consent to an older notice that never named
 * those services does not cover it. So those messages wait — without failing, without
 * blocking anyone else — until the person agrees; the inbox and the request itself never wait.
 */
describe("messages wait for consent to today's notice", () => {
  const people: string[] = [];
  async function person(): Promise<string> {
    const id = randomUUID();
    await getServiceSql()`insert into employee (id, display_name, status, telegram_user_id, is_synthetic)
      values (${id}, ${"RELAY-CONSENT " + id.slice(0, 8)}, 'active', ${9_900_000_000_000 + Math.floor(Math.random() * 1e6)}, true)`;
    people.push(id);
    return id;
  }
  afterEach(async () => {
    const sql = getServiceSql();
    await sql`delete from notification_outbox where recipient_employee_id = any(${people})`;
    await sql`delete from consent_record where employee_id = any(${people})`;
    await sql`delete from audit_log where entity = 'employee' and entity_id = any(${people})`;
    await sql`delete from employee where id = any(${people})`;
    people.length = 0;
  });

  async function statusOf(k: string): Promise<{ status: string; attempts: number }> {
    const [r] = await getServiceSql()<{ status: string; attempts: number }[]>`
      select status, attempts from notification_outbox where idempotency_key = ${k}`;
    return r!;
  }

  it("holds a Telegram message to someone who has not agreed, and delivers their inbox copy", async () => {
    const p = await person();
    await enqueueNotification({ idempotencyKey: key("held-tg"), chatId: 1, recipientEmployeeId: p, payload: { text: "your task" } });
    await enqueueNotification({ idempotencyKey: key("held-in"), channel: "inapp", recipientEmployeeId: p, payload: { text: "your task" } });
    let telegramCalls = 0;
    await deliverOutboxBatch(async () => {
      telegramCalls++;
    }, { batchSize: 10 });
    expect(telegramCalls).toBe(0);
    // Waiting, not failing: no attempt is spent, so it can never be abandoned for this.
    expect(await statusOf(key("held-tg"))).toEqual({ status: "pending", attempts: 0 });
    expect((await statusOf(key("held-in"))).status).toBe("sent");
  });

  it("delivers the consent request itself, which is how the person is asked", async () => {
    const p = await person();
    await enqueueNotification({
      idempotencyKey: key("ask"),
      chatId: 1,
      recipientEmployeeId: p,
      payload: { kind: "consent.requested", text: "please read" },
    });
    let telegramCalls = 0;
    await deliverOutboxBatch(async () => {
      telegramCalls++;
    }, { batchSize: 10 });
    expect(telegramCalls).toBe(1);
  });

  it("does not treat consent to an older notice as consent", async () => {
    const p = await person();
    await getServiceSql()`insert into consent_record (employee_id, policy_version, notice_hash)
                          values (${p}, 'demo-1.0', ${noticeHash("the old words")})`;
    await enqueueNotification({ idempotencyKey: key("old"), chatId: 1, recipientEmployeeId: p, payload: { text: "x" } });
    let telegramCalls = 0;
    await deliverOutboxBatch(async () => {
      telegramCalls++;
    }, { batchSize: 10 });
    expect(telegramCalls).toBe(0);
  });

  it("sends what was waiting on the first poll after the person agrees", async () => {
    const p = await person();
    await enqueueNotification({ idempotencyKey: key("later"), chatId: 1, recipientEmployeeId: p, payload: { text: "x" } });
    const sent: unknown[] = [];
    const deliver: Deliverer = async (m) => {
      sent.push(m);
    };
    await deliverOutboxBatch(deliver, { batchSize: 10 });
    expect(sent.length).toBe(0);

    await recordConsent({ employeeId: p, noticeHash: currentNoticeHash(), via: "telegram" });
    await deliverOutboxBatch(deliver, { batchSize: 10 });
    expect(sent.length).toBe(1);
    expect((await statusOf(key("later"))).status).toBe("sent");
  });
});
