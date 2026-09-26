-- migrations/0012_projects.sql — the second portal: work that has a plan, a shape and an end.
--
-- A task is a thing somebody does today. A project is a thing the company is trying to achieve,
-- with a reason it exists, requirements that say what "done" means, milestones that say when,
-- and issues that are risks to the plan rather than a broken chiller on the floor.
--
-- Two design choices carry the whole file:
--
--   1. THE TASK TABLE IS THE UNIT OF WORK FOR PROJECTS TOO. `task.project_id` and
--      `task.milestone_id`, not a parallel task system. Everything Phase 3 built — steps,
--      progress with a named source, relations, resolution — applies unchanged to project work,
--      and a person's "My work" is one list whether the work came from a project or a shift.
--
--   2. PROGRESS IS COMPUTED, NEVER TYPED. `project_progress` is a view. A project's percentage
--      is derived from its milestones' weights and its tasks' own (already evidence-based)
--      percentages. `project_update.pct_reported` exists so a human can SAY where they think
--      they are, and it is stored next to the computed number rather than instead of it.
--
-- Deliberately NOT here: earned value, SPI, CPI, velocity, burndown. They need a time-phased
-- cost baseline FreshNow does not have, and inventing one would be a fabricated number. The
-- metrics view implements the Kanban Guide's four flow metrics instead, which need only the
-- timestamps we already keep honestly.

-- ── The project ───────────────────────────────────────────────────────────────
create table if not exists project (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  -- Short human handle used in conversation ("NB-01"). Unique when present.
  code                text,
  -- WHY it exists, in the business's own words. The needs/requirements stage starts here.
  purpose             text,
  status              text not null default 'draft'
                        check (status in ('draft', 'active', 'on_hold', 'done', 'cancelled')),
  start_date          date,
  target_date         date,
  sponsor_employee_id uuid references employee (id) on delete set null,
  lead_employee_id    uuid references employee (id) on delete set null,
  -- A judgement, made by a person, about whether this will land. Never computed: the view
  -- computes schedule and progress; whether that is *worrying* is a human call.
  health              text not null default 'green' check (health in ('green', 'amber', 'red')),
  health_note         text,
  health_updated_at   timestamptz,
  created_by          uuid references employee (id) on delete set null,
  created_at          timestamptz not null default now(),
  is_synthetic        boolean not null default false
);
create unique index if not exists project_code_unique on project (lower(code)) where code is not null;
create index if not exists idx_project_status on project (status);

-- ── What the project must deliver ─────────────────────────────────────────────
-- MoSCoW, because a requirement without a priority is a wish, and because "won't" is the
-- half of the method people forget: recording what is explicitly out of scope is what stops
-- it being argued back in later.
create table if not exists project_requirement (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references project (id) on delete cascade,
  kind          text not null default 'requirement'
                  check (kind in ('need', 'requirement', 'constraint', 'assumption')),
  text          text not null,
  priority      text not null default 'should' check (priority in ('must', 'should', 'could', 'wont')),
  -- How we will know it is met. A requirement nobody can test is not a requirement.
  acceptance    text,
  status        text not null default 'open' check (status in ('open', 'met', 'dropped')),
  raised_by     uuid references employee (id) on delete set null,
  position      int not null default 0,
  created_at    timestamptz not null default now(),
  is_synthetic  boolean not null default false
);
create index if not exists idx_requirement_project on project_requirement (project_id);

-- ── When ──────────────────────────────────────────────────────────────────────
create table if not exists milestone (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references project (id) on delete cascade,
  name         text not null,
  due_date     date,
  -- Relative importance in the rollup. Equal weights unless somebody says otherwise, so a
  -- two-day milestone does not count the same as a two-month one when it shouldn't.
  weight       int not null default 1 check (weight between 1 and 100),
  status       text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  done_at      timestamptz,
  position     int not null default 0,
  created_at   timestamptz not null default now(),
  is_synthetic boolean not null default false
);
create index if not exists idx_milestone_project on milestone (project_id);

-- ── The existing task table becomes the unit of project work ──────────────────
alter table task
  add column if not exists project_id   uuid references project (id) on delete set null,
  add column if not exists milestone_id uuid references milestone (id) on delete set null;
create index if not exists idx_task_project on task (project_id);
create index if not exists idx_task_milestone on task (milestone_id);

-- ── Who is on it ──────────────────────────────────────────────────────────────
-- Drives both visibility (a member may see the project) and alert routing for it.
create table if not exists project_member (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references project (id) on delete cascade,
  employee_id  uuid not null references employee (id) on delete cascade,
  role         text not null default 'member' check (role in ('sponsor', 'lead', 'member', 'watcher')),
  created_at   timestamptz not null default now(),
  unique (project_id, employee_id)
);
create index if not exists idx_project_member_employee on project_member (employee_id);

-- ── The status log ────────────────────────────────────────────────────────────
-- Append-only: a status history that can be edited is not a history. `pct_reported` is what a
-- person SAYS; `project_progress.progress_pct` is what the tasks actually show. Keeping both
-- is the point — the gap between them is the most useful number on the page.
create table if not exists project_update (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references project (id) on delete cascade,
  author_id     uuid references employee (id) on delete set null,
  narrative     text not null,
  pct_reported  int check (pct_reported between 0 and 100),
  health        text check (health in ('green', 'amber', 'red')),
  period_start  date,
  period_end    date,
  created_at    timestamptz not null default now(),
  correlation_id uuid,
  is_synthetic  boolean not null default false
);
create index if not exists idx_project_update_project on project_update (project_id, created_at desc);

-- ── Risks to the plan ─────────────────────────────────────────────────────────
-- Deliberately NOT the `blocker` table. A broken chiller is an operational blocker with an SLA
-- and an escalation ladder measured in minutes; "the supplier may not deliver in time" is a
-- project risk reviewed weekly. Putting them in one table would mean one of them gets the
-- wrong urgency, and it would corrupt the blocker SLA statistics.
create table if not exists project_issue (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references project (id) on delete cascade,
  milestone_id    uuid references milestone (id) on delete set null,
  kind            text not null default 'issue'
                    check (kind in ('issue', 'risk', 'dependency', 'decision')),
  title           text not null,
  description     text,
  severity        text not null default 'medium' check (severity in ('low', 'medium', 'high', 'critical')),
  status          text not null default 'open' check (status in ('open', 'mitigating', 'resolved', 'accepted')),
  owner_id        uuid references employee (id) on delete set null,
  raised_by       uuid references employee (id) on delete set null,
  mitigation      text,
  due_date        date,
  resolved_at     timestamptz,
  resolution_note text,
  created_at      timestamptz not null default now(),
  correlation_id  uuid,
  is_synthetic    boolean not null default false
);
create index if not exists idx_project_issue_project on project_issue (project_id, status);

-- ── Who may see a project ─────────────────────────────────────────────────────
-- Membership, or the ordinary org rule applied to the people on it: a manager who can see the
-- lead can see the project. The CEO sees all. SECURITY DEFINER for the same reason
-- app_can_view_employee is: the policy must be able to look at rows the caller cannot.
create or replace function app_can_view_project(target uuid) returns boolean
  language sql stable security definer set search_path = public as $fn$
    select app_is_ceo()
        or exists (select 1 from project_member m
                   where m.project_id = target and m.employee_id = app_current_employee())
        or exists (select 1 from project p
                   where p.id = target
                     and (app_can_view_employee(p.lead_employee_id)
                       or app_can_view_employee(p.sponsor_employee_id)))
$fn$;
grant execute on function app_can_view_project(uuid) to freshnow_app;

-- ── Progress, computed ────────────────────────────────────────────────────────
-- One row per project. Every number here is SQL over every row — never a model, never typed.
-- Dropped first rather than replaced: CREATE OR REPLACE VIEW cannot change a column's type,
-- so a view that is ever corrected would otherwise fail to apply on a database that has it.
drop view if exists project_progress;
create view project_progress as
with task_rollup as (
  select t.project_id,
         count(*)::int                                          as tasks_total,
         count(*) filter (where s.category = 'done')::int        as tasks_done,
         count(*) filter (where s.category = 'in_progress')::int as tasks_in_progress,
         -- The average of the tasks' own evidence-based percentages (Phase 3). A task in the
         -- 'done' CATEGORY counts as 100 whatever its stored number says: the category is the
         -- definition of finished, and a stale stored value must not drag a project down.
         coalesce(round(avg(case when s.category = 'done' then 100 else t.progress_pct end))::int, 0) as task_pct
  from task t
  join task_status s on s.key = t.status
  where t.project_id is not null
  group by t.project_id
),
milestone_rollup as (
  -- Weighted by the milestone's weight, so critical work cannot hide behind an aggregate
  -- (Linear computes progress per milestone for exactly this reason).
  select m.project_id,
         count(*)::int                                   as milestones_total,
         count(*) filter (where m.status = 'done')::int  as milestones_done,
         count(*) filter (where m.status = 'open' and m.due_date is not null
                            and m.due_date < current_date)::int as milestones_overdue,
         sum(m.weight)::int                              as weight_total,
         sum(m.weight) filter (where m.status = 'done')::int as weight_done
  from milestone m
  group by m.project_id
),
issue_rollup as (
  select project_id,
         count(*) filter (where status in ('open', 'mitigating'))::int                 as issues_open,
         count(*) filter (where status in ('open', 'mitigating')
                            and severity in ('high', 'critical'))::int                 as issues_serious
  from project_issue
  group by project_id
)
select p.id                                    as project_id,
       p.name,
       p.status,
       p.health,
       p.start_date,
       p.target_date,
       coalesce(t.tasks_total, 0)              as tasks_total,
       coalesce(t.tasks_done, 0)               as tasks_done,
       coalesce(t.tasks_in_progress, 0)        as tasks_in_progress,
       coalesce(m.milestones_total, 0)         as milestones_total,
       coalesce(m.milestones_done, 0)          as milestones_done,
       coalesce(m.milestones_overdue, 0)       as milestones_overdue,
       coalesce(i.issues_open, 0)              as issues_open,
       coalesce(i.issues_serious, 0)           as issues_serious,
       -- Weighted milestones when there are any, else the tasks' own average, else 0.
       -- Stated in the column name so nobody has to guess which one they are reading.
       case
         when coalesce(m.weight_total, 0) > 0
           then round(100.0 * coalesce(m.weight_done, 0) / m.weight_total)::int
         else coalesce(t.task_pct, 0)
       end                                     as progress_pct,
       case when coalesce(m.weight_total, 0) > 0 then 'milestones' else 'tasks' end as progress_source,
       -- How much of the planned time has been used. NULL when the dates are not set: an
       -- unknown is not zero.
       case
         when p.start_date is null or p.target_date is null or p.target_date <= p.start_date then null
         else greatest(0, least(100, round(100.0 * (current_date - p.start_date)
                                              / (p.target_date - p.start_date))::int))
       end                                     as schedule_elapsed_pct,
       (select max(u.created_at) from project_update u where u.project_id = p.id) as last_update_at,
       (select count(*)::int from project_update u where u.project_id = p.id)     as updates_total
from project p
left join task_rollup      t on t.project_id = p.id
left join milestone_rollup m on m.project_id = p.id
left join issue_rollup     i on i.project_id = p.id;

-- ── Flow metrics ──────────────────────────────────────────────────────────────
-- The Kanban Guide's four: WIP, Throughput, Work Item Age, Cycle Time — and cycle time as
-- PERCENTILES, never a mean, because the distribution is skewed and the mean of a skewed
-- distribution describes nobody's experience. Work Item Age is the only leading indicator
-- here: it tells you about work that is still open, while the rest are about work already
-- finished. Scoped per project (NULL project_id = ordinary operational work).
drop view if exists flow_metrics;
create view flow_metrics as
with finished as (
  select t.project_id,
         extract(epoch from (t.resolved_at - coalesce(t.started_at, t.created_at))) / 86400.0 as cycle_days,
         t.resolved_at
  from task t
  join task_status s on s.key = t.status
  where s.category = 'done' and t.resolved_at is not null
    and coalesce(t.started_at, t.created_at) is not null
    and t.resolved_at >= coalesce(t.started_at, t.created_at)
),
open_now as (
  select t.project_id,
         extract(epoch from (now() - coalesce(t.started_at, t.created_at))) / 86400.0 as age_days,
         s.category
  from task t
  join task_status s on s.key = t.status
  where s.category <> 'done'
)
select p.project_id,
       -- WIP: work started and not finished. The number the Kanban Guide says to limit.
       (select count(*) from open_now o where o.project_id is not distinct from p.project_id
          and o.category = 'in_progress')::int                                        as wip,
       (select count(*) from open_now o where o.project_id is not distinct from p.project_id)::int as open_total,
       -- Work Item Age: how long the oldest unfinished thing has been going.
       (select round(max(o.age_days))::int from open_now o
          where o.project_id is not distinct from p.project_id)                       as oldest_open_days,
       (select round(avg(o.age_days))::int from open_now o
          where o.project_id is not distinct from p.project_id)                       as avg_open_days,
       -- Throughput: items finished in the last 7 and 28 days.
       (select count(*) from finished f where f.project_id is not distinct from p.project_id
          and f.resolved_at > now() - interval '7 days')::int                         as throughput_7d,
       (select count(*) from finished f where f.project_id is not distinct from p.project_id
          and f.resolved_at > now() - interval '28 days')::int                        as throughput_28d,
       (select round(percentile_cont(0.5) within group (order by f.cycle_days)::numeric, 1)
          from finished f where f.project_id is not distinct from p.project_id)       as cycle_p50_days,
       (select round(percentile_cont(0.85) within group (order by f.cycle_days)::numeric, 1)
          from finished f where f.project_id is not distinct from p.project_id)       as cycle_p85_days,
       (select round(percentile_cont(0.95) within group (order by f.cycle_days)::numeric, 1)
          from finished f where f.project_id is not distinct from p.project_id)       as cycle_p95_days,
       (select count(*) from finished f where f.project_id is not distinct from p.project_id)::int as finished_total
from (select distinct project_id from task) p;

grant select on project_progress to freshnow_app;
grant select on flow_metrics to freshnow_app;

-- ── RLS ───────────────────────────────────────────────────────────────────────
alter table project             enable row level security;
alter table project             force row level security;
alter table project_requirement enable row level security;
alter table project_requirement force row level security;
alter table milestone           enable row level security;
alter table milestone           force row level security;
alter table project_member      enable row level security;
alter table project_member      force row level security;
alter table project_update      enable row level security;
alter table project_update      force row level security;
alter table project_issue       enable row level security;
alter table project_issue       force row level security;

drop policy if exists project_select on project;
create policy project_select on project for select to freshnow_app
  using (app_can_view_project(id));

drop policy if exists project_requirement_select on project_requirement;
create policy project_requirement_select on project_requirement for select to freshnow_app
  using (app_can_view_project(project_id));

drop policy if exists milestone_select on milestone;
create policy milestone_select on milestone for select to freshnow_app
  using (app_can_view_project(project_id));

drop policy if exists project_member_select on project_member;
create policy project_member_select on project_member for select to freshnow_app
  using (app_can_view_project(project_id) or employee_id = app_current_employee());

drop policy if exists project_update_select on project_update;
create policy project_update_select on project_update for select to freshnow_app
  using (app_can_view_project(project_id));

drop policy if exists project_issue_select on project_issue;
create policy project_issue_select on project_issue for select to freshnow_app
  using (app_can_view_project(project_id));

-- The views run with the querying role's permissions (security_invoker), so the policies
-- above apply through them rather than being bypassed. Without this a view would be a hole
-- straight through RLS — the single most common way row security is accidentally defeated.
alter view project_progress set (security_invoker = true);
alter view flow_metrics    set (security_invoker = true);

-- Privileges for tables created after 0005's blanket grant (see G-privileges).
grant select, insert, update, delete on project, project_requirement, milestone,
      project_member, project_update, project_issue to freshnow_app;
