# Claude Code Bundle — FreshNow Operations Platform

Drop-in project instructions and skills. Copy into the root of your repository.

## Contents

```
claude-code/
├── CLAUDE.md                          # project instructions — loads every session
├── HONESTY-AND-ACCURACY.md            # read at the start of EVERY task
└── .claude/skills/
    ├── spec-driven-build/SKILL.md     # the six-step task loop — start here
    ├── deterministic-query/SKILL.md   # anti-hallucination: gates, bounded loops, semantic layer
    ├── telegram-bot/SKILL.md          # grammY, webhooks, keyboards, identity linking
    ├── database-schema/SKILL.md       # migrations, RLS, indexing, outbox/audit
    ├── llm-openrouter/SKILL.md        # the LLM wrapper, prompts, validation, cost caps
    ├── background-jobs/SKILL.md       # BullMQ, SLA timers, idempotency, outbox worker
    ├── uae-compliance/SKILL.md        # PDPL employee data + Dubai Municipality food safety
    └── task-documentation/SKILL.md    # the per-task HTML + knowledge-base append
```

## Install

```bash
cp CLAUDE.md HONESTY-AND-ACCURACY.md /path/to/freshnow-ops/
cp -r .claude /path/to/freshnow-ops/
```

Also copy `specs/` and `tasks/TASK-BOARD.md` into the repo — `CLAUDE.md` refers to both.

`CLAUDE.md` loads automatically each session. Skills load on demand when Claude judges
them relevant; you can also name one directly (`use the deterministic-query skill`).

## How the pieces fit

**`HONESTY-AND-ACCURACY.md`** is the one that matters most. It is read at the start of
every task and it overrides convenience. It exists because the system's whole value is
that a CEO can trust a number it prints — and the same standard has to apply to the code
and the documentation, or the trust is unearned.

**`spec-driven-build`** defines the loop every task follows: read → research (web search,
every task) → plan and confirm → build → verify → document. Two artifacts end every task:
a task HTML and a knowledge-base append.

**`deterministic-query`** is the skill to read if you only read one. It encodes why an
LLM must translate rather than compute, the semantic layer that solves opaque columns and
self-joins, bounded tool loops, and the deterministic gates that catch invented numbers.

## Keeping this honest

These are living documents. When a decision contradicts something here, change the file
in the same commit. A `CLAUDE.md` that has drifted from the real codebase is worse than
none, because Claude will follow it confidently.

Most likely to need updating in the first few months:

- Model IDs in `llm-openrouter` — Gemini 2.5-series is scheduled for retirement 2026-10-16
- The job catalogue in `background-jobs` as real jobs get added
- Blocker categories and routing rules, once the company supplies the real ones
- Phase 3–5 table designs, once the fleet and production process are documented
