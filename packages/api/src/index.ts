import "dotenv/config";
import { checkPolicyAtStartup, loadConfig } from "@freshnow/core";
import { registerAppShell } from "./routes/app-shell.js";
import { buildServer } from "./server.js";

// Entrypoint: validate config, then listen. Routes live in ./routes.
// HOST defaults to 0.0.0.0 for the DEMO so the dashboard is reachable from the
// phones on the same wifi. Production binds localhost behind Caddy (DEVIATIONS #5).
const cfg = loadConfig();
// Policy as code (compliance/processors.json): reported in the demo, enforced when IS_DEMO=false.
checkPolicyAtStartup("api");
const app = buildServer();
const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "0.0.0.0";

// Authentication is on when SUPABASE_URL is set and OFF when it is not — and "not set"
// includes a typo. In that state `?viewer=ceo` makes anyone the CEO, and bound to 0.0.0.0
// that is anyone on the network. Demo mode is a legitimate configuration and is not
// refused, but it must never be a silent one: this is the loudest thing the process logs.
// (Audit 2026-09-18, I21.)
if (!cfg.SUPABASE_URL && host !== "127.0.0.1" && host !== "localhost") {
  const line = "!".repeat(78);
  console.warn(
    `
${line}
` +
      `  AUTHENTICATION IS OFF (SUPABASE_URL is not set) and the API is binding to ${host}.
` +
      `  Every /dashboard route accepts ?viewer=ceo from ANY client that can reach this port.
` +
      `  This is demo mode. If you did not intend it, set SUPABASE_URL or bind HOST=127.0.0.1.
` +
      `${line}
`,
  );
}

// The React dashboard is served from this same origin at /app, so there is no CORS
// configuration and no dev proxy in production. Registered here rather than inside
// buildServer because plugin registration is async and the test harness builds the
// server synchronously.
await registerAppShell(app);

app
  .listen({ port, host })
  .then((addr) => app.log.info(`API listening on ${addr} — React dashboard at ${addr}/app/`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
