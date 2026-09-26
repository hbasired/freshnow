import type { FastifyInstance } from "fastify";
import { createConnection } from "node:net";
import { concurrencyStats, getServiceSql, traceStats, tracingStats } from "@freshnow/core";

/**
 * Can we open a TCP connection to Redis? A full client would mean a dependency here just
 * to answer a health question; a socket that connects is enough to tell "the container is
 * gone" from "it is there", which is the distinction that was missing.
 */
async function pingRedis(timeoutMs = 1_000): Promise<"ok" | "down" | "not_configured"> {
  const raw = process.env.REDIS_URL;
  if (!raw) return "not_configured";
  let host: string;
  let port: number;
  try {
    const u = new URL(raw);
    host = u.hostname;
    port = Number(u.port || 6379);
  } catch {
    return "not_configured";
  }
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (r: "ok" | "down"): void => {
      socket.destroy();
      resolve(r);
    };
    socket.setTimeout(timeoutMs, () => done("down"));
    socket.once("connect", () => done("ok"));
    socket.once("error", () => done("down"));
  });
}

export function registerHealthRoute(app: FastifyInstance): void {
  app.get("/health", async (req) => {
    let db: "ok" | "down" = "ok";
    try {
      await getServiceSql()`select 1`;
    } catch {
      db = "down";
    }

    // Saturation is reported, not guessed. `waiting` above zero means people are queuing
    // for a model slot; `rejected` above zero means work was refused because the queue
    // was full — the number that says the box needs more capacity rather than patience.
    const load = concurrencyStats();
    const saturated = Object.values(load).some((s) => s.waiting > 0);

    // Tracing is optional and fire-and-forget, which means a broken tracer is silent by
    // design. Reporting its counters here is what makes "it is enabled" distinguishable
    // from "it is enabled and every send has failed for a week".
    const tracing = tracingStats();
    const trace = traceStats();

    // Redis backs the BullMQ queue. An audit on 2026-09-18 stopped the container and
    // /health still answered "ok" — a dependency being down and the system claiming health
    // is an observability lie even when the functional impact is currently nil (the
    // delayed-timer path is never armed; the SLA sweep is what actually escalates).
    const redis = await pingRedis();

    return {
      status: db === "ok" ? (saturated ? "busy" : "ok") : "degraded",
      db,
      // Reported separately from `status` on purpose: Redis being down does not currently
      // stop escalation, so calling the whole system degraded would overstate it. Saying
      // nothing understated it.
      redis,
      load,
      tracing,
      trace,
      correlationId: req.correlationId,
    };
  });
}
