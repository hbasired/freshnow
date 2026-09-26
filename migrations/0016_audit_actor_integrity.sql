-- migrations/0016_audit_actor_integrity.sql — the audit log's actor must be who it says.
--
-- `audit_log` is append-only against TAMPERING: the app role has INSERT and SELECT only, and
-- both UPDATE and DELETE fail at the grant (verified live, 2026-09-18). It was NOT append-only
-- against FABRICATION: the INSERT policy was `with check (true)`, so anything issuing SQL on
-- the app connection could write
--
--   insert into audit_log (actor, action, ...) values ('employee:<the CEO>', 'ceo.approved_x', ...)
--
-- and it would stand forever, indistinguishable from the real thing. `rate-limit.ts` also
-- counts abuse from `audit_log` keyed on actor, so a forged actor was a rate-limit evasion.
-- Every app-role write in the codebase is parameterised, so this was not reachable today;
-- it is defence in depth, and the audit log is the one table where that is not optional.
--
-- The rule: on the APP connection, the actor must be the session's own employee (or
-- `system` when acting with no employee context, which the sweeps do through the service
-- role anyway). The SERVICE role may write any actor, because core writes on behalf of the
-- person a verified request identified — that trust is placed in the API's auth hook, which
-- is where identity is actually established.

create or replace function audit_log_actor_guard() returns trigger
  language plpgsql set search_path = public, pg_temp as $fn$
declare
  me uuid;
begin
  -- The service role (BYPASSRLS, used by core) writes the actor the API verified.
  -- `session_user`, not `current_user`: see migration 0014 / gotcha G92.
  if pg_has_role(session_user, 'postgres', 'member') then
    return new;
  end if;

  me := app_current_employee();

  -- An app-role session with no employee context may only write as `system`.
  if me is null then
    if new.actor is distinct from 'system' then
      raise exception 'audit_log: an app session with no employee context may only act as system (got %)', new.actor
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- An app-role session with an employee context may write as itself, or as system.
  if new.actor is distinct from ('employee:' || me::text) and new.actor is distinct from 'system' then
    raise exception 'audit_log: actor % does not match the session employee %', new.actor, me
      using errcode = '42501';
  end if;
  return new;
end;
$fn$;

drop trigger if exists audit_log_actor_integrity on audit_log;
create trigger audit_log_actor_integrity
  before insert on audit_log
  for each row execute function audit_log_actor_guard();
