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

## A-T53.2 — Mail the CEO sends to their own alias carries the `\Sent` label over IMAP [believed — CORRECTED 2026-10-07]
Gmail exposes labels through `X-GM-LABELS`; a self-sent message is in Sent and Inbox. If not, the message still passes on
Authentication-Results (Google signs its own mail) [believed]. Confirm/refute: Act E5. Affects: sender proof in
`email-inbound.ts`.
**Correction (TASK-054, 2026-10-07):** search found Google's own help and several guides saying the opposite — mail you send
to your own alias is filed under **Sent Mail and All Mail, not the Inbox** ("to prevent clutter"). The poller read INBOX only,
so the CEO's email to the `+freshnow` alias would likely never have been seen. The worker now also reads the server's `\Sent`
special-use mailbox (D177); the "in Inbox" half of this entry is withdrawn. Still to confirm on the laptop: Act E5.

## A-T53.3 — Gmail keeps the Message-ID we set [believed]
Gmail is documented to keep a client-supplied Message-ID on SMTP submission. If it replaced it, thread matching would fall back
to the subject key (which is always present). Confirm/refute: look at "Show original" on a FreshNow email. Affects: `findTask`.

## A-T53.4 — Gmail's first Authentication-Results header is from mx.google.com with spf/dkim/dmarc [believed]
Confirm/refute: "Show original" on a reply from Hemanth's account. If the authserv-id differs, set `EMAIL_TRUSTED_AUTHSERV`.
Affects: `readAuthResults`, `authPasses`.

## A-T53.5 — Gmail's vacation reply sets Auto-Submitted [believed]
Confirm/refute: turn on Hemanth's vacation reply and reply to a task. Affects: the automatic-message screen.

## A-T54.1 — Gmail lists "[Gmail]/Sent Mail" with the `\Sent` special-use flag, and a CC'd self-alias copy is there [believed]
Google's IMAP extensions page shows `* LIST (\HasNoChildren \Sent) "/" "[Gmail]/Sent Mail"`. Tested against Dovecot with a
`\Sent` mailbox, not Gmail. Confirm/refute: on the laptop, email Hemanth with the `+freshnow` address in Cc and check Records →
Email shows it as *assigned …*. Affects: `pollInbox` (worker/email-inbox.ts).

## A-T54.2 — A reply "I AGREE" to the emailed notice is valid PDPL consent [assumed — needs a lawyer]
It is a written, specific statement against the full notice text, from an address the receiving server authenticated, recorded
with the notice's hash and `via: "email"`. PDPL asks for "a specific, clear and unambiguous indication… by a statement or by a
clear affirmative action" (secondary sources, through search). A bare "yes" or "ok" is not accepted. Confirm/refute: the
company's lawyer. Affects: `isConsentAgreement`, `consentReply` (email-inbound.ts).

## A-T54.3 — A person the CEO adds is active at once [assumed]
They can be given work immediately; anything but the app inbox waits for their consent (the relay's hold). If the company wants
"added but not yet working" people, that is a new status. Confirm/refute: the CEO. Affects: `addPerson`.

## A-T54.4 — Work given by email should reach the assignee by email as well as their usual channels [assumed]
So their reply to that email lands on the task. Confirm/refute: watch whether staff find two notifications (Telegram + email)
noisy. Affects: `assignFromEmail`.

## A-T55.1 — Portal export times are Asia/Dubai local time [believed]
Every minute-level match between exports and the API's UTC timestamps worked with +04:00, but Televend does not document it.
Confirm/refute: Televend documentation, or an export taken at a known moment. Affects: `parseDubaiLocal` (files.ts).

## A-T55.2 — Refill fill_type 2 means "Removed" and source 3 means "Televend" [assumed]
The CSV shows Removed/Televend rows; the live codes for them were not seen. Until seen, they map to "unknown". Confirm/refute: a
live refill row whose CSV twin says Removed. Affects: REFILL_FILL_TYPE / REFILL_SOURCE (types.ts).

## A-T55.3 — `api.televendcloud.com` is the official API's production gateway [assumed]
Inferred from DNS; only the UAT gateway is documented. Confirm/refute: Televend IT at onboarding. Affects: allowlist HOSTS.

## A-T55.4 — Televend's cash-collection records carry the machine's own cash figures [believed]
The spec's CashCollection has cashIncome, cashLeftInMachine and denominations; never seen live (403 for this account).
Confirm/refute: the official API's demo mode, or a user with cash-centre view. Affects: expected cash in TASK-062.

## A-T55.5 — Reading Televend through a web user is acceptable under FreshNow's Televend contract [assumed]
No terms of use are published; the bridge uses the web app's own read endpoints, paced. Confirm/refute: FreshNow's Televend
contract or Televend. Removed entirely by the official API.

## A-T56.1 — A 30-minute vend overlap and 60-minute event overlap catch late telemetry [assumed]
Machines that lose connection upload later with original timestamps; anything older than the overlap is caught by the daily check of
yesterday, not by the 10-minute sync. Confirm/refute: compare a day's incremental rows with its daily-check rows over a few weeks.
Affects: VEND_OVERLAP_MS, EVENT_OVERLAP_MS (televend-sync.ts).

## A-T56.2 — Staff names from Televend are personal data FreshNow may process for operations [assumed]
tv_refill.filled_by and names inside `raw` (who filled, who resolved an alarm) are employees' names copied from Televend. Lawful basis,
notice and retention for them are not yet set; erasure cannot target them until Televend users are mapped to employees (TASK-057).
Confirm/refute: the company's lawyer with the notice update (plan §0.7). Affects: tv_refill, tv_event.raw, retention.ts.

## A-T57.1 — A Supervisor's team is their direct reports [assumed]
There are no teams yet (TASK-061). Until then Supervisor and Ops Head see and assign to the people who report to them, like a manager.
Confirm/refute: FreshNow's actual team structure (shift teams × machines). Affects: permissions.ts, app_can_view_employee.

## A-T57.2 — The question box is safe for Admin because Admin already sees everything [believed]
`data.ask` is granted only to roles with `data.read_all` (a test enforces it). The role map found that a crafted SQL identifier may slip
`set_config` past query/guard.ts — not verified; if it can, the asker could change their RLS identity within a read-only statement, which
only matters for a role that does not already see everything. Confirm/refute before granting data.ask to any other role.

## A-T58.1 — Media retention periods [assumed]
Evidence photos 180 days, short videos 30, receipts and invoices 1825 (UAE record-keeping period not verified), chat media 365.
Deletion is off until MEDIA_RETENTION=on. Confirm/refute: FreshNow's data controller. Affects: media.ts, .env.example.

## A-T58.2 — On erasure a person's photos stay, as evidence of the work [assumed]
Erasure anonymises (CLAUDE.md); the photos show machines, stock and receipts, so they are kept and point at the anonymised row.
If a photo shows a person, it is not found automatically. Confirm/refute: the company's lawyer with notice v3. Affects:
retention.ts (eraseEmployee), media_object.

## A-T58.3 — The laptop's load numbers say little about the VPS [assumed]
Measured on an Intel Core Ultra 5 125H (18 logical cores, 16 GB, Windows 11, Node 22.19) with Postgres on the same machine. The VPS
has 8 shared vCPU that Postgres competes for. Confirm/refute: `pnpm live:load` on the VPS (TASK-064) before raising either limit.
Affects: LIVE_MAX_STREAMS, LIVE_MAX_STREAMS_PER_PERSON (D209).

## A-T58.4 — Shifts hand over at 07:30 and 15:00 [assumed]
Read from the WhatsApp lists (a night shift's list posted at 07:12; night ≈ 15:00 → 07:30). A company phone's session ends at the
next handover at least 2 h away, plus 30 min. Confirm/refute: FreshNow's shift times. Affects: APP_SHIFT_HANDOVERS (.env),
device-auth.ts companySessionEnd.

## A-T58.5 — Televend's servers are outside the UAE [assumed]
INTIS d.o.o. is Croatian; its API addresses resolve to AWS ranges, region not published (compliance/processors.json). Notice 3.0
says "not yet confirmed: take it that they are outside the UAE". Confirm/refute: Televend, with the data processing agreement.
Affects: consent.ts, processors.json.

## A-T58.6 — A content-free FCM wake-up delivers the app's notifications reliably [believed]
Firebase's Android message-priority page (updated 2026-10-15): several seconds in onMessageReceived; an expedited WorkManager job
for the fetch; deprioritised if wake-ups do not lead to user-facing notifications (D213). Not tried on a phone. Confirm/refute:
TASK-063 on a real Android phone, Doze and battery saver included. Affects: D213, notice 3.0.

## A-T62.1 — A cash vend is AED 10 on every machine, whatever its name says [assumed]
18 of 29 reported collections equal Televend's cash vends × 10 exactly (VF75), including machines named "AED 12" (789: 11 vends,
AED 110) — so the name's price is not the cash price. Confirm/refute: FreshNow's price list per machine (cash and card).
Affects: the cash reconciliation (TASK-062).

## A-T58.7 — Notice 3.0's cash and stock lines describe what the app will record [assumed]
Named now so staff are asked once (plan §0.7), before field operations exist (TASK-061, TASK-065). If what is recorded turns out
different, the notice changes first. Affects: consent.ts.

## A-T60.1 — "LALA" on the delivery photo is the orange variety, and 17.15 kg a carton's weight [assumed]
Read from the Warehouse group, 16 Oct ("159 / 17.15 kg / LALA" with an FVC International citrus carton on a scale) — possibly
Lane Late. Confirm/refute: the warehouse keeper. Affects: inv_lot (variety, carton weight) in TASK-060.

## A-T61.1 — Part Cash on the machine counter is reset before the photo is taken [assumed]
Every counter photo shows Part Cash 0.00 while Part Cashless carries the period's card sales (G190). Confirm/refute: a VMO or
Oranfresh (what "ENTER = PARTIAL RESET" resets, and when the cash part resets). Affects: the cash design (TASK-061/062).

## A-T61.2 — The cash-deposit machine's operator is not always the person depositing [assumed]
David's 860 (his own list, 16 Oct) went in under operator "NOEL" (operator 4); Yakup's under his own name (operator 47).
Confirm/refute: how FreshNow's CDM operator accounts are assigned. Affects: matching deposits to drivers (TASK-061/062).


## A-T60.2 — The units of the warehouse list's items [assumed]
The WhatsApp list says "1 box" for 5-dirham cups, "1 gallon" for handwash and "Salt box" — the rest are numbers only. Assumed:
sleeved cups in packs, sealer in pieces, glass bottles in cartons (half steps), garbage bags in rolls (half steps), straws in
boxes (half steps), detergents and D1/D4 in cans, engine oil in bottles, oil filter and trolley belt in pieces. Confirm or
correct: the warehouse keeper, in Stock → Items, before the first count (a unit is fixed once an item moves).

## A-T60.3 — 30 minutes before a reminder [assumed]
A handover still waiting after 30 minutes reminds whoever must confirm it; 30 minutes after stock goes out with no count since,
the keepers are asked to count (INVENTORY_HANDOVER_REMIND_MINUTES, INVENTORY_COUNT_REMIND_MINUTES; 0 switches each off).
Confirm: the Ops Head — how long a team stays at the warehouse after it is given stock.

## A-T60.4 — One warehouse [assumed]
Every count, delivery and hand-out is the one "Warehouse". Confirm: is there a second store (a site cold room, a van that stays
loaded overnight)? A second warehouse is a new place, not a change.

## A-T60.5 — "Shorting 🍊" on the list is oranges set aside at sorting [assumed]
Seeded as "Sorting oranges", in cartons. Confirm: the warehouse keeper — sorting waste, small fruit, or oranges waiting to be
sorted? Damaged oranges are recorded with the reason "sorted out" either way.

## A-T60.6 — D1 and D4 are cleaning products [assumed]
Listed between the oil filter and the liquid detergent, with no unit. Confirm: the warehouse keeper.

## A-T61.3 — Which cash entries need a photo: collections, expenses and deposits [assumed]
As the CASH COLLECTION group does today (a photo per machine's cash, the fuel receipt, the deposit machine's receipt) and as the
user decided for field work (photos mandatory, 2026-10-15). A test note needs none. Confirm: FreshNow (the Ops Head, the auditor).

## A-T61.4 — Televend's collection is the one within 90 minutes of the entry [assumed]
A collection is matched to the Televend "Cash Collection" event on the same machine nearest the entry's time (the phone's time when
it is within 12 hours of the server's), within 90 minutes; the cash sales since the event before it, times the machine's price
(AED 10 where none is set, D221). If drivers stop recording the collection in the Televend Staff App, nothing matches.

## A-T61.5 — The machines give no change [assumed]
No entry exists for putting change into a machine. A vending guide names change-fund refills as a common cause of over/short.
Confirm: do FreshNow's machines pay out change, and who refills it from what cash?

## A-T61.6 — Cash records are kept at least as long as the tax law asks [assumed]
The notice says "kept as the company's financial record" without a period. Commercial summaries of Federal Decree-Law 47 of 2022
(corporate tax) say seven years after the tax period (one names Article 56). Confirm: FreshNow's accountant.

## A-T61.7 — The sheet's "crates" are an instruction, not a stock figure [assumed]
A stop's crates ("Mina 793 (2 crates)") add up to what the team takes from the warehouse, and the plan says so; what actually goes
into a machine is recorded from the person's stock in the item's own unit (cartons). Whether a crate is a carton is not known.
Confirm: the warehouse keeper — is one crate one carton of the stock list?

## A-T61.8 — The dispenser video is asked only where the planner ticks it [assumed]
Ticking tasks suggests proof (full or half service → normal pic; resort → re-sorting pic; a check, cleaning or other task → other
pic), and the planner changes it. The video is never suggested: the 13 Oct sheet asked for it at some machines only.
Confirm: the Supervisor — which machines need the dispenser video every time?

## A-T61.9 — Last night's plan stays on a driver's round until 12:00 the next day [assumed]
Night shifts run ≈15:00 → ≈07:30 (Kiran's 14/10 list posted 15 Oct 07:12). Until noon gives the end of the shift and the drive back.
Confirm: the Ops Head — when does the latest night shift end?

## A-T61.10 — A team is the people on one plan, made again each day [assumed]
The sheet pairs people differently from day to day ("Team Kiran / Ananthu", "Team Majid"), so there is no standing team table; a
plan names its team. Copying yesterday's plans keeps yesterday's pairs. Confirm: the Supervisor.

## A-T61.11 — The visit is the one person's; a teammate's work at the same machine is their own visit [assumed]
Two people at one machine each start a visit there; the stop shows both. Confirm: the Supervisor — does only one of the pair record?

## A-T61.12 — Televend's refill "belongs" to a visit when it is between 60 minutes before and 120 minutes after the visit began [assumed]
The Staff App entry is often made before the photos, sometimes after the drive. The window is a guess from the refill log's times,
not measured against visits (there are none yet). Revisit after a week of real visits.

## A-T70.1 — A token sale brings no money at the machine [assumed]
Income is estimated as (cups − token cups) × price. Televend lists 777 token sales since 3 Oct. If tokens are sold beforehand (to a
company, say), their income is real but arrives elsewhere. Confirm: the CEO — what is a token, and who pays for it?

## A-T70.2 — "card" in a machine's name means it takes no cash; "Cashless 1 only" / "Cashless 3 only" / "c3 only" do not [believed]
The Expo machines, Sharjah Police, Prime Motor and RTA HQ carry "Card only" or "card"; the nightly lists call two of them "cashless".
Machines named "Cashless 3 only" or "c3 only" had cash collected (Ibn Battuta 395, Rashid 857, Sahara 359 in the 15–17 Oct chats), so
those words name the card reader, not "no cash". Confirm: the Ops Head. The observed cash share per machine is shown beside it either way.

## A-T70.3 — The price in a machine's name is the price of every cup there, whatever the payment [refuted in part, 20 Oct → D258]
"AED15", "AED12", "AED8", "AED5" are read from the names; others use the AED 10 default (D221, A-T62.1). Replaced: cash collected at
machines named "AED 12" came in tens (VF89), so the name's price is taken as the card price and cash is priced at the set price or AED 10
(D258) [believed]. Confirm: the Ops Head — is cash AED 10 at every machine, and the name's price what a card pays?

## A-T70.4 — The thresholds: tiers at 125 % and 75 % of the average; a sharp drop is −40 % from ≥ 10 cups a day; a category move is 15 % [assumed]
The user chose three tiers against the fleet average (D248); the numbers are defaults in `core/analytics.ts`. Confirm or change: the
Ops Head, after a few weeks of use.

## A-T70.5 — "WAREHOUSE-1168" and "Oranfresh-ITALY" are not machines in public [assumed]
Both are enabled in Televend; one is named after the warehouse, the other after the maker and has no asset number. They are counted
until the Ops Head sets them "Not counted" in Analytics. Confirm: the Ops Head.

## A-T61.13 — A visit belongs to the shift the handovers put it in (07:30 and 15:00) [assumed]
Which plan a visit carries out, and under which day an off-plan visit is listed, follow APP_SHIFT_HANDOVERS (A-T58.4): before 07:30 is
last night's shift, then the day shift, from 15:00 the night. A night team still at a machine after 07:30 that is also on the day plan
gets the day plan's stop. Confirm with A-T58.4: FreshNow's real shift times.

## A-T72.1 — "Low on stock" is under 25 % of capacity by Televend's figure [assumed]
The Operations tile and its list use 25 % (`LOW_STOCK` in ops-drill.tsx). Televend's own figure is only as good as the fills logged in the
Staff App (it goes below zero). Confirm: the Ops Head — at what level is a machine sent a refill?

## A-T61.14 — Supervisors collect cash (they hold cash.hold) [assumed — to confirm]
The role table of TASK-061 gave Supervisors cash.hold. With D254 they no longer see Televend's expected figure, but they still see every
sale's payment type. Confirm: does a Supervisor ever collect cash? If not, take cash.hold from the role (D254).

## A-T85.1 — Handoffs are not weighed and signed into a system today [assumed]
Confirm/refute: the warehouse team describes how stock, sorting and loading are recorded now. Affects: the pilot baseline and slide 4 of the deck.

## A-T85.2 — 24 crates per van; crates weigh 5–30 kg filled [assumed]
Used only for arithmetic (49 vs 25 scans) and the station's plausibility check. Confirm/refute: dispatch lead and the crate specification.

## A-T85.3 — One orange ≈ 131 g; moisture loss 0.5–1.3 % a day at ambient temperature [assumed]
USDA "medium" orange via a secondary source; three storage studies under different conditions. Confirm/refute: weigh 20 of
FreshNow's oranges; weigh control crates twice a day during the pilot. Affects: the theft-detection tolerance (deck slide 15).

## A-T85.4 — Alarm thresholds (2 % short delivery, 48 h ageing, 1.5 days of cover, +5 points yield, 15 min for unexplained loss) [assumed]
Placeholders so the design can be discussed. Confirm/refute: management sets each threshold and owner (deck decision 5).

## A-T85.5 — SIRA rules: licensed installer, approved devices, 31-day retention, 4 MP minimum [assumed — installers' guides only]
Confirm/refute: SIRA's own published requirements or a SIRA-licensed installer's written statement before buying cameras.

## A-T75.1 — A day's change under 5 % is noise: said, not coloured [assumed — the trend sentence's rule reused]
Confirm/refute: ask the Ops Head which day-to-same-weekday move they would act on.

## A-T75.2 — Wallet and "other" payments are paid at the card price [assumed — extends A-T70.3]
The income estimate counts every paid cup that is not cash at the price in the machine's name. Confirm/refute: Televend's amounts
(API key) or FreshNow's price list per payment type.

## A-T75.3 — The first 15 machines, then "All", is enough for a first look [assumed]
Confirm/refute: watch the Ops Head use the Overview; raise it if they press "All" every time.
