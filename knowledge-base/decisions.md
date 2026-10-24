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
**Corrected 2026-09-29 (VF39):** Groq now offers every account a Zero Data Retention switch and publishes a DPA; OpenRouter does
not log prompts by default and can force zero-retention routing. Both still process outside the UAE, so the conclusion
(Core42 for real employee text) stands; the "no DPA" part is out of date for Groq [believed].
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
header button on small screens; **(2026-09-30, TASK-049: the phone button moved from the header to the top of Home, and to More → This device — D148.)** iPhone and browsers without the event get instructions for their menu. The live
status reads "refreshing every 20 s" instead of "polling", which looked like a fault through the quick tunnel.


## D146 — Self-reported progress may be a range; the range is stored and shown, its midpoint is used for sums (TASK-049) [verified — tests]
Employees pick 0–10%, 10–20% … 90–100% from a list. Migration 0018 stores the range (`task.progress_band_low/high`,
`progress_event.band_low/high`); `progress_pct` holds the midpoint (0–10 → 5, 90–100 → 95) because project rollups and
the behind flag are arithmetic over one number. Every screen shows the range ("20–30%"), the task page adds "counted as
25% in totals". The midpoint is a judgement — unbiased when nothing says where in the range the work sits — not a
standard. The list is enforced three times (API Zod, core `isAllowedBand`, CHECK constraints) and a test fails if the
dashboard's copy drifts from core's `PROGRESS_BANDS`. No 100% range: finishing is ✅ Done. Recomputing from steps or
status clears the range (D77 extended). "I know the exact number…" keeps the old exact input.

## D147 — Starter phrases fill a text box; they never replace the person's words (TASK-049) [verified in Chromium]
Progress notes and problems get tappable starters ("Materials ready", "Machine not working" …) that fill or append to an
ordinary editable box. The words are still what the CEO reads and what the blocker parser classifies, so the starters
are plain phrases, not category codes. Priority, due date (Today / Tomorrow / Friday · end of week / Next Monday — UAE
week) and close reason became chips. English only for now (A-T49.1).

## D148 — The phone gets its own layout, and only one layout is ever mounted (TASK-049) [verified in Chromium at 390 px; real phone unverified]
Below 1024 px: a title bar, one page at a time, and a bottom tab bar — Home · My work · Assign (Projects for people who
cannot give work) · Alerts · More. More holds every other page, search, theme, install, refresh, sign out. Counts only on
Home. `useMedia` chooses the layout on first paint; CSS-hiding one copy would have mounted two inbox bells fetching the
same notifications. The install button (D145) moved from the header to the top of Home and More → This device.

## D149 — Below 640 px a table is a list of cards (TASK-049) [verified in Chromium]
`DataTable` renders each row as a card: the first column as the heading, the rest as labelled lines, headless columns
(action buttons) at the bottom. One change fixed every list on every page; nothing scrolls sideways at 390 px.

## D150 — Each page is a history entry; an open task is one too; the URL is the truth on Back (TASK-049) [verified in Chromium]
The hash was only ever replaced, so a phone's back gesture left the app. Page changes now push (the first sync
replaces, so a shared link adds no entry); opening a task pushes `{task: true}`; closing it from the page calls
`history.back()`; `popstate` closes any task and re-reads the hash. Back = close the task, then the previous page.

## D151 — Policy as code: a JSON registry, rules checked at every start, enforced only in production (TASK-050) [verified — tests + real start-up]
`compliance/processors.json` lists every outside service, its country, legal ground, DPA and controls. `core/compliance.ts`
checks R0–R6 against the environment at the start of the api, worker and bot: in the demo it prints one line and never
blocks; with IS_DEMO=false it prints every finding and exits (observed: the api exited before opening its port). JSON, not
YAML: the project has no YAML parser and CLAUDE.md asks for no new dependency without a reason. "Reachable" uses the same
tests as the senders and the AI client, so the registry cannot disagree with what is actually used. A person's
confirmation (ZDR on, DPA filed) is recorded with a date; code cannot see another company's console.

## D152 — Identifiers leave no prompt; names stay (TASK-050) [verified — tests]
The AI wrapper removes phone numbers (UAE and international), emails, Emirates IDs, IBANs (mod-97) and card numbers (Luhn)
from user messages once per call, before any provider or trace; the count goes to `llm_call.redacted` (migration 0019).
Names are kept on purpose — the document planner routes work by name. Bare 10-digit Indian mobiles are kept: they look like
the order and batch numbers this business writes. Voice goes to Groq as audio; its transcript is redacted when parsed.

## D153 — Evidence and the right to a copy (TASK-050) [verified — tests + browser]
The CEO's Compliance page and `pnpm compliance` show the findings, the registry (record of processing) and SQL counts; the
worker writes one `compliance.snapshot` a Dubai day to the append-only audit log (counts only). Everyone can download their
own data as JSON (Alerts → Your consent), consent-free; the CEO can export anyone's (People). Push keys are excluded.

## D154 — Every attachment is virus-scanned by ClamAV, spoken to directly (TASK-051) [verified — tests + real clamd]
`core/antivirus.ts` speaks clamd's INSTREAM protocol over TCP (z-framed command, 4-byte length chunks, zero terminator) — no
npm package, the file never touches disk. It runs inside `inspectFile` after the cheap checks and before any parser, for the
dashboard, Telegram and the arrival gate. Unset `CLAMAV_HOST` = not scanned (demo default); set and down = the file is
REFUSED (fail closed — a scanner you can bypass by stopping it is not a scanner). Production requires it (R6). Antivirus is
one layer, not the defence (OWASP): the structural checks, the sandbox and "never forward a flagged file" stay.

## D155 — PDFs are parsed in a separate process with a memory and time ceiling (TASK-051) [verified — tests]
`core/pdf-sandbox.ts`: `node --max-old-space-size=256` child, 20 s kill, 8 MB output cap, and an EMPTY environment (no keys,
no database URL). `isEvalSupported: false` (CVE-2024-4367 workaround). Not worker_threads: their `resourceLimits` were not
enforced here (G128). Not an OS jail — same user; a separate container is the production step (not built).

## D156 — Documents are checked when they ARRIVE, and a not-forwardable file is never stored as an attachment (TASK-051) [verified — tests]
Attachments travel by Telegram file_id, so a document sent "for Rashid" used to reach Rashid unchecked. `gateIncomingDocument`
fetches it once (download injected; bounded by the document rate limit and semaphore) and runs the full gate: refused files
are never held; active-content PDFs are held for reading with `mayForward: false`; `saveAttachments` drops those for every
path (reports, assignments, document plans) and audits `attachment.withheld`. Over 15 MB or not downloadable → refused.
Photos are not fetched (Telegram re-encodes them — A-T51.2).

## D157 — Browser rules are hand-written, not a library (TASK-051) [verified — tests + Chromium]
`api/src/security-headers.ts` (OWASP headers cheat sheet): nosniff, no-referrer, DENY framing, Permissions-Policy, COOP/CORP on
everything; the React app gets a strict CSP — scripts only from 'self' plus the SHA-256 of the one inline theme script, no
'unsafe-inline'/'unsafe-eval', connect-src 'self' (+ the Supabase origin only when not proxied); JSON gets
`default-src 'none'; frame-ancestors 'none'` and `no-store`. HSTS only when the request came over HTTPS through a proxy.
No `upgrade-insecure-requests` (breaks the Wi-Fi demo) and no COEP. Legacy page `/` (auth off only) keeps inline handlers
but cannot connect elsewhere.

## D158 — Sign-in guessing is braked per device (TASK-051) [verified — tests]
The auth proxy counts FAILED password sign-ins per client: CF-Connecting-IP, trusted only when the request came from this
machine (cloudflared); otherwise the socket address. 10 in 15 min → 429 without reaching Supabase; a success clears the
count. In memory (a restart forgets — accepted for a guessing brake; stores no addresses), audit keeps a hash only. The
real address is passed to GoTrue so its own limit is per phone, not per tunnel.

## D159 — Backups for ransomware: dump, checksum, encrypt to a public key, restore-test, one copy offline (TASK-051) [verified locally]
`scripts/backup.ts`: pg_dump custom format (inside the Supabase container when it runs — same version, nothing to install on
Windows), SHA-256 in sha256sum format, TOC check, manifest with row counts, keep N; `age` encryption to a PUBLIC key so the
server can encrypt but never decrypt; restore test into a scratch database with the audit log checked against the manifest.
All audited (`security.backup`, `security.restore_test`) and shown on Compliance → Security. The offline copy is a person's
step — nothing on a server can make a copy that server cannot delete.

## D160 — Supply chain: pinned scanners on an isolated clone; release-age quarantine respected (TASK-051) [verified — pnpm audit clean]
`pnpm security:scan`: tracked secret files, `pnpm audit` (high+), ClamAV EICAR self-test from memory; with Docker, gitleaks
(git history, `--network none`), OSV-Scanner and Trivy — images pinned (Trivy 0.69.3 per GHSA-69fq-xp46-6x23 after the March
2026 compromise), run on a fresh `git clone` in a temp folder mounted read-only, never the working folder with `.env`.
Fixes: nodemailer 7 → 10.0.12 (10.0.13 was inside pnpm's 1-day quarantine — no exclusion added), overrides for fast-uri and
brace-expansion, vitest 2 → 4 (critical UI-server advisory; dev only).

## D161 — WHO is decided by the name as written, in code; the model's pick is never enough on its own (TASK-052) [verified — tests]
`core/people-match.ts`: the written name must fit exactly ONE person, by whole words (a 3+ letter start counts: "Rash" →
Rashid; "Ali" is never Khalid). One match → that person, even over the model's pick. Several → ambiguous, the sender chooses
from just those. None but the model picked someone (nickname, another script, no name written) → a suggestion. Chat
assignment acts only on confirmed names and asks otherwise (buttons: the candidates + "someone else"); the document planner
keeps a guess as owner but flags it ("my guess — check") because the CEO confirms the whole plan; the typed-name prompt uses
the same matcher. The model now returns `named_as` for every item. Grounding is pure and exported (`groundResolution`,
`groundDocumentTasks`) so routing is tested and replayed without a model.

## D162 — Identifier placeholders are numbered per call and restored in the answer (TASK-052) [verified — tests]
"[phone-1]", "[phone-2]" (same value → same placeholder) instead of a bare "[phone]", so two numbers stay two and each stays
with its job; `llmComplete` validates the model's JSON and then restores real values on OUR side, so the assignee gets the
real number the provider never saw. Unknown placeholders are left as they are. The SQL guard validates the restored SQL.

## D163 — Retention and erasure reach the replay trace (TASK-052) [verified — tests]
`run_trace` kept each parse's `noteRaw` and extraction for ever. The sweep now ages parse traces older than the window (by the
trace's own age, so older rows are caught), and erasure clears that person's traces. An aged trace can no longer be replayed:
the retention window outranks replayability.

## D164 — Email both ways on the CEO's Gmail, no domain: SMTP out, IMAP in, App Password (TASK-053) [verified locally — not against Gmail]
The only receive path without a domain is reading a mailbox. The CEO's Gmail sends (smtp.gmail.com:465) and its
`+freshnow` alias is the inbox (imap.gmail.com:993), with an App Password, which needs 2-Step Verification. `EMAIL_ALLOWLIST`
limits both directions. The worker searches only mail TO the alias, opens the mailbox read-only and fetches with PEEK, so
nothing is marked read, moved or deleted. This is for the demo only. Production needs a company domain and a dedicated
mailbox with its DPA filed, and policy R2 already blocks a production start without that.

## D165 — A reply finds its task by key, then by thread; the sender must be authenticated and be the owner (TASK-053) [verified — tests + local round trip]
The Jira order: the key `FN-<task_number>` in the subject first, then In-Reply-To/References against the Message-IDs we
recorded when sending (`fn.<outboxId>@domain`, stable across retries). Proof of sender: Gmail's `\Sent` label (only the
account owner sends), or the FIRST `Authentication-Results` from `EMAIL_TRUSTED_AUTHSERV` (default mx.google.com) with SPF,
DKIM and DMARC all = pass. A later header could be forged by the sender, so only the first trusted one counts. No per-task
HMAC address (Discourse's pattern): the HMAC stops a guessed id being written to, and here a guessed key only lets the owner
update their own task. Screening order: to the inbox → not automatic → allow-listed → authenticated → active employee →
current consent → something above the quote.

## D166 — Email from a manager or the CEO becomes a proposal; an email never assigns by itself (TASK-053) [verified — tests + browser] — SUPERSEDED IN PART by D173 (2026-10-07)
`email_proposal` holds the tasks the model read out of the email, with owners grounded by the TASK-052 name rule. A person
taps Assign & notify (proposer or CEO; `canAssignTo` checked for every owner; decided first, so a double tap gets 409). The
webhook path (`/inbound/email`) records its plan the same way. An employee writing about no task of theirs is filed as a
general update, never against someone else's task.

## D167 — BullMQ job schedulers for slow, outside-world jobs; the outbox and sweeps stay in the loop (TASK-053) [verified — Redis + Dovecot test]
BullMQ was already in the stack (SLA timers). The inbox poll (every `EMAIL_POLL_SECONDS`, 30–600) and the unread-email retry
(5 min) run as `upsertJobScheduler` jobs, concurrency 1, 3 attempts with exponential backoff, bounded history. Reason: an
IMAP server can take a minute or never answer, and in the worker's loop one slow poll would hold up every Telegram message.
Started without being awaited, so Redis down never stops delivery. Postgres stays the record (`email_message`, `job_run`).
Not moved to BullMQ: the outbox relay and sweeps (fast DB work, already exactly-once through the outbox), and a parse retry
for task updates (the needs-review path already hands those to a person).

## D168 — Jev (TypeSafe AI) not adopted (TASK-053) [believed — sources through search]
A typed-decision model, launched 15 Sep 2026. It would be a new processor for employees' words, its zero data retention is
enterprise-only (contract), it is English-first ("other languages handled but not equally well") while this workforce writes
Hindi and Malayalam, and the decisions it is built for (routing, classification) are ones CLAUDE.md keeps deterministic. Look
again if extraction quality becomes the bottleneck and ZDR is offered on a standard account.

## D169 — Project-management tools: patterns adopted, no replacement (TASK-053) [believed — sources through search]
Plane, OpenProject, Taiga, Vikunja and Huly are desk tools for planners; none has Telegram capture, deterministic blocker
routing or SLA escalation, and each is several more services on a shared box. Adopted their proven patterns instead:
human-readable task keys (`task.task_number`, shown as FN-n), reply-by-email updates (Jira), and a proposal confirmed by a
person before anything is assigned.

## D170 — Context is retrieved for the request, never the whole database (TASK-053) [verified — tests]
`CONTEXT_LIMITS` (25 colleagues, 30 open tasks, 8 recent updates, 10 open blockers, 20 000 document characters).
`relevantPeople` puts people named in the text first, then fills to the cap. `loadMessageContext(employeeId, text)`,
`planDocumentTasks` and the email planner pass only those people; `planningDirectory` reads only id, name and department
(bounded at 5 000). The question box prunes the schema per question with join closure (`schema-prune.ts`), and the
selection is recorded. End-of-day lists stay uncapped because their lengths are reported as counts, not read by a model.

## D171 — `email_message.outbox_id` has no foreign key (TASK-053) [verified — deadlock reproduced and fixed]
The sender inserts the 'out' row while the relay holds the outbox row `FOR UPDATE`; an FK check takes a share lock on that
row from another connection and waits on its own transaction. The link is kept as a plain uuid, documented in the semantic
layer, with a regression test through the real relay.

## D172 — Whoever gives work chooses how the assignee is told: Telegram · App · Email (TASK-054) [verified — tests + browser]
`assignTask({ channels })` tells the assignee on exactly the chosen channels, wherever each can physically reach them (a linked
chat, an address on file and allowed, the company switch on; "App" = the in-app inbox plus web push when a device is on). It
overrides the person's per-event rules for that one message only and changes no setting. A choice that cannot reach them is
reported in `skipped` with the reason; if NONE can, the call is refused before anything is written (409 `no_channel`), so no task
exists that its owner was never told about. `assignment.notify_channels` records the intent (NULL = nobody chose: their own
rules); the outbox rows remain the record of what was sent. The dashboard pre-selects the person's usual channels and sends a
choice only when it differs, so "did nothing" stays "their rules". Reachability comes from one function shared with sending
(`reachOf` / `usualChannels` in alerts.ts), so the form and the sender cannot disagree.

## D173 — Email assigns at once when every owner is certain; otherwise a proposal (TASK-054) [verified — tests + Dovecot]
Requested by the user on 2026-10-07: "send assignment by email directly … similarly as Telegram". The model still only reads the
jobs. WHO is decided in code, per job: (1) the written name fits exactly one person (D161), (2) the job names someone by email
address, or (3) the email went TO exactly one employee and the job names nobody else. Every owner must also pass `canAssignTo`
for the sender, and the assignment rate limit must allow it. Anything uncertain → the whole email becomes a proposal (never half
assigned) and the reply says why and how to make it direct next time. Each task records `source_email_id` and origin "email";
the assignee is told on their usual channels plus email (A-T54.4); the sender gets one threaded reply listing FN keys, owners
and channels; `email.assigned` is audited with how each owner was decided.

## D174 — The CEO adds people; consent stays the person's own act, and can be given by email (TASK-054) [verified — tests]
`POST /dashboard/people` (CEO only) creates an active employee with email, department, role, manager (the CEO by default) and
issues a Telegram invite BOUND to that row, so joining the bot later never makes a second person. The audit row keeps the role
and the email domain, never the name or address (the append-only log could not be erased). The privacy notice is emailed with
the hash of its exact words; a reply "I AGREE", matched by thread to OUR notice email to THAT person and authenticated like any
reply, records consent `via: "email"` — refused if the notice changed since. Replies that do not agree record nothing; the
answer to them goes out as part of the consent conversation (the one kind the relay sends before consent). A-T54.2.

## D175 — A person's own percentage survives a status tap; "60%" in their words is their progress (TASK-054) [verified — tests + browser]
`recomputeProgress` no longer replaces a self-reported figure with the status default (pending 10%, in progress 50%) — only
counted steps or finishing (done/cancelled) replace it. `statedPercent` reads the ONE percentage written in a note (any
channel: Telegram, app, email) by a pattern before any model is called; two different figures or 100+ return null. It becomes
`reportProgress(..., source self_reported, note = their words)`. The email path's own first-line percentage call was removed so
there is one rule. This is the "I do not see the 60%" defect (G142).

## D176 — Every Overview number is counted by SQL and opens the list it counted (TASK-054) [verified — browser 34/34]
`GET /dashboard/summary` (under RLS) returns open, in progress, not started, blocked, behind, from earlier days, completed,
reports, open/urgent/acknowledged problems, needs-review. Tiles and the hero sentence link to new pages — Pending work,
Completed, Problems — through a third hash segment for the filter (`#tasks/pending/blocked`), so lists are bookmarkable and the
back gesture works; the current tile is marked. Page filters use the same definitions as the SQL, so a tile that says 7 opens a
list of 7. Pending cards show the FN key, owner, who gave it, the percentage with its source ("reported by X · time", "counted
from steps", "by status — no % reported yet"), the person's words, open problems and severity, behind/priority, age, last report.

## D177 — The inbox poller reads To OR Cc, in the inbox AND the server's Sent mailbox (TASK-054) [verified — Dovecot]
Because Gmail files self-sent alias mail under Sent only (A-T53.2 corrected), and because "copy FreshNow" is how the CEO logs an
email to a person. The Sent mailbox is found by its RFC 6154 special-use flag, never a localised name; a message there counts as
sent by the account owner (core still requires From = owner). Dedup by Message-ID covers a message in both.

## D178 — Mail-loop guards (TASK-054) [verified — tests]
Reading Sent means FreshNow's own outgoing mail is visible to the poller. Two guards: an inbound message whose Message-ID is one
we sent is ignored ("a message FreshNow sent itself"), and the inbox alias can never be stored as a person's address.

## D179 — The user directed the Operations + Inventory expansion now (TASK-055) [verified — user decision 2026-10-15]
Operations and Inventory portals, a read-only Televend connector (MCP + pipeline), a Flutter Android staff app, a built-in chat that
replaces the WhatsApp groups, and eight new roles — ahead of the Phase 3/4 table in CLAUDE.md. This supersedes CHANNELS-GUIDE's
"drivers stay on Telegram" and the Driver-PWA plan (TASK-BOARD 042); the messaging-resilience report's objection to a separate chat
server still holds (chat is built inside our own API and database). Telegram and email stay. The task sequence (055–069) is in
TASK-BOARD.md § "Operations + Inventory expansion"; each task after 056 starts with a short plan the user confirms.

## D180 — One Televend client, one egress gate: an allow-list of host + method + path (TASK-055) [verified — tests + live runs]
Every request to Televend goes through `TelevendClient`, which calls `decide()` (packages/televend/src/allowlist.ts) before
asking for a token or touching the network. A method check alone is not enough: Televend's web app has GET endpoints that START
export jobs. Widening the list takes a code change and a test, never a setting. Rejected: trusting the account's permissions (the
account given to us can edit machines, prices and events).

## D181 — A refused Televend credential latches; the password is never retried (TASK-055) [verified — tests]
Keycloak counts failed passwords. `PasswordSession` signs in once, lives on the refresh token, and after a refused password (or a
refused API client) throws `TelevendAuthError` for every later call until the process restarts with new settings. A 5xx from the
token endpoint is not a refusal and does not latch.

## D182 — Three Televend transports behind one interface; the bridge until the official API exists (TASK-055) [verified — user choice + tests]
`TelevendSource` = bridge (the web app's own GETs, chosen by the user 2026-10-15), official (documented Data-Streaming API, fetch →
persist → commit), files (portal exports). Downstream code sees normalised `Tv*` rows only, so switching transports changes nothing
downstream. The bridge is to be replaced by the official API as soon as Televend IT issues a read-only client.

## D183 — Windowed reads with adaptive slicing instead of offset paging (TASK-055) [verified — live re-read]
Televend's paging drifts on large windows (G148). Vends and events are read as time slices that each fit one page; a full page splits
the slice in half. Bounded (600 requests, 1-second minimum slice) and honest (`complete: false` when a bound is hit).

## D184 — MCP over the v2 SDK, answers computed in code, names as initials (TASK-055) [verified — stdio run]
`@modelcontextprotocol/server` 2.3.1 (v2 "stable release line": two dependencies) over v1 `@modelcontextprotocol/sdk` 1.32.1
(express, hono, ajv…). zod 4 is installed for the MCP package only; the rest of the repo stays on zod 3. Every tool returns totals
computed in TypeScript plus at most 50 rows; filler names default to initials because the model's context processes whatever we
put in it (CLAUDE.md rules 2 and 4; minimum-necessary prompts).

## D185 — SheetJS 0.20.3 from the vendor CDN, pinned by sha512 (TASK-055) [verified — install + parse of 11 real exports]
Needed for the portal's legacy `.xls` event exports. The npm registry copy is stuck at 0.18.5 (affected by CVE-2023-30533 and
CVE-2024-22363); 0.20.3 is past both fixes. Installed from `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`; the lockfile's
integrity hash makes a changed tarball fail the install rather than slip in.

## D186 — Company data never enters the public repository (TASK-055) [verified — git check-ignore]
WhatsApp exports, Televend exports, screenshots and analysis outputs live in git-ignored folders (`private-data/` for everything new).
Tests use synthetic files generated in memory with the real layouts. Committed write-ups give methods and match rates, not sales
figures or names; detailed reports go to `private-data/reports/`.

## D187 — A local, read-only Televend mirror in Postgres (TASK-056) [verified — tests + live runs]
Migration 0023: tv_machine (+ tv_machine_caption name history), tv_vend, tv_event, tv_refill, tv_sync_run, tv_sync_cursor, and our own
machine registry (machine + machine_placement). The portals, reconciliation and the app read OUR database — joinable with stock and
cash, and still there when Televend is down. Natural unique keys + ON CONFLICT make every re-read harmless; every row keeps Televend's
JSON (`raw`) for replay. Readable by the CEO only until TASK-057's operations roles.

## D188 — Per-row raw JSON and tv_sync_run instead of a raw-page table (TASK-056) [verified — schema]
The plan named a `tv_raw_page` table. Keeping each record's own JSON on its row replays the normalisation of that record directly, and
tv_sync_run records the window, requests and completeness of every run — the same replay/audit value without storing every page
twice. Superseded plan detail, recorded here.

## D189 — Sync shape: overlapping incremental windows + a bounded daily check (TASK-056) [verified — tests + live]
Every ~10 min: machines (refill detection from last_refill_at), vends since the cursor minus 30 min, events since the cursor minus
60 min (late telemetry keeps its original time), refills only for machines whose last refill moved — read for the business day of that
refill. The cursor moves only after a complete read. Once a day after 04:00 Asia/Dubai: yesterday re-read whole, vends compared with
Televend's own whole-day count; at most 3 attempts per day. Backfill: newest day first, skips complete days, request budget per run.

## D190 — Physical machine = asset number; Televend records are placements (TASK-056) [verified — tests]
`machine` has one row per asset number (created on first sight of an enabled machine) with a QR token for the visit sticker; a
Televend record whose asset number changes is closed and re-placed; a disabled record has no open placement; the label follows
Televend's name unless set by hand (`label_manual`).

## D191 — Tables are created by the task that uses them (TASK-056) [verified — plan deviation recorded]
The plan listed vehicle, team, shift_window, site and a "FreshNow system" actor in TASK-056. None is used by the ingestion, so each
moves to the task that first needs it (system actor → TASK-059 alarms→blockers; vehicle/team/shift → TASK-061 field operations):
unused tables add test, reset and erasure surface for nothing.

## D192 — No live-sync triggers on the Televend tables yet (TASK-056) [believed]
The current SSE stream is a doorbell that makes every open dashboard re-fetch its 12 task endpoints on any watched-table change; a
sync every 10 minutes would ring it for screens that show no Televend data. Triggers come with the scoped realtime topics (TASK-058).

## D193 — A past day's refills ask every Televend machine record (TASK-056) [verified — tests + measured]
Complete by construction rather than pruned by a guess: Televend's machines list cannot tell which disabled record was live on a
past day (G160), and a broken machine can sit unsold for weeks before it is emptied and disabled. Cost: one request per record —
221 instead of 87 per day at ≤ 1 request/second; the daily check stays inside the 10-minute schedule (the worker runs one job at a
time). For a long history backfill, refills become the largest stream; the backfill's request budget bounds each run.

## D194 — The test suite gets its own Redis database, not a mocked queue (TASK-056) [verified — MONITOR]
Tests keep using real BullMQ against a real Redis (same rule as Postgres: never mocked), in a logical database of their own so they
can never touch a running worker's schedules or timers (G163). Chosen over a separate Redis container for tests because the same
server with another database index needs no new service on the laptop or in CI; TEST_REDIS_URL overrides it where a dedicated
test server exists.

## D195 — Each stream of a sync run on its own; a failed refill read is never "consumed" (TASK-056 review) [verified — tests]
A run reads refills first and saves the machines' new state after, keeping a record's old state when its read failed; vends,
events and the daily check's streams each run whatever the others did; the run then fails as a whole (TelevendSyncError) so the
failure is seen in job_run and the worker log. Chosen over a per-record "pending read" column: it needs no schema change and keeps
the rule the cursors already follow — state moves only after the read it stands for succeeded.

## D196 — Permissions are capabilities, in one table with a database twin (TASK-057) [verified — tests]
`core/permissions.ts` holds ROLE_CAPABILITIES (11 roles × 19 capabilities); every check in the API, bot, worker and dashboard asks
`can()`. Postgres holds the same table as `role_capability` (0025), read by `app_has_capability()` inside the read policies; a test asks
Postgres every role × capability and fails on any difference. Changing what a role may do = edit the TS table + a new migration. Deny
by default: unknown role or inactive account → nothing. Chosen over role-name checks because 14 "refuse if employee" checks would have
let any new role through (G169).

## D197 — Admin reads everything but is not the CEO (TASK-057, user decision 2026-10-15) [verified — tests]
`app_reads_all()` (CEO and Admin) replaces `app_is_ceo()` in the 22 read policies; `app_is_ceo()` itself is unchanged, so the CEO-only
INSERT/UPDATE policies and the 0014 guard on privileged employee columns still mean the CEO alone. Admin's writes go through core on the
service role with capability checks. Admin cannot: make or remove Admins, change the CEO's own row (role, manager, department, status),
erase an Admin, or act in the CEO's name (R30). The CEO role is handed over, never granted.

## D198 — Only a role that leads people may be someone's manager (TASK-057) [verified — tests]
Escalation level 1 sends a raiser's own words to their manager; RLS must let that manager see them. Core refuses a new manager whose
role lacks people.view_reports or data.read_all, and the dashboard's "Reports to" offers only those roles. Before, the picker offered
anyone who was not an employee — any new role.

## D199 — The bot's document planning stays the CEO's (and Admin's) (TASK-057) [believed — kept as it was]
`documents.plan_tasks` (dashboard) is held by everyone who leads people, as the old deny-list allowed; `documents.plan_in_bot` only by
the CEO and Admin, as the bot allowed. Two capabilities state the existing difference honestly instead of silently widening the bot.
Open question for the user whether to unify.

## D200 — Department, site and shift are self-filled once, then changed on the People page (TASK-057) [verified — tests]
They decide what a department lead sees and who resolves a person's blockers. "Update my details" rewrote them at will through the
service role, past the 0014 guard (G170). Now core writes them only while blank (first onboarding keeps working); role title and
language stay the person's own.

## D201 — An email address is an identity: the CEO's and Admins' are the CEO's to change (TASK-057 review) [verified — tests]
Inbound email decides who is speaking by the sender's address. With Admin now allowed to set addresses, an Admin could have pointed the
CEO's row at a mailbox they control and given work by email in the CEO's name (R30). Core `setEmployeeEmail` refuses a change to the
CEO's or an Admin's address unless the CEO makes it (a person may still change their own); the People page shows those addresses
read-only to an Admin. Found by reviewing the change myself — the independent review could not run (weekly limit).

## D202 — The CEO still hands the CEO role over through the API (TASK-057 review) [verified — tests]
The first version refused any change to or from "ceo", which removed the CEO's existing (API-only) handover that the erase route's
rule depends on ("the CEO role changes hands through updateOrg first"). Restored for the CEO alone; the seeded CEO row keeps the role;
nobody else may grant or take it; the People page still never offers it.

## D203 — Photos and videos live in Supabase Storage, reached only through the API (TASK-058, user decision) [verified — tests + live]
One private bucket "media" (JPEG and MP4 only, 50 MiB), files named by the sha256 of their CLEANED bytes, the record in
media_object/media_link in the same Supabase database (Storage keeps its own index there too, in the `storage` schema). Every read
is checked under the viewer's RLS before a byte is fetched; a file one may not see answers like one that does not exist. The API
holds SUPABASE_SECRET_KEY for this, confined to a client that calls only /storage/v1 object and bucket endpoints, in that bucket,
for the two content-addressed path shapes. Chosen by the user over a plain folder ("one Supabase for everything"); measured cost
of the extra service: storage-api ≈ 83 MiB RAM, ~0% CPU idle (2026-10-15, laptop).

## D204 — Nothing a phone writes about where or how a picture was taken is kept (TASK-058) [verified — tests + live]
Photos are decoded and re-encoded (sharp keeps no metadata by default: EXIF incl. GPS, ICC, XMP, IPTC), turned upright first,
shrunk to 2048 px on the long edge, with a 320 px thumbnail. Videos are not re-encoded (no ffmpeg on a shared server): every
udta and meta box (and XMP) at the top level, in moov and in each trak is renamed "free" and zeroed in place — same length, every
offset valid. ≤ 15 s per video. The type is decided by the file's first bytes; HEIC is refused (the app sends JPEG).

## D205 — Deleting media waits for the company's decision, like text retention (TASK-058) [believed]
Each file records its due date from its class (evidence 180 days, video 30, receipt 1825, chat 365 — the plan's proposals), but the
sweep deletes nothing until MEDIA_RETENTION=on, and says so hourly — the same rule as RETENTION_DAYS: how long evidence is kept is
the data controller's call, not a developer default.

## D206 — A live update reaches only the people it concerns (TASK-058, amends D92) [verified — tests + load test]
The NOTIFY payload now carries a scope worked out in the trigger: `e:<employee>` (rows anyone who may see that person may see),
`s:<employee>` (rows only that person sees — their inbox, a blocker they are to resolve, work they gave), `p:<project>`, `org` (who
sees whom changed) and `*` (only those who read everything). The API matches it against
each open stream's picture of what its viewer may see; the browser still receives exactly `{table, op, at}` and never the scope
(D92's rule). Fail-open everywhere: a scope the trigger cannot compute becomes `*` + `org`, more than 100 topics collapse to `*`,
and a picture still loading hears everything — a missed doorbell leaves a board stale, an extra one only costs a refetch.
Migration 0027, on 19 tables.

## D207 — A viewer's picture: candidates by plain SQL, then the same RLS that guards every read (TASK-058) [verified — twin test]
Asking RLS for "everyone I may see" ran app_can_view_employee on every row: 46 ms per picture at 300 people, 8.95 s to bring 300
pictures up to date after an org change. Now the service connection lists candidates (me, my reports, my department) and the
viewer's own context keeps those RLS allows, with `id = any(candidates)` — leakproof, so the planner applies it before the
policy: 1.9 ms, 1.27 s for 300 (G179, VF68). Candidates can only narrow what RLS decides; a test compares each role's picture
with what RLS returns (live-audience.test.ts). Projects are read whole under RLS.

## D208 — Portals are a registry; each loads only its own data and code (TASK-058) [verified — browser + build]
portals.ts names each portal and the capability it needs (Operations: televend.read). The picker and the switcher show only what
the viewer may open, and a link to one they may not lands on one they may, without a Back trap. The tasks board's lists load
only on the tasks portal. Operations and the chart library — Recharts 3.10.1 (MIT; the user's choice) — are one chunk fetched
when Operations opens (VF69); a chunk that cannot be downloaded shows "could not be opened · Reload", and a tab left open across a
deploy reloads itself once.

## D209 — How many live streams one API process carries is configuration, sized by measurement (TASK-058) [verified — load test]
LIVE_MAX_STREAMS (500) and LIVE_MAX_STREAMS_PER_PERSON (8) replace the fixed 50. Past either, a board polls instead — nothing is
lost, it is slower. A stream that falls 64 KiB behind is closed. Measured on the laptop (VF68); the VPS is re-measured before
the limits are raised (A-T58.3).

## D210 — Phone sign-in: a PIN the server checks, short opaque tokens, sessions that end with the shift (TASK-058) [verified — tests; deviation]
The user's decision (2026-10-15): shared company phones and bound personal phones, a 4–6 digit PIN, no SMS. The design review
rejected a key unlocked on the phone — an insider holding a shared phone could test PINs offline against it — so only the API
checks the PIN: scrypt N=2^14, r=8, p=5 (one of OWASP's equivalent minimums) over an HMAC of the PIN with a pepper kept outside
the database (APP_PIN_PEPPER). The phone keeps a device secret and, for each person set up on it, a person secret (both stored as
sha256). Sign-in returns opaque tokens — access `fna_` (15 min), refresh `fnr_` — stored hashed and checked in the database on
every request. Refresh rotates; a refresh token presented twice ends its whole family (RFC 9700 §4.14), except within 60 s, before
its successor was used (a lost response). Wrong PINs: from the 5th in a row a wait of 1, 5, 15, 30, 60 min, disabled at the 10th;
20 in 30 days across phones (counted since the person was last set up) disables them everywhere; 15 on one phone in an hour lock
the phone for an hour, as do 5 wrong set-up codes. A company phone holds one person at a time; its session ends at the next
handover (07:30, 15:00 — A-T58.4) at least 2 h away, plus 30 min, or after 60 idle minutes; a personal phone after 30 days or 7
idle. CEO and Admin cannot use a shared phone. Until the app's routes exist a phone's token opens GET /dashboard/me only.
Deviation (DEVIATIONS.md): NIST SP 800-63B-4 asks 8+ characters of a memorised secret used with a second factor (§3.1.1.2) — the
enrolled phone is that factor — and 4–6 digits is below it. Recommended: require 6.

## D211 — Functions that run as their owner have a fixed search path; the live-update trigger runs for nobody else (TASK-058) [verified — test]
Migration 0029: every SECURITY DEFINER function in public owned by the migrating role gets `search_path = pg_catalog, public,
pg_temp` (else a caller's temporary schema could shadow a table it names); notify_change() is executable by its owner only — a
trigger needs no EXECUTE when it fires (G182); Supabase's default grant of EXECUTE on new public functions to service_role is
revoked (G183); the triggers name public.task and public.assignment in full. A test checks the ACL and every search path.

## D212 — One media record per uploader per content; the server decides how long it is kept (TASK-058 review) [verified — tests]
Migration 0030 replaces one record per sha256 — a second person sending the same bytes (a forwarded photo) was given the first
person's record — with one per (uploaded_by, sha256); the bytes are shared and removed only when no record needs them. Videos
are always class "video", photos "evidence" or "receipt", chat media "chat"; the sweep re-dates every record from the current
periods, so a changed period applies to files already stored. Refusals and duplicates count towards the upload limit, at most
two photo decodes run at once, linking a file to a task is audited, and a video whose length cannot be read is refused.

## D213 — The phone app's push is a wake-up with no content (TASK-058, binding on TASK-063) [believed — Firebase docs]
Notice 3.0 tells people Google's Firebase sees only that a signal went to their phone, and when. So an FCM message carries no
text, name or record id; the app fetches what is new from the API and shows the notification itself — D92's rule, on the phone.
Firebase's Android guidance (updated 2026-10-15): a high-priority message gives several seconds in onMessageReceived, enough to
show a notification; a fetch needs an expedited WorkManager job (briefly exempt from quota after a high-priority message); and
high-priority messages that do not lead to user-facing notifications are deprioritised. So: high priority only for what the
person is told about, a generic notification first if the fetch may be slow. If TASK-063 cannot keep this, the notice changes first.

## D214 — An Operations figure is shown only for time the mirror read to the end (TASK-058 review) [verified — tests + browser]
"In the mirror" is measured, not inferred from the first read: the complete vends runs, as one set of time ranges (range_agg),
must contain the span — the day shown up to its cut, the earlier day whole. Otherwise that side is null, never 0, and the page
says why: before the mirror, a gap (a sync stopped for longer than its 48-hour look-back, or a read that did not finish), or
nothing read yet today. The cut (horizon, clock or day end, whichever is first) is computed in Postgres and never falls before
the day began — just after midnight it fell on yesterday and drew 23 hours of nothing sold. The hour in progress is compared
with the same minutes a week earlier.

## D215 — Privacy notice 3.0: the operations work in one change, each part named only when it is switched on (TASK-058) [believed — a draft for the lawyer]
Adds Televend's records that carry staff names (FreshNow reads them and sends Televend nothing; its server region is not
claimed); photos and videos (location removed; periods once MEDIA_RETENTION=on); phone sign-in (account safety only, never
attendance; three wrong PINs tell the person and their lead; sessions deleted 30 days after they end; the audit trail keeps each
sign-in); the app's wake-up through Firebase (D213); the cash and stock recorded in the app (a difference is a fact about what is
held, looked at by a person); and who sees what since TASK-057 (Admins; the machine records: Ops Head and Supervisors). One rule
per part, shared with the compliance check where there is one (televendReachable). Version 3.0-draft: everyone is asked again
and their messages are held meanwhile (D139/D140). On Telegram the request arrives in two messages (G187).

## D216 — The question box reads only the tables it documents; the activity feed leaves sign-ins out (TASK-058) [verified — tests]
The notice's "never used to check when you work" was not yet true: query/guard.ts checked keywords and schemas, not tables, and
the CEO's RLS reads app_session and audit_log — "when did X sign in each day?" could have been answered. Now each query is planned
first (EXPLAIN, verbose, nothing executed) and refused — and audited as query.scope_refused — if it reads any relation besides
the eight documented ones (schema-prune.ts): CTEs, subqueries and joins included, because Postgres names them, not a parser of
ours. CLAUDE.md's "pre-approved views" is now enforced, not only shown to the model. /dashboard/activity leaves out
app.signed_in and app.signed_out (they stay in the audit trail; wrong PINs still show). A person's own data export still lists
their sign-ins — their right of access.

## D217 — The FreshNow app is the main channel; Telegram is an option, not the first one (user, 2026-10-16) [decided]
"Can we not make telegram the first option and app the main one and implement accordingly" — with the app's own chat (TASK-066)
as the WhatsApp replacement. What follows from it, from TASK-059 on: every confirmation and handshake (a driver accepting stock,
an auditor approving cash) happens in the app — the web app now, the Flutter app from TASK-063 — never only in Telegram; the app
is listed first and is the default wherever a channel is chosen; Telegram stays for people who link it, as an extra or a
fallback, and the bot keeps working. Today's state: the in-app inbox is always on and push is used where a phone is set up, but
NOTIFY_CHOICES lists Telegram first and a linked Telegram account is added by default (alerts.ts usualChannels) — to change with
tests in TASK-059's first step.

## D219 — Phone sign-in after its independent review: ten findings, all fixed (TASK-058 review) [verified — tests]
The reviewer's findings, each confirmed by reading the code first: the counted row of a wrong PIN or code is written in the SAME
transaction as the count, and each phone's attempts are serialised by a lock on its row (a malformed correlation id used to make
the post-commit audit write fail, so failures went uncounted and unreported); refresh, sign-in and sign-out lock the phone too,
so a revoke never misses the pair a refresh is inserting; a voided refresh pair presented later ends the family and is
recorded (RFC 9700 §4.14 — the phone that lost the answer never had that pair); CEO and Admin are refused on a shared phone at
every sign-in, refresh and token check, not only at set-up; set-up checks the phone and code before the slow PIN hash; the
30-day limit counts failures against the person's live credentials and, when reached, revokes them all (recovery is a fresh
set-up); a PIN changed during a check refuses the old one; housekeeping keeps used codes a credential still points at, in its
own try; and someone else's export of a person — and the phone list — carry no sign-in times.

## D220 — Machine alarms reach people through rules, as problems, behind a switch (TASK-059) [verified — tests]
Migration 0031: alarm_rule (per Televend alarm name: actionable | noise | info, an on-delay, the category that routing_rule
uses, severity, advice — seeded from the measured classes) and machine_alarm (each alarm linked to the problem it raised or
joined). An alarm still open after its on-delay becomes a blocker raised by a system actor (a disabled employee row, never
assignable or messaged), routed, timed and escalated like any other; repeats join the open one per machine and alarm name;
it closes itself ("Cleared in Televend") when every alarm behind it clears. An unknown alarm name needs someone after 30
minutes — hiding it is the worse failure. Off (OPS_ALARM_PROBLEMS) until routing rules name who handles machine, stock and
cash problems: with today's catch-all every one of ~30 a day would page the CEO. The command centre lists them either way.
Ops Head and Supervisors see the system's problems through a new clause in blocker_select.

## D221 — The cash a collection should have found is Televend's cash vends between collections × the cash price (TASK-059) [believed — 18/29 matched]
Televend gives each collection's time (the Staff App's "Cash Collection" event) but not its amount without the cash-centre
permission; it does give every cash vend (payment_type 0). Window [previous collection + 1 min, this one + 1 min): a vend in
the minute of a collection belongs to it and none is counted twice. Price per machine (machine.cash_price_fils), default
AED 10 (A-T62.1). Never the machine counter's photo (G190). Shown as "should have found", with "a difference is a fact to
look into, never an accusation" — the driver's own count arrives with the app (TASK-061).

## D222 — The Operations command centre (TASK-059) [verified — tests + browser]
Now: tiles (need someone, offline, cups today, cash in the machines, collections, refills), the alarms that need someone
(blips held back by their on-delay, counted but not listed), every machine by Televend region with its state in a word, an
icon and a colour, cups today and the cash waiting; a machine panel (today by hour, alarms, collections with what each
should have found, refills with who filled). Day report: one Dubai day per machine. Views in the hash (#operations,
#operations/sales, #operations/day). A morning report at 07:30 to everyone with televend.read — app first, Telegram only
where the app cannot reach a phone (notifyPeople telegram: "fallback", D217); once a day, marked in the audit log.

## D218 — Stock differences and corrections are approved by the Ops Head, the CEO or an Admin (user, 2026-10-16) [decided]
For TASK-060: the warehouse keeper never approves their own count; a difference beyond a small tolerance is recounted by someone
else first; an approval carries a reason and posts an adjustment — the original entries are never edited (a reversal, as
ERPNext keeps its ledger; dated when it is made — our choice: ERPNext's page does not say which date its reversal rows carry,
corrected 2026-10-18). Kept order (user): TASK-059 Operations command centre, then TASK-060 inventory. Built as D223–D225.

## D223 — One stock ledger: moves are never changed, the balance follows them, a real place never goes below zero (TASK-060) [verified — tests]
Migration 0032. Every change of stock is a document (stock_doc) with moves (stock_move: an amount of one item from one place
to another). Places: the warehouse, each person who holds stock, in transit, and four bookkeeping places (suppliers, used,
damaged, count adjustments) that may go negative. stock_balance is kept by a trigger in the same transaction as each move and
can never disagree with the moves; its CHECK refuses any move that would take a real place below zero, whoever writes it.
Moves and document lines are never updated or deleted (triggers), a document's content never changes and its state only moves
forward; the app role has SELECT only (revoked insert/update/delete, G197). A mistake is a reversal: the opposite moves, posted
when the reversal is made (our choice — ERPNext's own page says it keeps the original rows and adds opposite ones, not which
date they carry; read 2026-10-17). Concurrent postings take one advisory lock per item, in id order, so two documents never
wait on each other in a circle; the balance row's own lock would keep the numbers right without it (PostgreSQL 17 §13.2.1,
read 2026-10-17). Every document id is made by the client: the same request twice posts once (request_hash tells a repeat
from a different request under the same id). Tested: Σ moves = balance for every place after 80 random postings; every item
sums to zero over all places; two hand-outs of the last carton — exactly one succeeds.

## D224 — A handover is confirmed by the other side; what did not arrive waits in transit for an approver (TASK-060) [verified — tests + browser]
Warehouse → person (the person confirms), person → warehouse (someone at the warehouse who is not the giver confirms — or the
keeper takes it back at the desk and the person confirms), person → person (from one's own stock; the receiver confirms).
The stock leaves the giver at once, into "in transit"; it is the receiver's only when they confirm. Nobody confirms their own
handover; nobody gives stock to themself; only roles that hold stock (inventory.hold) can be given any. A receiver who counts
less accepts what they counted (with a reason); the rest stays in transit, visible, until the Ops Head, the CEO or an Admin
who was not a party settles it — back to the giver (they miscounted) or written off with a reason. Refused or cancelled
handovers put the stock back where it was.

## D225 — Counts: the screen hides the record, a second person recounts big differences, an approver who did not count decides (TASK-060, implements D218) [verified — tests + browser]
Opening, after the team left, closing, or a spot check. A full count needs a number for every item (a line starts empty, not
at 0); a spot count any. Each line is compared with the ledger when the count is handed in; an item that moved while it was
being counted is never "accepted as counted". Differences beyond the item's tolerance go to a recount by someone else, who sees
neither the record nor the first count; an approver may let the recount go with a reason (one keeper on shift). The decision is
per line: the count is right (an adjustment document is posted, with a reason) or the record is right (nothing moves). The
database itself refuses a decision by the person who counted or recounted. A shortage that the warehouse no longer holds (stock
handed out since the count) is refused: count again.

## D226 — Stock is held per place and item; a delivery's lot details are kept on the delivery (TASK-060) [decided]
Oranges' variety and carton weight (A-T60.1) are recorded on each delivery line, but balances are not split by lot: the keeper
counts cartons, not deliveries, and the warehouse does not keep deliveries apart physically (no evidence that it does). Per-lot
stock (food traceability, a recall) waits for a named need — complexity is earned by a failure mode (CLAUDE.md).

## D227 — One unit per item, fixed once it has moved (TASK-060) [decided]
The WhatsApp list counts each item in one unit; nothing yet needs a carton→kg conversion (cups per carton is a calibration for
reconciliation, TASK-062, not a unit). An item's unit and step can be corrected until its first movement, then never — "10"
must keep meaning what it meant. The count tolerance is the approvers' to set (it decides when a second person looks).

## D228 — "Blind" is the count screen; the control is the second person (TASK-060) [decided]
The count screen never shows the record's figure, but anyone who may open the stock screen — the keeper included — can look at
it first. Hiding the warehouse's figures from the keeper would make the job impossible (giving out needs them). So a copied
count is caught by the recount by someone else, spot checks by the Ops Head, and the record of who counted what and when —
not by the screen. Stated in the task page so nobody believes the screen is the control.

## D229 — Ledger rows are deleted only through inv_purge_docs, for practice runs (TASK-060) [verified — tests]
The demo reset and the tests' clean-up delete stock documents (and their reversals) through one function that rebuilds the
affected items' balances afterwards: deleting moves one by one passes through states that never existed (G196). A purge that
would leave a real place below zero is refused whole. The switch it sets is a guard against accidents, not against the service
role on purpose; against the app role the boundary is its missing write grants.

## D230 — No stock is seeded: the first approved count is the opening stock (TASK-060) [decided]
The nineteen items of the warehouse's WhatsApp list are seeded with their units (some assumed, A-T60.2), with no quantities —
the list is copied forward, not counted (VF74). The first count, approved with the reason "opening stock", sets the warehouse.

## D231 — Who is told about stock, and when (TASK-060) [verified — tests]
App first, Telegram only where the app cannot reach a phone (D217). A handover waiting: whoever must confirm it (for a return,
the warehouse keepers; with none, the Ops Head; then the CEO). Less arrived: the giver, and the Ops Head to settle. Refused: the
giver. Below an item's minimum in the warehouse: the keepers and the Ops Head, once a day per item. A count that differs: a
second person to recount, then the approvers; closed: the stock list from the record, the WhatsApp list's replacement. The
worker reminds once: a handover still waiting after 30 minutes, and a count of the warehouse 30 minutes after stock went out
with no count since (A-T60.3) — the CEO asks for "the stock after the first team" every morning (VF74). Every notice is best
effort: one that fails never undoes the stock that moved.

## D232 — The Stock portal: for everyone who holds or sees stock, made for the warehouse's phone (TASK-060) [verified — browser]
portals.ts: a portal may need any one of several capabilities; Stock needs inventory.read or inventory.hold. A driver sees what
waits for them (one tap: "All here"; or "Something is different"), what they hold, and the buttons to give it back, hand it on
or record it used; the keeper sees today's counts (opening / after the team / closing), big action tiles, the stock list as
tiles (🚨 when low), and the movements; approvers see what needs them. Targets 48 px or more (Android guidance, checked
2026-10-17), steppers instead of typing, icons before words, one thing per sheet. Its own code chunk (12 KB gzipped), loaded by
those who open it. The page refreshes on the database's doorbell (0032 scopes: c:inventory.read and the people concerned).

## D233 — The independent review of TASK-059 and TASK-058's last parts: 27 findings, 25 confirmed, all but four fixed (2026-10-17/18) [verified — tests]
Fixed: long alarms never mirrored as cleared — an open-alarm refresh re-reads their start windows (G201, VF81); machine problems
folded by category into one alert — every system-raised problem is its own alert; a repeat inside its on-delay now joins the open
problem and a problem stays open while any repeat is; a switched-off Televend record raises nothing and closes its problems; an
unrelated failing stream no longer stops the alarm sync; info alarms never linked; the day report counts alarms by what
happened (stayed open past their wait, or cleared within it), not by rule class; the question box refused functions that read
tables by name (query_to_xml …) and Unicode-escaped names, in the text and in the plan; a third party's data export no longer
shows a count of a person's sessions, and the person's own includes their wrong PINs; voice transcripts age out and are erased;
media: bytes and records under one lock per picture, bytes taken back when the record fails, a believable taken-at time, the
retention clock restarts when a picture is attached again, two uploads at a time per person, a capped decode queue, a storage
error no longer reads as "no such file"; live updates: a failed LISTEN starts again on a fresh connection, capability scope keys,
the machines' problems ring everyone who runs the machines, a stalled stream is destroyed, semaphores re-check, rate-limit audit
rows at most once per five minutes. Refuted by the skeptic: a duplicated Telegram part on a partial failure (deliberate), the
MP4 header's duration (any self-declared length can lie). Not fixed (low, written down): expected cash across a machine move
without a collection; a re-pointed Televend record mixing two assets' history on the machine page; with no vends cursor every
day reads as "not in the mirror" (lasts until the first complete read).

## D234 — The notice names stock for everyone, who can see it and how long it stays; its words follow the person's (TASK-060) [verified — tests]
Notice 3.0-draft gains three lines that are always there (stock is recorded on every installation): what is recorded (stock a
person is given, hands back, uses or counts), who can see it (the warehouse keepers, the Ops Head, Supervisors, the CEO, Admins),
and how long (the records stay as the company's stock record; the words typed on them go with the person's other words —
migration 0034 lets only the words be redacted). The text changed, so everyone is asked again; nobody had agreed to 3.0 yet.

## D235 — The morning report waits, until 10:00, for Televend to have read yesterday in full (2026-10-18) [verified — test]
On 18 Oct the worker started after a night off and sent the report minutes before the catch-up read landed — honest ("not read
in full") but useless. Until 10:00 it now waits while the sync is stale or yesterday is incomplete; after that it goes as it is.

## D236 — The TASK-060 review: a count's difference is not posted twice, in-transit stock is not counted twice (2026-10-19) [verified — tests]
Two read-only reviewers reported 17 findings on the stock ledger and portal; the skeptic pass did not run (usage limit), so each
was checked by hand against the code — all 17 real, all fixed with a test. The rules that changed:
- Accepting a count posts (count − ledger) as it was at the moment of counting. That stays right when stock was merely handed out
  or delivered since (both sides move alike), but not when the books were CORRECTED since: another count's decision, or an undone
  document. Accepting is then refused ("changed since") — checked under the item locks, so two decisions cannot both pass.
- A counted line that differs while the item is on a waiting or partly accepted handover from or to the warehouse is "unclear"
  (like moving during the count): counted again, never accepted as counted. A line that matches is clear (the stock has left).
- While a person counts (their count open, or a recount they took), their stock screen hides the warehouse's figures and the day
  sheet is closed to them; until a recount is taken, nobody who may still take it sees the first count or the ledger. A count
  copied from the screen would always "match" and nobody would look again — D228's "the control is the second person" only
  works if the figures are not on the counter's screen. They could still look before starting: spot counts by someone else stay
  the real control.
- An item's unit and step are fixed by a document line, by a count waiting for its decision, or by a count that found some of it;
  the editor takes the ledger's item lock, and every posting locks its items before reading them.
- A take-back from someone whose account is no longer active is confirmed by someone else at the warehouse, never the taker.
  A receiver whose role no longer holds stock may refuse a handover, not take it in.
- A repeat of a posted document is answered before anything else is checked; a different hand-in, recount or decision under a
  closed count is refused ("already handed in / decided"), never reported as done; a recount handed in after it was let go is
  refused in words. JSON numbers are read exactly (2.4996 refused, as the text is).
- Screens: the number box keeps what is typed until it loses focus ("2.5" had become 25); take-back amounts are set once per person
  chosen; a sheet sends only the items still on its list and names any that dropped off; a resumed count shows its own kind and
  offers to cancel it; the day sheet's person rows gain "undone"; Movements pages by (time to the microsecond, id).

## D237 — A driver never sees Televend's "should have found" — the auditor does (TASK-061, 2026-10-19) [believed — research + reasoning]
The driver counts the cash and types the figure. A figure on their screen — before, or after while they may still undo and type
again — invites matching it: under-reporting when the box held more than Televend counted (failed vends, notes put in without a
sale), and over-reporting nothing. That is the blind-count situation (POS vendors' "count before you see the expected total";
an internal-audit flash report's surprise counts and separated duties). So the server leaves Televend's figure, and the count of
collections that differ, out of every answer to anyone without cash.read; the cash auditor, the Ops Head, the CEO and Admins see
both. Against it, honestly: some vending software shows drivers the expected collection (a vendor blueprint; Cantaloupe's
"expected collection ticket") — in those operations the bags are counted in a counting room, not by the driver. If FreshNow moves
to sealed bags counted elsewhere, revisit.

## D238 — Cash is its own ledger, with the stock ledger's rules; a shift is what the auditor checks (TASK-061) [verified — tests]
Migration 0035: accounts (a person's hands; a machine's cash box; fuel, other expenses, the cash-deposit machine, bank, over/short),
entries (collection, test note, expense, deposit, reversal) and moves in whole fils, a balance kept by a trigger and never below
zero for a person, moves never changed, entries' content never changed (words only removed), reversals for mistakes. Its own
tables, not stock's: the warehouse keeper sees all stock and must see no cash, and money is never a decimal.
- A shift is one person's working period; its business date is the Dubai date it started (a night shift belongs to the day it
  began). One open shift per person; the first entry opens one. Cash still held at the end carries to the next shift (shown as
  "carried in") and the person is told to deposit it.
- Every entry carries a photo except a test note (A-T61.3); deposits check that the notes add up to the amount.
- Undo: the person, for their own entry while the shift is open and unchecked; an auditor, for anyone else's entry. Undoing a
  collection whose cash was spent or deposited since is refused until those are undone.
- The auditor checks an ended shift: ok, or a question in words that goes to the person and the Ops Head (the CEO when there is
  none); the person answers in the app; ok settles it. Nobody checks their own shift — the database refuses it too.
- Notices are the app's (D217): a question, an answer, a settled check, cash still held at a shift's end.

## D239 — The Cash portal: "My cash" for whoever handles it, "To check" and "All shifts" for whoever checks it (TASK-061) [verified — tests, typecheck]
One portal (`#cash`), for every role with cash.hold or cash.read: a driver's page is what they hold, their shift, five big tiles
(collected, fuel, test note, deposited, other), the shift's sums in the order the WhatsApp list wrote them, and any question to
answer; the auditor's is the ended shifts not yet ok, each opening to its entries, photos and Televend's figure per collection,
with "All ok" or "Ask". The warehouse keeper and the technician do not see it; the cash auditor sees no Stock portal.

## D240 — The notice names cash always: what, why, who sees it, how long its words stay (TASK-061) [verified — tests]
Cash is recorded through the web app now, not only by the phone app, so its lines no longer depend on phone sign-in. The words on
cash records (a note, the auditor's question, the answer) follow the person's other words: aged by the retention sweep, removed on
erasure, listed in their own download with the checks they made as an auditor. The amounts stay as the company's financial record.
The text changed, so everyone is asked again (notice 3.0 is still a draft).

## D241 — A team's shift is a plan in the app: the instruction sheet's machines, tasks, crates and proof (TASK-061 part 2) [verified — tests]
Migration 0036. A Supervisor, the Ops Head, the CEO or an Admin (routes.plan) makes one plan per team per day and shift: the team's
name as the sheet writes it ("Team Kiran / Ananthu"), its people (1–6, each active with visits.record), and the machines in order —
each with the sheet's tasks (full service, half service, resort, cash, water remove, kachara remove, clean with hot water, deep
clean, make free vend, check 🚨, other), crates of oranges (0–20), instructions (required for check and other) and the proof the
stop needs (normal pic, re-sorting pic, video of the white fruit dispenser, other). Every id comes from the browser, so the same
plan saved twice is one plan. A plan keeps its day and shift; a stop taken off is kept, marked removed (a visit may point at it); a
visited stop's machine is not changed. "Copy yesterday's plans" copies teams, machines, crates and instructions, skipping a plan
whose name already exists for that shift. The team is told once, when the plan is first made, with the crates to take. Why a
table, not a chat sheet: the sheet's red NO cells were filled in by hand from photos in the group (13 and 18 Oct sheets).
- A machine may be marked "served at night only" or "by day only" with a reason ("Schedule rashid always Night", 18 Oct). Putting
  it on the other shift is said as a warning, never refused — the planner may know better that day.

## D242 — A visit starts at the machine: its sticker's link or its typed number — never the phone's location (TASK-061 part 2) [verified — tests]
The user decided "no GPS" (2026-10-15). A machine's sticker is a link (`#visit/<qr_token>`) the phone's own camera opens — a page's
camera scanner (BarcodeDetector) needs HTTPS, which the laptop setup does not have; the typed number ("Machine ID" on the sticker)
is the fallback, and the visit records which of the two started it. One open visit per person: the same machine resumes it,
another is refused until it ends. The visit carries out the stop for that machine on the person's current round (unvisited first);
a machine off the plan is still a visit, off the plan. Nothing about a visit changes once it has ended (the database refuses it),
except its note's words being removed.

## D243 — Proof is the person's own photos and videos, one kind each; missing proof is said, not refused (TASK-061 part 2) [verified — tests]
A photo for the photo kinds, an MP4 video (15 s at most, TASK-058's limit) for the dispenser — checked by the stored file's type,
not its name. Only photos the person took themselves. A piece of proof is taken off, never deleted; when the photo rules remove the
file, the record that proof was given stays (media_id becomes empty). Ending a visit with proof missing is allowed and answered
with what is missing — the planner sees it as the sheet's NO. A planner may end a visit someone forgot to end.

## D244 — A visit's fill and cash go on the ledgers that already exist, linked to it (TASK-061 part 2) [verified — tests]
The fill is "used, put into a machine" from the person's own stock (TASK-060); the cash is a collection on their shift (D238), with
its photo. visit_doc links each to the visit. The cash ticks "Cash" by itself; the fill ticks nothing — it is part of a full or half
service the person ticks. No third ledger, and the auditor's view of cash is unchanged.

## D245 — The sheet's OK / NO is worked out from the visits, with Televend's refill beside it (TASK-061 part 2) [verified — tests]
For each stop on a day's plans: whether it was visited (by whom, when, by sticker or number), each proof column OK or NO, the fill,
whether cash was recorded, and — for planners — Televend's refill in cups and its Cash Collection event within 60 minutes before to
120 minutes after the visit started (A-T61.12). Visits off the plans are listed apart. A driver sees the plans they are on and how
far the team has got (who visited each machine, when, which proof is missing) — never another team's plans, and never the photos of
a teammate; Televend's "should have found" stays away from them (D237).

## D246 — The Route portal; the portal switcher wraps at three (TASK-061 part 2) [verified — typecheck, tests]
`#route` (Today: the person's round and "start a visit"; Plans and Proof for planners), opened from the switcher and the phone's
More menu, for every role with routes.plan or visits.record (Supervisor, Ops Head, CEO, Admin, VMO, Technician). A sticker's link
opens it with that machine's visit offered; the token is read once at load, because the shell rewrites the address to `#route`.
With six portals the switcher's labels collided in the 248 px sidebar (the user's point 9, 19 Oct): it now shows three per row and
wraps.

## D247 — The notice names visits always, and says plainly what "no location tracking" means (TASK-061 part 2) [verified — tests]
What is recorded (the machine named, when, what was ticked, the proof, the stock and cash recorded there, the plans a person is on),
why (it replaces the sheet and the photo group; a missing photo is a fact a person looks at), who sees it (planners; teammates see
progress but not photos), how long (an operations record; the words go with the person's other words). "No location tracking" now
reads: the app never reads where the phone is — a visit records only the machine named and the time. Visit notes, plan notes and
instructions are aged by the retention sweep, removed on erasure, and listed in the person's own download. The text changed, so
everyone is asked again (still the 3.0 draft).

## D248 — The 19 Oct request is planned in five phases, easiest first; 16 choices made by the user [verified — user's answers, 19 Oct]
Request recorded verbatim (`docs/requirements/REQ-2026-10-19.md`, 115 requirements, every one with a row in the plan's table —
checked by a script). Plan: `docs/reports/plan-2026-10-19-analytics-routing-cash.html`. Phases: 1 analytics on the data we have
(070–075) → 2 money and stock balanced (062, 076, 077, 061 part 3) → 3 the Televend switch and audits (082, 084; 083 writes) → 4 one
app after the server (064, 066, 063, 065, 067, 068, 069) → 5 forecasts and routes (078–081). The user's answers:
- Categories: Televend's regions with FreshNow's corrections. Tiers: three against the fleet average of cups per machine per day
  (≥ 125 %, 75–125 %, < 75 %) plus "no sales". Income: cups × the price in the machine's name, labelled estimated. Sales history:
  copied back as far as Televend returns.
- A deposit that differs needs a reason; the person and their manager are alerted. Fuel needs its receipt; food and other need the
  manager's approval in the app; "juice try" is its own kind. The bank statement comes as CSV/Excel. OCR runs on our server.
- Locations: a pin on an OpenStreetMap map **and** a pasted Google Maps link (both). Solver: VROOM on OSRM, OR-Tools as a cross-check,
  ant colony a benchmark. Routes: computed at 00:00, reviewed, else sent marked "automatic" one hour before the shift. Shifts assumed
  day 07:00–16:00, night 16:00–07:30 until confirmed.
- Televend writes: one operation at a time, each with the user's yes, after Televend confirms the endpoint; the bridge account never
  writes (the 15 Oct read-only rule holds until then). The MCP ↔ API switch lives in Settings (CEO/Admin), audited, with a live test,
  a shadow week and automatic fall-back. The server is bought before Phase 4.
- The earlier plan (TASK-055–069) checked item by item at the user's request (plan §10): 90 deliverables, 38 built, 52 open, each with
  a task. Six had no place in the first draft and were added: Televend's people matched to employees (062 — also so erasure reaches
  Televend's copies of names, A-T56 note), sites and vans (078), Televend's history log (072), period close (062), the missing MCP
  tools (082), and alarms → routed problems once FreshNow names the resolvers (074).

## D249 — Machine performance is cups per day read, against the average of the machines that sold (TASK-070) [verified — tests]
`core/analytics.ts`. Whole days only, up to yesterday, at most 92 (today is Operations → Now). A day counts only when the sync read it to
its end (tv_sync_run.complete) — a day not read is named and left out, never counted as zero, and per-day figures divide by the days
read. The fleet average is over counted machines that sold at least once; a machine that sold nothing is "no sales", apart, so a broken
machine does not drag the average down. Tiers: top ≥ 125 %, below < 75 %, about average between (D248, A-T70.4). The "80 % set" is the
fewest machines whose cups reach 80 % of all (ties by asset number, so the set is the same every run). The period before is the same
days of the week, shifted by whole weeks (7 × ⌈days ÷ 7⌉): yesterday against the same weekday a week before, ten days against the ten
days two weeks before — a weekday pattern never reads as a change. Each machine's days sit beside the same weekday 7 days before (R8.3).
Insights are fixed sentences filled from the figures, each carrying the numbers it states (tested: no number in a sentence that is not
in its list); actions name the machines. A LEVEL is per machine that sold; a CHANGE is on volume — cups per day read, for the same
machines in both periods — never on a per-machine average whose denominator can move (G210). The page draws; it computes nothing (each machine's cash share and the cash share's move come
from the server too).

## D250 — A machine's category is FreshNow's correction, else Televend's region; "Not counted" leaves it out (TASK-070) [verified — tests]
Migration 0037: `machine.category_override`, `category_note`, `category_set_by`, `category_set_at`, and the capability `machines.manage`
(Ops Head, CEO, Admin). Choosing Televend's own region clears the correction. Each change is audited — without the reason's words, which
stay on the machine row where the retention sweep, erasure, the person's download and the reset script reach them. Categories compare
per machine per day so 19 machines and 2 compare fairly.

## D251 — Income is an estimate: (cups − token cups) × the price set, else the "AED n" in the name, else AED 10 (TASK-070) [verified — tests; prices believed, A-T70.1, A-T70.3]
Televend's sales list carries no amount (VF82), so every income figure says "estimated" and how its price was found (set, name,
default). "card" in the name marks a card-only machine (A-T70.2). Replaced by Televend's amounts when the API key arrives (082).

## D252 — The Analytics portal, for whoever reads Televend's data (TASK-070) [verified — typecheck, tests]
`#analytics` (Machines) and `#analytics/categories`, for televend.read (CEO, Admin, Ops Head, Supervisor). Charts per the data-viz
method: above / about / below the average is a diverging scale — the accent blue, the base gray, and a new orange token
(`--color-mark-below`, validated in both themes 19 Oct) — and every tier is also said in words; category bars are one series in one
hue with the fleet line; categories' days are small multiples, not a 9-colour legend (the categorical palette stops at 8). Figures
reload when the range changes, after a correction, or on Refresh — not on every live update (whole days do not change by the minute).

## D253 — The analytics store: per machine record and Dubai day, built only from checked days, replayable (TASK-071) [verified — tests, live]
Migration 0038: `sales_day` (cups by payment — cash, cashless, cashless 3, token, wallet, other — first and last sale, and the
machine's Televend name and region at the day's last sale), `sales_hour`, `analytics_run` (each build: the sales read, the newest
stored, the cups and machines written, Televend's own count and whether they agree), `tv_day_total` (Televend's fleet count per day for
the months its sales list no longer holds). A day is built only when a daily check or a backfill read it to its end and matched
Televend's count; building it again replaces its rows in one transaction and keeps the earlier run. The input is measured inside
Postgres (G202). The worker builds it every hour (at most 31 days a run); `pnpm analytics:store` builds by hand; `/health` reports the
newest day built and any day that differs or failed. Each sale carries the machine's name and region at that moment, so a machine that
moved is counted where it stood (asset 796 has had four Televend records). No personal data — no card ids, no people.

## D254 — Televend's expected cash goes only to cash.read — in Operations too (independent review, 20 Oct) [verified — tests]
D237 kept Televend's "should have found" from anyone without cash.read, but the Operations reads (TASK-059, built before D237) gave it to
every televend.read holder — so a Supervisor, who handles cash (cash.hold) without cash.read, saw "AED 140 cash waiting" before a
collection. Now `seesExpectedCash(viewer)` gates it everywhere it leaves the server: the fleet (each machine's and the total cash waiting),
a machine's collections (old machine panel and the machine page), the day report (each collection and the total), and the morning
message (two texts: with the figure for cash.read holders, "N cash collections logged in Televend" for the rest). The screens hide the
"Cash in the machines" tile and show collections' times only. Honestly, what stays: a televend.read holder still sees every sale's payment
type (Recent sales, Sales by hour, Analytics' cash share), so a Supervisor who wants to can count cash sales since a collection. The
server no longer hands them the figure; a strict blind count for Supervisors needs FreshNow's choice — take cash.hold from the
Supervisor role (Supervisors then do not collect), or hide payment types from them. Recommended: if Supervisors do not collect cash in
practice, remove cash.hold from the role (open question in TASK-061's page).

## D255 — The words on a cash check stay on the shift: never in the audit trail, never quoted in a notice (review, 20 Oct) [verified — tests]
The auditor's question and the person's answer were copied into audit_log (kept for good) and into the notices' text (the outbox), where
the retention sweep and erasure never reach — breaking the notice's promise that those words go with the person's other words. The audit
rows now record only that a note was written (`hasNote`), the notices say "open Cash to read it", and the words live only on the shift
row, aged and erased with the person's other words — as the stock module already did (D234).

## D256 — A visit belongs to the shift the clock is in; a stop keeps what was visited; proof is one visit's (review, 20 Oct) [verified — tests]
- Which stop a visit carries out: the plans of the shift being worked come first — by the handovers (APP_SHIFT_HANDOVERS, 07:30 and
  15:00, A-T58.4): before 07:30 last night's, then the day, from 15:00 tonight's — then a stop nobody visited, then plan order. "Unvisited
  first" over the whole round had sent a second visit at 02:00 to tomorrow night's plan made in advance. Off-plan visits are listed under
  the day of their shift, once.
- A visited stop keeps its machine, also when taken off and sent again — refused in core and by a trigger (migration 0039); the stop a visit
  picks is locked (FOR SHARE) until the visit is in, so a planner's save and a visit cannot cross.
- A photo or video proves one visit and must be sent after it began (5 minutes allowed; the phone's start time when it queued offline,
  at most 12 h earlier). The same for cash: one photo, one cash entry.
- A fill or a cash entry at a visit is posted on its ledger and linked to the visit in one transaction (`opts.within`), or not at all.
- A plan's note and a stop's instructions keep their author (`note_by`, `instructions_by`, migration 0039), copies too; erasure and the
  person's download follow the author, not the plan's creator. A planner ending someone's visit writes no words on it.
- Copying a day says which plans it left out and why; a plan cannot be renamed to a name its shift already has.

## D257 — Analytics reads the store, compares day for day, and counts FreshNow's machines (review, 20 Oct) [verified — tests]
Rewritten on the TASK-071 store (sales_day): a day counts only when its latest build is good and agrees with Televend's own count (an
incremental read, or a day whose check failed, is "not read" — yesterday arrives after its morning check). A change compares only days read
on both sides — each day with the same weekday `shiftDays` earlier — from the totals (never from rounded rates); the page says how many
days were compared. Each Televend record's sales count for the FreshNow machine it stood in that day (the placement in force at the day's
end; a record's first placement reaches back to its first sale, its last forward; a record never placed counts by its number; one with
no number stays itself): a machine re-registered in Televend is one machine, one switched off keeps its category and price, a record
moved between machines is split at the move. Machines switched off since count in "before" (a sentence names them). Ranks and the tier
lines come from the server; "% of the average" is cut down to the whole %, so it never crosses its tier's line. Per-machine calls
(day by day, correct the category) name FreshNow's machine id — two machines can share their current Televend record.

## D258 — Income: cash cups at the cash price, card cups at the price in the name (supersedes D251's formula) [believed — VF89; A-T70.3 replaced]
Estimated income = cash cups × the cash price (set on the machine, else the default AED 10) + the other paid cups × the card price (the
"AED n" in the machine's Televend name, else the cash price); token cups are not paid. The machine page (TASK-072) already priced this
way; Analytics now agrees with it. Evidence: cash collected at machines named "AED 12" came in tens (VF89). Replaced by Televend's own
amounts when the API key arrives (082).

## D259 — Stock: the database's clock under the item lock; figures hidden from counters everywhere (review, 20 Oct) [verified — tests]
- A move's time (`stock_move.posted_at`, now `clock_timestamp()`, migration 0040) and a count's start, hand-in and recount are the
  database's clock, read under the item lock, and compared in SQL — so "was it corrected after it was counted?" follows the lock's order,
  and no time loses its microseconds in JavaScript (G213).
- On a partly accepted handover only the item still on its way is in transit for a count. A reversal stops a decision only when what it
  undoes was posted by the count's moment. An item's unit stays while the warehouse is being counted.
- Someone counting, who took a recount, or who may take one waiting gets stock notices without figures, and a refusal for asking too
  much names no number (D236 extended to the push channel and the refusals).
- A photo on a stock document is seen by whoever may read the document (migration 0040's app_media_on_stock_doc, mirroring
  stock_doc_select). The document's machine is named for every reader of the document (service role, for documents already visible).
- Someone who left, or whose role no longer holds stock, is offered for "Take back" only; movers who hold stock can write off their own.

## D260 — Alarms: open is open until now; old problems re-read; a failing window waits its turn (review of the 059 fixes, 20 Oct) [verified — tests]
The day report measures an alarm still open to the time the report is made (one from 23:45 still open in the morning needed someone).
The open-alarm re-check also reads, at any age, an alarm behind a problem still open; one window that fails every run goes to the back of
the queue and the others are read — the run still ends in an error naming it. An info alarm's repeat never holds a problem open. A
problem closed because its record was switched off releases its still-open alarms (machine_alarm.released_at, migration 0041), so the
record switched back on raises them again.

## D261 — A role that does not lead people cannot keep reports; escalation skips a "manager" who cannot (review, 20 Oct) [verified — tests]
updateOrg refuses moving someone people report to into a role without data.read_all or people.view_reports ("move them to another
manager first"); the escalation's manager rung takes the raiser's manager only while active and in a role that leads people. Acknowledging
already went by capability (canAssignTo).

## D262 — Media uploads: two at a time, each storage call with a deadline; a missing bucket is an outage (review, 20 Oct) [verified — tests]
An upload writes the file to Storage inside the bytes' lock, in a transaction on the API's pool of five connections; `mediaStoreSemaphore`
lets two run at once (queue 50) and each storage write and read has a deadline (60 s, 30 s). Reading, only a missing OBJECT is
"no such file"; anything naming the bucket raises.

## D263 — The independent review of 20 Oct: two passes, a skeptic for every finding; one choice left to FreshNow [verified — tests, browser checks]
The review owed for TASK-057, the TASK-059 and TASK-060 fixes, TASK-061 (Cash, Route) and TASK-070 ran once the usage limit reset. For
each area read-only reviewers looked for defects, and a skeptic tried to refute each finding before it counted: 57 raised, 53 confirmed,
4 refuted. All 53 were fixed with tests (D254–D262; migrations 0039–0041). A second pass checked every fix — 33 fixed, 17 partly fixed,
3 fixed but breaking something — and raised 25 problems, 24 confirmed by their skeptics. 23 are fixed, most with a test (the few screen
or script changes without one are named on the task pages); 1 is FreshNow's choice: a Supervisor can still count a machine's cash sales
from the sales list (D254, A-T61.14). Each task page has an "Independent review, 20 Oct" section. Lesson kept: 20 of the 53 first fixes
needed a second look, so a fix gets its own review, not only a re-run of its test.

## D264 — Orange tracking is built inside the platform as the warehouse tasks of the TASK-055 plan (TASK-085) [believed — proposal, awaiting management decision]
Receiving, sorting, crates, weigh-and-load, trips and machine delivery are proposed as modules on the existing Postgres, RLS,
audit log, alarm engine and staff app, on top of the Televend mirror and machine registry of TASK-056. Adopting OpenWMS.org,
Odoo Community, ERPNext, OpenBoxes, InvenTree or GreaterWMS was rejected: each is a second system of record (ERPNext a second
database engine — MariaDB; OpenWMS a Java/RabbitMQ/Kubernetes stack for automated warehouses). Their data models are borrowed:
Manhattan's LPN, ASN, reason codes, cycle counts and perpetual inventory transactions; Odoo's double-entry moves through virtual
locations; ERPNext's quality-inspection gate; OpenBoxes' lot, expiry and FEFO. Deck: `docs/reports/warehouse-traceability-deck.html`.

## D265 — Recommended capture: weigh at the tailgate; cameras are evidence, not the record (TASK-085) [believed — proposal]
Option 1b puts the networked scale at the van door: the van is scanned once, each crate once, so weighing and loading are one
record and there is no waiting area where fruit can be taken. Two zones (Option 1) need a numbered seal per crate. Computer vision
reads plates at the gate and bookmarks video per scan; reading crate numbers by camera misses hidden crates silently, so it is an
audit layer only. Face recognition of staff or drivers is not proposed (biometric data; disproportionate).

## D266 — Devices reach the platform over HTTPS (REST); MCP is never in a device's data path (TASK-085) [believed — reasoning from CLAUDE.md rule 2]
Affordable scales speak RS232/USB; a serial-to-network bridge with an HTTP client (USR-W610 class) or a Raspberry Pi gateway
posts stable readings to the API with a device key. MCP lets an AI assistant call tools; placing it between a scale and the record
would put a model in the data path. MCP stays where the local build put it (D184): read-only tools over computed totals.

## D267 — Weights in whole grams; one ledger row per movement (TASK-085) [believed — design, not built]
Integer grams avoid rounding drift in totals; every movement of fruit is one append-only row (from, to, grams, who, when,
evidence), with virtual places for garbage, charity, staff, sold, cups sold, expected moisture loss and "unexplained".

## D268 — Voice entry prototype: Groq Whisper for speech, fixed rules for fields, a model only for grounded gaps (TASK-085) [verified — 16/16 parser cases, mocked end-to-end run]
`docs/prototypes/voice-crate-capture.html` is a standalone page: the user's Groq key, a 15-second recording cap, Whisper with a
format-biasing prompt, a deterministic parser (number words, decimals, spelled plates), and a model call only for a missing field
whose value must appear in the transcript or it is ignored and flagged. Not for staff data while Groq is the provider (D121).

## D269 — CopilotKit OpenIntelligentUI and OpenDots not adopted (TASK-085) [believed — their GitHub READMEs, 23 Oct 2026]
OpenIntelligentUI (MIT; Next.js + Python FastAPI agent; OpenAI default; Jev router needing a TypeSafe key) would add a runtime,
send data to two more US AI services (against D121) and let model-written UI show numbers no query produced. Borrowed idea: the
assistant picks one of our registered chart components and fills it with SQL rows. OpenDots (MIT, alpha; agents with their own
browser/shell; needs CopilotKit Intelligence) conflicts with "no model decides who or whether" and adds an outside service.

## D270 — Task numbers follow the plan of 19 Oct; other work takes the next number after its range [decided 2026-10-23 — reversible]
The plan reserves 070–084 (074 = alarms that clear themselves, 075 = the business analytics portal). The orange proposal — first
TASK-070, then TASK-074 — is TASK-085, and its assumptions A-T74.x are A-T85.x. The Analytics improvements asked for on 23 Oct are
TASK-075, the plan's own number for that work.

## D271 — Choosing categories recounts everything for them, against their own average (TASK-075) [decided — the user's words, 23 Oct]
"Unselect … expo … the full analysis is shown … without including expo": with a choice, the average, the tiers, the ranks, the
80 % set, the categories and the sentences are all of the chosen categories' machines; `selection.available` still lists every
category for the buttons. An empty choice counts nothing — never every category by accident. The choice travels as one JSON array of
names, because a category's name is free text and no separator is safe.

## D272 — "Last week same day" is always the same weekday 7 days back, for every day (TASK-075) [decided]
Each day of a profile stands beside the same weekday a week earlier with the % difference, whatever the range; the period's own
change still compares the same weekdays whole weeks earlier, over the days read on both sides (D257). Day-over-day is offered only as
an explicit choice on Compare ("yesterday vs the day before").

## D273 — Profiles and comparisons share the performance page's SQL for what a machine is (TASK-075) [verified — 23 TASK-070 tests unchanged, 19 new]
`machineInfo` (record now, number, name, category, set price, live) and `namePrice` are one fragment; `attributedHours` credits an
hour to the machine its day is credited to. A machine is the same machine, in the same category, at the same price, on every page.

## D274 — A comparison's differences are worked out by the server from exact totals (TASK-075) [verified — tests]
B − A and (B − A) ÷ A come from unrounded totals: 16 against 21.33 cups a day is +33.3 % (not the 33.1 % of the rounded 21.3); a
cash move from exact shares is −20.3 points (not the −20.4 of 43.8 and 23.4). The page draws; it does no arithmetic.

## D275 — A and B wear two peer hues; signed changes one neutral hue (TASK-075) [verified — the dataviz validator]
`--color-series-a` / `--color-series-b` (blue/orange, the reference palette's slots 1 and 2): dark ΔE 30.0 colour-blind / 34.2 normal,
light 27.5 / 38.9 against the panel. Never on a chart with the tier scale. The machines that moved are one gray, the sign said by
direction and label. Now-against-before stays the accent/gray emphasis pair.

## D276 — A machine and a category are pages with their own links (TASK-075) [verified — routing tests, browser]
`#analytics/machine/<FreshNow id | tv:<record>>`, `#analytics/category/<name, encoded>` — a "/" in "Hospital / Clinics" never splits
the hash; Back works through them. Also `#analytics/trends` and `#analytics/compare`.

## D277 — The answer sits right under the button that asks for it (TASK-075) [decided — the user: "the answer is below the charts"]
One filter row above everything it scopes (days, then categories); the sentences directly under the key figures; under the tier
buttons the table of the machines first (a card each on a phone), the chart of the same machines after it — a table beside the chart
squeezed the names onto four lines (G228).

## D278 — The proposal's budget separates what the pilot needs from what is optional (TASK-085, 24 Oct) [decided — the user's question]
Core kit, one station and one van: a scale that sends its weight (a data port, read by Chrome over a USB cable, Bluetooth on
Android, or a Wi-Fi bridge only where no laptop stands at the door), the phone or a scanner gun, QR labels, a van re-weigh scale —
AED 580 minimum, AED 1,600–3,211 with a scanner gun and a calibrated 1-gram scale. Cameras, ANPR, installer and GPS are a separate,
optional layer bought only if the pilot's numbers show a need. The old AED 12.5K–41K "rollout" mixed both and read as the price of
the pilot. A scale whose weight a person reads and types is not enough: the typed number is the gap a theft hides in.
