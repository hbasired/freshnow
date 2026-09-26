import "dotenv/config";

// Point the db layer at the throwaway test database, never the demo database.
// db.ts reads DATABASE_URL / DATABASE_URL_SERVICE lazily on first use, so setting
// them here (before any test touches the DB) is enough.
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
if (process.env.TEST_DATABASE_URL_SERVICE) {
  process.env.DATABASE_URL_SERVICE = process.env.TEST_DATABASE_URL_SERVICE;
}

// Suites run the dashboard in demo mode (`?viewer=`) unless one turns sign-in on itself,
// so a developer's .env pointing at Supabase does not silently change what is tested.
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_ANON_KEY;
delete process.env.SUPABASE_JWT_SECRET;
