import { describe, expect, it } from "vitest";
import { redisConnection } from "./redis.js";

const db = (url?: string): number => (redisConnection(url) as { db: number }).db;

describe("redisConnection — REDIS_URL read whole (G163)", () => {
  it("keeps the logical database, which is what lets the test suite live in its own", () => {
    expect(redisConnection("redis://localhost:6380/15")).toMatchObject({ host: "localhost", port: 6380, db: 15 });
    expect(db("redis://localhost:6380")).toBe(0);
    expect(redisConnection("redis://localhost")).toMatchObject({ port: 6379, db: 0 });
  });

  it("passes user, password and TLS through", () => {
    expect(redisConnection("rediss://app:p%40ss@redis.example:6390/2")).toMatchObject({
      host: "redis.example",
      port: 6390,
      db: 2,
      username: "app",
      password: "p@ss",
      tls: {},
    });
  });

  it("refuses a database that is not a whole number", () => {
    expect(() => redisConnection("redis://localhost:6379/x")).toThrow(/whole number/);
  });

  it("the suite itself runs in its own database, not the live worker's (vitest.setup.ts)", () => {
    if (process.env.TEST_REDIS_URL) return; // an explicit test server was given
    expect([14, 15]).toContain(db());
  });
});
