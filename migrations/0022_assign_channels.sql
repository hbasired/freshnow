-- migrations/0022_assign_channels.sql — who chose how a person is told, and where work came from (TASK-054).
--
-- Three questions the database could not answer before:
--
--   1. "How was Hemanth told about FN-57?" — an assignment now records the channels the person
--      giving the work CHOSE (Telegram, the app, email). NULL means nobody chose: the assignee's
--      own notification rules applied, exactly as before. What was actually queued is still the
--      outbox rows; this column is the intent, so a skipped channel ("Telegram — not linked") can
--      be explained afterwards instead of guessed.
--   2. "Did this come from the dashboard, a Telegram message, a document or an email?" —
--      assignment.origin. NULL on rows written before this migration: unknown, never back-filled
--      with a guess.
--   3. "Which email created this task?" — task.source_email_id. When the CEO emails work in and
--      it is assigned, a reply-all from the employee to THAT email (not to our [FN-n] message)
--      can still find their task, and the task's provenance is a join, not a note.
--
-- Forward-only and additive: no existing row changes meaning.

alter table assignment add column if not exists notify_channels text[];
alter table assignment drop constraint if exists assignment_notify_channels_ck;
alter table assignment add constraint assignment_notify_channels_ck
  check (notify_channels is null
         or (cardinality(notify_channels) between 1 and 3
             and notify_channels <@ array['telegram', 'app', 'email']::text[]));

alter table assignment add column if not exists origin text;
alter table assignment drop constraint if exists assignment_origin_ck;
alter table assignment add constraint assignment_origin_ck
  check (origin is null or origin in ('dashboard', 'telegram', 'email', 'document'));

-- A foreign key is safe here, unlike email_message.outbox_id (D171): the task is inserted by the
-- inbound pipeline AFTER its email_message row is written and committed, and nothing holds that
-- row FOR UPDATE while it happens. Email rows are never deleted (retention ages their bodies), so
-- no ON DELETE rule is needed.
alter table task add column if not exists source_email_id uuid references email_message(id);
create index if not exists idx_task_source_email on task (source_email_id) where source_email_id is not null;

-- No new RLS policy: both tables already have row policies and the app role already has SELECT on
-- them, which covers new columns. Writes go through core as the service role.
