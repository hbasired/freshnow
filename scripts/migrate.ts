import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import "dotenv/config";
import postgres from "postgres";

// Minimal forward-only migration runner for the DEMO database (DATABASE_URL_SERVICE).
// Applied files are tracked in schema_migrations, so re-runs are safe and never drop.
// The throwaway test DB is migrated separately by vitest.global-setup.ts.
const url = process.env.DATABASE_URL_SERVICE;
if (!url) throw new Error("DATABASE_URL_SERVICE is required to run migrations");

const sql = postgres(url, { max: 1, onnotice: () => {} });
const dir = join(process.cwd(), "migrations");

try {
  await sql`create table if not exists schema_migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )`;
  const applied = new Set(
    (await sql<{ name: string }[]>`select name from schema_migrations`).map(
      (r) => r.name,
    ),
  );
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files) {
    if (applied.has(f)) {
      console.log(`· skip ${f} (already applied)`);
      continue;
    }
    console.log(`> applying ${f}`);
    await sql.unsafe(readFileSync(join(dir, f), "utf8")).simple();
    await sql`insert into schema_migrations (name) values (${f})`;
    console.log(`  applied ${f}`);
  }
  console.log("migrations up to date");
} finally {
  await sql.end();
}
