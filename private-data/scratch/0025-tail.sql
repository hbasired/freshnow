on conflict do nothing;

-- ── 3. The checks the policies use ────────────────────────────────────────────
-- SECURITY DEFINER with a pinned search_path, like app_can_view_employee (0009): the function
-- reads role_capability whatever the caller's grants, and a caller cannot redirect the table.
create or replace function app_has_capability(cap text) returns boolean
  language sql stable security definer
  set search_path = public
  as $fn$
    select exists (
      select 1 from role_capability
      where role = case when app_is_ceo() then 'ceo' else app_access_role() end
        and capability = cap)
$fn$;
revoke all on function app_has_capability(text) from public;
grant execute on function app_has_capability(text) to freshnow_app;

create or replace function app_reads_all() returns boolean
  language sql stable security definer
  set search_path = public
  as $fn$
    select app_has_capability('data.read_all')
$fn$;
revoke all on function app_reads_all() from public;
grant execute on function app_reads_all() to freshnow_app;

-- ── 4. Who sees whom ─────────────────────────────────────────────────────────
-- Same shape as 0009; the role names are now capabilities, so Ops Head and Supervisor see their
-- direct reports like a manager, and Admin sees everyone.
create or replace function app_can_view_employee(target uuid) returns boolean
  language sql stable security definer
  set search_path = public
  as $fn$
    select target is not null and (
         app_reads_all()
      or target = app_current_employee()
      -- Roles that lead people see their direct reports.
      or (app_has_capability('people.view_reports')
          and exists (select 1 from employee e
                       where e.id = target and e.manager_employee_id = app_current_employee()))
      -- A department lead also sees everyone in their department.
      or (app_has_capability('people.view_department')
          and app_department() is not null
          and exists (select 1 from employee e
                       where e.id = target
                         -- Departments are typed by people; "Production" and "production" are one.
                         and lower(trim(e.department)) = lower(trim(app_department()))))
    )
$fn$;

create or replace function app_can_view_project(target uuid) returns boolean
  language sql stable security definer
  set search_path = public
  as $fn$
    select app_reads_all()
        or exists (select 1 from project_member m
                   where m.project_id = target and m.employee_id = app_current_employee())
        or exists (select 1 from project p
                   where p.id = target
                     and (app_can_view_employee(p.lead_employee_id)
                       or app_can_view_employee(p.sponsor_employee_id)))
$fn$;

-- ── 5. The read policies that named the CEO ──────────────────────────────────
alter policy alert_select on alert using ((select app_reads_all()) or app_can_view_employee(employee_id));
alter policy audit_select on audit_log using ((select app_reads_all()));
alter policy consent_select on consent_record using (employee_id = app_current_employee() or (select app_reads_all()));
alter policy email_message_select on email_message using ((select app_reads_all()) or app_can_view_employee(employee_id));
alter policy email_proposal_select on email_proposal using ((select app_reads_all()) or proposed_by = app_current_employee());
alter policy escalation_ceo on escalation using ((select app_reads_all()));
alter policy invite_ceo on invite_code using ((select app_reads_all()));
alter policy job_run_ceo on job_run using ((select app_reads_all()));
alter policy llm_call_ceo on llm_call using ((select app_reads_all()));
alter policy outbox_ceo on notification_outbox using ((select app_reads_all()));
alter policy notification_pref_select on notification_pref using (employee_id = app_current_employee() or (select app_reads_all()));
alter policy run_trace_ceo on run_trace using ((select app_reads_all()));
alter policy voice_select on voice_asset using (employee_id = app_current_employee() or (select app_reads_all()));

-- The machines and their Televend data (0023): the CEO, Admin, Ops Head and Supervisor.
alter policy machine_select on machine using ((select app_has_capability('televend.read')));
alter policy machine_placement_select on machine_placement using ((select app_has_capability('televend.read')));
alter policy tv_machine_select on tv_machine using ((select app_has_capability('televend.read')));
alter policy tv_machine_caption_select on tv_machine_caption using ((select app_has_capability('televend.read')));
alter policy tv_vend_select on tv_vend using ((select app_has_capability('televend.read')));
alter policy tv_event_select on tv_event using ((select app_has_capability('televend.read')));
alter policy tv_refill_select on tv_refill using ((select app_has_capability('televend.read')));
alter policy tv_sync_run_select on tv_sync_run using ((select app_has_capability('televend.read')));
alter policy tv_sync_cursor_select on tv_sync_cursor using ((select app_has_capability('televend.read')));

-- Left as they were, on purpose: the INSERT policies on blocker, consent_record, task_update and
-- voice_asset, and the UPDATE policy on employee, still say app_is_ceo(). They are writes through
-- the app role as the CEO; an Admin's writes go through core on the service role with a capability
-- check in the handler (D70), and Admin never acts as the CEO (R30).
