import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { armEscalation, cancelEscalation, closeEscalation, escalationQueue } from "./escalation.js";

// Runs against the real Redis (freshnow-redis). We assert arming/cancelling the
// delayed job; we do NOT wait for the delay to fire (BullMQ's job, not ours).
afterAll(async () => {
  await escalationQueue().obliterate({ force: true }).catch(() => {});
  await closeEscalation();
});

describe("escalation timer (BullMQ)", () => {
  it("arms a delayed job and cancels it by blocker id", async () => {
    const id = randomUUID();
    await armEscalation(id, 60_000);
    const job = await escalationQueue().getJob(`esc-${id}`);
    expect(job).toBeTruthy();
    expect(job?.opts.delay).toBe(60_000);

    await cancelEscalation(id);
    expect(await escalationQueue().getJob(`esc-${id}`)).toBeFalsy();
  });

  it("dedupes on jobId (arming twice keeps one job)", async () => {
    const id = randomUUID();
    await armEscalation(id, 60_000);
    await armEscalation(id, 60_000);
    expect(await escalationQueue().getJob(`esc-${id}`)).toBeTruthy();
    await cancelEscalation(id);
    expect(await escalationQueue().getJob(`esc-${id}`)).toBeFalsy();
  });
});
