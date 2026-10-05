# Email setup guide — what you must do, in order

**Status: nothing in this guide is built.** The platform is *ready* for email — the outbox has a
`channel` column, the worker picks a sender per channel, and people can already express an email
preference — but there is no email sender, no domain, and no provider account. This document is the
list of decisions and actions needed before that changes, written so somebody who is not a developer
can act on most of it.

Read it in order. Steps 1–4 are prerequisites you cannot skip; step 5 onwards is the build.

> **Why email at all, given Telegram works?** Two reasons, and neither is "email is better".
> First, a second channel that does not depend on one company's app — see
> `docs/reports/messaging-resilience.html`. Second, email is how you reach people who are not on
> Telegram: a supplier, an auditor, a new employee before onboarding. Telegram stays primary.

---

## Step 1 — Decide the sending domain (you, this week)

You need a domain you control the DNS for. Three options, in order of preference:

| Option | Example | Notes |
|---|---|---|
| **A subdomain of the company domain** | `ops.dailyvending.ae` | **Recommended.** A reputation problem on operational mail never touches the domain the business sends invoices from. Standard practice. |
| The main domain | `dailyvending.ae` | Simplest, but everything shares one reputation. If an ops alert loop ever spams, the company's normal mail suffers. |
| A new domain | `freshnow-ops.ae` | A brand-new domain has no sending reputation at all and is treated with suspicion for weeks. Avoid unless there is a reason. |

**What to decide:** the exact subdomain, and who at the company can edit its DNS records.

**Also decide the From address now**, because it goes in the DNS setup: something like
`ops@ops.dailyvending.ae`. It must be a real, monitored address — see step 6.

---

## Step 2 — Choose a provider (you, with the prices below)

**Do not send from your own server.** Port 25 is blocked by default on most VPS providers, including
Hostinger, and a fresh IP address with no sending history lands in spam folders for weeks regardless.
This is not a thing to be clever about.

Prices checked September 2026. Confirm them before signing anything — they move.

| Provider | Cost | Inbound (replies) | Why you would pick it |
|---|---|---|---|
| **Resend** | Free tier ~3,000/month; ~$20/month for 50,000 | **Included on every plan** | Easiest setup, inbound at no extra cost. **Recommended for FreshNow.** |
| **Postmark** | ~$16.50/month (Pro) for 10,000 | **Pro plan and above only** | The best measured deliverability of the three; separates transactional and broadcast streams properly. Pick this if alerts landing in spam would be a real operational problem. |
| **Amazon SES** | ~$0.10 per 1,000 — cheapest by far | Yes, but you assemble it (SNS + S3 or a Lambda) | Cheapest, and AWS-shaped: more moving parts, more IAM, more to get wrong. Pick it only if someone already runs AWS. |

**Volume estimate for sizing:** roughly *(employees × alerts per day) + daily digests*. At 20 staff and
a handful of alerts each, that is a few hundred a month — comfortably inside every free tier. Do not
buy a big plan.

**One exception to "don't self-host":** a self-hosted **Postfix for inbound only** is defensible —
receiving mail has none of the reputation problems of sending it. It is still a service to run and
patch on a box with 8 shared vCPUs. Only if the provider's inbound cost ever becomes the deciding factor.

---

## Step 3 — DNS records (whoever controls DNS; ~30 minutes, then wait)

Your provider generates the exact values. These are what they are *for*, so you can check the work.

| Record | Purpose | What goes wrong without it |
|---|---|---|
| **SPF** (TXT) | Lists who may send as your domain | Mail is marked suspicious or rejected |
| **DKIM** (TXT) | Cryptographically signs each message | Same, plus anyone can forge you |
| **DMARC** (TXT) | Tells receivers what to do when SPF/DKIM fail, and where to send reports | Without it you are blind to forgery, and **bulk senders are now required to publish one** |
| **PTR / reverse DNS** | Your provider's job, not yours | — |
| **MX** | Where replies are delivered | Replies bounce; reply-to-update cannot work |

**Start DMARC at `p=none` with a reporting address** and read the reports for two weeks before
moving to `p=quarantine` and then `p=reject`. Going straight to `reject` on a misconfigured domain
silently destroys your own mail.

### The 2024+ bulk sender rules apply

Google, Yahoo and Microsoft now enforce, for anyone sending in volume: SPF **and** DKIM **and** DMARC
aligned; **one-click unsubscribe** (RFC 8058) on anything resembling a bulk message; and a spam
complaint rate kept **below 0.3%**. Operational alerts to your own staff are transactional rather
than bulk, but the thresholds are applied by machines that do not read intent. Comply anyway.

**DNS propagation takes hours.** Do this several days before you need it.

---

## Step 4 — The PDPL question (before anyone stores an address)

`employee` deliberately has **no email column** today. That was a UAE PDPL decision, recorded in
`scripts/link-dashboard-user.ts`, and adding one is a data-protection change, not a schema change:

- **Lawful basis and purpose limitation** — an address collected to send shift alerts may not later
  be used for anything else without asking again.
- **Transparency** — the onboarding consent notice must say that email is now a channel. That means
  a **new policy version and a new notice hash**, and existing staff re-consenting. The consent
  machinery already supports this; it has to actually be done.
- **Data minimisation** — a work address, not a personal one, wherever possible.
- **Withdrawable** — "stop emailing me" must work, which is what `notification_pref` with
  `mode = 'off'` already provides. It has to be reachable without asking an administrator.

**Do not add `employee.email` until the notice is updated.** This is the step most likely to be
skipped and the one with legal consequences.

---

## Step 5 — The build (a developer; roughly a day)

In dependency order. Each is small because the groundwork is done.

1. **`employee.email`** — nullable, unique, with the consent version that covers it. Migration plus
   `semantic/schema.yaml` in the same task, as always.
2. **`makeEmailSender()`** in `packages/worker/` — the same `Deliverer` shape as
   `makeTelegramSender()`, mapping the provider's rate-limit response to `RateLimitError` so the relay
   backs off instead of abandoning. Add it to the `senders` map in `worker/index.ts`. **That is the
   whole integration** — no business logic changes, because the outbox already carries `channel`,
   `recipient_employee_id` and `reason`.
3. **Turn the channel on** — `EMAIL_ENABLED=1`, which is what `availableChannels()` in
   `core/alerts.ts` reads. Until then an email preference produces no outbox row at all, deliberately:
   a row for a channel with no sender would sit pending forever and look like a lost message.
4. **A plain-text body** built from the same `payload.text` Telegram gets, plus the `reason` line
   ("you are being told because you are the assignee"). Do not build an HTML template first; a
   transactional alert that renders as text everywhere is worth more than one that looks nice in Gmail.
5. **One-click unsubscribe headers** on anything that could be read as bulk — `List-Unsubscribe` and
   `List-Unsubscribe-Post` — wired to set `notification_pref.mode = 'off'` for that person and channel.
6. **Tests**, matching the existing shape: one per rule in `alerts.test.ts` with `EMAIL_ENABLED=1`,
   an idempotency test (the structural key `<event>:<entity>:<person>:email` already guarantees it),
   and a bounce-handling test.

---

## Step 6 — Replying to email to update a task (optional, and harder than it looks)

Only build this if somebody actually asks. It is the part with real traps.

> **Built in TASK-053 (5 Oct 2026), for Gmail with no domain.** What was chosen, against the list below:
> - **Identification: the subject key (`[FN-42]`) first, then `In-Reply-To` / `References`** against the
>   `Message-ID`s FreshNow recorded when it sent (`fn.<outbox id>@…`, stable across retries) — Jira's
>   pattern. No per-task plus address with an HMAC: the HMAC exists to stop a guessed task id being
>   written to, and here a reply is accepted only when the sender is authenticated **and** owns the
>   task, so a guessed key lets nobody update anything that is not already theirs. One inbox address
>   (`<CEO Gmail>+freshnow`) and one IMAP search keep the rest of the mailbox unread.
> - **Spoofing:** Google's own `Authentication-Results` (the first one, from `mx.google.com`) must show
>   SPF, DKIM **and** DMARC = pass, or the message must carry Gmail's `\Sent` label (only the account
>   owner can send it). Plus `EMAIL_ALLOWLIST` both ways.
> - **Quotes:** Gmail, Outlook and phone formats are stripped, **in English only**; the full body is
>   stored before anything interprets it (retention-swept like a Telegram note).
> - **Auto-replies:** dropped on the `Auto-Submitted` and `Precedence` headers (Gmail's vacation reply sets `Auto-Submitted`) [believed].
> - **Attachments are not read** (text only — photos go through Telegram or the app).
> - **Bounces are not handled yet:** Gmail returns them to the account's own inbox, not to the
>   `+freshnow` address, so they are not read. With two allow-listed addresses this is acceptable;
>   with real staff it is the next thing to build.
>
> Set-up and demo: `EMAIL-DEMO-GUIDE.md`.

**How the reply is identified** — three mechanisms, in order of reliability:

1. **A plus-addressed reply key** — `ops+t_<taskid>_<hmac>@ops.dailyvending.ae`, as Discourse does.
   The HMAC is what stops somebody guessing a task id and writing to it. Most reliable.
2. **`Message-ID` / `In-Reply-To` threading**, as Zendesk does. Works when the client threads properly.
3. **A key in the subject line**. Last resort; people edit subject lines.

**The traps, each of which has bitten somebody:**

- **Inbound email is a spoofable write path into your task table.** Anyone can put any address in a
  `From:` header. **You must validate SPF/DKIM/DMARC on inbound** and reject what fails, or
  "reply to update" becomes "anyone on the internet can update your tasks". This is the single most
  important line in this section.
- **Quote stripping is a multilingual problem.** The libraries that strip "On Tuesday, X wrote:" and
  signature blocks recognise **English** quote headers. FreshNow's workforce writes Hindi and
  Malayalam, and their mail clients produce quote headers in those languages. Expect the stripping to
  fail, and expect a "reply" that is 90% quoted history. **Store the raw body regardless** — the same
  rule as Telegram: the employee's words are persisted before anything tries to interpret them.
- **Auto-replies and out-of-office** will arrive and must not become task updates. Check
  `Auto-Submitted:` and `Precedence:` headers and drop them.
- **Attachments** have the same size and type gates as the bot's uploads. Reuse `inspectFile`; do not
  write a second policy.
- **Bounces and complaints** must mark the address undeliverable rather than retrying forever. A hard
  bounce should set `notification_pref.mode = 'off'` for email and tell somebody.

---

## What "done" looks like

- [ ] Subdomain chosen, DNS access confirmed
- [ ] Provider account created, sending domain verified
- [ ] SPF, DKIM, DMARC (`p=none`) published; MX pointed at the provider
- [ ] Two weeks of DMARC reports read; moved to `p=quarantine`
- [ ] Consent notice updated, new policy version, staff re-consented
- [ ] `employee.email` migration + `schema.yaml`
- [ ] `makeEmailSender()` + `EMAIL_ENABLED=1`
- [ ] Tests green, including an idempotency test
- [ ] One real alert received by a real person on a real phone

---

## Honest limits of this guide

- **Prices are September 2026 and will have moved.** Check before signing.
- **Nobody here has run a deliverability programme.** The advice above is standard practice, not
  experience with these specific providers at this specific volume.
- **The PDPL reading is not legal advice.** It follows the same reasoning as the rest of the platform's
  compliance decisions. A lawyer should see step 4 before addresses are collected.
- **Reply-to-update is estimated, not scoped.** The multilingual quote-stripping problem in particular
  has no clean solution, and the honest answer may be "replies create a note for a human to read,
  not a parsed status update".
