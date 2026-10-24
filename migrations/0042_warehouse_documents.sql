-- migrations/0042_warehouse_documents.sql — planned receipts, returns to the supplier, lots, reorder rules (TASK-086)
--
-- Televend's Warehouse Management (its user guide, version 1.1, an Odoo-style module) plans its documents: a receipt is drafted,
-- marked "to do", received — what came against what was expected — and closed, with a backorder for the rest; a done document can
-- be returned; minimum and maximum quantities suggest what to order. FreshNow's ledger (0032) records only what has happened. This
-- adds the plan ON TOP of it, never beside it: when a planned document is done it posts an ordinary stock document through the
-- same ledger, so balances, counts, the day sheet and the Movements view stay the one record of where stock is.
--
--   supplier       who delivers: a name, a short code, how many days a delivery usually takes
--   wh_order       a planned receipt (suppliers → warehouse) or a return to the supplier (warehouse → suppliers):
--                  draft → ready → done | cancelled (ready → draft to edit again); a receipt short of what was expected
--                  leaves a backorder — a new ready receipt for the rest — or is closed short, as the receiver chooses
--   wh_order_line  each item once: what was expected and what came (or goes back), its kilograms in whole grams, variety,
--                  best-before day
--   inv_lot        every receipt line received is a lot: the delivery it came in, its supplier, day, kilograms, best-before —
--                  the start of lot tracking (TASK-086 part 1 records lots at receiving; following a lot through hand-outs
--                  and machines comes with the crates)
--   reorder_rule   per item and place (the warehouse, or one person's stock): below the minimum, order up to the maximum, in
--                  multiples; a SUGGESTION a person confirms — nothing is ordered or handed out by the rule itself
--
-- A done or cancelled document never changes, its lines and lots neither (triggers); the stock it moved is undone like any other
-- stock document's — a reversal by an approver. Writes go through core on the service role; the app role reads, as 0032's tables.
--
-- A return to the supplier is a new kind of stock document, 'supplier_return', from the warehouse to the bookkeeping place
-- "Suppliers", with a reason (quality, wrong item, excess, damaged on arrival, expired, other) — the chats' "Not good orange …
-- carton return" (REQ-2026-10-19 RW.5).

-- ── 1. The ledger learns one more kind: a return to the supplier ─────────────
-- 0032's checks were written inline, so Postgres named them; find each by what it says and replace it with a named one.
do $$
declare
  c record;
begin
  for c in
    select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'stock_doc'::regclass and contype = 'c'
  loop
    if c.conname = 'stock_doc_kind_check'
       or (c.def like '%supplier IS NULL%invoice_no IS NULL%' and c.def like '%''receipt''%')
       or c.def like '%''machine_refill''%' then
      execute format('alter table stock_doc drop constraint %I', c.conname);
    end if;
  end loop;
end $$;

alter table stock_doc add constraint stock_doc_kind_check
  check (kind in ('receipt', 'handover', 'use', 'damage', 'count_adjustment', 'reversal', 'supplier_return'));
alter table stock_doc add constraint stock_doc_supplier_only_on_supplier_docs
  check ((supplier is null and invoice_no is null) or kind in ('receipt', 'supplier_return'));
alter table stock_doc add constraint stock_doc_reason_by_kind
  check (case kind
    when 'use'             then reason in ('machine_refill', 'cleaning', 'shift_use', 'repair', 'other')
    when 'damage'          then reason in ('spoiled', 'broken', 'expired', 'sorting_waste', 'other')
    when 'reversal'        then reason in ('entered_by_mistake', 'wrong_quantity', 'wrong_item', 'duplicate', 'other')
    when 'supplier_return' then reason in ('quality', 'wrong_item', 'excess', 'damaged_on_arrival', 'expired', 'other')
    else reason is null end);

-- ── 2. Who may do what ───────────────────────────────────────────────────────
-- No new capability: the planned documents are the warehouse's own work (inventory.move), seen by everyone who sees all stock
-- (inventory.read); a return to the supplier is told to the approvers (core). permissions.ts is unchanged.

-- ── 3. Suppliers ─────────────────────────────────────────────────────────────
create table if not exists supplier (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (length(btrim(name)) between 1 and 80),
  -- A short code for labels and lot numbers: FVC, AL-AWIR.
  code         text check (code is null or code ~ '^[A-Z0-9-]{2,12}$'),
  -- How many days an order usually takes to arrive — the reorder suggestion says when to order by.
  lead_days    integer check (lead_days is null or lead_days between 0 and 60),
  -- The company's own words about it; no person's phone number or name is needed here (PDPL: data minimisation).
  note         text check (note is null or length(note) <= 300),
  active       boolean not null default true,
  created_by   uuid references employee (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  is_synthetic boolean not null default false
);
create unique index if not exists uq_supplier_name on supplier (lower(btrim(name)));
create unique index if not exists uq_supplier_code on supplier (code) where code is not null;

-- ── 4. Planned documents ─────────────────────────────────────────────────────
-- Their numbers, IN-2026-0001 and RET-2026-0001: one counter per kind and year, taken in the document's own transaction, so a
-- document that is not created leaves no gap.
create table if not exists wh_number (
  kind text    not null,
  year integer not null,
  last integer not null,
  primary key (kind, year)
);

create table if not exists wh_order (
  -- Made by the phone or browser: creating the same document twice creates it once (request_hash tells a repeat from a
  -- different request that reused the id), as stock_doc.
  id             uuid primary key,
  kind           text not null check (kind in ('receipt', 'supplier_return')),
  number         text not null unique check (number ~ '^(IN|RET)-[0-9]{4}-[0-9]{4,}$'),
  state          text not null default 'draft' check (state in ('draft', 'ready', 'done', 'cancelled')),
  supplier_id    uuid not null references supplier (id),
  -- The Dubai day it is expected (a receipt) or planned (a return).
  scheduled_on   date,
  priority       text not null default 'normal' check (priority in ('normal', 'urgent')),
  -- The supplier's paper: delivery note, order or invoice number.
  source_ref     text check (source_ref is null or length(btrim(source_ref)) between 1 and 40),
  -- The truck's plate as written at the gate (a receipt) — the plate only, never the driver's name.
  vehicle        text check (vehicle is null or length(btrim(vehicle)) between 1 and 20),
  note           text check (note is null or length(note) <= 500),
  -- A return: why it goes back.
  reason         text check (reason is null or reason in ('quality', 'wrong_item', 'excess', 'damaged_on_arrival', 'expired', 'other')),
  backorder_of   uuid references wh_order (id),
  return_of      uuid references wh_order (id),
  -- The ledger document its validation posted.
  stock_doc_id   uuid unique references stock_doc (id),
  -- Done with less than expected and no backorder: the rest will not come.
  closed_short   boolean not null default false,
  created_by     uuid not null references employee (id),
  created_at     timestamptz not null default now(),
  ready_by       uuid references employee (id),
  ready_at       timestamptz,
  done_by        uuid references employee (id),
  done_at        timestamptz,
  cancelled_by   uuid references employee (id),
  cancelled_at   timestamptz,
  cancel_note    text check (cancel_note is null or length(cancel_note) <= 300),
  request_hash   text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  is_synthetic   boolean not null default false,
  correlation_id uuid,
  check ((kind = 'supplier_return') = (reason is not null)),
  check (return_of is null or kind = 'supplier_return'),
  check (backorder_of is null or kind = 'receipt'),
  check ((state = 'done') = (done_at is not null)),
  check ((state = 'done') = (stock_doc_id is not null)),
  check ((state = 'cancelled') = (cancelled_at is not null)),
  check (not closed_short or state = 'done'),
  check ((kind = 'receipt') = (number like 'IN-%'))
);
create index if not exists idx_wh_order_open on wh_order (state, scheduled_on) where state in ('draft', 'ready');
create index if not exists idx_wh_order_supplier on wh_order (supplier_id, created_at desc);
create index if not exists idx_wh_order_created on wh_order (created_at desc);
create index if not exists idx_wh_order_return_of on wh_order (return_of) where return_of is not null;

create table if not exists wh_order_line (
  order_id    uuid not null references wh_order (id),
  item_id     uuid not null references inv_item (id),
  -- What is expected (a receipt) or to go back (a return), in the item's unit.
  expected_qty numeric(14, 3) not null check (expected_qty > 0),
  -- What came (or went back) — written when the document is done.
  done_qty    numeric(14, 3) check (done_qty is null or done_qty >= 0),
  -- Kilograms as whole grams, so totals never drift by rounding: the delivery note's, and the scale's at receiving.
  expected_g  bigint check (expected_g is null or (expected_g > 0 and expected_g <= 100000000)),
  done_g      bigint check (done_g is null or (done_g >= 0 and done_g <= 100000000)),
  variety     text check (variety is null or length(btrim(variety)) between 1 and 40),
  best_before date,
  note        text check (note is null or length(note) <= 200),
  primary key (order_id, item_id)
);

-- ── 5. Lots ──────────────────────────────────────────────────────────────────
create table if not exists inv_lot (
  id             uuid primary key default gen_random_uuid(),
  -- The receipt's number and the line's place in it: IN-2026-0007-1.
  code           text not null unique,
  item_id        uuid not null references inv_item (id),
  supplier_id    uuid not null references supplier (id),
  order_id       uuid not null references wh_order (id),
  stock_doc_id   uuid not null references stock_doc (id),
  received_on    date not null,
  best_before    date,
  variety        text,
  qty            numeric(14, 3) not null check (qty > 0),
  weight_g       bigint check (weight_g is null or weight_g > 0),
  created_at     timestamptz not null default now(),
  is_synthetic   boolean not null default false,
  correlation_id uuid,
  unique (order_id, item_id)
);
create index if not exists idx_inv_lot_item on inv_lot (item_id, received_on desc);

-- ── 6. Reorder rules ─────────────────────────────────────────────────────────
create table if not exists reorder_rule (
  id           uuid primary key default gen_random_uuid(),
  item_id      uuid not null references inv_item (id),
  -- The warehouse, or one person's own stock (core refuses any other place).
  location_id  uuid not null references inv_location (id),
  min_qty      numeric(14, 3) not null check (min_qty >= 0),
  max_qty      numeric(14, 3) not null check (max_qty > 0),
  -- Order in packs of this many (null: the item's step).
  multiple     numeric(14, 3) check (multiple is null or multiple > 0),
  -- Whom the warehouse orders it from (a warehouse rule); a person's stock is filled from the warehouse.
  supplier_id  uuid references supplier (id),
  active       boolean not null default true,
  created_by   uuid references employee (id),
  created_at   timestamptz not null default now(),
  updated_by   uuid references employee (id),
  updated_at   timestamptz not null default now(),
  is_synthetic boolean not null default false,
  check (max_qty >= min_qty),
  unique (item_id, location_id)
);

-- ── 7. What may never change ─────────────────────────────────────────────────
-- A document moves forward only; once done or cancelled its content is fixed. Who did each step is written once.
create or replace function wh_order_guard() returns trigger
  language plpgsql
  set search_path = public
as $fn$
begin
  if tg_op = 'DELETE' then
    if not inv_purging() then
      raise exception 'warehouse documents are never deleted: cancel it, or reverse the stock it moved' using errcode = 'P0001';
    end if;
    return old;
  end if;
  if (new.id, new.kind, new.number, new.supplier_id, new.backorder_of, new.return_of, new.created_by, new.created_at,
      new.request_hash, new.is_synthetic, new.correlation_id)
     is distinct from
     (old.id, old.kind, old.number, old.supplier_id, old.backorder_of, old.return_of, old.created_by, old.created_at,
      old.request_hash, old.is_synthetic, old.correlation_id) then
    raise exception 'who made a warehouse document, for which supplier, is never changed' using errcode = 'P0001';
  end if;
  if old.state in ('done', 'cancelled') then
    -- Only the words may be removed afterwards (erasure, retention), as on a stock document (0034).
    if (new.state, new.scheduled_on, new.priority, new.source_ref, new.vehicle, new.reason, new.stock_doc_id, new.closed_short,
        new.ready_by, new.ready_at, new.done_by, new.done_at, new.cancelled_by, new.cancelled_at)
       is distinct from
       (old.state, old.scheduled_on, old.priority, old.source_ref, old.vehicle, old.reason, old.stock_doc_id, old.closed_short,
        old.ready_by, old.ready_at, old.done_by, old.done_at, old.cancelled_by, old.cancelled_at)
       or (new.note is distinct from old.note and not inv_is_redaction(new.note))
       or (new.cancel_note is distinct from old.cancel_note and not inv_is_redaction(new.cancel_note)) then
      raise exception 'a % warehouse document is never changed', old.state using errcode = 'P0001';
    end if;
    return new;
  end if;
  if new.state is distinct from old.state and not (
       (old.state = 'draft' and new.state in ('ready', 'done', 'cancelled'))
    or (old.state = 'ready' and new.state in ('draft', 'done', 'cancelled'))) then
    raise exception 'a warehouse document cannot go from % to %', old.state, new.state using errcode = 'P0001';
  end if;
  return new;
end;
$fn$;

-- Lines: added, changed or removed only while their document is a draft. When it is received (or returned) from draft or ready,
-- what came is written once — the expectation stays as it was.
create or replace function wh_order_line_guard() returns trigger
  language plpgsql
  set search_path = public
as $fn$
declare
  v_state text;
begin
  select state into v_state from wh_order where id = coalesce(new.order_id, old.order_id);
  if tg_op = 'DELETE' then
    if v_state = 'draft' or inv_purging() then
      return old;
    end if;
    raise exception 'the lines of a % warehouse document are not removed', v_state using errcode = 'P0001';
  end if;
  if tg_op = 'INSERT' then
    if v_state = 'draft' then
      return new;
    end if;
    raise exception 'lines are added only to a draft' using errcode = 'P0001';
  end if;
  if new.order_id is distinct from old.order_id or new.item_id is distinct from old.item_id then
    raise exception 'a line stays on its document and item' using errcode = 'P0001';
  end if;
  if v_state = 'draft' then
    return new;
  end if;
  -- A person's words are removed (erasure, retention) in any state, as on a stock document (0034) — and only that.
  if new.note is distinct from old.note and inv_is_redaction(new.note)
     and (new.expected_qty, new.done_qty, new.expected_g, new.done_g, new.variety, new.best_before)
         is not distinct from (old.expected_qty, old.done_qty, old.expected_g, old.done_g, old.variety, old.best_before) then
    return new;
  end if;
  if v_state = 'ready'
     and (new.expected_qty, new.expected_g, new.variety, new.best_before, new.note)
         is not distinct from (old.expected_qty, old.expected_g, old.variety, old.best_before, old.note)
     and old.done_qty is null and old.done_g is null then
    return new;
  end if;
  raise exception 'the lines of a % warehouse document are not changed', v_state using errcode = 'P0001';
end;
$fn$;

-- A lot is written once, when its receipt is done.
create or replace function inv_lot_guard() returns trigger
  language plpgsql
  set search_path = public
as $fn$
begin
  if tg_op = 'UPDATE' then
    raise exception 'a lot is never changed' using errcode = 'P0001';
  end if;
  if not inv_purging() then
    raise exception 'a lot is never deleted' using errcode = 'P0001';
  end if;
  return old;
end;
$fn$;

drop trigger if exists wh_order_guard on wh_order;
create trigger wh_order_guard before update or delete on wh_order for each row execute function wh_order_guard();
drop trigger if exists wh_order_line_guard on wh_order_line;
create trigger wh_order_line_guard before insert or update or delete on wh_order_line for each row execute function wh_order_line_guard();
drop trigger if exists inv_lot_guard on inv_lot;
create trigger inv_lot_guard before update or delete on inv_lot for each row execute function inv_lot_guard();

-- ── 8. Purge (practice runs only) ────────────────────────────────────────────
-- These documents with their lines and lots, then the stock documents they posted — with any others named in p_docs — through
-- ONE call of 0032's purge, which rebuilds the balances from what remains: purged apart, a delivery could go before the hand-out
-- that used it and leave the warehouse below zero, which the purge refuses. For scripts/reset-employee.ts and the tests' clean-up.
create or replace function wh_purge_orders(p_orders uuid[], p_docs uuid[] default '{}') returns integer
  language plpgsql
  set search_path = public
as $fn$
declare
  v_orders uuid[];
  v_docs   uuid[];
begin
  perform set_config('freshnow.ledger_purge', 'on', true);
  -- With every backorder and return made from them.
  with recursive o(id) as (
    select id from wh_order where id = any(p_orders)
    union
    select w.id from wh_order w join o on w.backorder_of = o.id or w.return_of = o.id
  )
  select coalesce(array_agg(id), '{}') into v_orders from o;
  select coalesce(array_agg(stock_doc_id), '{}') || coalesce(p_docs, '{}') into v_docs from wh_order where id = any(v_orders) and stock_doc_id is not null;
  delete from inv_lot where order_id = any(v_orders);
  delete from wh_order_line where order_id = any(v_orders);
  -- One statement: a backorder and the receipt it came from go together (a NO ACTION key is checked at the statement's end).
  delete from wh_order where id = any(v_orders);
  if cardinality(v_docs) > 0 then
    perform inv_purge_docs(v_docs);
  end if;
  perform set_config('freshnow.ledger_purge', 'off', true);
  return cardinality(v_orders);
end;
$fn$;
revoke all on function wh_purge_orders(uuid[], uuid[]) from public;

-- ── 9. Row security: read only, for the people who see all stock ─────────────
do $$
declare
  t text;
begin
  foreach t in array array['supplier', 'wh_number', 'wh_order', 'wh_order_line', 'inv_lot', 'reorder_rule']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists %I on %I', t || '_select', t);
    execute format('revoke insert, update, delete, truncate on %I from freshnow_app', t);
    execute format('grant select on %I to freshnow_app', t);
  end loop;
end $$;

create policy supplier_select on supplier for select to freshnow_app using ((select app_has_capability('inventory.read')));
create policy wh_number_select on wh_number for select to freshnow_app using ((select app_has_capability('inventory.read')));
create policy wh_order_select on wh_order for select to freshnow_app using ((select app_has_capability('inventory.read')));
create policy wh_order_line_select on wh_order_line for select to freshnow_app using (exists (select 1 from wh_order o where o.id = order_id));
create policy inv_lot_select on inv_lot for select to freshnow_app using ((select app_has_capability('inventory.read')));
create policy reorder_rule_select on reorder_rule for select to freshnow_app using ((select app_has_capability('inventory.read')));

-- ── 10. Live updates: everyone who sees all stock (0027) ─────────────────────
do $$
begin
  perform set_config('client_min_messages', 'warning', true);
  drop trigger if exists notify_wh_order_ins on wh_order;
  drop trigger if exists notify_wh_order_upd on wh_order;
  drop trigger if exists notify_wh_order_del on wh_order;
  create trigger notify_wh_order_ins after insert on wh_order referencing new table as new_rows
    for each statement execute function notify_change($s$select 'c:inventory.read'::text from changed$s$);
  create trigger notify_wh_order_upd after update on wh_order referencing old table as old_rows new table as new_rows
    for each statement execute function notify_change($s$select 'c:inventory.read'::text from changed$s$);
  -- A purge (practice runs only) rings too, as every watched table's three triggers do (0027).
  create trigger notify_wh_order_del after delete on wh_order referencing old table as old_rows
    for each statement execute function notify_change($s$select 'c:inventory.read'::text from changed$s$);
end $$;
