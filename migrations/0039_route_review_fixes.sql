-- migrations/0039_route_review_fixes.sql — route plans: fixes from the independent review of 20 Oct 2026 (TASK-061 part 2)
--
-- 1. A visited stop keeps its machine — in the database too (review routes#2). savePlan refused changing a visited stop's
--    machine only for stops still on the plan; a stop taken off and then sent again with its old id came back with another
--    machine, and the visit made at the first machine then "carried out" the second. The guard also closes the race between
--    a planner's save and a visit starting at that stop (startVisit locks the stop it picks, FOR SHARE, until it commits).
--    A stop also stays on its plan.
--
-- 2. Who wrote a plan's note and a stop's instructions (review routes#9). Erasure and the person's own download keyed on the
--    plan's creator, but whoever saves a plan writes its words, and copying a plan copies them under the copier. The author is
--    kept beside the words: set when the words change, carried over when a plan is copied. Rows already there are given the
--    plan's creator — the best that can be said for them (all are test or demo rows so far: the Route portal is not in use).

create or replace function route_stop_guard() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.plan_id is distinct from old.plan_id then
    raise exception 'route_stop: a stop stays on its plan' using errcode = 'check_violation';
  end if;
  if new.machine_id is distinct from old.machine_id and exists (select 1 from visit v where v.stop_id = old.id) then
    raise exception 'route_stop: a visited stop keeps its machine — take it off and add a new one' using errcode = 'check_violation';
  end if;
  return new;
end
$$;

drop trigger if exists route_stop_guard on route_stop;
create trigger route_stop_guard before update on route_stop for each row execute function route_stop_guard();

alter table route_plan add column if not exists note_by uuid references employee (id);
alter table route_stop add column if not exists instructions_by uuid references employee (id);

update route_plan set note_by = created_by where note is not null and note_by is null;
update route_stop s set instructions_by = p.created_by
  from route_plan p
 where p.id = s.plan_id and s.instructions is not null and s.instructions_by is null;
