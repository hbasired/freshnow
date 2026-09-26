# Assumptions

Every entry is **[assumed]** until the company confirms it, and names what would confirm/refute
it. NOTHING here is a real company fact; all seeded data is synthetic (`is_synthetic = true`).

## A-T1.1 — Toolchain versions are current and compatible [believed]
Node 22.19.0, pnpm 11.25.0, Docker 29.1.3, `pgvector/pgvector:pg17`, `redis:7-alpine`.
Confirm/refute: `pnpm verify` and `docker compose up` health checks (Task 001 verify step).

## A-T1.2 — Blocker categories, sites, shifts, SLAs are UNKNOWN [assumed]
Company has not supplied A7 (categories), A8 (routing), A9 (SLAs), A1 (headcount), A3 (shifts).
The demo will use synthetic placeholders, marked in code with `// ASSUMED:`.
Confirm/refute: company answers to Block A in `04-QUESTIONS-FOR-COMPANY.md`.

## A-T1.3 — A USD 2/day LLM budget is enough for demo volume [assumed]
Placeholder cap in `.env.example`. Confirm/refute: measure real token spend once the parser
(Tasks 004/008) runs against sample updates.

## A-T2.1 — Schema categories/statuses and degenerate routing are placeholders [assumed]
`blocker.category` values (equipment/supply/staffing/quality), the status enums, and the
"everything → CEO" routing are synthetic. Confirm/refute: company answers A7 (categories),
A8 (routing), A9 (SLAs). Affects: `routing_rule` seed, blocker checks, TASK-009 routing engine.

## A-T4.1 — LLM cost is a $0 placeholder; Hindi extraction unmeasured [assumed]
Free-tier pricing is treated as $0, so the budget cap won't trip in normal demo use. Confirm/refute: real
provider pricing if a paid tier is used. Hindi/Hinglish parse accuracy is unmeasured until the Task 008
contract tests. Affects: `LLM_DAILY_BUDGET_USD` realism, parser quality.

**Update 2026-09-12:** cost is no longer a $0 placeholder. `cost.ts` holds list prices for the configured models and OpenRouter calls log the provider bill (D66). Groq itself is still free tier, so logged Groq costs are what a paid tier would charge.

## A-T11.1 — All seed data (names, roles, sites, shifts, updates, blockers) is invented [assumed]
The 5 `DEMO –` employees and their history do not reflect real FreshNow staff or operations. Every seeded
row is `is_synthetic=true`. Confirm/refute: replace with the company's real anonymised history once shared.
Affects: anything shown on the dashboard / query box until real data arrives.


## A-T25.1 — Dashboard account emails are placeholders [assumed]
The CEO and Hemanth sign in as `ceo@freshnow.local` and `hemanth@freshnow.local`. These are not
real mailboxes, so password reset by email cannot work, and no SMTP is configured anyway.
Confirm/refute: the real addresses once the company agrees to dashboard accounts. Affects:
`pnpm link:user` (re-run with the real address), password recovery.

## A-T25.2 — A hosted Supabase project behaves like the local stack [believed]
Verified only against the local CLI stack. Believed to carry over because a hosted project uses
the same Auth server, publishes its keys at the same path, and issues tokens with
`iss = <project URL>/auth/v1`. Not verified: the Supavisor transaction pooler (excluded
locally), the Data API being on by default, and project-specific key rotation. Affects:
`DATABASE_URL` choice (pooler vs direct), Data API exposure of `public`.

## A-T25.3 — A phone on the same Wi-Fi can reach port 54321 [assumed]
The browser signs in against Supabase Auth directly, so a phone must reach this PC on port
54321 as well as 3001. It answered on the LAN address from this PC; no phone has tried. Windows
Firewall may block it for other devices. Confirm/refute: sign in once from the phone.
Affects: phone sign-in only; the PC browser is unaffected.

## A-T31.1 — The escalation ladder's timings are placeholders [assumed]
Rung 1 fires as soon as the response window runs out, rung 2 thirty minutes later, rung 3 sixty
minutes after that. Nobody at FreshNow has said what their real escalation timings are. They are rows
in `escalation_level`, changeable without a deploy. Confirm/refute: ask what should happen, and after
how long, when a critical blocker is not acknowledged.
Affects: how quickly problems climb to the CEO.

## A-T31.2 — The default ladder is degenerate in the seeded org [assumed]
Rung 1 names the resolver and the raiser's manager; rung 2 and 3 name the CEO. Because `seed.ts` makes
everyone report to the CEO, all three rungs resolve to the same person today. The mechanism is tested
with a real manager in the fixtures, but the live org chart is not yet real, and no employee has
`access_role = 'lead'`, so the `department_lead` target type is unexercised in practice.
Confirm/refute: enter the real reporting lines in the People tab.
Affects: whether escalation reaches anyone other than the CEO.

## A-T32.1 — Nobody has described a real FreshNow project [assumed]
Every project fixture is invented. The shape (purpose -> requirements with acceptance -> weighted
milestones -> tasks -> status log -> risks) follows established practice, but we do not know whether
FreshNow thinks in milestones at all, what they would call their stages, or what they would want a
project's health to mean. Confirm/refute: walk one real initiative through the portal with the CEO.
Affects: whether the plan section matches how they actually work.

## A-T32.2 — The staleness and behind thresholds are placeholders [assumed]
`STALE_PROJECT_DAYS = 7` decides when a project is called stale for having no status update, and the
task board's 30-point gap is reused to flag a project behind. Neither came from the company.
Confirm/refute: ask how often a project should be reported on, and how far behind is worth a flag.
Affects: how noisy the project sweep is.

## A-T32.3 — Project news ignores a person's notification preferences [assumed]
Project alerts (health turning red, a serious issue, the sweeps) write outbox rows directly on
Telegram and the in-app inbox, rather than going through the Phase 4 event catalogue. The reasoning:
somebody who silenced "work assigned to me" has said nothing about project news. The consequence is
that project notifications currently cannot be turned off at all. Confirm/refute: ask whether people
want per-project or per-event control before adding project event types to `notification_pref`.
Affects: notification volume for project members.

## A-T33.1 — The 50-stream cap is a guess [assumed]
`MAX_STREAMS = 50` in `api/routes/events.ts` bounds concurrent SSE connections so a leak of open tabs
cannot exhaust the box's sockets. Nobody has measured what this VPS actually tolerates; 50 is a
sensible-looking number for 8 shared vCPUs. Over the cap the client is told to keep polling, so
exceeding it degrades rather than breaks. Confirm/refute: open 50+ boards and watch memory and CPU.
Affects: how many people can watch a live board at once.

## A-T34.1 — Only one of the seven operations has been traced for real [assumed]
`parse_update` was traced end to end against Langfuse Cloud and read back through their API (correct
name, tags, cost, and a null input proving the privacy default held). The other six operations use the
same `logLlmCall` path so they are believed to work, but none has been seen in the UI, and no real
provider failure has been watched arriving as two generations under one trace.
Confirm/refute: run an EOD generation and an Ask query, then look at the trace list.
Affects: confidence that every operation appears, not just parsing.

## A-T34.2 — Traces go to Langfuse Cloud, not the VPS [verified as the current setup]
`LANGFUSE_BASE_URL=https://cloud.langfuse.com` (EU region), chosen deliberately with the user on
2026-09-14, with the stated intent to move to a self-hosted instance once the VPS is finalised.
Metadata for every model call therefore leaves the machine — model, provider, tokens, cost, latency,
success — but no employee text, because `LANGFUSE_CAPTURE_CONTENT` is unset (D97). Moving it is a
change to one URL and one key pair.
Affects: where LLM metadata is stored, and the PDPL picture if content capture is ever turned on.

## A-T38.1 — The configured CEO Telegram id belongs to the row with the ceo role [assumed — narrowed by T39]
Since TASK-039 the bot honours BOTH: the configured Telegram id is CEO with or without a row, and a
row with `access_role = 'ceo'` is CEO too. So handing the role over on the People tab now makes that
person CEO in Telegram as well. What remains assumed is that the two name the same person; if they do
not, the bot has two CEOs, and nothing checks or prevents it.
Confirm/refute: when the company names its real CEO, set `CEO_TELEGRAM_USER_ID` AND the role for the
same row, then `/whoami` from both accounts.
Affects: how many accounts can assign to anyone, see every blocker and create invites.

## A-T38.2 — Erasure covers the words we knew about [assumed]
`eraseEmployee` redacts `task_update` notes and assignment notes. A person's words in
`project_update.narrative`, `project_issue.description`, `attachment` captions or a `task.details`
they typed are not touched, and their Supabase Auth user is unlinked but not deleted. A data-subject
request today would find those. Not a regression — nothing erased them before — but a known gap.
Affects: PDPL completeness of an erasure.
