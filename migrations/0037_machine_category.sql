-- migrations/0037_machine_category.sql — FreshNow's corrections to a machine's category (TASK-070)
--
-- The analytics group machines by category — Hospital / Clinics, Metro, Shopping Mall / Complex, Events (the Expo
-- machines), Office Buildings, Tram, Shopping Centers, Other stations, Parks. That is Televend's "region", the user's
-- choice on 19 Oct (D248): "Televend + our fixes". Some machines sit in the wrong region in Televend (a Sharjah clinic
-- and Sharjah Police are filed under Events), so FreshNow keeps its own correction here, on its own machine record.
-- Televend is never changed: the mirror (tv_machine) stays Televend's word, this column is ours.
--
-- A correction may also take a machine out of the figures ("Not counted" — a test machine in the warehouse), so a
-- machine that sells nothing because it is not in public does not pull the fleet average down.
--
-- ── WHO ───────────────────────────────────────────────────────────────────
--   machines.manage   corrects a machine's details in FreshNow (its category)      Ops Head, CEO, Admin
-- Reading stays as it was: machine rows are read with televend.read (0025). Writes go through core on the service
-- role, which checks machines.manage and audits each change.

-- ── 1. Who may do what (the SQL copy of permissions.ts) ──────────────────────
insert into role_capability (role, capability) values
  ('ceo', 'machines.manage'),
  ('admin', 'machines.manage'),
  ('ops_head', 'machines.manage')
on conflict do nothing;

-- ── 2. The correction, with who made it, when and why ───────────────────────
alter table machine add column if not exists category_override text
  check (category_override is null or length(btrim(category_override)) between 1 and 60);
alter table machine add column if not exists category_note text
  check (category_note is null or length(category_note) <= 300);
alter table machine add column if not exists category_set_by uuid references employee (id);
alter table machine add column if not exists category_set_at timestamptz;
