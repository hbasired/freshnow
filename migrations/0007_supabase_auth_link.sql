-- migrations/0007_supabase_auth_link.sql — link employees to Supabase Auth users, and
-- close the doors Supabase opens by default.
--
-- ── The link ───────────────────────────────────────────────────────────────────
-- A person signs in to the dashboard through Supabase Auth and gets a JWT whose `sub` is
-- their auth user id. `employee.auth_user_id` maps that id to the employee row whose RLS
-- context the dashboard then runs under. That replaces the `?viewer=` query parameter,
-- which anyone could set, with an identity the auth server vouches for.
--
-- Deliberately NO foreign key to `auth.users`. That table exists only in the Supabase
-- `postgres` database; the throwaway test database and a plain-Postgres deployment do not
-- have an `auth` schema, and a hard FK would make these migrations Supabase-only. The link
-- is checked in application code when a token is presented, which is where it matters.
--
-- ── The doors ──────────────────────────────────────────────────────────────────
-- Supabase grants every new table in `public` to its `anon` and `authenticated` roles by
-- default, because its Data API (PostgREST) serves `public` directly to browsers. This
-- system never exposes tables that way — every read goes through the API, which sets RLS
-- context itself. RLS is enabled with policies only for `freshnow_app`, so those grants
-- would be default-deny anyway; revoking them removes the reliance on that single layer.
--
-- Guarded, so the same file applies cleanly to plain Postgres where those roles do not
-- exist.

alter table employee add column if not exists auth_user_id uuid;

-- One auth account maps to at most one employee, and lookups by it are on every request.
create unique index if not exists employee_auth_user_id_key
  on employee (auth_user_id) where auth_user_id is not null;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon')
     and exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on all tables in schema public from anon, authenticated';
    execute 'revoke all on all sequences in schema public from anon, authenticated';
    execute 'revoke all on all functions in schema public from anon, authenticated';
    -- And for tables created by later migrations, which run as this same role.
    execute 'alter default privileges in schema public revoke all on tables from anon, authenticated';
    execute 'alter default privileges in schema public revoke all on sequences from anon, authenticated';
    execute 'alter default privileges in schema public revoke all on functions from anon, authenticated';
  end if;
end $$;
