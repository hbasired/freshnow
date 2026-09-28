import type { FastifyInstance } from "fastify";
import { loadConfig } from "@freshnow/core";

/**
 * Same-origin sign-in for a LOCAL Supabase.
 *
 * The browser signs in against Supabase Auth directly. With the local stack that is
 * `http://<laptop>:54321` — a second port, over plain HTTP. That worked on the office Wi-Fi,
 * but it is a dead end for the one thing a phone demo needs most: web push only runs on an
 * HTTPS page (a browser rule, G107), and an HTTPS page may not call a plain-HTTP port (mixed
 * content). So a phone could either sign in or receive notifications, never both.
 *
 * Passing the three auth calls the dashboard makes through this server puts sign-in on the
 * same origin as the page. One HTTPS tunnel to port 3001 then covers everything, and the
 * firewall no longer needs 54321 open.
 *
 * Deliberately narrow: only what `packages/dashboard/src/Root.tsx` uses —
 *   POST /auth/v1/token?grant_type=password|refresh_token   (sign in, stay signed in)
 *   POST /auth/v1/logout                                     (sign out)
 *   GET  /auth/v1/user                                       (the client may re-read the user)
 * Everything else is 404 without touching Supabase: no sign-up (the local config has
 * `enable_signup = true`, and accounts are created by `pnpm link:user` only), no admin API,
 * no password recovery or magic links.
 *
 * Only for a local Supabase (127.0.0.1 / localhost). A hosted project is already HTTPS on its
 * own domain, so there is nothing to fix and the route stays off.
 *
 * Tokens are unaffected: GoTrue signs them with its configured issuer, not the host the
 * request came through, so `auth.ts` verifies them exactly as before.
 */

const ALLOWED: Record<string, readonly string[]> = {
  "POST token": ["password", "refresh_token"],
  "POST logout": [],
  "GET user": [],
};

/** Headers the Supabase JS client sends that GoTrue needs. Nothing else is forwarded. */
const FORWARD_HEADERS = ["apikey", "authorization", "content-type", "x-client-info", "x-supabase-api-version"];

const UPSTREAM_TIMEOUT_MS = 10_000;

export function isLocalSupabase(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const h = new URL(url).hostname;
    return h === "127.0.0.1" || h === "localhost";
  } catch {
    return false;
  }
}

export function registerAuthProxyRoutes(app: FastifyInstance): void {
  // An encapsulated scope, so its body handling cannot leak into the rest of the API. The
  // body is passed through as bytes: supabase-js sends `Content-Type: application/json` with
  // an EMPTY body on sign-out, which Fastify's JSON parser rejects with a 400.
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

    scope.route({
      method: ["GET", "POST"],
      url: "/auth/v1/:op",
      handler: async (req, reply) => {
        const base = loadConfig().SUPABASE_URL;
        const { op } = req.params as { op: string };
        const grants = ALLOWED[`${req.method} ${op}`];
        const query = req.query as Record<string, string | undefined>;
        const refused = () =>
          reply.code(404).send({ error: { code: "not_found", message: "Not found", correlationId: req.correlationId } });

        if (!isLocalSupabase(base) || !grants) return refused();
        if (op === "token" && !grants.includes(query.grant_type ?? "")) return refused();

        const target = new URL(`${base!.replace(/\/$/, "")}/auth/v1/${op}`);
        for (const [k, v] of Object.entries(query)) if (typeof v === "string") target.searchParams.set(k, v);

        const headers: Record<string, string> = {};
        for (const h of FORWARD_HEADERS) {
          const v = req.headers[h];
          if (typeof v === "string") headers[h] = v;
        }
        // GoTrue rate-limits sign-in per client address; without this every attempt would
        // look like it came from the API itself.
        headers["x-forwarded-for"] = req.ip;

        let res: Response;
        try {
          res = await fetch(target, {
            method: req.method,
            headers,
            ...(req.method === "POST" && Buffer.isBuffer(req.body) && req.body.length > 0 ? { body: req.body } : {}),
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
          });
        } catch (err) {
          req.log.warn({ err }, "auth proxy: Supabase Auth unreachable");
          return reply.code(502).send({
            error: { code: "bad_gateway", message: "Sign-in service is not reachable — is Supabase running?", correlationId: req.correlationId },
          });
        }

        reply.code(res.status);
        const type = res.headers.get("content-type");
        if (type) reply.header("content-type", type);
        const retryAfter = res.headers.get("retry-after");
        if (retryAfter) reply.header("retry-after", retryAfter);
        // Tokens must never be cached by a proxy or the browser.
        reply.header("cache-control", "no-store");
        return reply.send(Buffer.from(await res.arrayBuffer()));
      },
    });
  });
}
