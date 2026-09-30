-- migrations/0018_progress_band.sql — a self-reported percentage may be a RANGE.
--
-- Employees asked to pick "10–20%" from a list rather than type an exact figure. That is
-- the more honest input: a person's estimate is a band, and a typed "15%" claims a
-- precision nobody measured. So the band is stored as the person gave it, and shown that
-- way everywhere ("10–20% · self-reported").
--
-- `progress_pct` still holds ONE number, because every rollup (project progress, the
-- behind flag, averages) is arithmetic over it. For a band that number is the MIDPOINT —
-- the unbiased single value when nothing says where inside the band the work sits. The
-- band beside it says the number is an estimate within a range, not a measurement.
--
-- Only self-reported progress has a band. Counted (steps) and status-derived progress are
-- exact by construction, and the code clears the band whenever it recomputes from them.

alter table task
  add column if not exists progress_band_low  int,
  add column if not exists progress_band_high int;

alter table progress_event
  add column if not exists band_low  int,
  add column if not exists band_high int;

-- Both ends or neither; a real range inside 0–100; the stored number inside it. A band on
-- a percentage that did not come from a person is a contradiction, so it is refused.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'task_progress_band_ck') then
    alter table task add constraint task_progress_band_ck check (
      (progress_band_low is null and progress_band_high is null)
      or (progress_source = 'self_reported'
          and progress_band_low >= 0 and progress_band_high <= 100
          and progress_band_low < progress_band_high
          and progress_pct between progress_band_low and progress_band_high)
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'progress_event_band_ck') then
    alter table progress_event add constraint progress_event_band_ck check (
      (band_low is null and band_high is null)
      or (source = 'self_reported'
          and band_low >= 0 and band_high <= 100
          and band_low < band_high
          and pct between band_low and band_high)
    );
  end if;
end $$;
