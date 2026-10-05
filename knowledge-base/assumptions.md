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


## A-T44.1 — The app consent notice says the right things [assumed]
`APP_CONSENT_POLICY_VERSION = "app-draft-1.0"`. Written by the developer from the bot notice plus what changed
(managers see reports' work since T29; push addresses; an AI service reads the words). Not reviewed by
FreshNow or a lawyer, English only.
Confirm/refute: company + counsel sign-off (already listed as "sign off consent notice v2"); native-speaker
Hindi/Malayalam versions. Affects: whether app-only consent is valid under PDPL Art. 6.

## A-T44.2 — 4 vCPU / 16 GB is enough for the stack at ~40 people [assumed]
The CEO deck prices Azure D4as v5 as "right-sized", with D8as v5 (8/32, like-for-like with Hostinger KVM 8)
beside it. Nothing has been load-tested at that size, and self-hosted Supabase adds containers.
Confirm/refute: run the stack on a 4/16 box with the seed and a synthetic end-of-shift burst; watch memory.

## A-T44.3 — Azure UAE North costs ≈ 1.23 × US East for every service [assumed]
Derived from one pair (D8as v5: $0.424 vs $0.344/h, third-party tracker). Applied to disks, PostgreSQL,
Redis, storage and logs in the deck. Other services may carry a different regional premium.
Confirm/refute: the Azure pricing calculator with UAE North selected. Affects: every Azure line in the deck.

## A-T44.4 — Code sent to GitHub Copilot is not a PDPL transfer [believed]
Source code is not personal data; Copilot processing is US/EU (no UAE residency). Holds only while no real
employee data reaches a prompt, file or test. Confirm/refute: counsel. Affects: Copilot recommendation.

## A-T46.1 — Employees' express consent is a valid transfer ground for Telegram and the AI providers [assumed]
Notice 2.0 relies on PDPL Art. 23(1)(b). Open questions: whether consent from an employee is "freely given",
and whether consent may be a condition of using the work tool (today a person who does not agree cannot use the
bot or the dashboard). Confirm/refute: counsel. If refuted, the next step is a "no transfers" mode (app only, no
AI) for people who decline — designed in TASK-046's write-up, not built. Affects: the whole consent design.

## A-T46.2 — "Ask the CEO" is the data-subject contact [assumed]
The notice says so because no data-protection contact has been named (deck action 8). Confirm/refute: FreshNow
names a contact; the notice line changes and everyone is asked again. Affects: notice 2.0 wording.

## A-T46.3 — A message delivered late is better than one never delivered [assumed]
Messages to someone who has not agreed wait in the outbox indefinitely and are sent when they agree — possibly
days later. Confirm/refute: the CEO. Alternative: expire held rows after N hours. Affects: `outbox-relay.ts`.


## A-T49.1 — The starter phrases are the right words for FreshNow's work, and English is enough for now [assumed]
Progress: Started the work · Materials ready · Some of it done · Most of it done · Final checks left · Paused for today.
Problems: Machine not working · Out of oranges / stock · Waiting for parts · No power or water · Vehicle problem · Need
help from someone. Confirm/refute: the CEO and two employees; a native speaker for Hindi, Malayalam, Urdu. Also measure
how the blocker parser classifies each starter (needs a live model). Affects: `components/quick.tsx`.

## A-T49.2 — The midpoint of a range is acceptable for the "behind" flag and project rollups [assumed]
A conservative company might prefer the low end. Confirm/refute: the CEO. Affects: `bandMidpoint` in `core/progress.ts`
(one function).

## A-T49.3 — Home, My work, Assign/Projects, Alerts are the four places people go daily on a phone [assumed]
Confirm/refute: which pages are opened most in the first weeks of real use (the audit log does not record page views;
ask). Affects: `phoneTabs` in `App.tsx`.

## A-T51.1 — The pinned scanner and ClamAV image tags exist and are clean [assumed]
gitleaks v8.30.1, osv-scanner v2.6.0, Trivy 0.69.3, clamav/clamav:1.5 — from release notes via search; not pulled here (no
Docker daemon). Confirm/refute: the first `pnpm security:scan` and `docker compose --profile security up -d clamav` on the
laptop; then pin by digest. Affects: `scripts/security-scan.ts`, `docker-compose.yml`.

## A-T51.2 — Telegram re-encodes photos, so a "photo" is not the sender's file [believed]
Why photos are not fetched and scanned on arrival. Confirm/refute: Telegram Bot API documentation on photo processing.
Affects: `gateIncomingDocument` (documents only).

## A-T51.3 — cloudflared passes X-Forwarded-Proto / Cf-Visitor, so HSTS is sent through the tunnel [believed]
Confirm/refute: `curl -sI https://<tunnel>/app/` shows `strict-transport-security`. Affects: HSTS only.

## A-T52.1 — The honorifics this workforce uses [assumed]
mr, mrs, ms, miss, dr, sir, madam, ji, bhai, sahab, saheb, chetta, chechi, anna are dropped from written names. A missing one
only sends a name to "ask", never to the wrong person. Confirm/refute: real messages in the first weeks. Affects:
`people-match.ts`.

## A-T53.1 — Gmail delivers `<address>+freshnow@gmail.com` to the inbox and IMAP SEARCH TO matches it [believed]
Plus addressing is documented Gmail behaviour; that `SEARCH TO` matches the alias was tested on Dovecot only. Confirm/refute:
Act E2 in EMAIL-DEMO-GUIDE.md (a reply appears in Records → Email). Affects: `pollInbox`.

## A-T53.2 — Mail the CEO sends to their own alias carries the `\Sent` label over IMAP [believed]
Gmail exposes labels through `X-GM-LABELS`; a self-sent message is in Sent and Inbox. If not, the message still passes on
Authentication-Results (Google signs its own mail) [believed]. Confirm/refute: Act E5. Affects: sender proof in
`email-inbound.ts`.

## A-T53.3 — Gmail keeps the Message-ID we set [believed]
Gmail is documented to keep a client-supplied Message-ID on SMTP submission. If it replaced it, thread matching would fall back
to the subject key (which is always present). Confirm/refute: look at "Show original" on a FreshNow email. Affects: `findTask`.

## A-T53.4 — Gmail's first Authentication-Results header is from mx.google.com with spf/dkim/dmarc [believed]
Confirm/refute: "Show original" on a reply from Hemanth's account. If the authserv-id differs, set `EMAIL_TRUSTED_AUTHSERV`.
Affects: `readAuthResults`, `authPasses`.

## A-T53.5 — Gmail's vacation reply sets Auto-Submitted [believed]
Confirm/refute: turn on Hemanth's vacation reply and reply to a task. Affects: the automatic-message screen.
