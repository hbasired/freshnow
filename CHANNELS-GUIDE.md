# Channels — how FreshNow reaches people

_Written 2026-09-19. Telegram is the only live channel today; the others are built, switched
off, and waiting for you._

Every message this system sends — a problem raised, a task assigned, an escalation nobody
answered — leaves by a **channel**. There are five. This guide says what each is for, who
should use it, what it costs, and exactly what to click.

---

## The short answer

| If you are… | Use |
|---|---|
| A **driver or anyone in the field** | **Telegram.** Already on their phone, works on mobile data, no password, one tap. Do not move them. |
| **Office, warehouse or a manager** who already signs in to the dashboard | **The dashboard inbox + notifications on your device.** Nothing to install, stays inside the country. |
| Somebody **outside the company** — a supplier, an auditor, a new starter | **Email.** |
| A team that already lives in a **company chat room** | **The chat channel**, if you decide to run a chat server. |

**Nothing here has a per-message cost.** The only thing in this platform you pay for by use
is the AI, and none of these channels involves it.

---

## The five channels

| Channel | Reaches | Where the words live | Cost | Needs |
|---|---|---|---|---|
| **Telegram** | Anyone with the bot | Telegram's servers, **outside the UAE** | free | nothing — it works today |
| **This dashboard** (the bell) | Anyone who signs in | **our own server** | free | nothing — always on |
| **Phone & desktop notifications** (web push) | Anyone who signs in, with the app closed | **our own server**; the relay carries encrypted text it cannot read | free | an **https** address |
| **Email** | Anyone with an address | the email provider | free at our volume (Brevo: 300/day) | a domain + a free provider account |
| **Company chat** | A team room | **our own server** | free software, ~2 GB of RAM | a Mattermost server you run |

---

## Three switches, not one

A message only goes out if **all three** of these are true. This is deliberate: it means no
one person can accidentally start messaging the whole company.

1. **Set up on the server** — the keys exist. A developer's job, done in `.env`.
2. **Switched on by the company** — the CEO's job, in the dashboard. Described below.
3. **Wanted by the person** — each employee's own choice, also in the dashboard.

If a channel is not working, the dashboard tells you *which* of the three is missing rather
than leaving you guessing.

---

## For the CEO — switching a channel on

**Dashboard → Alerts → Channels.**

You will see all five with a coloured dot and a badge:

- 🟢 **LIVE** — set up, switched on, sending.
- 🟠 **NOT SET UP** — you switched it on, but the server has no keys for it. Nothing is
  being sent. The line underneath says exactly what is missing.
- ⚪ **OFF** — you have not switched it on.

Flip the switch on the right. **Every change is recorded** with your name and the time, so
"who turned email on?" is always answerable.

> **Nothing is sent to anyone until you do this.** Email, notifications and chat all ship
> off. Telegram is on because it is what the company uses today.

---

## For everyone — turning on notifications on your phone or computer

**Dashboard → Alerts → Notifications on this device → Turn on for this device.**

Your browser will ask permission once. Say yes and that device will buzz when something
needs you, **even with the app closed**.

### There is no app to install

No app store, no APK, no download. The web page *becomes* the app:

- **Android / Chrome / Edge:** open the dashboard → menu **⋮** → **Install app** (or
  "Add to Home screen"). It then opens like any other app, without the browser bar.
- **iPhone / iPad:** open the dashboard **in Safari** → **Share** ⬆️ → **Add to Home
  Screen** → open FreshNow from the Home Screen → *then* turn notifications on.
  **On iPhone this order matters**: Apple does not allow notifications from a Safari tab, only
  from an app that has been added to the Home Screen. This is Apple's rule, not a setting we
  can change.
- **Windows / Mac:** the same install button in Chrome or Edge, or just leave the tab open.

### What each person can choose

**Dashboard → Alerts → How you are told.** Per event — a problem raised, an escalation, a
task assigned — each person chooses their own channel and can hold messages for a few
minutes. Your inbox in the dashboard always gets everything; that one cannot be switched off,
because it is the record rather than a copy of it.

---

## Should drivers move off Telegram?

**No.** This is the clearest recommendation in this guide.

|  | Telegram | The app + notifications |
|---|---|---|
| Already installed | ✅ every time | ❌ must be added to the Home Screen |
| Needs a password | ❌ no | ✅ yes, once |
| Works on mobile data | ✅ | ✅ |
| Reporting a blocker | one tap | sign in, open, tap |
| Proof somebody read it | ✅ the Acknowledge tap | ❌ we only know it was delivered |

A driver at a vending machine with one hand free will use the thing already open on their
phone. The app is better for people who are **already signed in to the dashboard anyway** —
managers, the warehouse, the office.

**The sensible shape:** Telegram for the field, the app and notifications for everyone at a
desk, email for people outside the company, and the dashboard inbox underneath all of it as
the record.

---

## Assigning work by email

You can forward an email — or a document — to a company address and have it become a
**proposed** list of tasks, which you then confirm in the dashboard. The same flow as
dropping a PDF into the bot.

**Set-up is free**: Cloudflare Email Routing receives mail on your domain at no cost and
hands it to us.

**Five things must be true before an email can create anything**, because email is the one
way in from outside the company and anybody can put your address in a `From:` line:

1. It carries the shared secret only our mail edge knows.
2. **SPF, DKIM and DMARC all pass** — this is what proves the sender is really who they say.
   A message missing any of them is refused.
3. The sender's address belongs to an **active employee who is allowed to give work**. An
   ordinary employee cannot assign by email, exactly as they cannot in the dashboard.
4. It is not an out-of-office or a bulk message.
5. Even then, it becomes a **proposal a human confirms** — never a silent write.

Every refusal is recorded with the reason (but never the message body).

---

## Running a company chat server

Only if you want one. `docker-compose.mattermost.yml` and
`docs/MATTERMOST-SETUP-GUIDE.md` are ready; nothing starts unless you start it.

Mattermost Team Edition is MIT-licensed, free, and has no user limit. The costs are not in
money: **~2 GB of RAM, its own database, a server to keep patched and backed up, an account
for every employee, and another app for staff to install and learn.**

My recommendation is still that you do not need it: the dashboard inbox plus notifications
already give you a channel that is ours, in the country, and free — with nothing to run.
The option exists because you asked for it.

---

## What you need before any of this works

**One domain name (about $10–15 a year) is the only thing on this page that costs money.**
It unlocks four things at once:

- **Notifications** — browsers only allow them on an `https://` address. On the office
  Wi-Fi address (`http://10.x.x.x:3001`) they cannot work at all. This is a browser rule.
- **Email**, in and out.
- **The Telegram webhook**, which is faster and cleaner than the current polling.
- **A proper address for staff**, instead of an IP that changes.

Until then everything above is built and tested, but notifications can only be demonstrated
on the developer's own machine — not on a phone.

---

## If something is not working

| What you see | What it means |
|---|---|
| A channel says **NOT SET UP** | Switched on, but the server has no keys. The line underneath names the missing one. |
| "Notifications need a secure (https) address" | You are on the Wi-Fi IP. Nothing to fix until there is a domain. |
| "On iPhone, tap Share → Add to Home Screen first" | Exactly that, then come back and turn them on. |
| "Notifications are blocked for this site" | You said no to the browser once. Allow them in the browser's own site settings. |
| Somebody is not getting Telegram messages | They may not be linked to Telegram yet, or have turned that event off under **How you are told**. |
| An email was sent and nothing happened | Check **Activity** for `inbound_email.refused` — the reason is recorded. |
