# What to Ask FreshNow — Before Starting the Build

Ordered by whether an answer is needed **before code**, **before Phase 2**, or
**before Phase 3–4**. Nothing here is a research question you could answer yourself —
every item is something only the company knows.

**How to use this:** send Block A first, on its own. It is eleven questions and should
take one conversation. Do not send all sixty at once; you will get a slow, partial
reply and lose two weeks. Block B goes out once the pilot is running. Block C goes out
when Phase 3 planning starts.

Anything unanswered gets built against a clearly-marked placeholder and logged in
`knowledge-base/assumptions.md` with the question number, so it is visible rather than
silently invented.

---

## Block A — Blocking. Needed before the first line of code.

### People

**A1. How many employees in total, and how do they split by function?**
Warehouse/production, drivers, in-store/retail, maintenance, admin. A rough count per
group is enough.
*Why it blocks:* determines whether the pilot is one department or cross-company, and
whether the schema needs sites and shifts from day one.

**A2. Which languages do staff actually use day to day?**
Not what's on paper — what they type in a WhatsApp group. English, Arabic, Hindi,
Malayalam, Urdu, Tagalog, mixed?
*Why it blocks:* determines the bot's interface languages and the parser's few-shot
examples. Getting this wrong makes the system unusable for the people it's for.

**A3. What are the shift patterns?**
Start and end times per group, and whether the working week is Monday–Friday with a
half-day Friday.
*Why it blocks:* the daily prompt fires per employee at shift start. A prompt at the
wrong hour is ignored, and ignored prompts kill the project.

**A4. Who are the first 5–10 volunteers, and which department?**
*Why it blocks:* a single-department pilot is far easier to make succeed than a
cross-company one. We need names and their manager.

**A5. Does everyone already have Telegram installed and use it?**
If a group uses WhatsApp exclusively, say so now.
*Why it blocks:* the entire channel choice rests on this.

### Work

**A6. What does a normal day look like for a warehouse operator and for a driver?**
Ten real examples of tasks, in their own words. Not a job description — actual daily
items.
*Why it blocks:* the task taxonomy, the categories, and the recurring-task templates
all come from this.

**A7. What kinds of things go wrong that stop someone working?**
Six to ten real examples from the last month. Equipment, supply, staffing, quality,
logistics, IT — whatever actually happens.
*Why it blocks:* these become the blocker categories, and the categories drive routing.

**A8. For each of those, who fixes it — first person, and who if they're unavailable?**
*Why it blocks:* this is the routing table. It is the heart of the escalation engine
and it cannot be guessed.

**A9. How fast does each kind of problem need a response?**
Rough is fine: "chiller down needs someone within the hour," "packaging shortage can
wait until next shift."
*Why it blocks:* these are the SLA windows that arm the escalation timers.

### CEO

**A10. Does the CEO want alerts in Telegram, or only in the dashboard?**
And for which severities? Everything, or only high and critical?
*Why it blocks:* changes the notification design and the alert-fatigue threshold.

**A11. Is the CEO willing to approve each message the system sends on his behalf?**
The design requires a human tap before any message goes out under his name. Confirm he
accepts that friction.
*Why it blocks:* it's a governance requirement we won't remove, so he should agree to
it now rather than be surprised.

### Legal

**A12. Which legal entity, and is it mainland Dubai or a free zone (DIFC / ADGM)?**
*Why it blocks:* determines whether federal PDPL or a free-zone data-protection regime
applies, which changes the consent notice wording.

**A13. Who signs off on the employee privacy notice?**
We will draft it; someone at FreshNow must approve and issue it.
*Why it blocks:* employees cannot be onboarded without it.

---

## Block B — Needed before Phase 2 (in-platform task assignment)

**B1. How are tasks assigned today?** Verbally, WhatsApp group, printed sheet,
spreadsheet, nothing formal?

**B2. Which tasks recur, and on what schedule?** Daily opening checks, weekly
deep-clean, monthly stock count — with the actual cadence.

**B3. Who is allowed to assign work to whom?** Can any manager assign to any employee,
or only within their department?

**B4. Are there existing SLAs with site owners or customers?** e.g. "machine restocked
within 48 hours of a low-stock report." If they exist, in writing or by habit, we
should encode them.

**B5. What does the CEO look at today to know how operations are going?** A report, a
WhatsApp group, a walk around the warehouse? Whatever it is, the dashboard should
replace or beat it.

**B6. Are there existing tools we should read from or write to?** Accounting software,
a POS, a spreadsheet everyone uses, an existing WhatsApp group we're replacing.

**B7. What should happen when an employee doesn't respond for two days?** Manager
notified, CEO notified, nothing? This is a policy question, not a technical one.

**B8. Photo evidence — is it wanted?** Delivery proof, equipment faults, completed
setups. It affects storage sizing and retention.

---

## Block C — Needed before Phase 3–4 (warehouse, telemetry, forecasting)

### Warehouse, production, R&D

**C1. How are production batches tracked today?** Paper, spreadsheet, nothing? Is
there a batch code format already in use?

**C2. What QC checks are performed, and at what points?** Parameters, thresholds,
who performs them, what happens on a fail.

**C3. What is the shelf life of each product, and how is expiry currently managed?**

**C4. What is the current Dubai Municipality compliance position?** Is the facility
registered on DMChecked? Is there a documented HACCP plan and a certified Person-in-
Charge? Are cold-chain temperature logs kept, and how?

**C5. What does R&D actually log today?** Experiments, formulations, tasting notes,
outcomes — and where it lives now.

**C6. What is the current spoilage/waste rate?** Even a rough figure. This is the
baseline the forecasting work will be judged against, and without it we cannot prove
value later.

### Vending fleet

**C7. How many machines, of which makes and models, and how old?**

**C8. Is any telemetry already installed?** Nayax, Cantaloupe, Parlevel, Vendekin, or
none? If yes, we want API access rather than re-instrumenting.

**C9. Do the machines support DEX (EVA-DTS) and MDB, or are they legacy units?**

**C10. What is the connectivity situation at each site?** Cellular, WiFi, or none.

**C11. Is there transaction-level sales history?** Per machine, per product, per
timestamp — how far back, and in what format (CSV, database, vendor portal export)?
*This is the single most important item in Block C. Everything in Phase 4 depends on
it, and it is common to discover mid-project that the data is incomplete or unusable.*

**C12. How are restock routes planned today?** Manually, by habit, by spreadsheet, by
software?

**C13. How many service vehicles, and what is the daily route pattern?**

### Delivery and retail

**C14. How do home-delivery orders arrive today?** Which platform, and does it expose
an API or an export?

**C15. How many in-store points, and do they have a POS that can be read from?**

### Cost baselines — needed to prove ROI later

**C16. Cost per service visit** (labour + fuel + vehicle), even approximate.
**C17. Cost of a stockout** — lost sale value, and any site-owner penalty.
**C18. Monthly spoilage cost.**
**C19. Hours per week currently spent on manual coordination and status-chasing.**

*Without these four numbers, the project cannot demonstrate financial impact later.
Ask for them early even though they aren't needed to build. Rough estimates from
whoever owns the P&L are fine — precision matters less than having a baseline recorded
before anything changes.*

---

## Three things to tell them, not ask

**1. Employees will be told they're being monitored.** This is a legal requirement
under UAE data-protection law, not a choice. A one-page notice goes out at onboarding
and consent is recorded. Covert monitoring is a real legal risk and we won't build it.

**2. The system will not score or rank individual employees.** It tracks process
metrics — how many blockers, of what kind, how long to resolve. It does not produce
performance scores, sentiment analysis, or league tables. This is a deliberate design
boundary; it keeps the tool useful and out of grievance territory.

**3. Phase 1 success is measured by response rate, not features.** If employees stop
replying, no amount of AI fixes it. The first four weeks are about whether the workflow
fits how people actually work. Expect to change the questions and the timing based on
what the pilot shows.

---

## Suggested message for Block A

> We're starting the operations system. Before we write any code we need eleven things
> that only you can answer — everything else we can research ourselves. Most are a
> sentence each; A6, A7 and A8 need a bit more thought and are the most important.
>
> If any answer is "we don't really have a fixed way of doing that," say so — that's
> useful information, not a problem. We'd rather build for how things actually work
> than for how they're supposed to.
