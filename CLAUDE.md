# CLAUDE.md — FreshNow Operations Platform

Project instructions for Claude Code.

> ## ⚠️ Before anything else
> **Read `HONESTY-AND-ACCURACY.md` at the start of every task.** It is not optional
> and it overrides convenience. A confidently wrong number in this system reaches a
> CEO and gets acted on. The same standard applies to the code, the documentation,
> and the knowledge base as to the system's own outputs.

---

## What this project is

An internal operations platform for **FreshNow** (Daily Vending LLC), a Dubai-based
fresh orange juice vending operator expanding into in-store juice sales and home
delivery of bottled juice. They also run a warehouse with food-technology R&D, juice
production, and bottle filling.

Employees report daily task status through a **Telegram bot**. Everything is stored in
**PostgreSQL**. Blockers are detected, classified, and escalated by deterministic
rules. The CEO gets alerts in Telegram and a full picture in a **web dashboard**, and
can message any employee — or a different employee who can unblock the first one.

**Everything runs on one Hostinger KVM 8 VPS: 8 vCPU, 32 GB RAM, 400 GB NVMe, no GPU.**

---

## The four architectural rules

### 1. Telegram is a channel, not the system

All domain logic lives in the Core API. The bot translates Telegram updates into API
calls and nothing more. The dashboard, the Mini App, and every later adapter (driver
PWA, telemetry ingest, WhatsApp) call the same API. **If you are writing business
logic inside a bot handler, stop and move it to `packages/core`.**

This is what makes Phase 4–5 expansion additive rather than a rewrite.

### 2. The LLM translates; the engine computes

**The model never counts, sums, aggregates, or reads rows to produce a number.** It
writes a query; Postgres executes it over every row; the model narrates a small
bounded result.

This is not a style preference. A transformer flattens a 2-D table into a 1-D token
sequence, its attention mechanism is built for salience rather than exhaustiveness,
and its arithmetic is pattern-matched rather than computed. Ask it to aggregate and it
returns an estimate shaped like an answer. See `HONESTY-AND-ACCURACY.md` and the
`deterministic-query` skill.

```
natural language → [LLM: translate] → SQL
                                       ↓
                    [Postgres: compute exactly, over every row]
                                       ↓
        answer ← [LLM: narrate] ← ≤ 50 rows
```

### 3. Deterministic, replayable, auditable, observable

Every one of these is a hard requirement, not a nice-to-have:

| Property | What it means here |
|---|---|
| **Deterministic** | Routing, escalation, and assignment are rules and lookups — never model calls. Same inputs, same decision, every time. |
| **Replayable** | Every run is reconstructible from stored state: raw input, resolved intent, executed query, rows returned, gates fired, final output. You can re-run a decision from a week ago and get the same answer. |
| **Auditable** | Append-only `audit_log` with `correlation_id` linking every step of a run. Any number shown to the CEO traces back to the SQL that produced it. |
| **Observable** | Every step emits timing, tokens, prompts, tool calls. A run's timeline is queryable, not guessable. |

If a design choice trades any of these away for elegance or speed, it is the wrong
choice. State the trade-off explicitly and get it approved rather than making it
silently.

### 4. Every loop is bounded

Unbounded agent loops are the single most common way these systems fail in
production — burning cost, hanging requests, and never returning. Especially when a
query self-references (an employee's manager is also an employee in the same table).

- **Tool-calling loops: hard iteration cap** (SQL 8, retrieval 6). On cap, return
  partial results with a clear "could not complete" flag — never loop again.
- **Result sets: `MAX_ROWS = 50`.** Aggregation is pushed into SQL so the model
  receives an answer, not a table.
- **Cost: per-task token budget** with a circuit breaker.
- **Clarification: max 3 rounds**, then proceed with best guess flagged low-confidence.
- **Retries: capped attempts** with exponential backoff. Never unlimited.

---

## Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Runtime | Node.js 22 LTS, TypeScript strict | |
| Bot | **grammY** | webhook mode in production |
| API | **Fastify** + Zod | |
| Jobs | **BullMQ** + Redis | delayed jobs for SLA timers |
| DB | **PostgreSQL** via self-hosted Supabase | RLS enforced, pgvector available |
| Dashboard | **Next.js** + Tailwind + shadcn/ui | |
| LLM | **OpenRouter** via a single wrapper module | never called directly from handlers |
| Proxy | **Caddy** | automatic TLS |
| Deploy | **Docker Compose** | one stack, one box |
| Observability | Structured logs + `run_trace` table + Uptime Kuma | |

Do not add dependencies without a stated reason. This runs on one shared-vCPU box —
every container competes with Postgres for CPU.

---

## Repository layout

```
/
├── CLAUDE.md
├── HONESTY-AND-ACCURACY.md        # read first, every task
├── docker-compose.yml
├── Caddyfile
├── .env.example
├── specs/                          # the specification is the source of truth
│   ├── SPEC-000-system-overview.md
│   ├── SPEC-001-database-schema.md
│   ├── SPEC-002-telegram-bot.md
│   ├── SPEC-003-semantic-layer-and-query.md
│   ├── SPEC-004-jobs-and-escalation.md
│   └── SPEC-005-observability-and-audit.md
├── knowledge-base/                 # project memory — append after every task
│   ├── 00-INDEX.md
│   ├── decisions.md
│   ├── assumptions.md
│   ├── verified-facts.md
│   └── gotchas.md
├── docs/tasks/                     # one HTML per completed task
│   └── TASK-001-<slug>.html
├── migrations/                     # numbered SQL, forward-only
├── semantic/
│   └── schema.yaml                 # THE semantic layer — hand-maintained
└── packages/
    ├── core/     # domain logic — the heart
    ├── api/      # Fastify HTTP layer
    ├── bot/      # grammY — thin translation only
    ├── worker/   # BullMQ processors
    └── dashboard/# Next.js
```

---

## How work is done: specs → task → build → document

This is a **spec-driven** build. Work proceeds one task at a time, and each task
follows the same six steps. Do not skip steps and do not batch tasks.

### Step 1 — Read
`HONESTY-AND-ACCURACY.md`, then the relevant `specs/SPEC-*.md`, then
`knowledge-base/00-INDEX.md` and anything it points to that is relevant.

### Step 2 — Research
**Web-search at the start of every task** for anything that may have moved: library
APIs and current versions, Telegram Bot API methods, OpenRouter model IDs and pricing,
and how comparable production systems solve this specific problem. Record what you
found in the task HTML. If a search contradicts a spec, **stop and flag it** rather
than silently following either one.

### Step 3 — Plan
State what you will build, which spec sections it satisfies, what you will not build,
and what you are assuming. Get confirmation before writing code for anything larger
than a single file.

### Step 4 — Build
Write the code. Follow the spec. Where the spec is silent or wrong, say so — do not
improvise and do not pretend the spec covered it.

### Step 5 — Verify
Run it. Tests pass, typecheck passes, the actual path works in the actual client.
Note explicitly what you did **not** verify.

### Step 6 — Document
Two artifacts, every task, no exceptions:

1. **`docs/tasks/TASK-NNN-<slug>.html`** — what was done, why it was done, how it was
   done, the concepts and techniques used, and a **"What we have not verified"**
   section that is never empty. See the `task-documentation` skill.
2. **Knowledge-base append** — new decisions, assumptions, verified facts, and
   gotchas, each with a confidence marker (`[verified]` / `[believed]` / `[assumed]`).

The knowledge base is created in Task 001 and appended after every task thereafter.

---

## Non-negotiable implementation rules

### The outbox pattern for every outbound message

**Never call `bot.api.sendMessage()` from business logic.** Write a row to
`notification_outbox` with an `idempotency_key`; the worker delivers it. This is what
makes delivery exactly-once from the employee's perspective and survives restarts.

### Raw text is written before the LLM is called

An employee's update must never be lost because OpenRouter timed out.

```ts
const update = await taskUpdates.createRaw({ taskId, employeeId, noteRaw: text });
await queue.add("parse_update", { updateId: update.id });   // async, retryable
```

### The LLM never decides who or whether

| The LLM may | The LLM may not |
|---|---|
| Extract `{status, blocker, category, severity}` from free text | Decide which employee resolves a blocker |
| Summarize the day for the CEO | Decide whether to escalate |
| Draft a message the CEO will approve | Send any message autonomously |
| Write SQL against approved views | Write to the database directly |
| Say "I don't have data on that" | Produce a number it did not read from a query result |

Routing is a lookup on `(blocker_category, site_id, shift) → resolver_employee_id`.
Escalation is a rule on `severity` + age + `sla_due_at`. Both must be explainable to
the CEO and reproducible. Never replace them with a model call.

### Two deterministic gates run before any LLM validation

Both are pure code, no model, no latency, no possibility of the judge hallucinating:

1. **Numeric sanity gate** — if the answer states numbers and a query result exists,
   at least one of those numbers must literally appear in the returned rows. This
   catches the classic failure: correct query, correct rows, invented total.
2. **Grounding gate** — if the answer makes a claim about a policy, a rule, or a
   food-safety requirement, it must cite a source record.

A failed gate does not fail the request; it escalates to re-derivation.

### Every LLM call goes through `packages/core/src/llm/`

One wrapper: schema validation, one retry, 10 s timeout, cost logging to `llm_call`,
daily budget cap with graceful degradation to rules-only. Model IDs in config, never
inline.

### Row-Level Security on every table, default deny

Employees read/write their own rows; managers read their department; the `ceo` role
reads all; the worker's `service_role` bypasses. Never disable RLS "temporarily."

### `telegram_user_id` is `bigint`

Telegram IDs exceed 32-bit range. Using `int` fails silently and corrupts identity
mapping. Same for `telegram_message_id` and `chat_id`.

### Audit log is append-only

No UPDATE or DELETE grant for the application role. Every state change, every message
sent on the CEO's behalf, every consent capture, every gate decision — with a
`correlation_id` tying the run together.

### Webhook requests must be verified

Reject any request whose `X-Telegram-Bot-Api-Secret-Token` header doesn't match.
Without this, anyone who finds the URL can inject fabricated employee updates.

---

## The semantic layer

`semantic/schema.yaml` is a **hand-maintained** artifact, not something introspected
from the database at runtime. Reflection gives you types; only a human gives you
meaning.

Every column carries a plain-business-language `notes` field. Every foreign key
carries a `purpose` string naming which business question that join path serves —
**including self-referential keys** like `manager_employee_id → employee_id`, because
nothing in the column types tells a model that a self-join is required.

Two consequences:

- **Schema pruning:** never paste the whole schema into a prompt. Select only the
  tables a question needs.
- **Scope guard:** check the semantic layer before executing. If the data isn't there,
  the correct answer is "I don't have that information" — not an improvised query.

The semantic layer rots if left alone. When a migration changes a table, updating
`schema.yaml` is part of that task, not a follow-up.

---

## Security and data protection

This system stores employee performance data in the UAE. **Federal Decree-Law No. 45
of 2021 (PDPL)** applies: lawful basis, transparency, purpose limitation, data
minimisation, and withdrawable consent. UAE guidance treats unnotified employee
monitoring as a legal risk.

- Consent captured during bot onboarding, recorded with a policy version and a hash of
  the notice text.
- No message is ever sent on the CEO's behalf without an explicit human tap.
- Prompts contain the minimum necessary — never phone numbers, never full records.
- Natural-language query uses a **read-only** role against **pre-approved views**, and
  shows the generated SQL.
- **Do not build individual sentiment analysis, productivity scoring, or employee
  ranking.** Track process metrics, not people scores. If a request implies this, flag
  it rather than implementing it.
- Retention sweep from Phase 1. Erasure = anonymise, not delete.

See the `uae-compliance` skill.

---

## Testing expectations

- **Unit tests for every rule** in blocker-routing and escalation. Wrong answers here
  cause real operational damage.
- **Contract tests for LLM output parsing** against real anonymised update texts in
  each language the workforce uses. Run on every prompt change.
- **Replay test:** a stored run can be re-executed from its recorded state and produce
  the same decision.
- **Idempotency test:** running any job twice produces one notification, not two.
- **RLS tests per role** asserting both what is visible and what is not.
- Do not mock the database in integration tests — use a throwaway Postgres container.
- Never write a test by reading the implementation. It proves nothing.

---

## Style

- TypeScript strict. No `any`. `unknown` + Zod parse at boundaries.
- Names match the domain language: `blocker`, `escalation`, `task_update`, `resolver`
  — not `issue`, `alert`, `ticket`.
- SQL migrations forward-only and numbered. Never edit an applied migration.
- Comment *why*, not *what* — especially around routing rules and SLA timers.
- `timestamptz` always. Store UTC, render Asia/Dubai.
- The UAE working week is **Monday–Friday**. Never hardcode a Sat/Sun weekend.
- Mark unverified assumptions in code with `// UNVERIFIED:` and log them in the
  knowledge base.

---

## What not to do

- Don't add Temporal, Kubernetes, LangGraph, or a multi-agent supervisor in Phase 1–2.
  Complexity is earned by a named failure mode, not anticipated.
- Don't run a local LLM. This VPS has **no GPU**; CPU inference would starve Postgres
  and is slower and more expensive than the API at this volume.
- Don't build vending telemetry from scratch in Phase 4 without first checking whether
  Nayax or Vendekin expose an API. Buying is the recommended path.
- Don't use OpenRouter `:free` models in production — rate-limited, rotate without notice.
- Don't put a dashboard inside Telegram. Alerts and one-tap actions in Telegram;
  tables, maps, and trends in the web dashboard.
- Don't store anything in Telegram as the record. Postgres is the only truth.
- Don't invent company facts to make progress. Mark them `[assumed]` and surface them.
- Don't create files, scripts, or docs that weren't asked for.

---

## Phase discipline

| Phase | Scope | Do not build ahead |
|---|---|---|
| **1** | Bot onboarding, daily capture, blockers, rules-based escalation, CEO alerts, basic dashboard, audit + replay spine | task assignment, query agent, telemetry |
| **2** | CEO assigns tasks in-platform, notifications, Mini App forms, bounded NL query over views with gates | telemetry, forecasting |
| **3** | Warehouse: batch/lot traceability, QC + R&D logging, inventory; CEO assistant with read-only tools | routing, delivery |
| **4** | Vending telemetry (vendor API preferred), demand forecasting, driver PWA | route optimization |
| **5** | Route optimization (OR-Tools/VROOM), delivery ops, customer channel | — |

**Phase 1 success is not "the AI works."** It is employee response rate above 70% for
four consecutive weeks and the CEO opening the digest daily. If either is failing, fix
the workflow — do not add features.

---

## Skills

| Skill | Use when |
|---|---|
| `deterministic-query` | Any text-to-SQL, tool loop, retrieval, validation gate, or semantic-layer work |
| `telegram-bot` | Any grammY handler, keyboard, conversation, webhook, or Mini App work |
| `database-schema` | Migrations, RLS policies, indexing, query patterns |
| `llm-openrouter` | Any model call, prompt design, or output validation |
| `background-jobs` | Scheduled jobs, SLA timers, idempotency, the outbox worker |
| `uae-compliance` | Anything touching employee data, consent, retention, or food-safety records |
| `task-documentation` | The per-task HTML and knowledge-base append — every task ends here |
| `spec-driven-build` | Starting any task; the research → plan → build → verify → document loop |
