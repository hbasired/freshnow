# Fresh Run — the test guide (one phone, two Telegram accounts, one browser)

_Updated 2026-09-19 against the running bot and dashboard. Bot wording below is quoted from
the code; dashboard tabs are the ones that exist today._

**This works on your phone alone.** Telegram lets you hold several accounts and switch
between them. The bot identifies people by **Telegram user id**, so your two accounts are two
different people to the system. Switching accounts is a genuine test, not a shortcut.

| | |
|---|---|
| **Account A — CEO** | id `6051615734` (linked to the `DEMO CEO` row) |
| **Account B — Employee** | your other account (Hemanth, id `8903000291`, is registered right now — see "Reset" to start him fresh) |
| **Bot** | @freshnow1bot |
| **Dashboard** | `pnpm urls` prints the address to use right now (the Wi-Fi IP changes) |

### Do both accounts need to be on the same Wi-Fi?

**No — not for the bot.** Telegram relays every message over the internet; the bot works on
mobile data from anywhere.

**Yes — for the dashboard.** The phone browser talks straight to this PC on ports **3001**
(dashboard) and **54321** (sign-in). Same Wi-Fi, and the firewall rule in `COMMANDS.md` §3.

### How to switch accounts in Telegram
Tap the **☰ menu** (or your avatar) → your accounts are listed → tap the other one.

---

## 0 · Pre-flight (on the PC, 30 seconds)

```bash
pnpm urls                                  # every address, whether each service answers, containers
curl -s http://localhost:3001/health        # {"status":"ok","db":"ok","redis":"ok", ...}
```

If anything is down, start it (`COMMANDS.md` §1): Supabase, then `pnpm start:api`,
`pnpm start:worker`, `pnpm start:bot` — one terminal each, `start:*` never `dev:*`.

Open the dashboard on the PC, sign in as the CEO (password in `CREDENTIALS.local.md`), and
leave it visible: it updates live, no refresh needed.

---

## What you are testing, in order

| # | Loop | Proves |
|---|---|---|
| 1–2 | Invite → register → consent → profile | Onboarding, PDPL consent record |
| 3 | Log a status, raise a problem (text or voice) | Capture, extraction, routing, alerting |
| 4 | CEO acknowledges | Escalation stops, audit records who |
| 5–6 | CEO assigns, employee closes | Outbox delivery, the full loop |
| 7 | Dashboard | Same data, live, access-controlled |
| 8 | A manager in Telegram | Org roles reach the bot |
| 9 | Ask a question | Text-to-SQL with both gates |

---

## 1 · CEO creates the invite  ← *Account A*

Switch to **Account A (CEO)**, open @freshnow1bot. **Send:** `/invite Hemanth`

**Expect:** 🔑 **Invite code for Hemanth** · an 8-character code · "Tap the code above to copy it."

👉 Tap the code to copy it. (Or `/start` → **➕ Create invite code** → send the name.)

*Behind it:* a row in `invite_code`; audit `invite.created`.

## 2 · Switch to Account B and register  ← *Account B*

**a)** `/start` → a welcome with your Telegram id and a button **🔑 I have an invite code**.
**b)** Tap it → *"Please type your invite code and send it."* → paste the code.
**c) Expect the privacy notice** — what is recorded, what is not (no location tracking, no
productivity scoring, no sentiment analysis) — with **✅ I agree**.
**d)** Tap ✅ I agree → *"✅ Thank you, Hemanth. You are now registered."* then the first question.
**e)** Answer the four questions one message at a time:

| Bot asks | Send |
|---|---|
| `1/4 · Which department do you work in?` | `production` |
| `2/4 · What is your role or job title?` | `juice production operator` |
| `3/4 · Which site do you work at?` | `warehouse` |
| `4/4 · Which shift do you work?` | `day` |

**f)** Language: tap **English** (or हिंदी / മലയാളം) → *"Language set to English. ✅"* and the employee menu:
📋 Log daily tasks · ➕ Add a task · 👤 Update my details.

✅ **Dashboard → People**: Hemanth is listed with **no DEMO badge**, Access *Employee*, Reports
to *DEMO CEO*. **Activity** shows `invite.redeemed` (the consent itself is a row in `consent_record`, with the
notice's hash).

## 3 · Log a status and raise a problem  ← *Account B*

**a)** `/start` → **📋 Log daily tasks** → *"You have no open tasks yet."* with **➕ Add a task**.
**b)** Tap **➕ Add a task**, send: `Restock Deira metro machines`
**c)** Tap **📋 Log daily tasks** → the task card with **✅ Done · ⏳ Pending · 🚫 Blocker**.
**d)** Tap **🚫 Blocker** → *"🚫 Recorded as blocked: "Restock Deira metro machines" — What is stopping it?"*
**e)** Reply — type it, **or hold the mic and send a voice note**:
```
van 2 ka chiller thanda nahi ho raha juice kharab ho jayega
```

**Expect:**
> ✅ Saved your words. Checking…
> 🚨 Logged a **high** equipment problem.
> *The chiller on van 2 is not cooling, risking juice spoilage.*
> The CEO has been alerted.

*Behind it:* `task_update` with your exact words in `note_raw` (before the model is called);
`blocker` routed by `routing_rule`; `alert` created (a repeat of the same problem increments
`count` instead of paging again); two `notification_outbox` rows for the CEO — Telegram and
in-app; audit rows all sharing one `correlation_id`; a `run_trace` row with the routing input.

> A voice note takes the same path: the bot first replies *"I heard: …"* so you see the
> transcription before it acts. **Note:** transcription and extraction are currently done by
> AI services outside the UAE — see `docs/reports/uae-data-residency-and-llm-analysis.html`.

## 4 · Switch back to CEO — the alert is waiting  ← *Account A*

**Expect** a message that arrived on its own:
> ⚠️ HIGH · equipment — van 2 chiller
> 👤 Hemanth (production · warehouse)
> 📋 Task: Restock Deira metro machines
> 💬 "van 2 ka chiller thanda nahi ho raha juice kharab ho jayega"
> 📝 The chiller on van 2 is not cooling, risking juice spoilage.
> [ ✅ Acknowledge ]

Your own words come first, the model's paraphrase after — the reader should read the person.

Tap **✅ Acknowledge** → *"✅ Blocker acknowledged — it will no longer escalate."*

Also: `/blockers` lists every open problem with its own Acknowledge button. The dashboard
bell (top right) shows the same alert; **Alerts** tab lists it with who acknowledged and when.

*Behind it:* `blocker.acknowledged` with **your** employee id as actor — never "system".
Only the CEO, the assigned resolver or the raiser's manager can acknowledge; anyone else
tapping a crafted button is refused.

## 5 · CEO assigns work back  ← *Account A*

**Send:** `/assign` → a list of people as buttons → tap **Hemanth**
→ *"What should Hemanth do? Send the task description."* → send:
```
Swap the van 2 chiller unit before the afternoon route
```
**Expect:** *"📌 Assigned to Hemanth. They have been notified in Telegram."*

Or do it from the browser: **Assignments** tab → assign — it lands in the same tables and
reaches the phone by the same outbox.

## 6 · Employee receives it and closes the loop  ← *Account B*

**Expect** an incoming message: *"📌 New task from the CEO: Swap the van 2 chiller unit …"*
Then `/start` → **📋 Log daily tasks** → the new task is in the list → tap **✅ Done** →
*"Anything to add about it? Send it now — or tap /skip."*

That is the full loop: CEO → employee → report → CEO → assign → employee → done. At end of
day, `/eod` on Account B asks "Anything to add before I write your end-of-day report?" and
then writes it; on Account A it writes everyone's.

## 7 · Show it on the dashboard (PC, signed in as the CEO)

| Tab | Point out |
|---|---|
| **Overview** | The greeting, the six status cards (urgent open, open problems, carried over, pending/completed today, need a human), the **last-seven-days chart** (click a column to open that day; the Table button shows the same numbers as text), the **Needs a human** list, and below it the day's board — every number is a SQL count |
| **Alerts** | The alert, its count, who acknowledged, when; the bell shows unread |
| **Assignments** | The task you assigned, its progress (*counted* from steps, or *self-reported* with the note) |
| **Activity** | Every step, timestamped, in order, with the actor |
| **People** | Hemanth with no DEMO badge; **Access** and **Reports to** editable by the CEO; **Has left…** (anonymises — do not click during a test) |
| **End of day** | Generate → the counts, and the narrative only if it passed the numeric gate |
| **Ask** | *"How many equipment blockers are open?"* → the answer, **the SQL used**, and both gate verdicts |
| **Projects** (top-left switch) | The second portal: needs, milestones, issues; progress computed by the views |

Then sign out and sign in as **Hemanth** (phone or PC): he sees only his own rows, one
person under People, and **no Ask box and no report button**. Enforced by the database, not
hidden by the page.

## 8 · A manager in Telegram (optional, 2 minutes)

As the CEO on the dashboard: **People** → set Hemanth's **Access** to *Manager*, and set
**DEMO – Priya Nair**'s **Reports to** to Hemanth. On Account B: `/start`.

**Expect:** *"You are signed in as **manager**"* with **🚨 My team's blockers** and
**📌 Assign a task to my team**. `/assign` offers **Priya only**; `/blockers` shows problems
raised by his team, not everyone's. Revert both on People afterwards.

## 9 · Ask the data a question (CEO only)

Dashboard → **Ask**: *"Which blockers are still open and who must fix them?"* The model
writes SQL against the semantic layer; Postgres runs it under the CEO's row-level rules; the
model narrates a bounded result; the numeric-sanity gate checks every number appeared in the
rows and the grounding gate checks any policy claim came from a policy table. A failed gate
shows a withheld answer and the SQL — never an invented number.

---

# 🔄 RESET — do the whole thing again from scratch

One command on the PC. **Always dry-run first:**

```bash
npx tsx scripts/reset-employee.ts --all-real --dry-run    # shows what would be removed, changes nothing
npx tsx scripts/reset-employee.ts --all-real              # removes every real (non-DEMO) employee
```

One person, or just their activity:

```bash
npx tsx scripts/reset-employee.ts --telegram 8903000291              # unregister Hemanth (register again from step 1)
npx tsx scripts/reset-employee.ts --telegram 8903000291 --activity   # keep him registered, wipe what he did
npx tsx scripts/reset-employee.ts --ceo --activity                   # wipe what the CEO did (assignments, files, reports)
npx tsx scripts/reset-employee.ts --name "Their Name"
```

**What it does:** deletes that person and their tasks, updates, blockers, escalations,
alerts, assignments, voice notes, consent record, queued messages and conversation state —
children before parents. **What it protects:** the CEO row; DEMO staff (add `--include-demo`
to remove them); and **`audit_log`, which is never touched** — history is not rewritten
because a test was re-run. **This is the DEMO tool only.** When a real person leaves, use
**People → Has left…**, which anonymises and keeps every row.

After a reset Account B is unknown to the bot again. Make a new invite (there are none unused
right now) and start at step 1. No service restart needed.

---

# If something goes wrong mid-run

| Symptom | Fix |
|---|---|
| Bot says *"Send /start to see your menu"* when you expected a question | Its step was reset (a question left too long expires). `/cancel`, then `/start`, redo that part. |
| Bot silent | `pnpm urls` — if Telegram is unreachable it is the Wi-Fi and the bot retries by itself; otherwise the bot process died: `pnpm start:bot`. |
| Stuck half-way through registration | `docker exec supabase_db_freshnow psql -U postgres -d postgres -c "delete from bot_session where key = '<your telegram id>';"` then `/start`. |
| "Could not use that code (already_used)" | Each code works once. `/invite` a new one. |
| CEO menu missing on Account A | `CEO_TELEGRAM_USER_ID=6051615734` in `.env` **and** the `ceo` role on that row; restart the bot. |
| Dashboard blank on the phone | The Wi-Fi IP changed — `pnpm urls`. Sign-in spins → port 54321 blocked (`COMMANDS.md` §3). |
| Alert never reaches the CEO | The worker is not running (`pnpm start:worker`). `select status, count(*) from notification_outbox group by 1;` — `pending` rows are waiting for it; `abandoned` means it gave up and audited why. |
| Voice note misheard | The transcript is shown first as *"I heard: …"*. Send it again or type it; either way the words are saved. |
| "Only the CEO or a manager can assign tasks." | Account B is an employee — expected. Step 8 makes him a manager. |
| Model slow or "could not understand" | `curl localhost:3001/health` → `load.llm`; the daily budget cap or a provider outage degrades to rules-only and marks the update *needs a human* rather than failing. |
