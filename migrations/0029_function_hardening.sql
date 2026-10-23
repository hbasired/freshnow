-- migrations/0029_function_hardening.sql — two findings of the TASK-058 security review (D211).
--
-- 1. notify_change() (0027) runs SQL handed to it by its trigger definitions, with its owner's rights.
--    0027 revoked EXECUTE from PUBLIC so that no other role could attach it to a trigger of its own —
--    but on Supabase, a function postgres creates in public is also granted to service_role by default
--    privileges, and revoking from PUBLIC does not touch a grant made to a named role. So: revoke it
--    from every named role that could hold it, and stop future functions being granted to service_role
--    by default (FreshNow never calls a function as service_role: the API uses postgres and the app role).
--
-- 2. A SECURITY DEFINER function whose search_path omits pg_temp searches the CALLER's temporary schema
--    FIRST for tables, so a session allowed to create temp tables could put its own "employee" or "task"
--    in front of the real one inside a function running with the owner's rights. PostgreSQL's advice
--    ("Writing SECURITY DEFINER Functions Safely") is to list pg_temp last. Every SECURITY DEFINER function
--    in public gets that; and the live-sync triggers whose scope joins other tables name them with schema.
--
-- Triggers keep firing for every role either way: EXECUTE on a trigger function is checked when a
-- trigger is created, never when it fires (verified, G182).
--
-- 3. (Same review, data lens.) A change to who may see whom that arrives collapsed to "*" — more than
--    100 subjects, or a scope that could not be worked out — lost its "org" key, so the API's cached
--    pictures of who sees what stayed as they were. "*" now keeps "org" when it was there, and a scope
--    that failed says "org" too: reloading a picture needlessly costs a query, missing one leaves a
--    board stale.

create or replace function notify_change() returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, public, pg_temp
as $fn$
declare
  changed_sql text;
  touched bigint;
  topics text[];
begin
  -- `changed` is every row the statement touched: before-images and after-images for an update,
  -- so moving a task from one person to another tells the viewers of both.
  changed_sql := case tg_op
    when 'INSERT' then 'select * from new_rows'
    when 'DELETE' then 'select * from old_rows'
    else 'select * from old_rows union all select * from new_rows'
  end;
  begin
    execute format(
      'with changed as (%s)
       select (select count(*) from changed),
              (select coalesce(array_agg(distinct t order by t), ''{}'') from (%s) s (t) where t is not null)',
      changed_sql, tg_argv[0])
      into touched, topics;
  exception when others then
    raise warning 'live sync: the scope of a change to % could not be worked out (%) - every viewer is told',
      tg_table_name, sqlerrm;
    touched := 1;
    topics := array['*', 'org'];
  end;

  if touched = 0 then
    return null; -- the statement changed nothing; nobody needs to look again
  end if;
  if cardinality(topics) > 100 then
    topics := case when 'org' = any(topics) then array['*', 'org'] else array['*'] end;
  end if;

  perform pg_notify('freshnow_change', json_build_object(
    'table', tg_table_name,
    'op', lower(tg_op),
    'at', (extract(epoch from clock_timestamp()) * 1000)::bigint,
    'scope', topics
  )::text);
  return null;
end;
$fn$;

do $$
declare
  r record;
begin
  perform set_config('client_min_messages', 'warning', true);

  -- 1 ── Only the owner may execute notify_change().
  for r in select rolname from pg_roles
            where rolname in ('service_role', 'anon', 'authenticated', 'freshnow_app', 'freshnow_query', 'authenticator') loop
    execute format('revoke all on function public.notify_change() from %I', r.rolname);
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'alter default privileges for role postgres in schema public revoke execute on functions from service_role';
  end if;

  -- 2 ── pg_temp last, for every SECURITY DEFINER function in public.
  for r in select p.oid::regprocedure as sig
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.prosecdef
              and p.proowner = (select oid from pg_roles where rolname = current_user) loop
    execute format('alter function %s set search_path = pg_catalog, public, pg_temp', r.sig);
  end loop;

  -- … and the scope SQL that joins other tables says which schema it means.
  for r in select * from (values
      ('task_step',      $s$select 'e:' || t.employee_id from changed c join public.task t on t.id = c.task_id$s$),
      ('progress_event', $s$select 'e:' || t.employee_id from changed c join public.task t on t.id = c.task_id$s$),
      ('attachment',     $s$select 'e:' || uploaded_by from changed
                            union select 'e:' || t.employee_id from changed c join public.task t on t.id = c.task_id
                            union select 'e:' || a.assigned_to from changed c join public.assignment a on a.id = c.assignment_id$s$),
      ('task_watcher',   $s$select 's:' || employee_id from changed
                            union select 'e:' || t.employee_id from changed c join public.task t on t.id = c.task_id$s$)
    ) v (tbl, scope)
  loop
    execute format('drop trigger if exists %I on public.%I', 'notify_' || r.tbl || '_ins', r.tbl);
    execute format('drop trigger if exists %I on public.%I', 'notify_' || r.tbl || '_upd', r.tbl);
    execute format('drop trigger if exists %I on public.%I', 'notify_' || r.tbl || '_del', r.tbl);
    execute format(
      'create trigger %I after insert on public.%I referencing new table as new_rows
         for each statement execute function public.notify_change(%L)',
      'notify_' || r.tbl || '_ins', r.tbl, r.scope);
    execute format(
      'create trigger %I after update on public.%I referencing old table as old_rows new table as new_rows
         for each statement execute function public.notify_change(%L)',
      'notify_' || r.tbl || '_upd', r.tbl, r.scope);
    execute format(
      'create trigger %I after delete on public.%I referencing old table as old_rows
         for each statement execute function public.notify_change(%L)',
      'notify_' || r.tbl || '_del', r.tbl, r.scope);
  end loop;
end $$;
