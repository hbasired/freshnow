# FreshNow — demo runbook

Everything for today's demo, in order: get ready, rehearse, wipe your practice data, then run
the demo start to finish and register a colleague live at the end.

**Read this once before you start.** Commands live in **`COMMANDS.md`**; logins live in
**`CREDENTIALS.local.md`**.

> **The dashboard opens on a portal picker.** Two cards — *Task & logging* (the daily
> operation) and *Projects* (work with a plan and an end). Choose one, then sign in; the same
> account opens both and the header switches between them at any time. Signing out returns to
> the picker.

> **Rehearse before you present.** The dashboard, sign-in, the model chain and 321 automated
> tests are verified. What has *never* been done end to end is a person tapping through the bot
> on a phone — that is exactly what Part 1 is for. Leave 30 minutes.

---

## Part 0 · Get the system up (10 minutes)

1. **Start it** — three terminals, in this order (full commands in `COMMANDS.md` §1):

   ```bash
   docker compose up -d
   npx supabase start -x realtime,storage-api,imgproxy,edge-runtime,logflare,vector,supavisor,mailpit,postgrest
   pnpm start:api      # terminal 1
   pnpm start:worker   # terminal 2
   pnpm start:bot      # terminal 3
   ```

2. **Get today's addresses** — your Wi-Fi address changes every time the laptop reconnects:

   ```bash
   pnpm urls
   ```

   Write down the dashboard address it prints, e.g. `http://10.74.102.148:3001/app/`.
   Check the line `Bot  @freshnow1bot reachable`. If it says it cannot reach Telegram, that is
   the Wi-Fi, not the system — it keeps retrying and usually recovers within a minute.

3. **Phone check — do this now, not in front of the audience:**
   - Phone on the **same Wi-Fi** as the laptop.
   - Open the dashboard address. You should see the **portal picker** — two cards, *Task &
     logging* and *Projects*. No password is asked for yet.
   - Tap **Task & logging**, then sign in as the CEO (credentials in `CREDENTIALS.local.md`).
     If the page loads but sign-in hangs, port 54321 is blocked — run the firewall command in
     `COMMANDS.md` §3 as Administrator.
   - Check the **theme buttons** (☀️ 🌙 🖥️, top right). Light is worth using if you are
     presenting on a projector or in a bright room; the dashboard remembers the choice per
     device. *Auto* follows the phone's or laptop's own setting.
   - Open Telegram on **both** accounts and send `/start` to **@freshnow1bot**. The CEO account
     should see a menu including **➕ Create invite code**.
   - **First start after the 28 Sept update (consent notice 2.0):** within a minute of the worker
     starting, each account gets *"📄 FreshNow's privacy notice has changed"* with the full notice.
     Tap **✅ I agree** on both. Until an account agrees, the bot answers everything with the notice
     and records nothing, and messages *to* that account wait in the outbox (they arrive the moment
     it agrees). One agreement covers Telegram and the dashboard.

4. **Screen setup for the demo:** laptop showing the dashboard (signed in as CEO), your phone
   mirrored or held up for the Telegram side. Keep the three service terminals off-screen.
   Pick the theme now, before anyone is watching — switching mid-demo looks like a fiddle.

---

## Part 1 · Rehearse privately (20 minutes)

Run the whole of Part 3 yourself, with your two accounts, before anyone watches. You are
checking that each message arrives and the dashboard moves. Note anything slow — a first model
call after an idle period can take a few seconds.

**Your two Telegram accounts:**

| Role | Telegram id | Used for |
|---|---|---|
| CEO | `6051615734` | assigning, alerts, documents, the question box |
| Employee (Hemanth) | `8903000291` | reporting status, receiving tasks |

---

## Part 2 · Wipe your practice data (2 minutes)

Do this **after rehearsing and before demonstrating**, so the board is clean and nothing on
screen is something you already did.

**Always look first.** This changes nothing and prints what is there:

```bash
npx tsx scripts/reset-employee.ts --telegram 8903000291 --dry-run
```

Then pick what you need:

| Goal | Command |
|---|---|
| Clear what the employee did, **keep them registered** | `npx tsx scripts/reset-employee.ts --telegram 8903000291 --activity` |
| Clear what the CEO did (assignments, uploaded files, reports) | `npx tsx scripts/reset-employee.ts --ceo --activity` |
| **Unregister** the employee so you can show onboarding live on your own second phone | `npx tsx scripts/reset-employee.ts --telegram 8903000291` |
| Remove a colleague you registered during rehearsal | `npx tsx scripts/reset-employee.ts --name "Their Name"` |
| Remove every real person (keeps the DEMO staff) | `npx tsx scripts/reset-employee.ts --all-real` |

**What it always protects:**
- The **CEO row** is never deleted — `--ceo` only works together with `--activity`.
- The five **`DEMO –` employees** stay, so the dashboard still has history to show.
- The **audit log is never touched**. History is not rewritten because a test was re-run.

**One catch when you unregister someone who also has a dashboard login** (Hemanth does): removing the
employee row unlinks that login, so their dashboard sign-in stops working. After they re-register in
Telegram, restore it with one command — the password does not change:

```bash
pnpm link:user "Hemanth" hemanth@freshnow.local
```

**Two ways to run the demo, pick one:**

- **Keep both accounts registered** (`--activity` for the employee, `--ceo --activity`): the board is
  empty and you fill it live. The employee phone skips the invite-code step, because that phone is
  already known — show onboarding with a colleague in Part 4 instead.
- **Unregister the employee** (no `--activity`): his phone starts as a stranger, so you can show the
  whole journey from invite code onwards on your own second phone. Remember the dashboard re-link
  above, and note that his existing tasks, assignments and blockers go with him.

After the reset, refresh the dashboard: today's board should be empty, People should still show
the DEMO staff plus your two accounts, and Activity will show the seeded history.

---

## Part 3 · The demo, act by act (about 15 minutes)

### Act 1 — What this is (1 min, dashboard on screen)

Signed in as the CEO, on the **Overview** tab.

> "Employees report their day in Telegram — the app they already have. Everything lands in a
> database. Problems are detected and escalated to me automatically. This dashboard is the same
> data, and it shows exactly what the person signed in is allowed to see."

Point at the **DEMO** badge and say plainly: the five `DEMO –` people and their history are
**synthetic test data**; the real accounts are yours and Hemanth's. Saying this yourself, first,
is worth more than being asked.

### Act 2 — An employee reports their day (2 min)

On the **employee phone**: send `/log`.

- The bot lists the person's tasks: *"You have N task(s). Tap a status for each:"*, each with
  **✅ Done · ⏳ Pending · 🚫 Blocker**.
- If there are no tasks yet, it offers **➕ Add a task** — add one, e.g. *"Clean the chiller in van 2"*.
- Tap **✅ Done** on one task.

On the **dashboard**: refresh (↻). The task appears under **Completed** on today's board.

> "A tap, not a form. The button is the record — the system never guesses what the tap meant."

### Act 3 — A blocker, and the CEO hears about it (3 min)

On the **employee phone**, tap **🚫 Blocker** on a task, or just type a message in the worker's
own words, for example:

```
boss van 2 ka chiller kaam nahi kar raha, juice kharab ho jayega
```

What to show, in this order:

1. The employee gets an immediate acknowledgement — their words are saved *before* any AI runs.
2. The **CEO phone** receives an alert about the blocker, with a button to acknowledge it.
3. The **dashboard** shows it under **Blockers** on the Overview tab, with severity and category — and the red **Urgent open** card and the **Needs a human** list both pick it up.
4. On the CEO phone, send `/blockers` → the open list → acknowledge one. The bot confirms:
   *"✅ Blocker acknowledged — it will no longer escalate."*

> "It read Hindi written in English letters, decided this stops work, and told me. Who it goes to
> is a rule in a table, not the AI's opinion — so it is the same every time and I can explain it."

### Act 4 — The CEO assigns work (2 min)

On the **CEO phone**: `/assign`, then follow the prompts (who, then what).

- The employee phone receives: **📌 New task from the CEO:** followed by the task.
- The employee taps a status on it, or sends `/log`.
- The **dashboard → Assignments** tab shows who gave what to whom, and whether it was delivered.

### Act 5 — A document becomes tasks for the right people (3 min)

This is the part people remember. On the **CEO phone**, send a **PDF work order that names two
people** with a caption like *"Assign the work in this document to the right people."*

- The bot reads the document and proposes a split — one task per job, each matched to the person
  named — and asks you to confirm with **✅ Create these tasks** (or *"👤 Say who does the other N"*
  when a name is not in the directory).
- Tap the confirm button. Each person gets **their own message with only their own tasks**.
- If you want the file itself forwarded, tap **📄 Also send the file** — otherwise the document is
  not forwarded, only the work in it.

> "It does not forward a PDF to everybody. It reads it, splits it, and sends each person only
> their part — and it will not invent a person: a name it does not recognise comes back to me."

Have a suitable PDF ready on the CEO phone before you start.

### Act 6 — End of day (2 min)

On either phone: `/eod`.

- The bot replies *"📊 Building the end-of-day report…"*, then asks whether you want to add
  anything before it files the report. Send a sentence, or `/skip`.
- The **dashboard → End of day** tab shows the stored report: what was completed, what is pending,
  blockers, and work carried over from earlier days with its age.

### Act 7 — Ask the data a question (2 min, CEO only)

On the dashboard, open the **Ask** tab and type, e.g. *"how many blockers are open right now?"*

- The answer appears with **the SQL that produced it** and a note that the numbers were checked
  against the returned rows.

> "The AI writes the query. The database does the counting. Every number on screen traces back to
> SQL I can read — it is never a number the model made up."

### Act 8 — Who sees what (1 min)

Sign out — you land back on the portal picker. Choose **Task & logging** and sign in as
**Hemanth**, on the phone.

> If you unregistered him in Part 2, do this act **after** he has re-registered and you have re-run
> `pnpm link:user` (see Part 2) — otherwise the sign-in is correctly refused as not linked to an employee.

- He sees only his own rows, one person under People, and **no Ask box and no report button**.
- Point out that this is enforced by the database, not hidden in the interface.

**Optional — a manager on the phone (1 min).** As the CEO on the dashboard, People → set Ahmed's
**Access** to *Manager* and Priya's **Reports to** to Ahmed. On Ahmed's phone, `/start`: he is now
"signed in as *manager*" with **🚨 My team's blockers** and **📌 Assign a task to my team** — and the
directory offers Priya only. `/blockers` shows Priya's problems, not Ramesh's. Same rule as the
browser, same database. (Revert both on People afterwards.)

### Act 9 — The app replaces Telegram, with one switch (3 min)

This is the answer to "what if we stop using Telegram?" — shown, not described. Telegram is the
default and stays on until the CEO chooses otherwise.

**Before the demo (once):** web push needs VAPID keys in `.env` and an **https** address — or
`http://localhost` on the machine you are presenting from. Generate the keys with
`npx web-push generate-vapid-keys` (from `packages/worker`), paste the three `VAPID_*` lines into
`.env`, restart the API and the worker. On a phone, `http://10.x.x.x:3001` cannot work — browsers only
allow notifications on https. For a phone demo with **synthetic data only**, a temporary tunnel such
as `cloudflared tunnel --url http://localhost:3001` gives an https address (traffic then passes through
Cloudflare — never do this with real employee data). iPhone: Safari → Share → **Add to Home Screen**
first, then open FreshNow from the Home Screen.

1. **Alerts → Notifications on this device → Turn on for this device**, allow the browser prompt.
   Then **🔔 Send a test notification** — close the tab first and it still arrives. That banner went
   through the real outbox and the real worker, not a shortcut.
2. **Alerts → Channels → How people hear from us.** Three choices: **Telegram** (default),
   **Telegram + App**, **App only**. Choose **App only**. Telegram's row turns OFF, phone notifications
   turn LIVE. (If web push is not set up, *App only* is greyed out and the server refuses it — turning
   Telegram off with nothing to replace it would leave nobody reachable.)
3. As the CEO, **Assignments → assign a task** to the person whose device is on. Their phone buzzes with
   **"New task for you"**; tapping it opens that exact task. Nothing was sent to Telegram — check
   **Activity**: `alert.enqueued` lists the channels, `inapp` and `webpush` only.
4. That person reports **🚫 Blocked** on **My work** with a sentence. The CEO's device buzzes with
   **"Problem for you to resolve"** — it stays on screen until dismissed, because a blocker should not be
   glanced at and lost — and **✅ Acknowledge** on the Alerts tab stops the escalation, exactly as the
   Telegram button does.
5. Switch back to **Telegram** at the end. Every switch is in **Activity** as `channel.mode_set`, with
   who and when.

> "Telegram stays the default. The app is built, wired and switched off until you decide — and when you
> do, it is one choice, it is recorded, and it cannot be made in a way that leaves people unreachable."

---

## Part 4 · Register someone from the office, live (3 minutes)

The best closing act: a real person joins in front of everyone.

1. **CEO phone:** `/invite Ahmed Khan` (their real name), or `/start` → **➕ Create invite code**.
   The bot replies with a **single-use code**.
2. **Their phone:** open **@freshnow1bot** → `/start` → tap **🔑 I have an invite code** → type the
   code.
3. The bot shows the **data-protection notice**. They tap **✅ I agree** (or **✖ No thanks**, which
   stops there — worth saying out loud).
4. The bot asks four questions, one at a time: **department, role, site, shift**.
5. They are now active: the **dashboard → People** tab shows them immediately.

When somebody leaves for real, the CEO uses **People → Has left…** (reason, then the red button). That
anonymises the person — name, Telegram link, login and every note — and keeps their tasks, counts and
history. It cannot be undone. The reset script is for wiping DEMO data, not for leavers.
6. Give them something to do: on the CEO phone `/assign` → pick them → a small task. They receive
   it and tap a status. It appears on the board.

> "Nobody creates their own account. I issue a code, they consent, and they fill in their own
> details. Their consent is recorded with the version of the notice they agreed to."

**Afterwards**, if they were only a demonstration:

```bash
npx tsx scripts/reset-employee.ts --name "Ahmed Khan" --dry-run
npx tsx scripts/reset-employee.ts --name "Ahmed Khan"
```

---

## Part 5 · If something goes wrong

| What you see | What to do, in front of people |
|---|---|
| Bot does not reply | Wait ten seconds — Telegram from this Wi-Fi drops occasionally and the bot retries. Keep talking; move to the dashboard. Check the Telegram line in `pnpm urls` afterwards. |
| Dashboard will not load on the phone | The Wi-Fi address changed. Run `pnpm urls` and use the new one. |
| Sign-in spins forever | Port 54321 is blocked — firewall command in `COMMANDS.md` §3. Fall back to showing the dashboard on the laptop. |
| A reply takes several seconds | Normal for the first call after an idle spell. Say "it is reading the message now" and carry on. |
| Nothing arrives in Telegram at all | The worker terminal is not running — it is what delivers messages. Restart `pnpm start:worker`. |
| Something is genuinely broken | Move to the dashboard and talk about what is already on it. Every act above stands alone. |

---

## Part 6 · Questions you are likely to get

**"Is the AI deciding who does what?"**
No. The AI only turns a sentence into structured fields. Who a problem goes to is a lookup in a
table; whether it escalates is a rule on severity and age. Both are the same every time and can be
explained to you afterwards.

**"What if it gets the message wrong?"**
The person's exact words are saved before the AI runs, and shown on the dashboard. If parsing
fails the update is flagged for a human rather than dropped.

**"Can someone see a colleague's data?"**
No — the database enforces it per person, not the screen. That is what Act 8 shows.

**"Is our data being used to train AI?"**
Messages go to a model provider to be read. Nothing is used for training by us. Before going live
this belongs in the staff notice, naming the provider.

**"What does it cost to run?"**
At 25 staff, measured: well under a dollar a month in model calls, plus the server. Details in
`docs/reports/model-benchmark.html`.

**"Is this the finished system?"**
No — it is a working demo on real infrastructure. The data for the five `DEMO –` people is
synthetic. What is not built yet is listed honestly in `docs/tasks/`.

---

## Part 7 · After the demo

```bash
# clear what the demo created, keep both accounts registered
npx tsx scripts/reset-employee.ts --telegram 8903000291 --activity
npx tsx scripts/reset-employee.ts --ceo --activity

# stop everything (data is kept)
npx supabase stop
docker compose stop
```

Then, when you have a moment:

- **Buy a little OpenRouter credit** — the backup model provider works, but the account shows no
  purchased credit and could stop without warning.
- **Rotate the API keys** that were pasted into chat.
- **Change the two dashboard passwords** (`pnpm link:user "<name>" <email> <new-password>`).
