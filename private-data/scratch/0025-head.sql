-- migrations/0025_rbac_v2.sql — roles and permissions (TASK-057).
--
-- Seven roles join ceo/manager/lead/employee: admin, ops_head, supervisor, cash_auditor,
-- warehouse_keeper, technician, vmo. What each may do is ONE table, kept in two places:
-- packages/core/src/permissions.ts for the code, and role_capability here for row-level security —
-- a test fails the build if the two disagree. Deny by default: a role that does not list a
-- capability does not have it.
--
--   app_has_capability(cap)   does the viewer's role hold it? (the CEO's for the CEO)
--   app_reads_all()           sees everything the CEO sees — the CEO, and Admin (user decision,
--                             2026-10-15: "full access"). Admin is NOT made the CEO: app_is_ceo()
--                             is unchanged, so the CEO-only WRITE policies and the guard on
--                             privileged employee columns (0014) still mean the CEO alone.
--
-- Every read policy that said `app_is_ceo()` now says `(select app_reads_all())` — or, for the
-- Televend tables (0023), `(select app_has_capability('televend.read'))` so Ops Head and
-- Supervisor see them too. The `(select …)` form lets Postgres evaluate a row-independent check
-- once per statement instead of once per row (Supabase RLS performance guidance, checked
-- 2026-10-15) — it matters on tv_vend, which grows by about 47k rows a month.

-- ── 1. The roles ──────────────────────────────────────────────────────────────
alter table employee drop constraint if exists employee_access_role_check;
alter table employee add constraint employee_access_role_check check (access_role in (
  'ceo', 'admin', 'ops_head', 'supervisor', 'manager', 'lead',
  'cash_auditor', 'warehouse_keeper', 'technician', 'vmo', 'employee'));

-- ── 2. What each role may do (the SQL copy of permissions.ts) ────────────────
create table if not exists role_capability (
  role        text not null,
  capability  text not null,
  primary key (role, capability)
);
alter table role_capability enable row level security;
alter table role_capability force row level security;
drop policy if exists role_capability_select on role_capability;
-- Reference data, like routing_rule: anyone signed in may read what a role allows.
create policy role_capability_select on role_capability for select to freshnow_app using (true);
grant select on role_capability to freshnow_app;

-- Generated from ROLE_CAPABILITIES (permissions.ts) on 2026-10-15; the twin test keeps it honest.
insert into role_capability (role, capability) values
