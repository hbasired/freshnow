-- migrations/0035_cash.sql — every dirham, from the machine to the bank (TASK-061, first part)
--
-- Today a driver's cash lives in the "CASH COLLECTION" WhatsApp group: a photo per machine, a nightly
-- list ("790 − fuel 185 − cash test 10 − juice try 10 = 585"), the cash-deposit machine's receipt, and
-- hours later the auditor's "audit ok ✅" (VF73). Nothing checks a collection against what the machine
-- sold, nothing adds the list up, nothing knows who holds what. This is that record.
--
-- ── THE SAME RULES AS STOCK, ITS OWN TABLES ─────────────────────────────────
-- Cash is a ledger like stock (0032): documents, moves between accounts, a balance kept by a trigger in
-- the same transaction and never below zero for a person, moves never changed or deleted, mistakes
-- reversed. Its own tables, not stock's: the warehouse keeper sees all stock and must see no cash, and
-- money is whole fils (bigint), never a decimal.
--
--   machine:<m>  the machine's cash box — collections come from it; a "test" note goes back into it
--   person:<e>   what a person holds — never below zero
--   fuel, other  what was spent, with its receipt
--   cdm          paid into the cash-deposit machine, until the bank confirms it (not yet read)
--   bank, over_short   for the reconciliation (TASK-062)
--
-- ── SHIFTS ────────────────────────────────────────────────────────────────
-- A shift is the unit of accountability: its business date is the Dubai date it STARTED (a night shift
-- that ends at 07:30 belongs to the day before — Kiran's "14/10" list was posted on 15 Oct at 07:12).
-- Every cash document belongs to its person's open shift; the auditor checks a whole shift: ok, or a
-- question with a note. Nobody audits their own shift.
--
-- ── WHO ───────────────────────────────────────────────────────────────────
--   cash.hold   collects cash, pays expenses, deposits — accounts for every dirham   VMO, Supervisor, Ops Head, CEO, Admin
--   cash.read   sees everyone's cash                                                  Cash auditor, Ops Head, CEO, Admin
--   cash.audit  checks a shift: ok, or a question                                     Cash auditor, Ops Head, CEO, Admin
-- The warehouse keeper and the technician see no cash. Writes go through core on the service role.

-- ── 1. Who may do what (the SQL copy of permissions.ts) ──────────────────────
insert into role_capability (role, capability) values
  ('ceo', 'cash.hold'), ('ceo', 'cash.read'), ('ceo', 'cash.audit'),
  ('admin', 'cash.hold'), ('admin', 'cash.read'), ('admin', 'cash.audit'),
  ('ops_head', 'cash.hold'), ('ops_head', 'cash.read'), ('ops_head', 'cash.audit'),
  ('cash_auditor', 'cash.read'), ('cash_auditor', 'cash.audit'),
  ('supervisor', 'cash.hold'),
  ('vmo', 'cash.hold')
on conflict do nothing;

-- ── 2. Accounts ──────────────────────────────────────────────────────────────
create table if not exists cash_account (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null check (kind in ('person', 'machine', 'fuel', 'other', 'cdm', 'bank', 'over_short')),
  -- Null for a person's or a machine's account: their names are read from employee and machine.
  name         text check (name is null or length(btrim(name)) between 1 and 80),
  employee_id  uuid references employee (id),
  machine_id   uuid references machine (id),
  -- Only a person's account is real cash in a hand; the others are where cash came from or went.
  is_virtual   boolean generated always as (kind <> 'person') stored,
  created_at   timestamptz not null default now(),
  is_synthetic boolean not null default false,
  check ((kind = 'person') = (employee_id is not null)),
  check ((kind = 'machine') = (machine_id is not null)),
  check ((kind in ('person', 'machine')) = (name is null))
);
create unique index if not exists uq_cash_account_person on cash_account (employee_id) where kind = 'person';
create unique index if not exists uq_cash_account_machine on cash_account (machine_id) where kind = 'machine';

insert into cash_account (id, kind, name) values
  ('00000000-0000-0000-0000-00000000c001', 'fuel', 'Fuel'),
  ('00000000-0000-0000-0000-00000000c002', 'other', 'Other expenses'),
  ('00000000-0000-0000-0000-00000000c003', 'cdm', 'Deposited (cash-deposit machine)'),
  ('00000000-0000-0000-0000-00000000c004', 'bank', 'Bank'),
  ('00000000-0000-0000-0000-00000000c005', 'over_short', 'Over / short')
on conflict (id) do nothing;

-- ── 3. Shifts ────────────────────────────────────────────────────────────────
create table if not exists shift (
  -- Made by the phone or browser: a "start shift" tap sent twice opens one shift.
  id             uuid primary key,
  employee_id    uuid not null references employee (id),
  started_at     timestamptz not null default now(),
  -- The Dubai date the shift started: a night shift belongs to the day it began.
  business_date  date not null,
  state          text not null default 'open' check (state in ('open', 'closed')),
  ended_at       timestamptz,
  ended_by       uuid references employee (id),
  vehicle        text check (vehicle is null or length(btrim(vehicle)) between 1 and 40),
  -- The auditor's check of the whole shift; may move from "query" to "ok" once answered.
  audit_outcome  text check (audit_outcome is null or audit_outcome in ('ok', 'query')),
  audited_by     uuid references employee (id),
  audited_at     timestamptz,
  audit_note     text check (audit_note is null or length(audit_note) <= 500),
  -- The person's answer to the auditor's question, in their own words.
  answer_note    text check (answer_note is null or length(answer_note) <= 500),
  answered_at    timestamptz,
  is_synthetic   boolean not null default false,
  correlation_id uuid,
  check ((state = 'closed') = (ended_at is not null)),
  check (audited_by is null or audited_by <> employee_id),
  check ((audit_outcome is null) = (audited_by is null)),
  check ((answer_note is null) = (answered_at is null))
);
create unique index if not exists uq_shift_open on shift (employee_id) where state = 'open';
create index if not exists idx_shift_date on shift (business_date desc, employee_id);

-- ── 4. The ledger ────────────────────────────────────────────────────────────
create table if not exists cash_doc (
  -- Made by the phone or browser: the same request twice posts once (request_hash tells a repeat from
  -- a different request under the same id).
  id               uuid primary key,
  kind             text not null check (kind in ('collection', 'expense', 'test_vend', 'deposit', 'reversal')),
  state            text not null default 'posted' check (state in ('posted', 'reversed')),
  shift_id         uuid not null references shift (id),
  created_by       uuid not null references employee (id),
  -- A collection or a test note: which machine.
  machine_id       uuid references machine (id),
  -- What the person says: collected, spent, put back to test, deposited. A collection may be 0 (nothing in the box).
  amount_fils      bigint not null check (amount_fils >= 0 and amount_fils <= 100000000),
  expense_kind     text check (expense_kind is null or expense_kind in ('fuel', 'other')),
  litres           numeric(8, 2) check (litres is null or (litres > 0 and litres < 1000)),
  -- A deposit: as the cash-deposit machine's receipt prints it.
  cdm_txn_no       text check (cdm_txn_no is null or length(btrim(cdm_txn_no)) between 1 and 40),
  cdm_operator     text check (cdm_operator is null or length(btrim(cdm_operator)) between 1 and 60),
  cds_id           text check (cds_id is null or length(btrim(cds_id)) between 1 and 40),
  bag_no           text check (bag_no is null or length(btrim(bag_no)) between 1 and 40),
  -- Notes by face value in AED, e.g. {"100": 8, "50": 1, "10": 1} — they add up to the amount.
  denominations    jsonb,
  -- The time printed on the receipt (deposit or fuel), when given.
  receipt_at       timestamptz,
  reason           text check (reason is null or reason in ('entered_by_mistake', 'wrong_amount', 'wrong_machine', 'duplicate', 'other')),
  note             text check (note is null or length(note) <= 500),
  reverses_doc_id  uuid references cash_doc (id),
  device_at        timestamptz,
  recorded_at      timestamptz not null default now(),
  request_hash     text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  is_synthetic     boolean not null default false,
  correlation_id   uuid,
  check ((kind in ('collection', 'test_vend')) = (machine_id is not null)),
  check ((kind = 'expense') = (expense_kind is not null)),
  check (litres is null or expense_kind = 'fuel'),
  check ((cdm_txn_no is null and cdm_operator is null and cds_id is null and bag_no is null and denominations is null) or kind = 'deposit'),
  check ((kind = 'reversal') = (reverses_doc_id is not null)),
  check ((kind = 'reversal') = (reason is not null)),
  -- A reversal carries the amount it undoes: 0 when it undoes an empty box.
  check (kind in ('collection', 'reversal') or amount_fils > 0),
  check (state = 'posted' or kind <> 'reversal')
);
create unique index if not exists uq_cash_doc_reverses on cash_doc (reverses_doc_id) where reverses_doc_id is not null;
create index if not exists idx_cash_doc_shift on cash_doc (shift_id, recorded_at);
create index if not exists idx_cash_doc_machine on cash_doc (machine_id, recorded_at) where machine_id is not null;
create index if not exists idx_cash_doc_creator on cash_doc (created_by, recorded_at desc);

create table if not exists cash_move (
  id              bigint generated always as identity primary key,
  doc_id          uuid not null references cash_doc (id),
  from_account_id uuid not null references cash_account (id),
  to_account_id   uuid not null references cash_account (id),
  fils            bigint not null check (fils > 0),
  step            text not null check (step in ('post', 'reverse')),
  posted_at       timestamptz not null default now(),
  posted_by       uuid not null references employee (id),
  is_synthetic    boolean not null default false,
  correlation_id  uuid,
  check (from_account_id <> to_account_id)
);
create index if not exists idx_cash_move_doc on cash_move (doc_id);
create index if not exists idx_cash_move_from on cash_move (from_account_id, posted_at);
create index if not exists idx_cash_move_to on cash_move (to_account_id, posted_at);

create table if not exists cash_balance (
  account_id uuid primary key references cash_account (id),
  fils       bigint not null,
  is_virtual boolean not null,
  updated_at timestamptz not null default now(),
  constraint cash_balance_never_negative check (is_virtual or fils >= 0)
);

-- ── 5. The balance follows the moves; nothing changes but forward ────────────
-- Update first, insert only an account's first row: an upsert would check the CHECK on the row it
-- proposes before it finds the conflict (G195).
create or replace function cash_balance_add(p_account uuid, p_delta bigint) returns void
  language plpgsql
  set search_path = public
as $fn$
declare
  attempt integer := 0;
begin
  loop
    update cash_balance set fils = fils + p_delta, updated_at = now() where account_id = p_account;
    if found then
      return;
    end if;
    begin
      insert into cash_balance (account_id, fils, is_virtual)
      values (p_account, p_delta, (select is_virtual from cash_account where id = p_account));
      return;
    exception when unique_violation then
      attempt := attempt + 1;
      if attempt >= 3 then
        raise;
      end if;
    end;
  end loop;
end;
$fn$;
revoke all on function cash_balance_add(uuid, bigint) from public;

create or replace function cash_move_apply() returns trigger
  language plpgsql
  set search_path = public
as $fn$
begin
  perform cash_balance_add(new.from_account_id, -new.fils);
  perform cash_balance_add(new.to_account_id, new.fils);
  return null;
end;
$fn$;

create or replace function cash_balance_guard() returns trigger
  language plpgsql
  set search_path = public
as $fn$
begin
  if pg_trigger_depth() < 2 and not inv_purging() then
    raise exception 'cash_balance is kept by the ledger: post a cash document instead' using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end;
$fn$;

-- Moves: never changed; deleted only by a purge (cash_purge_shifts).
create or replace function cash_doc_guard() returns trigger
  language plpgsql
  set search_path = public
as $fn$
begin
  if tg_op = 'DELETE' then
    if not inv_purging() then
      raise exception 'cash documents are never deleted: post a reversal instead' using errcode = 'P0001';
    end if;
    return old;
  end if;
  if (new.id, new.kind, new.shift_id, new.created_by, new.machine_id, new.amount_fils, new.expense_kind, new.litres, new.cdm_txn_no,
      new.cdm_operator, new.cds_id, new.bag_no, new.denominations, new.receipt_at, new.reason, new.reverses_doc_id, new.device_at,
      new.recorded_at, new.request_hash, new.is_synthetic, new.correlation_id)
     is distinct from
     (old.id, old.kind, old.shift_id, old.created_by, old.machine_id, old.amount_fils, old.expense_kind, old.litres, old.cdm_txn_no,
      old.cdm_operator, old.cds_id, old.bag_no, old.denominations, old.receipt_at, old.reason, old.reverses_doc_id, old.device_at,
      old.recorded_at, old.request_hash, old.is_synthetic, old.correlation_id) then
    raise exception 'a cash document''s content is never changed: post a reversal instead' using errcode = 'P0001';
  end if;
  if new.note is distinct from old.note and not inv_is_redaction(new.note) then
    raise exception 'the words on a cash document are only ever removed, never rewritten' using errcode = 'P0001';
  end if;
  if new.state is distinct from old.state and not (old.state = 'posted' and new.state = 'reversed' and old.kind <> 'reversal') then
    raise exception 'a cash document cannot go from % to %', old.state, new.state using errcode = 'P0001';
  end if;
  return new;
end;
$fn$;

create or replace function shift_guard() returns trigger
  language plpgsql
  set search_path = public
as $fn$
begin
  if tg_op = 'DELETE' then
    if not inv_purging() then
      raise exception 'shifts are never deleted' using errcode = 'P0001';
    end if;
    return old;
  end if;
  if (new.id, new.employee_id, new.started_at, new.business_date, new.is_synthetic)
     is distinct from (old.id, old.employee_id, old.started_at, old.business_date, old.is_synthetic) then
    raise exception 'who worked the shift, and when it started, is never changed' using errcode = 'P0001';
  end if;
  if new.state is distinct from old.state and not (old.state = 'open' and new.state = 'closed') then
    raise exception 'a shift cannot go from % to %', old.state, new.state using errcode = 'P0001';
  end if;
  if old.ended_at is not null and new.ended_at is distinct from old.ended_at then
    raise exception 'when a shift ended is never changed' using errcode = 'P0001';
  end if;
  if new.audit_note is distinct from old.audit_note and old.audit_note is not null and new.audited_at is not distinct from old.audited_at
     and not inv_is_redaction(new.audit_note) then
    raise exception 'the words on a shift''s audit are only ever removed, never rewritten' using errcode = 'P0001';
  end if;
  if new.answer_note is distinct from old.answer_note and old.answer_note is not null and new.answered_at is not distinct from old.answered_at
     and not inv_is_redaction(new.answer_note) then
    raise exception 'the words of an answer are only ever removed, never rewritten' using errcode = 'P0001';
  end if;
  return new;
end;
$fn$;

drop trigger if exists cash_move_apply on cash_move;
create trigger cash_move_apply after insert on cash_move for each row execute function cash_move_apply();
drop trigger if exists cash_move_guard on cash_move;
create trigger cash_move_guard before update or delete on cash_move for each row execute function inv_ledger_guard();
drop trigger if exists cash_balance_guard on cash_balance;
create trigger cash_balance_guard before insert or update or delete on cash_balance for each row execute function cash_balance_guard();
drop trigger if exists cash_doc_guard on cash_doc;
create trigger cash_doc_guard before update or delete on cash_doc for each row execute function cash_doc_guard();
drop trigger if exists shift_guard on shift;
create trigger shift_guard before update or delete on shift for each row execute function shift_guard();

-- Practice runs only (scripts/reset-employee.ts, the tests): these shifts with their documents, moves
-- and photo links, then every cash balance rebuilt from what remains — refused whole if that would leave
-- a person below zero.
create or replace function cash_purge_shifts(p_shifts uuid[]) returns integer
  language plpgsql
  set search_path = public
as $fn$
declare
  v_docs uuid[];
begin
  perform set_config('freshnow.ledger_purge', 'on', true);
  select coalesce(array_agg(id), '{}') into v_docs from cash_doc where shift_id = any(p_shifts);
  delete from media_link where entity_type = 'cash_doc' and entity_id = any(v_docs);
  delete from cash_move where doc_id = any(v_docs);
  delete from cash_doc where id = any(v_docs) and reverses_doc_id is not null;
  delete from cash_doc where id = any(v_docs);
  delete from shift where id = any(p_shifts);
  delete from cash_balance;
  insert into cash_balance (account_id, fils, is_virtual)
  select f.account, sum(f.fils), a.is_virtual
    from (select to_account_id as account, fils from cash_move
          union all
          select from_account_id, -fils from cash_move) f
    join cash_account a on a.id = f.account
   group by f.account, a.is_virtual;
  perform set_config('freshnow.ledger_purge', 'off', true);
  return cardinality(v_docs);
end;
$fn$;
revoke all on function cash_purge_shifts(uuid[]) from public;

-- ── 6. Photos: the counter, the receipt ──────────────────────────────────────
alter table media_link drop constraint if exists media_link_entity_type_check;
alter table media_link add constraint media_link_entity_type_check check (entity_type in ('task', 'stock_doc', 'cash_doc'));

-- ── 7. Row security: read only, and only what the role allows ────────────────
do $$
declare
  t text;
begin
  foreach t in array array['cash_account', 'shift', 'cash_doc', 'cash_move', 'cash_balance']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists %I on %I', t || '_select', t);
    execute format('revoke insert, update, delete, truncate on %I from freshnow_app', t);
    execute format('grant select on %I to freshnow_app', t);
  end loop;
end $$;

-- A person sees the places cash goes and their own account — not who else holds cash.
create policy cash_account_select on cash_account for select to freshnow_app
  using ((select app_has_capability('cash.read'))
         or ((select app_has_capability('cash.hold')) and (kind <> 'person' or employee_id = app_current_employee())));
-- A shift and its documents: whoever sees all cash, and the person whose shift it is — including an
-- auditor's undo of one of their entries (it belongs to their shift).
create policy shift_select on shift for select to freshnow_app
  using ((select app_has_capability('cash.read')) or employee_id = app_current_employee());
create policy cash_doc_select on cash_doc for select to freshnow_app
  using ((select app_has_capability('cash.read'))
         or exists (select 1 from shift s where s.id = shift_id and s.employee_id = app_current_employee()));
create policy cash_move_select on cash_move for select to freshnow_app
  using (exists (select 1 from cash_doc d where d.id = doc_id));
create policy cash_balance_select on cash_balance for select to freshnow_app
  using ((select app_has_capability('cash.read'))
         or exists (select 1 from cash_account a where a.id = account_id and a.employee_id = app_current_employee()));

-- The cash auditor checks the receipts: a photo on a cash document is also seen by whoever sees all
-- cash (0026 shows a photo only to those who may see its sender). A function, so that the media
-- policy does not read media_link under media_link's own policy, which reads media_object.
create or replace function app_media_on_cash_doc(p_media uuid) returns boolean
  language sql stable security definer
  set search_path = pg_catalog, public, pg_temp
as $fn$
  select app_has_capability('cash.read')
     and exists (select 1 from media_link l where l.media_id = p_media and l.entity_type = 'cash_doc')
$fn$;
revoke all on function app_media_on_cash_doc(uuid) from public;
grant execute on function app_media_on_cash_doc(uuid) to freshnow_app;
alter policy media_object_select on media_object
  using ((select app_reads_all()) or app_can_view_employee(uploaded_by) or app_media_on_cash_doc(id));

-- ── 8. Live updates: whoever sees all cash, and the person concerned (0027, 0032) ──
do $$
declare
  w record;
begin
  perform set_config('client_min_messages', 'warning', true);
  for w in
    select * from (values
      ('cash_doc', $s$select 'c:cash.read'::text from changed
                      union select 's:' || s.employee_id from changed c join shift s on s.id = c.shift_id$s$),
      ('shift', $s$select 'c:cash.read'::text from changed union select 's:' || employee_id from changed$s$)
    ) v (tbl, scope)
  loop
    execute format('drop trigger if exists %I on %I', 'notify_' || w.tbl || '_ins', w.tbl);
    execute format('drop trigger if exists %I on %I', 'notify_' || w.tbl || '_upd', w.tbl);
    execute format('drop trigger if exists %I on %I', 'notify_' || w.tbl || '_del', w.tbl);
    execute format(
      'create trigger %I after insert on %I referencing new table as new_rows
         for each statement execute function notify_change(%L)',
      'notify_' || w.tbl || '_ins', w.tbl, w.scope);
    execute format(
      'create trigger %I after update on %I referencing old table as old_rows new table as new_rows
         for each statement execute function notify_change(%L)',
      'notify_' || w.tbl || '_upd', w.tbl, w.scope);
    execute format(
      'create trigger %I after delete on %I referencing old table as old_rows
         for each statement execute function notify_change(%L)',
      'notify_' || w.tbl || '_del', w.tbl, w.scope);
  end loop;
end $$;
