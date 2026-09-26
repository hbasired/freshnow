-- migrations/0014_privilege_hardening.sql — close three holes an audit found on 2026-09-18.
--
-- None of the three was reachable over HTTP on the day it was found: every write route
-- checks permission before calling core, and core writes on the service role. But RLS is
-- the LAST line of defence, and the point of a last line is that it holds when the ones in
-- front of it do not. All three were places where the database would have permitted
-- something the application merely happened not to ask for.

-- ── 1. An employee could promote themselves to CEO ───────────────────────────
--
-- `employee_update` (migration 0001) was `USING/WITH CHECK (id = app_current_employee()
-- or app_is_ceo())` with NO COLUMN RESTRICTION, and `freshnow_app` holds UPDATE on the
-- table. Verified as the real app role with an ordinary employee context:
--
--   update employee set access_role = 'ceo' where id = <self>   -- ALLOWED
--   update employee set auth_user_id = <other> where id = <self> -- ALLOWED
--
-- So the row-level rule was right (you may only touch yourself) and the column-level rule
-- was missing entirely: "yourself" included your own authorization level and your own
-- dashboard-account binding.
--
-- Postgres has no per-column WITH CHECK, so this is a trigger. It refuses changes to the
-- columns that decide WHO YOU ARE and WHAT YOU MAY SEE unless the session is the CEO or
-- the service role (which has BYPASSRLS and is what `updateOrg` legitimately uses).
-- SECURITY INVOKER, deliberately. A SECURITY DEFINER trigger owned by `postgres` rewrites
-- `current_user` to the owner, so a "is this the service role?" test written against
-- `current_user` is true for EVERY caller and the guard passes everything through. That is
-- exactly what the first version of this trigger did, and the probe caught it.
-- `session_user` is the role that actually logged in and is not rewritten.
create or replace function employee_guard_privileged_columns() returns trigger
  language plpgsql set search_path = public, pg_temp as $fn$
begin
  -- The service role bypasses RLS and is the intended path for org changes (core
  -- `updateOrg`, the onboarding link step). `app_is_ceo()` covers a CEO acting through
  -- the app role. Everyone else may edit their own profile, not their own power.
  if pg_has_role(session_user, 'postgres', 'member') or app_is_ceo() then
    return new;
  end if;

  if new.access_role is distinct from old.access_role then
    raise exception 'access_role may only be changed by the CEO' using errcode = '42501';
  end if;
  if new.auth_user_id is distinct from old.auth_user_id then
    raise exception 'auth_user_id may only be changed by the CEO or the service role' using errcode = '42501';
  end if;
  if new.manager_employee_id is distinct from old.manager_employee_id then
    raise exception 'manager_employee_id may only be changed by the CEO' using errcode = '42501';
  end if;
  if new.department is distinct from old.department then
    raise exception 'department may only be changed by the CEO' using errcode = '42501';
  end if;
  if new.status is distinct from old.status then
    raise exception 'status may only be changed by the CEO' using errcode = '42501';
  end if;
  -- Telegram identity is how the bot decides who is speaking; rebinding it to somebody
  -- else's chat id would be an impersonation primitive. The unique constraint stops the
  -- exact collision, not the attempt.
  if new.telegram_user_id is distinct from old.telegram_user_id then
    raise exception 'telegram_user_id may only be changed by the CEO or the service role' using errcode = '42501';
  end if;
  return new;
end;
$fn$;

drop trigger if exists employee_privileged_columns on employee;
create trigger employee_privileged_columns
  before update on employee
  for each row execute function employee_guard_privileged_columns();

-- ── 2. Routing was not deterministic, because duplicates were possible ───────
--
-- `routing_rule` had only a primary key on `id`. `resolveForCategory` picks with
-- `order by (category is not null) desc limit 1`, so two rules for the same
-- (category, site, shift) made the winner arbitrary and plan-dependent — a data-entry
-- mistake would quietly break CLAUDE.md's "same inputs, same decision, every time".
--
-- NULLS NOT DISTINCT so that two catch-alls (all three columns NULL) also collide, which
-- is the case most likely to be entered twice.
do $$
begin
  if not exists (select 1 from pg_indexes where indexname = 'routing_rule_unique_match') then
    -- Drop any duplicates that already exist, keeping the oldest, or the index cannot build.
    delete from routing_rule a using routing_rule b
     where a.ctid > b.ctid
       and a.category is not distinct from b.category
       and a.site is not distinct from b.site
       and a.shift is not distinct from b.shift;
    create unique index routing_rule_unique_match
      on routing_rule (category, site, shift) nulls not distinct;
  end if;
end $$;

-- ── 3. Indexes on the foreign keys the hot paths actually join on ────────────
--
-- `escalation.blocker_id` is read per blocker by `escalateBlocker` AND by `slaSweep`'s
-- lateral join, which runs every 60 seconds over up to 200 blockers. The rest are joined
-- on every alert resolution. All were unindexed.
create index if not exists idx_escalation_blocker on escalation (blocker_id);
create index if not exists idx_escalation_escalated_to on escalation (escalated_to);
create index if not exists idx_alert_employee on alert (employee_id);
create index if not exists idx_task_watcher_employee on task_watcher (employee_id);
create index if not exists idx_consent_employee on consent_record (employee_id);
create index if not exists idx_escalation_target_employee on escalation_target (target_employee_id);
