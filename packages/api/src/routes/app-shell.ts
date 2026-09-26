import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

/**
 * Serve the built React dashboard from the API, at `/app`.
 *
 * Same origin as `/dashboard/*`, which is the point: no CORS configuration, no dev proxy
 * in production, and the phone reaches it on the same host and port it already uses.
 *
 * Mounted at `/app` rather than `/` deliberately. The existing hand-written dashboard
 * keeps `/` until the React one has been used on a real phone — a cutover you can do by
 * changing one line, and reverse just as fast, rather than a switch that has to be right
 * first time.
 */
export async function registerAppShell(app: FastifyInstance): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const dist = join(here, "..", "..", "..", "dashboard", "dist");

  if (!existsSync(join(dist, "index.html"))) {
    app.log.warn(
      { dist },
      "React dashboard not built — /app will 404. Run: pnpm --filter @freshnow/dashboard build",
    );
    return;
  }

  // No cache-control customisation on purpose. Hashed asset names could safely be cached
  // for a year, but index.html must not be, and @fastify/static's `setHeaders` types
  // disagree with what it passes at runtime. For a 67 kB bundle served over a LAN the
  // performance is irrelevant and a stale index.html after a deploy is not — so this
  // takes the correct-by-default option and revalidates every time.
  await app.register(fastifyStatic, { root: dist, prefix: "/app/" });

  // The app routes on the hash (#today, #carry), so there are no deep server paths to
  // rewrite — but /app without a trailing slash still has to land somewhere.
  app.get("/app", async (_req, reply) => reply.redirect("/app/"));
}
