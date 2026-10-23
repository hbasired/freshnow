-- 0031 — Machine alarms become problems (TASK-059)
--
-- Televend raises ~70 alarms a day; over half are blips that clear within minutes on their own
-- (measured 4–16 Oct: "Cashless device" 95 % under 5 min, "Communication Interrupted" 90 %,
-- "Inhibited" 84 %), while the ones that matter linger for hours ("No cash sales" median 455 min,
-- "Product level low" 305, "Connection lost" 350, "Bill / Cash Box Full" 181) and nobody owns them —
-- the Assigned column was empty on every exported alarm. An alarm that is still open after its
-- on-delay becomes a blocker raised by the system, and from there the existing pipeline does the
-- rest: routing by category, SLA, the escalation ladder, acknowledgement, the outbox (D206, D217).
--
-- alarm_rule says, per Televend alarm name, whether it is a problem, how long it must stay open
-- before it is one (ISA-18.2's on-delay: a blip that clears itself is never a problem), which
-- category routes it, how severe it is, and what to do — hand-maintained, like routing_rule.
-- machine_alarm links each Televend alarm to the blocker it raised or joined: one blocker per
-- machine and alarm name while it is open, however often Televend repeats the alarm.

-- The system actor: who raises a blocker no person reported. Disabled, so it is never assignable,
-- never asked for consent, never messaged — it only ever appears as "raised by".
insert into employee (id, display_name, status, access_role, is_synthetic)
values ('00000000-0000-0000-0000-0000000000a1', 'Machine alarms (Televend)', 'disabled', 'employee', false)
on conflict (id) do nothing;

create table if not exists alarm_rule (
  -- Televend's alarm name, exactly as it arrives (tv_event.name).
  name             text primary key,
  -- actionable: becomes a problem after its on-delay; noise: only if it outlasts its on-delay too,
  -- but it is shown as noise; info: never a problem (cash collections, refills, door opened …).
  class            text not null check (class in ('actionable', 'noise', 'info')),
  on_delay_minutes integer not null default 0 check (on_delay_minutes between 0 and 1440),
  category         text not null check (length(category) between 1 and 40),
  severity         text not null check (severity in ('low', 'medium', 'high', 'critical')),
  advice           text not null check (length(advice) between 1 and 400),
  updated_at       timestamptz not null default now()
);

insert into alarm_rule (name, class, on_delay_minutes, category, severity, advice) values
  ('Cashless device', 'noise', 30, 'equipment', 'medium',
   'The card reader keeps dropping out. If it has been out for half an hour, restart the reader; if it stays out, call the technician.'),
  ('Vending Machine Communication Interrupted', 'noise', 30, 'equipment', 'medium',
   'The machine stopped talking to Televend for a while. If it lasts, check its power and SIM signal.'),
  ('Vending Machine Inhibited', 'noise', 30, 'equipment', 'high',
   'The machine stopped selling. If it lasts half an hour, someone must go and look.'),
  ('Connection lost', 'actionable', 30, 'equipment', 'high',
   'The machine is offline: no sales are recorded and nobody can see its state. Check power and signal on site.'),
  ('No communication with Cashless 3', 'actionable', 15, 'equipment', 'medium',
   'The machine cannot reach its card reader. Restart the reader; if that fails, call the technician.'),
  ('No cash sales alarm', 'actionable', 0, 'cash', 'medium',
   'No cash sales for hours while the machine is up. Check the banknote acceptor and that the cash box is not full.'),
  ('No cashless 1 sales alarm', 'actionable', 0, 'equipment', 'medium',
   'No card sales for hours. Check the card reader.'),
  ('No cashless 3 sales alarm', 'actionable', 0, 'equipment', 'medium',
   'No card sales for hours. Check the card reader.'),
  ('Product level low', 'actionable', 0, 'stock', 'high',
   'The machine is running out. Plan a refill on the next route.'),
  ('Bill / Cash Box Full', 'actionable', 0, 'cash', 'high',
   'The cash box is full and the machine refuses notes. Collect the cash.'),
  ('Banknote acceptor error', 'actionable', 15, 'equipment', 'medium',
   'The note reader reports a fault. Clear the jam or call the technician.'),
  ('Banknote acceptor', 'actionable', 15, 'equipment', 'medium',
   'The note reader reports a problem. Check it on the next visit, sooner if cash sales stop.'),
  ('Vend on undefined column detected', 'actionable', 60, 'equipment', 'low',
   'A sale came from a column Televend does not know. The planogram in Televend needs fixing.')
on conflict (name) do nothing;

create table if not exists machine_alarm (
  id            uuid primary key default gen_random_uuid(),
  -- The Televend event (tv_event's key).
  event_source  text not null,
  event_id      text not null,
  -- Televend's machine, always; ours when the registry knows it (a machine missing from it still
  -- folds its repeats into one problem, by Televend's id).
  machine_tv_id bigint not null,
  machine_id    uuid references machine (id),
  alarm_name    text not null,
  started_at    timestamptz not null,
  -- The blocker it raised or joined; null while it waits out its on-delay.
  blocker_id    uuid references blocker (id),
  linked_at     timestamptz not null default now(),
  -- When Televend resolved it (copied from tv_event.resolved_at by the sync).
  cleared_at    timestamptz,
  is_synthetic  boolean not null default false,
  correlation_id uuid,
  unique (event_source, event_id)
);
create index if not exists idx_machine_alarm_blocker on machine_alarm (blocker_id);
create index if not exists idx_machine_alarm_machine on machine_alarm (machine_tv_id, alarm_name) where cleared_at is null;

-- A cash vend's price per machine, in fils; null = the configured default (A-T62.1: AED 10, measured
-- to fit 18 of 29 reported collections — the machine names' "AED 12" is not the cash price).
alter table machine add column if not exists cash_price_fils integer check (cash_price_fils is null or cash_price_fils between 100 and 100000);

-- Row security: what the operations roles read (televend.read), like the Televend tables. Writes are
-- the worker's, on the service role (D70).
alter table alarm_rule enable row level security;
alter table alarm_rule force row level security;
drop policy if exists alarm_rule_select on alarm_rule;
create policy alarm_rule_select on alarm_rule for select to freshnow_app using ((select app_has_capability('televend.read')));
grant select on alarm_rule to freshnow_app;

alter table machine_alarm enable row level security;
alter table machine_alarm force row level security;
drop policy if exists machine_alarm_select on machine_alarm;
create policy machine_alarm_select on machine_alarm for select to freshnow_app using ((select app_has_capability('televend.read')));
grant select on machine_alarm to freshnow_app;

-- The problems the machines raise are seen by everyone who runs the machines — not only by those who
-- may see the system actor (read-all) or whom it was routed to.
drop policy if exists blocker_select on blocker;
create policy blocker_select on blocker for select to freshnow_app
  using (app_can_view_employee(raised_by)
         or assigned_resolver = app_current_employee()
         or (raised_by = '00000000-0000-0000-0000-0000000000a1' and (select app_has_capability('televend.read'))));
