# Decisions

## D1 — Local demo mirrors production; deviations are documented, not silent [verified]
The company withheld real data (trust not yet established). We build a working demo with
synthetic, clearly-labelled data. Every prod-vs-demo difference is in `DEVIATIONS.md` with a
one-line switch back. Rationale: earn trust by showing the real system working end-to-end,
then feed it real data.

## D2 — LLM provider: Groq primary, NVIDIA NIM fallback, one wrapper [verified]
User supplied a Groq key (`gsk_…`) and an NVIDIA NIM key (`nvapi-…`). Both are OpenAI-compatible.
The mandated single LLM wrapper (Task 004) targets Groq and fails over to NVIDIA. Model IDs +
base URLs live in config, never inline. Satisfies the "single wrapper" rule while using the keys
the user actually has. Note: Groq ≠ xAI Grok (see gotcha G1).

## D3 — Routing target is the CEO only, for now [verified]
Per user instruction and absent company routing data (A7/A8/A9), `routing_rule` is seeded so
every `(category, site, shift)` → CEO, and any blocker escalates to the CEO immediately. The
engine stays table-driven, so real multi-resolver routing later is a data change, not a rewrite.

## D4 — Onboarding keeps the invite-code security gate; employee self-fills profile [verified]
Reconciles the user's "employees enter their own details" wish with `05-TELEGRAM-DATA-FLOW.md` §3
("never let someone self-declare who they are"). The CEO issues a single-use code (dashboard or
`/invite`); after redeeming it, the employee self-provides only non-sensitive descriptive fields
(department, role, site, shift, language). Security property (no open self-enrolment) preserved.

## D5 — Local transport = long polling; DB = plain Postgres+pgvector [verified]
No public HTTPS URL locally, so the bot uses `getUpdates` (Task 006). Plain
`pgvector/pgvector:pg17` replaces self-hosted Supabase; RLS is identical. Both revert per
`DEVIATIONS.md` #1/#2.

## D6 — Build-free TypeScript via source-pointing package exports + tsx [believed]
Workspace packages export `./src/index.ts` directly; dev runs through `tsx`; typecheck is a single
root `tsc --noEmit`. Avoids a build step for the demo. Confirm/refute: `pnpm verify` green
(Task 001 verify step).

## D7 — RLS enforced via a non-owner app role; service role bypasses [verified]
Postgres silently ignores RLS when the app connects as the table owner (or a superuser/BYPASSRLS
role). So the app connects as `freshnow_app` (login, non-owner, no bypass); the worker/migrations use
the owner/superuser (bypass). Per-request context is set with
`set_config('app.employee_id'|'app.is_ceo', …, true)` — transaction-local, pooling-safe. Verified by
8 RLS attack tests. Source: PostgreSQL docs + postgres.js docs, 2026-09-04. See gotcha G9.

## D8 — Tests run against a throwaway `freshnow_test` DB — never mocked, never the demo DB [verified]
CLAUDE.md forbids DB mocking. vitest globalSetup creates + migrates `freshnow_test`; a setup file
points the db layer at it, so running the suite never wipes demo data. Verified: 17/17 green.

## D9 — Built to satisfy externally-supplied acceptance tests [verified]
Four files (db.ts + db.rls/semantic/index tests) appeared in `packages/core/src`, not authored here,
encoding the T2/T6 behaviour in the plan. On the user's instruction we implemented against them
(TDD-style). Only their relative-import extensions were adjusted for NodeNext; logic untouched.
See gotchas G5/G6 and `docs/tasks/TASK-002-schema-rls-semantic.html`.

## D10 — Forward-only migrations with a `schema_migrations` ledger [verified]
`scripts/migrate.ts` applies `migrations/*.sql` to the demo DB and records each applied file, so
re-runs are safe and never drop. The test DB is reset fresh each run by globalSetup instead.

## D11 — Explicit Zod parse at the API boundary, not the Fastify type provider [verified]
`fastify-type-provider-zod` targets Zod 4.1; the codebase is on Zod 3.x to keep the T2 suite stable.
Request bodies are validated with `Schema.parse(req.body)` (ZodError → 400). No new coupling; revisit
if we move to Zod 4.

## D12 — Correlation id minted/echoed at the API edge [verified]
An `onRequest` hook accepts an inbound `x-correlation-id` or mints one, and echoes it — tying a run
across API → worker → `audit_log` (SPEC-000 R9/R11).

## D13 — Single LLM wrapper: Groq (gpt-oss-120b) primary, NVIDIA fallback, bounded + budgeted [verified]
All model calls go through `llmComplete` — schema-validated, 10 s timeout, one retry, provider fallback,
`llm_call` logging, daily budget → degrade to rules-only. Groq model corrected to `openai/gpt-oss-120b`
(llama-3.3 delisted). The model only translates text → validated JSON; it never computes numbers.

## D14 — Outbox is a DB-polling relay (SKIP LOCKED), not BullMQ [verified]
The task board said "BullMQ" for the outbox, but the canonical, more reliable implementation is a
DB-polling relay: `enqueueNotification` writes a row (idempotency_key UNIQUE, ON CONFLICT DO NOTHING);
`deliverOutboxBatch` claims pending rows `FOR UPDATE SKIP LOCKED`, delivers, marks sent/abandoned; 429
never abandons. At-least-once + idempotent enqueue. BullMQ + Redis is reserved for delayed SLA/escalation
jobs (Task 009), which is what it's best at.

## D15 — Blocker parser: LLM translates, engine decides; raw-first; needs_review on failure [verified]
`extractBlocker` (LLM → Zod `{is_blocker, category, severity, …}`) and `parseTaskUpdate` (raw →
note_parsed → blocker | needs_review). The model never decides who/whether — that is Task 009. Raw text
is written before the model runs, so an outage never loses an update. `is_synthetic` inherits from the
update. Live-verified on English + Hinglish.

## D16 — Deterministic routing (table lookup) + rule-based escalation with BullMQ timers [verified]
`routeBlocker` looks up `routing_rule` (category + catch-all → CEO) and sets the SLA; `escalateBlocker`
bumps a level and alerts; `slaSweep` is the safety net; `acknowledgeBlocker` stops it. No model call.
Delayed escalation is a BullMQ job keyed by blocker id (arm/cancel, survives restart). The demo routes only
by category (the blocker has no site/shift); site/shift on `routing_rule` are for future org-wide routing.

## D17 — Labelled synthetic seed via the real engine [verified]
`seedDemo` (idempotent) creates 5 `DEMO –` employees + tasks + past updates + 3 blockers, routed and one
escalated through the actual `routeBlocker`/`escalateBlocker`, so audit/trace history is genuine while all
data is synthetic (`is_synthetic=true`). Run with `pnpm seed`. Replace with real anonymised data once trust
is established.

## D18 — Guarded NL-query: translate→compute→gate, read-only, abstaining [verified]
`answerQuestion`: LLM writes SQL (validated read-only, LIMIT 50) → Postgres computes in a `read only`
transaction → LLM narrates ≤50 rows → numeric-sanity gate → return answer + executed SQL + row count +
verdict. Abstention reachable. The model never counts rows itself. Live-verified with real Groq. Known
limit: the gate catches invented numbers, not semantically-wrong queries (see gotcha G15).

## D19 — Replay re-derives the deterministic decision and reports divergence [verified]
`replayRun(correlationId)` reads the run's audit `blocker.routed` rows, re-derives the resolver via the
pure `resolveForCategory`, and reports any mismatch (e.g. the routing table changed). Only the
deterministic path is replayed; the LLM parse is not replayed for equality. Refactored routing to a pure
lookup so replay and live use the same code.

## D20 — Dashboard is a Fastify-served page; role scoping is RLS at the read boundary [verified]
For the demo the dashboard is a self-contained HTML page served by the API (not Next.js — DEVIATIONS #9),
with RLS-scoped JSON endpoints (`/dashboard/*`) read via `withContext` (app role): CEO sees all, employee
sees own — enforced by Postgres, not the handler. No real auth yet (viewer is a request param). The
NL-query box is wired to `answerQuestion`. Run: `pnpm dev:api` → http://localhost:3001.

## D21 — Bot conversation state lives in grammY's in-memory session [verified]
The onboarding/logging flows are a 7-state tagged union held in `session()` (ships with grammy —
no extra dependency; the `conversations` plugin was unnecessary for this size). Every answer is
written to Postgres the moment it arrives, so a restart loses only the "which question is next"
pointer, never data. Production would back the session with Redis (DEVIATIONS.md).

## D22 — Bot handlers stay thin; all flow logic moved into core [verified]
`packages/core/src/onboarding.ts` and `packages/core/src/updates.ts` hold the logic; the grammY
handlers only translate Telegram → core call → reply. This is CLAUDE.md rule 1 ("if you are
writing business logic inside a bot handler, stop and move it to packages/core") and it is what
makes the flows unit-testable without a Telegram harness — 17 new tests cover them.

## D23 — Checking an invite code must not consume it [verified]
`validateInvite` is deliberately separate from `redeemInvite`, so the PDPL consent notice can be
shown *before* the code is spent. `redeemInvite` then runs in one transaction with
`SELECT … FOR UPDATE` on the invite row, so a double redeem cannot create two identities.
Consent is written in the same transaction as the link.

## D24 — A real person's employee row is NOT synthetic [verified]
`redeemInvite` inserts the employee with `is_synthetic = false`, while seeded demo staff stay
`true`. This keeps the "never present synthetic data as real" boundary meaningful once real
people start using the demo alongside the seed.

## D25 — Parser prompt hardened against low-literacy input [verified]
A 30-run in-persona stress test (barely-literate warehouse worker) drove four reproducible
failures into the prompt's design:
- a leading "boss" flipped a real breakdown into needs_review → explicit FORMS OF ADDRESS rule
- a shortage mentioned *after* good news raised no blocker → explicit "politeness must not hide
  a problem" rule (a polite end-of-shift report is the most natural thing a worker writes)
- a bleeding injury was filed as "staffing" → new `safety` category, and "if a PERSON is hurt,
  category is ALWAYS safety"
- severity moved with spelling/script rather than consequence → severity anchored to CONSEQUENCE,
  with "harm that already happened is never rated below the risk of that same harm"
Languages fixed at English + Hindi + Malayalam only (user instruction).

## D26 — needs_review alerts a human instead of failing silently [verified]
`attachNoteAndProcess` now enqueues a `needs_review` outbox message to the CEO carrying the
employee's raw words, and writes a `task_update.needs_review` audit row. Previously an
un-parseable message was stored and nothing happened — a silent delete for exactly the employees
least able to rephrase. The employee is separately told in the bot that it was saved but not
understood. Satisfies SPEC-000 R25 (escalate to a human, do not guess).

## D27 — Bot conversation state persisted in Postgres [verified]
Supersedes D21 (in-memory session). A `bot_session` table + a grammY `StorageAdapter`.
Conversation state is not employee data — it holds only "which question comes next", and
every answer is written to its own table as it arrives — so the table is safe to drop.
Chosen over Redis to avoid a new dependency in the bot package.

## D28 — Voice uses Groq-hosted whisper-large-v3, not local faster-whisper [verified]
The plan assumed a local CPU faster-whisper `small` model. Groq already serves
`whisper-large-v3` on the key we have: no Python dependency, and the FULL large model,
which is materially better on Hindi and Malayalam than a local `small` would be. Telegram
sends OGG/Opus, which the endpoint accepts directly, so no ffmpeg transcode is required.
Write-first still applies: the `voice_asset` row is inserted BEFORE transcription.
→ Update `DEVIATIONS.md` #4: STT is now a hosted API, which also suits the no-GPU VPS.

## D29 — A worker can just speak or type the problem; menus are optional [verified]
The low-literacy test showed menu navigation is itself a barrier. Any free text or voice
note from a registered employee is now recorded and run through the same parse → route →
alert pipeline, with no menu. This is safe because the parser decides what is a problem:
verified that "aaj sab thik hai", gibberish, "done boss" and 👍 still create nothing.

## D30 — Adminer added as the operator's database console [verified]
Operators need to inspect and correct data without writing SQL from memory. Adminer
(`:8080`, service `adminer` in docker-compose) gives clickable tables, inline row editing
and an SQL box, reachable from the demo phones. Documented in `BACKEND-OPERATIONS.md`
together with the two-role model, the never-edit list, and the correlation_id trace flow.
Demo-only exposure — registered as DEVIATIONS D11.

## D31 — Attachments store Telegram's file_id, never the bytes [verified]
An assignment often is "do this" plus a spec sheet, and a breakdown report is often a
photo of the fault. Telegram accepts a `file_id` wherever an upload is expected, so
forwarding a file to the assignee is a **reference pass**: nothing is downloaded, nothing
is stored on the machine, and no employee document sits on this box. `attachment` keeps
the handle plus metadata (name, mime, size, kind) and `file_unique_id` to notice the same
file arriving twice. This is also the better PDPL position — the minimum necessary is the
reference, not the content.
**Limit recorded honestly:** a `file_id` is not a durable archive. It is scoped to this
bot and Telegram makes no permanent-retention promise. Production must decide a
mirroring/retention policy before an attachment is treated as a record.
Each file is queued as its **own** outbox row (`attachment-<id>`), so one failing file
cannot block the instruction and a retry cannot double-send.

## D32 — One message may carry several work items, capped at 8 [verified]
"tell Rashid to fix van 2 and ask Priya to restock the Marina machine" is two jobs for two
people. `resolveMessage` now returns `items[]`, each with its own task, title and assignee,
every index still validated against the supplied lists — so a multi-item message cannot
invent a person any more than a single-item one could. `task`/`newTaskTitle`/`assignee`
remain as `items[0]` because most messages carry exactly one.
Capped at `MAX_ITEMS = 8` (CLAUDE.md rule 4): an unbounded list from a model is an
unbounded number of writes. Verified live — the two-person message above produced exactly
two assignments with the right titles and the right people.

## D33 — Dashboard KPIs are decision-first, detail is tabular underneath [verified]
Following the operations-dashboard research: at most 9 headline metrics, the ones that
change what the CEO does today first (urgent open, open blockers, carried over), each one
clickable through to the table that explains it; detail tables at the bottom; and a
data-freshness line that is always visible, because a stale number that looks live is the
failure mode that matters. Completed / Pending / Blockers are three real tables with the
person, the task, and — on click — their exact words. Carry-over is grouped by the day the
work was raised, with an age column, so "what is still hanging over from Tuesday" is a
glance rather than a query.

## D34 — A document is READ and split, never forwarded as the assignment [verified]
A CEO who attaches a PDF and says "assign these tasks" is not asking us to post a file at
somebody — nobody can report status against "here is a PDF". The document is downloaded,
its text extracted, and the separate jobs inside it become separate assignments routed to
the people the document names. Verified on the real 2026-09-08 PDF: 4 numbered items became
**6 tracked tasks** (items 1 and 4 each contained two distinct jobs), each its own
assignment with its own delivery, so each has a status thread.

The file itself is forwarded **only** on an explicit tap (`📄 Also send the file`), and then
rides on the first task only, so one document does not arrive six times.

## D35 — The document plan is a proposal the CEO confirms, never an autonomous write [verified]
`planDocumentTasks` returns a plan and writes nothing. The CEO sees every task and its owner
and taps to create them. This follows CLAUDE.md ("no message on the CEO's behalf without an
explicit human tap") and is the right trade regardless: a misread document silently becoming
six people's Monday is far worse than one extra tap. Any task whose owner could not be
resolved is shown as **"⚠️ nobody named — needs you to say who"** and blocks the create
button — the model never picks the nearest-looking colleague.

## D36 — unpdf for PDF text, chosen for zero dependencies [verified]
`unpdf` 1.8.1 (MIT, **zero runtime dependencies**, Node ≥22, published 2026-08-13) ships a
serverless build of Mozilla's PDF.js with the canvas module mocked. Zero deps matters on a
box where every process competes with Postgres for CPU; the `@napi-rs/canvas` peer is for
rendering only and is not installed. Measured on the real PDF: 1 page, 481 chars, **259ms**.
A scan has no text layer and returns nothing — treated as "tell me the tasks here instead",
never as "the document contained no work".

## D37 — /log, /status and /mytasks reach daily capture directly [verified]
Reporting your day was reachable only by tapping through a menu, which is a barrier for
exactly the people who most need to report. All three aliases call one `showLogBoard()`, so
the command cannot drift from the button, and `/log` sits directly after `/start` in the
Telegram command menu.

## D38 — Dashboard navigation: grouped sidebar, counts, deep links [verified]
Eight pills in one horizontally-scrolling strip hid half the tabs off the right edge of a
phone — the device this is actually read on. Now: a grouped sidebar (Today / Work / Records
/ Tools) on a wide screen, a 4-across grid on a phone with nothing scrolled out of reach,
a live count on each tab so you can see where the work is without opening it, a breadcrumb
naming what you are looking at, and the tab kept in the URL hash so a refresh or a shared
link lands back on the same view.

## D39 — Opening an attached document is a deterministic branch, not a classification [verified]
If the sender is the CEO and a readable work document is pending, the document is read —
decided before any model call, gated only by "is this obviously a question?". The presence of
the document is a fact; delegating it to an intent classifier made the whole feature depend on
whether a terse caption happened to parse as `assignment`, and it did not (G34).

This is CLAUDE.md rule 3 applied to a decision that had quietly become a model call. The
model's job stays what it should be: reading the document's prose, never deciding whether to
look at it.

A no-caption document now also offers **"📄 Read it and assign the tasks"** directly, so the
CEO never has to guess the wording that triggers the feature.

## D40 — An unrecognised name is reported by name, not as a blank [verified]
`DocumentTask.namedAs` carries the name the DOCUMENT used, kept **especially** when it matched
nobody. The CEO sees `⚠️ document says "manvanth" — not in the system, tap to say who` rather
than `⚠️ nobody named`. The first tells them whether to add a person or pick a different one;
the second tells them nothing. Verified live on a real document naming Hemanth, "manvanth" and
"Atif": 2 tasks owned, 2 flagged by name, none guessed.

Creating a partial plan also states what was **not** created and why — a silent skip is how
somebody comes to believe a job was handed out when it never was.

## D41 — The threat model is stated honestly, not inflated [verified]
This process never executes a document: text is extracted by PDF.js with canvas mocked,
there is no viewer, no PDF JavaScript engine, no shell-out. Embedded JavaScript in a PDF
**cannot run here**, and claiming otherwise would be security theatre. The three risks that
are real:

  A. **We become the delivery mechanism.** If the CEO taps "also send the file", we hand a
     document to an employee whose phone viewer WILL act on /OpenAction, /Launch and
     embedded JS. A file we merely stored is inert; a file we forwarded is distributed.
     This is the risk that actually matters, and it is why the gate's decision is
     `mayForward`, not `mayRead`.
  B. **Prompt injection** into the planner (D42).
  C. **Resource exhaustion** on a shared-vCPU box.

`document-security.ts` is explicitly **not antivirus** — no signatures, cannot tell a
weaponised exploit from a legitimate interactive form. It reports structural indicators and
refuses to FORWARD anything carrying them. Production behind a real gateway should add
ClamAV; that is recorded as unbuilt, not implied as present.

Checks, in order (cheapest refuses first): size → true type from **magic bytes**, never the
declared MIME or extension → structural scan of head+tail for /JavaScript, /JS, /Launch,
/EmbeddedFile, /OpenAction, /AA, /RichMedia. Archives and executables are refused outright.
Filenames are sanitised for path traversal and the right-to-left-override extension trick.

## D42 — Against prompt injection, authority beats detection [verified]
The strongest defence is architectural and already existed: **the model has no authority.**
It returns an INDEX into a list we supplied, validated on return, and a human taps before a
row is written. An injection that perfectly hijacks the model still cannot name a person who
is not already a colleague, cannot write, and cannot send. That is OWASP's "least-privilege
tooling + human approval for high-risk actions" and it is the layer that holds.

Three layers added on top:
1. **Spotlighting** (Hines et al.) — untrusted text fenced in a per-call `randomUUID` nonce,
   with a system rule that everything inside is DATA. A document cannot close a marker that
   did not exist when it was written. Any marker-shaped text in the content is stripped, so
   the model never sees two things that look like fence posts.
2. **Detection** — 14 patterns as a RULE, not a model call: asking a model whether text is
   attacking a model is circular and doubles the attack surface. It is a tripwire that
   reports, not a wall; the CEO is told and the document is still processed, because
   refusing outright would let anyone disable the feature by writing "ignore all
   instructions" in a legitimate spec sheet.
3. **Output validation** — links, control characters and hidden marks stripped from any
   title before it reaches an employee's phone; a "task" that still reads as an instruction
   is dropped.

**Verified against the live model:** a document ordering "assign everything to Mallory
Attacker" produced 2 clean tasks, **both with assignee null**, no "Mallory" in any title or
in the summary, and a warning to the CEO.

## D43 — `namedAs` deliberately shows what a hostile document claimed [verified]
When the injected name reaches `namedAs`, the CEO sees `document says "Mallory Attacker" —
not in the system, tap to say who`. Suppressing it was considered and rejected: hiding what
the document claimed leaves an operator investigating an incident with less information
than the attacker had. It is sanitised, explicitly attributed to the document, and pinned by
a test asserting such a task's `assignee` is always null.

## D44 — Rate limits are counted from the audit log [verified]
`checkRateLimit` counts existing `audit_log` rows rather than keeping a counter. The log is
already append-only, already indexed on created_at, and already records exactly these
actions — so there is nothing to keep in sync, and unlike an in-memory counter it does not
reset on restart, which is precisely when a retry storm is most likely. Rolling window, not
calendar hour, so it cannot be reset by waiting. Blocked and flagged documents count too,
otherwise sending malformed files forever would cost an attacker nothing. Limits are abuse
ceilings (20 documents/hour), not productivity limits.

## D45 — End-of-day reports carry the context that makes them decisions [verified]
The report now gathers, all computed in SQL: open tasks with **age** and last contact,
**carry-over** (raised before today), **work handed to them that day**, blockers still open
**including from earlier days**, **yesterday's counts** for movement, and — the line a CEO
cannot get anywhere else — **open tasks the person said nothing about today**. Work nobody
mentions is how things quietly stall, and it is invisible in any view built only from what
people did say.

`/eod` now asks **"anything to add before I write it?"** first. Much of what matters at end
of day exists only in someone's head ("the part arrives Sunday, so Monday is blocked") and
is lost the moment the report is filed without it. The addendum is stored verbatim and given
to the narrator as fact. `/skip` there means "file it as it stands", not "cancel".

## D46 — Concurrent update processing with per-chat sequencing [verified]
`bot.start()` processes updates **one at a time**. Every handler here can make a 1-4s model
call, so ten employees reporting at the end of a shift queue behind each other and the tenth
waits the better part of a minute — for a bot whose entire value proposition is that
reporting is quick.

Switched to `@grammyjs/runner` (`run()`), with **`sequentialize()` keyed by chat id as the
first middleware**, ahead of session loading. Different people run in parallel; one person
runs in order. The sequencing is not optional: conversation state lives in one
`bot_session` row per chat, so two concurrent handlers for the same person would both read
the same step, both act on it, and the later write would erase the earlier — losing a
half-finished registration or creating one document's tasks twice.

`sink.concurrency` is 50, far below the runner's default of 500: this box has 8 vCPU shared
with Postgres, Redis and the worker, and admitting more work than can be served converts a
queue into memory pressure.

## D47 — Concurrency is capped at the model, not just at the bot [verified]
Processing updates concurrently does not make a system scale; it moves the bottleneck. Ten
simultaneous messages become ten simultaneous model calls and the provider answers with
429s. `llmSemaphore` (6 concurrent, 200 queued) wraps `llmComplete`, which every model call
in the system already funnels through — so the cap is honest rather than advisory. Documents
get their own narrower semaphore (2), because a document read is a download plus a parse
plus a large prompt.

The wait queue is **bounded**: an unbounded queue under sustained overload is a slower way
to run out of memory, and it holds work until long after the person gave up. Past the cap we
fail fast and say so.

**Measured, not assumed** — 20 simultaneous messages through the real pipeline:
`8.2s elapsed, 20/20 succeeded, 0 rejected, peak concurrent exactly 6, peak queued 14`,
against roughly 30s sequential. About 3.7x, with the limit holding exactly.

`/health` now reports `load` per semaphore (active, waiting, peak, rejected) so saturation is
observed rather than guessed; status becomes `busy` when anyone is queuing.

## D48 — Session timezone on the connection, not per query [verified]
`connection: { timezone: "Asia/Dubai" }` on both pools, rather than rewriting 21 date
windows. A per-query fix leaves the NEXT query to get it wrong with nothing to catch it;
a connection-level setting makes every present and future query correct by default.
`timestamptz` storage is unaffected — only the interpretation of date casts changes, which
is exactly what a day boundary needs.

## D49 — The SQL row cap wraps rather than appends [verified]
`select * from (<model sql>) as bounded_result limit 50`. The previous "does it already
contain a LIMIT?" test was satisfied by a LIMIT in a subquery, so the cap was bypassable by
construction. Wrapping makes it structural: whatever the inner query does, the outer LIMIT
is the last word, and the caller's own inner LIMIT still applies.

## D50 — Escalation runs on the sweep; the timer is real but idle, and said so [verified]
`slaSweep` is THE live mechanism. The BullMQ delayed-timer path exists, has a running
consumer and is tested, but nothing ever ARMS it — `armEscalation` lives in the worker while
the code that routes a blocker lives in core, and core must not depend on the worker. That
dependency direction is why it was never wired, and the bot used to tell the CEO "the
escalation timer is cancelled", which was untrue.

Rather than invert the dependency late, the sweep interval went from 5 minutes to 60
seconds: escalation is now at most a minute late instead of five, which for a 15-minute
critical SLA is the difference that matters, at the cost of one indexed query a minute. The
timer path also gained the same "already escalated?" guard the sweep has, so it is safe if
it is ever armed. Wiring it properly means moving the queue into core — recorded as not
done rather than implied.

## D51 — An optional shared secret for the dashboard, off by default [verified]
The API binds `0.0.0.0` so a phone can reach it and there is NO login, so anyone on the same
wifi can read every employee's data and use the NL-query box, which runs generated SQL as
the BYPASSRLS service role. Adding a `viewer=ceo` check would have been theatre — `viewer`
is a query parameter anyone can set.

`DASHBOARD_TOKEN` is real: set it and every `/dashboard/*` request must carry it
(`?k=` or `X-Dashboard-Key`, constant-time compared); leave it unset and the demo behaves
exactly as before. A gate that can be switched on is worth more than a comment saying one is
needed, and the default keeps the trade-off visible rather than pretending it away.

## D52 — LangChain: no. LangGraph: no. Langfuse: yes. Decided separately [verified]
These three are marketed as a stack and are three independent decisions.

**LangChain — no.** Its value is a uniform provider interface plus structured output and
tool plumbing. `packages/core/src/llm/client.ts` already is that, in ~200 lines, and every
line exists because of a failure we actually hit. Replacing understood code with a
dependency whose failure modes we would then have to learn is a net loss.

**LangGraph — no, and not close.** Its central feature is *model-driven control flow*.
CLAUDE.md rule 3 forbids exactly that in writing: "Routing, escalation, and assignment are
rules and lookups — never model calls." Everything LangGraph is recommended for, this system
already has deterministically: durable state (`bot_session`), branching (`routing_rule`),
human-in-the-loop (`confirm_doc_tasks`), bounded loops (SQL cap 8, MAX_ITEMS 8, semaphores).
It is also Python, while the bot is grammY on Node — so adopting it means two runtimes or a
full rewrite.

**Langfuse — yes.** The research finding that decides it: **Langfuse is framework-agnostic.**
Its TypeScript SDK v4 is a thin layer over the OpenTelemetry client and works with a plain
OpenAI-compatible call — no LangChain required. It fixes a defect we have carried for days
(`llm_call.cost_usd` reports 0 because the pricing table has no entry for current model ids),
adds nested traces, and brings prompt versioning plus datasets, which is what CLAUDE.md's
"contract tests on every prompt change" actually needs. One dependency, one wrapper,
reversible in a single file — the property the other two lack.

## D53 — Agentic tool-calling belongs in the question box and nowhere else [verified]
Measured industry figures: an agent loop costs **3–5x** for a simple task, **5–30x** typical,
**50–100x+** for multi-agent, because every step re-sends the accumulated context and tool
definitions.

Every model call in FreshNow today is a **single-shot extraction** — text in, one validated
JSON object out. `parseTaskUpdate`, `resolveMessage`, `planDocumentTasks` and the EOD
narration have nothing to iterate on; the context is retrieved deterministically *before*
the call. Wrapping a ~600-token status extraction in a four-tool agent loop makes it roughly
2 500 tokens to produce the identical JSON — a multiple on the bill for nothing.

The exception is `answerQuestion`. "Why is Priya behind this week?" genuinely needs a lookup,
then a decision about what to look at next. That loop is already half-built (bounded at 8
iterations, read-only guard, row cap, numeric-sanity and grounding gates). What would improve
it is **more tools, not more framework**: `get_employee_context`, `get_task_history`,
`search_notes` over the pgvector extension that is installed and unused. Native tool calling
on the existing OpenAI-compatible endpoint handles the loop. It is used a few times a day by
one person, so even a 10x multiplier there is negligible in absolute terms.

## D54 — Supabase yes, React yes, FastAPI not now [verified]
**Supabase — do it.** Supabase *is* Postgres: the schema, all six migrations and every RLS
policy move essentially unchanged, and it closes the largest open gap, which is that the
dashboard currently has **no authentication at all**. A decision made months ago turns out to
be exactly what it requires: Supavisor pools in *transaction mode*, and this system already
sets RLS context with `set_config(..., is_local => true)` rather than a plain `SET`, which
was written to stop a pooler leaking one user's context into another's.

**React + Tailwind — do it.** Additive and low-risk: it consumes the same API, so the tested
core is untouched, and it replaces the weakest component (a dashboard hand-written inside a
JS template literal). Built and shipped this session at `/app`, with the old page still at
`/` so the cutover is a one-line change and reversible.

**FastAPI — not now.** The backend is ~7 000 lines carrying 197 tests, 53 recorded decisions
and 50 gotchas, each of which is a bug someone hit. A rewrite re-discovers all fifty. The bot
cannot move (grammY and the concurrency work are Node), so it means operating two runtimes
rather than replacing one. The usual reason to want Python here is the LangChain/LangGraph
ecosystem, and the recommendation above is not to adopt those. If there is another reason —
a Python-only team, a client requirement — the calculus changes and it should be stated.

## D55 — The React dashboard is served by the API at /app [verified]
Same origin as `/dashboard/*`: no CORS configuration, no dev proxy in production, and a phone
reaches it on the host and port it already uses. Mounted at `/app` rather than `/` on purpose
— the existing page keeps `/` until the React one has been used on a real phone, so the
cutover is one line and the rollback is the same line.

## D56 — Rate-limit waiting is budgeted per call, not per attempt [verified]
A 429 is "come back shortly", not "this provider is broken", so `llmComplete` now waits the
provider's own reset hint (`retry-after`, else `x-ratelimit-reset-tokens`) instead of burning
a retry in milliseconds and failing over.

The budget is **25s across the whole call**, not per attempt. Per-attempt waiting could
stack to a minute on a message someone is waiting for; a single wait would not survive a
token budget that stays spent for several seconds. A per-call budget bounds the worst case
a person experiences while surviving the short, self-clearing limits a per-minute quota
actually produces.

The cap on any single wait is 30s for the same reason: past that the person has given up,
and failing over to another provider — or degrading to rules-only — serves them better than
sleeping.

## D57 — Concurrency is sized to the provider, not to the box [verified]
`llmSemaphore` went 6 → 2. The original figure came from this machine's 8 vCPU, which was
the wrong constraint by a wide margin: Groq's on-demand tier allows **8 000 tokens/minute**,
and six concurrent document plans is ~14 000. See G53 — it took out a test run.

This is a **provider ceiling, not a code one**. On a paid tier with a higher TPM the limit
should be raised, and the number to raise it against is `x-ratelimit-limit-tokens` divided by
the worst-case call size (~2 350 tokens for a document plan), not the core count.


## D58 — Dashboard identity comes from a verified Supabase JWT, never from the request [verified]
With `SUPABASE_URL` set, a `preHandler` hook on `/dashboard/*` and `/employees/*` verifies
the bearer token against the project's published keys (`/auth/v1/.well-known/jwks.json`,
ES256 or RS256 only, issuer and audience checked) and maps `sub` to an employee through
`employee.auth_user_id`. The RLS context is built from that employee. `?viewer=` is
ignored entirely: a parameter the caller controls is not an identity. Verification is local
(`jose.createRemoteJWKSet` caches the key set), so there is no auth round trip per request.
A token that fails any check gets one message, "Session is invalid or has expired", because
telling a caller which check failed helps an attacker more than a user.

## D59 — Demo mode survives, switched by SUPABASE_URL alone [verified]
Unset `SUPABASE_URL` and the dashboard behaves exactly as before (`?viewer=` demo auth, old
page at `/`). Same build, same code paths. The test suite defaults to demo mode:
`vitest.setup.ts` deletes the `SUPABASE_*` variables, so a developer's `.env` pointing at
Supabase does not silently change what is tested; `auth.test.ts` turns sign-in on for itself.

## D60 — `employee.auth_user_id` has no foreign key to `auth.users` [verified]
`auth.users` exists only in the Supabase `postgres` database. A hard FK would make the
migrations Supabase-only and break the throwaway test database and any plain-Postgres
deployment. The link is checked where it matters — when a token is presented. A partial
unique index keeps one account per employee.

## D61 — Under sign-in, the question box, report generation and invites belong to the CEO [verified]
`POST /dashboard/query` still runs generated SQL as the service role (per-viewer scoping of
generated SQL is not built), so it cannot be open to every signed-in employee.
`POST /dashboard/eod/generate` writes a report for everyone and spends model calls.
`POST /employees/invite` mints an identity. All three return 403 for a non-CEO token, and
the React app hides the controls rather than showing buttons that can only fail.

## D62 — Names cross the RLS boundary through one function, not a wider policy [verified]
Migration 0008 adds `employee_display_name(uuid)`: SECURITY DEFINER, `search_path` pinned,
execute granted to `freshnow_app` only. It returns a display name and nothing else. The
alternative — letting employees read every employee row — would expose site, shift,
Telegram id and consent state to colleagues. Names already reach employees through the bot.

## D63 — The Supabase secret key is read only by `pnpm link:user` [verified]
The secret (service-role) key bypasses RLS through Supabase's Data API. The API, bot and
worker never read it; only `scripts/link-dashboard-user.ts` does, to create accounts
through the Auth admin API. Each link is audited as `dashboard_user.linked` with the auth
user id, not the email address.

## D64 — On Supabase the service role is `postgres`, and the app role is unchanged [verified]
`postgres` on Supabase has BYPASSRLS but is not a superuser, which is all the service
connection needs (FORCE RLS tables included). `freshnow_app` is created by migration 0001
exactly as on plain Postgres. Migration 0007 revokes Supabase's default grants to `anon`
and `authenticated` on everything in `public`, including future tables.

## D65 — Data moved as a data-only dump under `session_replication_role = replica` [verified]
Schema came from our own migrations (so `schema_migrations` is truthful); rows came from
`pg_dump --data-only --column-inserts` of the old database, loaded in one transaction with
FK triggers suspended (the `employee` self-reference makes the dump circular). Every
table's count was compared and four FK paths spot-checked. The old `freshnow-db` container
is untouched as the rollback copy; the old `.env` values are kept, commented.


## D66 — The cost log records what was charged, and estimates only when it must [verified]
Every one of the first 296 logged model calls said `cost_usd = 0`: `cost.ts` had an empty price
table, so the daily budget cap could never trip. Now `llm_call.cost_usd` is the provider's own bill
when it sends one (OpenRouter's `usage.cost`), and otherwise tokens × list price from a table that
covers the configured models (Groq on-demand rates, checked 2026-09-12). The Groq account is free
tier, so logged Groq costs are what the calls *would* cost on a paid tier — say so wherever the
numbers are shown. Verified live: a Groq call logged $0.000117; an OpenRouter call logged the
$0.000027 OpenRouter billed.

## D67 — The OpenRouter fallback stays `gpt-4o-mini`; `gemini-2.5-flash-lite` is the candidate [verified]
`gpt-4o-mini` has now passed every task on two separate days (6/6 on 2026-09-07, 5/5 on
2026-09-12, including the injection test). `gemini-2.5-flash-lite` also went 5/5 on 2026-09-12,
faster and cheaper — but once. Switching the fallback on a single sample would repeat the G51
mistake in the other direction. Re-run it on the full set before changing `OPENROUTER_MODEL`.

## D68 — Python joins as a worker behind the queue, never as a rewrite of the API [verified]
The FastAPI question, answered for the record. The API stays Fastify/TypeScript: it already has
validation, async I/O and speed, and the bot, worker, rules and dashboard share one language and one
set of types. Where Python genuinely earns its place — Phase 4 forecasting, Phase 5 route
optimisation with OR-Tools or VROOM — it arrives as a separate worker that takes jobs from BullMQ
and writes results to Postgres. The one thing that would change this is a team or client that will
only ever maintain Python, and even then it is a planned project after the demo.


## D69 — The dashboard is a channel: it calls core, never Telegram, never a copied rule [verified]
Every write route in `packages/api/src/routes/work.ts` and `documents.ts` is a Zod-validated shell
over the function the bot already calls (`assignTask`, `recordTaskUpdate`, `createTask`,
`acknowledgeBlocker`, `planDocumentTasks`). Telegram delivery follows because `assignTask` writes
the outbox row the worker delivers. Verified end to end: three assignments made in a real browser
were `sent` to Hemanth's phone within seconds, with no code in the API touching the Bot API.

## D70 — Write authorisation lives in the handler, and every refusal has a test [verified]
Core writes use the BYPASSRLS service role; Postgres will not refuse them. So each write route
checks permission explicitly (`isCeo`, ownership via an RLS-scoped read) before calling core, and
`work.test.ts` / `documents.test.ts` prove six refusals. Reads keep using `withContext` and RLS.
`packages/api/src/viewer.ts` is the single definition of who the viewer is, shared by all routes.

## D71 — New routes live under /dashboard/* so they inherit the auth hooks [verified]
The shared-secret `onRequest` and JWT `preHandler` hooks match `/dashboard*` (and `/employees*`).
A new prefix is unauthenticated by default. Putting write routes under `/dashboard/` is the
cheapest way to make forgetting impossible.

## D72 — A browser upload produces tasks, not a forwarded file [verified]
Attachments are Telegram `file_id`s; an upload has none. `POST /dashboard/documents/plan` runs the
same byte-level gate, the same extraction inside the document semaphore, and the same planner as
the bot, and `/apply` calls `assignTask` per confirmed row with the file name in the note. The
response carries `fileForwarded: false` and the card says so before the user acts. Forwarding
(worker uploads bytes, stores the returned id) is planned, not built.


## D73 — One predicate decides visibility: app_can_view_employee(target) [verified]
Migration 0009 rewrites every SELECT policy that used to say "own row or CEO" in terms of a single
SECURITY DEFINER function: CEO → everyone; manager or lead → their direct reports; lead → their
department (case-insensitive); everyone → themselves. `canAssignTo` in `core/org.ts` is its
TypeScript twin for writes, which run as the service role. A rule that exists in exactly two
places, both tested against the same seven-person org, is the smallest honest number.

## D74 — access_role is permission; role_title is a job title [verified]
People type their job title at onboarding ("AI Engineer", "route driver"). Permission must not be
inferred from free text, so it is a separate CHECKed column with four values, changed only by the
CEO and audited with before/after (`employee.org_updated`).

## D75 — A missing role in the context is the most restrictive role [verified]
`app_access_role()` returns 'employee' when the GUC is unset. A caller that forgets to pass the
role can hide rows, never reveal them. Tested: a lead's context without the role sees only the lead.

## D76 — The reporting line cannot loop, enforced in the database [verified]
A BEFORE trigger walks up to 20 hops from the proposed manager and raises on a cycle or
self-management. The API turns that into 409 with the reason. Any recursive "who is above me"
query is now safe to write.


## D77 — A percentage is one of three named things, and the column says which [verified]
`task.progress_source` is counted (done steps / total, wins whenever steps exist), status (the
lookup's pct_when_here when there are no steps), or self_reported (typed by a person, mandatory
note, replaced by the next countable change). Every change is appended to progress_event. The
"90% for three weeks" failure the PM literature warns about becomes a query, not a memory.

## D78 — Status and resolution are two columns, set together at the end [verified]
Status is where a task is; resolution is why it stopped (done, wont_do, duplicate, cancelled).
recordTaskUpdate sets resolution = done with status = done; closeTask sets status = cancelled with
the chosen reason. Reports group by task_status.category, never by the status name.

## D79 — The three task-child tables cascade; their people references set null [verified]
task_step, task_relation and progress_event have no meaning without their task, so they are
ON DELETE CASCADE — the one deliberate exception to this schema's no-cascade convention. Their
done_by / created_by / employee_id references are ON DELETE SET NULL so the reset script can remove
a person and the record of what happened to the task survives. Without this, every existing test
teardown and the reset script would have failed on the new foreign keys.

## D80 — "Behind" is a flag from two dates and a percentage, never a forecast [verified]
elapsed_pct = time since started_at over the start→due window; behind when elapsed_pct minus
progress_pct exceeds 30 points (BEHIND_THRESHOLD_POINTS in api/routes/tasks.ts, [assumed]). Shown as
a pill on the board and in the panel. Never "X% likely to be late": that would be a prediction the
data cannot support.

## D81 — Escalation targets are symbolic, resolved at fire time [verified]
`escalation_target.target_type` is one of resolver, manager_of_raiser, department_lead, ceo, employee —
not a uuid, except for the deliberate `employee` case. The people are looked up when the rung fires, so
the ladder survives staff changes (Jira's notification-scheme approach). A rung that resolves to nobody
is recorded with `escalated_to NULL` and the next rung is tried in the same call: **skipped, not dropped**.
The NULL row is what stops the next sweep retrying the same empty rung forever.

## D82 — One alert per PROBLEM, not per report [verified]
`alert.alias` is the person, category and named asset, lowercased, with a unique index where
`state <> 'resolved'`. A second report of the same problem while the first is open increments `count`
and pages nobody (Opsgenie's alias dedup) — this is the fix for the two identical "Escalation L1"
messages. `blocker.alert_id` ties every report to the problem, so acknowledging the alert acknowledges
all of them. Without a named asset the alias falls back to the blocker's own id: guessing that two
free-text reports are the same problem would suppress a real one, so the failure mode is one message
too many, never one too few. Count blockers for "how often was this reported"; count alerts for "how
many problems were there".

## D83 — The outbox knows about channels; the worker has a sender per channel [verified]
`notification_outbox.channel` (telegram | inapp | email | webpush) plus `recipient_employee_id` and
`reason`. The relay claims **only rows whose channel it has a sender for**, so a row for a channel that
is not switched on waits rather than failing — the honest state. `inAppSender` is a no-op because the
row *is* the notification: the in-app inbox needs no network, no token and no third party, which is what
makes the Telegram-independence proposal credible rather than theoretical. A bare function still means
"the Telegram sender", so every older caller and test is unchanged.

## D84 — Every alert records the rule that chose the recipient [verified]
`resolveAlertRecipients` returns `{employeeId, channel, reason, ruleId, delayMinutes}` and `notify()`
writes the reason onto the outbox row and the whole list into `alert.enqueued`. "Who was told what and
why" is therefore a query, not a reconstruction. `alert.no_recipient` is logged when a rule matches
nobody — the case worth knowing about, because it means somebody should have been told and was not.
The idempotency key is structural (`<event>:<entity>:<person>:<channel>`), so idempotency is met by
construction rather than by a check.

## D85 — One acknowledge rule, shared by the bot and the dashboard [verified]
`mayAcknowledgeBlocker(actorId, blockerId)` in core: the CEO, the assigned resolver, or someone who
manages the person who raised it. The bot handler was CEO-only and the API had the same rule written
inline; two rules for one decision is how they drift apart.

## D86 — The task table is the unit of work for projects too [verified]
`task.project_id` and `task.milestone_id`, not a parallel project-task system. Everything Phase 3
built — steps, progress with a named source, relations, resolution — applies to project work
unchanged, and a person's "My work" stays one list whichever kind of work it came from. A second
task table would have meant two of every rule, drifting apart. `flow_metrics` separates the two by
`project_id IS NULL` meaning ordinary operational work.

## D87 — A project's progress is a VIEW, never a column [verified]
`project_progress` computes it from milestone weights when the project has milestones, and from the
tasks' own (already evidence-based) percentages otherwise; `progress_source` says which, and the UI
never shows the number without it. A stored percentage is one somebody typed once and nobody updated;
a view cannot go stale. A task in the 'done' CATEGORY counts as 100 whatever its stored percentage
says, so a stale value cannot drag a project down. Both views are `security_invoker = true` —
without it a view is a hole straight through RLS.

## D88 — A project issue is not a blocker, and they get different tables [verified]
A broken chiller is an operational problem with a response window measured in minutes and an
escalation ladder; "the supplier may slip two weeks" is a risk reviewed weekly. One table for both
would give one of them the wrong urgency and would corrupt the blocker SLA statistics. `project_issue`
has its own vocabulary (issue | risk | dependency | decision) and its own states, including
'accepted' — meaning we decided to live with it, which a blocker never gets to be.

## D89 — A claimed percentage is stored BESIDE the computed one, never instead [verified]
`project_update.pct_reported` is what a person says; `project_progress.progress_pct` is what the work
shows. The API returns the computed figure with the claim, the audit row records both at the moment
the claim was made, and the UI writes the gap out in words ("You said 80%; the work shows 25%").
Nobody is overruled and nothing is hidden — the gap is the most useful number on the page.
Health is the other human judgement, and it always carries a mandatory note and a timestamp.

## D90 — Flow metrics, not earned value; percentiles, not means [verified]
`flow_metrics` implements the Kanban Guide's four: WIP, Throughput, Work Item Age, Cycle Time — with
cycle time as p50/p85/p95 because the distribution is skewed and the mean of a skewed distribution
describes nobody's experience. Work Item Age is the only leading indicator of the four. SPI, CPI,
earned value, velocity and burndown are deliberately absent: they need a time-phased cost baseline
FreshNow does not keep, and inventing one would be a fabricated number.

## D91 — The milestone gate: refuse, then record the override [verified]
Marking a milestone done over unfinished work is the commonest way a project reports itself green
while being late. Core refuses; the route answers 409 with the count; the UI asks; `force: true`
writes `forced` and `openTasksAtTheTime` into the audit row. Nothing is prevented — it is simply
impossible to do quietly. The same shape as the self-reported percentage in D77.

## D92 — The change notification carries NO row content [verified]
`pg_notify('freshnow_change', ...)` sends the table name, the operation and a timestamp. Not an id,
not an employee, not a project. `LISTEN` has no row security of its own and the API holds ONE
listening connection shared by every signed-in viewer, so any identifier in the payload would be a
channel straight past RLS — an employee could learn a blocker had been raised about a colleague just
by watching. Clients re-fetch through the ordinary RLS-scoped endpoints instead: the stream is a
doorbell, never a delivery. Two tests assert the payload has exactly three keys. The cost is that
every client refetches on every change to a watched table; at FreshNow's size that is cheaper than
the polling it replaces, and the fix under load is per-viewer filtering in the API, NOT a richer payload.

## D93 — Live updates never replace the poll, they only slow it down [verified]
The poll stays at 120 s while the stream is healthy and returns to 20 s the moment it is not, and the
status line reads "live" or "polling" so which is in force is visible rather than assumed. A stream
that dies quietly therefore degrades to exactly what existed before, instead of to a board that has
silently stopped updating — which is the failure mode that makes people stop trusting a dashboard.

## D94 — Statement-level triggers, not row-level [verified]
`for each statement`, so one UPDATE touching 200 rows produces one notification. Since the payload
carries no row content there is nothing per-row to say anyway, and row-level triggers on a bulk write
would turn one action into hundreds of notifications and hundreds of client refetches. Tested: five
rows, one UPDATE, one event.

## D95 — `llm_call` is the record of cost; Langfuse is the timeline on top [verified]
The table answers "what did this cost" and the daily budget cap reads it, so it must never depend on
a third party being up. Langfuse answers the different question — "what happened, in order": that a
parse hit a 429 on Groq, waited, fell through to OpenRouter, and failed schema validation there, all
inside one employee's message. Both are written from the same place (`logLlmCall`); only the table is
load-bearing. The existing `correlation_id` is used directly as the trace id, so every model call in
one run groups into one trace with no new plumbing.

## D96 — No Langfuse SDK; one fetch against the ingestion API [verified]
Langfuse takes a batch of JSON events over HTTP with basic auth. That is the whole integration. Adding
the SDK plus its transitive tree, on a box where every process competes with Postgres for 8 shared
vCPUs, to wrap one POST, fails the CLAUDE.md test for adding a dependency. The client is ~200 lines
including its comments.

## D97 — LLM tracing captures NO employee text by default [verified]
`LANGFUSE_CAPTURE_CONTENT` unset sends model, provider, tokens, cost, latency and success — enough for
every question about cost and reliability. Set to 1 it also sends prompt and completion TEXT, which
here is employees' own words about their shift. With a hosted Langfuse that means their free text
leaves the company, needing the same lawful basis, notice and consent as any other processing (PDPL).
The default is the one that cannot create that problem, the flag is separate from the on/off keys, and
the generation's metadata carries `contentCaptured` so absent-by-policy is never mistaken for a bug.
Also: **no `userId` on any trace** — tying traces to a person would build exactly the individual
profiling CLAUDE.md forbids.

## D98 — Tracing is fire-and-forget, bounded, and counted [verified]
Every send has its own 5 s timeout, every failure is swallowed, the queue is capped at 200 events and
drops rather than growing, and the flush timer is `unref`'d so it never holds a process open. Losing a
trace is acceptable; losing an employee's update because an observability tool was down is not. The
counters (`sent`, `failed`, `dropped`) are reported on `/health`, because fire-and-forget and "quietly
failing for a week" are indistinguishable without them.

## D99 — The portal picker comes before sign-in, and is not a security boundary [verified]
`/app/` opens on two cards (Task & logging, Projects); choosing one leads to a sign-in that names it,
and you land in that portal. Choosing first is worth the click: the portals answer different questions,
people arrive knowing which they came for, and the login screen can then say what it is for.
**But the same account opens both**, and access is still decided by role plus RLS. The login card says
so in words, because a picker that looks like two logins would imply a boundary that does not exist —
worse than having none. An existing session is never re-challenged: asking again for a password the
browser already holds is theatre. Signing out returns to the picker.

## D100 — Every colour is a token with two values; no hex literals in classes [verified]
Dark values in Tailwind's `@theme`, light overriding the same names under `:root[data-theme="light"]`.
No component knows which theme is on. The prerequisite was removing all 26 hardcoded literals
(`bg-[#1f2630]` → `bg-sunken`, etc.) — a literal is invisible in dark and a black hole in light, so the
theme cannot work while any survive. New tokens: sunken, well, on-accent, crit/high/med bg+fg pairs,
demo-edge, scrim. Nothing guards this automatically yet; a lint rule banning `[#` in className would.

## D101 — Three theme states, not a toggle: Light, Dark, Auto [verified]
A two-state switch cannot express "it is dark because my laptop is". Auto follows the OS and keeps
following it while the page is open (a `matchMedia` change listener, verified by emulating both). An
explicit choice wins and persists in localStorage. A dashboard on a wall should go light when the
office does, without anyone touching it — and somebody surprised by that should be able to see why and
stop it.

## D102 — The light accents are darker than GitHub's, for a measured reason [verified]
`--color-ok/warn/crit/link` in light are #116329 / #7d4e00 / #a40e26 / #0550ae rather than GitHub's
lighter equivalents. They are used as 14px text on their OWN 15% tint (the selected tab, the active
nav item): GitHub's values give ≈5.1:1 on white but only ≈4.15:1 on that tint, under AA's 4.5. The
darker set gives ≈5.9:1 on the tint and ≈7.4:1 on white. Re-measure before changing them.

## D103 — The NL-query runs as the RLS-enforced role, in the asker's own context [verified]
`runReadOnly` used `getServiceSql()` — the BYPASSRLS `postgres` role, a member of `pg_read_all_data`,
which can read `auth.users`, `auth.refresh_tokens` and `auth.identities`. Confirmed live:
`has_table_privilege('postgres','auth.users','SELECT')` → true. That contradicted CLAUDE.md ("a
read-only role against pre-approved views" — neither half was true) and `db.ts`'s own rule that the
service client is "never for user-facing reads". It now runs through `withContext(asker, …)` on
`freshnow_app`, which has **no privileges on the `auth` schema at all**, is not BYPASSRLS and is not a
superuser — so the worst a wrong or injected query reaches is what the asker could already see. The
box is CEO-only and a CEO's context sees every business row, so nothing legitimate was lost.
`guard.ts` additionally refuses any non-public schema and the catalogue, with 11 tests, as the second
lock rather than the first.

## D104 — Privileged employee columns are guarded by a trigger, not just by RLS [verified]
`employee_update` (migration 0001) allowed `id = app_current_employee()` with **no column
restriction**, so an employee could `update employee set access_role='ceo' where id = <self>` — and
rebind their own `auth_user_id` and `telegram_user_id`. Verified as the real app role before the fix.
Postgres has no per-column WITH CHECK, so migration 0014 adds a BEFORE UPDATE trigger refusing changes
to `access_role`, `auth_user_id`, `manager_employee_id`, `department`, `status` and
`telegram_user_id` from anyone but the CEO or the service role. Ordinary profile edits still work
(verified). Not reachable over HTTP before or after — every write route checks permission first — but
RLS is the last line of defence and the point of a last line is that it holds when the others do not.

## D105 — RAG is not the right tool for FreshNow's operational data [verified reasoning]
Measured 2026-09-18: the entire free-text corpus is **7 rows averaging 28 characters**, and zero stored
documents. Beyond size, the operational data is *structured*, and the industry split is clear — text-to-SQL
over a semantic layer for structured data, retrieval for unstructured text — because a query computes an
exact answer over every row while retrieval returns what looked similar. That is the architecture
CLAUDE.md already mandates and this system already implements. RAG becomes right when FreshNow supplies
DOCUMENTS (HACCP plans, SOPs, equipment manuals) — the trigger is the corpus arriving, not a date. The
design for that build (pgvector in the existing Postgres, hybrid retrieval, reranking, structure-aware
chunking, ACL filtering at retrieval, citations finally implementing the grounding gate, and a scored
eval set) is recorded in `docs/reports/future-plan.html` §2 so it is designed rather than improvised.

## D106 — Replay re-derives from RECORDED inputs and distinguishes "not found" from "clean" [verified]
`blocker.routed` audit detail now carries `input: {category, severity, site, shift}`; `replayRun`
re-derives from that and never reads the live blocker row. Before: it re-read live state, and because
`scripts/reset-employee.ts` hard-deletes blockers, 45 of 50 routed blockers no longer existed and
every one reported `diverged: true` — while a correlation id that never existed returned
`{steps:0, checks:[], diverged:false}`, i.e. "replayed fine". Now `found` is explicit, a run recorded
before inputs were kept is counted `unreplayable` (unknown ≠ wrong), and only a check that actually
ran can diverge. Six tests, including the three silently-wrong behaviours.

## D107 — `run_trace` is written by the real code paths and is append-only [verified]
`core/trace.ts` `recordTrace()` — best-effort, failures counted on `/health`, never able to break the
step it observes. `parse_update` and `route_blocker` write it; before 2026-09-18 only `seed.ts` did and
the table held two rows. Append-only like the audit log: one run may perform the same step for several
entities, so a retry appears twice because it happened twice. (My first version added a uniqueness
constraint on (correlation_id, step); the seed test caught it — G94.)

## D108 — A routing failure alerts a human and is swept, never lost [verified]
`attachNoteAndProcess` catches `routeAndAlert`, audits `blocker.routing_failed`, and sends the
employee's own words to a human through the needs-review path. Beneath that, `sweepUnroutedBlockers`
runs beside the SLA sweep: any open blocker with no resolver and no SLA — which `slaSweep` cannot see,
because it filters on `sla_due_at is not null` — is retried and audited either way (`blocker.rerouted`
/ `blocker.still_unroutable`). The realistic trigger is the company replacing the catch-all routing
rule with real ones, which makes "no rule matched" MORE likely, not less.

## D109 — Consent gaps are recorded, not enforced, and the trade-off is stated [verified]
`recordTaskUpdate` audits `consent.missing` (once per person per day) when the reporter has no
consent record and is not synthetic. It does NOT refuse the update: losing an employee's report of a
broken chiller to a paperwork gap is the wrong trade. 6 of 7 active employees had no record because
they were created by script; the gap is now visible where it will be acted on.

## D110 — Routing matches (category, site, shift), most specific first [verified]
`resolveForCategory` takes a key, not a string. A rule naming all three beats one naming two, and so
on down to the catch-all; NULL in a rule column means "any"; site and shift compare case-insensitive
and trimmed like department. Before, `site is null and shift is null` was hardcoded and every
site/shift rule the company entered would have been invisible — with the catch-all replaced, nothing
would have matched at all. Replay re-derives with the same key from the recorded input.

## D111 — The audit-log actor is tied to the session by a trigger [verified]
On the app connection, `actor` must be `employee:<app_current_employee()>` or `system`; the service
role (where the API's verified identity is applied) may write any actor. `with check (true)` had made
the log append-only against tampering but not against fabrication — a forged "the CEO approved this"
row would have stood forever, and `rate-limit.ts` counts abuse from actor. Probed as the real app
role: forgery refused, own actor and system accepted. Defence in depth; not reachable over HTTP.

## D112 — Both gates run on both model-written outputs [verified]
The EOD narrative now passes `numericSanityGate` against the counts, detail and date it was written
from; a failure withholds the prose, keeps the computed counts, and audits the numbers that had no
source. The question box additionally passes a `groundingGate`: a claim about a policy, rule or
food-safety requirement is grounded only if the SQL read a policy-bearing table (`sla_policy`, the
ladder, `routing_rule`, `task_status`) and got rows. No document store exists, so a HACCP claim can
never be grounded today — the correct verdict. A withheld sentence is the failure direction, never a
stated falsehood. The dashboard shows both verdicts.

## D113 — Webhook mode: a one-route listener that verifies the secret before grammY does [verified]
`bot/webhook.ts` opens a `node:http` server on a local port (Caddy terminates TLS), answers one path
and one method, compares `X-Telegram-Bot-Api-Secret-Token` in constant time BEFORE handing the body to
grammY, audits rejections without the token, and calls `setWebhook` on startup. Fails closed: no
secret of ≥16 chars, no HTTPS `PUBLIC_URL` → the bot refuses to start. Not mounted in the Fastify API
on purpose — the bot instance lives in the bot package, and coupling them means the API restarts when
the bot does. Tested against a real socket. Never yet called by Telegram: there is no domain.

## D114 — Retention ages words, never counts; erasure anonymises, never deletes [verified]
`retentionSweep` redacts `task_update.note_raw` and the parsed copy past `RETENTION_DAYS`, leaving
statuses, counts, blockers and audit rows. It is DISABLED until that variable is set (and refuses under
30 days) because the window is the data controller's decision, not a developer default; the worker
says hourly that it is disabled. `eraseEmployee` replaces name, Telegram id, login and every note, sets
status disabled, and keeps every row — deleting was what broke replay (TASK-036). Audits carry counts,
never content. Nothing calls erasure yet; the reset script remains the demo tool.

## D115 — Erasure is a CEO-only route with three refusals and a two-step UI [verified]
`POST /dashboard/people/:id/erase` with a human-chosen reason (`left`, `consent_withdrawn`, `request`).
Refuses a non-CEO (403), the CEO erasing themselves (403), any CEO row (409 — hand the role over
first, so `ceoEmployeeId()` always finds someone), an unknown id (404), any other reason (400).
Under `/dashboard/*` so both auth hooks cover it. The People tab shows "Has left…" only to the CEO and
only on rows that are neither the CEO's nor already disabled; the first click opens the reason and
the red button, never the action. Proven by the suite on a synthetic person and by the live API for
every refusal. The reset script's hard delete remains the DEMO tool; this is the production one.

## D116 — "The CEO" is a lookup, not the seeded constant [verified]
`ceoEmployeeId()` (core/org.ts): active `access_role = 'ceo'`, seeded row preferred when it is one,
seeded id only as the fallback for an empty database. Moved onto it: `alertNeedsReview` (who is told
about a blocker no rule could place — now with the correlation id), `completeOnboarding` (who a new
employee reports to), and the invite route records the real signed-in issuer instead of the demo CEO.
`IS_DEMO` now reads the environment. Still anchored to the seeded row on purpose: the bot's CEO
identity (`TELEGRAM_CEO_USER_ID` + `ensureCeoLinked`), the invite fallback when the bot CEO has no
employee row, and the seed itself. See A-T38.1.

## D117 — The bot's role is a menu; the permission is the rule, asked every time [verified]
`Role` is now `ceo | manager | employee` and decides only what buttons appear. Whether THIS person may
act on THAT person is `canAssignTo(viewer, target)` — the dashboard's rule — asked at the directory
(`listAssignable`, its SQL twin), at the `assignto:` tap, and again at the final write, because callback
data is an employee id anyone can type into a modified client. `/blockers` for a manager runs the query
under row-level security as that person (`listOpenBlockersFor`), so the bot and the dashboard show the
same list by construction. `manager` and `lead` share the menu; the lead's department reach is the
rule's business, not the menu's. Same principle applied to the document planner, which had gated the
button and not the function.

## D118 — Bot handlers are tested through grammY's real `handleUpdate` [verified]
`bot/roles.test.ts` builds the real bot (`createBot`), sets `bot.botInfo`, installs a transformer via
`bot.api.config.use` that records every outgoing call and returns a fake `ApiResponse`, and feeds
hand-built `Update` objects — commands with their `bot_command` entity, callback queries with `data`.
The whole middleware chain runs: sequentialize, the auth query, the Postgres session, the handler, the
core write. This is grammY's documented approach and it is the first time a command or callback
handler in this repo has a test; `flows.test.ts` reaches only the exported text router with a stub.

## D119 — Residency is a hosting and provider decision, not a model-ownership one [verified]
The law (Federal Decree-Law 45/2021, Art. 22–23, read in the LexisNexis translation) regulates
transfer abroad; it does not require in-country storage except in sector laws (health, banking,
government) that do not cover FreshNow's ops data. What moves employee data abroad today is
Telegram (unavoidable with any consumer messenger), the three US AI providers, Langfuse metadata,
and the production plan itself — Hostinger has no UAE or Middle East location. The recommendation
is therefore: host in a UAE region; route model calls to a UAE-hosted provider (Core42 offers the
same `gpt-oss-120b`; OpenAI's `ae.api.openai.com` processes in-region for selected models by
approval; Azure UAE North Standard runs Whisper in-region); drop the foreign fallbacks and degrade
to rules-only instead; pseudonymise prompts. NOT self-hosting: the 120B model's weights are 61 GB
(the VPS has 32 GB and no GPU), the 20B would contend with Postgres, and fine-tuning is the wrong
tool for extraction/SQL tasks with a handful of real rows. Full reasoning and sources in the report.

## D120 — The consent notice must describe the system as it is [verified]
The notice shown at onboarding says updates are "visible to you and the CEO" and nothing about
managers, AI processing abroad, voice transcription, retention or erasure. Since the org model and
the AI pipeline, that is not what happens. Art. 6 consent must be specific and Art. 5(1) processing
transparent, so the consent held today does not cover today's transfers. Decision: a notice v2
(draft in the report §5) with a new `CONSENT_POLICY_VERSION`, re-consent for everyone, native-speaker
review of Hindi/Malayalam — after the hosting and provider decisions, so the notice can say where
the AI runs. Not deployed by me: the wording is the company's and its lawyer's.

## D121 — Model calls move to a UAE-hosted provider; the US fallbacks are removed, not reordered [verified]
Groq, OpenRouter and NVIDIA are self-serve APIs with no data-processing agreement, processing outside the UAE.
PDPL Art. 7(5) and 8(1) require an appointed processor under a contract; Art. 22's adequacy route does not exist
while the Executive Regulations are unissued. So: Core42 Compass (same `openai/gpt-oss-120b`, UAE jurisdiction,
$0.15–0.25/M in) as the provider, OpenAI's `ae.api.openai.com` (approval required) as the optional second, Azure
UAE North Whisper for voice. Critically, `LLM_PROVIDER_ORDER` must list ONLY in-country providers: a residency
posture cannot have a fallback that leaves the country, and the wrapper already degrades to rules-only +
`needs_review` when every provider is unavailable, which is the correct failure direction. Keys for the US
providers stay for development against DEMO data.

## D122 — Telegram may be used, on the consent ground, once the notice names it [verified reading]
TDRA regulates VoIP, not text (the bot never calls). PDPL permits transfer abroad on the data subject's express
consent (Art. 23(1)(b)); Telegram stores cloud chats worldwide and offers no business contract, so consent is the
only available ground — and today's notice does not mention Telegram, so the ground is not yet established. Open
question for counsel: whether a regulator would treat Telegram as an appointed processor (needing a contract it
does not offer) or as an independent service like an email provider. My reading is the latter; it is recorded as a
reading. Mitigation either way is the in-app/web-push channel, which is ours and in-country.

## D123 — The dashboard is a shell, and its chart colours are computed, not chosen [verified]
Persistent sidebar (nav with icons + counts, portal switch, signed-in person), header with search, status cards
that carry a definition under the number, a last-seven-days stacked chart, and a "Needs a human" list that names
the items the two red numbers were counting. Two rules held while building it: (1) the engine computes — the chart
reads `GET /dashboard/week`, seven days of counts done in SQL under the viewer's RLS, so it can never show a number
this person may not see, and the browser adds nothing up; (2) the marks were validated with the data-viz
validator in both themes rather than picked by eye — `#2ea043/#388bfd/#da3633` dark, `#116329/#0550ae/#a40e26`
light, all six checks passing. States wear status colours; identity is never colour-alone (legend + direct label +
table toggle + tooltip on keyboard focus).

## D124 — Brand colours are fills; readable steps of the same hues are the text [verified]
FreshNow's three colours (#97d700 CTA green, #9bca3c hero green, #f39c12 orange, sampled from their website)
measure 1.7–2.2:1 against white text and 8.6–10.9:1 against near-black. So: they fill the hero, the logo mark, the
portal tiles and the primary action button, always with `--color-on-brand` (#0d1117) on them — in BOTH themes,
because a fill is the same colour on a light page and a dark one. Where a colour must be read, the same hues are
stepped until they pass: light ok #3d6b10 (6.35:1 on white), light warn #9d5404 (5.67:1), dark ok #8bc53f (8.37:1
on a card), dark warn is the exact brand orange #f39c12 (7.89:1 — a dark surface needs no stepping). Every value
was measured against every surface it lands on before shipping. Swapping in a different brand is: replace three
hexes, re-run the contrast pass.

## D125 — The brand carries the chrome; the chart carries the meaning [verified]
The chart does NOT use the brand's green-and-orange pairing (see G106) and does not follow the brand at all beyond
its green. This is now a written boundary in `index.css`: decoration follows the company's identity, encoding
follows what a person can distinguish. The same rule is why status colours were not repainted to match the brand
beyond their own hues, and why `crit` stays red.

## D126 — A channel is switched on in three places, by three different people [verified]
Available (keys in `.env`, read by `channelAvailability()`), enabled (`channel_setting`, the CEO's toggle
in the dashboard, audited as `channel.toggled`), preferred (`notification_pref`, each person's own). All
three, or nothing is sent. They are separate because the error message differs: "not configured on this
server" and "the company has not switched it on" have different fixes, and the Channels card names which.
Everything ships off except telegram and inapp. `availableChannels()` — which used to read only the
environment — is now `liveChannels()` in `core/channels.ts`, the single place the question is answered.

## D127 — The gate lives in `enqueueNotification`, not in the callers [verified]
Four sites queued a channel directly and consulted nothing: needs-review alerts, attachment forwarding and
two project-alert paths. Once the CEO could switch Telegram off they would have kept posting to it. The
check went into the one function every outbound message passes through: a message on a channel that is not
live is dropped and audited as `notification.channel_disabled`, with the channel and recipient but never
the body. One place instead of four that can drift apart.

## D128 — Inbound email is a write path from outside, and is gated like one [verified]
`POST /inbound/email` sits outside `/dashboard/*` deliberately (a mail edge is a machine and cannot hold a
JWT), so it carries its own guards: a constant-time shared secret; SPF+DKIM+DMARC must ALL pass, with a
missing verdict treated as a failure; the sender must be an active employee whose role may give work; auto
-replies and bulk mail dropped; and the output is a PROPOSAL the CEO confirms, never a silent write. With
no secret configured the route 404s — an unconfigured write path that works is worse than none. Refusals
are audited with the reason and never the body. Reply-to-update was NOT built: the email guide's own
conclusion is that multilingual quote-stripping has no clean solution.


## D129 — "How people hear from us" is three presets over the existing switches (TASK-044, 2026-09-26) [verified]
Telegram (default: telegram on, webpush off) · Telegram + App (both on) · App only (telegram off, webpush on),
set by `setDeliveryMode()` in `core/channels.ts`, CEO-only (`PUT /dashboard/channels/mode`), audited once as
`channel.mode_set` plus the usual `channel.toggled` per switch that moved. A preset writes `channel_setting`
and nothing else, so the outbox gate, `liveChannels()` and the per-channel toggles are unchanged. Two rules:
**App only is refused (409) while web push is not configured** — turning Telegram off with only the inbox left
would reach nobody who is not looking at the dashboard; and web push is switched on **before** Telegram is
switched off, so there is no instant with both dark. Re-selecting the current mode writes nothing.
Rejected: a new "primary channel" column — a second source of truth for what the switches already say.

## D130 — A subscribed device is the opt-in for web push (TASK-044) [verified]
TASK-043 required a per-event `notification_pref` row before web push sent anything, and the preferences card
only ever offered Telegram — so web push could be switched on, enabled on a phone, and never fire. Now: no rule
→ web push goes to anyone with ≥1 `push_subscription`; a rule decides (`off` silences one event). The
subscription only exists after an explicit tap AND the browser's own permission prompt, which is a clearer
yes than a row. Email stays opt-in per event, because an address can be stored by someone else.

## D131 — One-off messages fan out through `notifyPeople()` (TASK-044) [verified]
The needs-review alert (CEO) and project news were queued on Telegram (and sometimes the inbox) directly, so
with Telegram off the outbox gate dropped them: an unreadable breakdown report reached nobody. `notifyPeople`
applies the no-rule defaults of `resolveAlertRecipients` (inbox always, Telegram if linked, web push if a
device) and takes a `keyFor(employee, channel)` so existing idempotency keys are kept — the needs-review
Telegram key stays `needs-review-<id>`, project keys stay `<key>:<person>:<channel>`. Email is excluded: it is
opt-in per event and these have no event to opt into.

## D132 — Phone banners are derived from the event, never from the text (TASK-044) [verified]
`presentationOf(event)` gives title, `url` (always under `/app/`; `?task=<id>` opens that task's panel), a
collapse `tag`, and `urgent` (blocker raised/escalated only). Urgent → the sender asks the push service for
`Urgency: high` (RFC 8030) and the service worker sets `requireInteraction`; a repeated tag sets `renotify` so
an escalation buzzes again instead of silently replacing the banner. Deterministic, no model.

## D133 — Consent for app-only people is a separate, hashed notice (TASK-044) [verified in code; wording assumed]
People who never use Telegram never saw the bot's /start notice. The app shows `appConsentNotice()` on first
real sign-in (not in demo mode), stores `consent_record` with version `app-draft-1.0` and the SHA-256 of the
exact words, and refuses consent sent against a different hash (409) — the hash is only worth anything if it
proves what was on screen. Withdraw is in the Alerts tab and has the bot's effect (status → disabled). The CEO
cannot withdraw in-app: it would lock the company out; handing over the role comes first. The gate is in the
UI only; the API does not yet refuse an unconsented viewer (see TASK-044 "not verified").
**Superseded 2026-09-28 by D139–D141:** there is now ONE notice (2.0) for the bot and the app, the API refuses an
unconsented viewer (`403 consent_required`), and `appConsentNotice` / `app-draft-1.0` are gone.

## D134 — What git must never hold, and what it no longer does (TASK-044) [verified]
`.gitignore` now ignores every `.env*` except `.env.example` (previously `.env.production`/`.env.staging`
would have been committed), keys/certs, service-account JSON, VAPID key files, DB dumps and backups, Redis
snapshots (`*.rdb`, `*.aof`), Caddy ACME data, logs, test output, caches and Supabase CLI state. Untracked
(still on disk): `supabase/.branches`, `supabase/.temp`, and `freshnow/opt-COO*.pdf` — Print-to-PDF copies
(~14.8 MB) of the markdown research beside them. No secret was found in the tracked tree or its one commit.

## D135 — Hosting recommendation: Azure UAE North + Core42; AWS UAE "not now" (2026-09-26) [believed]
From `docs/reports/ceo-deck-azure-aws-uae.html`: one Azure VM in UAE North (Dubai) running today's Compose
stack, nightly encrypted `pg_dump` to geo-redundant storage (auto-copied to the paired UAE Central, Abu Dhabi),
AI on Core42 (same `gpt-oss-120b`), ≈ $202/month estimated. AWS me-central-1 is priced from AWS's own list but
not recommended while it is impaired (VF33). Azure's in-country AI is reserved capacity (≥ $6,500/month) —
~900× our AI bill. GitHub Copilot Business for development only, with no real employee data in prompts.
Confirm/refute: Azure calculator for UAE North; AWS declaring the region recovered; counsel on the backup copy.


## D136 — A local Supabase is signed in to through the API's own origin (TASK-045, 2026-09-28) [verified]
`routes/auth-proxy.ts` passes exactly three calls to the local Supabase Auth — `POST /auth/v1/token`
(grant `password` | `refresh_token`), `POST /auth/v1/logout`, `GET /auth/v1/user` — and 404s everything else
without contacting Supabase (sign-up, admin API, recovery, OTP, other grants). `/app-config` returns
`supabaseSameOrigin: true` for a 127.0.0.1/localhost Supabase and the dashboard then uses `location.origin`.
Why: web push needs an HTTPS page and an HTTPS page cannot call `http://<laptop>:54321` (mixed content), so a
phone could sign in or be notified, never both. One HTTPS tunnel to :3001 now serves both, and :54321 no
longer has to be opened. Off for a hosted Supabase (already HTTPS on its own domain). The body is passed as
bytes in an encapsulated scope because supabase-js sends an empty body with `Content-Type: application/json`
on sign-out, which Fastify's JSON parser rejects. Issuer and JWT verification are unchanged.

## D137 — Nothing about a signed-in person is fetched or shown before consent is known (TASK-045) [verified]
The first version rendered the board while the consent check was in flight and swapped the notice in after,
so a person briefly saw — and the browser fetched — their data before agreeing. Now `App` shows a spinner
while consent is unknown and `load()` returns early unless consent is `true`.

## D138 — CI is manual-only for now (TASK-045, owner's request) [verified]
`on: workflow_dispatch` only; the push/pull_request triggers are kept in a comment. It had never passed: the
workflow and `package.json#packageManager` both named a pnpm version and `pnpm/action-setup@v4` refuses that
("Multiple versions of pnpm specified"). The duplicate is removed so a manual run gets past setup.

## D139 — One consent notice for both doors, generated from the configuration (TASK-046) [verified]
`packages/core/src/consent.ts`, version `2.0-draft`. The bot and the dashboard show the same words. The section
"Where your data goes beyond FreshNow's database" is built from the same environment the senders and the model
client read: Telegram when `BOT_TOKEN` is set, each AI provider with a key (fixed order, so `LLM_PROVIDER_ORDER`
does not change the text), the push relays when VAPID is set, email/chat/Langfuse-with-content when configured,
and the retention period. Consent is "current" only for this version AND one of these hashes — so a provider
added or removed, or `RETENTION_DAYS` set, makes everyone's consent out of date and they are asked again.
Rejected: a hand-maintained list of processors — it can drift from what the code actually calls, and a notice
that under-names a recipient is exactly the defect this replaces (deck slide 10).

## D140 — Until a person agrees to the current notice, nothing is taken from them and nothing is sent to them abroad (TASK-046) [verified]
Three places, each a control rather than a screen: the bot answers every update from a linked person without
current consent with the notice and an "I agree" button and processes nothing (only /withdraw, /help, /whoami,
/cancel and the consent buttons pass); the API's sign-in hook returns `403 consent_required` for every
`/dashboard/*` and `/employees/*` route except `/dashboard/me`, the consent routes and the live stream (table
names only); the outbox relay does not claim Telegram/web push/email/chat rows for them — they stay `pending`
with no attempt spent and go out on the first poll after they agree. Never held: the in-app inbox (our own
database), the consent request itself, rows with no recipient. The bot tells the person their message was not
recorded rather than dropping it silently. Synthetic (demo) people are NOT exempt: the seeded DEMO CEO row is
used by the real CEO's Telegram account.

## D141 — Everyone is asked without having to message first, once per version of the words (TASK-046) [verified]
`requestConsentFromEveryone()` runs in the worker every minute (with the SLA sweep). It enqueues, for each
active person with a Telegram link or a dashboard account and no current consent: Telegram (the notice +
buttons `consent:renew:<first 16 hex of the hash>` / `consent:later`), the inbox, and web push if they have a
device — only on channels that are live, because a row on a switched-off channel is dropped and audited, which
once a minute per person would bury the audit log. Keys `consent.requested:<tag>:<person>:<channel>` make it
idempotent per version of the words. A tap
under an older tag records nothing and shows the new words.

## D142 — The PDPL verdict the decks now state (TASK-046) [believed — a technical reading for counsel]
FreshNow must comply with the PDPL in full; no localisation rule forces employee task data to stay in the UAE;
data may leave only on express consent or a PDPL-grade contract (Art. 22–23); UAE hosting and Core42 are the
simplest way to comply, recommended rather than legally required; the deadline that matters is the first real
employee's data, not a fine today (Regulations pending, Art. 26 fines decision not found, Art. 29 six months).
The deck slide titled "…true for some sectors — not ours" read as "the law does not apply to us"; it is retitled
and both decks carry the verdict as slide 2.

## D143 — The inbox panel is placed from the bell's position and clamped to the window (TASK-047) [verified]
It was `absolute right-0` on the bell: right only while the bell sits at the right of the screen. In a zoomed
or narrow window the header wrapped, the bell landed on the left, and the 420 px panel opened off-screen
(the CEO's Chrome, 28 Sep). Now the header's controls are one `ml-auto` group (they wrap to the right), and
the panel is rendered into `<body>` with `position: fixed`, right-aligned under the bell and clamped 8 px
inside both window edges, height capped to the space below. Into `<body>` because the sticky header's
`backdrop-filter` makes the header, not the window, the containing block of a fixed child.

## D144 — An answered consent request is marked read (TASK-047) [verified]
`recordConsent` marks the person's `consent.requested` inbox rows read, and the worker's sweep settles any
left unread by people who agreed earlier. Only those rows are touched. Before this, Hemanth — already agreed —
still had "until you do, your updates can't be taken" at the top of his inbox.

## D145 — The service worker is registered on load, handles page loads pass-through, and the app offers its own Install button (TASK-048) [verified in Chromium; phone unverified]
Registered in `main.tsx` before React renders (it was registered only on "Turn on notifications"). `sw.js` gains a
`fetch` handler for navigations only, network-only (`respondWith(fetch(request))`) — no cache, so D-level rule
"a board is a count from the database" stands; data calls, SSE and sign-in never reach `respondWith`. Reason:
Chrome's guidance is that Android treats a site as an installable app (WebAPK) rather than a shortcut only with
a service worker that handles fetch [believed — developer.chrome.com, via search]. `lib/install.ts` keeps the
browser's `beforeinstallprompt` and the dashboard shows **Install FreshNow** in Alerts → This device, plus a
header button on small screens; iPhone and browsers without the event get instructions for their menu. The live
status reads "refreshing every 20 s" instead of "polling", which looked like a fault through the quick tunnel.

