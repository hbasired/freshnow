-- migrations/0038_analytics_store.sql — the analytics store: every machine's sales per day and hour, built from the mirror (TASK-071)
--
-- The user (19 Oct): "The data needs to be stored as well because we can find the patterns and increase sales and revenue" and
-- "data collection should take place from the system side as well and stored for future learning and model building" (R0.2, R15.3).
-- The mirror (tv_vend) holds every sale; this store holds what the analysis, the forecasts and the patterns need, per machine
-- record and Dubai day, small enough to keep for good (no personal data: no card ids, no people).
--
--   analytics_run   one build of one day: what it read (the input), what it wrote, and whether its total equals Televend's own count
--   sales_day       per Televend machine record and Dubai day: cups by payment, first and last sale, and the machine's name and
--                   Televend region AT THE TIME (each sale carries them) — a machine that moved is counted where it stood (G160)
--   sales_hour      the same, per hour of the Dubai day (demand by hour, TASK-079)
--   tv_day_total    Televend's own count of the whole fleet's sales per day — for the months before Televend's sales list begins
--                   (measured 20 Oct: itemised sales from late March 2026; daily totals further back)
--
-- A day is built only when the sync read it to its end and its count equalled Televend's own (tv_sync_run.complete, the daily check
-- or a backfill). Building a day again replaces its rows in one transaction and leaves the earlier run in analytics_run, so every
-- figure can be traced to the run — and the run to the sales it read — and re-run to the same answer (CLAUDE.md rule 3).
--
-- ── WHO ───────────────────────────────────────────────────────────────────
-- Read with televend.read (CEO, Admin, Ops Head, Supervisor), like the mirror. Written only by the worker on the service role.

create table if not exists analytics_run (
  id             uuid primary key default gen_random_uuid(),
  kind           text not null check (kind in ('sales_day')),
  day            date not null,
  -- What the build read: the sales of the day in the mirror, and the newest of them by the time they were stored.
  vends_read     integer not null check (vends_read >= 0),
  input_synced_through timestamptz,
  -- What it wrote.
  cups           integer not null check (cups >= 0),
  machines       integer not null check (machines >= 0),
  -- Televend's own count of the day's sales (from the run that completed it) and whether the store's total equals it.
  televend_count integer,
  agrees         boolean,
  status         text not null check (status in ('ok', 'failed')),
  error          text,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  is_synthetic   boolean not null default false,
  correlation_id uuid
);
create index if not exists idx_analytics_run_day on analytics_run (kind, day, started_at desc);

create table if not exists sales_day (
  day              date not null,
  machine_tv_id    bigint not null,
  -- As Televend named the machine and its region at the day's last sale (each sale carries both).
  machine_caption  text,
  location_caption text,
  cups             integer not null check (cups >= 0),
  cash_cups        integer not null check (cash_cups >= 0),
  cashless_cups    integer not null check (cashless_cups >= 0),
  cashless3_cups   integer not null check (cashless3_cups >= 0),
  token_cups       integer not null check (token_cups >= 0),
  wallet_cups      integer not null check (wallet_cups >= 0),
  other_cups       integer not null check (other_cups >= 0),
  first_sale_at    timestamptz not null,
  last_sale_at     timestamptz not null,
  run_id           uuid not null references analytics_run (id),
  is_synthetic     boolean not null default false,
  primary key (day, machine_tv_id),
  check (cups = cash_cups + cashless_cups + cashless3_cups + token_cups + wallet_cups + other_cups)
);
create index if not exists idx_sales_day_machine on sales_day (machine_tv_id, day);

create table if not exists sales_hour (
  day           date not null,
  machine_tv_id bigint not null,
  hour          smallint not null check (hour between 0 and 23),
  cups          integer not null check (cups > 0),
  run_id        uuid not null references analytics_run (id),
  is_synthetic  boolean not null default false,
  primary key (day, machine_tv_id, hour)
);

create table if not exists tv_day_total (
  day          date primary key,
  -- Televend's own count of sale vends that day across the fleet (vends/aggregates), and its quantity.
  vends        integer not null check (vends >= 0),
  quantity     integer,
  fetched_at   timestamptz not null default now(),
  is_synthetic boolean not null default false,
  correlation_id uuid
);

-- ── Row security: read only, for whoever reads Televend's data ─────────────
do $$
declare
  t text;
begin
  foreach t in array array['analytics_run', 'sales_day', 'sales_hour', 'tv_day_total']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists %I on %I', t || '_select', t);
    execute format('create policy %I on %I for select to freshnow_app using ((select app_has_capability(''televend.read'')))', t || '_select', t);
    -- 0005's default privileges hand every new table insert/update/delete too; the store is written by the worker only.
    execute format('revoke insert, update, delete, truncate on %I from freshnow_app', t);
    execute format('grant select on %I to freshnow_app', t);
  end loop;
end $$;
