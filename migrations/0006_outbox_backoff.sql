-- migrations/0006_outbox_backoff.sql — give the outbox relay a real backoff.
--
-- The relay claims the oldest `limit N` pending rows each poll. A row that keeps failing
-- stays pending and keeps being re-claimed, so N permanently-failing rows fill every
-- batch and NOTHING ELSE IS EVER DELIVERED — head-of-line blocking that takes out all
-- outbound messaging while the relay hammers the same rows every 3 seconds.
--
-- Telegram 429s made this worse: the code deliberately never abandons a rate-limited row
-- (correct), and captured `retry_after` from the API (correct) — but had nowhere to put
-- it, so it retried immediately and forever.
--
-- `next_attempt_at` is that place. The relay now skips rows that are not due, so a
-- failing row waits its turn instead of starving every other message.

alter table notification_outbox
  add column if not exists next_attempt_at timestamptz not null default now();

-- The relay's claim query filters on (status, next_attempt_at) and orders by created_at.
create index if not exists idx_outbox_due
  on notification_outbox (next_attempt_at, created_at)
  where status = 'pending';
