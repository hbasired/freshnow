-- migrations/0004_attachment.sql — files attached to assignments and reports.
--
-- We store Telegram's `file_id` and the file's METADATA, never the bytes. Telegram
-- accepts a file_id in place of an upload, so forwarding a spec sheet to the assignee
-- is a reference pass, not a download-and-re-upload. That keeps the demo box free of
-- employee documents entirely, which is also the better PDPL position: the minimum
-- necessary is the reference, not the content.
--
-- A file_id is scoped to the bot, so it stays usable across restarts; it is not a
-- durable archive, which is why `file_unique_id` is kept for de-duplication and why
-- production must decide a retention/mirroring policy before this is the record.

create table if not exists attachment (
  id             uuid primary key default gen_random_uuid(),

  -- What it is attached to. Exactly one of these is set in practice, but the table
  -- deliberately allows a file to arrive before we know (a document sent with no
  -- caption is held until the next message says what it is for).
  assignment_id  uuid references assignment(id),
  task_id        uuid references task(id),
  task_update_id uuid references task_update(id),

  uploaded_by    uuid not null references employee(id),

  file_id        text not null,   -- Telegram handle; re-sendable by the same bot
  file_unique_id text,            -- stable across bots; used to spot the same file twice
  file_name      text,
  mime_type      text,
  file_size      int,
  kind           text not null default 'document'
                   check (kind in ('document','photo','voice','video','audio')),
  caption        text,

  created_at     timestamptz not null default now(),
  is_synthetic   boolean not null default false
);

create index if not exists idx_attachment_assignment on attachment(assignment_id);
create index if not exists idx_attachment_task       on attachment(task_id);
create index if not exists idx_attachment_update     on attachment(task_update_id);

alter table attachment enable row level security;
alter table attachment force row level security;

-- The CEO sees every attachment. Everyone else sees what they uploaded and what is
-- attached to work that is theirs — so an assignee can open the spec sheet they were
-- sent, but cannot enumerate another department's files.
drop policy if exists attachment_read on attachment;
create policy attachment_read on attachment for select
  using (
    app_is_ceo()
    or uploaded_by = app_current_employee()
    or task_id in (select id from task where employee_id = app_current_employee())
    or assignment_id in (select id from assignment where assigned_to = app_current_employee())
  );
