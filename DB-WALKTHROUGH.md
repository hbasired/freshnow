# Database Walkthrough — following one person through the tables

_Updated 2026-09-19 for the Supabase database (16 migrations, 36 tables, 2 views). Every query
below was run against the live database today._

The tables make sense once you follow **one person** through them. Use any of the DEMO
staff (`DEMO – Priya Nair`, `DEMO – Ahmed Khan`, …) or a real person you registered.

## Where to type queries

| Tool | Address | Log in as |
|---|---|---|
| **Supabase Studio** (easiest) | http://localhost:54323 → **SQL Editor** | no login on the local stack |
| **psql** from a terminal | `docker exec -it supabase_db_freshnow psql -U postgres -d postgres` | `postgres` |
| One-off query | `docker exec supabase_db_freshnow psql -U postgres -d postgres -c "select count(*) from employee;"` | `postgres` |

> **Adminer at http://localhost:8080 is the OLD database** (`freshnow-db`, port 5433), kept as a
> rollback copy since 2026-09-11. It does not have the new tables. Do not use it for anything
> below.

The `postgres` login you use here bypasses row-level security — you see everything. The
application logs in as `freshnow_app` and sees only what the current person may see (§ "Who
may see what").

---

## The mental model — the chain, then the rings around it

Everything still follows one chain:

```
employee  ──►  task  ──►  task_update  ──►  blocker  ──►  alert / escalation  ──►  notification_outbox
 (who)        (what)      (what they       (a problem     (who must be told,     (the message that
                           SAID + status)   found in it)   and when it climbs)    actually goes out)
```

Around that chain, added since the first version of this guide:

| Ring | Tables | One sentence |
|---|---|---|
| **Org** | `employee.access_role`, `employee.manager_employee_id` | Who reports to whom, and whether someone is CEO / manager / lead / employee. This drives what every person may see. |
| **Task depth** | `task_status`, `task_step`, `task_relation`, `progress_event` | Checklists, progress that is *counted* from steps (or self-reported with a mandatory note), task links, and an append-only progress history. |
| **Alerting** | `sla_policy`, `escalation_policy` → `escalation_level` → `escalation_target`, `alert`, `task_watcher`, `notification_pref` | How long a problem may wait, the ladder it climbs, de-duplication of repeats, who watches what, how each person wants to be told. |
| **Projects** | `project`, `project_requirement`, `milestone`, `project_member`, `project_update`, `project_issue` + views `project_progress`, `flow_metrics` | The second portal. Progress is computed by the views, never typed. |
| **Evidence** | `audit_log`, `run_trace`, `llm_call`, `consent_record`, `job_run` | What happened, what each step consumed, what the model cost, what the person agreed to. |
| **Plumbing** | `notification_outbox`, `bot_session`, `invite_code`, `attachment`, `voice_asset`, `daily_report`, `schema_migrations` | Delivery, conversation state, onboarding, files, voice, EOD, migrations. |

> **`task_update.note_raw` is still the single most important column.** It holds exactly what
> the person typed or said. It is never rewritten by the system — only aged out by the
> retention sweep (when `RETENTION_DAYS` is set) or replaced by `[erased]` when a person is
> anonymised.

---

## Step 1 — Find the person

```sql
select id, display_name, access_role, manager_employee_id, department, role_title, site, shift, status, telegram_user_id
from employee
where display_name ilike '%priya%';
```

**Use `ilike '%name%'`, never `= 'name'`.** `=` is case-sensitive. Demo names are stored as
`DEMO – Priya Nair` (with an en-dash), so a partial match is the only sane match.

Two columns that did not exist before:

- `access_role` — `ceo` · `manager` · `lead` · `employee`. Set on the dashboard's People tab.
- `manager_employee_id` — who they report to. A manager sees their reports; a lead sees their
  reports **and** their department. Both are enforced by the database (next section), and the
  Telegram bot reads the same column to decide who gets the manager menu.

Copy the `id` — it is the thread through every other table.

## Who may see what — test it as the app, not as yourself

As `postgres` you see everything, so a query proves nothing about access. Run it as the
application role with a person's context set. From a terminal (the password is the one in
`DATABASE_URL` in `.env`):

```bash
docker exec -e PGPASSWORD=<freshnow_app password> supabase_db_freshnow \
  psql -h 127.0.0.1 -U freshnow_app -d postgres -Atc "
begin;
  select set_config('app.employee_id', '<uuid of Priya>', true);
  select set_config('app.is_ceo', 'off', true);
  select set_config('app.access_role', 'employee', true);
  select count(*) from employee;   -- 1: herself
  select count(*) from task;       -- only her tasks
commit;"
```

Verified today: with no context the app role sees **0** employees; as the CEO it sees all 7;
as Priya it sees 1 employee and 1 task. One function, `app_can_view_employee(target)`, holds
the whole rule (migration 0009) — the code's `canAssignTo` is its TypeScript twin.

---

## Step 2 — What work does she have, and how far along is it?

```sql
select t.id, t.title, t.status, t.priority, t.progress_pct, t.progress_source, t.due_at, t.resolution, t.created_at
from task t
join employee e on e.id = t.employee_id
where e.display_name ilike '%priya%'
order by t.created_at desc;
```

`task.status` is the task's own state (`open`, `in_progress`, `done`, `cancelled` …); the
lookup table `task_status` maps each to a category (to do / in progress / done) that reporting
runs on. `resolution` says *why* it stopped (`done`, `wont_do`, `duplicate`, `cancelled`) and
is set only when it does. Neither is what she said about it — that is the next table.

`progress_pct` comes with `progress_source`:

- `counted` — computed from `task_step` rows (done ÷ total). Trust it.
- `status` — derived from the status's `task_status.pct_when_here`.
- `self_reported` — a person typed a number; the note they had to give is in `progress_note`
  and the full history is in `progress_event`. The dashboard labels it as such.

```sql
select s.title, s.done, s.done_at from task_step s where s.task_id = '<task id>' order by s.position;
select pct, source, note, created_at from progress_event where task_id = '<task id>' order by created_at;
```

---

## Step 3 — What did she actually report? ⭐

```sql
select to_char(u.submitted_at at time zone 'Asia/Dubai', 'DD Mon HH24:MI') as at_dubai,
       u.status,
       u.channel,                                -- 'telegram' or 'web'
       coalesce(t.title, '(general update)')     as task,
       u.note_raw                                as her_exact_words,
       u.note_parsed->>'summary'                 as system_understood_it_as,
       u.note_parsed->>'needs_review'            as needs_human
from task_update u
join employee e on e.id = u.employee_id
left join task t on t.id = u.task_id
where e.display_name ilike '%priya%'
order by u.submitted_at;
```

- A tap with no words has `note_raw` **null**. Normal.
- `channel` tells you whether it came from the bot or the browser — both land here, same shape.
- `needs_review = true` means the model could not understand it and a human was alerted.
- All timestamps are stored in UTC (`timestamptz`); render them in Dubai time as above.

### `left join`, not `join`

`task_id` is nullable — a general update has no task. An inner `join task` silently drops
exactly those rows, which is how "what did she say?" once came back empty although her words
were in the table.

---

## Step 4 — Did anything become a problem, and who must fix it?

```sql
select b.severity, b.category, b.status,
       coalesce(b.affected_asset, b.risk) as summary,
       raiser.display_name   as raised_by,
       resolver.display_name as must_fix,
       b.raised_at, b.sla_due_at, b.resolved_at, b.resolved_by, b.alert_id, b.correlation_id
from blocker b
join employee raiser        on raiser.id   = b.raised_by
left join employee resolver on resolver.id = b.assigned_resolver
where raiser.display_name ilike '%priya%'
order by b.raised_at desc;
```

`employee` is joined **twice** with different aliases: who reported it and who must fix it. One
alias gets you the wrong answer — which is why `semantic/schema.yaml` spells this join out for
the question box.

**Why that resolver?** Routing is a table lookup, most specific rule first:

```sql
select coalesce(r.category,'*') as category, coalesce(r.site,'*') as site, coalesce(r.shift,'*') as shift,
       e.display_name as resolver
from routing_rule r join employee e on e.id = r.resolver_employee_id
order by r.category nulls last, r.site nulls last, r.shift nulls last;
```

Today every rule points at the CEO — the company has not supplied its own table yet. A rule
naming category + site + shift beats one naming category alone; `*` means "any".

**How long may it wait?** `sla_policy` — critical 15 min, high 60, medium 240, low 1440
(placeholders until FreshNow supplies real ones). **Where does it climb?** The ladder:

```sql
select p.name, l.level_no, l.timeout_minutes, t.target_type
from escalation_policy p
join escalation_level l on l.policy_id = p.id
join escalation_target t on t.level_id = l.id
order by p.name, l.level_no;
```

Level 1 tells the resolver and the raiser's manager; after 30 minutes unacknowledged it
reaches the CEO; after 60 the CEO again. Targets are symbolic (`resolver`,
`manager_of_raiser`, `ceo`) so the ladder survives staff changes.

---

## Step 5 — Was anyone told?

```sql
select o.created_at, o.channel, o.status, o.attempts,
       r.display_name as recipient,
       o.reason,
       left(o.payload->>'text', 70) as message
from notification_outbox o
left join employee r on r.id = o.recipient_employee_id
order by o.created_at desc
limit 15;
```

`channel`: `telegram` (delivered by the worker to the phone) or `inapp` (the dashboard bell) —
a linked person gets both. `status`: `pending` = waiting for the worker · `sent` · `abandoned`
= retried to the cap and given up (audited as `notification.abandoned`; that message was never
received).

**Repeats are counted, not re-sent.** The `alert` table de-duplicates on `alias`:

```sql
select alias, kind, state, count, first_seen, last_seen, acked_by, acked_at from alert order by last_seen desc limit 10;
```

---

## Step 6 — The full story of one run

Every action in one run shares a `correlation_id`. Get one from any blocker or update, then:

```sql
select created_at, actor, action, entity, entity_id
from audit_log
where correlation_id = '<paste-it-here>'
order by created_at;
```

Then what each step consumed — this is what makes a run *replayable*, not merely logged:

```sql
select step, input, output, created_at
from run_trace
where correlation_id = '<paste-it-here>'
order by created_at;
```

And what the model cost:

```sql
select provider, model, prompt_tokens, completion_tokens, cost_usd, latency_ms, success
from llm_call where correlation_id = '<paste-it-here>';
```

`cost_usd` is real for `openai/gpt-oss-120b` (the pricing table has it); a model without a
price row logs 0 and a warning, once.

---

## One query for the whole picture of a person

```sql
select
  e.display_name,
  t.title                                                     as task,
  t.status                                                    as task_status,
  to_char(u.submitted_at at time zone 'Asia/Dubai','DD Mon HH24:MI') as reported_at,
  u.status                                                    as reported,
  u.channel,
  u.note_raw                                                  as their_words,
  b.severity                                                  as problem_severity,
  b.category                                                  as problem_category
from employee e
left join task_update u on u.employee_id = e.id
left join task        t on t.id = u.task_id
left join blocker     b on b.task_update_id = u.id
where e.display_name ilike '%priya%'
order by u.submitted_at desc nulls last;
```

All `left join` — you still see the person with no updates, the update with no task, the task
with no problem.

## Everyone's day at a glance

```sql
select e.display_name,
       count(u.id)                                    as reports_today,
       count(u.note_raw)                              as with_words,
       count(*) filter (where u.status = 'blocker')   as blockers_reported
from employee e
left join task_update u
       on u.employee_id = e.id
      and u.submitted_at >= (current_date at time zone 'Asia/Dubai')
where e.status = 'active'
group by e.display_name
order by reports_today desc, e.display_name;
```

## A project's real progress (the second portal)

```sql
select * from project_progress;   -- tasks done/total, per-milestone completion, schedule elapsed, behind/ahead
select * from flow_metrics;       -- work-item age, cycle-time p50/p85/p95, throughput, WIP, blocked time
```

Both are views with `security_invoker` on, so they respect the same row-level rules as the
tables under them. Nobody types a percentage into either.

---

## Which table answers which question

| You want to know | Look at |
|---|---|
| Who works here, who reports to whom, who is a manager | `employee` (`access_role`, `manager_employee_id`) |
| What someone is meant to be doing, and how far along | `task` (`progress_pct` + `progress_source`), `task_step` |
| **What someone actually said** | **`task_update.note_raw`** |
| What the AI understood | `task_update.note_parsed->>'summary'` |
| What went wrong | `blocker` |
| Who must fix it, and why them | `blocker.assigned_resolver` + `routing_rule` |
| How long it may wait, where it climbs | `sla_policy`, `escalation_policy/level/target`, `escalation` |
| Whether a repeat was sent again or counted | `alert` (`alias`, `count`) |
| Whether someone was told, on which channel | `notification_outbox` (`channel`, `status`, `recipient_employee_id`) |
| How a person wants to be told | `notification_pref` |
| What happened, in order | `audit_log` (by `correlation_id`) |
| What each step consumed — for replay | `run_trace` |
| What the AI cost / how slow | `llm_call` |
| Whether they consented, and to which wording | `consent_record` (`policy_version`, `notice_hash`) |
| Which question the bot is mid-way through | `bot_session` |
| A project's needs, milestones, issues, progress | `project*`, `milestone`, `project_progress`, `flow_metrics` |
| Which migrations have run | `schema_migrations` (`name`, `applied_at`) |

---

## The four traps

1. **`= 'name'` is case-sensitive.** Always `ilike '%name%'`.
2. **`task_id` is nullable.** Use `left join task`, or you drop general updates — often the
   ones carrying the words.
3. **`task.status` ≠ what they said.** The status is a button tap; the words are in
   `task_update.note_raw`.
4. **You are `postgres` and see everything.** To know what a *person* sees, run as
   `freshnow_app` with their context (above). Adminer on :8080 is the old database.

## Never edit these

`audit_log` · `consent_record` · `run_trace` · `progress_event` · `schema_migrations` · and
never `note_raw` or `transcript_raw` — those are a person's own words. The application role
physically cannot (verified: `permission denied for table audit_log`; a forged actor is refused
by trigger). You, as `postgres`, can — which is exactly why you should not.
Full rules in `BACKEND-OPERATIONS.md`.
