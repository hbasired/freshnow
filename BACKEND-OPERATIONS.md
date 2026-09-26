# FreshNow — Backend Operations Guide

_Updated 2026-09-19. Everything an operator can do behind the bot and the dashboard: inspect
the database, change data safely, trace what happened, replay a decision, back up and
restore, and know what must never be touched. Every command marked **verified** was run
against this system today, not written from memory._

---

## 1. Three ways in

The live database is **Supabase Postgres** on `127.0.0.1:54322`, database `postgres`.

### A. Supabase Studio — browser (easiest)

http://localhost:54323 → **Table Editor** to click through rows, **SQL Editor** to paste any
query in this guide. No login on the local stack.

### B. psql — command line **(verified)**

```bash
docker exec -it supabase_db_freshnow psql -U postgres -d postgres          # interactive
docker exec supabase_db_freshnow psql -U postgres -d postgres -c "select count(*) from blocker;"
```

Inside psql: `\dt` list tables · `\d employee` describe · `\x` wide output · `\q` quit.

### C. Any GUI client (DBeaver, TablePlus, pgAdmin)

Host `127.0.0.1` · Port **54322** · Database `postgres` · User `postgres` · Password: the one in
`DATABASE_URL_SERVICE` in `.env`.

> **Adminer at http://localhost:8080 is the OLD database** (`freshnow-db`, port 5433, user
> `freshnow`) — kept only as a rollback copy from before 2026-09-11. It has none of the tables
> added since. Nothing in this guide applies to it.
>
> **Redis is on 6380** (another project on this PC holds 6379). The worker's SLA timers and
> the `/health` endpoint's `redis` probe use it.

---

## 2. The two database roles — read this before changing anything

| Role | Bypasses RLS? | Sees | Used by |
|---|---|---|---|
| **`postgres`** | yes (`BYPASSRLS`, **not** a superuser on Supabase) | everything | you (operator), migrations, seed, the worker and the API's service writes |
| **`freshnow_app`** | no — row-level security enforced, default deny | only what the current person may see | the API's reads, the question box, RLS tests |

Verified today as the real app role (password from `DATABASE_URL` in `.env`):

```bash
A="docker exec -e PGPASSWORD=<app password> supabase_db_freshnow psql -h 127.0.0.1 -U freshnow_app -d postgres -Atc"

$A "select count(*) from employee"                                  # -> 0   (no context: nothing)
$A "begin; select set_config('app.is_ceo','on',true); select count(*) from employee; commit;"   # -> 7
```

To see exactly what one person sees:

```sql
begin;
  select set_config('app.employee_id', '<employee uuid>', true);
  select set_config('app.is_ceo', 'off', true);
  select set_config('app.access_role', 'employee', true);   -- or 'manager' / 'lead'
  select set_config('app.department', '', true);            -- the lead's department, if any
  select count(*) from employee;  select count(*) from task;
commit;
```

As Priya (an employee) today: 1 employee, 1 task. The whole rule lives in one SQL function,
`app_can_view_employee(target)` (migration 0009): CEO → everyone; manager → their direct
reports; lead → their reports plus their department; everyone → themselves. `canAssignTo` in
`packages/core/src/org.ts` is the same rule for writes, which run as `postgres` and therefore
get no help from RLS — every write route checks it explicitly.

> The app role cannot connect over the Unix socket (peer auth) — always `-h 127.0.0.1`.

---

## 3. What each table holds

36 tables and 2 views (migrations 0001–0016). Grouped by what they are for.

**The chain**

| Table | What it is | Safe to edit? |
|---|---|---|
| `employee` | People. `access_role` (ceo/manager/lead/employee), `manager_employee_id`, `department`, `site`, `shift`, `telegram_user_id` (bigint), `auth_user_id` (dashboard login). | ✅ yes — but role and manager changes should go through the People tab so they are audited |
| `task` | Work. `status`, `resolution`, `priority`, `due_at`, `progress_pct` + `progress_source`, `parent_task_id`, `project_id`, `milestone_id`. | ✅ yes |
| `task_update` | Each report. **`note_raw` = their exact words**, `note_parsed` = what the model understood, `channel` (telegram/web), `correlation_id`. | ⚠️ never edit `note_raw` / `note_parsed` |
| `blocker` | A problem extracted from an update. `assigned_resolver`, `sla_due_at`, `resolved_by`, `resolution_note`, `alert_id`. | ✅ status/resolution only |
| `escalation` | Each rung climbed, with `correlation_id`. | ⚠️ read-only in practice |
| `assignment` | Who gave work to whom. | ✅ yes |
| `daily_report` | End-of-day per person per day; the model's narrative is gate-checked. | ✅ regenerate rather than edit |

**Task depth (0010)**: `task_status` (lookup: key → category → `pct_when_here`), `task_step`
(checklists), `task_relation` (blocks / precedes / relates / duplicates; inverse written
automatically; max 30), `progress_event` (append-only progress history — ❌ never edit).

**Alerting (0011)**: `sla_policy` (severity → minutes — **the SLA dial, editable**),
`escalation_policy` → `escalation_level` (`timeout_minutes`) → `escalation_target`
(`target_type`: resolver / manager_of_raiser / department_lead / ceo / employee),
`alert` (de-dup by `alias`; `count`, `state`, `acked_by`), `task_watcher`, `notification_pref`.

**Projects (0012)**: `project`, `project_requirement`, `milestone`, `project_member`,
`project_update` (append-only status log), `project_issue`; views `project_progress` and
`flow_metrics` (computed, `security_invoker`).

**Evidence**

| Table | What it is | Safe to edit? |
|---|---|---|
| `audit_log` | Append-only record of every change, with `correlation_id`. Actor is tied to the session by trigger (0016). | ❌ **never** |
| `run_trace` | What each step consumed and produced — replay reads this. Append-only. | ❌ never |
| `llm_call` | Every model call: provider, model, tokens, `cost_usd`, latency, success. | ❌ never |
| `consent_record` | PDPL consent: `policy_version` + hash of the exact notice shown. | ❌ **never** — legal record |
| `job_run` | Background job outcomes. | ❌ never |

**Plumbing**: `notification_outbox` (`channel` telegram/inapp, `status`, `attempts`,
`recipient_employee_id`, `reason`, `read_at` — ✅ status only), `bot_session` (✅ safe to delete
a row: resets one chat), `invite_code` (✅), `attachment`, `voice_asset` (⚠️ don't edit
transcripts), `schema_migrations` (❌ never; columns `name`, `applied_at`).

**Telling real from demo:** every business table has `is_synthetic`. `true` = seeded demo
row (badged DEMO in the dashboard). Never present a synthetic row as a company fact.

---

## 4. Reading and inspecting **(verified)**

**System health at a glance**

```sql
select 'employees' t, count(*) from employee where status = 'active'
union all select 'open blockers', count(*) from blocker where status='open'
union all select 'open alerts', count(*) from alert where state <> 'resolved'
union all select 'tasks to do', count(*) from task where status not in ('done','cancelled')
union all select 'outbox pending', count(*) from notification_outbox where status='pending'
union all select 'needs human review', count(*) from task_update where note_parsed->>'needs_review'='true';
```

Or, without SQL: `curl http://localhost:3001/health` → `db`, `redis`, load, tracing and
trace-write counters, in one JSON.

**Every blocker, who raised it and who must fix it** — `employee` joined twice:

```sql
select b.severity, b.category, raiser.display_name as raised_by, resolver.display_name as must_fix,
       b.status, b.raised_at, b.sla_due_at
from blocker b
join employee raiser on raiser.id = b.raised_by
left join employee resolver on resolver.id = b.assigned_resolver
order by b.raised_at desc;
```

**What one person actually said** (their own words, never rewritten)

```sql
select u.submitted_at, u.channel, u.status, u.note_raw, u.note_parsed->>'summary' as understood_as
from task_update u join employee e on e.id = u.employee_id
where e.display_name ilike '%ahmed%'
order by u.submitted_at desc;
```

**Messages the system could not understand** (these need a human)

```sql
select u.submitted_at, e.display_name, u.note_raw
from task_update u join employee e on e.id = u.employee_id
where u.note_parsed->>'needs_review' = 'true'
order by u.submitted_at desc;
```

**Who is a manager, and who reports to them**

```sql
select e.display_name, e.access_role, m.display_name as reports_to, e.department
from employee e left join employee m on m.id = e.manager_employee_id
where e.status = 'active' order by e.access_role, e.display_name;
```

---

## 5. Changing data safely

Prefer the dashboard for anything a person did — it is audited with who did it. Use SQL for
operator fixes. **Always `select` first, always with a `where`.**

**Fix a person's details**

```sql
select id, display_name, department, site, shift from employee where display_name ilike '%ahmed%';
update employee set department = 'production', site = 'warehouse', shift = 'day' where id = '<uuid>';
```

**Roles and reporting lines** — do these on the dashboard's **People** tab (CEO sign-in), not
in SQL: the API checks the loop guard and writes `employee.org_updated` with before/after.
The Telegram bot reads the same column, so a manager made on the dashboard gets the manager
menu on their next message. If you must do it in SQL, the cycle guard trigger (0009) still
refuses a loop, and the privilege trigger (0014) refuses self-promotion from the app role.

**Change who a blocker category routes to** (the main operational dial)

```sql
select coalesce(r.category,'*') category, coalesce(r.site,'*') site, coalesce(r.shift,'*') shift, e.display_name resolver
from routing_rule r join employee e on e.id = r.resolver_employee_id order by 1,2,3;

-- equipment problems at the warehouse, day shift → a specific person
insert into routing_rule (category, site, shift, resolver_employee_id)
values ('equipment', 'warehouse', 'day', (select id from employee where display_name ilike '%ahmed%'));
```

Most specific rule wins (category + site + shift beats category alone; `null` = any). This is
a data change, not a code change: the next blocker routes differently, and "why did this go
to Ahmed?" is answered by that row. Replay re-derives past decisions from what was recorded
at the time, so changing the table does not rewrite history.

**Change the SLA windows** — now a table, not code:

```sql
select severity, minutes from sla_policy order by minutes;
update sla_policy set minutes = 30 where severity = 'high';   -- takes effect on the next blocker
```

Today: critical 15 · high 60 · medium 240 · low 1440 — placeholders until FreshNow supplies
real ones (`docs/WHAT-WE-NEED-FROM-FRESHNOW.md` §1).

**Change the escalation ladder**

```sql
select p.name, l.level_no, l.timeout_minutes, t.target_type
from escalation_policy p join escalation_level l on l.policy_id = p.id
join escalation_target t on t.level_id = l.id order by p.name, l.level_no;
update escalation_level set timeout_minutes = 45 where level_no = 2;
```

Targets are symbolic; a level with nobody available is skipped, never dropped.

**Resolve a blocker** — prefer the dashboard (note required, resolver recorded). SQL:

```sql
update blocker set status='resolved', resolved_at=now(), resolution_note='<why>' where id='<uuid>';
```

**Unstick a chat** (someone stuck mid-question in Telegram) **(verified)**

```sql
delete from bot_session where key = '<telegram user id>';   -- the key is the chat id
```

They then send `/start`. Safe: only conversation state lives here.

**Re-issue an invite**

```sql
select code, display_name, redeemed_at, expires_at from invite_code order by created_at desc;
update invite_code set expires_at = now() + interval '72 hours' where code = 'K7M2QXAB';
```

**Stop a queued message from being sent**

```sql
update notification_outbox set status='abandoned' where status='pending' and id='<uuid>';
```

**Set the retention window** — in `.env`, not SQL: `RETENTION_DAYS=<n ≥ 30>`, restart the
worker. Until it is set the hourly sweep logs that it is disabled and ages nothing out.

**When somebody leaves** — the CEO's **People → Has left…** action anonymises them (name,
Telegram, login, every note) and keeps every row. Do not delete employee rows: every
foreign key and the audit trail point at them. The reset script is for DEMO data only.

---

## 6. What you must NOT change

| Never touch | Why |
|---|---|
| `audit_log` | The tamper-evidence record. Every number the CEO sees traces back to it. |
| `run_trace` | Replay reconstructs decisions from it. Editing it makes replay lie. |
| `consent_record` | Legal proof of PDPL consent, including a hash of the exact notice text. |
| `progress_event`, `project_update` | Append-only histories the progress views are computed from. |
| `llm_call`, `job_run` | The cost and job records. |
| `schema_migrations` | Deleting a row re-runs a migration and corrupts the schema. |
| `note_raw` / `note_parsed` / `transcript_raw` | A person's own words. The design keeps them verbatim; only the retention sweep and erasure may replace them, and both audit a count, never content. |
| Applied migration files | Forward-only. Add `0017_*.sql`; never edit an applied one. |

**Enforced, not just a convention** — verified today as the app role:

```
update audit_log …        ERROR:  permission denied for table audit_log
delete from audit_log …   ERROR:  permission denied for table audit_log
insert … actor='employee:<the CEO>' with no session context
                          ERROR:  audit_log: an app session with no employee context may only act as system
```

⚠️ **Honest caveat:** that protection applies to the *application*. The `postgres` role you use
as an operator bypasses RLS and owns the tables, so it **can** modify `audit_log`. The
guarantee is "the running system cannot rewrite history", not "nobody can". In production the
operator account should not be the service account.

---

## 7. Tracing, auditing and replay **(verified)**

Every run — one employee report from message to alert — shares a **`correlation_id`**.

**Find a run, then read the ordered story**

```sql
select id, correlation_id, severity, category, raised_at from blocker order by raised_at desc limit 5;

select created_at, actor, action, entity, entity_id
from audit_log where correlation_id = '<correlation-id>' order by created_at;
```

**See what each step consumed** — the inputs, not just the outcome:

```sql
select step, input, output, created_at from run_trace
where correlation_id = '<correlation-id>' order by created_at;

select provider, model, prompt_tokens, completion_tokens, cost_usd, latency_ms, success
from llm_call where correlation_id = '<correlation-id>';
```

`run_trace` is written by the real code paths (`parse_update`, `route_blocker`) since
2026-09-18. It is append-only: a retried step appears twice because it happened twice.

**Replay a past decision and check it still holds.** From the project folder:

```bash
npx tsx --import dotenv/config -e "import('./packages/core/src/index.ts').then(async c => { console.log(JSON.stringify(await c.replayRun('<correlation-id>'), null, 2)); await c.closeDb(); })"
```

The report says `found`, how many `steps` were re-derived from the recorded inputs, one
`checks` entry per blocker (original resolver vs re-derived), and `diverged: true` if the
routing table or ladder has changed since — which is the point. Runs from before 2026-09-18
answer honestly instead: `"unreplayable": "run predates input recording (migration 0015);
the decision's inputs were never stored"` (verified today on the newest demo blocker).

**Every action by one person, or every action in the last day**

```sql
select created_at, action, entity, entity_id from audit_log
where actor = 'employee:<uuid>' order by created_at desc limit 50;

select created_at, actor, action, entity from audit_log
where created_at > now() - interval '24 hours' order by created_at desc limit 100;
```

The action catalogue — what every `action` value means — is in `semantic/schema.yaml` under
`audit_log.columns.action.notes`.

**Langfuse** — every model call is also a trace in Langfuse Cloud (EU), metadata only
(`captureContent: false` on `/health`). Filter by the correlation id as the trace name.

---

## 8. Monitoring **(verified)**

**Model spend and reliability**

```sql
select provider, model, count(*) calls, round(sum(cost_usd)::numeric, 4) usd,
       round(avg(latency_ms)) avg_ms, count(*) filter (where not success) failures
from llm_call
where created_at >= date_trunc('day', now() at time zone 'Asia/Dubai')
group by provider, model order by calls desc;
```

`cost_usd` is real for models in the pricing table (`openai/gpt-oss-120b` is; a model
without a price row logs 0 and warns once). All-time to date: 322 calls, $0.0076.

**Delivery health**

```sql
select channel, status, count(*) from notification_outbox group by channel, status order by 1,2;
select created_at, detail from audit_log where action = 'notification.abandoned' order by created_at desc limit 10;
```

`abandoned` = retried to the cap and given up — that message was never received; the audit
row names the recipient and the last error.

**Escalation and routing failures worth a look every day**

```sql
select created_at, action, detail from audit_log
where action in ('blocker.routing_failed','blocker.still_unroutable','alert.no_recipient','eod.gate_failed','consent.missing')
order by created_at desc limit 20;
```

**Background jobs**: `select job_name, status, started_at, finished_at from job_run order by created_at desc limit 20;`
The worker also prints, hourly, whether the retention sweep is enabled.

**Service health**: `curl http://localhost:3001/health` — `status`, `db`, `redis` (a real TCP
ping), model/document load, tracing queue, trace-write counters.

---

## 9. Changing the schema

Migrations are **forward-only and numbered**. Never edit one that has run.

1. Create `migrations/0017_your_change.sql` — plain SQL, idempotent where possible
   (`add column if not exists`, `drop policy if exists` before `create policy`).
2. New table? Enable **and force** RLS, add the select policy in terms of
   `app_can_view_employee`, grant to `freshnow_app`, add `is_synthetic`.
3. `pnpm migrate` **(verified)** — applies anything new, skips what is applied, records
   `name` + `applied_at` in `schema_migrations`.
4. **Update `semantic/schema.yaml` in the same change** — `semantic.test.ts` fails on any
   table or column missing from it, in either direction; `db.grants.test.ts` fails on a table
   without a grant.
5. `pnpm verify`.

Currently applied: 0001–0016 (0014 privilege hardening, 0015 traceability, 0016 audit-actor
integrity, all on 2026-09-18).

---

## 10. Backup and restore **(verified today: 332 KB dump, 36 tables; restored into a scratch database with 7 employees and 386 audit rows intact)**

**Back up** (public schema + all data):

```bash
mkdir -p backups
docker exec supabase_db_freshnow pg_dump -U postgres -d postgres --schema=public --clean --if-exists \
  > backups/freshnow-$(date +%Y%m%d-%H%M).sql
```

**Restore into a scratch database first — never straight over the live one:**

```bash
docker exec supabase_db_freshnow psql -U postgres -d postgres -c "create database restore_test;"
docker exec -i supabase_db_freshnow psql -U postgres -d restore_test < backups/<file>.sql
docker exec supabase_db_freshnow psql -U postgres -d restore_test -c "select count(*) from employee;"
docker exec supabase_db_freshnow psql -U postgres -d postgres -c "drop database restore_test;"
```

Expect two kinds of harmless noise on a fresh scratch database: `relation "public.x" does not
exist` (from `--clean` dropping tables that are not there yet) and `permission denied to
change default privileges` (Supabase-owned defaults; `postgres` is not a superuser there).
The data lands regardless — check the counts.

Restore over the live database (destructive — stop the API, worker and bot first):

```bash
docker exec -i supabase_db_freshnow psql -U postgres -d postgres < backups/<file>.sql
```

**Off-box backups are still deferred** (`DEVIATIONS.md` #6). Until they exist, a laptop
failure loses everything since the last manual dump.

---

## 11. Common operator tasks

| Task | How |
|---|---|
| Start / stop everything | `COMMANDS.md` §1 and §4 |
| Check what is up and the URLs to use right now | `pnpm urls` |
| Re-seed demo data | `pnpm seed` (idempotent, all rows `is_synthetic=true`) |
| Full end-to-end check | `pnpm e2e` — 19 checks, real database, real model, **sends real Telegram messages** |
| Full test suite | `pnpm verify` — typecheck + 375 tests, ~2 minutes, makes real model calls |
| Test one employee message | `npx tsx scripts/employee-sim.ts "chiller kharab hai"` |
| Change who the CEO is | `CEO_TELEGRAM_USER_ID` in `.env` **and** the `ceo` role on the same row (People tab), then restart the bot |
| Give someone a dashboard login | `pnpm link:user "<employee name>" <email>` (prints a password once) — record it in `CREDENTIALS.local.md` |
| Somebody left | Dashboard → People → **Has left…** (anonymises; never deletes) |
| Wipe test activity, keep DEMO | `npx tsx scripts/reset-employee.ts --all-real --dry-run`, then without `--dry-run` |
| Unlink someone from Telegram | `update employee set telegram_user_id=null, status='pending' where id='<uuid>';` |
| See service logs | the three terminals; Postgres: `docker logs -f supabase_db_freshnow` |

---

## 12. Safety rules

1. **`select` before `update`.** Always. And always with a `where`.
2. **Never run `update`/`delete` without a `where`.**
3. **Back up before bulk changes.** One command, ten seconds.
4. **Never edit** `audit_log`, `run_trace`, `consent_record`, `progress_event`,
   `schema_migrations`, or any applied migration file.
5. **Never edit a person's own words** (`note_raw`, `note_parsed`, `transcript_raw`).
6. **Use `freshnow_app`, not `postgres`, when testing who-can-see-what** — as `postgres` you
   bypass the very rules you are trying to test.
7. **Change roles, reporting lines, resolutions and erasures on the dashboard**, so they carry
   the actor and the before/after in the audit log.
8. **After a schema change, run `pnpm verify`** before letting anyone use the system.
9. **The API is bound to 0.0.0.0** so your phone can reach it (`COMMANDS.md` §3). Anyone on the
   same Wi-Fi can too. Demo-only; revert for production (`DEVIATIONS.md` #5).
10. **Keys live only in `.env`; dashboard passwords only in `CREDENTIALS.local.md`.** Both
    are git-ignored. Rotate any key that has ever been pasted into a chat.
