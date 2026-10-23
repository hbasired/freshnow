-- migrations/0024_televend_refill_identity.sql — a second identity for refills read from Televend's API
-- (TASK-056, after review on 2026-10-15).
--
-- tv_refill.natural_key (0023) is the identity SHARED with the portal's exports: asset number from the
-- machine's name + time to the second + column + action word + quantity, so the same refill read from
-- the API and from a CSV is one row. Two things change that key for a row the API has already given us:
--
--   * the number in the machine record's name changes (a record re-used for another physical machine —
--     placeMachine handles it), and every refill re-read afterwards is keyed with the new number;
--   * a refill code that had no meaning yet ("unknown", G161) is mapped, and every re-read row gets the
--     new action word.
--
-- Either way the re-read row had a new natural_key and was stored a second time. Televend's own identity
-- of an API row never changes: the machine record, the exact timestamp (milliseconds, as read), the
-- column, the raw refill code and the quantity. This index makes that identity unique too; the sync's
-- `on conflict do nothing` (no target) then skips a re-read row that matches either identity.
-- Checked before adding it: no stored row violates it (2026-10-15).

create unique index if not exists uq_tv_refill_api_identity
  on tv_refill (machine_tv_id, at, coalesce(column_no, -1), (raw ->> 'fill_type'), quantity_change)
  where source in ('bridge', 'official') and machine_tv_id is not null;

-- Rows whose code or origin had no meaning when stored; the sync re-reads them against the current
-- code tables on every refill read (remapUnknownRefills), so the table is tiny to scan.
create index if not exists idx_tv_refill_unknown on tv_refill (id) where action = 'unknown' or origin = 'unknown';
