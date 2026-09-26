---
name: task-documentation
description: "How to produce the two mandatory artifacts at the end of every FreshNow task — the per-task HTML explaining what was done, why, how, and the concepts and techniques used, and the knowledge-base append recording decisions, assumptions, verified facts, and gotchas with confidence markers. Use this skill at the END of every task without exception, when creating the knowledge base in Task 001, when a later task corrects an earlier knowledge-base entry, and whenever writing any explanatory document about the system. Also use it if tempted to skip documentation because the task was small, since the knowledge base compounds and a missing entry costs more later than it saved."
---

# Task Documentation & Knowledge Base

Two artifacts end every task. Neither is optional, and a task is not done until both
exist.

---

## Artifact 1 — `docs/tasks/TASK-NNN-<slug>.html`

A standalone, self-contained HTML file. No build step, no external dependencies, no
CDN — it must open correctly from the filesystem in two years when the project has
moved on.

### Required sections, in order

**1. Header** — task number, title, date, phase, spec sections satisfied, one-sentence
summary of what changed.

**2. What was done** — the concrete change. Files created or modified, tables added,
endpoints exposed, jobs registered. Specific enough that someone can find it in the
repository without asking.

**3. Why it was done** — the problem this solves and the decision behind the approach.
This is the section that has value in six months. Include the options considered and
why the chosen one won. If the reason was "the spec said so," say which spec line and
why that spec line exists.

**4. How it works** — the mechanism. A short walkthrough of the flow, the important
code shapes (not a code dump — the interesting parts), and a diagram if the thing has
more than three moving parts. Prefer plain HTML/CSS diagrams over an image so the file
stays self-contained and editable.

**5. Concepts and techniques used** — named, explained briefly, and linked to why they
apply here. This section is what makes the document teach rather than just record.
Examples: the transactional outbox pattern, idempotency keys, RRF fusion, bounded tool
loops, deterministic gates, row-level security, RFC 5545 recurrence rules.

**6. Research findings** — what was searched at the start of the task, what came back,
what was adopted or rejected. Include the comparable production systems examined and
what was learned from them. If a search contradicted a spec, record that and the
resolution.

**7. What we have not verified** — **never empty.** If it is empty you have not looked
hard enough. Things that routinely belong here:
- behaviour under realistic load
- behaviour when an external dependency is down
- anything dependent on FreshNow data not yet supplied
- anything tested only with synthetic input
- performance claims that were reasoned rather than measured
- library behaviour taken from documentation rather than observed

**8. Open questions** — for the company, or for a later task.

### Style rules

- **Separate what was built from what was designed.** "The escalation engine routes by
  category" is a claim about code that exists. "This will reduce response time" is a
  prediction. Mark predictions as predictions.
- **Only measured numbers.** If you did not run it, do not report a number. If you
  quote a number from reference material, attribute it: "one reference implementation
  reported…", never "systems achieve…".
- **No unsourced authority claims.** "We chose BullMQ" is honest. "BullMQ is the
  industry standard" needs a source.
- Write for a competent engineer joining the project cold, not for the person who just
  did the work.

### Minimal template

Keep every task HTML on the same skeleton so the set reads as one document series.

```html
<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TASK-007 — Blocker Escalation Engine</title>
<style>
  :root{--bg:#0d1117;--fg:#e6edf3;--mut:#8b949e;--acc:#3fb950;--warn:#d29922;--card:#161b22;--bd:#30363d}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
       font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
       max-width:860px;padding:48px 24px;margin-inline:auto}
  h1{font-size:1.9rem;margin:0 0 4px} h2{margin-top:2.5rem;color:var(--acc);font-size:1.25rem}
  .meta{color:var(--mut);font-size:.9rem;margin-bottom:2rem}
  .card{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:18px;margin:14px 0}
  .unverified{border-left:3px solid var(--warn)}
  code{background:#1f2630;padding:2px 6px;border-radius:4px;font-size:.9em}
  pre{background:#010409;border:1px solid var(--bd);border-radius:8px;padding:14px;overflow-x:auto}
  table{border-collapse:collapse;width:100%;margin:14px 0}
  th,td{border:1px solid var(--bd);padding:8px 10px;text-align:left;font-size:.94rem}
  th{background:#1f2630}
</style></head><body>
<h1>TASK-007 — Blocker Escalation Engine</h1>
<p class="meta">Phase 1 · 2026-09-14 · Satisfies SPEC-004-R3 … R9</p>

<h2>What was done</h2>
<h2>Why it was done</h2>
<h2>How it works</h2>
<h2>Concepts and techniques used</h2>
<h2>Research findings</h2>
<h2 class="warn">What we have not verified</h2>
<div class="card unverified"> … never empty … </div>
<h2>Open questions</h2>
</body></html>
```

---

## Artifact 2 — the knowledge base

Created in **Task 001**, appended after every task thereafter. It is the project's
memory, and a wrong entry compounds because later tasks build on it.

### Structure

```
knowledge-base/
├── 00-INDEX.md          # what's here, what changed recently, where to look
├── decisions.md         # choices made and why — the architectural record
├── assumptions.md       # things believed but unconfirmed, and what would settle them
├── verified-facts.md    # things actually checked, with how they were checked
└── gotchas.md           # traps hit, so nobody hits them twice
```

### Confidence markers — every entry, no exceptions

| Marker | Meaning |
|---|---|
| `[verified]` | Tested in this codebase, or read in current official documentation. Say which. |
| `[believed]` | Reasoned from experience, not confirmed. Say what would confirm it. |
| `[assumed]` | A working assumption about FreshNow's business. **Must** name what would confirm or refute it, and who can answer. |

### Entry format

```markdown
### 2026-09-14 · TASK-007 · Escalation SLA windows
[assumed] SLA windows are critical=15min, high=60min, medium=4h, low=next-day.
These are placeholders chosen to make the timer logic testable. FreshNow has not
supplied real SLAs.
→ Confirms/refutes: ops manager or CEO stating actual response expectations per
  severity. Question is in the company list as Q17.
→ Affects: worker/escalate_blocker, SPEC-004-R5, the routing table seed data.
```

Every entry names: the date, the task, the claim, the confidence, and — for anything
not `[verified]` — what would settle it and what depends on it.

### Correcting an earlier entry

When a later task disproves something, **edit the original entry** and add a
correction note. Do not leave two contradictory entries in place for a future reader
to adjudicate.

```markdown
### 2026-09-14 · TASK-007 · Escalation SLA windows
~~[assumed] critical=15min…~~
**Corrected 2026-10-02 (TASK-014):** [verified] Company confirmed critical=30min,
high=2h, medium=next-shift, low=weekly review. Placeholders replaced in seed data.
```

### What belongs where

| File | Contains | Example |
|---|---|---|
| `decisions.md` | Architectural choices, alternatives rejected, the reasoning | "Chose BullMQ over Temporal for Phase 1 because…" |
| `assumptions.md` | Anything about FreshNow's business not confirmed by the company | Headcount, shift patterns, blocker categories, resolver mapping |
| `verified-facts.md` | Things actually checked, with the method | "Telegram callback_data is capped at 64 bytes — confirmed in Bot API docs 2026-09-10" |
| `gotchas.md` | Traps hit during development | "`telegram_user_id` overflows `int` — silent corruption, use `bigint`" |

### `00-INDEX.md`

Kept current so a future session can orient in one read: a one-line summary of each
file, the five most recent entries, and a list of the open `[assumed]` items blocking
progress.

---

## Why this discipline pays

The reference material supplied with this project contains a section listing three
bugs that each cost real time, and notes what they had in common: **every one was
invisible to a test that "passed."** A backend curl test bypassed the browser's parser.
A completed run hid the absence of streaming. A working API key masked a
configuration bug.

The knowledge base is where that class of lesson is stored so it is paid for once. The
"What we have not verified" section is where the *next* one is caught before it costs
anything — by forcing the question "what did I actually check?" at the moment it is
still cheap to answer.
