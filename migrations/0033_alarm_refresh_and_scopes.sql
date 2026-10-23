-- migrations/0033_alarm_refresh_and_scopes.sql — fixes from the independent review of TASK-059 (2026-10-17)
--
-- 1. tv_event.checked_at: when the sync last re-read an open alarm's window to see whether Televend has
--    cleared it (refreshOpenAlarms, review command-centre#1). The incremental read re-reads only the
--    last hour of starts, so an alarm that cleared hours after it started stayed open here for good.
--    Each run re-reads the alarms checked longest ago first; this column is the queue's order.
--
-- 2. A machine's problems ring the doorbell of everyone who runs the machines (review
--    live-updates-media#4). 0031 let every holder of televend.read SEE the problems the system raises,
--    but 0027's live scope still named only the raiser and the resolver, so an Ops Head who was not
--    the resolver saw them only at the next poll. `c:<capability>` = everyone whose role holds it
--    (live-audience.ts).

alter table tv_event add column if not exists checked_at timestamptz;
create index if not exists idx_tv_event_open_alarm on tv_event (started_at)
  where resolved_at is null and kind in ('alarm', 'warning');

do $$
declare
  scope text := $s$select 'e:' || raised_by from changed
                   union select 's:' || assigned_resolver from changed
                   union select 'c:televend.read'::text from changed where raised_by = '00000000-0000-0000-0000-0000000000a1'$s$;
begin
  perform set_config('client_min_messages', 'warning', true);
  drop trigger if exists notify_blocker_ins on blocker;
  drop trigger if exists notify_blocker_upd on blocker;
  drop trigger if exists notify_blocker_del on blocker;
  execute format('create trigger notify_blocker_ins after insert on blocker referencing new table as new_rows
                    for each statement execute function notify_change(%L)', scope);
  execute format('create trigger notify_blocker_upd after update on blocker referencing old table as old_rows new table as new_rows
                    for each statement execute function notify_change(%L)', scope);
  execute format('create trigger notify_blocker_del after delete on blocker referencing old table as old_rows
                    for each statement execute function notify_change(%L)', scope);
end $$;
