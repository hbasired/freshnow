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
    await sql.unsafe("drop schema if exists public cascade; create schema public;").simple();
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
