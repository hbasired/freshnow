-- migrations/0017_channels.sql — a channel is switched on in three places, not one.
--
-- 0011 made the outbox channel-aware and said email and web push would later be "a new
-- sender and a row". That is true of DELIVERY. What it left out is CONTROL: today a channel
-- is on if an environment variable says so, which is a developer's decision made in a file
-- the company cannot see. This migration adds the two things that were missing:
--
--   1. `channel_setting` — the COMPANY's switch, flipped by the CEO in the dashboard and
--      audited. A channel now needs BOTH its keys (env) AND this row to be true before a
--      single message is queued. `notification_pref` remains the third gate, the person's
--      own. Available → enabled → preferred; all three, or nothing is sent.
--
--   2. `push_subscription` — where a browser's push endpoint lives. One row per device, not
--      per person: somebody with a phone and a desktop has two, and a device that stops
--      answering (410 Gone) is deleted rather than retried forever.
--
-- Everything ships OFF except telegram and inapp, which are what runs today. Turning a
-- channel on is a deliberate act by a named person, recorded in audit_log.

-- ── The company's switch ──────────────────────────────────────────────────────
create table if not exists channel_setting (
  channel    text primary key check (channel in ('telegram', 'inapp', 'email', 'webpush', 'chat')),
  enabled    boolean not null default false,
  -- Who flipped it. Null for the seeded defaults, which nobody chose.
  updated_by uuid references employee (id) on delete set null,
  updated_at timestamptz not null default now()
);

-- The state on the day this migration runs: Telegram is the live channel, the in-app inbox
-- is always on (the row IS the notification — there is nothing to switch off), and the three
-- new channels are dark until somebody turns them on.
insert into channel_setting (channel, enabled) values
  ('telegram', true),
  ('inapp',    true),
  ('email',    false),
  ('webpush',  false),
  ('chat',     false)
on conflict (channel) do nothing;

-- ── 'chat' joins the channel vocabulary ───────────────────────────────────────
-- 0011 is applied and must never be edited, so the CHECK is replaced rather than altered.
alter table notification_outbox drop constraint if exists notification_outbox_channel_check;
alter table notification_outbox add constraint notification_outbox_channel_check
  check (channel in ('telegram', 'inapp', 'email', 'webpush', 'chat'));

-- A person cannot hold a preference for 'inapp' (it is not optional) but can for 'chat'.
alter table notification_pref drop constraint if exists notification_pref_channel_check;
alter table notification_pref add constraint notification_pref_channel_check
  check (channel in ('telegram', 'email', 'webpush', 'chat'));

-- ── Where a browser's push endpoint lives ─────────────────────────────────────
create table if not exists push_subscription (
  id           uuid primary key default gen_random_uuid(),
  employee_id  uuid not null references employee (id) on delete cascade,
  -- The push service's URL for this device. Unique because re-subscribing the same browser
  -- returns the same endpoint, and two rows would mean two identical notifications.
  endpoint     text not null unique,
  -- The device's public key and auth secret (RFC 8291). The payload is encrypted to these,
  -- which is why the relay in the middle — Google, Apple, Mozilla — can only see ciphertext.
  p256dh       text not null,
  auth         text not null,
  -- For the person's own "which devices am I subscribed on?" list. Never parsed.
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz,
  is_synthetic boolean not null default false
);

create index if not exists idx_push_subscription_employee on push_subscription (employee_id);

-- ── An address to send email to ───────────────────────────────────────────────
-- Deliberately absent until now: docs/EMAIL-SETUP-GUIDE.md §4 requires the consent notice to
-- name email before an address is stored. The column exists so the channel can be built; the
-- notice is the company's to update before anybody fills it in.
alter table employee add column if not exists email text;
create unique index if not exists employee_email_key on employee (lower(email)) where email is not null;

-- ── Row security ──────────────────────────────────────────────────────────────
alter table channel_setting   enable row level security;
alter table channel_setting   force  row level security;
alter table push_subscription enable row level security;
alter table push_subscription force  row level security;

-- Everyone may READ which channels are on: the dashboard explains to each person why an
-- option is or is not offered, and that explanation would be a lie if the row were hidden.
-- Writing is the CEO's, enforced in the API (core writes run as the service role).
drop policy if exists channel_setting_select on channel_setting;
create policy channel_setting_select on channel_setting for select to freshnow_app
  using (true);

-- A push subscription is a device fingerprint. Own rows only — not even a manager's, and
-- deliberately not the CEO's either: knowing which devices somebody has is not an
-- operational need, and CLAUDE.md forbids building surveillance into this system.
drop policy if exists push_subscription_own on push_subscription;
create policy push_subscription_own on push_subscription for select to freshnow_app
  using (employee_id = app_current_employee());

-- Privileges for tables created after 0005's blanket grant.
grant select, insert, update, delete on channel_setting, push_subscription to freshnow_app;
