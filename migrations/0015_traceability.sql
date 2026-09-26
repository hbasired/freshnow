-- migrations/0015_traceability.sql — make the run actually traceable end to end.
--
-- CLAUDE.md rule 3 requires every run to be replayable and observable, with a
-- `correlation_id` linking every step. The audit of 2026-09-18 found the two most
-- consequential steps unlinked:
--
--   * `notification_outbox` — the message a person ACTUALLY RECEIVES had no correlation id,
--     so "the CEO got this alert; what produced it?" was unanswerable.
--   * `escalation` — likewise, so an escalation could not be tied to the run that caused it.
--
-- Both are nullable: existing rows predate this and there is no honest value to backfill
-- them with. A NULL here means "written before 2026-09-18", not "unknown provenance".

alter table notification_outbox add column if not exists correlation_id uuid;
alter table escalation          add column if not exists correlation_id uuid;

-- Following a run means selecting by correlation_id across tables, so both want an index.
create index if not exists idx_outbox_correlation on notification_outbox (correlation_id);
create index if not exists idx_escalation_correlation on escalation (correlation_id);

-- `run_trace` is the replay spine and is queried by correlation id on every replay; it had
-- no index at all because until now only the seeder ever wrote to it.
create index if not exists idx_run_trace_correlation on run_trace (correlation_id, created_at);

-- NO uniqueness on (correlation_id, step), deliberately.
--
-- The first version of this migration added one, on the reasoning that a run has each step
-- once and a retry should overwrite rather than appear twice. That is wrong: one run can
-- legitimately perform the same step for several entities — the seeder routes three
-- blockers under one correlation id, and a document that creates five assignments is the
-- same shape. The index made the second one fail.
--
-- Traces are therefore append-only, like the audit log. A retried step appears twice, which
-- is the honest record of what happened rather than a tidier fiction.
