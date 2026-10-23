-- migrations/0040_stock_review_fixes.sql — the stock ledger: fixes from the independent review of 20 Oct 2026 (TASK-060, 057)
--
-- 1. A photo on a stock document is seen by whoever may read the document (review roles#1). 0032 let photos be attached to
--    stock documents but gave them no reading rule of their own, so 0026's rule applied: only those who may see the sender.
--    The driver confirming the keeper's handover, the keeper confirming a driver's return with a photo of the damage, and the
--    Ops Head settling a dispute or reversing a delivery saw "no photos" — and decided without the evidence. The function
--    repeats stock_doc_select's own rule (it runs as its owner, so it cannot lean on that policy): whoever sees all stock, the
--    people who made, confirm or answered it, and the people whose own stock it moves.
--
-- 2. A move's time is when it was posted under its item's lock, not when its transaction began (review 060-fixes#6). Counting
--    asks "was this item corrected on the books after it was counted?" by comparing times: with transaction start times, a
--    decision that began before a count's hand-in but posted after it looked older than the count, and the same gap could be
--    corrected twice. clock_timestamp() is read when the row is written — under the item lock — so the order of times is the
--    order of the lock. (The count's own hand-in and recount times are set the same way, after its ledger read.)

alter table stock_move alter column posted_at set default clock_timestamp();

create or replace function app_media_on_stock_doc(p_media uuid) returns boolean
  language sql stable security definer
  set search_path = pg_catalog, public, pg_temp
as $fn$
  select exists (
    select 1
      from media_link l
      join stock_doc d on d.id = l.entity_id
     where l.media_id = p_media and l.entity_type = 'stock_doc'
       and (app_has_capability('inventory.read')
            or d.created_by = app_current_employee()
            or d.confirm_by = app_current_employee()
            or d.answered_by = app_current_employee()
            or exists (select 1 from inv_location il
                        where il.id in (d.from_location_id, d.to_location_id) and il.employee_id = app_current_employee())))
$fn$;
revoke all on function app_media_on_stock_doc(uuid) from public;
grant execute on function app_media_on_stock_doc(uuid) to freshnow_app;

alter policy media_object_select on media_object
  using ((select app_reads_all()) or app_can_view_employee(uploaded_by) or app_media_on_cash_doc(id) or app_media_on_visit(id)
         or app_media_on_stock_doc(id));
