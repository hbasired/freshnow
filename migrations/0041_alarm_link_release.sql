-- migrations/0041_alarm_link_release.sql — an alarm let go when its problem closed with its machine record switched off
-- (TASK-059 fixes, independent review of 20 Oct 2026, finding fixes-059#6)
--
-- A problem whose Televend record is switched off is closed (a retired record never reports its alarms resolved). If the
-- operator switches the same record back on while an alarm is still open, that alarm was already linked, so it was never
-- raised again: the machine showed as needing action with no problem behind it and nobody paged. Now the closing marks
-- the still-open links released; the alarm sync treats a released link as unlinked once the record is live, and re-links it
-- to the new problem (the link row is updated, never a second one made — one row per Televend event).

alter table machine_alarm add column if not exists released_at timestamptz;
