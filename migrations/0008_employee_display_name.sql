-- migrations/0008_employee_display_name.sql — let a query name a colleague without
-- reading their row.
--
-- The employee SELECT policy is "your own row, or everything if you are the CEO". That is
-- right for the row: department, site, shift, Telegram id and consent state are not for
-- colleagues to browse. But a query that joins employee to put a NAME on something the
-- viewer IS allowed to see — who assigned this work, who raised this blocker — silently
-- drops the row for an employee, because the inner join finds nothing. The first real
-- browser sign-in showed it: six assignments, all Hemanth's, and his dashboard said 0.
--
-- This function is the deliberate, narrow window: any employee may learn any employee's
-- display name by id, and nothing else. Names already reach employees through the bot
-- ("assigned by DEMO CEO" in every end-of-day report), so this widens nothing in practice
-- while keeping the row policy exactly as strict as it was.
--
-- SECURITY DEFINER runs it as the owner (the migration role, which bypasses RLS);
-- `set search_path` pins name resolution so a caller cannot redirect `employee` to a table
-- of their own. STABLE lets the planner call it once per row rather than per reference.

create or replace function employee_display_name(employee_id uuid) returns text
  language sql stable security definer
  set search_path = public
  as $fn$
    select display_name from employee where id = employee_id
$fn$;

-- The app role may call it; nobody else needs to (the service role reads the row).
revoke all on function employee_display_name(uuid) from public;
grant execute on function employee_display_name(uuid) to freshnow_app;
