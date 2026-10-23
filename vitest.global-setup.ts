import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import "dotenv/config";
import postgres from "postgres";

// Runs ONCE before the whole test suite. Creates a throwaway `freshnow_test`
// database (never the demo DB), resets its schema, and applies EVERY migration in
// order. Tests then run against it via the app + service roles. No mocking — real
// Postgres.
//
// Applying all of them (rather than only 0001) is the point: a test database that
// stops at the first migration silently stops testing every table added since, and
// the failure shows up as "relation does not exist" long after the migration landed.
export default async function setup(): Promise<void> {
  const adminUrl = requireEnv("DATABASE_URL_SERVICE");
  const testServiceUrl = requireEnv("TEST_DATABASE_URL_SERVICE");
  // The app-role URL too: without it every RLS-context query in the suite ran against the live
  // database (vitest.setup.ts redirects only what is set — review 2026-10-15).
  const testAppUrl = requireEnv("TEST_DATABASE_URL");

  // Step 2 DROPS the schema of the test database. Refuse unless both test URLs name the
  // throwaway `freshnow_test` and neither is the database the running system uses — a .env
  // that copied the live URL into a TEST_ line would otherwise wipe it (review 2026-10-15).
  for (const [name, url] of [["TEST_DATABASE_URL_SERVICE", testServiceUrl], ["TEST_DATABASE_URL", testAppUrl]] as const) {
    if (dbName(url) !== "freshnow_test") throw new Error(`${name} must name the freshnow_test database: the test setup drops its schema.`);
    for (const live of [process.env.DATABASE_URL, process.env.DATABASE_URL_SERVICE]) {
      if (live && sameDatabase(url, live)) throw new Error(`${name} is the live database: the test setup would drop its schema.`);
    }
  }

  // 1) Ensure the test database exists (CREATE DATABASE cannot run in a transaction).
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    const rows = await admin`select 1 from pg_database where datname = 'freshnow_test'`;
    if (rows.length === 0) await admin.unsafe("create database freshnow_test");
  } finally {
    await admin.end();
  }

  // 2) Reset schema + apply every migration on the test database (simple protocol
  //    so multi-statement SQL with dollar-quoted DO blocks is parsed server-side).
  const sql = postgres(testServiceUrl, { max: 1, onnotice: () => {} });
  try {
    // And ask the server itself, in case a proxy or alias maps the name elsewhere.
    const [{ db } = { db: "" }] = await sql<{ db: string }[]>`select current_database() as db`;
    if (db !== "freshnow_test") throw new Error(`refusing to reset "${db}": only freshnow_test is reset by the test setup.`);
    await sql.unsafe("drop schema if exists public cascade; create schema public;").simple();
    // The live database is Supabase's, where a function postgres creates in public is executable by
    // service_role by default (pg_default_acl). Reproduce that here, so a test of who may execute a
    // function says what is true live: without it, the TASK-058 privilege test passed on this database
    // while the live one granted service_role exactly what the test said nobody had.
    await sql.unsafe(`do $$ begin
      if exists (select 1 from pg_roles where rolname = 'service_role') then
        execute 'alter default privileges for role postgres in schema public grant execute on functions to service_role';
      end if;
    end $$;`).simple();
    const dir = join(process.cwd(), "migrations");
    // Filenames are zero-padded and forward-only, so lexical order is apply order.
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const f of files) {
      await sql.unsafe(readFileSync(join(dir, f), "utf8")).simple();
    }
  } finally {
    await sql.end();
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var for tests: ${name}`);
  return v;
}

const dbName = (url: string): string => decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));

/** Same server and database? Hosts compare case-insensitively, with the local names treated as one. */
function sameDatabase(a: string, b: string): boolean {
  const key = (raw: string): string => {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const local = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0";
    return `${local ? "local" : host}:${u.port || "5432"}/${dbName(raw)}`;
  };
  return key(a) === key(b);
}
