-- migrations/0009_org_roles.sql — who reports to whom, and who may see whom.
--
-- Until now the system knew two kinds of person: the CEO, who sees everything, and an
-- employee, who sees their own rows. `employee.manager_employee_id` existed and was
-- documented, but RLS treated a manager as an ordinary employee, and the seed made everyone
-- report to the CEO. This migration makes the org chart mean something:
--
--   ceo       sees and assigns everything (unchanged)
--   manager   sees and assigns to their direct reports (manager_employee_id = them)
--   lead      a manager who also sees everyone in their department
--   employee  their own rows only (unchanged)
--
-- `access_role` is what a person is ALLOWED to do; `role_title` stays the free-text job
-- title the person typed at onboarding. The two are deliberately separate columns.
--
-- Every visibility rule below goes through ONE function, app_can_view_employee(target), so
-- "may this viewer see this person's data" has exactly one answer, testable on its own.

alter table employee
  add column if not exists access_role text not null default 'employee'
    check (access_role in ('ceo', 'manager', 'lead', 'employee'));

update employee set access_role = 'ceo' where id = '00000000-0000-0000-0000-0000000000ce';

-- The reporting line is now queried on every read; it was never indexed.
create index if not exists idx_employee_manager on employee (manager_employee_id);
create index if not exists idx_employee_department on employee (department);

-- ── Context helpers ───────────────────────────────────────────────────────────
-- Set per transaction by withContext, alongside app.employee_id and app.is_ceo.
create or replace function app_access_role() returns text
  language sql stable as $fn$
    select coalesce(nullif(current_setting('app.access_role', true), ''), 'employee')
$fn$;

create or replace function app_department() returns text
  language sql stable as $fn$
    select nullif(current_setting('app.department', true), '')
$fn$;

-- SECURITY DEFINER for the same reason as employee_display_name (0008): this function reads
-- `employee`, and a policy on `employee` that called a SECURITY INVOKER function reading
-- `employee` would recurse into itself. The owner bypasses RLS; search_path is pinned so a
-- caller cannot redirect `employee` to a table of their own. STABLE lets the planner reuse it.
create or replace function app_can_view_employee(target uuid) returns boolean
  language sql stable security definer
  set search_path = public
  as $fn$
    select target is not null and (
         app_is_ceo()
      or target = app_current_employee()
      -- A manager or lead sees their direct reports.
      or (app_access_role() in ('manager', 'lead')
          and exists (select 1 from employee e
                       where e.id = target and e.manager_employee_id = app_current_employee()))
      -- A lead also sees everyone in their department.
      or (app_access_role() = 'lead'
          and app_department() is not null
          and exists (select 1 from employee e
                       where e.id = target
                         -- Departments are typed by people at onboarding; "Production" and
                         -- "production" are the same department.
                         and lower(trim(e.department)) = lower(trim(app_department()))))
    )
$fn$;

revoke all on function app_can_view_employee(uuid) from public;
grant execute on function app_can_view_employee(uuid) to freshnow_app;

-- ── The reporting line must not loop ─────────────────────────────────────────
-- A can manage B who manages A was possible before. Any recursive "who is above me"
-- query would then never finish. Walk up from the proposed manager; if the row itself
-- appears within 20 hops, refuse. Twenty is far deeper than any real org here.
create or replace function employee_manager_cycle_guard() returns trigger
  language plpgsql as $fn$
declare
  cur uuid := new.manager_employee_id;
  hops int := 0;
begin
  if cur is null then return new; end if;
  if cur = new.id then
    raise exception 'an employee cannot be their own manager';
  end if;
  while cur is not null and hops < 20 loop
    select manager_employee_id into cur from employee where id = cur;
    if cur = new.id then
      raise exception 'reporting line would form a cycle';
    end if;
    hops := hops + 1;
  end loop;
  return new;
end
$fn$;

drop trigger if exists employee_manager_cycle on employee;
create trigger employee_manager_cycle
  before insert or update of manager_employee_id on employee
  for each row execute function employee_manager_cycle_guard();

-- ── Policies, rewritten on the one predicate ─────────────────────────────────
-- Same TO clause and shape as 0001; drop-then-create so this file is re-runnable.

drop policy if exists employee_select on employee;
create policy employee_select on employee for select to freshnow_app
  using (app_can_view_employee(id));
-- Profile edits stay own-row or CEO. A manager reads their reports; they do not rewrite them.

drop policy if exists task_select on task;
create policy task_select on task for select to freshnow_app
  using (app_can_view_employee(employee_id));

drop policy if exists task_update_select on task_update;
create policy task_update_select on task_update for select to freshnow_app
  using (app_can_view_employee(employee_id));

drop policy if exists blocker_select on blocker;
create policy blocker_select on blocker for select to freshnow_app
  using (app_can_view_employee(raised_by) or assigned_resolver = app_current_employee());

drop policy if exists assignment_select on assignment;
create policy assignment_select on assignment for select to freshnow_app
  using (app_can_view_employee(assigned_to) or assigned_by = app_current_employee());

drop policy if exists daily_report_read on daily_report;
create policy daily_report_read on daily_report for select to freshnow_app
  using (app_can_view_employee(employee_id));

drop policy if exists attachment_read on attachment;
create policy attachment_read on attachment for select to freshnow_app
  using (
    app_can_view_employee(uploaded_by)
    or task_id in (select id from task where app_can_view_employee(employee_id))
    or assignment_id in (select id from assignment where app_can_view_employee(assigned_to))
  );
