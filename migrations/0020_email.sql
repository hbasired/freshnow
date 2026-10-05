-- migrations/0020_email.sql — email in and out, recorded (TASK-053).
--
-- Email already went OUT (worker/email-sender.ts) but left no record of WHICH message carried
-- which task, so a reply could not be tied back to its job; and email IN (the Cloudflare route)
-- kept only an audit line with the subject and a length — the words and the proposed tasks
-- were never stored, so the CEO had nothing to confirm. Two tables fix both:
--
--   email_message   every email we sent or received, one row each. Unique on
--                   (direction, message_id): polling a mailbox twice, or a provider redelivering,
--                   can never produce two task updates from one email (CLAUDE.md idempotency).
--   email_proposal  tasks read out of an email from someone who may give work. A PROPOSAL —
--                   nothing is assigned until a person taps Apply, the same rule as a PDF.

create table if not exists email_message (
  id              uuid primary key default gen_random_uuid(),
  direction       text not null check (direction in ('in', 'out')),
  -- RFC 5322 Message-ID without angle brackets. Ours are minted by the worker; theirs come
  -- from the sender's mail server.
  message_id      text not null check (length(message_id) between 3 and 998),
  in_reply_to     text,
  thread_refs     text[] not null default '{}',
  from_address    text not null,
  to_address      text not null,
  subject         text,
  -- Inbound only: what the person wrote, with the quoted history removed. Aged by the retention
  -- sweep and cleared by erasure, like task_update.note_raw. Outbound bodies are not stored —
  -- they are the outbox payload, already kept there.
  body_text       text,
  -- The person on OUR side: the sender of an inbound message, the recipient of an outbound one.
  -- NULL for a refused stranger (their address is in from_address; that is all we keep).
  employee_id     uuid references employee(id),
  task_id         uuid references task(id),
  assignment_id   uuid references assignment(id),
  task_update_id  uuid references task_update(id),
  -- The notification_outbox row an outbound email delivered. NO foreign key, on purpose: the
  -- relay holds FOR UPDATE on that row while the email is sent, and an FK check from this insert
  -- needs a KEY SHARE lock on the same row — the send would wait on itself for ever (found by
  -- the end-to-end run in TASK-053). The join still works; it is just not enforced.
  outbox_id       uuid,
  status          text not null check (status in ('sent', 'failed', 'received', 'processed', 'refused', 'ignored')),
  -- Why it was refused or ignored, in plain words; or what it became when processed.
  reason          text,
  -- Inbound: how many times reading it has been tried. A model outage leaves an email
  -- 'received'; the retry job tries again, at most a few times (CLAUDE.md rule 4).
  attempts        smallint not null default 0 check (attempts between 0 and 20),
  -- The receiving server's verdicts as read (spf / dkim / dmarc / how the sender was proven).
  auth            jsonb,
  correlation_id  uuid,
  -- The message's own Date header, when it had one.
  sent_at         timestamptz,
  created_at      timestamptz not null default now(),
  is_synthetic    boolean not null default false
);

create unique index if not exists email_message_direction_message_id on email_message (direction, message_id);
create index if not exists idx_email_message_employee on email_message (employee_id, created_at desc);
create index if not exists idx_email_message_task on email_message (task_id) where task_id is not null;
create index if not exists idx_email_message_created on email_message (created_at desc);

create table if not exists email_proposal (
  id               uuid primary key default gen_random_uuid(),
  email_message_id uuid not null references email_message(id),
  proposed_by      uuid not null references employee(id),
  summary          text,
  -- [{title, detail, assigneeId, assigneeName, namedAs, matchedBy, candidates:[{id,name}]}] —
  -- the plan exactly as the CEO is shown it, owners already checked by name (people-match.ts).
  tasks            jsonb not null check (jsonb_typeof(tasks) = 'array'),
  status           text not null default 'pending' check (status in ('pending', 'applied', 'dismissed')),
  decided_by       uuid references employee(id),
  decided_at       timestamptz,
  created_at       timestamptz not null default now(),
  is_synthetic     boolean not null default false,
  -- A decided proposal says who decided and when; a pending one has neither.
  check ((status = 'pending') = (decided_at is null))
);

create unique index if not exists email_proposal_one_per_message on email_proposal (email_message_id);
create index if not exists idx_email_proposal_pending on email_proposal (created_at desc) where status = 'pending';

-- ── Row security ──────────────────────────────────────────────────────────────
alter table email_message  enable row level security;
alter table email_message  force  row level security;
alter table email_proposal enable row level security;
alter table email_proposal force  row level security;

-- An email is about one person on our side; whoever may see that person may see it. A refused
-- stranger's message (employee_id NULL) is the CEO's alone.
drop policy if exists email_message_select on email_message;
create policy email_message_select on email_message for select to freshnow_app
  using (app_is_ceo() or app_can_view_employee(employee_id));

-- A proposal is the proposer's and the CEO's.
drop policy if exists email_proposal_select on email_proposal;
create policy email_proposal_select on email_proposal for select to freshnow_app
  using (app_is_ceo() or proposed_by = app_current_employee());

-- Writes go through core as the service role; the app role reads.
grant select on email_message, email_proposal to freshnow_app;
