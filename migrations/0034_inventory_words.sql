-- migrations/0034_inventory_words.sql — the words on stock records follow the person's other words (TASK-060)
--
-- 0032 made a stock document's content unchangeable, its notes included. But a note is a person's own
-- words, and the privacy notice says those are removed after the retention window and when a person is
-- erased — the stock records stay as the company's record, the words do not (consent.ts, retention.ts).
-- So the words, and only the words, may now be overwritten — and only with a redaction marker:
--   '[erased]'                       eraseEmployee
--   '[redacted — …]'                 the retention sweep
-- A note written later (the receiver's answer, the approver's settlement, the count decision) is set
-- once, then only redacted. Everything else stays as 0032 left it: content never changes, states only
-- move forward, nothing is deleted outside a purge.

create or replace function inv_is_redaction(v text) returns boolean
  language sql immutable
  as $fn$ select v = '[erased]' or v like '[redacted%' $fn$;

create or replace function stock_doc_guard() returns trigger
  language plpgsql
  set search_path = public
as $fn$
begin
  if tg_op = 'DELETE' then
    if not inv_purging() then
      raise exception 'stock documents are never deleted: post a reversal instead' using errcode = 'P0001';
    end if;
    return old;
  end if;
  if (new.id, new.kind, new.from_location_id, new.to_location_id, new.created_by, new.confirm_side, new.confirm_by,
      new.reason, new.supplier, new.invoice_no, new.machine_id, new.reverses_doc_id, new.count_session_id,
      new.device_at, new.recorded_at, new.request_hash, new.is_synthetic, new.correlation_id)
     is distinct from
     (old.id, old.kind, old.from_location_id, old.to_location_id, old.created_by, old.confirm_side, old.confirm_by,
      old.reason, old.supplier, old.invoice_no, old.machine_id, old.reverses_doc_id, old.count_session_id,
      old.device_at, old.recorded_at, old.request_hash, old.is_synthetic, old.correlation_id) then
    raise exception 'a stock document''s content is never changed: post a reversal instead' using errcode = 'P0001';
  end if;
  -- The words: the creator's note only redacted; the answer and settlement notes set once, then only redacted.
  if (new.note is distinct from old.note and not inv_is_redaction(new.note))
     or (new.answer_note is distinct from old.answer_note and old.answer_note is not null and not inv_is_redaction(new.answer_note))
     or (new.settle_note is distinct from old.settle_note and old.settle_note is not null and not inv_is_redaction(new.settle_note)) then
    raise exception 'the words on a stock document are only ever removed, never rewritten' using errcode = 'P0001';
  end if;
  if new.state is distinct from old.state and not (
       (old.state = 'waiting' and new.state in ('accepted', 'part_accepted', 'refused', 'cancelled'))
    or (old.state = 'part_accepted' and new.state = 'settled')
    or (old.state = 'posted' and new.state = 'reversed' and old.kind <> 'reversal')) then
    raise exception 'a stock document cannot go from % to %', old.state, new.state using errcode = 'P0001';
  end if;
  if (old.answered_by is not null and new.answered_by is distinct from old.answered_by)
     or (old.answered_at is not null and new.answered_at is distinct from old.answered_at)
     or (old.settled_by is not null and new.settled_by is distinct from old.settled_by)
     or (old.settled_at is not null and new.settled_at is distinct from old.settled_at) then
    raise exception 'who answered or settled a stock document is never changed' using errcode = 'P0001';
  end if;
  return new;
end;
$fn$;

create or replace function count_session_guard() returns trigger
  language plpgsql
  set search_path = public
as $fn$
begin
  if tg_op = 'DELETE' then
    if not inv_purging() then
      raise exception 'counts are never deleted' using errcode = 'P0001';
    end if;
    return old;
  end if;
  if (new.id, new.location_id, new.kind, new.started_by, new.started_at, new.is_synthetic)
     is distinct from (old.id, old.location_id, old.kind, old.started_by, old.started_at, old.is_synthetic) then
    raise exception 'who counted what, and when, is never changed' using errcode = 'P0001';
  end if;
  if (new.decision_note is distinct from old.decision_note and old.decision_note is not null and not inv_is_redaction(new.decision_note))
     or (new.recount_waived_reason is distinct from old.recount_waived_reason and old.recount_waived_reason is not null
         and not inv_is_redaction(new.recount_waived_reason)) then
    raise exception 'the words on a count are only ever removed, never rewritten' using errcode = 'P0001';
  end if;
  if new.state is distinct from old.state and not (
       (old.state = 'counting' and new.state in ('recount', 'approval', 'closed', 'cancelled'))
    or (old.state = 'recount' and new.state in ('approval', 'cancelled'))
    or (old.state = 'approval' and new.state = 'closed')) then
    raise exception 'a count cannot go from % to %', old.state, new.state using errcode = 'P0001';
  end if;
  return new;
end;
$fn$;
