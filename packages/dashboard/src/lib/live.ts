import { useCallback, useEffect, useRef, useState } from "react";
import { requestContext } from "./api";

/**
 * Live updates: the board is told when to look again, instead of guessing every 20 seconds.
 *
 * ── Why this is `fetch`, not `EventSource` ──────────────────────────────────
 *
 * `EventSource` is the obvious tool and it cannot be used here: it has no way to send an
 * `Authorization` header, so the only place a token could go is the URL — where it would be
 * written into every access log, proxy cache and browser history entry along the way. The
 * dashboard authenticates with a Bearer token, so the stream is read with `fetch` and a
 * streaming body reader instead, which carries the same headers as every other call.
 *
 * The cost is that reconnection is ours to implement rather than the browser's, which is
 * what the backoff below is. The benefit is that a session token never appears in a URL.
 *
 * Three things make this safe to rely on and safe to lose:
 *
 *  1. The event carries only WHICH TABLE changed — never any row content. The refresh it
 *     triggers goes through the ordinary RLS-scoped endpoints, so what a person sees is
 *     still decided by Postgres.
 *  2. The poll never goes away. It slows down while the stream is healthy and speeds back up
 *     the moment it is not, so a stream that dies quietly degrades to what we had before
 *     rather than to a board that has silently stopped updating.
 *  3. Changes are debounced. One person finishing a task writes to several tables in a few
 *     milliseconds; that is one refresh, not five.
 */

export type LiveStatus = "connecting" | "live" | "polling";

/** Long enough to coalesce one action's writes, short enough to feel immediate. */
const DEBOUNCE_MS = 400;
/** While the stream is healthy the poll is only a safety net. */
const POLL_LIVE_MS = 120_000;
/** Without a stream, the original cadence. */
const POLL_FALLBACK_MS = 20_000;
/** How often the poll wakes to ask "is a refresh due yet". Cheap; it usually does nothing. */
const POLL_TICK_MS = 2_000;
/** Reconnect backoff, capped so a board left open overnight always comes back. */
const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

export function useLiveUpdates(onChange: () => void, enabled = true): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>(enabled ? "connecting" : "polling");
  // Kept in a ref so reconnecting never depends on the identity of the callback, which
  // changes on every render of the board.
  const cb = useRef(onChange);
  cb.current = onChange;
  // The poll reads these rather than depending on them, so a flapping stream can never
  // restart the timer. See the comment on the poll effect at the bottom.
  const statusRef = useRef<LiveStatus>(status);
  statusRef.current = status;
  const lastRefresh = useRef<number>(Date.now());
  /** Every refresh goes through here, so the poll knows when one last happened. */
  const refresh = useCallback(() => {
    lastRefresh.current = Date.now();
    cb.current();
  }, []);

  useEffect(() => {
    if (!enabled) {
      setStatus("polling");
      return;
    }

    let stopped = false;
    let attempt = 0;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();

    const fire = (): void => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => refresh(), DEBOUNCE_MS);
    };

    /** Parse the SSE wire format: frames separated by a blank line, `field: value` per line. */
    const handleFrame = (frame: string): void => {
      let event = "message";
      for (const line of frame.split("\n")) {
        if (line.startsWith(":")) continue; // a heartbeat comment
        if (line.startsWith("event:")) event = line.slice(6).trim();
      }
      if (event === "hello") {
        attempt = 0; // a stream that greets us has earned a fresh backoff budget
        setStatus("live");
      } else if (event === "change") {
        fire();
      } else if (event === "error") {
        // The server told us it cannot serve this stream. Keep the backoff climbing so we
        // do not hammer it, and let the poll carry the board.
        setStatus("polling");
      }
    };

    const connect = async (): Promise<void> => {
      const { headers, query } = requestContext();
      const res = await fetch(`/dashboard/events${query ? `?${query}` : ""}`, {
        headers: { ...headers, accept: "text/event-stream" },
        signal: controller.signal,
        // Never serve this from a cache: it is a stream, and a cached one never ends.
        cache: "no-store",
      });
      if (!res.ok || !res.body) throw new Error(`stream refused (${res.status})`);

      // NOT `attempt = 0` here. The server answers 200 and writes its headers before it
      // knows whether it can subscribe at all; its failure path then sends `event: error`
      // and closes. Resetting the backoff on the status code alone turned that into a
      // permanent one-reconnect-per-second loop against the API. The backoff is reset in
      // `handleFrame` instead, when a `hello` proves the stream is actually serving.
      setStatus("connecting");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Frames are separated by a blank line; keep the trailing partial in the buffer.
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const f of frames) if (f.trim()) handleFrame(f);
      }
      throw new Error("stream ended");
    };

    const loop = (): void => {
      if (stopped) return;
      void connect().catch(() => {
        if (stopped) return;
        setStatus("polling");
        // The poll has already sped back up by the time this fires, so a board whose stream
        // never returns still refreshes — just at the old cadence.
        const wait = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]!;
        attempt++;
        retry = setTimeout(loop, wait);
      });
    };
    loop();

    return () => {
      stopped = true;
      if (debounce) clearTimeout(debounce);
      if (retry) clearTimeout(retry);
      controller.abort();
    };
  }, [enabled]);

  /**
   * The poll that never goes away — and, just as importantly, never RESTARTS.
   *
   * This used to be `setInterval(..., status === "live" ? 120s : 20s)` keyed on `status`.
   * A flapping stream changes `status` every second or so, which cleared and recreated the
   * interval before it could ever reach 20 seconds: the board silently stopped refreshing,
   * which is the exact failure the fallback exists to prevent.
   *
   * So the timer is fixed and cheap, and the CADENCE is read from a ref on each tick.
   * Nothing about the stream can stop this firing.
   */
  useEffect(() => {
    const tick = setInterval(() => {
      const due = statusRef.current === "live" ? POLL_LIVE_MS : POLL_FALLBACK_MS;
      if (Date.now() - lastRefresh.current >= due) refresh();
    }, POLL_TICK_MS);
    return () => clearInterval(tick);
  }, [refresh]);

  return status;
}
