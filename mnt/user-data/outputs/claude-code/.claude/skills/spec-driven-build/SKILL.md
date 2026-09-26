---
name: spec-driven-build
description: "The six-step task loop for the FreshNow platform — read honesty rules and specs, web-search current documentation and comparable production systems, plan and confirm scope, build against the spec, verify what actually works, then produce the task HTML and knowledge-base append. Use this skill at the START of every task without exception, whenever picking up work from the task board, whenever a spec is ambiguous or appears wrong, and whenever deciding whether something is in scope for the current phase. Also use it when tempted to batch several tasks together or skip the research step, since both are the failure modes this loop exists to prevent."
---

# Spec-Driven Build Loop

Work proceeds **one task at a time**. Each task follows six steps. Do not skip steps
and do not batch tasks — a batched task produces documentation nobody can trace back
to a decision.

---

## Step 1 — Read

In this order:

1. `HONESTY-AND-ACCURACY.md` — every task, no exceptions
2. The relevant `specs/SPEC-*.md` sections
3. `knowledge-base/00-INDEX.md`, then whichever entries it points to that are relevant
4. Any skill named in `CLAUDE.md` for this kind of work

The knowledge base is the project's memory. Reading it prevents re-litigating settled
decisions and re-hitting known gotchas.

---

## Step 2 — Research (web search, every task)

**Search before building.** This is not optional and not a formality. Two categories:

### A. Is my technical knowledge current?

Search for the current state of anything the task touches:

- Library APIs and current major versions (grammY, BullMQ, Fastify, Supabase client)
- Telegram Bot API — methods, parameters, limits, recent additions
- OpenRouter model IDs, pricing, and deprecation notices
- Postgres / Supabase features and self-hosting changes
- Anything in the "moving targets" table in `HONESTY-AND-ACCURACY.md`

If a search result contradicts something in a spec or the knowledge base, **stop and
flag it**. Do not silently follow either one.

### B. How do established systems solve this?

Before designing a mechanism, look at how systems already in production solve the same
problem. Examples of good searches by task type:

| Task | Search for |
|---|---|
| Daily status collection | How Geekbot / DailyBot / Standuply structure async standups; documented response-rate problems |
| Escalation and on-call | PagerDuty and Opsgenie escalation-policy design; SLA timer patterns |
| Outbox / reliable delivery | Transactional outbox pattern; exactly-once delivery in message systems |
| Text-to-SQL | Current benchmarks and documented production failure modes; semantic-layer approaches |
| Job scheduling | BullMQ delayed-job patterns; idempotency key design |
| Food-safety records | HACCP digital record-keeping; Dubai Municipality DMChecked requirements |
| Vending telemetry | Nayax / Cantaloupe / Vendekin API documentation and DEX/EVA-DTS basics |
| Route optimization | OR-Tools VRP examples; VROOM deployment |

Record **what you searched, what you found, and what you took from it** in the task
HTML. If you found nothing useful, say that too — an empty research section is fine
when it's honest, but it should be rare.

---

## Step 3 — Plan and confirm

Before writing code for anything larger than a single file, state:

- **What you will build** — concretely, file by file
- **Which spec sections it satisfies** — by number
- **What you will not build** — the boundaries of this task
- **What you are assuming** — anything about FreshNow's business you don't actually know
- **What you found in research** that changes the approach

Wait for confirmation. A five-line plan that gets corrected costs a minute; a day of
work built on a misunderstanding costs a day.

---

## Step 4 — Build

Follow the spec. Where the spec is silent, say so and propose. Where the spec appears
wrong, say so and stop — do not improvise and do not pretend the spec covered it.

- Update `semantic/schema.yaml` in the same task as any migration that changes a table
- Mark unverified assumptions inline with `// UNVERIFIED:`
- Do not create files that weren't part of the plan

---

## Step 5 — Verify

Run it. Actually run it.

- `pnpm typecheck` and `pnpm test` pass
- The real path works in the real client — not a curl test standing in for a browser,
  and not a passing unit test standing in for an integration
- Idempotency: run the job twice, confirm one effect
- If it touches data access, confirm RLS behaves for each role

Then write down **what you did not verify**. This list is never empty. Things that
routinely belong on it: behaviour under load, behaviour when an external API is down,
anything depending on company data you don't have yet, anything you tested only with
synthetic input.

---

## Step 6 — Document

Two artifacts, every task. See the `task-documentation` skill for the format.

1. **`docs/tasks/TASK-NNN-<slug>.html`** — what, why, how, concepts and techniques
   used, research findings, and a non-empty "What we have not verified" section.
2. **Knowledge-base append** — new decisions, assumptions, verified facts, gotchas,
   each with a confidence marker.

A task is not done until both exist.

---

## Working with the specs

`specs/` is the source of truth for *what* the system does. The code is the source of
truth for *what it currently does*. When they diverge, one of them is wrong and it
must be resolved explicitly, not left to drift.

- **Spec change first, then code.** If a requirement changes, edit the spec in the same
  task and note it in the knowledge base.
- **Specs describe behaviour, not implementation.** "Blockers escalate to a second
  resolver after the SLA window" belongs in a spec; "using BullMQ delayed jobs" belongs
  in the code and the knowledge base.
- **Every spec requirement gets an identifier** (`SPEC-004-R7`) so tests and task
  documents can reference it.
- **Untestable requirements are bad requirements.** If you cannot write a test that
  fails when a requirement is violated, rewrite the requirement.

---

## Scope discipline

Check the phase table in `CLAUDE.md` before starting. If the task as described belongs
to a later phase, say so rather than building it. Building Phase 3 features during
Phase 1 is the most likely way this project goes wrong — it produces a large,
half-verified system before anyone knows whether employees will use the bot at all.

The signal that matters in Phase 1 is **employee response rate**, not feature count.

---

## When you are blocked on company input

Large parts of this system depend on facts only FreshNow can supply. When you hit one:

1. **Do not invent it.** An invented blocker category or shift pattern will be wired
   into routing rules and quietly wrong.
2. Build against a clearly-marked placeholder with a `// UNVERIFIED:` or `// ASSUMED:`
   comment.
3. Log it in `knowledge-base/assumptions.md` with **what would confirm or refute it**.
4. Surface it in the task HTML and in the running list for the company.

A system built on invented requirements is worse than an unfinished one, because
nobody knows which parts are real.
