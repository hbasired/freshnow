# START HERE

Everything for the FreshNow operations platform, in the order you need it.

---

## The files

| File | What it is | When to read it |
|---|---|---|
| **`03-SYSTEM-BLUEPRINT.html`** | The complete system — architecture, HLD/LLD, all flows, diagrams, capacity, cost, governance. **Open this first.** | Now, and share it with the company |
| `04-QUESTIONS-FOR-COMPANY.md` | What to ask FreshNow, in three blocks | **Send Block A today** |
| `05-TELEGRAM-DATA-FLOW.md` | How Telegram integration, capture, storage and identity mapping actually work | Before the build, to check the design makes sense to you |
| `06-REFERENCE-SYSTEMS-BENCHMARKS.md` | Production systems to study per task | During the build |
| `specs/SPEC-000` … `SPEC-005` | Numbered requirements — the source of truth for the build | Referenced by every task |
| `tasks/TASK-BOARD.md` | Phase-wise, task-wise plan with blockers and exit criteria | To pick the next task |
| `claude-code/` | Drop into your repo: `CLAUDE.md`, `HONESTY-AND-ACCURACY.md`, 8 skills | Before opening Claude Code |
| `01-COMBINED-MASTER-REFERENCE.md` | The merged research from your original uploads | Background |
| `02-FRESHNOW-TELEGRAM-SOLUTION.md` | The decision analysis behind the architecture | Background |

---

## Order of operations

1. **Read the blueprint HTML.** If anything in it is wrong about FreshNow, fix it before
   any code exists.
2. **Send Block A to the company.** Eleven questions. Tasks 002, 004, 005 and 009 are
   blocked on the answers, and 009 (routing and escalation) cannot be built at all
   without A7, A8 and A9.
3. **Set up the repository** while you wait for answers — that is Task 001, and it has no
   blockers.
4. **Run Task 001** with the kickoff prompt below.

---

## Setting up the repository

```bash
mkdir freshnow-ops && cd freshnow-ops
git init

# Drop in the Claude Code bundle
cp /path/to/claude-code/CLAUDE.md .
cp /path/to/claude-code/HONESTY-AND-ACCURACY.md .
cp -r /path/to/claude-code/.claude .

# Bring the specs and plan into the repo
cp -r /path/to/specs .
mkdir -p tasks && cp /path/to/tasks/TASK-BOARD.md tasks/

# Reference material Claude Code should be able to read
mkdir -p docs/reference
cp /path/to/05-TELEGRAM-DATA-FLOW.md docs/reference/
cp /path/to/06-REFERENCE-SYSTEMS-BENCHMARKS.md docs/reference/
cp /path/to/03-SYSTEM-BLUEPRINT.html docs/reference/

git add -A && git commit -m "Project instructions, specs, and task board"
claude
```

---

## Task 001 — the first task

**Goal:** a running, empty, hardened stack plus the project's memory. No business logic.

**Why this first:** it has no dependency on company answers, and it establishes the
knowledge base and documentation habit before there is anything complicated to document.
Getting the discipline in place on an easy task is the point.

**Deliverables**
- `docker-compose.yml` — Caddy, Supabase (hardened), Redis, and empty service containers
- `Caddyfile` with automatic TLS
- `.env.example` with every variable documented, and a real `.env` at `chmod 600`
- pnpm workspace: `packages/core`, `api`, `bot`, `worker`, `dashboard` — structure only
- `knowledge-base/` created with `00-INDEX.md`, `decisions.md`, `assumptions.md`,
  `verified-facts.md`, `gotchas.md`
- CI running typecheck and test
- `docs/tasks/TASK-001-foundation.html`

**Done when:** `docker compose up -d` brings everything up, TLS resolves on the domain,
Supabase Studio is reachable only over an SSH tunnel, all default Supabase secrets are
rotated, and the task HTML and knowledge base exist.

---

## The kickoff prompt

Paste this into Claude Code as the first message.

```
Read CLAUDE.md and HONESTY-AND-ACCURACY.md before doing anything else. Then read
specs/SPEC-000-system-overview.md and tasks/TASK-BOARD.md.

We are starting TASK-001 (Foundation). Follow the six-step loop in the
spec-driven-build skill. Do not skip the research step.

Scope for this task — infrastructure and project memory only, no business logic:

1. docker-compose.yml with Caddy (automatic TLS), self-hosted Supabase, Redis, and
   empty containers for bot / api / worker / dashboard.
2. Caddyfile routing /tg/webhook, /api/*, and / to the right services. Only 443 exposed.
3. .env.example documenting every variable. Note in the task HTML which Supabase
   defaults must be rotated before real data.
4. A pnpm workspace with packages/core, api, bot, worker, dashboard — structure,
   tsconfig, and lint config only. No features.
5. knowledge-base/ with 00-INDEX.md, decisions.md, assumptions.md, verified-facts.md,
   and gotchas.md, using the format in the task-documentation skill.
6. CI running typecheck and tests.

Before you write anything, web-search for:
- the current self-hosted Supabase Docker Compose setup and which containers are
  optional (I want to disable Analytics/Logflare in Phase 1 to save memory)
- current Caddy reverse-proxy configuration for multiple upstreams
- the current recommended pnpm workspace layout for a TypeScript monorepo

Then give me your plan before writing files: what you will create, what you found in
research that changes the approach, and anything you are assuming. Wait for my
confirmation.

Constraints to respect:
- One Hostinger KVM 8: 8 vCPU, 32 GB RAM, 400 GB NVMe, no GPU. Every container competes
  with Postgres for CPU, so keep the stack minimal.
- We have no answers from the company yet. Do not invent headcount, shifts, blocker
  categories, or anything else about their business. If a config needs one, mark it
  ASSUMED and log it in knowledge-base/assumptions.md with what would confirm it.
- Finish with docs/tasks/TASK-001-foundation.html including a non-empty "What we have
  not verified" section, and the knowledge-base entries.
```

---

## Two things worth knowing before you start

**The blockers are real.** Task 009 is the routing and escalation engine — the heart of
the system — and it cannot be built without knowing FreshNow's actual blocker categories
(A7), who resolves each one (A8), and how fast each needs a response (A9). Tasks 001–008
can proceed while you wait, but do not let Claude Code invent a routing table to keep
moving. It will be quietly wrong forever.

**Phase 1 succeeds or fails on response rate.** Not on features, not on the AI. If
employees stop replying after week three, the correct next task is a workflow change —
fewer questions, better timing, the right language — not another feature. Build the
response-rate view early (it is part of Task 015) and watch it daily during the pilot.
