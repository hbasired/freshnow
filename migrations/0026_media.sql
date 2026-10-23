-- migrations/0026_media.sql — photos and short videos (TASK-058).
--
-- The files live in Supabase Storage (one private bucket, "media"); these tables are the record of
-- them: what each file is, who sent it, until when it is kept, and what it belongs to. The API is
-- the only way in or out — every read is checked here, under row-level security, before the bytes
-- are fetched from Storage. Files are named by the sha256 of their CLEANED bytes (media-process.ts):
-- the same picture sent twice is stored once.
--
--   media_object   one cleaned file: kind, size, dimensions or duration, where it lives, who sent it,
--                  its retention class and the date it is due to go, and what was removed from it.
--   media_link     what a file belongs to (a task today; visits, cash collections and chat later).
--
-- Personal data: who sent a file. The pictures are meant to show machines, stock and receipts —
-- not people — and phone metadata (location, device) is removed before anything is stored.

create table if not exists media_object (
  id               uuid primary key default gen_random_uuid(),
  sha256           text not null unique check (sha256 ~ '^[0-9a-f]{64}$'),
  kind             text not null check (kind in ('photo', 'video')),
  mime             text not null check (mime in ('image/jpeg', 'video/mp4')),
  bytes            integer not null check (bytes > 0),
  width            integer,
  height           integer,
  duration_ms      integer,
  storage_path     text not null unique,
  thumb_path       text unique,
  uploaded_by      uuid references employee (id),
  -- When the phone says it was taken (the app sends it; never read from the file's metadata).
  captured_at      timestamptz,
  uploaded_at      timestamptz not null default now(),
  retention_class  text not null check (retention_class in ('evidence', 'video', 'receipt', 'chat')),
  retention_until  timestamptz not null,
  -- Whether a virus scanner looked at it (ClamAV, when configured — antivirus.ts).
  scan_status      text not null check (scan_status in ('clean', 'not_scanned')),
  -- What was taken out: {"exif": true} for a photo, {"mp4_boxes": ["/moov/udta", …]} for a video.
  stripped         jsonb not null default '{}'::jsonb,
  is_synthetic     boolean not null default false,
  correlation_id   uuid
);
create index if not exists idx_media_object_uploader on media_object (uploaded_by, uploaded_at desc);
create index if not exists idx_media_object_retention on media_object (retention_until);

create table if not exists media_link (
  id             uuid primary key default gen_random_uuid(),
  media_id       uuid not null references media_object (id) on delete cascade,
  entity_type    text not null check (entity_type in ('task')),
  entity_id      uuid not null,
  -- Why it is attached: evidence of the work, a receipt, …
  role           text not null default 'evidence' check (role in ('evidence', 'receipt', 'other')),
  linked_by      uuid references employee (id),
  linked_at      timestamptz not null default now(),
  is_synthetic   boolean not null default false,
  correlation_id uuid,
  unique (media_id, entity_type, entity_id, role)
);
create index if not exists idx_media_link_entity on media_link (entity_type, entity_id);

-- ── Row security ──────────────────────────────────────────────────────────────
-- A file is seen by whoever may see the person who sent it (themselves, the people who lead them,
-- the CEO and Admin — app_can_view_employee, 0025). Writes go through core on the service role.
alter table media_object enable row level security;
alter table media_object force row level security;
alter table media_link enable row level security;
alter table media_link force row level security;

drop policy if exists media_object_select on media_object;
create policy media_object_select on media_object for select to freshnow_app
  using ((select app_reads_all()) or app_can_view_employee(uploaded_by));

-- A link is seen when its file is (the subquery runs under the same policies).
drop policy if exists media_link_select on media_link;
create policy media_link_select on media_link for select to freshnow_app
  using (exists (select 1 from media_object m where m.id = media_id));

grant select on media_object, media_link to freshnow_app;
