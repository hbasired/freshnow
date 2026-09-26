# How It Actually Works — Telegram Integration, Data Collection, Storage & Mapping

A walkthrough of the whole flow, from a bot that doesn't exist yet to a CEO reading a
digest. Written to be read once, start to finish, before any code is written.

---

## 1. What a Telegram bot actually is

A common misconception is that a bot is something that "lives inside" Telegram. It
isn't. **A Telegram bot is a program running on your own server.** Telegram is a
message relay between it and your employees.

```
Employee's phone          Telegram's servers            Your Hostinger VPS
─────────────────         ──────────────────            ──────────────────
  Telegram app  ──────►   Bot API infrastructure ─────►  your bot process
       ▲                            │                          │
       └────────────────────────────┘◄─────────────────────────┘
              message delivered              sendMessage() call
```

So the answer to "should we build it on our server and host it from there?" is: **yes,
and there is no alternative.** There is nothing to "deploy into Telegram." You register
a bot with Telegram, tell it where your server lives, and Telegram forwards messages
to you.

Three consequences follow, and they answer the questions about why the VPS and the
database are needed at all:

1. **The bot needs somewhere to run.** That's the VPS.
2. **Telegram stores messages, not data.** You cannot query it, aggregate it, or
   report on it. That's what Postgres is for.
3. **Telegram has no scheduler.** Nothing in Telegram can decide "it's 07:30, prompt
   the warehouse shift." That's the worker.

---

## 2. Creating and registering the bot

### Step 1 — Create it

Message **@BotFather** on Telegram, send `/newbot`, give it a name and a username. You
get back a token that looks like `8123456789:AAH_xxxxxxxxxxxxxxxxxxxxxxxxxxx`.

That token is full control of the bot. It goes in `.env`, `chmod 600`, never in git.
If it leaks, revoke and regenerate immediately via BotFather.

Also configure through BotFather:
- `/setcommands` — registers `/start`, `/mytasks`, `/status`, `/blocked`, `/language`,
  `/privacy` so they appear in the app's command menu
- `/setprivacy` — leave **enabled**, since the design uses private 1:1 chats, not groups
- `/setdescription` and `/setabouttext` — what employees see before they tap Start

### Step 2 — Tell Telegram where your server is

```
POST https://api.telegram.org/bot<TOKEN>/setWebhook
{
  "url": "https://ops.freshnow.ae/tg/webhook",
  "secret_token": "<64 random characters>",
  "allowed_updates": ["message", "callback_query", "my_chat_member"],
  "max_connections": 40
}
```

From that moment, every message anyone sends the bot arrives at your server as an HTTPS
POST within milliseconds.

**The `secret_token` is not optional.** Telegram sends it back in the
`X-Telegram-Bot-Api-Secret-Token` header on every request. Your server rejects anything
where it doesn't match. Without this check, anyone who discovers the URL can post
fabricated employee updates directly into your database.

### Why webhook and not polling

Polling (`getUpdates`) means your server repeatedly asks Telegram "anything new?" It
works, and it's what you'll use in local development because it needs no public URL.
In production it wastes requests and adds latency. Webhooks push instantly.

One trap: if you point the webhook at a dev tunnel to test locally and forget to reset
it, **production silently stops receiving messages**. `getWebhookInfo` tells you where
the webhook currently points, how many updates are pending, and the last error —
it diagnoses most delivery problems in one call.

---

## 3. Mapping a Telegram account to an employee

This is the part that determines whether the data is trustworthy, so it's worth being
precise about.

### The identifier

Every Telegram account has a permanent numeric ID — `ctx.from.id`. It never changes,
it can't be spoofed (Telegram vouches for it), and it's how you know who sent a
message.

Two things matter about it:

- **It is a `bigint`, not an `int`.** Telegram IDs passed 32-bit range years ago. Using
  `int` fails silently and corrupts your identity mapping. This is a real, common bug.
- **It is not an identity.** It tells you *which Telegram account* sent a message. It
  tells you nothing about *which employee* that is. Connecting the two is a deliberate
  step.

### Never let someone self-declare who they are

The naive design — "the bot asks your name and department" — means anyone who finds
the bot can enrol as anyone. Instead, a manager creates the employee record first and
issues a one-time code, in person.

```
Manager                Dashboard         Core API          Employee        Bot        Postgres
───────                ─────────         ────────          ────────        ───        ────────
Creates employee ────► POST /employees ─────────────────────────────────────────────► INSERT
  (name, dept,                    │                                                    status='pending'
   role, manager)                 │
                                  ◄──── invite_code "K7M2QX"
                                        (single-use, 72h expiry)
Gives code in person ──────────────────────────────────► 
                                                        Opens bot, taps Start ──────►
                                                        ◄──── consent notice + "enter your code"
                                                        Types K7M2QX ────────────────►
                                                                          Validates ─► UPDATE employee
                                                                                        telegram_user_id=…
                                                                                        status='active'
                                                                                      ─► INSERT consent_record
                                                                                      ─► INSERT audit_log
                                                        ◄──── "Welcome Ahmed. You have 3 open tasks."
```

Rules that make this sound:

- Code is **single-use**, expires in 72 hours, and uses an unambiguous alphabet (no
  `0`/`O`, no `1`/`I` — people will read these off paper).
- `telegram_user_id` has a `UNIQUE` constraint. One Telegram account, one employee.
- **Consent is captured at this exact moment**, before the code is accepted — a plain
  notice in the employee's language, an "I agree" button, and a `consent_record` row
  storing the policy version and a hash of the text they actually saw.
- If someone changes phone or Telegram account, a manager reissues a code; the old
  link is revoked and both events are written to the audit log.

### After onboarding

Every subsequent message carries the Telegram user ID in the webhook payload. A
middleware resolves it to the employee record once, and every handler downstream has
the employee on hand. Employees never log in again — that's the whole point of using a
messaging app.

**If the record already exists, we link to it. If it doesn't, we don't create one from
the bot.** A record only ever originates from a manager in the dashboard. This is what
prevents a directory full of half-identified people.

---

## 4. Collecting the data

### The daily prompt

At each employee's shift start, the worker queues a prompt. Not a global 07:00 for
everyone — drivers, production, and retail run different hours, and a message that
arrives at the wrong time gets ignored.

```
Good morning Ahmed. 3 tasks for today:

1. Restock Deira metro machines        [Done] [In progress] [Blocked]
2. Load van 2 for afternoon route      [Done] [In progress] [Blocked]
3. Weekly chiller temperature check    [Done] [In progress] [Blocked]
```

Those are inline keyboard buttons. Tapping one sends a `callback_query` to your server
with a short code identifying task and status. **Two taps is a normal day.**

### When something is blocked

Tapping `Blocked` triggers one follow-up question with `force_reply`:

> What's blocking it?

The employee types freely, in whatever language they think in:

> chiller in van 2 not holding temp, juice at risk

That free text is the one place the system genuinely needs an LLM, and the next section
explains what happens to it.

### What's captured, and what isn't

| Captured | Not captured |
|---|---|
| Which task, which status, when | Location, unless an explicit route feature is added |
| The employee's own words | Anything from outside the bot conversation |
| Optional photos attached to a task | Sentiment, mood, or performance scores |
| Who was mentioned as needing to help | Message read receipts as a productivity metric |

The right-hand column is a deliberate boundary. It keeps the tool an operations tool
rather than a surveillance tool, and it keeps the project on the right side of UAE
employee-monitoring rules.

---

## 5. Storing it — and why order matters

Here is the single most important sequencing rule in the system:

```
1. Write the raw text to Postgres          ← happens first, always
2. Acknowledge to the employee              ← instant, they move on
3. Queue a background job to parse it       ← may fail, may retry
4. Parse with the LLM, write structured     ← minutes later is fine
5. Apply rules, route, notify               ← deterministic
```

**The employee's update is never lost because a model API timed out.** If the parse
fails, the row sits in `needs_review`, an hourly job retries it, and a human can
resolve it from the dashboard. That state is normal, not an error.

### What gets stored

```sql
task_update
  id, task_id, employee_id,
  status,              -- from the button tap: deterministic, always correct
  note_raw,            -- exactly what they typed, kept forever
  note_parsed jsonb,   -- what the LLM extracted, replaceable
  channel,             -- 'telegram'
  telegram_message_id, -- a reference, not the data
  submitted_at
```

Keeping `note_raw` and `note_parsed` separately matters: when you improve the parser in
three months, you can re-run it over the whole history. If you only kept the parse,
that history is gone.

### Postgres is the record; Telegram is transport

Telegram chat history cannot be queried, aggregated, joined, or reported on. You can't
ask it "how many equipment blockers did we have in the Deira site last month." Every
message is parsed into structured rows within seconds of arrival, and the database is
the only source of truth from that point on.

---

## 6. From free text to a routed blocker

This is the flow that produces the CEO's alert.

```
"chiller in van 2 not holding temp, juice at risk"
                    │
                    ▼
    ┌───────────────────────────────┐
    │ LLM: extract structured facts │   ← the ONLY thing the model decides
    └───────────────────────────────┘
                    │
                    ▼
    { category: "equipment",
      severity: "critical",
      affected_asset: "van 2 chiller",
      risk: "cold chain / spoilage" }
                    │
                    ▼
    ┌───────────────────────────────┐
    │ Lookup: (category, site,      │   ← deterministic, auditable,
    │  shift) → resolver_employee   │     explainable to the CEO
    └───────────────────────────────┘
                    │
         ┌──────────┴──────────┐
         ▼                     ▼
   Notify resolver       Notify CEO (severity ≥ high)
   [Accept] [Decline]    [Reassign] [Message] [Ask someone else]
         │
         ▼
   SLA timer armed — escalate to level 2 if unacknowledged in N minutes
```

**The model says what kind of problem it is. A lookup table decides who gets it.**

That split is not a stylistic choice. Routing must be reproducible — if the CEO asks
"why did this go to Rashid?", the answer is a row in a table, not a model's reasoning
that may differ next time. It also means routing can't hallucinate a person who doesn't
exist.

The same applies to escalation: a rule on severity, age, and SLA. Same inputs, same
decision, every time.

### The one-to-many and many-to-one requirement

This is where it's satisfied. The CEO addresses any employee, or several, from either
Telegram or the dashboard. Every employee's updates flow into one queue the CEO sees.
When a blocker needs someone other than the person who raised it, the system routes it
there and tells both.

None of this uses Telegram groups. Groups are noisy, they leak everyone's status to
everyone, and they're a poor fit for anything a manager sees but a peer shouldn't. The
topology is **private 1:1 chats, fanned out by the server**.

---

## 7. What runs on a schedule, and what "learning" means

### The jobs

| Job | When | What it does |
|---|---|---|
| `daily_prompt` | Per employee, at shift start | Queue the morning message |
| `reminder_nudge` | +3h if no response | One nudge. Never a second. |
| `parse_update` | On each new free-text update | LLM extraction |
| `sla_sweep` | Every 5 minutes | Escalate anything past its window |
| `executive_digest` | 18:00 daily | Aggregate in SQL, phrase with the LLM, send to CEO |
| `weekly_rollup` | Sunday evening | Trends, recurring blockers, response rates |
| `reparse_failed` | Hourly | Retry `needs_review` rows |
| `backup` | 02:00 daily | `pg_dump`, encrypt, push off the box |
| `retention_sweep` | Monthly | Enforce the retention policy |

These run in BullMQ backed by Redis, not raw crontab. The difference matters: BullMQ
gives you retries, backoff, and — crucially — **delayed jobs**, which is exactly what
an SLA escalation timer is. "Escalate this in 60 minutes unless someone acknowledges
it" is one line, and it survives a container restart. A `setTimeout` does not.

### What the system actually learns

Being concrete here, because "the system learns and adapts" is where these projects
drift into vagueness. In order of real value:

**1. Routing accuracy.** Every blocker records who it was routed to and who actually
resolved it. When those differ repeatedly for a category, the routing table is wrong.
Surface it monthly; a human updates the table. This is a `GROUP BY`, not a model — and
it makes the system visibly better every month.

**2. Recurrence clustering.** Group blockers by asset and category over time. *"Van 2
chiller: 3 blockers in 11 days"* is the insight that gets equipment fixed before a
batch of juice is lost. Simple aggregation first; semantic similarity over the free
text later, once there's enough of it.

**3. Task duration baselines.** How long each category of task actually takes, per
site. Feeds realistic due dates in Phase 2 and route timing in Phase 5.

**4. Response-rate and friction monitoring.** Who stops responding, and when. **This
is the project health metric.** Below roughly 70% and the workflow is wrong — no
amount of AI fixes that.

**5. Severity calibration.** Compare assigned severity against actual resolution time.
If "high" blockers resolve in five minutes, the classifier is over-firing and the CEO
will start ignoring alerts. Re-tune the prompt with real examples.

**6. Forecast inputs (Phase 4+).** Task and blocker history becomes a feature in
demand forecasting and predictive maintenance.

Note what is *not* on that list: fine-tuning a model. At this data volume, better
prompts with real examples beat fine-tuning on both cost and effort, for a long time.

### How adaptation actually happens

Honestly: **mostly by a human reading a monthly report and changing a table.** The
system surfaces the pattern; a person makes the change. That is a feature, not a
limitation — an escalation table that rewrites itself is an escalation table nobody can
predict or audit.

The parts that adapt automatically are narrow and safe: due-date defaults from measured
durations, prompt timing from observed response patterns, and severity thresholds tuned
against resolution times. Everything with consequences stays under human control.

---

## 8. The CEO's two surfaces

**Telegram** — the 06:30 brief, real-time alerts for high and critical only, and inline
buttons on each alert: `Reassign` · `Message employee` · `Ask someone else` ·
`Mark resolved` · `Snooze`.

**Web dashboard** — the actual picture. Live board of every employee and task, the
blocker queue with age and severity, department roll-ups, trends over weeks, and
(Phase 2) a natural-language question box.

Both talk to the same API and the same database. Cramming a dashboard into Telegram is
the single most common way these builds go wrong — chat is excellent for alerts and
one-tap actions, and terrible for tables, maps, and trends.

### Why the query box is guarded

When the CEO types *"how many equipment blockers did Deira have last month?"*, the
model does **not** read rows and count them. It writes a query, Postgres counts over
every row, and the model narrates a small result. Then two deterministic checks run
before anything is displayed:

- **Numeric sanity** — every number in the answer must literally appear in the returned
  rows. This catches the classic failure: correct query, correct rows, invented total.
- **Grounding** — a claim about a policy or an SLA must cite the record it came from.

And the executed SQL is shown alongside the answer. If the CEO can't audit a number,
the system shouldn't print it.

---

## 9. Where everything physically lives

```
Hostinger KVM 8 — 8 vCPU, 32 GB RAM, 400 GB NVMe, no GPU

  Caddy            :443   TLS, reverse proxy, the only thing exposed
  ├── /tg/webhook  ────►  bot service      (grammY, thin translation layer)
  ├── /api/*       ────►  core API         (all domain logic)
  ├── /            ────►  dashboard        (Next.js)
  └── /miniapp     ────►  Mini App         (Phase 2)

  worker                  BullMQ processors — the only thing that sends messages
  Redis            :6379  queues, delayed jobs, sessions
  Supabase/Postgres:5432  the system of record — RLS on, pgvector available
  Uptime Kuma             monitoring

  Outbound: OpenRouter (LLM), Telegram Bot API (sending), backup target
```

Only Caddy is publicly reachable. Postgres, Redis, and Supabase Studio bind to
localhost and are reached over an SSH tunnel.

**Capacity, honestly:** this comfortably runs Phases 1–3, which is realistically the
next 9–15 months. It gets tight in Phase 4 when telemetry ingestion and forecasting run
alongside everything else, and the failure mode will be CPU contention rather than
running out of RAM — a forecasting job pinning all eight shared vCPUs while the bot
times out on a webhook. The migration path is to move Postgres to managed first, then
split compute onto a second box.

---

## 10. The whole flow, one page

```
07:30  Worker fires daily_prompt for Ahmed (warehouse shift start)
       → writes to notification_outbox with idempotency_key
07:30  Outbox worker picks it up, calls Telegram sendMessage
07:31  Ahmed sees 3 tasks with status buttons
09:14  Ahmed taps [Blocked] on task 2
       → callback_query hits /tg/webhook, secret token verified
       → Core API records status, replies with force_reply question
09:14  Ahmed types "chiller in van 2 not holding temp, juice at risk"
       → RAW TEXT WRITTEN TO POSTGRES IMMEDIATELY
       → bot acknowledges instantly
       → parse_update job queued
09:14  Parser extracts {equipment, critical, "van 2 chiller", cold-chain risk}
       → blocker row created
       → routing lookup: (equipment, warehouse, day) → Rashid (maintenance)
       → two outbox rows: Rashid gets it with Accept/Decline, CEO gets an alert
       → escalate_blocker job scheduled with a 30-minute delay
       → audit_log rows written with a shared correlation_id
09:16  CEO taps [Message employee], types a reply, taps send
       → message logged with human_approved = true
       → delivered to Ahmed
09:22  Rashid taps [Accept]
       → escalation job cancelled
       → SLA timer stops
11:40  Rashid marks resolved, adds a note
18:00  executive_digest aggregates the day in SQL, LLM writes six lines,
       CEO gets the brief
Sun    weekly_rollup notices this is the third van-2 chiller blocker in 11 days
       and says so
```

Every step in that timeline is reconstructible from stored state. Same inputs, same
decisions. That is what "deterministic, replayable, auditable" means in practice, and
it is why a CEO can act on what this system tells him.
