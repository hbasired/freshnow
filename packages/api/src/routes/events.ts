import type { FastifyInstance } from "fastify";
import { subscribeToChanges, type ChangeEvent } from "@freshnow/core";
import { resolveViewer } from "../viewer.js";

/**
 * Server-Sent Events: the dashboard is told when to look again, instead of guessing.
 *
 * SSE rather than a WebSocket because the traffic is one-directional and tiny — the client
 * never sends anything back, it just re-fetches — and SSE is plain HTTP that reconnects by
 * itself, needs no new dependency, and survives the existing auth hooks unchanged. A
 * WebSocket would mean a second protocol, a second auth path and a new package for a stream
 * that carries no data.
 *
 * The event carries only WHICH TABLE changed (migration 0013). Every client then re-fetches
 * through the ordinary RLS-scoped endpoints, so what a person sees is still decided by
 * Postgres and never by this stream.
 */

/** Bounded so a leak of open tabs cannot exhaust the box's sockets. */
const MAX_STREAMS = 50;
/** Below Caddy's and most proxies' idle timeouts, so an idle stream is never cut. */
const HEARTBEAT_MS = 25_000;

let openStreams = 0;

export function registerEventRoutes(app: FastifyInstance): void {
  app.get("/dashboard/events", async (req, reply) => {
    // Under real sign-in the auth hook has already rejected anyone unauthenticated; this
    // also gives a 403 body rather than an endless empty stream if that ever changes.
    await resolveViewer(req);

    if (openStreams >= MAX_STREAMS) {
      return reply.code(503).send({
        error: { code: "too_many_streams", message: "Too many live connections; the dashboard will keep polling." },
        correlationId: req.correlationId,
      });
    }

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Nginx and some proxies buffer by default, which turns a live stream into a slow drip.
      "X-Accel-Buffering": "no",
    });

    openStreams++;
    let closed = false;
    const write = (event: string, data: unknown): void => {
      if (closed) return;
      try {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        closed = true; // the socket went away mid-write; cleanup happens below
      }
    };

    // `retry` tells the browser how long to wait before reconnecting itself.
    reply.raw.write("retry: 3000\n\n");
    write("hello", { correlationId: req.correlationId, heartbeatMs: HEARTBEAT_MS });

    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = await subscribeToChanges((e: ChangeEvent) => write("change", e));
    } catch (err) {
      req.log.error({ err }, "could not subscribe to database changes");
      write("error", { message: "Live updates unavailable; the dashboard will keep polling." });
      closed = true;
      openStreams--;
      reply.raw.end();
      return reply;
    }

    // A comment line is a valid SSE keep-alive: it costs two bytes and stops an idle
    // connection being closed by a proxy, which would otherwise look like a dead stream.
    const heartbeat = setInterval(() => {
      if (closed) return;
      try {
        reply.raw.write(": ping\n\n");
      } catch {
        closed = true;
      }
    }, HEARTBEAT_MS);

    const cleanup = (): void => {
      if (closed && unsubscribe === undefined) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe?.();
      unsubscribe = undefined;
      openStreams = Math.max(0, openStreams - 1);
    };
    req.raw.on("close", cleanup);
    req.raw.on("error", cleanup);

    // Returning the reply object tells Fastify the response is being handled manually.
    return reply;
  });
}
