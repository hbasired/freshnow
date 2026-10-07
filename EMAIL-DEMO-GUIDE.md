# Email demo guide — two Gmail accounts, the CEO and Hemanth

FreshNow can now **send** work and alerts by email and **read the replies**. This guide sets it up with two
personal Gmail accounts and walks through the demo. Nothing else changes: Telegram, the app and the
dashboard work exactly as before, and email is one more way to be told and to answer.

The two addresses are written below as **`<CEO Gmail>`** and **`<Hemanth Gmail>`** on purpose — this file is
in a public repository, so your real addresses go only into `.env` (which git never uploads).

---

## 0 · What happens, in one picture

```
CEO assigns "Fix the van 2 chiller" to Hemanth
        │  (dashboard or Telegram — as today)
        ▼
FreshNow sends from <CEO Gmail> to <Hemanth Gmail>:
   Subject: [FN-42] New task for you: Fix the van 2 chiller
   Reply-To: <CEO Gmail with +freshnow>          ◄── the system's inbox
        │
Hemanth presses Reply in Gmail and writes "40% done"   or  "Done"  or  "Blocked - no gas"
        │
The worker reads ONLY mail sent to the +freshnow address (every 60 s), checks it really came from
Hemanth (Google's SPF/DKIM/DMARC verdicts + the allow-list), finds FN-42 (the key in the subject, or
the email thread), files it as Hemanth's update, and replies "Saved your update on FN-42".
        │
"Done" closes FN-42 · "40%" sets progress · "Blocked…" raises a problem the CEO is alerted to
```

And the other way (TASK-054): the CEO gives work **by email, exactly like a Telegram message** — either

- writes to the `+freshnow` address naming the person ("Hemanth: restock the Marina machine"), or
- writes **to Hemanth directly and copies (Cc) the `+freshnow` address** — like copying a secretary.

When every job names exactly one person the CEO may give work to (or the email went **to** exactly one
employee), it is **assigned at once**: the task appears on the dashboard (Pending work, Assignments),
Hemanth is told on his usual channels **and by email** (`[FN-57] New task for you…`), every step is in the
audit log under one correlation id, and the CEO gets a reply: *"Assigned from your email: 1. FN-57 … →
Hemanth (told by the app, email)"*. When a name fits two people, nobody, or only a guess, nothing is
assigned — it waits in **Assign → From email** for a tap, and the reply says why.

```
CEO's Gmail ──To: Hemanth, Cc: <CEO Gmail+freshnow>──► Hemanth reads it as a normal email
        │
        └── FreshNow reads the copy (Inbox or Sent, To or Cc) ─► proves it is the CEO (Gmail Sent / SPF+DKIM+DMARC)
              ─► model reads the jobs ─► WHO decided in code: the name fits one person, or the email went TO them
              ─► task + assignment (origin "email", linked to this email) ─► Hemanth told: usual channels + email
              ─► audit log ─► reply to the CEO in the same thread
Hemanth "Reply all" with "60% done" ─► filed on that task (found by the thread) ─► 60% on the Pending page
```

---

## 1 · One-time Gmail setup (5 minutes, on the CEO's account only)

The system signs in to the CEO's Gmail to send and to read the inbox alias. Gmail requires an **App
Password** for that — your normal password will not work.

1. On a computer, sign in to **`<CEO Gmail>`** and open **https://myaccount.google.com/security**.
2. Under *How you sign in to Google*, turn on **2-Step Verification** (if it is not already on).
3. Open **https://myaccount.google.com/apppasswords**, type a name such as `FreshNow`, press **Create**.
4. Google shows a **16-letter password** once. Copy it **without the spaces**. This is the only password
   FreshNow needs; you can delete it on the same page at any time to cut FreshNow off.

Nothing to do on Hemanth's account — he only receives and replies, like any email.
IMAP is always on for personal Gmail since January 2025; there is no setting to enable.

> **What this App Password can do:** read and send all of the CEO's Gmail. FreshNow's code only ever
> *searches for* mail sent to the `+freshnow` alias, never changes the mailbox (nothing marked read,
> moved or deleted), and keeps only what it processes. For real employees use a separate company
> mailbox (e.g. `ops@` on the company domain) — see *Limits* at the end.

---

## 2 · Put the settings in `.env` (on the laptop)

Open `.env` in the project folder and add these lines, with your real addresses and the App Password:

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=<CEO Gmail>
SMTP_PASS=<the 16 letters>
EMAIL_FROM="FreshNow Ops <CEO Gmail>"

EMAIL_IMAP_HOST=imap.gmail.com
EMAIL_IMAP_PORT=993
EMAIL_IMAP_USER=<CEO Gmail>
EMAIL_IMAP_PASS=<the same 16 letters>
EMAIL_INBOX_ADDRESS=<CEO Gmail with +freshnow before the @>

EMAIL_ALLOWLIST=<CEO Gmail>,<Hemanth Gmail>
EMAIL_CEO_ADDRESS=<CEO Gmail>
EMAIL_EMPLOYEE_ADDRESS=<Hemanth Gmail>
EMAIL_EMPLOYEE_NAME=Hemanth
```

`EMAIL_ALLOWLIST` is the safety catch: FreshNow will never send email to, or accept email from, any
address that is not on it — so during the demo no one else can be emailed by mistake.

---

## 3 · Get the code and start everything

PowerShell, in the project folder (`cd C:\Users\acer\Downloads\freshnow`):

```powershell
git status                                   # anything modified is yours: git stash first
git fetch origin
git checkout claude/elegant-curie-bgpzqh     # this update's branch (or main, once its pull request is merged)
git pull origin claude/elegant-curie-bgpzqh

docker compose up -d                         # Redis (the worker's email jobs need it) + Adminer
npx supabase start -x realtime,storage-api,imgproxy,edge-runtime,logflare,vector,supavisor,mailpit,postgrest

pnpm install                                 # adds the two email libraries (imapflow, mailparser)
pnpm migrate                                 # adds 0020_email.sql and 0021_task_number.sql
pnpm build:web                               # the dashboard, with the new Email page

pnpm email:check                             # logs in to Gmail (send + read), sends nothing — must show two ✓
pnpm email:check --send                      # optional: one test email to each allowed address
pnpm email:setup                             # stores both addresses on the right people, switches email on
```

Then start the services, **one terminal each** (leave them running):

```powershell
$env:HOST = "127.0.0.1"; pnpm start:api      # terminal 1
pnpm start:worker                            # terminal 2 — sends email AND reads the inbox
pnpm start:bot                               # terminal 3
cloudflared tunnel --url http://localhost:3001   # terminal 4 — only for the phone/app demo
```

The worker prints, among its ready lines:

```
[worker] email sender ready
[worker] email inbox <CEO Gmail with +freshnow>: checked every 60s (BullMQ job scheduler)
```

**One more step, once:** adding email changed the privacy notice (it now names Gmail), so the CEO
and Hemanth are each asked to agree again — tap **✅ I agree** in Telegram or in the app. Until they
do, nothing of theirs is emailed and their emailed replies are recorded but not read.

Check: `curl http://localhost:3001/health` → `"email":{"sending":true,"receiving":true,"lastPollAt":"…","lastPollOk":true}`.

---

## 4 · The demo, act by act (≈ 10 minutes)

Three windows: the **dashboard as the CEO** (Chrome), **the CEO's Gmail**, and **Hemanth's Gmail** (his
phone is best — it shows email arriving like the real thing).

### Act E0 — Add a person with their email (CEO, 1 min) — optional
Dashboard → **Assignments → Add a person** (or **People → Add a person**): name, **email**, department,
who they report to. FreshNow emails them the privacy notice; they reply **I AGREE** and from then on
work can reach them by email — no Telegram needed. A Telegram invite code is shown too, bound to the same
person, in case they join the bot later.

> The address must be allowed: with `EMAIL_ALLOWLIST` set in `.env` (the demo's safety list), add the new
> address there and restart the api and worker — or empty the list to allow every employee's own address.

### Act E1 — Work arrives by email (CEO → Hemanth, 1 min)
Dashboard → **Assign** → *Who:* Hemanth, *What:* `Fix the van 2 chiller`. Under **Tell them by**, tap
**Email** (and/or Telegram, App — a choice that cannot reach him is greyed out with the reason) →
**Assign & notify by …**. The green line under the form says exactly where it went: *"Assigned FN-42 to
Hemanth — told by the app and email."* Within a few seconds Hemanth's Gmail shows **`[FN-42] New task for
you: Fix the van 2 chiller`** (the number will differ). Open the task in the dashboard: its title bar
shows the same **FN-42**.

> "Every task has a short key, like Jira's — it is how a reply finds its task."

### Act E2 — Progress by replying (Hemanth, 1 min)
In Hemanth's Gmail press **Reply** and write `40% done, compressor arrived`. Send.
Within a minute: Hemanth gets **"Saved your update on FN-42 … Status: in progress (40%)"** in the
same thread. On the dashboard, tap the **Pending** number on the Overview: FN-42 shows **40% — reported
by Hemanth**, with his words under it.

### Act E3 — A problem by replying (Hemanth → CEO, 2 min)
Reply again: `Blocked - no gas for the chiller`. The system files it, reads it as a problem, and the
CEO is alerted — in Telegram as always, and **by email** (the setup opted the CEO in). Hemanth's reply
says *"Logged a high supply problem — the CEO has been alerted."*

### Act E4 — Done by replying (Hemanth → CEO, 1 min)
Reply `Done, fixed and tested`. FN-42 closes; the CEO gets **"Task finished"** by email.

### Act E5 — The CEO gives work by email (CEO, 2 min)
From the CEO's Gmail, write a **new email** to the `+freshnow` address:

```
Subject: This week
Hemanth: restock the Marina vending machine
Hemanth: check the van 3 tyres
```

Within a minute both tasks are **assigned**: they appear under **Pending work** and **Assignments** (Via:
email), Hemanth gets two `[FN-…]` emails, and the CEO gets one reply listing both with how Hemanth was told.

**The same thing, written to Hemanth:** a new email **To: `<Hemanth Gmail>`**, **Cc: the `+freshnow`
address**, subject `Filler`, body `Please clean the filler before 4 pm.` — no name needed, because the
email went to him. When Hemanth presses **Reply all** and writes `60% done`, it is filed on that task.

> "Email works like Telegram: when the person is certain, it is assigned at once and recorded; when it is
> not — a name that fits two people, a nickname, someone not in the system — nothing happens until you
> choose, in Assign → From email. The model reads the jobs; it never decides who."

### Act E6 — The record (CEO, 1 min)
Dashboard → **Records → Email** (phone: More → Email): sending on, inbox read and when it was last
checked, the two allowed addresses, who has which address, and every email in and out with what it
became — *processed*, *ignored* (an out-of-office) or *refused* (and why).

---

## 5 · If something goes wrong

| What you see | What to do |
|---|---|
| `pnpm email:check` → `✗ sending: Invalid login` / `535` | Not an App Password, or 2-Step Verification is off (§1). Paste the 16 letters with no spaces. |
| `✗ reading: Authentication failed` / `Invalid credentials` | Same App Password in `EMAIL_IMAP_PASS`; `EMAIL_IMAP_USER` is the full address. |
| `ENOTFOUND` / `ETIMEDOUT` | No internet, or a firewall blocks ports 465 and 993. |
| Hemanth gets no email | Has he agreed to the new notice (§3)? Is email on (Alerts → Channels)? Is he opted in (Alerts → How you are told → Email)? Run `pnpm email:setup` again — it is safe. |
| A reply does nothing | Check **Records → Email**: *refused — not on EMAIL_ALLOWLIST* (wrong address), *ignored — has not agreed to the notice*, or *ignored — nothing written above the quote*. Not listed at all → is the worker running, and Redis (`docker compose up -d`)? |
| The worker says `background jobs could not start (is Redis running?)` | `docker compose up -d`, then restart the worker. Messages still go out meanwhile; only reading the inbox waits. |
| The CEO's own email is not picked up | The `+freshnow` address must be in **To or Cc**. Gmail files mail you send to your own alias under **Sent**, not Inbox — FreshNow reads both (TASK-054), so restart the worker after pulling. Look in Records → Email: *refused — sender not authenticated* means it came from another account. |
| The CEO's email became "to confirm" instead of assigned | The reply says why: a name fits two people or nobody, or the person is outside who that sender may give work to. Write the name as it is in FreshNow, or send it **To** the person. |
| A person added on the dashboard gets no email | They must reply **I AGREE** to the privacy-notice email first (People shows *not agreed yet*); until then only the app inbox gets their work. Check the address is on `EMAIL_ALLOWLIST`. |
| "Saved" replies arrive in Gmail's Spam | Mark one *Not spam*; Gmail learns. |

---

## 6 · Limits — say them if asked

- **A personal Gmail account is fine for this demo, not for employees' real data.** Google's data
  processing terms cover Google Workspace, not personal Gmail [believed], and the App Password can read
  the whole mailbox. Production: a company domain, a dedicated `ops@` mailbox (Workspace or another
  provider), its contract filed in `compliance/processors.json`. The compliance rules (R2) already
  block production until that is done.
- **Replies are read about once a minute**, not instantly (IMAP polling; Gmail push would need a Google
  Cloud project).
- **Text only.** Attachments in an emailed reply are not read; send photos through Telegram or the app.
- **Reply all.** When the CEO writes to Hemanth directly, Hemanth's update reaches FreshNow only if his reply
  still copies the `+freshnow` address (Reply all). Replying to FreshNow's own `[FN-…]` email always works.
- **Agreeing by email** ("I AGREE" to the notice) is a developer's reading of PDPL consent — a clear written
  statement, recorded with the hash of the exact notice — not a lawyer's. Get it checked before real staff.
- **Quoted text is stripped for Gmail, Outlook and phone formats in English.** A mail app writing its
  "On … wrote:" line in another language may leave the quote in the update — the words are still kept.
- **Not tested against Gmail itself from the build machine** (it cannot reach Gmail). It was tested
  end to end against real local mail servers (Dovecot IMAP, an SMTP server) — the first real run is
  `pnpm email:check` on the laptop.
