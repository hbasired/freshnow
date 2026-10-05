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

And the other way: the CEO emails work to the `+freshnow` address ("Hemanth: restock the Marina
machine") → it appears in **Assign → From email** as a proposal → the CEO taps **Assign & notify**.
**Nothing an email says is assigned until a person taps.**

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

### Act E1 — Work arrives by email (CEO → Hemanth, 1 min)
Dashboard → **Assign** → *Who:* Hemanth, *What:* `Fix the van 2 chiller` → **Assign & notify**.
Within a few seconds Hemanth's Gmail shows **`[FN-42] New task for you: Fix the van 2 chiller`** (the
number will differ). Open the task in the dashboard: its title bar shows the same **FN-42**.

> "Every task has a short key, like Jira's — it is how a reply finds its task."

### Act E2 — Progress by replying (Hemanth, 1 min)
In Hemanth's Gmail press **Reply** and write `40% done, compressor arrived`. Send.
Within a minute: Hemanth gets **"Saved your update on FN-42 … Status: in progress (40%)"** in the
same thread, and the dashboard shows the task at 40%.

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

Within a minute the CEO gets **"2 task(s) to confirm"**, and the dashboard → **Assign** shows a
**✉️ From email** card with both tasks, owner already filled in ("named in the email"). Tap **Assign &
notify** — only now is Hemanth told.

> "An email never assigns work by itself. A name that fits two people is shown as 'could be X or Y —
> choose'; a name the system could only guess is marked 'my guess — check'."

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
| The CEO's own email is not picked up | It must go **to the `+freshnow` address**. Look in Records → Email for it; *refused — sender not authenticated* means Gmail did not mark it as sent by the account — reply to any FreshNow email instead. |
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
- **Quoted text is stripped for Gmail, Outlook and phone formats in English.** A mail app writing its
  "On … wrote:" line in another language may leave the quote in the update — the words are still kept.
- **Not tested against Gmail itself from the build machine** (it cannot reach Gmail). It was tested
  end to end against real local mail servers (Dovecot IMAP, an SMTP server) — the first real run is
  `pnpm email:check` on the laptop.
