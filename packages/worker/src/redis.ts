import type { ConnectionOptions } from "bullmq";

/**
 * The worker's Redis connection, read whole from REDIS_URL: host, port, user, password, TLS
 * (`rediss:`) and the logical database (`redis://host:6380/15`).
 *
 * The database number is the point. Both queue modules used to read only host and port, so the
 * test suite — which starts real BullMQ queues, removes job schedulers and obliterates the
 * escalation queue — ran in the same database as a developer's live worker and silently stopped
 * its Televend sync and email polling (G163). vitest.setup.ts now gives the suite its own
 * database, which only works because this honours it.
 */
export function redisConnection(raw: string = process.env.REDIS_URL ?? "redis://localhost:6379"): ConnectionOptions {
  const url = new URL(raw);
  const db = url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0;
  if (!Number.isInteger(db) || db < 0) throw new Error("REDIS_URL: the database must be a whole number, e.g. redis://localhost:6379/0");
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    db,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(url.protocol === "rediss:" ? { tls: {} } : {}),
    // BullMQ workers block on Redis; ioredis must not give up on a command mid-wait.
    maxRetriesPerRequest: null,
  };
}
