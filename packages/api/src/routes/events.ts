import type { FastifyInstance } from "fastify";
import { loadConfig, openLiveAudience, subscribeToChanges, type ChangeEvent, type ChangeScope } from "@freshnow/core";
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
 *
 * Since TASK-058 (migration 0027) a change is sent only to the people it concerns: the
 * notification says whom, and each stream's audience (core live-audience.ts) decides in the
 * row-security policies' own terms. What is written to the socket is unchanged — `{table, op,
 * at}` — and the scope itself never leaves this process.
 */

/** Below Caddy's and most proxies' idle timeouts, so an idle stream is never cut. */
const HEARTBEAT_MS = 25_000;
/**
 * A client that stops reading lets frames pile up in this process. Past this much unsent, the
 * stream is ended: the browser reconnects and refetches, which is cheaper than holding its backlog.
 */
const MAX_UNSENT_BYTES = 64 * 1024;
/** How long a new stream waits for its audience before greeting; past it, everything is heard. */
const AUDIENCE_WAIT_MS = 2_000;

let openStreams = 0;
const streamsByPerson = new Map<string, number>();

export function registerEventRoutes(app: FastifyInstance): void {
  app.get("/dashboard/events", async (req, reply) => {
    // Under real sign-in the auth hook has already rejected anyone unauthenticated; this
    // also gives a 403 body rather than an endless empty stream if that ever changes.
    const viewer = await resolveViewer(req);
    const person = viewer.employeeId;

    // Read per connection: loadConfig() parses the environment each time, so a limit can be
    // tested without restarting, and a bad value fails here loudly rather than at import.
    const { LIVE_MAX_STREAMS, LIVE_MAX_STREAMS_PER_PERSON } = loadConfig();
    const full = openStreams >= LIVE_MAX_STREAMS;
    const theirs = streamsByPerson.get(person) ?? 0;
    if (full || theirs >= LIVE_MAX_STREAMS_PER_PERSON) {
      return reply.code(503).send({
        error: {
          code: "too_many_streams",
          message: full
            ? "Too many live connections; the dashboard will keep polling."
            : "Too many live connections open for you; this one will keep polling.",
        },
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
    streamsByPerson.set(person, theirs + 1);
    const audience = openLiveAudience(person);
    let closed = false;
    let unsubscribe: (() => void) | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe?.();
      unsubscribe = undefined;
      audience.close();
      openStreams = Math.max(0, openStreams - 1);
      const left = (streamsByPerson.get(person) ?? 1) - 1;
      if (left > 0) streamsByPerson.set(person, left);
      else streamsByPerson.delete(person);
    };
    const end = (): void => {
      cleanup();
      // destroy, not end: end() waits to flush to a client that is not reading, so its socket and the
      // unsent backlog lived on after it stopped counting against the stream caps (review 2026-10-17,
      // live-updates-media#9). Its browser reconnects and refetches.
      reply.raw.destroy();
    };
    req.raw.on("close", cleanup);
    req.raw.on("error", cleanup);

    const send = (frame: string): void => {
      if (closed) return;
      try {
        reply.raw.write(frame);
      } catch {
        cleanup(); // the socket went away mid-write
        return;
      }
      if (reply.raw.writableLength > MAX_UNSENT_BYTES) end();
    };
    const write = (event: string, data: unknown): void => send(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    // `retry` tells the browser how long to wait before reconnecting itself.
    send("retry: 3000\n\n");

    // Greet once the audience is known, so a "hello" means the filter is in force. A slow load
    // does not hold the stream back: until it lands, every change is heard (the safe direction).
    await Promise.race([audience.ready, new Promise((r) => setTimeout(r, AUDIENCE_WAIT_MS))]);
    if (closed) return reply;
    write("hello", { correlationId: req.correlationId, heartbeatMs: HEARTBEAT_MS });

    try {
      unsubscribe = await subscribeToChanges((e: ChangeEvent, scope: ChangeScope) => {
        if (closed) return;
        if (!audience.active) return end();
        if (!audience.hears(scope)) return;
        // Exactly these three fields — never the scope (D92, D206).
        write("change", { table: e.table, op: e.op, at: e.at });
        // Who may see whom just changed — possibly this person's own access. Once their picture is
        // reloaded, a person switched off loses the stream now rather than at the next change.
        if (scope.includes("org")) {
          void audience.ready.then(() => {
            if (!closed && !audience.active) end();
          });
        }
      });
    } catch (err) {
      req.log.error({ err }, "could not subscribe to database changes");
      write("error", { message: "Live updates unavailable; the dashboard will keep polling." });
      end();
      return reply;
    }
    if (closed) {
      unsubscribe?.(); // the client left while we were subscribing
      return reply;
    }

    // A comment line is a valid SSE keep-alive: it costs two bytes and stops an idle
    // connection being closed by a proxy, which would otherwise look like a dead stream.
    heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);

    // Returning the reply object tells Fastify the response is being handled manually.
    return reply;
  });
}

/** Open streams in this process — for /health and the load test. */
export function openLiveStreams(): number {
  return openStreams;
}
