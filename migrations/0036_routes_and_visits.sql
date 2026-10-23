-- migrations/0036_routes_and_visits.sql — each team's route, and every visit with its proof (TASK-061, part 2)
--
-- Today the route is a spreadsheet posted to the "Freshnow Service Team" WhatsApp group: a block per team and
-- shift ("Team KIRAN/ANANTU - NIGHT SHIFT"), a row per machine with its instructions ("Dubai Marina Full and cash dp
-- and water remove"), and columns NORMAL PIC / RESORTING PIC / VIDEO OF WHITE FRUIT DISPENSER / OTHER that someone
-- fills with OK — or a red NO — after looking through the photos in the group (13 Oct). This is that sheet, with
-- the proof attached to the visit it proves instead of being matched by eye.
--
--   route_plan          one team's plan for one shift: a name ("Team Kiran / Ananthu"), the day, day or night
--   route_plan_member   who is on the team that day (teams change day to day, so a team is not a fixed record)
--   route_stop          a machine on the plan, what to do there (the sheet's words) and the proof wanted
--   visit               someone at a machine: started by the machine's sticker link or its typed number, ended
--   visit_evidence      a photo or video added to a visit as one kind of proof
--   visit_doc           the stock put into the machine and the cash taken out, on their own ledgers (0032, 0035)
--
-- A visit records which machine and when — nothing about where anyone is between visits (no location).
--
-- ── WHO ───────────────────────────────────────────────────────────────────
--   routes.plan     makes the plans; sees every team's visits and proof      Supervisor, Ops Head, CEO, Admin
--   visits.record   records their own visits                                 VMO / driver, Technician, Supervisor, Ops Head, CEO, Admin
-- A driver sees the plans they are on and their own visits. Writes go through core on the service role.

-- ── 1. Who may do what (the SQL copy of permissions.ts) ──────────────────────
insert into role_capability (role, capability) values
  ('ceo', 'routes.plan'), ('ceo', 'visits.record'),
  ('admin', 'routes.plan'), ('admin', 'visits.record'),
  ('ops_head', 'routes.plan'), ('ops_head', 'visits.record'),
  ('supervisor', 'routes.plan'), ('supervisor', 'visits.record'),
  ('technician', 'visits.record'),
  ('vmo', 'visits.record')
on conflict do nothing;

-- ── 2. A machine's own service rule ──────────────────────────────────────────
-- "Schedule rashid always Night" (the service group, 15 Oct: the hospital does not allow the service trolley in
-- the day). A planner sets it; putting the machine on a plan of the other shift is warned about, not refused.
alter table machine add column if not exists service_shift text check (service_shift is null or service_shift in ('day', 'night'));
alter table machine add column if not exists service_note text check (service_note is null or length(service_note) <= 300);

-- ── 2b. Plans ────────────────────────────────────────────────────────────────
create table if not exists route_plan (
  -- Made by the planner's browser: the same plan saved twice is one plan.
  id             uuid primary key,
  business_date  date not null,
  shift_window   text not null check (shift_window in ('day', 'night')),
  name           text not null check (length(btrim(name)) between 1 and 80),
  note           text check (note is null or length(note) <= 500),
  state          text not null default 'active' check (state in ('active', 'cancelled')),
  copied_from    uuid references route_plan (id),
  created_by     uuid not null references employee (id),
  created_at     timestamptz not null default now(),
  updated_by     uuid not null references employee (id),
  updated_at     timestamptz not null default now(),
  is_synthetic   boolean not null default false,
  correlation_id uuid
);
create index if not exists idx_route_plan_date on route_plan (business_date desc, shift_window);

create table if not exists route_plan_member (
  plan_id     uuid not null references route_plan (id),
  employee_id uuid not null references employee (id),
  primary key (plan_id, employee_id)
);
create index if not exists idx_route_plan_member_person on route_plan_member (employee_id);

create table if not exists route_stop (
  id           uuid primary key default gen_random_uuid(),
  plan_id      uuid not null references route_plan (id),
  seq          integer not null check (seq between 1 and 500),
  machine_id   uuid not null references machine (id),
  -- The sheet's words (18 Oct): full service, half service, resort, cash, water remove, kachara remove, clean
  -- with hot water, deep clean, make free vend, a check (the sheet's 🚨: cup failure, orange stuck, connection…).
  tasks        text[] not null default '{}'
                 check (tasks <@ array['full_service', 'half_service', 'resort', 'cash', 'water_remove', 'garbage_remove',
                                       'hot_water_clean', 'deep_clean', 'free_vend', 'check', 'other']::text[]),
  -- Crates of oranges to load here — the sheet's "(2 crates)"; their sum is what the team takes from the warehouse.
  crates       integer check (crates is null or crates between 0 and 20),
  instructions text check (instructions is null or length(instructions) <= 300),
  -- The sheet's columns: normal pic, re-sorting pic, video of the white fruit dispenser, other.
  evidence     text[] not null default '{}'
                 check (evidence <@ array['normal_photo', 'resorting_photo', 'dispenser_video', 'other_photo']::text[]),
  -- Taken off the plan: kept, because a visit may already point at it.
  removed_at   timestamptz,
  is_synthetic boolean not null default false
);
create index if not exists idx_route_stop_plan on route_stop (plan_id, seq);
create index if not exists idx_route_stop_machine on route_stop (machine_id);

-- ── 3. Visits ────────────────────────────────────────────────────────────────
create table if not exists visit (
  -- Made by the phone or browser: a "start" tapped twice opens one visit.
  id             uuid primary key,
  machine_id     uuid not null references machine (id),
  employee_id    uuid not null references employee (id),
  -- The plan's stop this visit carries out, when the machine is on one of the person's plans.
  stop_id        uuid references route_stop (id),
  started_at     timestamptz not null default now(),
  -- How the machine was named: its sticker's link (the phone's camera read the code) or its number typed in.
  started_how    text not null check (started_how in ('qr', 'typed')),
  ended_at       timestamptz,
  tasks_done     text[] not null default '{}'
                   check (tasks_done <@ array['full_service', 'half_service', 'resort', 'cash', 'water_remove', 'garbage_remove',
                                              'hot_water_clean', 'deep_clean', 'free_vend', 'check', 'other']::text[]),
  note           text check (note is null or length(note) <= 500),
  device_at      timestamptz,
  request_hash   text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  is_synthetic   boolean not null default false,
  correlation_id uuid,
  check (ended_at is null or ended_at >= started_at)
);
-- One visit at a time per person.
create unique index if not exists uq_visit_open on visit (employee_id) where ended_at is null;
create index if not exists idx_visit_person on visit (employee_id, started_at desc);
create index if not exists idx_visit_machine on visit (machine_id, started_at desc);
create index if not exists idx_visit_stop on visit (stop_id) where stop_id is not null;

create table if not exists visit_evidence (
  id           uuid primary key default gen_random_uuid(),
  visit_id     uuid not null references visit (id),
  kind         text not null check (kind in ('normal_photo', 'resorting_photo', 'dispenser_video', 'other_photo')),
  -- Null once the file itself has gone under the photo rules (0026's retention sweep): the record that this
  -- proof was given, and when, stays.
  media_id     uuid references media_object (id) on delete set null,
  added_by     uuid not null references employee (id),
  added_at     timestamptz not null default now(),
  -- Taken off by mistake while the visit was open; the file follows the photo rules.
  removed_at   timestamptz,
  is_synthetic boolean not null default false,
  unique (visit_id, media_id)
);
create index if not exists idx_visit_evidence_visit on visit_evidence (visit_id);

create table if not exists visit_doc (
  visit_id     uuid not null references visit (id),
  stock_doc_id uuid unique references stock_doc (id),
  cash_doc_id  uuid unique references cash_doc (id),
  linked_at    timestamptz not null default now(),
  check ((stock_doc_id is null) <> (cash_doc_id is null))
);
create index if not exists idx_visit_doc_visit on visit_doc (visit_id);

-- ── 4. Nothing about a visit changes once it has ended ───────────────────────
create or replace function visit_guard() returns trigger
  language plpgsql
  set search_path = public
as $fn$
begin
  if tg_op = 'DELETE' then
    if not inv_purging() then
      raise exception 'visits are never deleted' using errcode = 'P0001';
    end if;
    return old;
  end if;
  if (new.id, new.machine_id, new.employee_id, new.started_at, new.started_how, new.device_at, new.request_hash, new.is_synthetic,
      new.correlation_id)
     is distinct from
     (old.id, old.machine_id, old.employee_id, old.started_at, old.started_how, old.device_at, old.request_hash, old.is_synthetic,
      old.correlation_id) then
    raise exception 'who visited which machine, and when, is never changed' using errcode = 'P0001';
  end if;
  if old.ended_at is not null then
    if new.ended_at is distinct from old.ended_at or new.tasks_done is distinct from old.tasks_done or new.stop_id is distinct from old.stop_id then
      raise exception 'a visit that has ended is not changed' using errcode = 'P0001';
    end if;
    if new.note is distinct from old.note and not inv_is_redaction(new.note) then
      raise exception 'the words on an ended visit are only ever removed, never rewritten' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$fn$;

create or replace function visit_evidence_guard() returns trigger
  language plpgsql
  set search_path = public
as $fn$
begin
  if tg_op = 'DELETE' then
    if not inv_purging() then
      raise exception 'proof is never deleted: take it off the visit instead' using errcode = 'P0001';
    end if;
    return old;
  end if;
  if (new.id, new.visit_id, new.kind, new.added_by, new.added_at, new.is_synthetic)
     is distinct from (old.id, old.visit_id, old.kind, old.added_by, old.added_at, old.is_synthetic)
     -- The file may only go (its retention ran out), never be swapped for another.
     or (new.media_id is distinct from old.media_id and new.media_id is not null)
     or (old.removed_at is not null and new.removed_at is distinct from old.removed_at) then
    raise exception 'proof added to a visit is never changed — only taken off, once' using errcode = 'P0001';
  end if;
  return new;
end;
$fn$;

create or replace function visit_doc_guard() returns trigger
  language plpgsql
  set search_path = public
as $fn$
begin
  if not inv_purging() then
    raise exception 'what a visit put in or took out stays linked to it' using errcode = 'P0001';
  end if;
  return coalesce(old, new);
end;
$fn$;

-- Practice runs only (scripts/reset-employee.ts, the tests): these visits with their proof and their links. The
-- stock and cash they moved are purged on their own ledgers (inv_purge_docs, cash_purge_shifts).
create or replace function visit_purge(p_visits uuid[]) returns integer
  language plpgsql
  set search_path = public
as $fn$
declare
  n integer;
begin
  perform set_config('freshnow.ledger_purge', 'on', true);
  delete from media_link where entity_type = 'visit' and entity_id = any(p_visits);
  delete from visit_doc where visit_id = any(p_visits);
  delete from visit_evidence where visit_id = any(p_visits);
  delete from visit where id = any(p_visits);
  get diagnostics n = row_count;
  perform set_config('freshnow.ledger_purge', 'off', true);
  return n;
end;
$fn$;
revoke all on function visit_purge(uuid[]) from public;

drop trigger if exists visit_guard on visit;
create trigger visit_guard before update or delete on visit for each row execute function visit_guard();
drop trigger if exists visit_evidence_guard on visit_evidence;
create trigger visit_evidence_guard before update or delete on visit_evidence for each row execute function visit_evidence_guard();
drop trigger if exists visit_doc_guard on visit_doc;
create trigger visit_doc_guard before update or delete on visit_doc for each row execute function visit_doc_guard();

-- ── 5. Photos and videos: proof on a visit is seen by whoever plans the routes ──
-- Linked like every other attachment (the retention clock runs from the last link, 0026/media.ts).
alter table media_link drop constraint if exists media_link_entity_type_check;
alter table media_link add constraint media_link_entity_type_check check (entity_type in ('task', 'stock_doc', 'cash_doc', 'visit'));

-- 0026 shows a file only to those who may see its sender; 0035 added whoever sees all cash for a photo on a
-- cash entry. A file on a visit is also seen by everyone with routes.plan — the supervisor checking the proof
-- is not the driver's manager.
create or replace function app_media_on_visit(p_media uuid) returns boolean
  language sql stable security definer
  set search_path = pg_catalog, public, pg_temp
as $fn$
  select app_has_capability('routes.plan')
     and exists (select 1 from visit_evidence e where e.media_id = p_media)
$fn$;
revoke all on function app_media_on_visit(uuid) from public;
grant execute on function app_media_on_visit(uuid) to freshnow_app;
alter policy media_object_select on media_object
  using ((select app_reads_all()) or app_can_view_employee(uploaded_by) or app_media_on_cash_doc(id) or app_media_on_visit(id));

-- ── 6. Row security: read only, and only what the role allows ────────────────
do $$
declare
  t text;
begin
  foreach t in array array['route_plan', 'route_plan_member', 'route_stop', 'visit', 'visit_evidence', 'visit_doc']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists %I on %I', t || '_select', t);
    execute format('revoke insert, update, delete, truncate on %I from freshnow_app', t);
    execute format('grant select on %I to freshnow_app', t);
  end loop;
end $$;

-- Membership is read without row security (a function), so the plan's policy and the member table's do not
-- read each other in a circle.
create or replace function app_on_plan(p_plan uuid) returns boolean
  language sql stable security definer
  set search_path = pg_catalog, public, pg_temp
as $fn$
  select exists (select 1 from route_plan_member m where m.plan_id = p_plan and m.employee_id = app_current_employee())
$fn$;
revoke all on function app_on_plan(uuid) from public;
grant execute on function app_on_plan(uuid) to freshnow_app;

create policy route_plan_select on route_plan for select to freshnow_app
  using ((select app_has_capability('routes.plan')) or app_on_plan(id));
create policy route_plan_member_select on route_plan_member for select to freshnow_app
  using ((select app_has_capability('routes.plan')) or app_on_plan(plan_id));
create policy route_stop_select on route_stop for select to freshnow_app
  using ((select app_has_capability('routes.plan')) or app_on_plan(plan_id));
create policy visit_select on visit for select to freshnow_app
  using ((select app_has_capability('routes.plan')) or employee_id = app_current_employee());
create policy visit_evidence_select on visit_evidence for select to freshnow_app
  using (exists (select 1 from visit v where v.id = visit_id));
create policy visit_doc_select on visit_doc for select to freshnow_app
  using (exists (select 1 from visit v where v.id = visit_id));

-- ── 7. Live updates: whoever plans, the team on the plan, the person visiting (0027) ──
do $$
declare
  w record;
begin
  perform set_config('client_min_messages', 'warning', true);
  for w in
    select * from (values
      ('route_plan', $s$select 'c:routes.plan'::text from changed
                        union select 's:' || m.employee_id from changed c join route_plan_member m on m.plan_id = c.id$s$),
      ('route_stop', $s$select 'c:routes.plan'::text from changed
                        union select 's:' || m.employee_id from changed c join route_plan_member m on m.plan_id = c.plan_id$s$),
      ('visit', $s$select 'c:routes.plan'::text from changed union select 's:' || employee_id from changed$s$),
      ('visit_evidence', $s$select 'c:routes.plan'::text from changed
                            union select 's:' || v.employee_id from changed c join visit v on v.id = c.visit_id$s$)
    ) v (tbl, scope)
  loop
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
      'notify_' || w.tbl || '_upd', w.tbl, w.scope);
    execute format(
      'create trigger %I after delete on %I referencing old table as old_rows
         for each statement execute function notify_change(%L)',
      'notify_' || w.tbl || '_del', w.tbl, w.scope);
  end loop;
end $$;
