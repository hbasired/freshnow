import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, enqueueNotification, getServiceSql } from "@freshnow/core";
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
