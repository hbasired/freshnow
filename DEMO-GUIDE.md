# FreshNow — demo runbook

Everything for a demo, in order. **Start with "Demo today"** — it is the current system (17 Oct 2026):
the Operations portal on live Televend data, roles, privacy. The older parts below (Part 0 onwards) are
the task-and-Telegram demo, still valid for that side of the system.

**Read this once before you start.** Commands live in **`COMMANDS.md`** (the whole sequence is its first
section, "Start to end"); logins and today's addresses live in **`CREDENTIALS.local.md`** ("Demo today").

---

## Demo — current (updated 18 Oct 2026; start here)

### A · Before anyone arrives (15 minutes)

1. **Start the system** — `COMMANDS.md` → "Start to end", steps 1–11. *(This morning they are already running:
   started 10:39. Check with `pnpm urls`: Dashboard `HTTP 200`, `@freshnow1bot reachable`.)*
2. **Sign in on the laptop as the CEO** — http://localhost:3001/app/ → the **Operations** card → the CEO account
   from `CREDENTIALS.local.md`. It first shows **privacy notice 3.0**: read it once (it is part of the demo, Act 8)
   and tap **I agree**. *(It changed on 18 Oct — it now names stock — so it is asked again even if you saw it before.)*
3. **Sign in as Hemanth too** — on your phone (`http://10.255.254.11:3001/app/` today; `pnpm urls` has the current
   address) or in a private browser window — and agree to the notice. *On Telegram both accounts already received
   the same notice, in two messages; agreeing there counts too.*
4. **Pick the theme** (☀️ 🌙 🖥️, top right) and keep the service terminals off screen.

### B · The demo, act by act (about 20 minutes)

**Act 1 — One system, six portals (1 min).** Sign out to the picker, or point at the switcher in the sidebar:
*Tasks*, *Projects*, *Operations*, *Stock*, *Cash*, *Route*. *"Each portal opens only for the roles that need it — the CEO sees all
six; a driver sees Tasks, Projects, Stock, Cash and Route; the warehouse keeper never sees cash."*

**Act 2 — Operations → Now: the machines at a glance (4 min).** The tiles across the top — on 17 Oct at 10:40 they read
**87 machines · 27 need someone · 4 offline · 176 cups so far · AED 1,680 in the machines · 29 collections ·
28 refills**. Then **Needs someone now**: each line is a Televend alarm that stayed open past its own delay, with
what to do (*"Bill / Cash Box Full — collect the cash"*). *"Televend raises about 70 alarms a day and over half
clear themselves within minutes. Each kind of alarm has a rule — how long to wait, how serious, who handles
it — so only the ones that need a person reach this list. Nobody owned an alarm before: the Assigned column was
empty on every one."* Scroll to **Every machine**: grouped by place (Metro, hospitals, malls …), each with its
state in words and colour, cups today and the cash waiting in it. Tap **Needs someone**, then type a machine
number in the search box (e.g. `399`).

**Act 3 — One machine: the cash check (4 min).** Tap a machine. The panel shows today hour by hour, its alarms,
its refills (with who filled), and **Cash collections — "Should have found"**: Televend's own cash sales
between two collections × the cash price. *"Yesterday the drivers reported 29 collections in WhatsApp. For 18 the
amount equals Televend's cash sales × AED 10 exactly. The other 11 reported **more** cash than Televend recorded —
AED 205 in all, mostly one AED 10 note, which fits the 'cash test' habit. Today the auditor writes 'audit ok ✅'
without this check. Here it is automatic — and a difference is a fact to look into, never an accusation."*

**Act 4 — Sales by hour (2 min).** Today against the same weekday last week (176 against 194 by 10:40); the hour
still running is dashed and compared with the same minutes last week; **Show as a table** for every number. Pick a
day before 4 Oct: it says *not in the Televend mirror* instead of showing zero.

**Act 5 — Day report (3 min).** Yesterday, 16 Oct: **1,474 cups** (306 cash, 1,120 card) · **34 collections that
should have found AED 2,430** · **37 refills** · **52 alarms that needed someone, 41 blips** · **8 machines with no
sale**. *"This is the yesterday-report that used to be assembled by hand from the WhatsApp groups — every number
counted by the database from Televend, read every 10 minutes."*

**Act 5b — Stock: the warehouse without the WhatsApp list (8 min).** *Before the demo, once:* **People** → Hemanth →
role **VMO / driver** (so he can be given stock), and have his phone signed in. Then:
1. **Stock → Items** — the 19 items of the warehouse's own WhatsApp list. *"No numbers yet, on purpose: that list is copied
   forward from the day before. The first count, approved, is the opening stock."*
2. **Delivery in** — Oranges 20 (variety `LALA`, carton `17.15` kg), Straws 3, supplier `FVC` → **Save delivery**. The tiles
   show 20 cartons.
3. **Give out** → tap **Hemanth** → Oranges **4** → **Send — they confirm**. *"It has left the warehouse, but it is not his
   until he says it arrived."* (Bottom of the page: *Sent by you — not confirmed yet*.)
4. **On Hemanth's phone** (a notification arrives in the app): **Stock → Waiting for you → ✓ All here**. *You hold: 4 cartons.*
   *"One tap. If one carton were missing he would press 'Something is different', type 3 — and the missing one would wait,
   visible, for the Ops Head to settle. Nobody can quietly lose a carton between two people any more."*
5. Hemanth: **Give back** → Oranges 1 → back on the laptop: **Waiting for you → ✓ All here**.
6. **Count → Spot check** → Oranges **17** → **Hand in** → *"It matches the record."* *"The count screen never shows the
   system's figure. A difference goes to a second person, then to the Ops Head, the CEO or an Admin — never the one who counted."*
7. **Day sheet** — Oranges: start 0, in 20, given out 4, back 1, end 17; *People*: Hemanth still holds 3. **Movements** — every
   step with who and when; open the delivery for the variety and the carton weight. *"Nothing here can be edited — a mistake is
   reversed, and both stay in the list."*

**Act 5c — Cash: the CASH COLLECTION group, in the app (6 min).** Hemanth (VMO / driver) on his phone; the CEO on the laptop as
the auditor. On Hemanth's phone: **Cash → Start shift** (van `Van 4`), then
1. **Collected** → machine number (its name appears) → `60` → photo of the cash → **Save**. *"The WhatsApp photo and caption, as
   one entry — added to what he holds at once."*
2. **Fuel** → `20` → photo of the receipt. **Test note** → the same machine, `10`. **Deposited** → tap `+` on the notes from the
   receipt (one 20, one 10) → photo → **Save AED 30**. *This shift* reads: collected 60 − test 10 − fuel 20 − deposited 30 =
   **in hand AED 0** — the nightly list, added up by itself. **End shift**.
3. On the laptop: **Cash → To check** → Hemanth's shift → under the collection, Televend's side. In a demo it reads *"Televend has
   no collection near this time"* — nobody recorded this one in the Televend Staff App. *"In the field the driver records it there
   too, and this line becomes Televend's own figure: '3 cash sales = AED 30 — less by AED 5'. Hemanth never sees it — a figure on
   his screen could be typed again to match. The auditor sees it, with the photos."* → **Ask** a question → on the phone it appears
   at the top of **Cash**; Hemanth answers → back on the laptop: **All ok**. *"That is 'audit ok ✅' — with the question and the
   answer kept."*

**Act 5d — Route: the instruction sheet, in the app (5 min).** The CEO on the laptop as the planner; Hemanth (VMO / driver) on his
phone, holding a couple of cartons from Act 5b. On the laptop: **Route → Plans → + New team plan** → *Night shift*, team `Team
Hemanth`, tap Hemanth, machine `793` (its name appears) → **Full service**, **Resort** (the proof chips fill in themselves) → crates
`2` → **+ Add a machine** → another number → **Check 🚨** → *"check the cup sensor"* → **Make the plan · 2 crates**. *"The sheet the
Supervisor typed every evening — and the team is told the crates to take."*
1. On Hemanth's phone: **Route** shows the round. Type the first machine's number → **Start visit**. *"In the field he scans the
   sticker on the machine and this opens by itself — no location is read, ever."*
2. Tick **Full service**, **Take a photo** for the normal pic; skip the re-sorting pic. **Put stock in** → `+` `+` → **Save what went
   in**. **Cash taken out** → `40` → photo → **Save AED 40**. **End the visit** → *"proof still missing: Re-sorting pic; not ticked:
   Resort"*. *"It does not stop him — it tells the Supervisor."*
3. On the laptop: **Route → Proof** → the stop reads **OK** under *Normal pic* and a red **NO** under *Re-sorting pic*, with who, when,
   "number typed", 2 cartons and the cash. *"That red NO used to be found by scrolling through the group's photos."*

**Act 6 — Read-only, by construction (1 min).** *"We read Televend; we cannot change it. Every request passes an
allow-list of read-only addresses before it leaves this server — tested against every write Televend has. The
account in use today is an admin account; that is exactly why the list, not the account, is the guarantee."*

**Act 7 — Who sees what (2 min).** Sign in as **Hemanth** (role: employee): his picker has **no Operations card**,
and the API refuses the data even if the address is typed. *"Admin, Ops Head and Supervisors see the machines;
drivers, the warehouse and technicians see only their own work. The database enforces it, not the screen."*

**Act 8 — Privacy (2 min).** Open the notice (Tasks portal → **Alerts** → *Your consent* → **Read the notice**): it names Televend (records that carry staff
names), photos and videos (location removed), phone sign-in (*only* to keep an account safe — never to check when
anyone works), the phone app's notifications (no message content goes to Google), and the cash and stock the app
will record. *"Because it changed, everyone was asked again, and nothing about them was sent until they agreed."*

**Act 9 — The task side (optional, 10 min).** Daily status, blockers, assignments, a document split into tasks,
end of day, the Ask box: Part 3 below, Acts 2–8.

### C · Say plainly what is not built yet

- **No staff app yet.** The phone sign-in behind it is built and tested; the Android app is TASK-063.
- **Alarms are not yet sent to anyone as problems.** It is built and switched off (`OPS_ALARM_PROBLEMS`) until the
  company names who handles machine, stock and cash problems — otherwise all ~30 a day would go to the CEO.
- **The cash is compared collection by collection, not yet added up for the company.** The auditor sees Televend's figure
  beside each collection; the automatic balancing of every shift, over/short, and the bank's statement come with TASK-062.
- **Stock is the warehouse and people only.** Loading into a machine is recorded as "used — into a machine"; the machine as a
  place, and the oranges-to-cups check against Televend, come with TASK-061 and TASK-062. Counting a driver's van is done by
  giving the stock back.

### D · What comes next, in order

| Task | What it brings |
|---|---|
| 059 ✓ | The command centre; alarms become routed problems once switched on; yesterday's report every morning |
| 060 ✓ **Stock** | Deliveries, hand-outs confirmed by the driver in the app, returns, used and damaged, blind counts with a second person and an approver, low-stock alerts, the stock list after every count, the day sheet |
| 061 part 1 ✓ **Cash** | Collections with their photo, test notes, fuel and other expenses with receipts, deposits with the CDM receipt; the auditor's check with Televend beside every collection, questions answered in the app |
| 061 part 2 ✓ **Route** | Each team's plan for the shift; a visit starts at the machine (sticker or number); photos and the dispenser video as proof; the fill and the cash on their ledgers; the sheet's OK / NO worked out |
| 061 part 3 | Part swaps and tickets: a part taken from stock into a machine, the old one back; a technician's job from an alarm |
| 062 Reconciliation | Every shift's cash and stock balanced automatically; "who did not report"; the auditor approves in the app instead of "audit ok ✅" |
| 063 App foundation | The Android app (one app, a home screen per role), offline, English/Hindi/Urdu |
| 064 Deploy | The server (VPS), a domain with HTTPS, backups, phones managed |
| 065 App for drivers and the warehouse | The real shift on a phone: take stock, visit, fill, collect, return, deposit |
| 066 Chat | The WhatsApp groups move into the app — photos, voice notes, cards that post themselves |
| 067–069 | The other roles in the app; reading receipts and counters (OCR); a pilot with one team, then everyone |

### E · What to ask for now

| From | Ask for | Why |
|---|---|---|
| **Televend (INTIS d.o.o.)** | A **read-only API client** for Data Streaming + Master Data (client id and secret, production URLs) — and whether it costs extra | The supported way in; today we use the web app's own read endpoints |
| Televend | The **data processing agreement** under FreshNow's subscription, and **where their servers are** | The privacy notice must say it; compliance blocks production without it |
| Televend | A **one-off export of history older than 7 days** | Their data streams keep 7 days |
| FreshNow's Televend admin | A **view-only Televend user** for the integration, **with the cash-centre (collections) view** | Replaces the admin account; with cash-centre access we read each collection's counted amount, not only its time |
| FreshNow management | The **cash price of each machine** (cash and card) | "Should have found" assumes AED 10; names saying "AED 12" did not match the cash |
| FreshNow management | **Who handles what**: machine faults, stock, cash — names and phones; and everyone's **role** (Ops Head, Supervisors and their teams, Cash auditor, Warehouse keeper, Technicians, drivers) | Routing rules, then switch alarms → problems on; roles decide what each person sees |
| FreshNow management | **Shift times** (07:30 and 15:00?), **count times** in the warehouse, **tolerances** for stock and cash differences, the **CDM deadline** after a shift | The shared-phone sign-in, the inventory counts and the reconciliation all run on them |
| FreshNow management | **Minimum stock** per item, **cups per carton**, carton weights and varieties (is "LALA" the variety?) | Low-stock alerts and the oranges-to-cups check |
| FreshNow management | The **PIN length** for the app (6 digits recommended) and **how long** words, photos, videos and receipts are kept | Security standard; data-protection law |
| FreshNow management | How many **company phones** (Android), and whether they are managed (MDM); **buy the VPS and a domain** when ready | The app and the deploy (TASK-063/064) |
| Drivers / Oranfresh | What the counter's **"ENTER = PARTIAL RESET"** resets — every counter photo shows Part Cash 0.00 | If the photo is taken before the reset, it confirms the cash too |
| Cash deposits | Why a driver's deposit shows **another person's CDM operator name** (David's 860 under "NOEL"), and the bank's or cash-in-transit company's **deposit statements** (portal access or a daily file) | Matching every deposit to the right driver and to the bank |
| Oranfresh | The **parts catalogue** and each machine's **model** | Spare-parts custody and repairs |
| A lawyer | Review **privacy notice 3.0**; native speakers for Hindi and Urdu | It is a developer's draft |

---

## The task & Telegram demo (earlier, still valid)

> **The dashboard opens on a portal picker** — *Task & logging*, *Projects*, and for the people who run the
> machines *Operations*. Choose one, then sign in; the same account opens all it may and the sidebar switches between
> them. Signing out returns to the picker. The automated tests number about 990 (17 Oct). The app is the main channel
> for staff from now on (company decision, 16 Oct); Telegram stays as an option for people who link it.

## Part 0 · Get the system up (10 minutes)

1. **Start it** — three terminals, in this order (full commands in `COMMANDS.md` → "Start to end"):

   ```bash
   docker compose up -d
   npx supabase start -x realtime,imgproxy,edge-runtime,logflare,vector,supavisor,mailpit,postgrest
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
   - **Whenever the privacy notice changes (now notice 3.0, 16 Oct):** within a minute of the worker
     starting, each account gets *"📄 FreshNow's privacy notice has changed"* with the full notice —
     on Telegram in **two messages**, the **✅ I agree** button under the second. Tap it on both.
     Until an account agrees, the bot answers everything with the notice and records nothing, and
     messages *to* that account wait in the outbox (they arrive the moment it agrees). One agreement
     covers Telegram and the dashboard.

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

> "The app is FreshNow's main channel from now on; Telegram stays for whoever links it. The switch is one
> choice, it is recorded, and it cannot be made in a way that leaves people unreachable."

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
