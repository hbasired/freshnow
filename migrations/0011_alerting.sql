-- migrations/0011_alerting.sql — who is told what, when, through which channel, and what
-- happens if nobody answers.
--
-- Today: every blocker alert goes to the CEO, SLA minutes are constants in TypeScript,
-- escalation always targets the CEO, and the outbox can only address a Telegram chat. This
-- migration turns each of those into a table, following the decomposition PagerDuty and
-- Opsgenie converged on (an escalation POLICY of ordered LEVELS with timeouts and symbolic
-- TARGETS; per-person notification RULES; ALIAS-based de-duplication; a three-state
-- acknowledgement machine), and makes the outbox channel-aware so email and web push are
-- later a new sender and a row — not a change to any business code.
--
-- Deterministic throughout: every recipient is a table lookup, and every alert records the
-- rule that chose it, so "who was told, and why" is a query over audit_log and this data.

-- ── The outbox learns channels and recipients ────────────────────────────────
alter table notification_outbox
  add column if not exists channel text not null default 'telegram'
    check (channel in ('telegram', 'inapp', 'email', 'webpush')),
  add column if not exists recipient_employee_id uuid references employee (id) on delete set null,
  -- Why this message exists: the matched rule, in plain words ("resolver", "manager of the
  -- person who raised it", "escalation level 2 → ceo"). Shown in the inbox.
  add column if not exists reason text,
  -- For the in-app channel the row IS the notification; this is when it was read.
  add column if not exists read_at timestamptz;

create index if not exists idx_outbox_recipient on notification_outbox (recipient_employee_id, created_at desc);

-- A person may read their own in-app notifications; the CEO still sees all rows.
drop policy if exists outbox_recipient on notification_outbox;
create policy outbox_recipient on notification_outbox for select to freshnow_app
  using (recipient_employee_id = app_current_employee());

-- ── SLA windows, editable ─────────────────────────────────────────────────────
create table if not exists sla_policy (
  severity     text primary key check (severity in ('low', 'medium', 'high', 'critical')),
  minutes      int  not null check (minutes > 0),
  updated_at   timestamptz not null default now(),
  is_synthetic boolean not null default false
);
-- Seeded with the constants the code has used so far, so nothing changes on day one.
-- [assumed] until FreshNow supplies real service levels (question A9).
insert into sla_policy (severity, minutes, is_synthetic) values
  ('critical', 15, true), ('high', 60, true), ('medium', 240, true), ('low', 1440, true)
on conflict (severity) do nothing;

-- ── Escalation: policy → levels → targets ─────────────────────────────────────
create table if not exists escalation_policy (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  is_default   boolean not null default false,
  is_synthetic boolean not null default false,
  created_at   timestamptz not null default now()
);
-- Exactly one default policy at a time.
create unique index if not exists escalation_policy_one_default on escalation_policy (is_default) where is_default;

create table if not exists escalation_level (
  id              uuid primary key default gen_random_uuid(),
  policy_id       uuid not null references escalation_policy (id) on delete cascade,
  level_no        int  not null check (level_no between 1 and 10),
  -- Minutes after the PREVIOUS level fired (or, for level 1, after the SLA ran out).
  timeout_minutes int  not null check (timeout_minutes >= 0),
  unique (policy_id, level_no)
);

create table if not exists escalation_target (
  id                 uuid primary key default gen_random_uuid(),
  level_id           uuid not null references escalation_level (id) on delete cascade,
  -- Symbolic, so the ladder survives staff changes: resolved to people at fire time.
  target_type        text not null check (target_type in ('resolver', 'manager_of_raiser', 'department_lead', 'ceo', 'employee')),
  target_employee_id uuid references employee (id) on delete set null,
  -- Order within a level: the first rule that names a person is the reason recorded.
  position           int  not null default 0,
  check ((target_type = 'employee') = (target_employee_id is not null))
);

-- The default ladder. Level 1 goes to the person the blocker was routed to AND the raiser's
-- manager; level 2, half an hour later, to the CEO; level 3, an hour after that, to the CEO
-- again. In the seeded org every manager is the CEO, so today's behaviour (escalate to the
-- CEO) is preserved; with a real org chart it becomes a real ladder. [assumed] timings.
do $$
declare pol uuid; l1 uuid; l2 uuid; l3 uuid;
begin
  if not exists (select 1 from escalation_policy where is_default) then
    insert into escalation_policy (name, is_default, is_synthetic) values ('Default ladder', true, true) returning id into pol;
    insert into escalation_level (policy_id, level_no, timeout_minutes) values (pol, 1, 0)  returning id into l1;
    insert into escalation_level (policy_id, level_no, timeout_minutes) values (pol, 2, 30) returning id into l2;
    insert into escalation_level (policy_id, level_no, timeout_minutes) values (pol, 3, 60) returning id into l3;
    insert into escalation_target (level_id, target_type, position)
      values (l1, 'resolver', 1), (l1, 'manager_of_raiser', 2), (l2, 'ceo', 1), (l3, 'ceo', 1);
  end if;
end $$;

-- ── Alerts: one open alert per problem, however many times it is reported ─────
create table if not exists alert (
  id             uuid primary key default gen_random_uuid(),
  -- Caller-supplied key for "the same problem". A repeat with the same alias while the
  -- alert is open increments count instead of paging again (Opsgenie's de-duplication).
  alias          text not null,
  kind           text not null,
  entity         text not null,
  entity_id      text not null,
  -- The person the alert is about (the raiser of a blocker); drives RLS.
  employee_id    uuid references employee (id) on delete set null,
  state          text not null default 'triggered' check (state in ('triggered', 'acknowledged', 'resolved')),
  count          int  not null default 1,
  first_seen     timestamptz not null default now(),
  last_seen      timestamptz not null default now(),
  acked_by       uuid references employee (id) on delete set null,
  acked_at       timestamptz,
  resolved_at    timestamptz,
  correlation_id uuid,
  is_synthetic   boolean not null default false
);
create unique index if not exists alert_open_alias on alert (alias) where state <> 'resolved';
create index if not exists idx_alert_entity on alert (entity, entity_id);

-- A blocker points at the alert it was folded into. Two reports of the same problem share
-- one alert; acknowledging the alert acknowledges both, and only the first walks the ladder.
alter table blocker add column if not exists alert_id uuid references alert (id) on delete set null;
create index if not exists idx_blocker_alert on blocker (alert_id);

-- ── Who else follows a task ───────────────────────────────────────────────────
create table if not exists task_watcher (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid not null references task (id) on delete cascade,
  employee_id  uuid not null references employee (id) on delete cascade,
  reason       text not null default 'watcher' check (reason in ('assignee', 'manager', 'raised_by', 'watcher')),
  created_at   timestamptz not null default now(),
  unique (task_id, employee_id)
);

-- ── What each person wants, per event and channel ─────────────────────────────
-- No row means the default: telegram immediately, and the in-app inbox always.
create table if not exists notification_pref (
  id            uuid primary key default gen_random_uuid(),
  employee_id   uuid not null references employee (id) on delete cascade,
  event_type    text not null,
  channel       text not null check (channel in ('telegram', 'email', 'webpush')),
  mode          text not null default 'immediate' check (mode in ('immediate', 'digest', 'off')),
  delay_minutes int  not null default 0 check (delay_minutes between 0 and 1440),
  updated_at    timestamptz not null default now(),
  unique (employee_id, event_type, channel)
);

-- ── RLS ───────────────────────────────────────────────────────────────────────
alter table sla_policy        enable row level security;
alter table sla_policy        force row level security;
alter table escalation_policy enable row level security;
alter table escalation_policy force row level security;
alter table escalation_level  enable row level security;
alter table escalation_level  force row level security;
alter table escalation_target enable row level security;
alter table escalation_target force row level security;
alter table alert             enable row level security;
alter table alert             force row level security;
alter table task_watcher      enable row level security;
alter table task_watcher      force row level security;
alter table notification_pref enable row level security;
alter table notification_pref force row level security;

-- Policies are configuration: readable by any app user, like routing_rule.
drop policy if exists sla_policy_select on sla_policy;
create policy sla_policy_select on sla_policy for select to freshnow_app using (true);
drop policy if exists escalation_policy_select on escalation_policy;
create policy escalation_policy_select on escalation_policy for select to freshnow_app using (true);
drop policy if exists escalation_level_select on escalation_level;
create policy escalation_level_select on escalation_level for select to freshnow_app using (true);
drop policy if exists escalation_target_select on escalation_target;
create policy escalation_target_select on escalation_target for select to freshnow_app using (true);

drop policy if exists alert_select on alert;
create policy alert_select on alert for select to freshnow_app
  using (app_is_ceo() or app_can_view_employee(employee_id));

drop policy if exists task_watcher_select on task_watcher;
create policy task_watcher_select on task_watcher for select to freshnow_app
  using (employee_id = app_current_employee()
      or task_id in (select id from task where app_can_view_employee(employee_id)));

drop policy if exists notification_pref_select on notification_pref;
create policy notification_pref_select on notification_pref for select to freshnow_app
  using (employee_id = app_current_employee() or app_is_ceo());
