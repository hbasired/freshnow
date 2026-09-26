-- migrations/0002_bot_session.sql — durable conversation state for the Telegram bot.
--
-- Why: grammY's default session storage is in-memory, so every process restart wiped
-- every half-finished conversation. In practice a worker would tap "I have an invite
-- code", the bot would ask for it, the process would restart, and their reply fell
-- through to "Tap /start" — the invite and registration flows appeared broken.
-- Storing the step in Postgres makes the flows survive restarts and deploys.
--
-- Not employee data: this holds only "which question comes next" for a chat, so it is
-- safe to drop. The employee's actual answers are written to their own tables as they
-- arrive (write-first), never left sitting in session state.

create table if not exists bot_session (
  key        text primary key,          -- grammY session key (chat/user scoped)
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- Only the service role touches this; the bot runs as the worker/service identity.
alter table bot_session enable row level security;
alter table bot_session force row level security;
