# What we need from FreshNow to switch the system from placeholders to real operations

**Status: the platform runs, and almost every number in it is invented.**

That is deliberate and it is flagged everywhere — `[assumed]` in the knowledge base,
`is_synthetic = true` on every seeded row, a DEMO badge in the dashboard. But it means the
escalation ladder currently escalates to a demo employee, "critical" means 15 minutes
because somebody had to pick a number, and "behind schedule" means 30 percentage points
for the same reason.

This document is the list of what only FreshNow can tell us. It is ordered by **what breaks
if we do not get it**, not by how easy it is to answer.

A note on effort, so the list is not daunting: **most of these are data, not code.** Items
marked 🟢 are typed into the dashboard or a table and take effect immediately. Items marked
🔵 need a developer first — those are listed honestly in §7 and in
`docs/FUTURE-PLAN.md`.

---

## 1 · Blocking — the system is actively guessing without these

### 1.1 Who actually resolves what 🟢

Today **every problem, of every kind, is routed to the CEO.** That is a seeded placeholder
(`routing_rule`), and it is the single least realistic thing in the system.

We need a table like this — one row per (kind of problem × where × when):

| Problem category | Site | Shift | Who fixes it | Their backup |
|---|---|---|---|---|
| equipment | Warehouse | any | ? | ? |
| equipment | Van fleet | any | ? | ? |
| quality | Production | any | ? | ? |
| supply | any | any | ? | ? |
| staffing | any | any | ? | ? |
| (your categories, not ours) | | | | |

**Questions:**
- What kinds of problem actually recur? Our five categories (equipment, quality, supply,
  staffing, other) were invented from the business description. What would an operations
  person call them?
- Does the answer change by **site** or by **shift**? (A night-shift chiller fault may go to
  a different person.)
- Who is the backup when the first person is unreachable?

> ⚠️ **One caveat we owe you:** site- and shift-specific rules are not read by the routing
> code yet — it currently only matches on category. That is a one-file change
> (`packages/core/src/routing.ts`) and it is on the plan, but if you give us site-specific
> rules today they would be silently ignored. Give us the table anyway; we will make the
> code read it before loading it.

### 1.2 Response times — what "urgent" actually means 🟢

We seeded these. **None came from FreshNow.**

| Severity | Our placeholder | What should it be? | What happens if it is missed? |
|---|---|---|---|
| Critical | 15 minutes | ? | ? |
| High | 1 hour | ? | ? |
| Medium | 4 hours | ? | ? |
| Low | 24 hours | ? | ? |

**Questions:**
- What is the most urgent thing that can go wrong, and how fast must somebody be on it?
  (Our guess: a chiller failure in a van with stock in it — cold chain, so minutes.)
- Do these windows run around the clock, or only during working hours? **Right now they run
  24/7**, so a 15-minute window that starts at 22:00 breaches at 22:15 and wakes somebody.
  Most operations have business-hours SLAs with an out-of-hours exception list — we need to
  know which this is.
- The UAE working week here is Monday–Friday. Do SLAs pause at the weekend?

### 1.3 The escalation ladder — who gets woken, and when 🟢 / 🔵

Currently: rung 1 goes to the assigned resolver and the raiser's manager; rungs 2 and 3 both
go to the CEO, 30 and 60 minutes later. **Every one of those timings is invented**, and
because everybody reports to the CEO in the seed data, in practice all three rungs are the
same person.

**Questions:**
- If the first person does not acknowledge, who is told second? Third?
- How long should each step wait?
- Is there anything that should go straight to the CEO with no ladder at all?
- Is there an hour after which nobody should be contacted except for a defined list of
  genuine emergencies?

### 1.4 The reporting lines 🟢

This is the highest-leverage single item on the page. The system has a full manager/lead/
employee model with row-level security enforcing it — and **the seed data has everybody
reporting directly to the CEO**, so none of it is exercised.

We need, for every employee: **name · job title · department · site · shift · who they
report to · whether they are a manager, a department lead, or neither.**

That one table switches on: who can assign work to whom, who sees whose data, who is told
when a problem is raised, and the whole middle of the escalation ladder.

### 1.5 Consent, before any more real people are onboarded 🔵

**6 of 7 active employee records have no consent record.** One does (the person onboarded
through the invite flow, which captures it correctly). The rest were created by script.

Under UAE PDPL (Federal Decree-Law No. 45 of 2021) this matters: the platform stores
employee performance data, and unnotified employee monitoring is treated as a legal risk.

**We need:**
- Sign-off on the consent notice wording (we drafted one; it has never been reviewed).
- A decision on who is the data controller contact for a withdrawal request.
- Confirmation that everybody currently in the system has been told, in a language they
  read, what is captured and why.

> The mechanism exists and works. Nothing currently *checks* it before recording an update —
> that is a code change on the plan.

**Added 2026-09-19 — the notice is out of date.** It says updates are "visible to you and the
CEO"; since the org model a manager or department lead also sees their reports' data, and it
does not say that words and voice notes are sent to an AI service outside the UAE. A draft
notice v2 and the reasoning are in `docs/reports/uae-data-residency-and-llm-analysis.html`
§5. Everyone will need to be asked again once the wording and the hosting/AI decisions below
are made. Also needed: **a retention window** (`RETENTION_DAYS`, ≥ 30) — the law says data may
not be kept after its purpose is fulfilled, and the sweep is built and waiting for the number.

---

## 2 · Needed before anyone trusts the numbers

### 2.1 What counts as "behind" 🟢
A task is flagged behind when the elapsed fraction of its time exceeds its reported progress
by **30 percentage points**. Invented. What would make an operations manager say "that one
is in trouble"?

### 2.2 What a status is worth 🟢
Progress is counted from checklist steps where they exist. Where they do not, the status
implies a percentage: open 0%, pending 10%, in progress 50%, done 100%. **The 10% and 50%
are guesses.** What does "pending" mean here — waiting on a part? Waiting on a person?

### 2.3 Project staleness 🟢
A project with no status update for **7 days** is flagged stale. Invented. How often should a
project be reported on?

### 2.4 Working hours and the daily rhythm 🟢
- What time does each shift start and end?
- When should the bot ask for a daily update — and should that differ per shift?
- When should the CEO's end-of-day summary land?
- Which days are non-working, including public holidays?

---

## 3 · Food safety and compliance — the part with legal weight

FreshNow produces and sells fresh juice in Dubai. That puts it under the UAE Food Safety Law
and Dubai Municipality's Food Code, which require **HACCP-based controls with records
available for inspection**, and Dubai Municipality now runs a digital food-safety platform
(DMChecked, which replaced FoodWatch Connect in November 2025) that inspectors check as part
of every visit.

**The platform records none of this today.** Before it can, we need to know:

- **Which critical control points do you already monitor?** (Cold storage ≤ 5 °C, the
  two-stage cooling rule of 60 °C → 5 °C within 6 hours, pasteurisation if any, filling-line
  hygiene?)
- **What do you record now, and on what?** Paper? A spreadsheet? Directly in DMChecked?
- **What are your own action limits** — the temperature or time at which somebody must
  intervene, as distinct from the legal limit?
- **Who is the designated food safety lead**, and who must be told within what time when a
  limit is breached?
- **How long must records be retained?**

> This is the largest single opportunity in the system and we have deliberately not built it
> speculatively. A temperature log that does not match how you are actually inspected is
> worse than no temperature log.

---

## 4 · The vending estate (Phase 4, but the answer shapes earlier work)

- How many machines, and where?
- Who makes them — **Nayax, Vendekin, or another?** This decides everything. If the vendor
  exposes an API we integrate; if not, telemetry is a much larger project. Our standing
  recommendation is to buy, not build.
- What does a machine already report — stock levels, temperature, faults, sales?
- Who currently finds out when a machine is empty or broken, and how?

---

## 5 · Scale and shape, so we size things honestly

- How many employees now, and in 12 months?
- How many sites, vans, and machines?
- Roughly how many problems are raised a day?
- Which languages must be supported? (We support English and Hindi. **Malayalam and Arabic
  are not built.** Arabic was deferred at your request.)
- How many people will use the dashboard at once?

---

## 6 · Where it will run

- **Hostinger has no data centre in the UAE** (their list: France, Germany, Lithuania, UK,
  India, Indonesia, Malaysia, USA, Brazil). Putting the database there makes every employee
  record a permanent cross-border transfer under PDPL Articles 22–23, with no adequacy list to
  rely on. **Please choose a host with a UAE region** — AWS me-central-1, Azure UAE North /
  Central, Oracle Cloud Abu Dhabi/Dubai, or a Dubai VPS — before go-live. Analysis and
  sources: `docs/reports/uae-data-residency-and-llm-analysis.html`.
- **Is Daily Vending LLC a mainland company or a free-zone (DIFC/ADGM) company?** The
  free zones have their own data-protection regimes; the analysis assumes mainland.
- **Do you have a UAE data-protection lawyer** who can confirm the analysis and watch for the
  PDPL Executive Regulations (not issued as of March 2026; a six-month compliance clock starts
  when they are)?
- **AI provider decision:** the same model we use is offered under UAE jurisdiction by Core42
  (G42); OpenAI offers a UAE endpoint by approval. We need sign-off to open an account and a
  signed data-processing agreement from whichever is chosen.
- Which domain will it be served from? **Nothing can be made public without one** — TLS, the
  Telegram webhook, and email all depend on it.
- Who owns DNS for that domain?
- Is there an existing backup arrangement, or do we need one?

---

## 7 · Things that need a developer before your data can be used

Stated plainly so nothing is promised that is not true. If you supply these, they land in a
table and take effect immediately — **except** where noted:

| You give us | Takes effect | Why |
|---|---|---|
| SLA windows per severity | 🟢 immediately | `sla_policy` is a live table |
| Escalation rungs, timings, targets | 🟢 immediately | `escalation_policy` / `_level` / `_target` are live tables |
| Reporting lines, roles, departments | 🟢 immediately | entered in the People tab; RLS follows |
| Project templates, milestones, requirements | 🟢 immediately | fully table-driven |
| "Behind" and staleness thresholds | 🟢 config change | one constant each |
| Routing by **category only** | 🟢 immediately | `routing_rule` is read for category |
| Routing by **site or shift** | 🔵 one-file change | the query currently ignores site and shift |
| **The real CEO being a different person** | 🔵 change in 3 files | a demo CEO id is still hardcoded in the escalation ladder and the audit actor |
| Managers using **Telegram** as managers | 🔵 real work | the bot only knows "CEO" and "employee"; the manager/lead model exists in the database and the web app but not in the bot |
| A public deployment | 🔵 real work | Telegram webhook mode and its secret-token check are not implemented |
| Consent enforcement before capture | 🔵 small change | consent is recorded but nothing checks it |
| Retention and erasure | 🔵 not built | PDPL requires it; currently deferred |

---

## 8 · The single most useful thing you could do first

If only one item on this page is answered, make it **§1.4 — the reporting lines.**

One table of *who reports to whom, and who leads which department* switches on the
permission model, the middle of the escalation ladder, and who is told about what. Almost
everything else on this page is a number; that one is the shape of the company, and the
system is currently pretending it is flat.

---

*Prepared 18 September 2026. Every placeholder named here is also recorded in
`knowledge-base/assumptions.md` with what would confirm or refute it.*
