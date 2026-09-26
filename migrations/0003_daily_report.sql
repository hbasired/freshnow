-- migrations/0003_daily_report.sql — end-of-day report per employee.
--
-- One row per person per day. The COUNTS are computed in SQL over every row; the
-- narrative is written by the model from those already-computed numbers, so it can
-- never invent a total (CLAUDE.md rule 2: the engine computes, the model narrates).
--
-- `detail` keeps the structured breakdown (tasks completed / pending / blocked, with
-- the person's own words) so the CEO can drill in without re-querying, and so the
-- report stays readable years later even if the underlying rows are anonymised.

create table if not exists daily_report (
  id             uuid primary key default gen_random_uuid(),
  employee_id    uuid not null references employee(id),
  report_date    date not null,

  -- Computed in SQL, never by the model.
  completed      int  not null default 0,
  pending        int  not null default 0,
  blockers       int  not null default 0,
  reports_made   int  not null default 0,

  summary        text,   -- model-written narrative, grounded in the counts above
  detail         jsonb,  -- structured breakdown incl. note_raw
  generated_at   timestamptz not null default now(),
  is_synthetic   boolean not null default false,

  -- Regenerating a day replaces it rather than duplicating it.
  unique (employee_id, report_date)
);

create index if not exists idx_daily_report_date on daily_report(report_date desc);

alter table daily_report enable row level security;
alter table daily_report force row level security;

-- The CEO sees every report; an employee sees only their own.
drop policy if exists daily_report_read on daily_report;
create policy daily_report_read on daily_report for select
  using (app_is_ceo() or employee_id = app_current_employee());
