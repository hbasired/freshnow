-- migrations/0010_task_depth.sql — steps, status categories, resolution, progress, relations.
--
-- What a task IS was one row with a title and a status. What the business needs to know
-- about a task is: how far along it is, on what evidence, whether it is late, what it
-- depends on, why it stopped, and what went wrong on the way. Each of those becomes data
-- here, following the shape mature tools converged on:
--
--   status category   Jira maps every status to To Do / In Progress / Done and reports on
--                     the category, not the name. Same here, with a lookup table.
--   status ≠ resolution  Jira again: status is WHERE it is, resolution is WHY it stopped
--                     (done, won't do, duplicate, cancelled). Conflating them is the most
--                     common reporting error.
--   steps             A checklist. Counting done steps is what makes a percentage honest.
--   progress_source   Which of three things the percentage is: counted from steps,
--                     derived from the status, or typed by a person (self-reported — kept,
--                     labelled, and never presented as a measurement).
--   relations         Hierarchy (parent) and relations (blocks, precedes, relates,
--                     duplicates) are different things; the inverse of a directional
--                     relation is written by the code in the same transaction.
--
-- Every percentage is a SQL expression over these rows. The model never produces one.
--
-- On cascades: this schema has none, deliberately, for business rows. The three tables
-- below are different — a step, a relation or a progress event has no meaning without its
-- task, so they go with it (ON DELETE CASCADE). Their references to PEOPLE are SET NULL: a
-- person may be removed from the system (the reset script does exactly that) and the record
-- of what happened to the task must survive them.

-- ── Status lookup ─────────────────────────────────────────────────────────────
create table if not exists task_status (
  key            text primary key,
  label          text not null,
  category       text not null check (category in ('todo', 'in_progress', 'done')),
  -- Status-based progress (OpenProject's mode): the percentage a task is considered to be at
  -- simply by being in this status, used when it has no steps to count. [assumed] values.
  pct_when_here  int  not null check (pct_when_here between 0 and 100),
  position       int  not null
);

insert into task_status (key, label, category, pct_when_here, position) values
  ('open',        'Open',        'todo',        0,   10),
  ('pending',     'Pending',     'in_progress', 10,  20),
  ('in_progress', 'In progress', 'in_progress', 50,  30),
  ('done',        'Done',        'done',        100, 40),
  ('cancelled',   'Cancelled',   'done',        0,   50)
on conflict (key) do nothing;

-- The existing CHECK on task.status lists the same five values; the foreign key makes the
-- lookup the single source of truth from here on.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'task_status_fk') then
    alter table task add constraint task_status_fk foreign key (status) references task_status (key);
  end if;
end $$;

-- ── Task depth ────────────────────────────────────────────────────────────────
alter table task
  add column if not exists resolution          text check (resolution in ('done', 'wont_do', 'duplicate', 'cancelled')),
  add column if not exists resolved_at         timestamptz,
  add column if not exists progress_pct        int not null default 0 check (progress_pct between 0 and 100),
  add column if not exists progress_source     text not null default 'status'
                                                 check (progress_source in ('counted', 'status', 'self_reported')),
  add column if not exists progress_note       text,
  add column if not exists progress_updated_at timestamptz,
  add column if not exists started_at          timestamptz,
  add column if not exists priority            text not null default 'normal'
                                                 check (priority in ('low', 'normal', 'high', 'urgent')),
  add column if not exists parent_task_id      uuid references task (id),
  add column if not exists task_type           text not null default 'task' check (task_type in ('task', 'subtask')),
  add column if not exists estimate_minutes    int check (estimate_minutes > 0);

create index if not exists idx_task_parent on task (parent_task_id);
create index if not exists idx_task_status on task (status);
create index if not exists idx_task_due on task (due_at);

-- Bring existing rows in line with their status.
update task t set progress_pct = s.pct_when_here, progress_source = 'status'
  from task_status s where s.key = t.status and t.progress_source = 'status';
update task set resolution = 'done', resolved_at = coalesce(resolved_at, now())
  where status = 'done' and resolution is null;

-- ── Steps (checklist) ─────────────────────────────────────────────────────────
create table if not exists task_step (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid not null references task (id) on delete cascade,
  title        text not null,
  position     int  not null default 0,
  done         boolean not null default false,
  done_at      timestamptz,
  done_by      uuid references employee (id) on delete set null,
  created_by   uuid references employee (id) on delete set null,
  created_at   timestamptz not null default now(),
  is_synthetic boolean not null default false
);
create index if not exists idx_task_step_task on task_step (task_id, position);

-- ── Relations between tasks ───────────────────────────────────────────────────
create table if not exists task_relation (
  id           uuid primary key default gen_random_uuid(),
  from_task_id uuid not null references task (id) on delete cascade,
  to_task_id   uuid not null references task (id) on delete cascade,
  kind         text not null check (kind in ('blocks', 'blocked_by', 'precedes', 'follows', 'relates', 'duplicates')),
  created_by   uuid references employee (id) on delete set null,
  created_at   timestamptz not null default now(),
  is_synthetic boolean not null default false,
  unique (from_task_id, to_task_id, kind),
  check (from_task_id <> to_task_id)
);
create index if not exists idx_task_relation_to on task_relation (to_task_id);

-- ── Progress history (append-only) ────────────────────────────────────────────
create table if not exists progress_event (
  id             uuid primary key default gen_random_uuid(),
  task_id        uuid not null references task (id) on delete cascade,
  employee_id    uuid references employee (id) on delete set null,
  pct            int  not null check (pct between 0 and 100),
  source         text not null check (source in ('counted', 'status', 'self_reported')),
  note           text,
  correlation_id uuid,
  created_at     timestamptz not null default now(),
  is_synthetic   boolean not null default false
);
create index if not exists idx_progress_event_task on progress_event (task_id, created_at desc);

-- ── Blockers get a resolution ─────────────────────────────────────────────────
-- The status value 'resolved' existed in the CHECK from day one; nothing ever wrote it.
alter table blocker
  add column if not exists resolved_at     timestamptz,
  add column if not exists resolved_by     uuid references employee (id) on delete set null,
  add column if not exists resolution_note text;

-- ── RLS: same predicate as everything else (0009) ─────────────────────────────
alter table task_status    enable row level security;
alter table task_status    force row level security;
alter table task_step      enable row level security;
alter table task_step      force row level security;
alter table task_relation  enable row level security;
alter table task_relation  force row level security;
alter table progress_event enable row level security;
alter table progress_event force row level security;

drop policy if exists task_status_select on task_status;
create policy task_status_select on task_status for select to freshnow_app using (true);

drop policy if exists task_step_select on task_step;
create policy task_step_select on task_step for select to freshnow_app
  using (task_id in (select id from task where app_can_view_employee(employee_id)));

drop policy if exists task_relation_select on task_relation;
create policy task_relation_select on task_relation for select to freshnow_app
  using (from_task_id in (select id from task where app_can_view_employee(employee_id))
      or to_task_id   in (select id from task where app_can_view_employee(employee_id)));

drop policy if exists progress_event_select on progress_event;
create policy progress_event_select on progress_event for select to freshnow_app
  using (task_id in (select id from task where app_can_view_employee(employee_id)));
