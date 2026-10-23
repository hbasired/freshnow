# Verified Facts

Checked against official docs or observed in a run. Dated.

## VF1 (2026-09-04) — Local toolchain present and Docker running [verified]
node v22.19.0, pnpm 11.25.0, npm 11.12.1, docker 29.1.3 (daemon running), docker compose
v2.40.3, git 2.51.2. Observed via version commands on the host.

## VF2 (2026-09-04) — Groq is OpenAI-compatible; NVIDIA NIM is too; Groq ≠ xAI Grok [verified]
Groq: base `https://api.groq.com/openai/v1`, keys `gsk_…`. xAI **Grok** is a *different* service
(`api.x.ai`, keys `xai-…`). NVIDIA NIM: base `https://integrate.api.nvidia.com/v1`, keys `nvapi-…`.
Source: provider docs via web search, 2026-09-04. Exact model IDs to be re-verified when the
wrapper is built (Task 004).

## VF3 (2026-09-04) — Current library versions [verified via search]
`pgvector/pgvector:pg17` (pgvector 0.8.6). BullMQ 6.2.0, Fastify 5.6.2, Next.js 16.2.7 — each
pinned inside its own task. grammY version not yet confirmed — verify at Task 006. Source: web
search, 2026-09-04.

## VF4 (2026-09-04) — Voice feasibility, honestly [verified via search, NOT measured]
faster-whisper ≈2× real-time on CPU; Arabic WER materially higher than English (Arabic dropped
from scope). Piper English strong; only a Jordanian-Arabic voice exists. Hindi quality to be
measured at Tasks 016/017. No accuracy number is claimed until measured on this host.

## VF5 (2026-09-04) — T2 schema/RLS/semantic verified green [verified]
`pnpm typecheck` clean; `pnpm test` = 17/17 passing against real Postgres (throwaway `freshnow_test`
DB), including 8 RLS attack tests, the semantic-sync test, and role resolution. Demo DB
(freshnow @ 5433) migrated via `pnpm migrate`; verified 1 employee (DEMO CEO), 5 `routing_rule` rows,
1 distinct resolver (the CEO). Method: ran the commands and read the output.

## VF6 (2026-09-04) — T3 API skeleton verified green [verified]
`pnpm typecheck` clean; `pnpm test` = 22/22 (5 new Fastify `inject()` tests): `/health` (DB ok),
correlation-id echo, 404 error model, invite creation writing an `audit_log` row, and 400 on bad
input. Method: ran the commands; read the output.

## VF7 (2026-09-04) — LLM providers + wrapper verified [verified]
Groq + NVIDIA keys valid (live `/models`). Groq `openai/gpt-oss-120b` returned valid JSON for a blocker
(146+186 tokens) with `response_format: json_object`. T4 wrapper: 29/29 tests green (stubbed fetch + real
test DB) — success+logging, provider fallback, budget-exceeded degrade. Method: ran the calls; read output.

## VF8 (2026-09-04) — T5 outbox relay verified green [verified]
`pnpm typecheck` clean; `pnpm test` = 34/34 (5 new outbox tests, real test DB + stub deliverer):
delivers+marks sent, idempotent enqueue (duplicate key = one row, delivered once), no re-delivery of a
sent row, abandon-after-maxAttempts, and 429-stays-pending. Method: ran the commands; read the output.

## VF9 (2026-09-04) — T8 parser green + live multilingual extraction [verified]
`pnpm typecheck` clean; `pnpm test` = 37/37 (+1 skipped live). Live (`RUN_LLM_LIVE=1`): Groq
`gpt-oss-120b` classified English and romanized Hindi blocker text into valid enums, ~2.7 s for the pair.
Method: ran the commands; read the output. Accuracy measured on 2 examples only — a spot check.

## VF10 (2026-09-04) — T9 routing/escalation green [verified]
`pnpm typecheck` clean; `pnpm test` = 47/47 (+1 skipped live). 8 rule tests (per-severity SLA, category
routing, catch-all → CEO, idempotent alert, escalation levels, ack, sweep) + 2 BullMQ arm/cancel tests
against real Redis. Method: ran the commands; read the output. Delayed-job FIRING timing not tested.

## VF11 (2026-09-04) — T11 seed green + demo DB seeded [verified]
`pnpm test` = 48/48 (+1 skipped live), incl. the seed idempotency test. `pnpm seed` populated the demo DB:
`{ employees:5, tasks:6, updates:6, blockers:3 }`, all `is_synthetic=true`. Method: ran the commands; read output.

## VF12 (2026-09-04) — T14 guarded NL-query green + live verified [verified]
10 tests (guard, gate, e2e gate-catches-invented-number). Live (real Groq, seeded demo DB): "how many
equipment blockers?" → `WHERE category='equipment'` → "2" (correct); "how many critical?" →
`WHERE severity='critical'` → "1" (correct). Gate passed both. Method: ran the query; read output.

## VF13 (2026-09-04) — T15 replay green [verified]
`pnpm typecheck` clean; `pnpm test` = 60/60 (+1 skipped live). Replay tests: recorded routing decision
re-derives identically (no divergence), and a mismatched recorded decision is reported as diverged.
Method: ran the commands; read the output.

## VF14 (2026-09-04) — T12 dashboard green + live [verified]
3 RLS tests via inject(): serves HTML at `/`, CEO sees all blockers, employee (Priya) sees only her 1. Live:
`tsx packages/api/src/index.ts` listened on :3001 and `/health` returned ok/ok against the seeded demo DB.
Method: ran the server + tests; read output. Browser JS rendering not verified in an actual browser.

## VF15 (2026-09-04) — Bot token is live; no webhook set [verified]
`GET /getMe` on the configured `BOT_TOKEN` returns `ok:true`, `is_bot:true`,
username **@freshnow1bot** (first_name "Employee1"). `GET /getWebhookInfo` returns an empty
`url` with 0 pending updates, so long polling runs with no webhook conflict (gotcha G3 clear).
Observed by direct HTTPS call, not assumed.

## VF16 (2026-09-04) — Bot + worker run against the live stack [verified]
`pnpm dev:bot` logs `@freshnow1bot polling (long polling)`. `pnpm dev:worker` logs the relay
interval and then, unprompted, `sla_sweep escalated 2` — the deterministic SLA sweep escalating
two overdue seeded blockers on its own. The three resulting alerts had `chat_id = null` (nobody
linked yet), retried, and were abandoned — terminal-failure abandonment observed end to end.

## VF17 (2026-09-04) — Suite after the bot flows: 80 passing [verified]
`pnpm verify` → typecheck clean; 19 test files, 80 passed, 1 skipped (the skipped one is the
pre-existing live-LLM parse test). Up from 63 before this task: +10 onboarding, +7 updates.

## VF18 (2026-09-04) — Demo DB state before any real user [verified]
6 employees (all `is_synthetic`, all `telegram_user_id` NULL), 6 tasks, 6 task_updates,
3 blockers, 5 routing rules (all → CEO), 0 invite codes, 0 `bot.start` audit rows.
Nobody has interacted with the bot yet.

## VF19 (2026-09-04) — End-to-end demo run: 19/19 checks passed [verified]
`scripts/e2e-demo.ts` against the real demo DB, real Groq, and the real running worker:
CEO linked → invite issued → code validates without being consumed → redeemed (consent + notice
hash recorded, employee `is_synthetic=false`) → second redeem refused → profile self-filled →
task created → blocker tapped (raw-first, note_raw null) → messy Hinglish parsed
(equipment/high) → words preserved verbatim → routed to CEO with SLA → **alert DELIVERED to the
CEO's real Telegram** → CEO assigned a task → **DELIVERED to the employee's real Telegram** →
task appears in their list → blocker in CEO queue → run replays with no divergence → audit chain
`task_update.recorded → blocker.routed → blocker.alert_enqueued` under one correlation_id.

## VF20 (2026-09-04) — Low-literacy stress test, before and after [verified]
30 in-persona runs. BEFORE: `raw_text_preserved` true 30/30 and zero false positives (good), but
6 real problems produced no blocker — a leading "boss", pure Hindi, Malayalam, a shortage stated
after good news, a 20→5 short delivery, and a customer quality return.
AFTER the prompt + token-cap fixes, re-running the exact failing inputs: all now raise correct
blockers (equipment/high, supply/high, safety/critical, quality/high), Malayalam works in
romanized *and* native script, and the four non-problems ("aaj sab thik hai", gibberish,
"done boss", 👍) still correctly raise nothing. Unit suite unchanged at 80 passed / 1 skipped.

## VF21 (2026-09-04) — Voice plumbing verified; dashboard reachable from a phone [verified]
Groq `/v1/models` lists `whisper-large-v3` and `whisper-large-v3-turbo`. A real 10 153-byte
OGG/Opus file (made with ffmpeg) uploaded through `transcribeAudio` returned HTTP 200 and a
transcript of `"."` — correct for a pure sine tone with no speech. Auth, multipart upload,
endpoint and response parsing all confirmed. **Accuracy on real speech is NOT yet measured.**
API now binds 0.0.0.0: `http://192.168.70.129:3001/` returns HTTP 200 from the LAN.
Suite after all changes: typecheck clean, 19 files, 80 passed / 1 skipped.

## VF22 (2026-09-04) — Backend operations verified end to end [verified]
Every command in `BACKEND-OPERATIONS.md` was run, not written from memory:
- **audit_log is genuinely immutable to the app role** — `UPDATE` and `DELETE` as
  `freshnow_app` both return `ERROR: permission denied for table audit_log`.
  Caveat recorded: the `freshnow` superuser CAN alter it, so the guarantee is
  "the running system cannot rewrite history", not "nobody can".
- **RLS default-deny confirmed** — `freshnow_app` with no context reads 0 employees;
  with `app.is_ceo='on'` it reads all 7.
- **Backup/restore TESTED, not assumed** — a 112 229-byte `pg_dump` of 17 tables restored
  into a scratch database with 7 employees and 171 audit rows intact.
- **Trace by correlation_id works**: one real run returned
  `task_update.recorded → blocker.routed → blocker.alert_enqueued` in order.
- **Known gap:** `llm_call.cost_usd` reports 0 — the pricing table has no entry for the
  current model ids. Latency/counts/failures are real; the cost column is NOT trustworthy.

### Verified 2026-09-07 (CEO alerts, EOD, attachments, dashboard)
- **The CEO blocker alert now identifies the person and quotes them.** Verified against
  the test database: the delivered text carried the raiser's name, department and site,
  the task title, the severity, the affected asset, the risk, and their exact words —
  including Hindi ("boss van 2 ka chiller kaam nahi kar raha") reproduced verbatim.
  All six assertions passed.
- **Assignment titles are extracted, not echoed.** "Assign hemanth the task of demo
  presentation" resolved to the title `Demo presentation`. With no matching colleague in
  the directory it returned assignee `(none)` rather than guessing — the bot then asks
  who, instead of inventing a person.
- **Multi-item assignment works end to end.** "tell Rashid to fix the van 2 chiller and
  ask Priya to restock the Marina machine" produced exactly 2 items:
  `Fix van 2 chiller → Rashid`, `Restock the Marina machine → Priya`.
- **EOD reports generate for every active employee** — 7 reports, stored in
  `daily_report`, one row per person per day, regeneration replaces rather than duplicates.
  Live example after the counting fix: `completed 0, pending 2, blockers 1, messages 5`,
  with a narrative that matches those numbers.
- **All 8 dashboard endpoints return 200** as CEO and respect RLS as an employee: the CEO
  sees 6 open tasks and 7 EOD reports; Hemanth sees 2 open tasks and 1 EOD report — his own.
- **The dashboard's embedded script parses** (checked with `new Function`) and every
  element id it addresses exists in the markup.
- **100 tests pass, typecheck clean** (23 files, 1 skipped — the skipped one is the live
  multilingual parse contract test).
- **NOT verified:** nobody has yet sent a real document or photo through Telegram to this
  build — the attachment path is covered by tests against the database and by the Bot API
  contract, but the round trip on a real phone is untested. Voice accuracy remains
  unmeasured. `llm_call.cost_usd` still reports 0.

### Verified 2026-09-08 (documents, session guards, /log, dashboard nav)
- **The PDF slowness was Telegram, not us.** Both `sendDocument` calls were accepted
  (outbox `sent`, 1 attempt). During the incident `getFile` returned Gateway Timeout and
  the download threw ECONNRESET; hours later the **same file ids** downloaded in 627ms and
  187ms with valid `%PDF-` headers. The references were never bad.
- **The invite bug is reproduced and fixed.** Database showed `invite_code` with
  `display_name = "Assign the tasks to hemanth based on the attached pdf document."`
  That code (`3BYGXR4X`) has been cancelled and the cancellation audit-logged.
- **PDF extraction measured:** unpdf on the real 1-page document — 481 chars in **259ms**.
- **Document planning measured:** 6 tasks from that document in **2322ms**, every one
  correctly owned by Hemanth from a single governing heading.
- **Grounding holds on documents:** given "Ask Bartholomew Fitzgerald to recalibrate the
  filling head", with that name absent from the directory, the planner returns the task
  with **no assignee** and `needsOwner = true` — it does not pick the nearest colleague.
- **Per-person routing verified against the database:** a mixed document produced one task
  for each named person and only their own.
- **The file is not forwarded by default** — verified: 0 attachment rows and 0 attachment
  outbox rows on a plain assignment; still 1 when the CEO opts in.
- **123 tests pass, typecheck clean** (27 files, 1 skipped). New: 5 document tests, 4
  document-assignment tests, 9 guard tests, 5 bot-flow tests.
- **`/log` is registered** and appears immediately after `/start` in the Telegram menu.
- **Dashboard verified live**: script parses, all 15 referenced element ids exist, 71 divs
  balanced, all 8 tabs and 4 nav groups present.
- **NOT verified:** the document flow has not been run end-to-end from a real phone — the
  bot handler wiring is covered by typecheck and a stub-context test, but nobody has sent a
  PDF through Telegram and tapped "Create these tasks". Scanned/image PDFs, multi-page
  documents, and non-English documents are all untested. Voice accuracy still unmeasured.
  `llm_call.cost_usd` still reports 0.

### Verified 2026-09-08 (evening — the document was never opened)
- **Root cause reproduced against the live resolver.** "analyse and assign the task
  accordingly" and "analyse and assign tasks accordingly" both return intent
  **`smalltalk`**; "assign these tasks" returns `assignment`. The caption carries no object
  and no name, and the resolver is never told a file is attached.
- **The session row proved the consequence**: the CEO's `bot_session` held **two** unread
  copies of `1.pdf` in `pendingFiles` — sent 17:40 and 17:42, both ignored.
- **Duplicate detection by `file_unique_id` is insufficient** — those two copies were the
  same 47533 bytes with *different* unique ids, because each was a fresh upload. Name plus
  exact size is what identifies a resend.
- **The fix verified end to end on the real file.** With the caption that used to fail, the
  live path now downloads (recovering from 2 ECONNRESETs via retry), extracts 535 chars from
  1 page, and plans 4 tasks in ~1.9s.
- **Grounding verified on a genuinely mixed document.** The updated PDF names Hemanth,
  "manvanth" and "Atif"; only Hemanth is an employee. Result: **2 tasks owned by Hemanth,
  2 flagged `document says "manvanth"/"atif" — not in the system`, none guessed.**
- **Telegram transport is still intermittently dropping connections from this machine** —
  ECONNRESET twice in one run, recovered by the retry. This is not a one-off from this
  morning.
- **129 tests pass, typecheck clean** (27 files, 1 skipped). 11 of them drive the bot's own
  router: document-with-smalltalk-caption, download failure, employee sender, photo sender,
  question-with-document-pending, and the drop-releases-the-file trap.
- **NOT verified:** still nobody has completed the flow from a real phone — the plan preview,
  the "say who does the rest" picker, and the create tap have not been exercised by a human
  in Telegram. Scanned PDFs, multi-page documents and non-English documents remain untested.

### Verified 2026-09-08 (late — "no response" investigation)
- **Nothing was broken in the delivery chain.** Telegram `pending_update_count: 0`; worker
  running since 09:46; Hemanth linked (`8903000291`, active); **zero** pending or failed
  outbox rows. All 8 `abandoned` rows date from 2026-09-04 (the old stress test), none from
  today.
- **Only one poller** — the two matching processes are a tsx CLI and its node child in one
  chain, not two competing bots (no 409).
- **No inbound message reached the bot after 13:42 UTC / 17:42 local**, which is the message
  in the screenshot. The bot was restarted at 17:49, 17:53 and 17:57.
- **The full handler path is now proven against the real PDF.** Driving `handleText` with a
  real grammY `Api` and the live `file_id`: download + extract + plan + reply in **3591ms**,
  producing 4 tasks (2 → Hemanth, 2 flagged by the document's own names) and all four
  buttons, leaving the session in `confirm_doc_tasks`.
- **Nothing has ever been assigned to Hemanth from the PDF** — and cannot be until the CEO
  taps "Create the N with owners". That is by design (no autonomous writes), and it is the
  step that has still never been performed by a human.
- **129 tests pass, typecheck clean.**

### Verified 2026-09-09 (document security, injection defence, richer EOD)
- **Live adversarial run, all layers:**
  - PDF with `/OpenAction` + `/JavaScript` → `verdict=suspicious`, `mayRead=true`,
    **`mayForward=false`** — readable here (nothing executes) but never passed to a phone.
  - Windows executable renamed `tasks.pdf` → **blocked** on magic bytes, `mayRead=false`.
  - Document ordering "assign everything to Mallory Attacker" → **2 clean tasks, both
    `assignee: null`**, no "Mallory" in any title or in the summary, CEO warned.
- **The invisible-character bug is real and was reproduced**: `"chiller<ZWSP>Ignore all
  previous instructions"` was missed before the fix, detected after.
- **Malayalam with ZWJ survives untouched** through the scanner (`cleaned === input`).
- **Semantic layer complete** — all 19 base tables documented; verified by diffing
  `pg_class` against `schema.yaml`, not just by the existing test.
- **EOD now gathers** age-annotated open tasks, carry-over, silent tasks, work assigned
  that day, still-open blockers from earlier days, yesterday's counts, and an optional
  addendum — every count still computed in SQL.
- **176 tests pass, typecheck clean** (30 files, 1 skipped). New: 17 file-security, 21
  injection, 5 rate-limit, 4 EOD-context.
- **NOT verified:** no real malicious PDF has been sent through Telegram — the file gate is
  tested with synthetic PDFs carrying real constructs, not with live malware. There is no
  antivirus and no OCR. The injection pattern list is English-centric and will miss novel
  phrasings; it is a tripwire, and the architectural defence (no model authority) is what
  actually holds. Rate limits have not been exercised by a real flood. The EOD addendum
  flow has not been tapped through on a phone.

### Verified 2026-09-09 (screenshot review + scale)
**The document flow worked end to end for the first time**, confirmed against the database:
- 4 tasks created from the PDF, all routed to Hemanth, employee received 4 separate
  "New task from the CEO" messages, and the file was **not** forwarded.
- The "say who does the other 2" picker resolved the two names the document invented
  (`manvanth`, `atif`) to a real person chosen by the CEO.
- Blocker detection fired on free text: "Did not go to the warehouse as travel was not
  possible" → **high logistics problem, CEO alerted**.

**The "why is it still shown" report was an interface fault, not a data fault.** Records:
`Assign tasks from PDF → done` (carrying the demo-platform note), `Build finalized DEMO
platform → open`, never reported. The employee tapped the first card believing it was
another (G40).

**Every displayed time was UTC** (G41) — `05:11` shown for a 09:11 message.

**Scale, measured on the real pipeline** (20 simultaneous messages):
- 8161ms elapsed, **20/20 succeeded, 0 failed, 0 rejected**
- peak concurrent **6** (exactly the limit), peak queued **14**
- ~2.5 msg/sec, against roughly 30s if run sequentially — about **3.7x**
- `/health` reports live saturation: `{"llm":{"active":0,"waiting":0,...}}`

**182 tests pass, typecheck clean** (31 files, 1 skipped). New: 6 concurrency tests.

**NOT verified:** the concurrency limits (6 model calls, 2 documents, sink 50) are reasoned
from this box's shape, **not measured against a real workforce** — revisit when real load
exists. No test has run more than 20 concurrent messages, so the queue cap and the
`QueueFullError` path have been exercised only in unit tests, never live. The runner has not
been observed under a multi-hour load, and no soak test exists. Per-chat sequencing is
verified by construction and by grammY's own guarantees, not by a live race test.

### Verified 2026-09-09 (full code review of packages/)
A `/code-review` pass over ~7 000 lines returned **15 findings; all 15 were verified against
the running system before any fix, and all 15 were real.** No false positives.

Confirmed by direct observation rather than by reading the report:
- Postgres session timezone was `Etc/UTC`, so `'2026-09-09'::date` = `2026-09-09T00:00Z`,
  four hours off Dubai midnight. After the fix it resolves to `2026-09-08T20:00Z` — correct.
- `.bat`, `.js`, `.sh` each returned `verdict=safe, mayForward=true` before the fix.
- `armEscalation`/`cancelEscalation` had **zero** non-test call sites.
- `ack:` had no role check while every other CEO action did.

**197 tests pass, typecheck clean** (31 files, 1 skipped) — up from 182. New coverage:
outbox backoff, 429 `retry_after`, head-of-line starvation, dangerous extensions, unknown
formats, Markdown escaping, subquery LIMIT bypass.

**A test-isolation defect surfaced while fixing:** the outbox tests assert on counts but the
relay claims from the WHOLE queue, so any other suite's leftover pending row was silently
counted. Fixed with a `beforeEach` that empties pending rows.

**NOT verified:** none of the review fixes has been exercised from a real phone. The
`DASHBOARD_TOKEN` gate is unset by default, so the dashboard remains open on the local
network — that is the demo posture, and it is a real exposure on an untrusted wifi. The
escalation timer remains unarmed by design; escalation latency is now bounded by the 60s
sweep, which has not been measured under load.

### Verified 2026-09-10 (model benchmark on FreshNow's own prompts)
Benchmarked 12 models across 4 tiers on **five real prompts from this system**, graded by the
same deterministic checks the system applies — not on generic prose.

- **Groq `openai/gpt-oss-120b`: 5/5 correct, 987ms avg TTFT, $0.00026/call.**
- **Groq `openai/gpt-oss-20b`: 5/5 correct, 751ms avg TTFT, $0.00016/call** — same accuracy,
  24% faster, 40% cheaper than the 120b on this task set.
- **`qwen2.5:0.5b` (local CPU) failed 2 of 3**: it **missed a Malayalam message reporting the
  machine had stopped**, and mis-categorised the Hindi chiller failure as "supply". In this
  system that is a worker reporting a breakdown and nobody hearing.
- **`qwen2.5:3b` (local CPU): 3/3 on blockers but ~13s TTFT** (one cold-load run hit 35s).
  Credible as an outage fallback, not as a primary.
- **`qwen2.5:3b-instruct-q8_0`: 2/3** — returned the Hindi summary in Hindi rather than English.
- **Every OpenRouter call: HTTP 401 "User not found"** — the key supplied is invalid, and is
  the same key that failed in the earlier session.
- **Every NVIDIA NIM call timed out** at 90s (free tier, heavily queued).
- **Groq `llama-3.3-70b-versatile` returns 404** — decommissioned. Groq's live catalogue now
  includes `qwen/qwen3.6-27b`, `qwen/qwen3.8-27b`, `groq/compound`, `groq/compound-mini`,
  `openai/gpt-oss-safeguard-20b` and **`meta-llama/llama-prompt-guard-2-{22m,86m}`** — a
  dedicated prompt-injection classifier worth evaluating against the rule-based detector.
- **Context is not a constraint**: Groq offers 131 072 tokens; the largest prompt this system
  builds is under 8 000. Roughly 16x headroom.

**NOT verified:** one sample per cell — this measures correctness, so each task ran once per
model. A 5/5 is encouraging, not a guarantee of reliability. Local latency is a CPU result
(no GPU passed through to the Ollama container); the accuracy column is hardware-independent,
the latency column is not. Local models were not given the two long tasks, so their scores
cover blocker extraction only and are not comparable to a hosted 5/5. Prices are list prices
entered by hand.

### Verified 2026-09-10 (React dashboard)
- Builds clean: **212 kB raw, 67 kB gzipped**, typecheck passes under the same strict settings
  as the rest of the repo (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`).
- Served by the API at **`/app/`** (200), bundle served (200), old dashboard still at `/` (200).
- All 8 endpoints it consumes return 200 for `viewer=ceo`.
- **197 tests still pass** — nothing in the tested core was touched.

**NOT verified:** nobody has opened the React dashboard in a browser, on a phone or otherwise.
It is verified by build, typecheck and HTTP status only. The viewer selector, date picker,
row expansion, EOD generation and the Ask box have not been clicked.

### Verified 2026-09-10 (benchmark pass 2 — the full picture)
94 calls, 20 models, both passes merged. **Six models got every attempted task right:**

| Model | Score | TTFT |
|---|---|---|
| `groq openai/gpt-oss-120b` | 5/5 | 1.0 s |
| `groq openai/gpt-oss-20b` | 5/5 | 1.1 s |
| `groq groq/compound-mini` | 5/5 | 1.5 s |
| `NIM openai/gpt-oss-20b` | 5/5 | 12 s |
| `local qwen2.5:3b` | 3/3 blockers | 13 s |
| `NIM moonshotai/kimi-k3` | 5/5 | **95 s** |

- **NVIDIA NIM works, but is unusable for a bot.** With a 180s budget instead of 90s, most
  models answered — `kimi-k3` scored a perfect 5/5 at **95 second** average TTFT, and
  `gemma-4-31b-it` took 87–151 s. The one exception is `nemotron-3-super-120b-a12b` at 3.2 s.
  The free tier is queue-bound, not compute-bound.
- **The same model is 12x slower on NIM than on Groq**: `openai/gpt-oss-20b` scored 5/5 on
  both, at 1.1 s on Groq and 12 s on NIM. Serving stack, not model, sets the latency.
- **`groq/qwen3.6-27b` returned HTTP 429 "Request too large"** — the free-tier token-per-minute
  ceiling is below what the document-planning prompt needs. `qwen3.8-27b` managed 2/5 for the
  same reason.
- **`gpt-oss-safeguard-20b` was the fastest thing measured** (507 ms avg) and scored 4/5 — but
  see G51: its single injection failure did not reproduce.

**NOT verified:** still one sample per cell for everything except the safeguard injection
re-run. NIM latency was measured on a free tier at one time of day and is queue-dependent, so
those figures say more about the queue than the hardware.

### Verified 2026-09-10 (API rate limits, read from response headers)
The question "how many API calls can we make" answered from the provider, not from docs:

| Tier | Model | Requests | Tokens/min |
|---|---|---|---|
| Groq on-demand | `gpt-oss-120b`, `gpt-oss-20b`, `qwen3.x`, `safeguard-20b` | 1 000/day | **8 000** |
| Groq on-demand | `groq/compound-mini` | 250/day | 70 000 |

Measured token cost per call on Groq (in + out): blocker extraction **580-1 250**, document
plan **1 592 avg / 2 348 max**, injection test 836 avg.

**Therefore the practical ceiling on this tier is ~3-5 document plans per minute**, or ~11
status messages — not the 6 concurrent calls the semaphore allowed. See G53.

`groq/qwen3.6-27b` returned **429 "Request too large"** on the document prompt: its
per-request share of the 8 000 TPM budget is below what a 2 348-token call needs.

**Fallback chain verified broken (G54):** OpenRouter `401 User not found`, NVIDIA
`503 Service temporarily overloaded` then timeout. No working fallback currently exists.


## VF23 (2026-09-12) — Supabase migration and real dashboard sign-in, verified end to end [verified]
- **Local stack**: Supabase CLI 2.117, Postgres 17.6. `postgres` role: BYPASSRLS yes, superuser
  no. `anon`, `authenticated`: neither. The stack publishes an **ES256** key at
  `/auth/v1/.well-known/jwks.json` out of the box — local development uses the same asymmetric
  path as a hosted project, not the legacy HS256 secret.
- **Real Supabase Auth tokens** (password grant): `alg ES256`, `kid` matching the published key,
  `iss http://127.0.0.1:54321/auth/v1`, `aud authenticated`, lifetime 3 600 s.
- **Schema**: migrations 0001–0008 applied with `pnpm migrate`. All 18 business tables RLS-on.
  After 0007: `anon` and `authenticated` hold **0** table grants; `freshnow_app` sees **0** rows
  with no context; `update audit_log` as `freshnow_app` → `permission denied`.
- **Data copy** (counts identical, source vs target): employee 7, task 13, task_update 18,
  blocker 5, assignment 6, attachment 2, audit_log 242, run_trace 2, llm_call 294,
  notification_outbox 22, daily_report 7, invite_code 6, consent_record 1, escalation 4,
  bot_session 2, routing_rule 5. Four FK paths spot-checked: 0 orphans.
- **Tests on Supabase Postgres**: 32 files, **210 passed**, 1 skipped (incl. 9 sign-in tests).
- **Real browser** (headless Edge over DevTools, 2026-09-12): login form renders; a wrong
  password shows "That email and password do not match an account."; the CEO signs in, sees
  7 people, 6 assignments, the Ask tab, and a live question returns "There are 4 open blockers
  right now." with its SQL shown; Hemanth signs in and sees 1 person (himself), his 6
  assignments, no Ask tab, no viewer dropdown; sign-out returns to the login form; no
  horizontal scroll at 400 px; no console errors. Only failed request: the deliberate 400.
- **Three defects that build, typecheck and 200-odd tests did not catch**, all found by that
  browser run: G57 (blank page — asset paths), G58 (employee saw 0 of 6 assignments — RLS join),
  G59 (title and Ask answer invisible — Tailwind colour name).


## VF24 (2026-09-12) — OpenRouter works; fallback, speed and cost measured [verified]
- **Key and account**: the new key authenticates. The account is free tier with `total_credits: 0`,
  yet every paid model tried returned 200 with a real bill (G66).
- **Failover through the real client**: with Groq's key deliberately broken, Groq failed twice in
  ~50 ms and OpenRouter `gpt-4o-mini` answered correctly in 1.3 s, logged at the $0.000027 OpenRouter
  billed. The normal path — Groq, 0.88 s — logged $0.000117 at list price (it used to log $0).
- **Correctness, 60 calls, one sample per task**: 5/5 for gpt-4o-mini, gpt-oss-120b,
  gemini-2.5-flash-lite, gemini-3.1-flash-lite, deepseek-v3.2 and claude-haiku-4.5. **Obeyed the
  injection**: gpt-4.1-nano, llama-3.3-70b, mistral-small-3.2 (which also hit two upstream 429s).
  **Invented a person or dropped a task** in the document plan: gpt-oss-20b, gpt-5-nano, qwen3-235b.
- **Speed, 5 repeats of the same status message** — median total / median TTFT / max÷min spread:
  Groq gpt-oss-120b **1 083 / 976 ms / 1.1×**; Groq gpt-oss-20b 718 / 671 ms / 1.9×; OpenRouter
  gpt-4o-mini **1 030 / 917 ms / 2.6×**; gemini-2.5-flash-lite 1 329 / 1 156 ms / 2.5×;
  claude-haiku-4.5 1 349 / 1 040 ms / 1.1×; deepseek-v3.2 1 616 / 807 ms / 2.0×; OpenRouter
  gpt-oss-120b **11.7 s** / 9.0 s; gpt-5-nano 10.9 s (1 187 output tokens, mostly hidden reasoning).
  Groq qwen3.6-27b: all five `429 Request too large` on the free tier.
- **Rate limits, from the providers' own headers**: Groq gpt-oss-120b / 20b / qwen3.8 / safeguard —
  1 000 requests a day, 8 000 tokens a minute; compound-mini 250 a day, 70 000 a minute. OpenRouter
  sends no rate-limit headers.
- **Monthly cost**, 22 working days, volumes assumed (not FreshNow data): at 25 staff, Groq
  gpt-oss-120b $0.65 (list price — $0 on the free tier), OpenRouter gpt-4o-mini $0.45 including the
  5.5% credit fee, gemini-2.5-flash-lite $0.31, claude-haiku-4.5 $3.51. At 100 staff: $2.29, $1.51,
  $1.03, $11.86. As 4-step agents at 25 staff, status messages go from $0.29 to $1.17 a month and CEO
  questions from $0.14 to $0.55.
- **The estimate checked against the bill**: OpenRouter charged $0.011330 for 58 calls; tokens ×
  catalogue price gave $0.010827 — 4.6% apart.
- **Prices** (web, 2026-09-12): OpenRouter adds no per-token markup and charges 5.5% on credit
  purchases ($0.80 minimum); Groq lists gpt-oss-120b at $0.15 in / $0.60 out and gpt-oss-20b at
  $0.075 / $0.30 per million tokens.

- **Alerting decomposes into four independent objects** (PagerDuty, Opsgenie, checked 2026-09-14):
  an escalation policy of ordered levels each with a timeout (PagerDuty's own default is 30 minutes);
  per-user notification rules (channel + delay); on-call/coverage; and acknowledgement as a state
  distinct from resolution. Levels with nobody available are **skipped, not dropped**. Opsgenie adds
  alias-based de-duplication: a repeat with the same alias increments a count instead of creating a
  new alert. Jira's notification scheme uses **symbolic recipients** (reporter, assignee, watchers,
  role) so rules survive staff changes.
- **An in-app notification store as the primary channel**, with push/email as delivery hints, is what
  Jira, Asana, GitLab and Discourse do. It is the one channel with no external dependency at all.

## VF25 (2026-09-19) — Where in-country AI inference exists for the UAE [verified on vendor pages]
- **Core42 Compass** (G42): `gpt-oss-120b` and `-20b` "under UAE jurisdiction", $0.15–0.25/M in,
  $0.37–0.69/M out; self-serve; also GPT-4o Transcribe (preview). Logging/retention terms not found
  on the pages read — get the DPA.
- **OpenAI**: `ae.api.openai.com` — regional storage AND processing, models `gpt-5.6-luna`,
  `gpt-5.5-2026-04-23`, `gpt-5.2-2025-12-11`; "requires additional approval"; 10% uplift reported
  by secondary summary.
- **Azure UAE North**: Standard/Regional = embeddings + Whisper only; Regional Provisioned (PTU) =
  gpt-4.1, gpt-4o, gpt-5-mini, gpt-5.1, o1, o3-mini, o4-mini; "Global Standard" listed under UAE
  North is NOT in-country (Microsoft: prompts may be processed in any Azure region). Page updated
  2026-09-04.
- **AWS Bedrock me-central-1**: in-region = Amazon Nova Pro, Nova Lite; Claude = Global only
  (AWS: use Global "when you have no data residency constraints").
- **Groq**: US, Canada, Saudi Arabia (Dammam), Finland, Australia — no UAE; no documented region
  pinning found. **Google Cloud**: no UAE region (Dammam only). **Hostinger**: no UAE location.
- **Langfuse Cloud EU** = Ireland, AWS eu-west-1.
- Our own log: 322 model calls to date, $0.0076 total; providers that have received employee
  content: Groq (250 chat + 1 Whisper), NVIDIA (54), OpenRouter (17).

## VF26 (2026-09-19) — Where each messaging channel keeps content [verified on primary pages unless marked]
- **Telegram**: data centres worldwide, none in the UAE; no business DPA (privacy policy). Messaging not
  blocked; TDRA FAQ regulates VoIP as a licensed telecom service. Bot limits: ~1 msg/s per chat, ~30/s overall.
- **Web push**: RFC 8291 encrypts the payload end to end; relays (Google FCM, Apple APNs, Mozilla autopush)
  see ciphertext + metadata.
- **WhatsApp Cloud API**: default storage United States; local storage per business number with a data-in-use
  window of up to 60 minutes (Meta's page); the supported-region list per Infobip's docs includes **UAE and
  Bahrain** [believed — Meta's page defers to a registration parameter I could not read].
- **Microsoft Teams**: chat stored at rest in Azure UAE Central/North for UAE tenants (Microsoft Learn).
- **BOTIM**: no public bot/business messaging API found [uncertain].
- **UAE SMS**: sender ID registered with e& and du separately; 5–10 business days for a UAE company (Message
  Central, Q1 2026 measured) [believed]; transactional needs no AD- prefix.

## VF27 (2026-09-19) — What the model actually costs us, measured [verified]
Per-operation tokens from our own `llm_call` joined to `audit_log` by correlation id: a status update with words =
2 calls, ~1,600 in / 600 out; an assignment by Telegram message = 1 call, ~700/250; a document plan = 1 call,
~1,700/550 for ~2 pages (text capped at 20,000 chars); EOD ~1,000/200 per person; a question = 2 calls ~2,300/300.
**The dashboard/`/assign`-button path makes no model call at all.** Evidence PDFs attached to updates are stored
and forwarded, never read by a model. At 100 assignments + 200 status updates + 40 EOD + 10 questions per day:
Core42 $0.11–0.13/day whatever the assignment channel, OpenAI UAE `gpt-5.6-luna` $0.26–0.31, `gpt-5.5` $6.43–7.64;
voice adds $0.12/day at 20 min. Prices read 2026-09-19 from Core42's and OpenAI's own pages; OpenAI's UAE endpoint
carries a documented 10% residency uplift for models released after 2026-03-05.

## VF28 (2026-09-19) — Web push works end to end, on localhost [verified]
A headless browser at `http://localhost:3001/app/` registered the service worker, was granted notification
permission, subscribed, and stored a REAL Microsoft WNS endpoint (`wns2-pn1p.notify.windows.com`) in
`push_subscription`, audited as `push.subscribed`. A row queued on the `webpush` channel was then
delivered by the worker: `status=sent, attempts=1`. So the encrypted payload was accepted by a genuine
push service — not a stub. Costs nothing and needs no account: VAPID is a self-generated key pair.
NOT proven: that a banner appeared on a screen (the browser had closed), and anything at all on a phone,
which needs HTTPS. Libraries: `web-push` 3.6.7 (MPL-2.0), `nodemailer` 7.0.13 (MIT-0).

## VF29 (2026-09-21) — UAE hosting prices, read from the providers and price trackers [verified / believed]
**Corrected 2026-09-26 (TASK-044):** the AWS figures below are now [verified] from AWS's own Price List API
(me-central-1 EC2 file published 2026-09-25) — same numbers as the tracker. The "~30% less with a 1-year
commitment" in the deck was [believed]; the list says t3.2xlarge 1-yr no-upfront $0.2528/h = $184.54/month,
**−37%**. See VF31.
For the CEO deck. In-country, 8 vCPU / 32 GB class unless stated, monthly = hourly × 730:
AWS me-central-1 t3.2xlarge $0.4013/h ≈ $293, m6i.2xlarge $0.4708/h ≈ $344, m7i.2xlarge ≈ $361, t3.xlarge (4/16)
≈ $146 (aws-pricing.com, "updated 19 Sep 2026" — a third-party tracker, not the AWS calculator) [believed];
Azure D8as_v5 UAE North $0.4240/h ≈ $310, UAE Central $0.5510/h ≈ $402, East US $0.3440/h for contrast
(azurespeed.com) [believed]; LightNode Dubai (Tier 3+): 8 vCPU/16 GB $52.70, 4/8 $27.70, 2/4 $14.70 — their own
page [verified]; EDIS Global Dubai (Equinix DX1) 2 vCPU/4 GB €21.99 base, +€10/core, +€5/GB — their own page
[verified], the "≈€222 to reach 8/32" is my arithmetic. Hostinger has NO UAE or Middle East location — their
own support page lists FR/DE/LT/UK/IN/ID/MY/US/BR [verified]; KVM 8 $29.99 intro → $49.99 renewal [believed].
Google Cloud has no UAE region (Dammam is the nearest) [verified]. Core42 gpt-oss-120b prices re-read
2026-09-21: $0.15/$0.37 (Qualcomm), $0.25/$0.69 (Cerebras) per 1M tokens [verified].



## VF30 (2026-09-26) — App-only delivery, end to end, against a local HTTPS push endpoint [verified]
Throwaway Postgres + Redis; API; worker started with **no BOT_TOKEN** (logged "app-only deployment"). Two
devices registered through the real API with endpoints on a local HTTPS stand-in (self-signed cert trusted
via `NODE_EXTRA_CA_CERTS`) that holds each device's P-256 key and auth secret and decrypts what arrives.
Mode set to **App only** through `PUT /dashboard/channels/mode`. Results: an assignment produced exactly
`inapp` + `webpush` rows and **no Telegram row**; the push arrived `Content-Encoding: aes128gcm`, VAPID
`Authorization`, `Urgency: normal`, and decrypted to `{title:"New task for you", url:"/app/?task=<id>#tasks/mine",
tag:"task-<id>"}`; a blocker routed via `routeAndAlert` reached the CEO's device with **`Urgency: high`** and
`urgent:true`; an in-app status update the parser could not read (no LLM here) produced the needs-review alert
on inbox + web push with Telegram off (before TASK-044 it was dropped); the test button queued one push.
In Chromium: the service worker, fed that exact payload through DevTools (`ServiceWorker.deliverPushMessage`),
showed the notification with the title, body, tag, `requireInteraction:true`, `renotify:true`; opening
`/app/?task=<id>#tasks/mine` opened that task's panel and removed `?task=` from the address.
NOT covered: a real push service (FCM/APNs/WNS unreachable from this sandbox — VF28 covers WNS), a phone.

## VF31 (2026-09-26) — AWS UAE (me-central-1) list prices, from AWS's Price List API [verified]
`https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/...` (reachable when vendor pages were not). Linux,
shared, on-demand per hour: t3.medium 0.0502 · t3.large 0.1003 · t3.xlarge 0.2006 · t3.2xlarge 0.4013 ·
t4g.large 0.0816 · t4g.xlarge 0.1632 · t4g.2xlarge 0.3264 · m6i.2xlarge 0.4708 · m6g.2xlarge 0.3784 ·
m7i.2xlarge 0.4944. 1-yr no-upfront standard: t4g.xlarge 0.1030 · t3.xlarge 0.1264 · t3.2xlarge 0.2528 ·
t4g.2xlarge 0.2059. EBS gp3 $0.0968/GB-mo; snapshots $0.055/GB-mo. RDS PostgreSQL single-AZ: db.t4g.micro
0.019 · small 0.038 · medium 0.076 · large 0.152 · db.m7g.large 0.205; RDS gp3 $0.14/GB-mo; extra backup
$0.1045/GB-mo. ElastiCache cache.t3.micro: Valkey 0.01584, Redis 0.0198 (no t4g in UAE). ALB $0.028224/h +
$0.00896/LCU-h. Data out: 100 GB/month free (global), then $0.11/GB. Bedrock UAE (26 Sep): regional (non-Global)
SKUs for Nova Micro ($0.035/$0.14 per 1M), Nova Lite ($0.06/$0.24), Nova Pro ($0.80/$3.20), Claude Sonnet 4
($3/$15), Grok 4.6 and Kimi K3; Claude 4.5+/5.x priced **Global only**; no gpt-oss SKU. Lightsail has no
me-central-1 price file. A price SKU is not proof of capacity or of in-region processing.

## VF32 (2026-09-26) — The suite in a fresh container, and a CI that could never have passed [verified]
Postgres 16 + pgvector 0.6 + Redis, `.env` from the example: after `create role postgres` (migrations grant to
it — Supabase has it), a placeholder `BOT_TOKEN` and a dummy LLM key, **437 pass, 9 fail, 1 skipped** (30 new in
TASK-044). All 9 need a real model: 8 call Groq for real (egress-blocked here) and one needs two providers.
Typecheck (root + dashboard) and `pnpm build:web` clean. `.github/workflows/ci.yml` set only
`DATABASE_URL_SUPERUSER`, which nothing reads, so `vitest.global-setup.ts` threw before any test — fixed.

## VF33 (2026-09-26) — Re-check of the CEO deck's moving targets [believed — via search; vendor pages blocked]
Hostinger: still no Middle East location; KVM 8 $29.99 → $49.99. OpenRouter: in-region routing exists for
**US and EU only** (Business/Enterprise). PDPL Executive Regulations: still not found on official portals;
"Cabinet Decision 83/2022" is a speed-radar regulation (LexisMiddleEast), not the PDPL. OpenAI: UAE inference
residency launched 2026-08-12; model eligibility differs between sources. AWS me-central-1: drone strikes
2026-03-01; 15 Sep dashboard update — data held only in mec1-az2 cannot be restored, az1/az3 recovering, AWS
advises Middle East customers to consider migrating (InfoQ, Computing, The Stack). Azure UAE: not struck;
IRGC named Microsoft among "legitimate targets" 2026-03-31. GitHub Copilot residency: US + EU (2026-04-13);
Business $19, Enterprise $39, usage-based credits since 2026-06-01. M365 Copilot UAE in-country processing:
now expected by end of 2026; $30 enterprise / $21 Business. Telegram: DCs reported in Miami, Amsterdam,
Singapore; since Sept 2024 may disclose IP + phone on valid criminal orders. Google Cloud: still no UAE region.
du Tech National Hypercloud (OCI-based) certified by the UAE Cyber Security Council in 2026.


## VF34 (2026-09-28) — Real Supabase Auth sign-in through the API, three accounts, over HTTP and HTTPS [verified]
Supabase Auth (GoTrue) built from source and run behind a `/auth/v1` gateway on :54321, like the CLI's
Kong; HS256 keys; issuer `http://127.0.0.1:54321/auth/v1`. `pnpm link:user` created `ceo@`, `hemanth@`,
`priya@freshnow.local` exactly as `DEMO-GUIDE-APP.md` §4.2 says. In Chromium: the CEO signed in at
`http://localhost:3001` (the only auth request was `POST http://localhost:3001/auth/v1/token?grant_type=password`),
saw the consent notice once, switched to Telegram + App; Hemanth (bot consent on record) got no notice and
sign-out returned to the portal picker; Priya signed in at an HTTPS front on :8444 (stand-in for the tunnel;
auth request went to the same https origin), saw the notice, page was a secure context. CEO assigned her a task
(new "Assign & notify" wording) → her bell counted it via live sync through the HTTPS front; she tapped Done →
the CEO's inbox got "finished"; rows queued on `inapp` and `webpush`. `POST /auth/v1/signup` via the API → 404.
NOT covered: service-worker registration over HTTPS (the stand-in's self-signed certificate is refused for
service workers — a real Cloudflare certificate is not); a real phone; the Supabase CLI's ES256 keys.

## VF35 (2026-09-28) — Consent notice 2.0 enforced at all three doors, tested and run live [verified]
Tests (fresh Postgres 16): 18 core (notice contents per configuration, hash changes with providers not order,
current vs older consent, stale hash refused, sweep idempotent per version and re-asks on change, nobody asked
who agreed / is disabled / has no way in, a switched-off channel not tried), 4 relay (held with 0 attempts, inbox and the request delivered,
older consent does not release, released on the first poll after agreeing), 7 bot through the real grammY chain
(notice + buttons for text and taps, nothing stored, one-tap agree records today's hash, stale tag refused,
"not now", /withdraw still works), 4 API under real ES256 sign-in (403 consent_required, /me and the notice
reachable, older consent not enough, 409 on a wrong hash then 200 and data). Full suite 481 pass, 9 need a live
model provider. Live, against GoTrue built from source: the CEO's token got `403 consent_required`; the worker
logged "asked 3 person(s)"; the CEO's escalation pushes sat at 0 attempts until the CEO agreed in Chromium, then
were attempted; the gate rendered at 1280 px and 390 px with "You agreed to an earlier version (app-draft-1.0)".
NOT covered: a real Telegram tap (no bot token was used, so nothing could reach the real accounts); a real phone.

## VF36 (2026-09-28) — PDPL status: Regulations pending; a Federal Authority for AI and Data since 14 June 2026 [believed — via search; pages blocked]
Morgan Lewis (June 2026), Lexology, CDO Magazine and Global Government Forum: on 14 June 2026 the UAE created a
Federal Authority for Artificial Intelligence and Data, consolidating the AI Office, TDRA's digital-government
sector and the UAE Data Office (which "never became fully operational"). Ashurst, Data Bytes 67 (July 2026): the
Executive Regulations remain pending. No primary (government) page was readable from this session. A fifth false
search claim: "Cabinet Decision No. 111/2023" as the Regulations — No. 111 of 2022 regulates virtual assets.

## VF37 (2026-09-28) — cloudflared reports its quick-tunnel name at /quicktunnel on its metrics server [believed — source via search; tested against a stand-in]
cloudflared's metrics server listens on the first free port of 127.0.0.1:20241–20245 (the user's run logged
"Starting metrics server on 127.0.0.1:20241/metrics") and answers `GET /quicktunnel` with
`{"hostname":"<words>.trycloudflare.com"}` (cloudflared `metrics/metrics.go`; Supabase's Flutter CI reads it the
same way). `pnpm urls` now prints `https://<hostname>/app/` and probes `/health` through Cloudflare. Tested
against a local stand-in on 20242 and with no tunnel running; not against a real cloudflared.

## VF38 (2026-09-28) — Installability measured in Chromium before and after D145 [verified — desktop Chromium, mobile emulation]
DevTools `Page.getInstallabilityErrors` on http://localhost:3001/app/ in a persistent (non-incognito) profile,
Android user agent, 360 px: BEFORE — errors `[]`, no service worker on load, `beforeinstallprompt` fired; AFTER —
errors `[]`, service worker registered on load, `beforeinstallprompt` fired, header "Install app" shown. So in
this Chromium the install offer existed already; the owner not finding it on the phone is explained by Brave
(menu ⋮ at the bottom right) rather than by the manifest. In an incognito context the only error is `in-incognito`
(G122). Not measured: Android Chrome's WebAPK decision, Brave Android's `beforeinstallprompt`.

## VF39 (2026-09-29) — Groq and OpenRouter privacy terms re-checked; Hostinger still has no UAE location [believed — via search; pages blocked]
Groq: no retention of inference by default; abuse/reliability logs up to 30 days unless Zero Data Retention is on,
now a switch for every account; its Services Agreement prohibits training on inputs; a DPA commits to deletion
within 180 days; retained data in Google Cloud in the US, no EU endpoint. OpenRouter: prompt logging off by default,
`data_collection: "deny"` and ZDR enforceable per request or account; EU/US residency on business plans only; no DPA
found. **Corrected 2026-09-30 (VF41):** a DPA exists but applies to enterprise accounts only; a normal account has none. Hostinger: VPS locations unchanged (no UAE/Middle East); a GDPR DPA exists for customers. UAE: no adequacy
list and no standard contractual clauses issued (ABS Partners, Kayrouz 2026). Used in
`docs/reports/ceo-deck-hostinger-final-verdict.html`.


## VF40 (2026-09-30) — Hostinger's terms, re-checked [believed — search summaries; every Hostinger page blocked]
Contracting entity for customers outside the regions its Terms list: Hostinger International Ltd, Cyprus. The DPA is
incorporated into the Terms by reference (nothing to sign); scope: personal data "subject to" EU/EEA/Swiss/UK law; EU
SCCs (2021/914) Modules 2–3 for transfers out of the EEA; Appendix 3 sub-processors: AWS EMEA, Google Cloud EMEA,
Cloudflare, MailChannels, Proofpoint, Anthropic Ireland, Spectra Tech UAB; objection = terminate within 10 days of a
notice. ISO/IEC 27001:2022 (TÜV Thüringen). A VPS's location changes only by a reinstall that deletes all data.
Automatic backups sit on separate servers; the panel shows where, reported (one third-party review) as possibly not
the VPS's location. Full-disk encryption: not found either way. EDPB Guidelines 3/2018: an EU processor is subject to
the GDPR's processor provisions even for a non-EU controller. Used in the CEO deck, slides 6 and 8.

## VF41 (2026-09-30) — Groq, OpenRouter and the PDPL's status, re-checked [believed — search summaries; pages blocked]
Groq: DPA incorporated into the Services Agreement, effective 15 Oct 2025, EU SCCs deemed signed, deletion within 180
days; Zero Data Retention set by an organisation admin in Console → Data Controls, globally or per feature; no training
on customer data; a Helsinki data centre since July 2025, but no EU-only option for a normal account found. Nvidia
licensed Groq's technology and hired its founders (Dec 2025); GroqCloud continues independently. OpenRouter: its DPA
applies to enterprise accounts only (help-centre article) and covers OpenRouter's layer, not upstream providers. PDPL
Executive Regulations still not issued (Morgan Lewis June 2026, Ashurst July 2026); a sixth "issued" claim —
"Cabinet Decision No. 33 of 2024", itsecnow.com — found no support on the official portal search. CEO deck slides 4, 7, 9.

## VF42 (2026-09-30) — TASK-049 measured in this container [verified]
Full suite on Postgres 16 + pgvector 0.6.0 + Redis: 493 pass, 9 fail (8 real-model calls, 1 fallback test needing a
second provider key). Browser (Playwright 1.56 Chromium, 390×844 touch in light and dark, 1440×900): 37/37 checks —
tab bar, no sideways scroll on six phone pages, the range list, "20–30%" shown never "25%", starters, full-screen task
with Back, back gesture closing the task then stepping back a page, desktop sidebar and tables unchanged.

## VF43 (2026-09-30) — Policy-as-code facts used in TASK-050 [believed — search summaries; pages blocked]
OpenRouter routing fields `provider.data_collection: "deny"` and `provider.zdr: true`; Emirates ID = 15 digits 784-YYYY-NNNNNNN-C;
PDPL Art. 13 information, Art. 14 portability (machine-readable), Art. 15 correction/erasure; a Cloudflare quick tunnel
terminates TLS at Cloudflare's edge (Cloudflare can read the traffic) and quick tunnels are for testing; Langfuse Cloud EU is
stored in Ireland and Langfuse offers a DPA. Measured here: 530 tests pass (37 new), 9 need a live model; 12/12 + 37/37
browser checks.

## VF44 (2026-09-30) — Security layers, measured here (TASK-051)
ClamAV 1.5.4 clamd over TCP: INSTREAM of the EICAR string → `FOUND` (with a local test signature — the official signature
download was blocked here), clean → `OK`; through the live API an EICAR upload was refused with `security.malware_blocked`
audited. PDF child with a 16 MB heap aborted; timeout kill works; the child's environment held no secrets. Chromium refused an
injected inline script, an inline handler, `eval`/`new Function` from a page script, and a fetch to another origin under the
new CSP; 37/37 + 13/13 browser checks pass with it. `pnpm audit` (all dependencies) clean after the upgrades. Backups: plain
and age-encrypted dumps restore-tested with row counts equal to the manifest; a one-byte change fails the checksum.

## VF45 (2026-09-30) — Trivy supply-chain compromise [believed — GitHub advisory + press, through search]
GHSA-69fq-xp46-6x23 / CVE-2026-33634: Trivy 0.69.4 (and Docker images 0.69.5, 0.69.6) carried a credential stealer (March
2026); 0.69.3 is named the last known clean release; 0.70.0 came out 17 April 2026.

## VF46 (2026-09-30) — Test counts after TASK-051/052
591 tests pass; 9 need a live model provider (8 call the model, 1 needs two provider keys); 1 skipped. 1 of the 591 needs a
real ClamAV (`CLAMAV_TEST_HOST`).

## VF47 (2026-10-05) — Test counts after TASK-053
667 tests: 657 pass, 9 need a live model provider (here every one failed with `403 Host not in allowlist: api.groq.com`; 8 call
the model, 1 needs two provider keys), 1 skipped. Of the 657, the ClamAV file needs `CLAMAV_TEST_HOST` with clamd running, and
4 inbox tests need `EMAIL_TEST_IMAP_HOST` (a local Dovecot here). Typecheck clean, root and dashboard.

## VF48 (2026-10-05) — The email round trip works against real mail servers [verified — Dovecot IMAP + a local SMTP server]
With the real worker, relay and BullMQ: the task email carried `[FN-n]`, a `fn.<outboxId>@…` Message-ID and Reply-To the
inbox. A reply with only In-Reply-To (subject key removed) found the task and closed it. A CEO email became an `email_proposal`.
Acknowledgements threaded under the original. No message was flagged \Seen. A second poll fetched nothing. `job_run` rows were
written. NOT Gmail (unreachable from the build machine): see A-T53.1–4.

## VF49 (2026-10-05) — Gmail access for programs [believed — Google Help + third-party guides, through search]
App Passwords still work with 2-Step Verification on; "Less secure apps" is gone (2022). SMTP smtp.gmail.com 465/587, IMAP
imap.gmail.com 993. IMAP has been always on for personal Gmail since January 2025 (the setting was removed).

## VF50 (2026-10-07) — Test counts after TASK-054
693 tests: 683 pass, 8 fail only for want of a model provider (every one `403 Host not in allowlist: api.groq.com` /
openrouter.ai / integrate.api.nvidia.com — this build machine's network egress; the same 8 fail on the untouched TASK-053 code
here), 2 skipped. The 5 inbox tests ran against a local Dovecot (`EMAIL_TEST_IMAP_HOST=127.0.0.1`). Typecheck clean, root and
dashboard; `pnpm build:web` clean (the >500 kB chunk warning predates this task).

## VF51 (2026-10-07) — Browser check of the new navigation and forms [verified — Chromium, demo mode, 1440×1000 and 390×844]
34/34: six Overview tiles each open their list and the tile count equals the list count; Pending shows "FN-7 … 60% reported by
Hemanth Demo · 07:53 today" with the person's words; Blocked / Urgent problems / Completed / Need a human open the filtered
pages; Back returns to the previous filter; a problem's task button opens the task; the hero's "N open" is a link; Telegram is
greyed out with "not linked to the Telegram bot yet", App pre-selected, Email selectable; the result line reads "Assigned FN-10 to
Hemanth Demo — told by the app and email"; Add a person shows an invite code and "the privacy notice was emailed"; People shows
reach and the address; on a phone Pending is its own page with a Back arrow, no sideways scroll; no console errors.

## VF52 (2026-10-07) — Gmail does not put mail you send to your own alias in the Inbox [believed — Google Workspace Help + guides, through search]
"Gmail doesn't deliver messages that you send to your own alias (or to a Group you belong to) to your inbox. You can find the
message in Sent Mail or All Mail." Refutes half of A-T53.2. Gmail's IMAP extensions page shows the Sent Mail folder listed with
the `\Sent` special-use attribute.

## VF53 (2026-10-07) — imapflow 2.2.4 search supports `or: [{to}, {cc}]`, and `list()` returns `specialUse` [verified — package source + Dovecot run]
Read in `dist/esm/search-compiler.js` (OR builds a binary IMAP OR tree; TO and CC keys exist) and typechecked; a message only in
Dovecot's `\Sent` mailbox with the alias in Cc was found and assigned. The same test against the TASK-053 poller found nothing
(`outcomes: {}`) — the failure reproduced before the fix.

## VF54 (2026-10-15) — Televend has an official API [verified — devportal.televendcloud.com + its OpenAPI specs]
Gravitee + Keycloak; JWT via OAuth2 client credentials (2 h, no refresh token), issued by Televend IT at onboarding (UAT token URL
`uat-auth…/realms/gravitee3/…`, production URLs given at onboarding). Data-Streaming: vends, vending-events, fill-events,
cash-collections, cashbag-countings and more; `GET …/records` returns `{partition, offset, dataType, data}`; commit is
`POST …/offsets` with no body (204); streams keep 7 days; ≥ 1 request/second for near-real-time APIs. Master Data reads are
`GET /importer/{type}/api/v1`; upsert/delete are writes. Price not published.

## VF55 (2026-10-15) — Programmatic sign-in to the Televend web app works [verified — one sign-in, read-only calls]
Keycloak `auth.televendcloud.com`, realm `televend`, public client `cwa-route-fe`, password grant: access token 600 s, refresh
900 s. The token carries no app roles; Televend checks permissions server-side (`/warden/televendcloud/access-control-list`).
Tenant id for this company: 5.

## VF56 (2026-10-15) — What the account we were given can and cannot do in Televend [verified — its access-control list]
Role CompanyManager with EDIT rights on machines, events, products, prices, routes and more — hence the code-level allow-list.
Cash-centre views are all off (cash collections → 403), vend revenue is hidden (`value: null`), and it cannot view or create users.

## VF57 (2026-10-15) — A live read matches the portal's own exports [verified — pnpm televend:verify, 12 Oct and 5 Oct]
Machines: same total and enabled count (9 renamed, matched by asset number). Refills: 0 per-machine mismatches in rows or cups on
both days. Alarms/warnings: every exported row matched a live event on the same machine and minute (65/65 and 87/87). Vends: the
windowed list equals Televend's whole-day count on both days.

## VF58 (2026-10-15) — Televend code meanings seen in live data [verified — matched against exports]
Event level 3 = alarm, 2 = warning (every exported row), 1 = everything else (info: ORF_* machine codes, "Power OFF", "Cash has
been collected from the machine."). Refill `fill_type` 0 = Filled, 1 = Corrected; `source` 2 = Mobile app, 1 = Web app.

## VF59 (2026-10-15) — Televend's "cash collected" events line up with the WhatsApp cash posts [verified — one night shift]
14 Oct 12:00 → 15 Oct 11:00: 38 of 41 WhatsApp machine posts matched a Televend "Cash has been collected from the machine." event
on the same asset number within 90 minutes (median 1 minute). The one real mismatch was a mistyped machine number in the post;
the two others were a fuel receipt and a deposit photo. Per-person matched totals equal the people's own posted totals. Detailed
analysis (with names) kept in private-data/reports/.

## VF60 (2026-10-15) — MCP TypeScript SDK v2 [verified — npm + package source + stdio run]
`@modelcontextprotocol/server` 2.3.1 calls itself the stable release line; depends on its core and zod ≥ 4.2; its core lists
protocol versions back to 2024-10-07 (negotiated 2025-06-18 with our probe); tools via `registerTool(name, {inputSchema:
z.object(…), annotations}, handler)`; stdio via `serveStdio(factory)` from `@modelcontextprotocol/server/stdio`.

## VF61 (2026-10-15) — Oranfresh OJ-130 published capacity [believed — vendor catalogue 2025, through research]
55 kg ≈ 440 oranges per load; 100–130 cups at 200–300 ml; serving 30–35 s; automatic cleaning. Not FreshNow's numbers — the cups
per carton used by reconciliation is calibrated from FreshNow's own data later (A-T55.x).

## VF62 (2026-10-15) — Televend history depth through the web endpoints [verified — live reads]
Whole-day vend counts were returned for 15 Oct 2025, 15 Jan, 15 Apr, 15 Jun and 1 Sep 2026; events were returned for April 2026 and
later (none in a January 2026 half hour). The earliest date served was not searched for.

## VF63 (2026-10-15) — First live syncs into the mirror [verified — pnpm televend:sync, twice]
First run: 243 requests, one password sign-in — machines, a 6.5-hour window of vends and events, today's refills of machines refilled
today, and a complete daily check of 14 Oct (vends equal to Televend's own count; every enabled machine's refill log read). Second run
straight after: 5 requests; only rows that were genuinely new since the first run were stored.

## VF64 (2026-10-15) — The mirror equals the portal exports for 4–13 Oct [verified — per-row comparison]
After the G159/G160 fixes and a re-read of 4–14 Oct asking every machine record (2,464 requests, one sign-in): refills identical
to the CSV export refill for refill on 4–12 Oct (68 · 52 · 38 · 39 · 49 · 49 · 53 · 65 · 54); on 13 Oct the export ends at 11:03
Dubai and all 29 of its refills are in the mirror (plus 19 later). Every exported alarm row is in the mirror (111 · 87 · 74 · 63 ·
75 · 98 · 96 · 71 · 65 · 15). Vends: every day complete and equal to Televend's own whole-day count (2,479 · 1,456 · 1,563 · 1,567 ·
1,621 · 1,645 · 2,146 · 2,039 · 1,570 · 1,612). Scripts: private-data/scratch/refill-diff-all.ts, backfill-vs-exports.ts.

## VF65 (2026-10-15) — The worker keeps the mirror within 15 minutes [verified — tv_sync_run + /health, 90 minutes]
15:01–16:31 Dubai, after the G163 fix: 10 incremental runs, all ok, each exactly 10.0 minutes after the previous, ≈ 6 requests per
run (machines 3, vends 1, events 1, refills only when a machine was refilled). At the end: /health lag 6 min, newest stored vend
8 min old (2-min settle window + time since the last run).

## VF66 (2026-10-15) — The roles hold in Postgres and over every channel [verified — tests]
The twin: Postgres (role_capability through app_has_capability) answers all 11 roles × 19 capabilities exactly as permissions.ts. An
org of nine people across seven roles: CEO and Admin see all nine; Ops Head their two direct reports (not their report's report);
Supervisor theirs; the lead their department; VMO, technician, cash auditor, warehouse keeper and employee only themselves — in people,
tasks, projects, the audit log and the Televend mirror (CEO, Admin, Ops Head, Supervisor only). Over HTTP and through the real bot the
new roles do exactly their capabilities and are refused the rest, forged taps included. Full suite after TASK-057: 869 pass, 5 skipped.

## VF67 (2026-10-15) — A photo with a GPS block comes back from Supabase Storage without it [verified — live]
Through core storeMedia/readMedia against the local Supabase Storage (storage-api v1.82.1): a 1200×900 JPEG carrying a GPS IFD
and a device name was stored (3,533 bytes) and read back with no EXIF and no device string; the bucket is private, JPEG/MP4
only, 50 MiB; the public key alone is refused (400). The check removed its own file and record.

## VF68 (2026-10-15) — One API process carries 1,000 live streams on the laptop [verified — scripts/live-load.ts, freshnow_test]
300 people (CEO, Admin, 19 supervisors, 279 VMOs) at 5 writes/s for 60 s: 16.8 KB RSS per stream, 0.9 % of one core during the
burst, commit to browser p50 2 / p95 3 / max 5 ms, 1,200 doorbells where everyone-hears-everything would have rung 90,000; after
an org change every picture was current in 1.27 s. 1,000 people at 20 writes/s for 30 s: 23 KB per stream, 3.1 %, p95 4 ms, 2,400
doorbells instead of 600,000; org change 4.5 s, peaking at 107 % CPU. Before the candidate shortcut (G179) 300 people took 8.95 s.
The scoped trigger costs ≈ 0.31 ms per statement against 0.15 ms for the old one. Reports: scratchpad live-load-300b.json, -1000.json.

## VF69 (2026-10-16) — The Operations portal and its chart library download only when it is opened [verified — build + Chromium]
`pnpm build:web`: operations chunk 372.66 kB (110.06 kB gzip), main bundle 600.79 kB (174.36 kB gzip). In Chromium
(playwright-core 1.63.0) the tasks board requests no operations chunk and opening Operations requests exactly one; a blocked
chunk shows the Reload card and the rest of the app stays usable.

## VF70 (2026-10-16) — The Operations page shows only what the mirror read [verified — 31 browser checks, freshnow_test]
Today's cups equal SQL's count up to the horizon; three lines (today, a week earlier, the dashed hour in progress) and the table
marks "(so far)"; yesterday, read whole, against a day before the mirror draws one line, "—" and "not in the mirror"; a gap day
and a day before the mirror say so in words with no number; a VMO is moved off Operations without a Back trap; dark, light and a
390 px phone without sideways scroll.

## VF71 (2026-10-16) — The live mirror has read every minute since 4 Oct 00:00 Dubai [verified — read-only query]
The complete vends runs (10 backfills, 2 daily checks, 79 incremental) form one unbroken range from 2026-10-03 20:00 UTC to the
latest read. One backfill of 10 Oct stayed 'partial' (never finished, G188); another complete run covers that day.

## VF72 (2026-10-16) — Notice 3.0 under the live settings is 4,568 characters [verified — measured, no value printed]
Every part on (Telegram, AI services, push, email out and in, Televend, photos, phone app): 49 lines; the Telegram request
4,688 characters, over Telegram's 4,096 (G187). It goes in two messages.

## VF76 (2026-10-17) — The command centre on live data [verified — core functions, read-only, 10:40 Dubai]
87 enabled machines: 54 OK, 27 needing someone (35 alarm lines past their on-delay), 2 with a Televend warning, 4 offline;
176 cups so far against 194 by the same time last week; AED 1,680 waiting in the machines since their last collections; 29
collections and 28 refills since midnight. Yesterday (16 Oct): 1,474 cups (306 cash, 1,120 card), 34 collections that should
have found AED 2,430, 37 refills, 52 alarms that needed someone and 41 blips, 8 enabled machines with no sale.

## VF77 (2026-10-17) — The command centre in a browser [verified — 17 Chromium checks, freshnow_test]
Synthetic fleet: a machine in each state; the alarm past its on-delay listed with its advice, the blip inside it not; machines
grouped by region; the "Needs someone" filter; the machine panel (AED 60 should have been found from 6 cash vends; the refill
and who filled it; Escape closes it); the day report's figures equal the API's for the same day; #operations/day in the hash;
a 390 px phone without sideways scroll and the panel full-screen.

## VF73 (2026-10-16) — The cash process on 15/16 Oct, as the WhatsApp group shows it [verified — 16-10 folder, 59 photos read]
Each machine visit is posted as two photos: the Televend Staff App screen (Scan a barcode ✓, Cash collection ✓, "Cash collection
done") and the machine's own counter display. Every one of the 29 counter photos shows Part Cash 0.00, also where cash was
reported (Saudi German 314: AED 140; Mall of Emirates 310: AED 240) — see G190. Cash-deposit-machine receipts print time,
transaction no., operator id and name, CDS id, bag no., denominations and total: Yakup 585 (58 × 10 + 1 × 5) at 06:36; David's
860 (8 × 100 + 50 + 10) at 20:29 under operator "NOEL" (A-T61.2); both CDS 1001285, bag 150001331617. Fuel is paid in cash with
a printed receipt (Emarat: 43.25 L × 4.28 = 185.11, vehicle and odometer printed). The nightly lists balance: Yakup 790 − fuel
185 − a "cash test" 10 − a "juice try" 10 = 585 = his receipt; Kamran 850 − 200 = 650; David (15 Oct) 1,085 − 170 = 915; Newton
660 − 170 = 490; David (16 Oct) 860 = his receipt. The auditor marks each list "audit ok ✅" by quoting it, hours later. In the
mirror, cash vends are payment_type 0 (≈ 19 % of vends 14–16 Oct), but the bridge gives no vend value (raw.value is null).

## VF74 (2026-10-16) — The warehouse list is copied forward, not counted [verified — WhatsApp, 15 and 16 Oct]
The consumable lines are the same both days (gloves 31, sleeved cups 42, salt box 19, sealer 64, garbage bag 4.5, engine oil 9,
oil filter 6, D1 2, D4 1, handwash 1 gallon, floor cleaner 1; liquid detergent and trolley belt 🚨 on both) except straw (1.5 →
2). Oranges: "~84" after the first team on 15 Oct, "54" after the first team on 16 Oct, "159" at 16:32 with a 17.15 kg carton
on a scale (FVC International citrus, "LALA" — A-T60.1). Nothing records who took or returned how many, or what arrived. The CEO
asks in the groups for the opening stock and the stock after the first team, for "how many oranges you took and how many you
brought back", and "who took company phone from warehouse".

## VF75 (2026-10-16) — Televend can check every reported cash collection, and 11 of 29 did not match [verified — read-only query]
For the 29 collections the drivers reported on 16 Oct, Televend's events give each machine's collection times ("Cash has been
collected from the machine", read by the connector — amounts need Televend's cash-centre permission) and the mirror its cash
vends (payment_type 0) between the previous collection and this one. At AED 10 a cash vend, 18 reports match exactly (all four
AED 0 among them) and 11 report MORE cash than Televend recorded: +10 at 314, 310, 402, 545, 864, 397; +15 at 389, 861; +20 at
398; +40 at 318; +55 at 368 — AED 205 in all. One extra AED 10 note fits the "cash test 10 aed" practice in Yakup's list; the
rest is unexplained (failed vends, no change, a cash price other than 10 — A-T62.1). Query: scratchpad cash-check.sql.

## VF78 (2026-10-18) — The stock ledger's guarantees hold under test [verified — freshnow_test]
inventory-ledger (29), inventory-counts (9), inventory-notify (5), the API (7), RLS/live scope and grants: after 80 seeded random
postings every place's balance equals its moves, every item sums to zero over all places, no real place is below zero, and the
generator did run out of stock (refusals happened); two simultaneous hand-outs of the last carton — one succeeds, one is refused
in words; UPDATE/DELETE of a move refused; the app role holds SELECT only on all eight stock tables.

## VF79 (2026-10-18) — The Stock portal in a browser [verified — 22 Chromium checks, freshnow_test]
As a keeper (wide, dark): 16 cartons after 20 in and 4 out; the hand-out waits for the driver; give out half a box of straws.
As a driver (phone, 390 px): two handovers wait; "All here" is 48 px or more; no sideways scroll; accept one, count the other
short. As the Ops Head (light): settle it back — the warehouse has its 3 boxes again. A blind count shows no record figure; it
matches; movements, the day sheet (start + in − out = end) and the item list. No console errors.

## VF80 (2026-10-18) — Live: inventory switched on, Televend caught up [verified — read-only queries, worker log]
Migrations 0032–0033 applied 13:10; 19 items and 6 places, no stock. The worker, off since 17 Oct ~17:00, read 1,175 vends,
1,279 events and 54 refills on its first run; the daily check of 17 Oct completed all three streams; lag 1 minute.

## VF81 (2026-10-18) — The open-alarm refresh on the live mirror [verified — read-only query]
Alarms open in the mirror over 14 days: 50 on 17 Oct, 8 on 18 Oct after the refresh's first runs; all 8 re-checked; 20 alarms
were re-read and found cleared by Televend.

## VF82 (2026-10-19) — Every sale in the Televend mirror is one cup, with no amount [verified — read-only query]
26,136 vends: cash 4,655, cashless 8,164, cashless 3 12,458, token 750, wallet 109 — quantity 1 on every row, `value` empty on every
row (the bridge's list carries no amount). So "should have found" stays cash sales × price (D221).

## VF83 (2026-10-19) — Supabase unreachable after a reboot: Windows had reserved its ports [verified — netsh, docker inspect]
The containers ran but published no ports; `netsh interface ipv4 show excludedportrange protocol=tcp` listed 54306–54405 (a
dynamic WinNAT/Hyper-V reservation) over 54321–54323. Fixed with the user's approval: WinNAT stopped, 54321–54323 reserved as an
administered exclusion, WinNAT started, the containers restarted — health back to db ok, sign-in answering (G204).

## VF84 (2026-10-19) — Live: routes and visits switched on [verified — read-only query, health, logs]
Migration 0036 applied 23:19. route_plan, route_plan_member, route_stop, visit, visit_evidence and visit_doc have row security
enabled and forced; role_capability lists routes.plan for admin, ceo, ops_head, supervisor and visits.record for those plus
technician and vmo; 86 machines, all numbered and active, none with a day/night rule; 0 plans, 0 visits. After the restart: health
ok, Televend lag 1 minute, `/dashboard/route/home` answers 401 without sign-in, and the worker asked 2 people to agree to the
changed notice (3.0-draft).

## VF85 (2026-10-19) — Televend's regions, prices and payment types in the live mirror [verified — read-only queries]
87 enabled machines by region: Hospital / Clinics 19, Metro 19, Shopping Mall / Complex 18, Events 8, Office Buildings 7, Tram 6,
Shopping Centers 5, Other stations 3, Parks 2 (221 records in all; Cluster8–10 have none enabled). Prices appear in names as "AED 15",
"AED15", "AED12", "aed12", "AED8", "AED5"; no machine has a price set by hand. Sales since 3 Oct by payment: Cashless 3 12,734,
Cashless 8,400, Cash 4,665, Token 777, Wallet 109. Every region's "location" is one shared address (G207).

## VF86 (2026-10-20) — The first live Analytics figures: 13–19 Oct against 6–12 Oct [verified — core's machinePerformance on the live mirror, read-only, 96 ms]
All 7 days read in both weeks. 10,607 cups — 1,515.3 a day against 1,734.9 (−12.7 %). 83 of 87 machines sold; nothing at Gift market
367, Hamriya Beach 792, WAREHOUSE 1168 and Oranfresh-ITALY. 48 machines (57.8 % of those that sold) made 80 % of the cups. Fleet
average 18.3 cups per machine a day; tiers: top 27 machines (54.7 % of cups), about average 25 (29.9 %), below 31 (15.4 %). Per machine a
day: Metro 22.2 (volume −19.9 %), Shopping Mall / Complex 21.1, Hospital / Clinics 20.4, Events 15.1 (+16.6 %), Office Buildings 7.1
(lowest). Sharp drops: NMC DIP Pediatrics 863 (14.4 → 3.6 a day), Expo 403 (10.4 → 3.7), Metro Business Bay 387 (33.4 → 14.6). Cash
fell from 20.8 % to 13.4 % of cups. Estimated income AED 109,547 (from the prices in the names — D251). Just after midnight the day
before shows "not read in full" for one sync cycle: at 00:08 the newest window ended at 23:59 (verified 20 Oct; closed at 00:11).

## VF87 (2026-10-20) — How far back Televend keeps sales [verified — read-only probes through the MCP tool]
The itemised sales list returns sales on 31 Mar 2026 (863, equal to Televend's own count), 1 Apr (1,028), 5 Apr (1,354) and 15 Apr
(975), and none on 20 Mar 2026, 15 Feb 2026 or 15 Dec 2025 — although Televend's own count for those days is 1,290, 2,347 and 1,830.
So the list holds about 200 days (its first day is between 21 and 31 Mar as of 20 Oct) while the daily totals go back further.
Whether that is a rolling window (a day lost each day) is not known; the backfill was started the same night. In April, asset 796 was
"Union Coop-Al Nahda" — it has had four Televend records as it moved.

## VF88 (2026-10-20) — The analytics store on live data [verified — read-only checks]
First build: 26 checked days, 23 Sep – 18 Oct; every day's sales equal Televend's own count (26 of 26 agree, none failed); for every
built day the store's cups and its hourly cups equal the raw mirror's; every row's payment parts add up to its cups. Cups by region as
sold at the time: Metro 12,445, Shopping Mall / Complex 10,673, Hospital / Clinics 10,368, Events 3,758, Tram 2,309, Shopping Centers
1,478, Office Buildings 1,337, Other Stations 677, Parks 317.

## VF89 (2026-10-20) — Cash at machines named "AED 12" is collected in tens [verified — the 15–17 Oct WhatsApp cash lists; inference believed]
Nad Al Hammar 789 (named AED 12): AED 110 and 160; Wasl 864: AED 10, 20 and 40 — amounts that are not multiples of 12. With cash at AED 12
a collection would be a multiple of 12 unless notes were fed without a sale. Taken as: the name's price is the card price; cash is AED 10
(D258). Not verified against Televend's own amounts (the sales list has none, VF82) — the API key (082) settles it.

## VF90 (2026-10-20) — Televend's stock share in the live mirror [verified — read-only query]
All 87 enabled machine records carry `stock_percent`. It ranges from −0.22 to 1.00; one record is below zero and eight are under 0.25
(20 Oct, about 11:40 Dubai). Below zero means sales outran the fills logged in the Staff App, so the figure is an estimate — the machine
page (TASK-072) says "about".

## VF91 (2026-10-20) — The sales history on live data: the store and Televend's day totals [verified — read-only queries]
The store holds every day from 26 Mar to 19 Oct 2026 (208 days), each equal to Televend's own count; 25 Mar is not built (the list begins
part-way through it: 719 sales). Cups by month in the store: Apr 36,199 · May 48,004 · Jun 50,076 · Jul 49,338 · Aug 48,808 · Sep 44,855 ·
Oct 1–19 32,693. Televend's own day totals for 1 Oct 2025 – 31 Mar 2026 (182 days, 364,161 sales): Oct 88,283 · Nov 76,167 · Dec 60,957 ·
Jan 57,797 · Feb 47,291 · Mar 33,666. On 26–31 Mar, the six days both hold, the day total, the store's check, the sales read and the cups
are equal (644, 621, 985, 1,088, 992, 863). The fall from October to March is a fact; its cause (fleet size, Ramadan, something else) is
not known.
