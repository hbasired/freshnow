-- migrations/0027_live_scope.sql — live updates reach the people a change concerns (TASK-058).
--
-- Until now (0013) every change rang every open board's doorbell: one listening connection, one
-- payload of {table, op, at}, fanned out to every viewer, each of whom then re-fetched. 0013 named
-- the fix for when there are many viewers: filter per viewer in the API — NOT a richer payload for
-- the client. This is that fix (D206, amending D92).
--
-- ── WHAT CHANGES, AND WHAT DOES NOT ──────────────────────────────────────────
--
-- The notification gains a `scope`: the subjects a change concerns, as short keys —
--
--   e:<employee id>  rows whose visibility is app_can_view_employee(that id)
--   s:<employee id>  rows only that person (and whoever reads everything) may see
--   p:<project id>   rows whose visibility is app_can_view_project(that id)
--   org              a change to who may see whom — manager, department, role or status of a person;
--                    lead, sponsor or membership of a project. Every viewer is told, and the API
--                    reloads what each viewer may see.
--   *                the scope could not be worked out: every viewer is told (0013's behaviour)
--
-- An empty scope means "only those who read everything" (escalations, for example).
--
-- What reaches a browser does NOT change: the API reads the scope, decides per connection, and
-- forwards {table, op, at} only. The scope never travels further (changes.ts keeps it out of the
-- event object itself, and the tests assert the three keys on the wire).
--
-- Who can read the scope here? Only a session that LISTENs on this database — one that holds
-- database credentials and can therefore read the tables themselves. The question box cannot: its
-- SQL must be a single SELECT and may not call any pg_* function (query/guard.ts, tested).
--
-- Rules that make this safe to depend on:
--   * A doorbell never blocks the write that rang it: if the scope cannot be worked out, a warning
--     is logged and every viewer is told.
--   * A statement that changed no rows rings no bell.
--   * A NOTIFY payload is capped at 8000 bytes: past 100 subjects, every viewer is told instead.
--   * The subjects are found with the function owner's rights (security definer), so a writer who
--     cannot see a task under row security still rings the bells of those who can. Because the
--     function runs SQL handed to it by the trigger definition, nobody but its owner may execute
--     it: Postgres checks EXECUTE when a trigger is created, so no other role can attach it.
--
-- Postgres refuses transition tables on a trigger with more than one event, so each watched table
-- gets three triggers (insert, update, delete) where 0013 had one.

create or replace function notify_change() returns trigger
  language plpgsql
  security definer
  set search_path = public
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
    topics := array['*'];
  end;

  if touched = 0 then
    return null; -- the statement changed nothing; nobody needs to look again
  end if;
  if cardinality(topics) > 100 then
    topics := array['*'];
  end if;

  perform pg_notify('freshnow_change', json_build_object(
    'table', tg_table_name,
    'op', lower(tg_op),
    -- Milliseconds, so a client can discard an event older than its last refresh.
    'at', (extract(epoch from clock_timestamp()) * 1000)::bigint,
    'scope', topics
  )::text);
  return null;
end;
$fn$;

revoke all on function notify_change() from public;

-- The same tables as 0013, each with the subjects its read policy turns on. Keep this list and the
-- policies in step: a policy that starts depending on a new column needs its key here too
-- (live-scope.test.ts writes to every table and checks the keys).
do $$
declare
  w record;
begin
  -- "trigger … does not exist, skipping" × 57 is noise, not news; warnings still show.
  perform set_config('client_min_messages', 'warning', true);
  for w in
    select * from (values
      ('task',                $s$select 'e:' || employee_id from changed$s$, null),
      ('task_update',         $s$select 'e:' || employee_id from changed$s$, null),
      ('task_step',           $s$select 'e:' || t.employee_id from changed c join task t on t.id = c.task_id$s$, null),
      ('progress_event',      $s$select 'e:' || t.employee_id from changed c join task t on t.id = c.task_id$s$, null),
      ('blocker',             $s$select 'e:' || raised_by from changed
                                 union select 's:' || assigned_resolver from changed$s$, null),
      ('escalation',          $s$select null::text$s$, null),
      ('assignment',          $s$select 'e:' || assigned_to from changed
                                 union select 's:' || assigned_by from changed$s$, null),
      ('daily_report',        $s$select 'e:' || employee_id from changed$s$, null),
      ('attachment',          $s$select 'e:' || uploaded_by from changed
                                 union select 'e:' || t.employee_id from changed c join task t on t.id = c.task_id
                                 union select 'e:' || a.assigned_to from changed c join assignment a on a.id = c.assignment_id$s$, null),
      ('notification_outbox', $s$select 's:' || recipient_employee_id from changed$s$, null),
      ('alert',               $s$select 'e:' || employee_id from changed$s$, null),
      ('task_watcher',        $s$select 's:' || employee_id from changed
                                 union select 'e:' || t.employee_id from changed c join task t on t.id = c.task_id$s$, null),
      -- A person joining or leaving changes who sees them. A change to their manager, department,
      -- role or status changes what someone else may see; any other change concerns that person.
      ('employee',            $s$select 'org'::text$s$,
                              $s$select 'e:' || id from new_rows
                                 union select 'org'::text from new_rows n join old_rows o on o.id = n.id
                                  where (n.manager_employee_id, n.department, n.access_role, n.status)
                                        is distinct from (o.manager_employee_id, o.department, o.access_role, o.status)$s$),
      ('project',             $s$select 'org'::text$s$,
                              $s$select 'p:' || id from new_rows
                                 union select 'org'::text from new_rows n join old_rows o on o.id = n.id
                                  where (n.lead_employee_id, n.sponsor_employee_id)
                                        is distinct from (o.lead_employee_id, o.sponsor_employee_id)$s$),
      ('project_member',      $s$select 'org'::text$s$, null),
      ('milestone',           $s$select 'p:' || project_id from changed$s$, null),
      ('project_requirement', $s$select 'p:' || project_id from changed$s$, null),
      ('project_update',      $s$select 'p:' || project_id from changed$s$, null),
      ('project_issue',       $s$select 'p:' || project_id from changed$s$, null)
    ) v (tbl, scope, update_scope)
  loop
    execute format('drop trigger if exists %I on %I', 'notify_' || w.tbl, w.tbl);
    execute format('drop trigger if exists %I on %I', 'notify_' || w.tbl || '_ins', w.tbl);
    execute format('drop trigger if exists %I on %I', 'notify_' || w.tbl || '_upd', w.tbl);
    execute format('drop trigger if exists %I on %I', 'notify_' || w.tbl || '_del', w.tbl);
    execute format(
      'create trigger %I after insert on %I referencing new table as new_rows
         for each statement execute function notify_change(%L)',
      'notify_' || w.tbl || '_ins', w.tbl, w.scope);
    execute format(
      'create trigger %I after update on %I referencing old table as old_rows new table as new_rows
         for each statement execute function notify_change(%L)',
      'notify_' || w.tbl || '_upd', w.tbl, coalesce(w.update_scope, w.scope));
    execute format(
      'create trigger %I after delete on %I referencing old table as old_rows
         for each statement execute function notify_change(%L)',
      'notify_' || w.tbl || '_del', w.tbl, w.scope);
  end loop;
end $$;
