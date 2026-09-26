-- migrations/0013_live_sync.sql — the dashboard stops guessing when to look again.
--
-- Today every open board polls every 20 seconds: a change made in Telegram can sit invisible
-- for twenty seconds, and a board left open on a wall runs the same eight queries all day
-- whether or not anything happened. This replaces the guess with a fact — Postgres says when
-- something changed — while keeping the poll as the fallback for when the stream drops.
--
-- ── THE ONE SECURITY DECISION IN THIS FILE ───────────────────────────────────
--
-- The NOTIFY payload carries NO ROW CONTENT. It is the table name and the operation, and
-- nothing else. Not an id, not an employee, not a project.
--
-- The reason is that `LISTEN` is a connection-level thing with no row security of its own:
-- whatever is put in a payload is visible to every listener, and the API holds ONE listening
-- connection shared by every signed-in viewer. Any identifier in the payload would therefore
-- be a channel that walks straight past RLS — an employee could learn that a blocker was
-- raised about a colleague simply by watching the stream.
--
-- So the event says only "something in `task` changed". Every client then re-fetches through
-- the ordinary RLS-scoped endpoints, and Postgres decides what each person may actually see.
-- The stream is a doorbell, never a delivery.
--
-- The cost of that choice, stated plainly: every connected client re-fetches on every change
-- to a watched table, even one it cannot see. At FreshNow's size (tens of employees, a few
-- changes a minute) that is cheaper than the polling it replaces. At hundreds of concurrent
-- viewers it would not be, and the fix then is per-viewer server-side filtering in the API —
-- NOT a richer payload.

-- Statement-level, not row-level: one notification per statement however many rows it
-- touched. A bulk update that changes 200 tasks should ring the doorbell once, not 200 times,
-- and since the payload carries no row content there is nothing per-row to say anyway.
create or replace function notify_change() returns trigger
  language plpgsql as $fn$
begin
  perform pg_notify('freshnow_change', json_build_object(
    'table', tg_table_name,
    'op', lower(tg_op),
    -- Milliseconds, so a client can discard an event older than its last refresh.
    'at', (extract(epoch from clock_timestamp()) * 1000)::bigint
  )::text);
  return null;
end;
$fn$;

-- The tables a dashboard actually renders. Deliberately NOT here:
--   audit_log, run_trace, llm_call — append-only telemetry nobody watches live, and the
--     highest-volume writes in the system; notifying on them would be most of the traffic
--     for none of the value.
--   invite, consent_record — read on demand, never on a board.
--   the alerting policy tables — configuration, changed by hand, not during a shift.
do $$
declare t text;
begin
  foreach t in array array[
    'task', 'task_update', 'task_step', 'progress_event', 'blocker', 'escalation',
    'assignment', 'daily_report', 'attachment', 'notification_outbox', 'alert',
    'employee', 'task_watcher',
    'project', 'milestone', 'project_requirement', 'project_member',
    'project_update', 'project_issue'
  ]
  loop
    if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'public' and c.relname = t and c.relkind = 'r') then
      execute format('drop trigger if exists %I on %I', 'notify_' || t, t);
      execute format(
        'create trigger %I after insert or update or delete on %I
           for each statement execute function notify_change()',
        'notify_' || t, t);
    end if;
  end loop;
end $$;
