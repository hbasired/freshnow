-- migrations/0023_televend_mirror.sql — a local, read-only mirror of Televend (TASK-056).
--
-- TASK-055 made Televend readable without any way to write to it. This migration gives what is
-- read a home in Postgres, so the Operations portal, the reconciliation rules and the app work
-- from OUR database — fast, joinable with stock and cash, and still there when Televend is down.
--
--   tv_machine            Televend's machines, as last seen (updated every sync).
--   tv_machine_caption    every name a machine has had — names change (9 of 87 in two days, G150).
--   machine               OUR physical machine: the asset number staff use ("Mina 793"), a QR token
--                         for the sticker that proves a visit, and nothing Televend owns.
--   machine_placement     which Televend machine record a physical machine is, over time.
--   tv_vend / tv_event / tv_refill   what happened, one row per Televend record.
--   tv_sync_run           every sync and backfill run: window, requests, rows, complete or not.
--   tv_sync_cursor        how far each stream has been read completely.
--
-- Rules carried from the connector (D180–D183):
--   * Natural unique keys + ON CONFLICT: re-reading a window inserts nothing twice.
--   * Every row keeps Televend's own JSON (`raw`) so a normalisation can be replayed later.
--   * Nothing here is ever written back to Televend; these are copies.
--
-- Personal data: tv_refill.filled_by (who filled a machine) and names inside `raw` (who filled,
-- who resolved an alarm). Readable by the CEO only until TASK-057 adds the operations roles.
-- Retention and erasure of these names arrive with the people mapping (A-T56.2).

create table if not exists tv_machine (
  televend_id          bigint primary key,
  caption              text not null,
  -- The 3–4 digit number in the name that staff use and that survives renames.
  asset_no             integer,
  enabled              boolean not null,
  pid                  text,
  external_id          text,
  location_id          bigint,
  location_caption     text,
  city                 text,
  region_caption       text,
  machine_type_caption text,
  stock_tracking       boolean,
  last_vend_at         timestamptz,
  last_refill_at       timestamptz,
  -- Televend's own stock level for the machine, percent of capacity.
  stock_percent        numeric(6,2),
  last_status          integer,
  connection_status    integer,
  signal_strength      integer,
  raw                  jsonb not null,
  first_seen_at        timestamptz not null default now(),
  last_seen_at         timestamptz not null default now(),
  is_synthetic         boolean not null default false
);
create index if not exists idx_tv_machine_asset on tv_machine (asset_no);

create table if not exists tv_machine_caption (
  televend_id    bigint not null references tv_machine(televend_id) on delete cascade,
  caption        text not null,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  primary key (televend_id, caption)
);

create table if not exists machine (
  id           uuid primary key default gen_random_uuid(),
  asset_no     integer unique,
  -- What people call it today; follows the current Televend name until someone sets it by hand.
  label        text not null,
  label_manual boolean not null default false,
  model        text,
  serial_no    text,
  -- Printed as a QR sticker on the machine (TASK-065): scanning it is how a visit starts.
  qr_token     uuid not null unique default gen_random_uuid(),
  status       text not null default 'active' check (status in ('active', 'inactive', 'retired')),
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  is_synthetic boolean not null default false
);

create table if not exists machine_placement (
  id                    uuid primary key default gen_random_uuid(),
  machine_id            uuid not null references machine(id) on delete cascade,
  tv_machine_id         bigint not null references tv_machine(televend_id),
  valid_from            timestamptz not null default now(),
  -- NULL = this is where the machine is now.
  valid_to              timestamptz,
  source                text not null check (source in ('televend_sync', 'manual')),
  created_at            timestamptz not null default now(),
  is_synthetic          boolean not null default false,
  check (valid_to is null or valid_to > valid_from)
);
-- A Televend machine record is one physical machine at a time.
create unique index if not exists machine_placement_one_open on machine_placement (tv_machine_id) where valid_to is null;
create index if not exists idx_machine_placement_machine on machine_placement (machine_id);

create table if not exists tv_vend (
  -- Which transport read it, and Televend's id in that transport (vend_id on the bridge).
  source           text not null check (source in ('bridge', 'official')),
  external_id      text not null,
  machine_tv_id    bigint not null,
  at               timestamptz not null,
  product          text,
  payment_type     integer not null,
  payment_caption  text,
  -- AED; NULL when the Televend account may not see vend values (VF56).
  value            numeric(10,2),
  column_no        integer,
  quantity         integer not null,
  price_list       integer,
  -- The telemetry box's own vend number — the key to recognise one vend across transports.
  device_vend_id   bigint,
  raw              jsonb not null,
  synced_at        timestamptz not null default now(),
  is_synthetic     boolean not null default false,
  primary key (source, external_id)
);
create index if not exists idx_tv_vend_machine_at on tv_vend (machine_tv_id, at);
create index if not exists idx_tv_vend_at_brin on tv_vend using brin (at);

create table if not exists tv_event (
  source         text not null check (source in ('bridge', 'official')),
  external_id    text not null,
  machine_tv_id  bigint,
  -- 3 = alarm, 2 = warning, 1 = info (VF58); kept numeric, named in `kind`.
  level          integer,
  kind           text not null check (kind in ('alarm', 'warning', 'info', 'unknown')),
  type_code      text,
  source_code    text,
  name           text,
  description    text,
  started_at     timestamptz not null,
  -- Filled in on a later sync when Televend resolves it (events are upserted, not frozen).
  resolved_at    timestamptz,
  counter        integer,
  raw            jsonb not null,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  is_synthetic   boolean not null default false,
  primary key (source, external_id)
);
create index if not exists idx_tv_event_machine_started on tv_event (machine_tv_id, started_at);
create index if not exists idx_tv_event_started_brin on tv_event using brin (started_at);
create index if not exists idx_tv_event_open_alarms on tv_event (started_at) where kind = 'alarm' and resolved_at is null;

create table if not exists tv_refill (
  id               uuid primary key default gen_random_uuid(),
  source           text not null check (source in ('bridge', 'official', 'file')),
  -- Televend's refill log has no id: this key is built from the machine, the exact time, the
  -- action and the quantity (refill.ts `refillKey`), so re-reading a day inserts nothing new.
  natural_key      text not null unique,
  machine_tv_id    bigint,
  machine_caption  text,
  at               timestamptz not null,
  -- "First Last" as Televend shows it. Personal data (see header).
  filled_by        text,
  role             text,
  column_no        integer,
  product          text,
  action           text not null check (action in ('filled', 'corrected', 'removed', 'unknown')),
  quantity_change  numeric(10,2) not null,
  quantity_after   numeric(10,2),
  capacity         numeric(10,2),
  origin           text not null check (origin in ('mobile_app', 'web_app', 'televend', 'unknown')),
  raw              jsonb not null,
  synced_at        timestamptz not null default now(),
  is_synthetic     boolean not null default false
);
create index if not exists idx_tv_refill_machine_at on tv_refill (machine_tv_id, at);
create index if not exists idx_tv_refill_at on tv_refill (at);

create table if not exists tv_sync_run (
  id             uuid primary key default gen_random_uuid(),
  stream         text not null check (stream in ('machines', 'vends', 'events', 'refills')),
  mode           text not null check (mode in ('incremental', 'daily_check', 'backfill')),
  transport      text not null check (transport in ('bridge', 'official', 'files')),
  window_from    timestamptz,
  window_to      timestamptz,
  requests       integer not null default 0,
  rows_read      integer not null default 0,
  rows_new       integer not null default 0,
  rows_changed   integer not null default 0,
  -- TRUE only when the read was complete AND, for a whole day of vends, equalled Televend's own
  -- count for that day. A run that is not complete is never used to say "nothing happened".
  complete       boolean not null default false,
  televend_count integer,
  status         text not null check (status in ('ok', 'partial', 'error')),
  error          text,
  correlation_id uuid,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz
);
create index if not exists idx_tv_sync_run_stream on tv_sync_run (stream, started_at desc);

create table if not exists tv_sync_cursor (
  stream      text primary key check (stream in ('vends', 'events', 'refills')),
  -- Everything before this instant has been read completely at least once.
  read_until  timestamptz not null,
  updated_at  timestamptz not null default now()
);

-- ── Row security ──────────────────────────────────────────────────────────────
-- Operations data. The CEO reads it now; TASK-057 widens it to the operations roles through the
-- capability helpers. Writes go through core on the service role (D70); the app role only reads.
do $$
declare t text;
begin
  foreach t in array array['tv_machine', 'tv_machine_caption', 'machine', 'machine_placement', 'tv_vend',
                           'tv_event', 'tv_refill', 'tv_sync_run', 'tv_sync_cursor']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists %I on %I', t || '_select', t);
    execute format('create policy %I on %I for select to freshnow_app using (app_is_ceo())', t || '_select', t);
    execute format('grant select on %I to freshnow_app', t);
  end loop;
end $$;
