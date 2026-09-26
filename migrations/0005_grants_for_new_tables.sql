-- migrations/0005_grants_for_new_tables.sql — close a whole class of bug.
--
-- `grant ... on ALL TABLES IN SCHEMA public` in 0001 grants on the tables that exist
-- at that moment. It is not a standing rule. Every table added by a later migration —
-- bot_session (0002), daily_report (0003), attachment (0004) — therefore had a correct
-- RLS policy and NO privilege behind it, so the RLS-enforced app role could not read
-- them at all. The dashboard's end-of-day view returned a 500 for the CEO because of
-- exactly this: the policy said yes, the grant said nothing.
--
-- Two fixes, deliberately both:
--   1. Grant on what exists now (repairs 0002-0004).
--   2. ALTER DEFAULT PRIVILEGES so tables created LATER by the migration role are
--      covered automatically — otherwise the next migration reintroduces the bug.
--
-- The RLS policies remain the thing that decides WHO sees WHICH row. A grant only says
-- the role may attempt the read at all; default-deny still applies to any table without
-- a policy, so this does not widen visibility.

grant usage on schema public to freshnow_app;
grant select, insert, update, delete on all tables in schema public to freshnow_app;

-- Append-only: re-strip UPDATE/DELETE on the audit log, since the blanket grant above
-- would otherwise hand them back.
revoke update, delete on audit_log from freshnow_app;

-- Future tables created by this role inherit the same privileges.
alter default privileges in schema public
  grant select, insert, update, delete on tables to freshnow_app;
