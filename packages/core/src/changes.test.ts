import { afterAll, describe, expect, it } from "vitest";
import { closeChangeStream, subscribeToChanges, type ChangeEvent } from "./changes.js";
import { closeDb, getServiceSql } from "./db.js";

/**
 * The change stream's LISTEN connection (TASK-058; review 2026-10-17, live-updates-media#3). postgres.js
 * keeps the listener of a LISTEN that failed and re-listens it when the connection comes back, so a
 * retry on the same connection stacked one listener per attempt — and every change was then delivered
 * that many times. A failed start must leave nothing behind.
 */
afterAll(async () => {
  await closeChangeStream();
  await closeDb();
});

describe("the change stream", () => {
  it("after a start that failed, the next subscriber starts on a fresh connection and hears each change once", async () => {
    await closeChangeStream();
    const saved = process.env.DATABASE_URL_SERVICE;
    process.env.DATABASE_URL_SERVICE = "postgres://nobody:nothing@127.0.0.1:1/none";
    try {
      await expect(subscribeToChanges(() => undefined)).rejects.toThrow();
    } finally {
      process.env.DATABASE_URL_SERVICE = saved;
    }
    const heard: ChangeEvent[] = [];
    const stop = await subscribeToChanges((e) => {
      if (e.table === "changes_test") heard.push(e);
    });
    try {
      await getServiceSql()`select pg_notify('freshnow_change', ${JSON.stringify({ table: "changes_test", op: "insert", at: Date.now(), scope: ["*"] })})`;
      const deadline = Date.now() + 5000;
      while (heard.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      await new Promise((r) => setTimeout(r, 300)); // room for a duplicate to arrive, if there were one
      expect(heard).toHaveLength(1);
    } finally {
      stop();
    }
  });
});
