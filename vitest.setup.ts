import "dotenv/config";

// Point the db layer at the throwaway test database, never the live one. db.ts reads
// DATABASE_URL / DATABASE_URL_SERVICE lazily on first use, so setting them here (before any test
// touches the DB) is enough. Both are required — vitest.global-setup.ts checks they name
// freshnow_test and are not the live database: with TEST_DATABASE_URL missing, every RLS-context
// query in the suite ran against live data (review 2026-10-15).
if (!process.env.TEST_DATABASE_URL || !process.env.TEST_DATABASE_URL_SERVICE) {
  throw new Error("TEST_DATABASE_URL and TEST_DATABASE_URL_SERVICE must both be set: the suite never runs against the live database.");
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.DATABASE_URL_SERVICE = process.env.TEST_DATABASE_URL_SERVICE;

// Redis: the suite starts real BullMQ queues and workers (email-inbox, escalation), removes job
// schedulers and obliterates the escalation queue. Run in the developer's live Redis database, that
// silently stopped the running worker's Televend sync and email polling until it was restarted
// (G163). The suite gets its own logical database: TEST_REDIS_URL, or the same server's database 15
// (14 when the live one is 15) — never the live one.
{
  // The live URL is captured once per process: this file runs before every test file, and must
  // not take its own redirect for the live value the second time.
  process.env.FRESHNOW_LIVE_REDIS_URL ??= process.env.REDIS_URL ?? "redis://localhost:6379";
  const live = new URL(process.env.FRESHNOW_LIVE_REDIS_URL);
  const dbOf = (u: URL): number => (u.pathname.length > 1 ? Number(u.pathname.slice(1)) : 0);
  // One server however it is written: hosts compare case-insensitively, the local names as one,
  // and a missing port is Redis's default.
  const serverOf = (u: URL): string => {
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const local = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0";
    return `${local ? "local" : host}:${u.port || "6379"}`;
  };
  const test = new URL(process.env.TEST_REDIS_URL ?? live.href);
  if (!process.env.TEST_REDIS_URL) test.pathname = `/${dbOf(live) === 15 ? 14 : 15}`;
  if (serverOf(test) === serverOf(live) && dbOf(test) === dbOf(live)) {
    throw new Error("TEST_REDIS_URL is the live Redis database: the suite would remove the running worker's schedules (G163).");
  }
  process.env.REDIS_URL = test.href;
}

// Suites run the dashboard in demo mode (`?viewer=`) unless one turns sign-in on itself,
// so a developer's .env pointing at Supabase does not silently change what is tested.
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_ANON_KEY;
delete process.env.SUPABASE_JWT_SECRET;

// The same rule for the real mailbox. A laptop .env with the live Gmail settings (SMTP_*,
// EMAIL_*, incl. a two-address EMAIL_ALLOWLIST) made the email suites refuse their own test
// addresses and fail — 5 of the 7 failures in the TASK-055 baseline run (2026-10-15). Suites
// that need email set exactly the variables they test. EMAIL_TEST_* are kept: they are the
// opt-in switches of the real-mailbox suite (COMMANDS.md), not live settings — removing them
// silently skipped that suite for good.
for (const key of Object.keys(process.env)) {
  if ((key.startsWith("SMTP_") || key.startsWith("EMAIL_")) && !key.startsWith("EMAIL_TEST_")) delete process.env[key];
}

// Televend (TASK-055): no test may ever reach the real Televend Cloud with the real account.
// The client tests inject a stub fetch and explicit settings; with these removed, anything
// that falls back to the environment finds no credentials and refuses to sign in.
//
// Langfuse: every model call in a test queued a trace for the LIVE Langfuse project with the live
// keys (review 2026-10-15). langfuse.test.ts sets the values it tests itself.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("TELEVEND_") || key.startsWith("LANGFUSE_")) delete process.env[key];
}
