# Task Board — Phase-wise, Task-wise

One task at a time. Each follows the six-step loop in the `spec-driven-build` skill and
ends with a task HTML plus a knowledge-base append. A task is not done until both
artifacts exist.

**Do not start a task whose blockers are unresolved.** Build against a marked
placeholder only where the task explicitly permits it.

---

## Phase 1 — Prove the loop

*Goal: employees actually report status every day, and the CEO reads the result.
Success is a sustained response rate above 70% for four weeks. Not feature count.*

| # | Task | Specs | Blocked on | Output |
|---|---|---|---|---|
| **001** | Repository, knowledge base, Docker Compose skeleton, Caddy + TLS, hardened Supabase, `.env.example`, CI with typecheck and test | 000 | — | Running empty stack; `knowledge-base/` created |
| **002** | Core schema migration + RLS + audit/outbox/trace tables + `semantic/schema.yaml` v1 + RLS tests per role | 001 | A1, A6, A7 for taxonomy | `migrations/0001_init.sql`, passing RLS tests |
| **003** | Core API skeleton: Fastify, Zod schemas, error model, `correlation_id` middleware, audit helper, health endpoint | 000, 005 | — | API responding, every request traced |
| **004** | Bot skeleton: grammY, webhook + secret verification, `/start`, consent notice, invite-code linking, consent record, auth middleware | 002 | A2 languages, A12/A13 legal | An employee can link and be greeted by name |
| **005** | Task model + daily prompt job + inline status keyboard + status recording + one nudge + shift-aware scheduling | 001, 002, 004 | A3 shifts, A6 tasks | Two-tap daily reporting works end to end |
| **006** | Outbox worker: BullMQ, idempotency, `SKIP LOCKED` claiming, throttling, 429 handling, terminal-failure abandonment | 001, 004 | — | Duplicate job produces one message |
| **007** | LLM wrapper: OpenRouter client, Zod validation, one retry, 10 s timeout, `llm_call` logging, daily budget cap with rules-only degradation | 003 | — | Parser callable, spend tracked |
| **008** | Blocker capture: force-reply flow, write-raw-first ordering, `parse_update` job, `needs_review` state, `reparse_failed` job | 003, 002 | A2 languages | Free text becomes a structured blocker |
| **009** | Routing + escalation engine: `routing_rule` lookup, delayed escalation jobs, acknowledgement cancel, race-safe processor, `sla_sweep` safety net | 004 | **A7, A8, A9** | Deterministic routing with unit tests per rule |
| **010** | CEO alerts: severity threshold, inline actions, human-approved messaging, message logging | 002, 000 | A10, A11 | CEO can act on a blocker from Telegram |
| **011** | Executive digest: SQL aggregation, LLM phrasing, exceptions-only format, `job_run` alerting on miss | 004 | A10 | 18:00 digest arrives daily |
| **012** | Dashboard v1: auth, employee list, live task board, blocker queue, run trace viewer, audit browser | 001, 005 | — | CEO and managers can see everything |
| **013** | Replay: reconstruct a run from `run_trace`, re-execute deterministic path, divergence report, CI replay test | 005 | — | A week-old decision replays identically |
| **014** | Retention sweep, erasure path, backup job with a **tested restore**, Uptime Kuma | 001, 005 | A12 | Restore verified, not assumed |
| **015** | Pilot readiness: privacy notice EN/AR, onboarding runbook, 5–10 volunteers linked, response-rate dashboard | all | A4, A13 | Pilot live |

**Phase 1 exit criteria:** response rate ≥70% for four consecutive weeks · CEO opens
the digest on ≥80% of days · zero lost updates · every displayed number traceable ·
replay test green.

*If response rate is the thing failing, the next task is a workflow change — fewer
questions, better timing, different language — not a new feature.*

---

## Phase 2 — Close the loop

*Goal: the system becomes the operational record, not a reporting layer on top of one.*

| # | Task | Specs | Blocked on |
|---|---|---|---|
| 016 | Task assignment from dashboard; assignment notifications; acceptance | 002, 004 | B1, B3 |
| 017 | Recurring task templates (RRULE), generation job, holiday calendar | 004 | B2 |
| 018 | Mini App: task board, bulk update, `initData` validation | 002 | — |
| 019 | Curated read-only views + `readonly_role` + view tests | 001, 003 | — |
| 020 | Query pipeline: intent, schema pruning, bounded tool loop, `MAX_ROWS` | 003 | — |
| 021 | Deterministic gates: numeric sanity, grounding; escalation to re-derivation | 003 | — |
| 022 | Critic → cross-validator → arbiter chain; confidence surfacing | 003 | — |
| 023 | Clarification + read-back with round caps | 003 | — |
| 024 | Learning reports: routing accuracy, recurrence clusters, duration baselines, severity calibration | 000 | — |
| 025 | Non-response policy and manager escalation | 004 | B7 |
| 026 | Photo attachments with retention sizing | 001 | B8 |

**Phase 2 exit:** the CEO assigns work in-platform and stops using the previous method ·
NL query answers are gate-checked and SQL-visible · routing accuracy report drives at
least one real routing-table correction.

---

## Phase 3 — The warehouse

*Goal: production, QC, and traceability in the same tool people already use daily.*

| # | Task | Specs | Blocked on |
|---|---|---|---|
| 027 | Product, lot, and batch schema with two-way traceability | 001 | C1, C3 |
| 028 | Production batch logging via bot and dashboard | 002 | C1 |
| 029 | QC check capture; immutable corrections; fail → automatic critical blocker | 001, 004 | C2 |
| 030 | Cold-chain temperature logging; excursion → critical blocker routed to the PIC | 004 | C4 |
| 031 | R&D experiment logging | 001 | C5 |
| 032 | Expiry and inventory views; waste tracking baseline | 001 | C3, C6 |
| 033 | pgvector + semantic search over blocker history and R&D notes | 003 | — |
| 034 | CEO assistant: bounded read-only tool loop over curated views | 003 | — |
| 035 | Data-upload onboarding pass: profile, infer, ask only the ambiguous residue, write back to `schema.yaml` | 003 | — |

**Phase 3 exit:** a recall query answerable in one step, both directions · cold-chain
excursions raise blockers automatically · waste baseline recorded.

---

## Phase 4 — Telemetry & forecasting

*Buy before building. Verify Nayax/Vendekin API access first.*

| # | Task | Blocked on |
|---|---|---|
| 036 | Vendor evaluation: telemetry API access, coverage, cost — **decision gate** | C7–C10 |
| 037 | Machine, slot, telemetry schema (time-partitioned from the start) | C7 |
| 038 | Telemetry ingestion (vendor API or MQTT) with buffering and gap detection | C8 |
| 039 | Anomaly detection with alert-fatigue controls: dedup, correlation, dynamic thresholds, severity tiers | — |
| 040 | Demand forecasting: statistical baselines first, perishable/newsvendor framing | C11, C6 |
| 041 | Shadow mode: recommendations compared against human schedules, not acting | — |
| 042 | Driver PWA | A1 |
| 043 | Infrastructure split: managed Postgres or second node | — |

**Phase 4 exit gate:** forecasts beat the static schedule in shadow mode · false-positive
alert rate low enough that drivers act on alerts · **do not enable autonomous dispatch
until both hold.**

---

## Phase 5 — Routing & delivery

| # | Task | Blocked on |
|---|---|---|
| 044 | Vehicle, route, stop schema | C13 |
| 045 | Route optimization with OR-Tools or VROOM | C12, C13 |
| 046 | Inventory routing: what to load per machine, pre-kitting | C11 |
| 047 | Delivery order integration | C14 |
| 048 | In-store POS integration | C15 |
| 049 | Customer channel (WhatsApp) for delivery updates | — |
| 050 | Cloud migration if residency, SLA, or scale require it | A12 |

---

## Operations + Inventory expansion (user-directed, approved 2026-10-15 — D179)

*Goal: one platform instead of Televend + WhatsApp groups — Operations and Inventory portals, a role-based Android
app (Flutter), a chat inside our own system, read-only Televend data, and every carton, part and dirham balanced at
the end of each shift. Numbers below are the `docs/tasks/TASK-NNN` numbers. Each task after 056 starts with a short
task plan confirmed by the user.*

| # | Layer | Delivers | Status |
|---|---|---|---|
| 055 | Televend read-only connector + MCP | allow-list egress gate, 3 transports, MCP server, data hygiene | **done** |
| 056 | Ingestion pipeline | Televend mirror (0023), 10-min sync, daily check, backfill, machine registry | **done** |
| 057 | RBAC v2 | admin, ops_head, supervisor, cash_auditor, warehouse_keeper, technician, vmo; capability matrix + SQL twin; RLS | **done** |
| 058 | Platform plumbing | media store, scoped realtime, N-portal shell + charts, device/PIN auth, privacy notice v3 | **done** |
| 059 | Operations portal v1 | command centre, machines, alarms → blockers, yesterday's report, recommendations | **done** (reviewed, fixed) |
| 060 | Inventory core + portal | append-only stock ledger with handshakes, counts, receive/issue/return, EOD balance | **done** (reviewed: 17 fixed, D236) |
| 061 | Field operations | route plans, QR visits, evidence, fills, cash, deposits, expenses, part swaps | **parts 1–2 done** — the cash ledger and the Cash portal (0035, D237–D240); route plans, visits by sticker or number, proof, fills and cash at a visit, the proof grid, the Route portal (0036, D241–D247); next: part 3 — part swaps, tickets |
| 062 | Reconciliation + EOD | stock/cash/Televend rules, "who did not report", auditor approval | |
| 063 | Flutter foundation | enrolment + PIN, offline store + command outbox, en/hi/ur, FCM | |
| 064 | Deploy | VPS (bought here), Caddy/TLS, backups incl. media, MDM | |
| 065 | App: VMO + warehouse keeper | shift, stock handshake, visit, fill, cash, return, deposit | |
| 066 | Chat | rooms, DMs, media, voice, cards, WhatsApp history import | |
| 067 | App: other roles | technician, supervisor, auditor, ops head, CEO | |
| 068 | OCR assist (deferrable) | counter LCD / receipts as proposals | |
| 069 | Pilot + cut-over | parallel run, then retire the WhatsApp groups | |

### Analytics, money, routes and the Televend switch (requested 2026-10-19, plan final the same day — D248)

*The request is recorded verbatim in `docs/requirements/REQ-2026-10-19.md` (115 requirements); the plan, with a row for every
requirement and the user's 16 answers, is `docs/reports/plan-2026-10-19-analytics-routing-cash.html`. Order by ease, as the user
asked: Phase 1 → 5. Existing tasks 062–069 and 061 part 3 sit in the phases below.*

| # | Phase | Delivers | Status |
|---|---|---|---|
| 070 | 1 Analytics | Analytics portal: machine performance tiers vs the fleet average, the 80 % set, categories (Televend regions + our fixes) aggregated and plotted, each machine's daily line vs last week's same day, insights and actions, a date picker | **done** (0037 live, D249–D252); reviewed 20 Oct (D257, D258) |
| 071 | 1 Analytics | sales history copied back as far as Televend returns; nightly analytics store; daily totals check; replayable runs | **done** (0038 live, D253; 26 Mar – 19 Oct in the store, VF91) |
| 072 | 1 Analytics | machine as a full page (with Televend's history log of renames and moves, if readable); recent sales page; Operations tiles that explore (cash in machines, collections, refills, needs a refill) | **done** (no migration); history log not read — not on the allow-list |
| 073 | 1 Analytics | each portal its own sidebar (the switcher wrap is done) | **next** |
| 074 | 1 Analytics | alarms cleared by the next sale; false alarms learned per type and machine; time to clear by type, chronic machines; alarms → routed problems switched on once FreshNow names the resolvers | |
| 075 | 1 Analytics | the business analytics portal: EDA for a day or a range, indicators, insights, actions | |
| 062 | 2 Money & stock | tally and end of day; the deposit check with a reason and alerts (golden cases from the chats); Televend's "filled by" names matched to employees (also for erasure); cups per carton; over/short; period close | |
| 076 | 2 Money & stock | finance view; food/other expenses approved by the manager; "juice try"; bank statement (CSV/Excel) matching; pop-ups | |
| 077 | 2 Money & stock | "Other" material; return to the supplier; a fruit grade only at chosen machines | |
| 061·3 | 2 Money & stock | part swaps, tickets (phones and SIMs too); spare parts with photos and the models they fit; each machine's parts history | |
| 082 | 3 Televend | the MCP ↔ API switch in Settings: live test, shadow week, fall-back, audited; the API variables in `.env`; the MCP read tools still missing (machine detail, sales with filters and totals, history log, file import, FreshNow views) | |
| — | before 069 | the independent reviews owed: 057, 059 fixes, 060 skeptic, 061 parts 1–2, 070 | **done** 20 Oct (D263): 53 + 24 confirmed, all fixed but one choice for FreshNow (A-T61.14) |
| 084 | 3 Televend | periodic audit: data vs Televend, ledgers, config, access; monthly report | |
| 083 | 3 Televend | writes to Televend, one operation at a time, each with the user's yes (only after Televend confirms the endpoint) | waits for Televend |
| 064, 066, 063, 065, 067, 068, 069 | 4 One app | server (bought before this phase), chat, the Android app, OCR on our server, pilot | |
| 078 | 5 Routes | machine and warehouse locations (map pin or Google Maps link), sites and vans with their capacity (from the earlier plan, never built), OSRM on OpenStreetMap, travel times | |
| 079 | 5 Routes | demand and stock-out forecast, back-tested | |
| 080 | 5 Routes | who usually goes where, learned nightly, a suggestion only | |
| 081 | 5 Routes | tomorrow's routes at 00:00 with VROOM (OR-Tools cross-check), reviewed, sent one hour before each shift | |

---

## Cross-cutting, every task

- Read `HONESTY-AND-ACCURACY.md` first
- Web-search current docs and comparable production systems before designing
- Update `semantic/schema.yaml` in the same task as any schema change
- Produce `docs/tasks/TASK-NNN-<slug>.html` with a non-empty "What we have not
  verified" section
- Append to the knowledge base with confidence markers
- Never invent a company fact — mark it `[assumed]` and surface it
