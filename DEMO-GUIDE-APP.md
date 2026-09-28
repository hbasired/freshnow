# Demo guide — the app: in-app inbox + phone & desktop notifications

_Written 2026-09-28 for the local build on the Windows laptop. The Telegram demo is in
`DEMO-GUIDE.md`; this guide adds the app channel — the dashboard inbox plus notifications on
each person's devices — and runs alongside it. Everything below was run end to end against a
real Supabase Auth server, except the last step on a real phone (see §10)._

> **This repository is public on GitHub.** No password is written in this file. §4 has you
> set them; keep them in `CREDENTIALS.local.md`, which git ignores.

---

## 0 · What you will have on screen

| Screen | Device & browser | Address | Signs in as |
|---|---|---|---|
| **CEO** | laptop · **Google Chrome** (normal window) | `http://localhost:3001/app/` | `ceo@freshnow.local` |
| **Hemanth** (employee) | laptop · **Microsoft Edge** (normal window) | `http://localhost:3001/app/` | `hemanth@freshnow.local` |
| **Phone** (employee "DEMO – Priya Nair") | your phone · Chrome (Android) or Safari (iPhone) | `https://<random>.trycloudflare.com/app/` (§3, step 6) | `priya@freshnow.local` |
| Telegram (unchanged) | your two phones | the bot `@freshnow1bot` | CEO `6051615734` · Hemanth `8903000291` |

**Why two different browsers on the laptop:** a browser keeps one sign-in per site and one
notification subscription per site. If the CEO and Hemanth share a browser, the second sign-in
replaces the first and notifications go to whoever turned them on last. **Do not use Incognito /
InPrivate** — browsers switch notifications off there.

**Why the phone uses a `https://…trycloudflare.com` address:** browsers only allow notifications
on an `https://` page (or `http://localhost` on the laptop itself). The Wi-Fi address
`http://10.x.x.x:3001` can show the inbox but can never buzz. A Cloudflare quick tunnel gives the
laptop an `https://` address for as long as it runs — free, no account.

---

## 1 · Get the latest code (once after each update)

PowerShell, in the project folder:

```powershell
cd C:\Users\acer\Downloads\freshnow
git status                      # anything listed as modified is yours: git stash  (or commit it)
git checkout main
git pull
pnpm install
```

- Nothing new to migrate: the database schema did not change.
- If this is the **first** pull since 26 Sept, git deletes three research PDFs from `freshnow/`
  (they are now ignored, not lost). To get them back:
  `git restore --source=8e34075 -- freshnow/opt-COO.pdf freshnow/opt-COO1.pdf freshnow/opt-COO2.pdf`

---

## 2 · One-time setup

### 2.1 · Web push keys (VAPID)

```powershell
pnpm --filter @freshnow/worker exec web-push generate-vapid-keys
```

It prints a **Public Key** and a **Private Key**. Open `.env` and add three lines (any real
mailbox works for the subject):

```ini
VAPID_PUBLIC_KEY=<the Public Key>
VAPID_PRIVATE_KEY=<the Private Key>
VAPID_SUBJECT=mailto:ops@freshnow.ae
```

Generate them **once**. New keys later silently disconnect every device that turned
notifications on.

### 2.2 · Check the rest of `.env`

These should already be there from before the cloud session:

| Key | Where it comes from |
|---|---|
| `SUPABASE_URL=http://127.0.0.1:54321` | fixed for the local Supabase |
| `SUPABASE_ANON_KEY` | `npx supabase status` → *Publishable key* (or *anon key*) |
| `SUPABASE_SECRET_KEY` | `npx supabase status` → *Secret key* (or *service_role key*) — used only by `pnpm link:user` |
| `DATABASE_URL`, `DATABASE_URL_SERVICE` | the Supabase Postgres on port `54322` |
| `REDIS_URL=redis://localhost:6380` | Docker Compose Redis |
| `BOT_TOKEN`, `CEO_TELEGRAM_USER_ID=6051615734` | Telegram |
| `GROQ_API_KEY` / `OPENROUTER_API_KEY` | reading free-text updates; without a working one, problems arrive as "needs a human reader" instead of a classified blocker |

### 2.3 · Install the tunnel tool

```powershell
winget install --id Cloudflare.cloudflared
```

Close and reopen PowerShell afterwards so `cloudflared` is on the path. Check: `cloudflared --version`.

You no longer need a firewall rule for port 54321: sign-in now goes through the dashboard's own
address (see §10, "What changed").

---

## 3 · Start everything (every time)

Open **Docker Desktop** and wait until it says *Engine running*. Then one PowerShell window per
line marked "terminal", all in the project folder.

| # | Terminal | Command | Wait for |
|---|---|---|---|
| 1 | any | `docker compose up -d` | `freshnow-redis … Started` (instant) |
| 2 | any | `npx supabase start -x realtime,storage-api,imgproxy,edge-runtime,logflare,vector,supavisor,mailpit,postgrest` | `Started supabase local development setup.` (~30 s) |
| 3 | **api** | `$env:HOST = "127.0.0.1"; pnpm start:api` | `API listening on http://127.0.0.1:3001 — React dashboard at …/app/` |
| 4 | **worker** | `pnpm start:worker` | `[worker] telegram sender ready` **and** `[worker] web push sender ready` |
| 5 | **bot** | `pnpm start:bot` | `[bot] @freshnow1bot polling …` |
| 6 | **tunnel** | `cloudflared tunnel --url http://localhost:3001` | a box with `https://<words>.trycloudflare.com` — **copy that address** |
| 7 | any | `pnpm urls` | `Dashboard … HTTP 200`, `Sign-in Supabase Auth HTTP 200`, `Web push VAPID keys set`, `@freshnow1bot reachable` |

Quick health check (note `curl.exe`, not `curl`, in PowerShell):

```powershell
curl.exe http://localhost:3001/health
```

→ `{"status":"ok","db":"ok","redis":"ok", …}`

- **`$env:HOST = "127.0.0.1"`** keeps the API off the Wi-Fi: the laptop reaches it on
  `localhost`, the phone reaches it through the tunnel. Nothing else on the network can.
- **Keep terminal 6 running for the whole demo.** Every restart of `cloudflared` gives a new
  address, and a phone's notification subscription belongs to the old one — you would have to
  set the phone up again (§5.3).
- If `supabase start` fails with `network … not found`: `npx supabase stop` then start again.
  (`--no-backup` deletes the database — only if a plain stop/start does not fix it.)

---

## 4 · Accounts and credentials

### 4.1 · Find the three people

Supabase Studio → **http://127.0.0.1:54323** → *SQL Editor* → run:

```sql
select id, display_name, access_role, status
from employee
where access_role = 'ceo' or display_name ilike '%hemanth%' or display_name ilike '%priya%'
order by access_role, display_name;
```

Expected: the CEO row (`00000000-0000-0000-0000-0000000000ce` unless you created another),
`Hemanth`, and `DEMO – Priya Nair`, all `active`.

### 4.2 · Set their dashboard passwords

**Recommended — let the script pick a strong password** and print it once:

```powershell
pnpm link:user 00000000-0000-0000-0000-0000000000ce ceo@freshnow.local
pnpm link:user "Hemanth" hemanth@freshnow.local
pnpm link:user "Priya" priya@freshnow.local
```

Each prints `Linked <name> → <email>` and `Password: …  (shown once)`.

**Or choose your own** (at least 6 characters): add it as a third argument, e.g.
`pnpm link:user "Hemanth" hemanth@freshnow.local <your password>`. Running the command again
with a new password **resets** it; the account and its history stay.

- `No employee matches` → use the `id` from §4.1 instead of the name.
- `matches 2 employees` → use the `id`.
- For an account that **already exists** and no password is given, the script only re-links it
  and prints `Existing account — password unchanged.` Give a password to reset it.

### 4.3 · Write them down — in `CREDENTIALS.local.md` only

Create `CREDENTIALS.local.md` in the project folder (git ignores it). Everything a demo needs:

| What | Address | Login |
|---|---|---|
| Dashboard — CEO | http://localhost:3001/app/ | `ceo@freshnow.local` / *(from 4.2)* |
| Dashboard — Hemanth | http://localhost:3001/app/ | `hemanth@freshnow.local` / *(from 4.2)* |
| Dashboard — Priya (phone) | https://…trycloudflare.com/app/ | `priya@freshnow.local` / *(from 4.2)* |
| Supabase Studio | http://127.0.0.1:54323 | no login (local only) |
| Supabase Postgres | `127.0.0.1:54322`, database `postgres` | `postgres` / `postgres` — the local Supabase default; `npx supabase status` → *DB URL* confirms it |
| App database role | same database | `freshnow_app` / the password in your `.env` `DATABASE_URL` |
| Adminer (old rollback Postgres) | http://localhost:8080 | System **PostgreSQL** (not MySQL) · Server `db` · User `freshnow` · Password = `POSTGRES_PASSWORD` in `.env` (default `freshnow_dev_pw`) · Database `freshnow` |
| Redis | `localhost:6380` | no password |
| Supabase keys | — | `npx supabase status` |
| Telegram bot | `@freshnow1bot` | CEO account `6051615734` · Hemanth `8903000291` |

---

## 5 · Put the three screens in place (≈ 10 minutes, before anyone watches)

### 5.1 · CEO — Google Chrome on the laptop

1. Open **http://localhost:3001/app/** → choose **Task & logging** → sign in with the CEO account.
2. **First time only:** a **"Before you start"** notice appears — what the app records, how the AI
   is used, how to withdraw. Tap **I have read this and agree**. (Recorded with a fingerprint of
   the exact words; it will not ask again.)
3. Left menu → **Alerts** → **Channels** → under **How people hear from us**, choose
   **Telegram + App**. (Telegram stays on; the app is added. Until this is chosen, notifications
   are switched off for the whole company and the test below says so.)
4. Scroll to **Notifications on this device** → **Turn on for this device** → Chrome asks → **Allow**.
5. Tap **🔔 Send a test notification**, then minimise Chrome. A Windows notification
   *"FreshNow test notification"* appears within seconds.
   - Nothing? Windows Settings → *System → Notifications*: notifications **On**, **Google Chrome On**,
     and *Do not disturb / Focus* **off**.

### 5.2 · Hemanth — Microsoft Edge on the laptop

1. Open **http://localhost:3001/app/** in Edge → **Task & logging** → sign in as Hemanth.
2. **No consent notice** — he already agreed in Telegram, and that record counts.
3. **Alerts → Notifications on this device → Turn on → Allow → Send a test notification.**
   Windows Settings must also allow **Microsoft Edge** notifications.

### 5.3 · The phone — "DEMO – Priya Nair"

Use the `https://….trycloudflare.com` address from §3 step 6, followed by `/app/`.

**Android (Chrome):**
1. Open `https://<words>.trycloudflare.com/app/`.
2. Menu **⋮ → Install app** (or *Add to Home screen*) → open **FreshNow** from the home screen.
3. **Task & logging** → sign in as Priya → the **Before you start** notice → **I have read this and agree**.
4. **Alerts → Notifications on this device → Turn on → Allow → Send a test notification.**
   Lock the phone: it buzzes.

**iPhone (Safari, iOS 16.4 or later):**
1. Open the address in **Safari** (not Chrome) → **Share ⬆ → Add to Home Screen → Add**.
2. Open **FreshNow from the Home Screen** — notifications do not exist in a Safari tab; this is
   Apple's rule.
3. Sign in as Priya → agree to the notice → **Alerts → Turn on → Allow → Send a test notification.**

The phone does **not** need to be on the laptop's Wi-Fi — mobile data works, because the tunnel is
on the internet.

### 5.4 · Rehearse once, then clean up (§8)

Run §6 privately end to end, then reset (§8) so the demo starts from a clean board.

---

## 6 · The demo, act by act (≈ 20 minutes)

Keep all three screens visible: CEO in Chrome, Hemanth in Edge, the phone in your hand.

### Act 1 — One switch decides how people hear from us (CEO, 2 min)
**CEO → Alerts → Channels → How people hear from us.**
- **Telegram** (default) — what the company runs today.
- **Telegram + App** — adds the inbox and device notifications; nobody loses Telegram. *(chosen in 5.1)*
- **App only** — the app replaces Telegram. Greyed out, and refused by the server, whenever phone
  notifications are not set up: switching Telegram off with nothing that reaches a closed phone would
  leave people unreachable.
- Show **Activity** (left menu): `channel.mode_set` — who changed it and when.

> "Telegram stays the default. The app is built and switched on in one click — and it cannot be
> switched on in a way that leaves people unreachable."

### Act 2 — Work is assigned; it arrives everywhere Hemanth is (CEO → Hemanth, 2 min)
1. **CEO → Assignments → 📌 Assign work** → *Who*: **Hemanth** → *What*: `Count the crates in the cold room`
   → *Note*: `before 4 pm` → **Assign & notify**.
2. Hemanth receives it **three ways at once**: Telegram message on his phone, a Windows banner
   **"New task for you"** from Edge, and **🔔 1** on his dashboard.
3. Click the banner → Edge opens **that task** directly.

### Act 3 — Work is assigned to the phone (CEO → phone, 1 min)
1. **CEO → Assignments** → *Who*: **DEMO – Priya Nair** *(shows "no Telegram — told in the app")* →
   *What*: `Check the chiller in van 2` → **Assign & notify**.
2. The phone buzzes: **New task for you**. Tap it → the app opens on that task.

### Act 4 — A problem reported from the phone reaches the CEO at once (phone → CEO, 3 min)
1. Phone → **My work** → the chiller task → **🚫 Blocker** → type in any language, e.g.
   `van 2 chiller not cooling, juice getting warm` → **🚫 Send blocker**.
2. Toast: *"Saved as a blocker (high) — the CEO has been alerted."*
3. The CEO's laptop shows **Problem for you to resolve**, and it **stays on screen until dismissed**
   — a blocker should not be glanced at and lost. The CEO's Telegram gets it too.
   - If the AI key is not working, the CEO instead gets **An update needs a human reader** with
     the employee's exact words. Nothing is lost either way.
4. **Overview** now shows the problem under *Urgent open*.

### Act 5 — Acknowledge stops the escalation (CEO, 1 min)
**CEO → Alerts → Open problems → ✅ Acknowledge.** The row turns *on it · DEMO CEO*. Every report
of the same problem is covered; the escalation ladder stops.

### Act 6 — Work finished closes the loop (Hemanth → CEO, 1 min)
**Hemanth (Edge) → My work → ✅ Done** on the crates task. The CEO gets **Task finished** on the
laptop, in the inbox, and on Telegram.

### Act 7 — The app replaces Telegram (CEO → Hemanth, 3 min)
1. **CEO → Alerts → How people hear from us → App only.** Telegram's row turns **OFF**,
   *Phone & desktop notifications* stays **LIVE**.
2. **CEO → Assignments** → Hemanth → `Clean the juicer nozzles` → **Assign & notify**.
3. Edge banner + inbox — **and nothing in Telegram.**
4. **Activity** → the newest `alert.enqueued` lists the channels used: `inapp` and `webpush` only.

### Act 8 — Each person chooses how they are told (Hemanth, 2 min)
1. **Hemanth → Alerts → How you are told** → *Work is assigned to me* →
   **This app's notifications: Off**.
2. CEO assigns him another task → **no banner**, but it is in his **🔔 inbox** — the inbox always
   gets everything, because it is the record, not a copy.
3. Set it back to **Immediately**.

### Act 9 — Consent and privacy (phone, 1 min)
**Phone → Alerts → Your consent**: when Priya agreed, which notice, **Read the notice**.
**Withdraw consent…** exists and asks twice — **do not tap it in the demo**: it switches the account
off (§8 has the undo). Point out what is *not* built: no location tracking, no productivity score,
no sentiment analysis.

### Act 10 — Escalation when nobody answers (optional, 5 min)
The response windows are placeholders (critical 15 min, high 60 min). Shorten them for the demo in
**Studio → SQL Editor**:

```sql
update sla_policy set minutes = 2 where severity in ('critical', 'high');
```

Report a new blocker from the phone (Act 4) and **do not acknowledge it**. Within about three
minutes the CEO gets **Escalated — level 1**. Put the windows back afterwards:

```sql
update sla_policy set minutes = case severity when 'critical' then 15 when 'high' then 60 else minutes end;
```

### Act 11 — The rest of the dashboard (CEO, 3 min)
- **Overview** — today's numbers, all counted in the database.
- **Ask** — `how many blockers are open right now?` → the answer **with the SQL that produced it**.
- **End of day → Generate end-of-day reports** — one report per person, counts computed in SQL.
- **People** — access roles; the database decides who sees what.
- **Projects** (top switcher) — purpose, requirements, milestones, progress.
- **Activity** — the audit trail of everything above.

### Act 12 — Back to the default (CEO, 30 s)
**Alerts → How people hear from us → Telegram.** Recorded in Activity like every other switch.

> "The in-app channel and the notifications are ours: the words are stored on our own server, and
> the message is encrypted to each device — Google, Apple and Microsoft relay it but cannot read it."

---

## 7 · If something goes wrong

| What you see | What to do |
|---|---|
| Sign-in says **"Sign-in service is not reachable — is Supabase running?"** | Start Supabase (§3 step 2), then retry. |
| **Invalid login credentials** | Reset the password: `pnpm link:user "<name>" <email> <new password>` (§4.2). |
| Signed in but **"This account is not linked to an active employee"** | Run `pnpm link:user` for that person again (no password needed); if they withdrew consent, §8 step 4. |
| **Notifications need a secure (https) address** | You opened the Wi-Fi IP. Use `http://localhost:3001` on the laptop or the tunnel address on the phone. |
| **On iPhone, tap Share → Add to Home Screen first** | Exactly that (§5.3), then open FreshNow from the Home Screen. |
| **Notifications are blocked for this site** | You said *Block* once. Click the padlock in the address bar → Notifications → Allow; on a phone, the site settings in the browser. |
| **App only** is greyed out / "needs web push set up" | VAPID keys are missing, or the **api** was not restarted after adding them (§2.1). |
| Worker never prints **web push sender ready** | Same: VAPID keys missing in `.env`; restart the **worker**. |
| **Send a test notification** says *"Web push is not live"* | The CEO has not chosen **Telegram + App** or **App only** yet (§5.1 step 3). |
| … says *"No device is turned on for you yet"* | Tap **Turn on for this device** first. |
| Test queued but **no banner** on Windows | Windows *Notifications* on, the browser allowed, *Do not disturb / Focus* off. |
| The phone stopped buzzing after a break | Was **cloudflared** restarted? New address = set the phone up again (§5.3). |
| Two people in one browser get each other's banners | Use Chrome for one and Edge for the other (§0). |
| Nothing arrives in **Telegram** any more | You are in **App only** — switch back to *Telegram* or *Telegram + App*. |
| The problem arrives as **"needs a human reader"** | The AI key is not working. Check `GROQ_API_KEY` / `OPENROUTER_API_KEY`; the demo still works. |

Useful looks inside (Studio → SQL Editor):

```sql
-- the last 20 things the system tried to send, and whether they went
select created_at, channel, status, attempts, payload->>'kind' as kind, reason
from notification_outbox order by created_at desc limit 20;

-- which devices have notifications on
select e.display_name, p.user_agent, p.created_at
from push_subscription p join employee e on e.id = p.employee_id;
```

---

## 8 · Reset after a rehearsal

1. **CEO → Alerts → How people hear from us → Telegram.**
2. Clear what people did (keeps them registered) — the same commands as `DEMO-GUIDE.md`:
   ```powershell
   npx tsx scripts/reset-employee.ts --telegram 8903000291 --activity
   npx tsx scripts/reset-employee.ts --ceo --activity
   ```
3. To show Priya's **consent notice** again on the phone:
   ```sql
   delete from consent_record where employee_id = 'd0000000-0000-0000-0000-000000000002';
   ```
4. If someone tapped **Withdraw consent** by mistake, switch them back on:
   ```sql
   update employee set status = 'active' where display_name = 'DEMO – Priya Nair';
   ```
5. Devices stay subscribed between rehearsals — nothing to redo unless the tunnel address changed.

---

## 9 · Stop everything

`Ctrl+C` in the **tunnel**, **bot**, **worker** and **api** terminals, then:

```powershell
npx supabase stop          # keeps all data
docker compose stop        # keeps all data
```

---

## 10 · What changed for this demo, and the honest limits

**Changed on 2026-09-28**
- **Sign-in goes through the dashboard's own address.** The API passes the three sign-in calls to
  the local Supabase and refuses everything else (including sign-up). That is what lets one
  `https://` tunnel serve a phone for both sign-in and notifications, and why port 54321 no longer
  needs to be open. Existing sessions sign in once more.
- **The consent notice is checked before the board loads** — nothing about a person is fetched or
  shown until they have agreed.
- **Assignment wording is channel-neutral**: *Assign & notify*, and people without Telegram are shown
  as *told in the app* rather than as unreachable.
- **CI is paused** (manual *Run workflow* only).

**Limits — say them if asked**
- **The tunnel passes through Cloudflare**, a US company. For a demo with test data that is fine; for
  real employee data it is a cross-border transfer. Production needs a domain on a UAE host (see the
  CEO decks), after which the tunnel is not used at all.
- **A real phone has not been tested by the developer.** Everything up to the push service was tested,
  and the notification display was tested in Chrome; the first real phone is this demo.
- **New staff still join through Telegram** (invite code → bot). An app-only sign-up is not built yet.
- **Files attached to an assignment** are still delivered in Telegram only.
- **iPhone needs iOS 16.4+** and the Home Screen step; the EU restriction on iPhone web apps does not
  apply in the UAE.
