-- migrations/0032_inventory.sql — the stock ledger (TASK-060)
--
-- Today the warehouse list is typed into a WhatsApp group, copied forward from the day before
-- (VF74), and nothing records who took or brought back how many, or what arrived. This is that record.
--
-- ── THE LEDGER ───────────────────────────────────────────────────────────────
-- Every change of stock is a MOVE of an amount of one item from one place to another (stock_move).
-- The places (inv_location) are the warehouse, every person who holds stock, "in transit" (a handover
-- the other side has not confirmed yet), and four bookkeeping places that are not shelves: suppliers
-- (deliveries come from there), used, damaged, and count adjustments. A move is never changed and
-- never deleted: a mistake is put right by a reversal — a new document whose moves go the other way.
-- (ERPNext keeps its ledger the same way: the original rows stay and opposite rows are added —
-- docs.frappe.io "Immutable Ledger", read 2026-10-17.)
--
-- stock_balance is what each place holds now. A trigger keeps it in the same transaction as the move,
-- so it cannot disagree with the moves (a test sums the moves and compares), and its CHECK refuses any
-- move that would take a real place below zero, whoever writes it. Two transactions moving the same
-- item meet on the same balance row: in Read Committed the second UPDATE waits, then applies to the
-- row as the first one left it (PostgreSQL 17 docs §13.2.1) — two hand-outs of the last carton cannot
-- both succeed. Core also takes a lock per item, in order, so two documents never wait on each other
-- in a circle.
--
-- ── HANDOVERS ────────────────────────────────────────────────────────────────
-- Stock always has one holder. A handover moves it from the giver to "in transit" at once, and on to
-- the receiver only when the OTHER side confirms — the person, for a hand-out; someone at the
-- warehouse, for a return. A receiver who counts less accepts what they counted; the rest stays in
-- transit, in plain view, until an approver settles it: back to the giver (they miscounted) or
-- written off with a reason.
--
-- ── COUNTS ───────────────────────────────────────────────────────────────────
-- A count is typed in without the system's figure on the screen. When it is handed in, each line is
-- compared with the ledger at that moment. A difference beyond the item's tolerance is counted again by
-- someone else; then the Ops Head, the CEO or an Admin decides, line by line, whether the count or the
-- ledger is right — never the person who counted (D218). Accepting a count posts an adjustment
-- document; the moves before it stay as they were.
--
-- ── WHO MAY DO WHAT ──────────────────────────────────────────────────────────
-- Four capabilities (permissions.ts + role_capability, kept equal by a test):
--   inventory.read     sees all stock — every place, every movement      CEO, Admin, Ops Head, Supervisor, Warehouse keeper
--   inventory.hold     can be given stock and must account for it        + Technician, VMO
--   inventory.move     runs the warehouse: receive, give out, take back, count   CEO, Admin, Ops Head, Warehouse keeper
--   inventory.approve  decides count differences, settles handovers, reverses    CEO, Admin, Ops Head
-- Everyone else sees nothing here. Writes go through core on the service role (D70); the app role
-- may only read, and only what these policies allow.
--
-- ── PURGE (practice runs only) ───────────────────────────────────────────────
-- A ledger row is deleted only through inv_purge_docs(), which sets `freshnow.ledger_purge` for its
-- own transaction and rebuilds the balances afterwards — used by scripts/reset-employee.ts and the
-- tests' clean-up to clear a practice run. Any role can set a custom setting, so this guards against
-- accidents, not against the service role on purpose; against the app role the boundary is that it has
-- no INSERT, UPDATE or DELETE grant at all.

-- ── 1. Who may do what (the SQL copy of permissions.ts) ──────────────────────
insert into role_capability (role, capability) values
  ('ceo', 'inventory.read'), ('ceo', 'inventory.hold'), ('ceo', 'inventory.move'), ('ceo', 'inventory.approve'),
  ('admin', 'inventory.read'), ('admin', 'inventory.hold'), ('admin', 'inventory.move'), ('admin', 'inventory.approve'),
  ('ops_head', 'inventory.read'), ('ops_head', 'inventory.hold'), ('ops_head', 'inventory.move'), ('ops_head', 'inventory.approve'),
  ('supervisor', 'inventory.read'), ('supervisor', 'inventory.hold'),
  ('warehouse_keeper', 'inventory.read'), ('warehouse_keeper', 'inventory.hold'), ('warehouse_keeper', 'inventory.move'),
  ('technician', 'inventory.hold'),
  ('vmo', 'inventory.hold')
on conflict do nothing;

-- ── 2. What is kept ──────────────────────────────────────────────────────────
create table if not exists inv_item (
  id              uuid primary key default gen_random_uuid(),
  name            text not null check (length(btrim(name)) between 1 and 60),
  category        text not null check (category in ('oranges', 'cups_packaging', 'consumable', 'cleaning', 'spare_part', 'vehicle', 'device', 'other')),
  -- The one unit it is counted in: carton, box, piece … (A-T60.2: the WhatsApp list names few units).
  unit            text not null check (length(btrim(unit)) between 1 and 20),
  -- The smallest amount anyone enters: 1 carton, half a box of straws.
  step            numeric(10, 3) not null default 1 check (step > 0 and step <= 1000),
  -- Below this the warehouse is low (🚨). Null: no alert until someone sets it.
  min_level       numeric(14, 3) check (min_level is null or min_level >= 0),
  -- A count this close to the ledger skips the recount (it is still approved). 0 = any difference.
  count_tolerance numeric(14, 3) not null default 0 check (count_tolerance >= 0),
  icon            text check (icon is null or length(icon) between 1 and 16),
  sort_order      integer not null default 100,
  active          boolean not null default true,
  -- A company phone handed out like stock ("who took the company phone", VF74).
  device_id       uuid references device (id),
  created_by      uuid references employee (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  is_synthetic    boolean not null default false
);
create unique index if not exists uq_inv_item_name on inv_item (lower(btrim(name)));

create table if not exists inv_location (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null check (kind in ('warehouse', 'person', 'in_transit', 'supplier', 'used', 'damaged', 'adjustment')),
  -- Null for a person's place: their name is read from employee, so an erased person's name goes too.
  name         text check (name is null or length(btrim(name)) between 1 and 80),
  employee_id  uuid references employee (id),
  -- Bookkeeping places hold no real stock and may go below zero (suppliers, used, damaged, adjustments).
  is_virtual   boolean generated always as (kind in ('supplier', 'used', 'damaged', 'adjustment')) stored,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  is_synthetic boolean not null default false,
  check ((kind = 'person') = (employee_id is not null)),
  check ((kind = 'person') = (name is null))
);
create unique index if not exists uq_inv_location_person on inv_location (employee_id) where kind = 'person';

create table if not exists count_session (
  -- Made by the phone or browser: sending the same count twice records it once.
  id                    uuid primary key,
  location_id           uuid not null references inv_location (id),
  kind                  text not null check (kind in ('opening', 'after_handout', 'closing', 'spot')),
  state                 text not null default 'counting' check (state in ('counting', 'recount', 'approval', 'closed', 'cancelled')),
  started_by            uuid not null references employee (id),
  started_at            timestamptz not null default now(),
  submitted_at          timestamptz,
  recount_by            uuid references employee (id),
  recount_started_at    timestamptz,
  recounted_at          timestamptz,
  recount_waived_by     uuid references employee (id),
  recount_waived_reason text check (recount_waived_reason is null or length(btrim(recount_waived_reason)) between 3 and 300),
  decided_by            uuid references employee (id),
  decided_at            timestamptz,
  decision_note         text check (decision_note is null or length(decision_note) <= 500),
  is_synthetic          boolean not null default false,
  correlation_id        uuid,
  -- Nobody recounts or approves their own count (D218).
  check (recount_by is null or recount_by <> started_by),
  check (decided_by is null or decided_by <> started_by),
  check (decided_by is null or recount_by is null or decided_by <> recount_by)
);
create index if not exists idx_count_session_place on count_session (location_id, started_at desc);
create index if not exists idx_count_session_open on count_session (state) where state in ('counting', 'recount', 'approval');

create table if not exists stock_doc (
  -- Made by the phone or browser: the same request sent twice posts once (request_hash tells a
  -- repeat from a different request that reused the id).
  id               uuid primary key,
  kind             text not null check (kind in ('receipt', 'handover', 'use', 'damage', 'count_adjustment', 'reversal')),
  -- Where the stock comes from and goes to. For a count adjustment the moves may go either way:
  -- these two name the counted place and the adjustment place; the moves are the truth.
  from_location_id uuid not null references inv_location (id),
  to_location_id   uuid not null references inv_location (id),
  state            text not null check (state in ('posted', 'reversed', 'waiting', 'accepted', 'part_accepted', 'settled', 'refused', 'cancelled')),
  created_by       uuid not null references employee (id),
  -- A handover: who confirms it — one person, or anyone who runs the warehouse (never the creator).
  confirm_side     text check (confirm_side in ('person', 'warehouse')),
  confirm_by       uuid references employee (id),
  answered_by      uuid references employee (id),
  answered_at      timestamptz,
  answer_reason    text check (answer_reason is null or answer_reason in ('not_received', 'wrong_items', 'wrong_count', 'damaged', 'other')),
  answer_note      text check (answer_note is null or length(answer_note) <= 500),
  settled_by       uuid references employee (id),
  settled_at       timestamptz,
  settle_note      text check (settle_note is null or length(settle_note) <= 500),
  reason           text,
  note             text check (note is null or length(note) <= 500),
  -- A delivery: as the supplier's paper says.
  supplier         text check (supplier is null or length(btrim(supplier)) between 1 and 80),
  invoice_no       text check (invoice_no is null or length(btrim(invoice_no)) between 1 and 40),
  -- Used: put into this machine.
  machine_id       uuid references machine (id),
  reverses_doc_id  uuid references stock_doc (id),
  count_session_id uuid references count_session (id),
  -- When the phone says it happened; every rule and every report uses recorded_at.
  device_at        timestamptz,
  recorded_at      timestamptz not null default now(),
  request_hash     text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  is_synthetic     boolean not null default false,
  correlation_id   uuid,
  check (from_location_id <> to_location_id),
  check ((kind = 'handover') = (confirm_side is not null)),
  check (confirm_side is distinct from 'person' or confirm_by is not null),
  check (confirm_by is null or confirm_by <> created_by),
  check (answered_by is null or answered_by <> created_by),
  check ((kind = 'reversal') = (reverses_doc_id is not null)),
  check ((kind = 'count_adjustment') = (count_session_id is not null)),
  check (machine_id is null or kind = 'use'),
  check ((supplier is null and invoice_no is null) or kind = 'receipt'),
  check (case kind
    when 'use'      then reason in ('machine_refill', 'cleaning', 'shift_use', 'repair', 'other')
    when 'damage'   then reason in ('spoiled', 'broken', 'expired', 'sorting_waste', 'other')
    when 'reversal' then reason in ('entered_by_mistake', 'wrong_quantity', 'wrong_item', 'duplicate', 'other')
    else reason is null end),
  check (case kind
    when 'handover' then state in ('waiting', 'accepted', 'part_accepted', 'settled', 'refused', 'cancelled')
    when 'reversal' then state = 'posted'
    else state in ('posted', 'reversed') end)
);
create unique index if not exists uq_stock_doc_reverses on stock_doc (reverses_doc_id) where reverses_doc_id is not null;
create index if not exists idx_stock_doc_recorded on stock_doc (recorded_at desc);
create index if not exists idx_stock_doc_open on stock_doc (state, recorded_at) where state in ('waiting', 'part_accepted');
create index if not exists idx_stock_doc_confirm on stock_doc (confirm_by) where state = 'waiting';
create index if not exists idx_stock_doc_creator on stock_doc (created_by, recorded_at desc);
create index if not exists idx_stock_doc_session on stock_doc (count_session_id) where count_session_id is not null;

create table if not exists stock_doc_line (
  doc_id    uuid not null references stock_doc (id),
  item_id   uuid not null references inv_item (id),
  -- What the document says, in the item's unit: sent, received, used, damaged.
  qty       numeric(14, 3) not null check (qty > 0),
  -- A delivery of oranges, as the carton says (A-T60.1).
  variety   text check (variety is null or length(btrim(variety)) between 1 and 40),
  carton_kg numeric(6, 2) check (carton_kg is null or (carton_kg > 0 and carton_kg < 100)),
  primary key (doc_id, item_id)
);

create table if not exists stock_move (
  id               bigint generated always as identity primary key,
  doc_id           uuid not null references stock_doc (id),
  item_id          uuid not null references inv_item (id),
  from_location_id uuid not null references inv_location (id),
  to_location_id   uuid not null references inv_location (id),
  qty              numeric(14, 3) not null check (qty > 0),
  -- Which step of its document: a handover posts send, then accept / refuse / cancel, and a part
  -- left in transit is later settled (back to the giver, or written off).
  step             text not null check (step in ('post', 'send', 'accept', 'refuse', 'cancel', 'settle_back', 'write_off', 'reverse')),
  posted_at        timestamptz not null default now(),
  posted_by        uuid not null references employee (id),
  -- A write-off: why (the same words as a count decision).
  reason           text check (reason is null or reason in ('damaged_unrecorded', 'unexplained')),
  is_synthetic     boolean not null default false,
  correlation_id   uuid,
  check (from_location_id <> to_location_id),
  check ((step = 'write_off') = (reason is not null))
);
create index if not exists idx_stock_move_doc on stock_move (doc_id);
create index if not exists idx_stock_move_item on stock_move (item_id, posted_at);
create index if not exists idx_stock_move_from on stock_move (from_location_id, item_id, posted_at);
create index if not exists idx_stock_move_to on stock_move (to_location_id, item_id, posted_at);

create table if not exists stock_balance (
  location_id uuid not null references inv_location (id),
  item_id     uuid not null references inv_item (id),
  qty         numeric(14, 3) not null,
  is_virtual  boolean not null,
  updated_at  timestamptz not null default now(),
  primary key (location_id, item_id),
  constraint stock_balance_never_negative check (is_virtual or qty >= 0)
);

create table if not exists count_line (
  session_id           uuid not null references count_session (id),
  item_id              uuid not null references inv_item (id),
  counted_qty          numeric(14, 3) not null check (counted_qty >= 0),
  -- The ledger when the count was handed in — never shown to the person counting.
  expected_qty         numeric(14, 3) not null,
  -- The item moved here while it was being counted: the two figures are from different moments.
  moved_during         boolean not null default false,
  recount_qty          numeric(14, 3) check (recount_qty is null or recount_qty >= 0),
  recount_expected_qty numeric(14, 3),
  recount_moved_during boolean,
  decision             text check (decision is null or decision in ('accept_count', 'keep_ledger')),
  decision_reason      text check (decision_reason is null or decision_reason in
                         ('opening_balance', 'used_unrecorded', 'damaged_unrecorded', 'delivery_difference', 'earlier_miscount', 'found', 'unexplained')),
  primary key (session_id, item_id),
  check ((recount_qty is null) = (recount_expected_qty is null)),
  check ((decision = 'accept_count') = (decision_reason is not null))
);

-- ── 3. The places that always exist ──────────────────────────────────────────
-- Fixed ids, like the system actor (0031): core and the tests name them directly.
insert into inv_location (id, kind, name) values
  ('00000000-0000-0000-0000-00000000b001', 'warehouse',  'Warehouse'),
  ('00000000-0000-0000-0000-00000000b002', 'in_transit', 'In transit'),
  ('00000000-0000-0000-0000-00000000b003', 'supplier',   'Suppliers'),
  ('00000000-0000-0000-0000-00000000b004', 'used',       'Used'),
  ('00000000-0000-0000-0000-00000000b005', 'damaged',    'Damaged'),
  ('00000000-0000-0000-0000-00000000b006', 'adjustment', 'Count adjustments')
on conflict (id) do nothing;

-- ── 4. The items on the warehouse's WhatsApp list (15 and 16 Oct, VF74) ──────
-- Names and quantities as the list has them; the units it does not state are assumed (A-T60.2) and
-- the keeper can correct them until an item has moved. No stock is seeded: the first count, approved,
-- is the opening stock — the list is copied forward, not counted (VF74).
insert into inv_item (name, category, unit, step, icon, sort_order) values
  ('Oranges',           'oranges',        'carton', 1,   '🍊', 10),
  ('Big oranges',       'oranges',        'carton', 1,   '🍊', 11),
  ('Sorting oranges',   'oranges',        'carton', 1,   '🍊', 12),
  ('Sleeved cups',      'cups_packaging', 'pack',   1,   '🥤', 20),
  ('5-dirham cups',     'cups_packaging', 'box',    1,   '🥤', 21),
  ('Straws',            'cups_packaging', 'box',    0.5, '🥢', 22),
  ('Sealer',            'cups_packaging', 'piece',  1,   '🧷', 23),
  ('Glass bottles',     'cups_packaging', 'carton', 0.5, '🍶', 24),
  ('Gloves',            'consumable',     'box',    1,   '🧤', 30),
  ('Salt',              'consumable',     'box',    1,   '🧂', 31),
  ('Garbage bags',      'consumable',     'roll',   0.5, '🗑️', 32),
  ('Liquid detergent',  'cleaning',       'can',    1,   '🧴', 40),
  ('Handwash',          'cleaning',       'gallon', 1,   '🧼', 41),
  ('Floor cleaner',     'cleaning',       'can',    1,   '🧽', 42),
  ('D1',                'cleaning',       'can',    1,   '🧴', 43),
  ('D4',                'cleaning',       'can',    1,   '🧴', 44),
  ('Engine oil',        'vehicle',        'bottle', 1,   '🛢️', 50),
  ('Oil filter',        'vehicle',        'piece',  1,   '🔧', 51),
  ('Trolley belt',      'spare_part',     'piece',  1,   '🧰', 60)
on conflict ((lower(btrim(name)))) do nothing;

-- ── 5. The balance follows the moves, in the same transaction ───────────────
-- Not INSERT … ON CONFLICT DO UPDATE: Postgres checks a CHECK constraint on the row it PROPOSES to
-- insert before it looks for the conflict, so taking 4 from a place holding 20 would propose a row of
-- −4 and be refused (found by the TASK-060 tests, G195). Update first; insert only a place's first row.
create or replace function stock_balance_add(p_location uuid, p_item uuid, p_delta numeric) returns void
  language plpgsql
  set search_path = public
as $fn$
declare
  attempt integer := 0;
begin
  loop
    update stock_balance set qty = qty + p_delta, updated_at = now()
     where location_id = p_location and item_id = p_item;
    if found then
      return;
    end if;
    begin
      insert into stock_balance (location_id, item_id, qty, is_virtual)
      values (p_location, p_item, p_delta, (select is_virtual from inv_location where id = p_location));
      return;
    exception when unique_violation then
      -- Another transaction made this place's first row a moment ago: update it instead. Bounded:
      -- the row exists now, so the next UPDATE finds it.
      attempt := attempt + 1;
      if attempt >= 3 then
        raise;
      end if;
    end;
  end loop;
end;
$fn$;
revoke all on function stock_balance_add(uuid, uuid, numeric) from public;

create or replace function stock_move_apply() returns trigger
  language plpgsql
  set search_path = public
as $fn$
begin
  perform stock_balance_add(new.from_location_id, new.item_id, -new.qty);
  perform stock_balance_add(new.to_location_id, new.item_id, new.qty);
  return null;
end;
$fn$;

-- ── 6. What may never change ─────────────────────────────────────────────────
create or replace function inv_purging() returns boolean
  language sql stable
  as $fn$ select coalesce(current_setting('freshnow.ledger_purge', true), '') = 'on' $fn$;

-- Each item's balances recomputed from its moves — only inside a purge. The CHECK judges the result:
-- a purge that would leave a real place below zero (a delivery whose cartons went to someone whose
-- records stay) is refused whole.
create or replace function stock_balance_rebuild(p_items uuid[]) returns void
  language plpgsql
  set search_path = public
as $fn$
begin
  if not inv_purging() then
    raise exception 'stock balances are rebuilt only inside a purge' using errcode = 'P0001';
  end if;
  delete from stock_balance where item_id = any(p_items);
  insert into stock_balance (location_id, item_id, qty, is_virtual)
  select f.place, f.item_id, sum(f.qty), l.is_virtual
    from (select to_location_id as place, item_id, qty from stock_move where item_id = any(p_items)
          union all
          select from_location_id, item_id, -qty from stock_move where item_id = any(p_items)) f
    join inv_location l on l.id = f.place
   group by f.place, f.item_id, l.is_virtual;
end;
$fn$;
revoke all on function stock_balance_rebuild(uuid[]) from public;

-- The only way a ledger row is ever deleted: these documents (and any reversal of them) with their
-- lines, moves and photo links, then the balances of the items they moved rebuilt from what remains.
-- Deleting moves one by one could pass through states that never existed (a delivery removed before
-- the hand-out that used it), so balances are rebuilt once at the end instead. For practice runs only:
-- scripts/reset-employee.ts and the tests' clean-up.
create or replace function inv_purge_docs(p_docs uuid[]) returns integer
  language plpgsql
  set search_path = public
as $fn$
declare
  v_docs  uuid[];
  v_items uuid[];
begin
  perform set_config('freshnow.ledger_purge', 'on', true);
  select coalesce(array_agg(distinct id), '{}') into v_docs
    from stock_doc where id = any(p_docs) or reverses_doc_id = any(p_docs);
  select coalesce(array_agg(distinct item_id), '{}') into v_items from stock_move where doc_id = any(v_docs);
  delete from media_link where entity_type = 'stock_doc' and entity_id = any(v_docs);
  delete from stock_move where doc_id = any(v_docs);
  delete from stock_doc_line where doc_id = any(v_docs);
  delete from stock_doc where id = any(v_docs) and reverses_doc_id is not null;
  delete from stock_doc where id = any(v_docs);
  perform stock_balance_rebuild(v_items);
  perform set_config('freshnow.ledger_purge', 'off', true);
  return cardinality(v_docs);
end;
$fn$;
revoke all on function inv_purge_docs(uuid[]) from public;

-- Moves and document lines: never changed; deleted only by a purge.
create or replace function inv_ledger_guard() returns trigger
  language plpgsql
  set search_path = public
as $fn$
begin
  if tg_op = 'UPDATE' then
    raise exception '% rows are never changed: post a reversal instead', tg_table_name using errcode = 'P0001';
  end if;
  if not inv_purging() then
    raise exception '% rows are never deleted: post a reversal instead', tg_table_name using errcode = 'P0001';
  end if;
  return old;
end;
$fn$;

-- The balance is written by the ledger's own triggers (nested, depth 2) or by a purge — never directly.
create or replace function stock_balance_guard() returns trigger
  language plpgsql
  set search_path = public
as $fn$
begin
  if pg_trigger_depth() < 2 and not inv_purging() then
    raise exception 'stock_balance is kept by the ledger: post a stock document instead' using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end;
$fn$;

-- A document's content never changes. Its state moves forward only, along the handover's path or
-- from posted to reversed; who answered and who settled are filled in once.
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
      new.reason, new.note, new.supplier, new.invoice_no, new.machine_id, new.reverses_doc_id, new.count_session_id,
      new.device_at, new.recorded_at, new.request_hash, new.is_synthetic, new.correlation_id)
     is distinct from
     (old.id, old.kind, old.from_location_id, old.to_location_id, old.created_by, old.confirm_side, old.confirm_by,
      old.reason, old.note, old.supplier, old.invoice_no, old.machine_id, old.reverses_doc_id, old.count_session_id,
      old.device_at, old.recorded_at, old.request_hash, old.is_synthetic, old.correlation_id) then
    raise exception 'a stock document''s content is never changed: post a reversal instead' using errcode = 'P0001';
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

-- A count line: what was counted and what the ledger said are kept as handed in; the recount and the
-- decision are written once each.
create or replace function count_line_guard() returns trigger
  language plpgsql
  set search_path = public
as $fn$
begin
  if tg_op = 'DELETE' then
    if not inv_purging() then
      raise exception 'count lines are never deleted' using errcode = 'P0001';
    end if;
    return old;
  end if;
  if (new.session_id, new.item_id, new.counted_qty, new.expected_qty, new.moved_during)
     is distinct from (old.session_id, old.item_id, old.counted_qty, old.expected_qty, old.moved_during)
     or (old.recount_qty is not null and (new.recount_qty, new.recount_expected_qty, new.recount_moved_during)
         is distinct from (old.recount_qty, old.recount_expected_qty, old.recount_moved_during))
     or (old.decision is not null and (new.decision, new.decision_reason) is distinct from (old.decision, old.decision_reason)) then
    raise exception 'a count, once handed in, is never changed' using errcode = 'P0001';
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
  if new.state is distinct from old.state and not (
       (old.state = 'counting' and new.state in ('recount', 'approval', 'closed', 'cancelled'))
    or (old.state = 'recount' and new.state in ('approval', 'cancelled'))
    or (old.state = 'approval' and new.state = 'closed')) then
    raise exception 'a count cannot go from % to %', old.state, new.state using errcode = 'P0001';
  end if;
  return new;
end;
$fn$;

drop trigger if exists stock_move_apply on stock_move;
create trigger stock_move_apply after insert on stock_move for each row execute function stock_move_apply();
drop trigger if exists stock_move_guard on stock_move;
create trigger stock_move_guard before update or delete on stock_move for each row execute function inv_ledger_guard();
drop trigger if exists stock_doc_line_guard on stock_doc_line;
create trigger stock_doc_line_guard before update or delete on stock_doc_line for each row execute function inv_ledger_guard();
drop trigger if exists stock_balance_guard on stock_balance;
create trigger stock_balance_guard before insert or update or delete on stock_balance for each row execute function stock_balance_guard();
drop trigger if exists stock_doc_guard on stock_doc;
create trigger stock_doc_guard before update or delete on stock_doc for each row execute function stock_doc_guard();
drop trigger if exists count_line_guard on count_line;
create trigger count_line_guard before update or delete on count_line for each row execute function count_line_guard();
drop trigger if exists count_session_guard on count_session;
create trigger count_session_guard before update or delete on count_session for each row execute function count_session_guard();

-- ── 7. Photos on a delivery, a damage, a handover ────────────────────────────
alter table media_link drop constraint if exists media_link_entity_type_check;
alter table media_link add constraint media_link_entity_type_check check (entity_type in ('task', 'stock_doc'));

-- ── 8. Row security: read only, and only what the role allows ────────────────
do $$
declare
  t text;
begin
  foreach t in array array['inv_item', 'inv_location', 'stock_doc', 'stock_doc_line', 'stock_move', 'stock_balance', 'count_session', 'count_line']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists %I on %I', t || '_select', t);
    -- 0005's default privileges hand every new table insert/update/delete too. Row security already
    -- refuses them (there is no write policy), but the ledger is append-only by grant as well.
    execute format('revoke insert, update, delete, truncate on %I from freshnow_app', t);
    execute format('grant select on %I to freshnow_app', t);
  end loop;
end $$;

-- The catalogue and the places' names: everyone who holds or sees stock.
create policy inv_item_select on inv_item for select to freshnow_app
  using ((select app_has_capability('inventory.read')) or (select app_has_capability('inventory.hold')));
create policy inv_location_select on inv_location for select to freshnow_app
  using ((select app_has_capability('inventory.read')) or (select app_has_capability('inventory.hold')));

-- A document: everyone who sees all stock; otherwise the people it concerns — who made it, who must
-- confirm or confirmed it, and whoever's own stock it moves.
create policy stock_doc_select on stock_doc for select to freshnow_app
  using ((select app_has_capability('inventory.read'))
         or created_by = app_current_employee()
         or confirm_by = app_current_employee()
         or answered_by = app_current_employee()
         or exists (select 1 from inv_location l
                     where l.id in (from_location_id, to_location_id) and l.employee_id = app_current_employee()));
-- Lines and moves are seen with their document (the subquery runs under stock_doc's policy).
create policy stock_doc_line_select on stock_doc_line for select to freshnow_app
  using (exists (select 1 from stock_doc d where d.id = doc_id));
create policy stock_move_select on stock_move for select to freshnow_app
  using (exists (select 1 from stock_doc d where d.id = doc_id));
-- What a place holds: everyone who sees all stock, and each person their own.
create policy stock_balance_select on stock_balance for select to freshnow_app
  using ((select app_has_capability('inventory.read'))
         or exists (select 1 from inv_location l where l.id = location_id and l.employee_id = app_current_employee()));
-- Counts: the people who see all stock (the API leaves the ledger's figure out while a count is open).
create policy count_session_select on count_session for select to freshnow_app
  using ((select app_has_capability('inventory.read')));
create policy count_line_select on count_line for select to freshnow_app
  using ((select app_has_capability('inventory.read')));

-- ── 9. Live updates: the people a change concerns (0027) ─────────────────────
-- `c:<capability>` = everyone whose role holds it (live-audience.ts).
do $$
declare
  w record;
begin
  perform set_config('client_min_messages', 'warning', true);
  for w in
    select * from (values
      ('stock_doc', $s$select 'c:inventory.read'::text from changed
                       union select 's:' || created_by from changed
                       union select 's:' || confirm_by from changed where confirm_by is not null
                       union select 's:' || l.employee_id from changed c
                         join inv_location l on l.id in (c.from_location_id, c.to_location_id)
                        where l.employee_id is not null$s$),
      ('count_session', $s$select 'c:inventory.read'::text from changed$s$)
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
