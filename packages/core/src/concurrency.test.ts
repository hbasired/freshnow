import { describe, expect, it } from "vitest";
import { QueueFullError, Semaphore } from "./concurrency.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("bounded concurrency", () => {
  it("never runs more than the limit at once", async () => {
    const sem = new Semaphore("test", 3, 100);
    let live = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 30 }, () =>
        sem.run(async () => {
          live++;
          peak = Math.max(peak, live);
          await sleep(5);
          live--;
        }),
      ),
    );

    expect(peak).toBe(3);
    expect(sem.stats.active).toBe(0);
    expect(sem.stats.peakActive).toBe(3);
  });

  it("runs every queued item — waiting is not dropping", async () => {
    const sem = new Semaphore("test", 2, 100);
    let done = 0;
    await Promise.all(
      Array.from({ length: 25 }, () => sem.run(async () => { await sleep(2); done++; })),
    );
    // An employee whose message is slow still gets an answer; one whose message is
    // dropped has learned not to trust the bot.
    expect(done).toBe(25);
  });

  it("releases the slot when the work throws", async () => {
    const sem = new Semaphore("test", 1, 10);
    await expect(sem.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    // A leaked slot would wedge the whole system after one bad request.
    expect(sem.stats.active).toBe(0);
    await expect(sem.run(async () => "ok")).resolves.toBe("ok");
  });

  it("fails fast once the wait queue is full, rather than growing forever", async () => {
    const sem = new Semaphore("test", 1, 2);
    const held = sem.run(() => sleep(50));
    const queued = [sem.run(() => sleep(1)), sem.run(() => sleep(1))];

    // An unbounded queue under sustained overload is a slower way to run out of memory,
    // and it holds work until long after the person gave up.
    await expect(sem.run(async () => "nope")).rejects.toBeInstanceOf(QueueFullError);
    expect(sem.stats.rejected).toBe(1);

    await Promise.all([held, ...queued]);
  });

  it("preserves order for queued work", async () => {
    const sem = new Semaphore("test", 1, 100);
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => sem.run(async () => { order.push(i); await sleep(1); })),
    );
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("a burst of 50 finishes in about ceil(50/limit) waves, not serially", async () => {
    const sem = new Semaphore("test", 10, 200);
    const started = Date.now();
    await Promise.all(Array.from({ length: 50 }, () => sem.run(() => sleep(20))));
    const elapsed = Date.now() - started;

    // 5 waves x 20ms = ~100ms concurrently, versus 1000ms if it ran one at a time.
    // Generous upper bound so a slow CI machine does not make this flaky.
    expect(elapsed).toBeLessThan(500);
  });
});
