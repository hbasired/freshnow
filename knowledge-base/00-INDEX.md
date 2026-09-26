# Knowledge Base — Index

The project's memory. Read at the start of every task; append after every task.
Each entry carries a confidence marker: **[verified]** (tested / read in official docs),
**[believed]** (reasoned but unconfirmed), **[assumed]** (working assumption needing
company input).

## Files
- `decisions.md` — design decisions and why.
- `assumptions.md` — assumptions about FreshNow's business; each names what would confirm/refute it.
- `verified-facts.md` — things checked against docs or observed in a run, dated.
- `gotchas.md` — traps and sharp edges discovered during the build.

## Demo framing
This build is a **local working demo** that mirrors production (see `../DEVIATIONS.md`).
Behaviour is real; only the data is synthetic and always flagged `is_synthetic = true`.
Routing goes to the **CEO only** for now (company routing data not yet supplied).

## Task log
- **T1 Foundation** (2026-09-04): pnpm monorepo, Docker infra (Postgres+pgvector, Redis),
  typed env config, vitest, knowledge base, CI, `DEVIATIONS.md`.
  → `docs/tasks/TASK-001-foundation.html`
- **T2 Schema + RLS + semantic** (2026-09-04): `migrations/0001` (15 tables), RLS default-deny +
  policies, append-only audit, `semantic/schema.yaml`, deterministic role resolver, throwaway-test-DB
  harness, migration runner. 17/17 tests green. → `docs/tasks/TASK-002-schema-rls-semantic.html`
- **T3 Core API skeleton** (2026-09-04): Fastify `buildServer()`, correlation-id hook, error model,
  `/health`, `POST /employees/invite`; core `logAudit`/`createInvite`. 22/22 tests green.
  → `docs/tasks/TASK-003-api-skeleton.html`
- **T4 LLM wrapper** (2026-09-04): `llmComplete` (Groq `gpt-oss-120b` → NVIDIA fallback), schema-validated,
  bounded (10 s / one retry), budget-capped, `llm_call` logged. 29/29 tests green.
  → `docs/tasks/TASK-004-llm-wrapper.html`
- **T5 Outbox worker** (2026-09-04): `enqueueNotification` + DB-polling relay (`SKIP LOCKED`),
  idempotent at-least-once delivery, 429 backoff, abandon-after-max; injectable Telegram sender.
  34/34 tests green. → `docs/tasks/TASK-005-outbox-worker.html`
- **T8 Blocker parser (core)** (2026-09-04): `extractBlocker` + `parseTaskUpdate` (raw-first → note_parsed
  → blocker | needs_review); fixed a jsonb double-encoding bug. 37/37 green; EN+Hindi verified live. The
  daily-logging bot UI is wired when the token arrives. → `docs/tasks/TASK-008-blocker-parser.html`
- **T9 Routing + escalation** (2026-09-04): deterministic `routeBlocker` (category→CEO) + `escalateBlocker`
  + `slaSweep` + `acknowledgeBlocker`; BullMQ delayed timers (arm/cancel). 47/47 green.
  → `docs/tasks/TASK-009-routing-escalation.html`
- **T11 Synthetic seed** (2026-09-04): `seedDemo` (idempotent) → 5 DEMO employees + tasks + updates + 3
  blockers (routed, one escalated) + traces; `pnpm seed`. All `is_synthetic`. 48/48 green.
  → `docs/tasks/TASK-011-synthetic-seed.html`
- **T14 Guarded NL-query** (2026-09-04): `answerQuestion` (NL→SQL, read-only, narrate, numeric-sanity gate,
  abstain, SQL shown). 10 tests + live-verified real Groq. → `docs/tasks/TASK-014-nl-query.html`
- **T15 Replay** (2026-09-04): `replayRun` reconstructs a run and re-derives the routing decision, reporting
  divergence; pure `resolveForCategory`. 60/60 green. → `docs/tasks/TASK-015-replay.html`
- **T12 Dashboard** (2026-09-04): Fastify-served role-based page + RLS-scoped `/dashboard/*` endpoints +
  NL-query box; `pnpm dev:api` → http://localhost:3001. 3 RLS tests + live health. Deviation from Next.js.
  → `docs/tasks/TASK-012-dashboard.html`
- **T6/T7/T10/T13 Bot flows** (2026-09-04): replaced the stub menus with real conversations —
  invite-gated onboarding (validate → PDPL consent → transactional redeem → self-filled profile),
  daily logging (Done/Pending/Blocker, raw-text-first), CEO blocker queue with one-tap Acknowledge,
  and CEO→employee assignment via the outbox. Logic lives in core (`onboarding.ts`, `updates.ts`);
  handlers are thin. 80/81 tests green. Bot verified live as **@freshnow1bot**.
  → `docs/tasks/TASK-006-bot-flows.html`

- **T18 (partial) E2E verification + low-literacy hardening** (2026-09-04): 19/19 end-to-end checks
  against real Telegram accounts (alerts and assignments actually delivered to both phones). A
  30-run agent stress test in the persona of a barely-literate worker found 6 real problems being
  silently dropped; root cause was a reasoning-model token cap truncating JSON plus an unpinned
  output language, misreported as a timeout because the client hid the primary provider's error.
  All fixed and re-verified; `needs_review` now alerts a human instead of failing silently.
  → `docs/tasks/TASK-018-e2e-verification-and-hardening.html`

- **T19 EOD reports, attachments, multi-item messages, dashboard rebuild** (2026-09-07): CEO blocker
  alerts now name the person, their department/site and task, and quote their exact words in their
  own language. Assignment titles are extracted rather than echoed, missing information is asked for
  (`assign_pending`, `which_task`) rather than guessed, one message may carry up to 8 work items for
  different people, and assignments can carry documents/photos — stored as Telegram `file_id`
  references, never bytes. New `daily_report` gives a per-employee end-of-day report with every count
  computed in SQL. Dashboard rebuilt around Completed/Pending/Blockers tables, carry-over grouped by
  the date work was raised, assignments, and EOD. **Three real defects found while verifying** —
  later migrations had RLS policies with no privilege behind them (G28), the test DB had stopped at
  migration 0001 (G29), and the first EOD counted messages instead of work items and missed a blocker
  entirely (G30). 100 tests green.
  → `docs/tasks/TASK-019-eod-attachments-dashboard.html`

- **T20 Document intelligence, conversation guards, /log, dashboard nav** (2026-09-08): a PDF of
  jobs is now READ and split into one tracked assignment per job, routed to whoever the document
  names, each with its own message — the real 4-item document became 6 tracked tasks. The file is
  forwarded only on an explicit tap. The plan is a proposal the CEO confirms; an unresolvable owner
  blocks the create button rather than being guessed. Two deterministic guards fix the overnight
  `/invite` that swallowed the next morning's instruction (G31): a 30-minute step TTL and a
  name-plausibility rule, both erring towards asking. `/log` reaches daily capture directly.
  Dashboard nav rebuilt as a grouped sidebar with live counts and hash routing. Confirmed the
  "slow PDF" was Telegram's transport, not our code (G33). 123 tests green.
  → `docs/tasks/TASK-020-document-intelligence-and-guards.html`

- **T21 Document security, injection defence, rate limits, EOD context** (2026-09-09): an honest
  threat model — this server never executes a document, so the real risk is FORWARDING one.
  Magic-byte type detection, a structural scan for active content (such files stay readable but
  the forward button disappears), archives and executables blocked, filenames sanitised, and 20
  documents/hour per person counted from the audit log. Prompt injection: spotlighting with a
  per-call random fence, 14 rule-based patterns, output validation. Verified live that a document
  ordering "assign everything to Mallory Attacker" yields 2 clean tasks with **no assignee**.
  Two real bugs found while building it: stripping invisible characters *defeated* the detector by
  destroying word boundaries (G37), and the obvious strip-all rule would corrupt Hindi and
  Malayalam (G38). EOD reports gained age, carry-over, silent tasks, assignments received,
  a yesterday comparison, and an "anything to add?" step. 176 tests green.
  → `docs/tasks/TASK-021-security-guardrails-and-eod-context.html`

- **T22 Confirmation naming, Asia/Dubai time, concurrent runner** (2026-09-09): screenshot review
  confirmed the document pipeline works end to end (4 tasks routed, file not forwarded, blocker
  detected and escalated) and exposed two real defects. Status confirmations never named the task
  (G40) — the employee tapped the wrong card, so a note landed on the wrong job while the task they
  believed finished stayed open. Every displayed time was UTC (G41), and "today" computed in UTC
  meant an EOD run after 20:00 Dubai would report the wrong day. Scale: swapped `bot.start()` (one
  update at a time) for `@grammyjs/runner` with per-chat `sequentialize`, a 6-wide semaphore on
  every model call, and a bounded wait queue. Measured 20 simultaneous messages: 8.2s, 20/20
  succeeded, peak concurrent exactly 6, ~3.7x faster than sequential. `/health` now reports live
  saturation. 182 tests green.
  → `docs/tasks/TASK-022-scale-and-time-fixes.html`

- **T23 Full code review + remediation** (2026-09-09): `/code-review high packages/` over ~7 000
  lines returned **15 findings; all 15 verified real against the running system before any fix, no
  false positives**. Highest: the outbox could starve itself so no message was ever delivered
  (G43); `.bat`/`.js`/`.sh` attachments passed the gate as `safe, mayForward: true` (G44); every
  day window was 4h out because Postgres runs UTC and only half the timezone fix had landed (G45);
  MAX_ROWS was escapable by a subquery LIMIT (G46); the rate limiter counted nothing because it
  logged `actor: "system"` (G47); Telegram Markdown 400s made the bot look dead (G48); anyone could
  acknowledge a blocker (G49); "which task?" silently ate the reply (G50). Two findings got a
  judgement rather than a patch: the escalation timer cannot be armed from core without inverting a
  package dependency, so the sweep tightened 5min→60s and the misleading UI text went; and the
  dashboard got a REAL optional `DASHBOARD_TOKEN` rather than a `viewer=ceo` check that anyone
  could set. 197 tests green (up from 182).
  → `docs/tasks/TASK-023-code-review-remediation.html`

- **T24 Model benchmark, framework decision, React dashboard** (2026-09-10): benchmarked 12 models
  on FreshNow's OWN prompts (multilingual blocker extraction, document routing with grounding, a live
  injection attempt) rather than generic prose. Groq `gpt-oss-20b` and `gpt-oss-120b` both 5/5;
  `qwen2.5:0.5b` MISSED a Malayalam breakdown report (D52 note); OpenRouter key invalid; NIM free tier
  timed out. Researched the three frameworks and found they are three separate decisions:
  **LangChain no, LangGraph no** (its central feature is model-driven control flow, which CLAUDE.md
  rule 3 forbids in writing), **Langfuse yes** (framework-agnostic OTEL SDK, fixes cost reporting that
  reads 0). Agentic loops cost 3-30x tokens, so tool-calling belongs only in the CEO question box.
  Built the React + Tailwind dashboard, served by the API at `/app`. Recommended Supabase yes,
  FastAPI rewrite no. **The benchmark also exposed two real defects in our own config**: the
  concurrency limiter was sized to the box (6) not the provider (Groq allows 8 000 tokens/min, and
  6 document plans is ~14 000) and the client had no 429 backoff, so a busy minute took out a test
  run (G53); and there is currently **no working fallback provider** -- OpenRouter 401, NVIDIA 503
  (G54). Both fixed/recorded. 200 tests.
  -> `docs/tasks/TASK-024-benchmark-frameworks-react.html`
- **T25 Supabase migration and real dashboard sign-in** (2026-09-12): the system now runs on
  Supabase (local CLI stack). Migrations 0001–0008 applied; every row copied and counted; the old
  Postgres kept as the rollback copy. The dashboard has real sign-in: a Supabase JWT verified
  against the published ES256 keys, mapped to an employee through `employee.auth_user_id`, with
  `?viewer=` ignored (D58). Question box, report generation and invites are CEO-only under sign-in
  (D61). Accounts are linked with `pnpm link:user`. A real headless browser signed in as the CEO and
  as Hemanth and found **three defects no test caught**: a blank page from Vite asset paths (G57),
  an employee seeing 0 of their 6 assignments because an RLS-hidden join dropped the rows (G58,
  fixed by migration 0008 / D62), and an invisible title from a Tailwind colour named `base`
  (G59). 210 tests on Supabase Postgres.
  -> `docs/tasks/TASK-025-supabase-auth-migration.html`
- **T26 OpenRouter fallback, benchmark, pricing, FastAPI answer** (2026-09-12): new OpenRouter key stored in
  `.env`; dashboard logins in the git-ignored `CREDENTIALS.local.md`. Failover proven through the real client with
  a broken Groq key (G54 resolved). Graded 12 OpenRouter models on the five real tasks, and ran a 5-repeat latency
  pass giving the S3 lab's numbers (TTFT, ITL, decode and prefill tok/s, total, spread) for 17 Groq and OpenRouter
  models; OpenRouter's own bill recorded per call and matched the estimate to 4.6%. The cost log now records real
  money (D66). Monthly model cost at 25 staff: $0.31–0.65 on the recommended models; a 4-step agent roughly
  quadruples it, still under $2. Findings: OpenRouter's default routing made gpt-oss-120b ten times slower than on
  Groq (G63); a cheap reasoning model costs more per call than its price sheet suggests (G64); three cheap models
  obeyed the injection (G67); a UTC "today" in a test failed after midnight Dubai (G68). FastAPI: keep Fastify,
  Python joins as a worker (D68). 213 tests.
  -> `docs/tasks/TASK-026-openrouter-benchmark-pricing.html`
- **T27 Demo runbook, commands file, reset tooling** (2026-09-12): wrote `DEMO-GUIDE.md` (pre-flight,
  rehearsal, wiping practice data, an act-by-act demo, registering a colleague live, troubleshooting, the
  questions an audience asks) and `COMMANDS.md` (start, stop, reset, health checks, the firewall rule a phone
  needs). Extended `scripts/reset-employee.ts`: `--activity` wipes what a person did but keeps them registered,
  `--ceo --activity` clears the CEO test artefacts, and the delete order now covers `attachment` and
  `daily_report` — tables added after the script was written, which would have made it fail on a foreign key
  (G69). Verified on a throwaway employee carrying one of every attached row.
  -> `docs/tasks/TASK-027-demo-runbook-and-reset.html`
- **T28 The dashboard can create work — task portal phase 1** (2026-09-14): five write routes
  (`/dashboard/tasks`, `/assignments`, `/task-updates`, `/blockers/:id/ack`) and two document routes
  (`/documents/plan`, `/apply`), each a Zod shell over the core function the bot calls (D69); write
  authorisation explicit in the handler with a test per refusal (D70); shared `viewer.ts`. New My work
  tab, write-capable Assignments tab (assign, add a person, from a document), Acknowledge on Status.
  `recordTaskUpdate` takes a channel; `createTask` audits; `acknowledgeBlocker` records who. Two real
  browser runs (29 checks) proved delivery to Telegram and found G70 (body-less POSTs from the browser
  were 400, including the old Generate-EOD button) and G71 (invisible success toast). 14 new tests.
  -> `docs/tasks/TASK-028-ui-writes-task-portal.html`
- **T29 The org model — managers, department leads, who sees whom** (2026-09-14): migration 0009 adds
  `employee.access_role` (ceo|manager|lead|employee) and rewrites every SELECT policy on one SECURITY DEFINER
  predicate, `app_can_view_employee(target)` (D73); `canAssignTo` in `core/org.ts` is its TypeScript twin
  for writes; `resolveViewer` carries role and department into every RLS read; a trigger refuses looping
  reporting lines (D76); the CEO edits roles and managers on the People tab, audited with before/after.
  Departments compare case-insensitively after the live data showed Production vs production (G74).
  12 boundary tests on a seven-person org, positive and negative per role per table.
  -> `docs/tasks/TASK-029-org-model-rls.html`
- **T30 Task depth — steps, progress as evidence, relations, resolution** (2026-09-14): migration 0010
  adds a task_status lookup with categories, resolution separate from status (D78), progress with a named
  source — counted from steps, implied by status, or self-reported with a mandatory note (D77) — an
  append-only progress_event history, task_step, task_relation with automatic inverses and a bounded cycle
  check, and blocker resolution. A SQL behind flag from start/due dates (D80). Seven routes and a task
  detail panel. The child tables cascade (D79) after the new FK broke every teardown (G76). 14 new tests.
  -> `docs/tasks/TASK-030-task-depth-progress.html`
- **T31 Alerts — who is told what, when, and what if nobody answers** (2026-09-14): migration 0011
  turns every hardcoded alerting decision into a table — `sla_policy`, `escalation_policy`/`_level`/`_target`
  with symbolic targets (D81), `alert` with alias de-duplication (D82), `task_watcher`, `notification_pref` —
  and makes `notification_outbox` channel-aware with a sender per channel (D83), the in-app inbox being a
  row that needs no external service. `core/alerts.ts` resolves recipients by lookup and records the rule that
  chose each one (D84); the sweep now climbs one rung per timeout instead of firing once (G78), skipping empty
  rungs rather than dropping them. One acknowledge rule shared by the bot and the API (D85). An inbox bell and
  an Alerts tab. 22 new tests; 283 green.
  -> `docs/tasks/TASK-031-alert-routing.html`
- **T32 The project portal** (2026-09-14): migration 0012 adds project, project_requirement (MoSCoW
  with acceptance), milestone (weighted), project_member, project_update (append-only), project_issue —
  kept separate from `blocker` on purpose (D88) — plus `task.project_id`/`milestone_id`, because the task
  table is the unit of work for projects too (D86). Progress is a VIEW, never a column (D87): weighted
  milestones or the tasks' own percentages, with `progress_source` naming which. A person's claimed
  percentage is stored beside the computed one, never instead (D89). `flow_metrics` gives the Kanban
  Guide's four measures with cycle time as percentiles, and deliberately no SPI/CPI/EV (D90). The
  milestone gate refuses to tick over open work until forced, and records the force (D91). A portal
  picker with hash routing; three hourly sweeps. 24 new tests; 307 green.
  -> `docs/tasks/TASK-032-project-portal.html`
- **T33 Live sync** (2026-09-14): migration 0013 puts a statement-level trigger on the 19 tables a
  dashboard renders, emitting `pg_notify` with the table and operation and **no row content at all**
  (D92) — because one listening connection is shared by every viewer, so anything in the payload would
  bypass RLS. `core/changes.ts` holds that one connection on its own client (G84); `GET /dashboard/events`
  fans it out over SSE; the dashboard reads it with `fetch`, not `EventSource`, because EventSource
  cannot send an Authorization header (G85). The poll stays as the fallback and the header shows which
  is in force (D93). A change made in one session reached another in 780 ms. 3 tests; 310 green.
  -> `docs/tasks/TASK-033-live-sync.html`
- **T34 Langfuse tracing** (2026-09-14): every model call becomes a trace grouped by correlation id,
  so one run reads as a story — which provider answered, how long, what it cost, where a retry fell
  through. `llm_call` stays the record of COST because the budget cap reads it and must not depend on
  a third party (D95). No SDK: one fetch against the ingestion API (D96). Content capture is OFF by
  default — prompts are employees' own words (D97). Fire-and-forget with counters on /health, so it
  can never break a model call and a broken tracer is still visible (D98). Seven operations named.
  11 tests; 321 green. **Live against Langfuse Cloud (EU) since 2026-09-14**, verified end to end.
  -> `docs/tasks/TASK-034-langfuse-tracing.html`
- **T35 Light theme, and the portal picker before the password** (2026-09-18): the dashboard opens
  on a choice of the two portals and lands you in the one you pick (D99) — which is explicitly NOT a
  security boundary, and the UI says so. A real light theme: every colour became a token with two
  values after all 26 hardcoded hex literals were removed (D100), three states Light/Dark/Auto with
  Auto tracking the OS live (D101), applied before React mounts so there is no dark flash (G87), and
  `color-scheme` set so the native date picker follows (G88). Light accents are darker than GitHub's
  because they sit on their own 15% tint (D102). Contrast measured on real data: 0 failures in either
  theme — after the measurement itself was wrong twice (G89). 321 tests still green.
  -> `docs/tasks/TASK-035-light-theme-portal-entry.html`
- **T36 Adversarial audit + code review; security hardening** (2026-09-18): an audit agent ran ~40 live
  queries and a privilege probe as the real `freshnow_app` role; a code review covered the dashboard
  rework. **Three critical holes closed** — the NL-query ran model-written SQL as the BYPASSRLS role that
  can read `auth.users` (D103), an employee could promote themselves to CEO at the RLS layer (D104), and
  routing was non-deterministic for want of a unique index. The semantic-layer test checked table names
  only and is now column-accurate in both directions (G90). Eleven review findings fixed, including an
  SSE reconnect loop that also stopped the fallback poll (G91). Two deliverables written:
  `docs/WHAT-WE-NEED-FROM-FRESHNOW.md` and `docs/reports/future-plan.html` (RAG: not yet — D105).
  Then the remediation round: migrations 0014 + 0015; replay re-derives from RECORDED inputs and
  says when a run does not exist (D106); `run_trace` written by the real paths, append-only (D107);
  a routing failure is caught, audited and a human alerted, with a reconciliation sweep beneath
  (D108); outbox and escalation carry `correlation_id`; abandoned messages are audited; the Telegram
  sender has a timeout; `/health` pings Redis (proved live); the CEO rung looks up the real CEO; a real
  CEO keeps their own id in the audit log; `task.done` keys per occurrence; consent gaps are recorded
  (D109). Three of my own probes/constraints were wrong first (G92, G93, G94). **338 tests green.**
  -> `docs/tasks/TASK-036-audit-remediation.html` · `docs/reports/future-plan.html`
- **T37 The remaining findings closed** (2026-09-18): routing honours site and shift, most specific
  first (D110); the audit-log actor is tied to the session by trigger (D111); the EOD narrative passes
  the numeric gate and the question box passes a real grounding gate (D112); Telegram webhook mode
  exists, fails closed, verifies the secret token before grammY sees a byte (D113); PDPL retention
  and erasure exist — words aged, never counts; anonymised, never deleted — disabled until the company
  sets a window (D114); the per-process LLM cap is honest and configurable. The sender timeout and the
  fail-open warning were EXERCISED, not reasoned (G95, G96), and a config rule that would have broken
  every model call was caught by the suite (G97). Migration 0016. **360 tests green.**
  -> `docs/tasks/TASK-037-remaining-findings.html`
- **T38 Erasure has a caller; the system finds the real CEO** (2026-09-18): `POST /dashboard/people/:id/erase`
  and a two-step "Has left…" on the People tab — CEO only, never self, never a CEO row (D115). `ceoEmployeeId()`
  replaces the seeded id where the system needs *a* CEO: the needs-review alert, onboarding's parent, the
  invite issuer (D116). Four TASK-037 audit actions added to the semantic catalogue. Stopping a background
  `pnpm start:*` leaves the tsx child alive — two workers ran for a minute (G98). **362 tests green.**
  -> `docs/tasks/TASK-038-erasure-and-real-ceo.html`
- **T39 Managers act as managers in Telegram** (2026-09-18): `botRole` reads both the configured CEO id and
  the row's `access_role`; a manager gets their team's blockers (queried UNDER RLS as them) and assigns to
  their reports, with `canAssignTo` re-checked at the tap and at the write because callback data is
  guessable (D117). A pre-existing hole — `doc:read` and `docplan:go` never checked the role — closed. First
  test of the bot through grammY's real `handleUpdate` with a mocked API (D118). **375 tests green.**
  -> `docs/tasks/TASK-039-managers-in-telegram.html`
- **T40 UAE data residency analysis + guides refreshed** (2026-09-19): the PDPL has no general
  localisation rule (Art. 22–23 regulate transfer; Executive Regulations still unissued as of
  Mar 2026); our system transfers abroad via Telegram, three US AI providers (incl. one voice
  recording), Langfuse metadata, and — if deployed as planned — the whole database, because
  Hostinger has no UAE location (D119). The consent notice no longer describes the system (D120).
  In-country AI exists: Core42 hosts our exact model; OpenAI has a UAE endpoint; Azure UAE North
  runs Whisper in-region; AWS in-region is Nova only (VF25). DB-WALKTHROUGH, BACKEND-OPERATIONS and
  FRESH-RUN rewritten against the live Supabase database — every SQL block executed (G101).
  -> `docs/reports/uae-data-residency-and-llm-analysis.html` · `docs/guides/`
- **T40b Messaging report v2** (2026-09-19): every Telegram alternative judged on residency as well as
  resilience (VF26). Recommendation unchanged — in-app + web push first — because it is the only channel that
  is both ours and in-country; WhatsApp Business with UAE local storage is the mainstream fallback if
  "never abroad" becomes a rule. -> `docs/reports/messaging-resilience.html`
- **T41 Provider verdict, cost model, Telegram verdict, dashboard redesign** (2026-09-19): Groq/OpenRouter/NVIDIA
  are out for real employee data — no processor contract is possible on self-serve terms and the fallback chain
  leaks to a second US company (D121). Core42 hosts our exact model; measured cost at 100 assignments + 200 status
  updates/day is **$0.12/day**, and the assignment CHANNEL barely matters because the UI path uses no model at all
  (VF27). Telegram is lawful on the consent ground once the notice names it (D122). The dashboard became a real
  shell — sidebar, icon set, status cards with definitions, an RLS-scoped week chart whose colours were run through
  the data-viz validator, and search (D123). A green vitest run is not a green typecheck (G103).
  -> `docs/tasks/TASK-041-provider-decision-and-dashboard-redesign.html` · `docs/reports/llm-provider-decision-and-costs.html`
- **T42 FreshNow's brand colours applied** (2026-09-19): the company's green #97d700/#9bca3c and orange #f39c12,
  sampled pixel-wise from their website, used as FILLS (dark ink on them = 8.6–10.9:1) and as darkened STEPS where
  they must be read (white on them is 1.7–2.2:1, unusable) — D124. The chart keeps green/blue/red because brand
  green beside brand orange measures ΔE 0.4–3.6 under simulated colour blindness (G106). A brand hero on the
  Overview and branded entry screens replace the plain ones. 376 tests unchanged — presentation only.
  -> `docs/tasks/TASK-042-freshnow-brand-theme.html`
- **T43 Four channels behind three switches** (2026-09-19): in-app (already done), web push, email both
  directions, and a chat webhook — all built, all shipped OFF, Telegram untouched. A channel now needs
  keys + the CEO's switch + the person's preference (D126); `enqueueNotification` drops anything on a
  dark channel, closing four call sites that bypassed every gate (D127). Web push PROVEN end to end on
  localhost against Microsoft's real WNS (VF28). Inbound email gets five gates and still only produces a
  proposal (D128). Cannot reach a phone without a domain — service workers need HTTPS (G107).
  -> `docs/tasks/TASK-043-notification-channels.html` · `CHANNELS-GUIDE.md`
- **CEO deck on data residency** (2026-09-21, document only, no code): 16 slides — the PDPL articles quoted,
  where data goes today from `llm_call`, why not Hostinger, UAE hosting prices (VF29), why not Groq/OpenRouter/
  NVIDIA keys, Core42 vs OpenAI UAE, tokens per operation, daily cost by assignment channel, Telegram verdict,
  actions, sources, what is not verified. Numbers are the TASK-041 cost model re-run against re-read prices.
  -> `docs/reports/ceo-deck-data-residency.html`

## Blocked on the user
- ~~`CEO_TELEGRAM_USER_ID` is empty.~~ **Resolved 2026-09-04:** CEO = 6051615734,
  employee = 8903000291. Both have run `/start`; the CEO is linked to the CEO employee row.
- **Remaining:** nobody has tapped through the bot UI on a phone yet. Everything is verified
  through the core functions and real Telegram delivery, but the in-app tap-through is untested.
