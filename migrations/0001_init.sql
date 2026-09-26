-- migrations/0001_init.sql — FreshNow core schema (Phase 1). Forward-only.
-- Applied to a throwaway `freshnow_test` DB by the test harness, and (later) to the
-- demo DB. RLS is default-deny on business tables. Telegram ids are bigint. Every
-- business row carries is_synthetic so demo data is never mistaken for real data.

create extension if not exists vector;

-- ── Roles ──────────────────────────────────────────────────────────────────
-- App role: RLS-ENFORCED (non-owner, no BYPASSRLS) — all user-facing access.
-- The owner/superuser (freshnow) is the service role and bypasses RLS.
-- Dev-only password; the app connects with it via DATABASE_URL.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'freshnow_app') then
    create role freshnow_app login password 'freshnow_app_pw';
  end if;
end
$$;

-- ── RLS context helpers ─────────────────────────────────────────────────────
-- app.employee_id / app.is_ceo are set per-transaction via set_config(...,true).
create or replace function app_current_employee() returns uuid
  language sql stable as $fn$
    select nullif(current_setting('app.employee_id', true), '')::uuid
$fn$;

create or replace function app_is_ceo() returns boolean
  language sql stable as $fn$
    select coalesce(current_setting('app.is_ceo', true), 'off') = 'on'
$fn$;

-- ── Tables ──────────────────────────────────────────────────────────────────
create table employee (
  id                  uuid primary key default gen_random_uuid(),
  display_name        text not null,
  telegram_user_id    bigint unique,                 -- bigint: Telegram ids exceed int32
  manager_employee_id uuid references employee(id),  -- self-ref: who this person reports to
  department          text,
  role_title          text,
  site                text,
  shift               text,
  language            text,
  status              text not null default 'pending'
                        check (status in ('pending','active','disabled')),
  is_synthetic        boolean not null default false,
  created_at          timestamptz not null default now()
);

create table task (
  id           uuid primary key default gen_random_uuid(),
  employee_id  uuid not null references employee(id),
  title        text not null,
  details      text,
  status       text not null default 'open'
                 check (status in ('open','done','pending','in_progress','cancelled')),
  due_at       timestamptz,
  is_synthetic boolean not null default false,
  created_at   timestamptz not null default now()
);

create table task_update (
  id                  uuid primary key default gen_random_uuid(),
  task_id             uuid references task(id),
  employee_id         uuid not null references employee(id),
  status              text not null
                        check (status in ('done','pending','blocker','in_progress')),
  note_raw            text,               -- verbatim; written BEFORE any LLM call
  note_parsed         jsonb,              -- LLM extraction; replaceable
  channel             text not null default 'telegram',
  telegram_message_id bigint,
  correlation_id      uuid,
  submitted_at        timestamptz not null default now(),
  is_synthetic        boolean not null default false
);

create table blocker (
  id                uuid primary key default gen_random_uuid(),
  task_update_id    uuid references task_update(id),
  raised_by         uuid not null references employee(id),  -- who reported it
  assigned_resolver uuid references employee(id),           -- who must fix it (demo: CEO)
  category          text,
  severity          text check (severity in ('low','medium','high','critical')),
  status            text not null default 'open'
                      check (status in ('open','acknowledged','resolved','cancelled')),
  risk              text,
  affected_asset    text,
  correlation_id    uuid,
  sla_due_at        timestamptz,
  raised_at         timestamptz not null default now(),
  is_synthetic      boolean not null default false
);

create table escalation (
  id           uuid primary key default gen_random_uuid(),
  blocker_id   uuid not null references blocker(id),
  level        int not null default 1,
  escalated_to uuid references employee(id),
  reason       text,
  created_at   timestamptz not null default now(),
  is_synthetic boolean not null default false
);

create table routing_rule (
  id                   uuid primary key default gen_random_uuid(),
  category             text,
  site                 text,
  shift                text,
  resolver_employee_id uuid not null references employee(id),  -- demo: always the CEO
  is_synthetic         boolean not null default false
);

create table assignment (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid references task(id),
  assigned_by  uuid references employee(id),
  assigned_to  uuid not null references employee(id),
  note         text,
  status       text not null default 'assigned'
                 check (status in ('assigned','accepted','done','cancelled')),
  created_at   timestamptz not null default now(),
  is_synthetic boolean not null default false
);

create table consent_record (
  id             uuid primary key default gen_random_uuid(),
  employee_id    uuid not null references employee(id),
  policy_version text not null,
  notice_hash    text not null,          -- hash of the exact notice text the employee saw
  consented_at   timestamptz not null default now(),
  is_synthetic   boolean not null default false
);

create table invite_code (
  id           uuid primary key default gen_random_uuid(),
  code         text unique not null,
  display_name text,
  employee_id  uuid references employee(id),
  issued_by    uuid references employee(id),
  expires_at   timestamptz,
  redeemed_at  timestamptz,
  created_at   timestamptz not null default now(),
  is_synthetic boolean not null default false
);

create table voice_asset (
  id             uuid primary key default gen_random_uuid(),
  employee_id    uuid references employee(id),
  file_id        text,
  local_path     text,
  transcript_raw text,
  status         text not null default 'pending'
                   check (status in ('pending','transcribed','failed')),
  created_at     timestamptz not null default now(),
  is_synthetic   boolean not null default false
);

create table notification_outbox (
  id              uuid primary key default gen_random_uuid(),
  idempotency_key text unique not null,   -- exactly-once delivery
  chat_id         bigint,
  payload         jsonb,
  status          text not null default 'pending'
                    check (status in ('pending','sent','failed','abandoned')),
  human_approved  boolean not null default false,
  attempts        int not null default 0,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz,
  is_synthetic    boolean not null default false
);

create table audit_log (
  id             uuid primary key default gen_random_uuid(),
  correlation_id uuid,
  actor          text,
  action         text not null,
  entity         text,
  entity_id      text,
  detail         jsonb,
  created_at     timestamptz not null default now()
);

create table run_trace (
  id             uuid primary key default gen_random_uuid(),
  correlation_id uuid,
  step           text not null,
  input          jsonb,
  output         jsonb,
  created_at     timestamptz not null default now()
);

create table llm_call (
  id                uuid primary key default gen_random_uuid(),
  correlation_id    uuid,
  provider          text,
  model             text,
  prompt_tokens     int,
  completion_tokens int,
  cost_usd          numeric(10,6),
  latency_ms        int,
  success           boolean,
  created_at        timestamptz not null default now()
);

create table job_run (
  id          uuid primary key default gen_random_uuid(),
  job_name    text not null,
  status      text,
  detail      jsonb,
  started_at  timestamptz,
  finished_at timestamptz,
  created_at  timestamptz not null default now()
);

-- ── Indexes (hot paths) ─────────────────────────────────────────────────────
create index on task (employee_id);
create index on task_update (employee_id);
create index on task_update (task_id);
create index on blocker (raised_by);
create index on blocker (assigned_resolver);
create index on blocker (status);
create index on audit_log (correlation_id);
create index on run_trace (correlation_id);

-- ── RLS: enable (default deny), then policies ───────────────────────────────
alter table employee            enable row level security;
alter table task                enable row level security;
alter table task_update         enable row level security;
alter table blocker             enable row level security;
alter table escalation          enable row level security;
alter table routing_rule        enable row level security;
alter table assignment          enable row level security;
alter table consent_record      enable row level security;
alter table invite_code         enable row level security;
alter table voice_asset         enable row level security;
alter table notification_outbox enable row level security;
alter table audit_log           enable row level security;
alter table run_trace           enable row level security;
alter table llm_call            enable row level security;
alter table job_run             enable row level security;

-- employee: sees own row; CEO sees all; may update own descriptive profile.
create policy employee_select on employee for select to freshnow_app
  using (id = app_current_employee() or app_is_ceo());
create policy employee_update on employee for update to freshnow_app
  using (id = app_current_employee() or app_is_ceo())
  with check (id = app_current_employee() or app_is_ceo());

-- task: employee sees own tasks; CEO sees all.
create policy task_select on task for select to freshnow_app
  using (employee_id = app_current_employee() or app_is_ceo());

-- task_update: read own; insert only for self (WITH CHECK blocks cross-employee).
create policy task_update_select on task_update for select to freshnow_app
  using (employee_id = app_current_employee() or app_is_ceo());
create policy task_update_insert on task_update for insert to freshnow_app
  with check (employee_id = app_current_employee() or app_is_ceo());

-- blocker: visible to raiser or assigned resolver; CEO sees all.
create policy blocker_select on blocker for select to freshnow_app
  using (raised_by = app_current_employee()
         or assigned_resolver = app_current_employee()
         or app_is_ceo());
create policy blocker_insert on blocker for insert to freshnow_app
  with check (raised_by = app_current_employee() or app_is_ceo());

-- routing_rule: config, readable by any authenticated app user.
create policy routing_rule_select on routing_rule for select to freshnow_app
  using (true);

-- assignment: parties to the assignment, or CEO.
create policy assignment_select on assignment for select to freshnow_app
  using (assigned_to = app_current_employee()
         or assigned_by = app_current_employee()
         or app_is_ceo());

-- consent / voice: own rows or CEO.
create policy consent_select on consent_record for select to freshnow_app
  using (employee_id = app_current_employee() or app_is_ceo());
create policy consent_insert on consent_record for insert to freshnow_app
  with check (employee_id = app_current_employee() or app_is_ceo());
create policy voice_select on voice_asset for select to freshnow_app
  using (employee_id = app_current_employee() or app_is_ceo());
create policy voice_insert on voice_asset for insert to freshnow_app
  with check (employee_id = app_current_employee() or app_is_ceo());

-- CEO-only surfaces in the app (the worker uses the service role, which bypasses).
create policy invite_ceo    on invite_code         for select to freshnow_app using (app_is_ceo());
create policy outbox_ceo    on notification_outbox for select to freshnow_app using (app_is_ceo());
create policy escalation_ceo on escalation         for select to freshnow_app using (app_is_ceo());
create policy run_trace_ceo on run_trace           for select to freshnow_app using (app_is_ceo());
create policy llm_call_ceo  on llm_call            for select to freshnow_app using (app_is_ceo());
create policy job_run_ceo   on job_run             for select to freshnow_app using (app_is_ceo());

-- audit_log: append-only for the app role — SELECT (CEO) + INSERT, never UPDATE/DELETE.
create policy audit_select on audit_log for select to freshnow_app using (app_is_ceo());
create policy audit_insert on audit_log for insert to freshnow_app with check (true);

-- ── Privileges ──────────────────────────────────────────────────────────────
grant usage on schema public to freshnow_app;
grant select, insert, update, delete on all tables in schema public to freshnow_app;
-- Append-only: strip UPDATE/DELETE on the audit log at the privilege level too.
revoke update, delete on audit_log from freshnow_app;

-- ── Seed: the demo CEO + degenerate routing (everything → CEO) ──────────────
-- Synthetic. The real CEO Telegram id is linked at onboarding.
insert into employee (id, display_name, status, is_synthetic)
values ('00000000-0000-0000-0000-0000000000ce', 'DEMO CEO', 'active', true);

insert into routing_rule (category, site, shift, resolver_employee_id, is_synthetic)
values
  (null,        null, null, '00000000-0000-0000-0000-0000000000ce', true),  -- catch-all
  ('equipment', null, null, '00000000-0000-0000-0000-0000000000ce', true),
  ('supply',    null, null, '00000000-0000-0000-0000-0000000000ce', true),
  ('staffing',  null, null, '00000000-0000-0000-0000-0000000000ce', true),
  ('quality',   null, null, '00000000-0000-0000-0000-0000000000ce', true);
