# Demo guide — the app: in-app inbox + phone & desktop notifications

_Written 2026-09-28 for the local build on the Windows laptop. The Telegram demo is in
`DEMO-GUIDE.md`; this guide adds the app channel — the dashboard inbox plus notifications on
each person's devices — and runs alongside it. Everything below was run end to end against a
real Supabase Auth server, except the last step on a real phone (see §10). **Updated 2026-09-30**
(TASK-049/050): the phone layout, progress ranges, and policy as code — the Compliance page,
"Download my data", and identifiers removed from AI prompts._

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
git fetch origin
git checkout claude/elegant-curie-bgpzqh        # this update's branch — or: git checkout main, once its pull request is merged
git pull origin claude/elegant-curie-bgpzqh     # (or: git pull origin main)
pnpm install
pnpm migrate                    # database changes (Supabase must be running) — "skip" for ones already applied
pnpm build:web                  # rebuild the dashboard — every pull, not optional
```

Which branch: new work arrives on a pull request. Before it is merged, pull its branch (the name is on the
pull request page); after it is merged, `git checkout main` and `git pull origin main`. `COMMANDS.md` §0 has both.

- **`pnpm build:web` is not optional.** The API serves the dashboard from `packages/dashboard/dist`,
  which is build output and not in git — after a pull the laptop keeps serving the *old* dashboard
  (no consent notice, no delivery-mode switch, sign-in aimed at port 54321, so the phone cannot sign
  in through the tunnel) until you rebuild. Build before starting the API (§3).
- **`pnpm migrate` is not optional either** when a pull adds a migration (30 Sep added
  `0018_progress_band.sql` and `0019_llm_call_redacted.sql`). Skipped, the task lists fail with *Request failed
  (500)* and the api window logs `column … does not exist`. It needs Supabase running; run it before starting the api.
- **Nobody is asked to agree again.** The 30 Sep updates do not change the privacy notice's words, so everyone's
  consent still counts.
- **`pnpm install` matters this time**: the security update (TASK-051) upgrades the email library and the test
  runner to versions without known vulnerabilities. It adds no migration.

### 1.1 · Already running when you pulled? What to restart

Nothing reloads by itself — `pnpm start:*` runs the code as it was when it started.

| Window | After a pull | Why |
|---|---|---|
| **api** | `Ctrl+C`, then `$env:HOST = "127.0.0.1"; pnpm start:api` | new server code; serves the new dashboard build |
| **worker** | `Ctrl+C`, then `pnpm start:worker` | new sending / consent code |
| **bot** | `Ctrl+C`, then `pnpm start:bot` | new bot code |
| **tunnel** | **leave it running** | it only forwards to port 3001; a restart would give the phone a new address |
| Docker, Supabase | leave running | nothing changed in them |
| browsers, phone | reload the page (on the phone: close and reopen the app) | picks up the new dashboard |

Order: `git pull` → `pnpm install` → `pnpm migrate` → `pnpm build:web` → restart **api**, **worker**, **bot** → reload the
browsers. (`pnpm dev:api` instead of `start:api` reloads server code on every change, but the dashboard
still needs `pnpm build:web`.)

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
| 3 | **api** | `$env:HOST = "127.0.0.1"; pnpm start:api` | `API listening on http://127.0.0.1:3001 — React dashboard at …/app/` (first comes one `[api] policy: demo mode, not enforced — N rule(s) would stop production` line — expected, see below) |
| 4 | **worker** | `pnpm start:worker` | `[worker] telegram sender ready` **and** `[worker] web push sender ready` (after the same `policy` line) |
| 5 | **bot** | `pnpm start:bot` | `[bot] @freshnow1bot polling …` |
| 6 | **tunnel** | `cloudflared tunnel --url http://localhost:3001` | connectivity checks that all say `PASS` (the address itself is printed near the top — you do not need to find it) |
| 7 | any | `pnpm urls` | **`Phone https://<words>.trycloudflare.com/app/ HTTP 200`** — the phone's address, checked end to end — plus `Dashboard … HTTP 200`, `Sign-in Supabase Auth HTTP 200`, `Web push VAPID keys set`, `@freshnow1bot reachable` |

Quick health check (note `curl.exe`, not `curl`, in PowerShell):

```powershell
curl.exe http://localhost:3001/health
```

→ `{"status":"ok","db":"ok","redis":"ok", …}`

- **The `policy: demo mode, not enforced` line is expected.** The api, worker and bot check the configuration
  against `compliance/processors.json` at start-up. In the demo they only report what would stop a production
  start (no retention period, a laptop as the host, zero retention not yet confirmed at Groq …); nothing is
  blocked. `pnpm compliance` prints the details; the CEO sees them on **Records → Compliance**. If a window says
  **`refusing to start`**, `.env` has `IS_DEMO=false` — remove that line for the demo (§7).
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

0. **In Telegram first (CEO and Hemanth):** within a minute of the worker starting, the bot sends
   each of you *"📄 FreshNow's privacy notice has changed"* — tap **✅ I agree**. Until you do, the
   bot answers everything with the notice, and Telegram messages to you wait (they are delivered the
   moment you agree). One agreement counts for Telegram and the app.
1. Open **http://localhost:3001/app/** → choose **Task & logging** → sign in with the CEO account.
2. If you have not agreed yet, **"The privacy notice has changed"** appears (or **"Before you
   start"** for someone who never agreed to anything) — what is recorded, **which services outside
   our database receive it** (Telegram, the AI providers configured in `.env`, the push relays), how
   long it is kept, how to withdraw. Tap **I have read this and agree**. It is recorded with a
   fingerprint of the exact words; it asks again only if the words change.
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
2. **No notice** if he tapped **✅ I agree** in Telegram (step 5.1·0) — that record counts here too.
   Otherwise he sees *"The privacy notice has changed"* — agree.
3. **Alerts → Notifications on this device → Turn on → Allow → Send a test notification.**
   Windows Settings must also allow **Microsoft Edge** notifications.

### 5.3 · The phone — "DEMO – Priya Nair"

**Before the phone:**
- The CEO has chosen **Telegram + App** (§5.1 step 3). With **Telegram** only, the phone gets its inbox but
  never buzzes.
- Priya has a password (`pnpm link:user "Priya" priya@freshnow.local <password>`, §4.2).
- `pnpm urls` shows **`Phone https://<words>.trycloudflare.com/app/ HTTP 200`**. `DOWN` right after starting
  the tunnel: wait 30 seconds and run it again. Still `DOWN`: the **api** window is not running, or
  cloudflared was closed.

**What the tunnel means for data:** Cloudflare decrypts traffic through a quick tunnel at its edge — sign-in
included. Use it with the demo's synthetic data and your own test accounts only, never with real employees. The
system says so itself: open the CEO's **Compliance** page through the tunnel address and it adds a finding for it.

**Getting the address onto the phone:** copy the `Phone` line from `pnpm urls` and send it to yourself —
Telegram → **Saved Messages** is quickest — then tap it on the phone. It is long and random; typing it is
where most attempts go wrong.

**Android — use Chrome.** Brave and other privacy browsers can block web push (Brave needs *Use Google
services for push messaging* switched on, and reports of Android PWAs not getting notifications exist).
Chrome is the dependable one for the demo.
1. Open `https://<words>.trycloudflare.com/app/` in **Chrome**.
2. Install it — whichever you see first:
   - a green **📲 Install app** button at the top of the page (phone screens only), or
   - **Alerts → This device → Install FreshNow**, or
   - Chrome's menu **⋮** (top right) → **Install app** / *Add to Home screen*.
   Then open **FreshNow** from the home screen / app drawer — it opens full-screen, without the address bar.
3. **Task & logging** → sign in as Priya (or any account) → agree to the notice.
4. **Alerts → This device → 🔔 Notifications → Turn on for this device → Allow → Send a test notification.**
   Lock the phone: it buzzes.

**Does it behave like a normal app?** Yes, for messages: once installed and turned on, notifications land
in the phone's notification shade with the app **closed** — sound, vibration, lock-screen banner, per the
phone's own settings for FreshNow — and a tap opens the right task. Differences from a store app: no
Play Store, and — while the laptop is the server — notifications stop when the laptop sleeps or the tunnel
stops (a new tunnel address also means turning notifications on again). On Samsung phones, if banners arrive late,
Settings → Apps → Chrome → Battery → *Unrestricted*.

**iPhone (Safari, iOS 16.4 or later):**
1. Open the address in **Safari** (not Chrome) → **Share ⬆ → Add to Home Screen → Add**.
2. Open **FreshNow from the Home Screen** — notifications do not exist in a Safari tab; this is
   Apple's rule.
3. Sign in as Priya → agree to the notice → **Alerts → Turn on → Allow → Send a test notification.**

The phone does **not** need to be on the laptop's Wi-Fi — mobile data works, because the tunnel is
on the internet.

**Finding your way on the phone (since 30 Sep).** The phone no longer shows a squeezed copy of the laptop
screen. It is one page at a time:
- **The bar at the bottom** — **Home · My work · Assign · Alerts · More**. People who cannot give work
  out see **Projects** in the middle instead of **Assign**. A red number on **Alerts** is urgent problems;
  the number on **My work** is your open tasks.
- **More** — everything else (Carry-over, End of day, People, Activity, Ask, Projects), a search box over
  everything on the board, and **This device**: theme, install, refresh, sign out. A page opened from More
  has a **‹** back arrow at the top left.
- **Home** — the day with **‹ ›** to step a day back or forward (tap the date for a calendar), then the
  counts, what needs a human, the week, and the day's reports as cards.
- **My work** — one card per task: tap its title to open it, **✅ Done / ⏳ Pending / 🚫 Problem** to report,
  **📊 Update progress** to pick a range (0–10%, 10–20% …). A task opens as its own page with **‹ Back**.
- Tables on the laptop are cards on the phone — nothing scrolls sideways.

**If the phone will not cooperate:**

| On the phone | Cause | Do |
|---|---|---|
| A Cloudflare error page saying **502** / *Bad gateway* | the tunnel is up, the API behind it is not | start the **api** window; check `curl.exe http://localhost:3001/health` on the laptop |
| A Cloudflare error page saying **1033** | cloudflared is not connected (window closed, laptop asleep) | start the tunnel again — it will have a **new** address: `pnpm urls`, resend it |
| *"This site can't be reached"* | wrong or old address | run `pnpm urls` again and resend the `Phone` line; the address changes whenever cloudflared restarts |
| *"Sign-in service is not reachable"* | Supabase is not running on the laptop | `npx supabase start …` (§3 step 2) |
| *"Invalid login credentials"* | Priya has no password yet, or a different one | `pnpm link:user "Priya" priya@freshnow.local <new password>` |
| No **Install app** anywhere | another browser (Brave: menu **⋮ bottom right**; Samsung Internet: ☰ → *Add page to* → *Home screen*), or already installed | use **Chrome**; or check the app drawer for FreshNow |
| The status line says **refreshing every 20 s** instead of **live** | expected through a quick tunnel (no live stream) | nothing to do — notifications still arrive at once |
| **Turn on** says notifications are blocked | you tapped *Block* once | Android: ⋮ → Settings → Site settings → Notifications → allow the address; iPhone: Settings → Notifications → FreshNow |
| Test says *"Web push is not live"* | the company is on **Telegram** only | CEO → Alerts → Channels → **Telegram + App** |
| The board updates slowly (up to 20 s) | expected through a quick tunnel (no live stream) | notifications still arrive at once; reopen the app to refresh |

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
1. Phone → **My work** → the chiller task → **🚫 Problem** → tap **Machine not working** (it fills the
   box; tap more to add them) and/or type in any language, e.g.
   `van 2 chiller not cooling, juice getting warm` → **🚫 Send problem**.
2. Toast: *"Saved as a problem (high) — the CEO has been alerted."*
3. The CEO's laptop shows **Problem for you to resolve**, and it **stays on screen until dismissed**
   — a blocker should not be glanced at and lost. The CEO's Telegram gets it too.
   - If the AI key is not working, the CEO instead gets **An update needs a human reader** with
     the employee's exact words. Nothing is lost either way.
4. **Overview** now shows the problem under *Urgent open*.

### Act 4b — Progress as a range, not a guess at a number (phone → CEO, 1 min)
1. Phone → **My work** → any task → **📊 Update progress** → *How far along is it?* **20–30% · about a
   quarter** → tap **Materials ready** → **Save progress**.
2. The card now reads **20–30%** — never "25%". The CEO's **Carry-over** shows the same range.
3. CEO opens the task: **20–30%** · *self-reported · a range, counted as 25% in totals*. The midpoint is
   used only for sums and the "behind" flag; the person's range is what is shown. Ticking steps replaces it.

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
**Phone → Alerts → Your consent**: when Priya agreed, which notice (**2.0-draft**), **Read the notice**.
Point at the section *"Where your data goes beyond FreshNow's database"*: it names Telegram, each AI
provider that has a key in `.env`, and the push relays — built from the configuration, so it cannot
fall out of date. Add or remove a provider and **everyone is asked again** automatically.
Tap **⬇ Download my data**: the phone saves a JSON file of everything the system holds about Priya — profile,
tasks, her own words, problems, assignments, inbox, consent record (the PDPL's rights to information and to a
machine-readable copy). On Android it lands in *Downloads*; on iPhone Safari offers to save it to *Files*.
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
- **Projects** (top switcher on the laptop; **More → Projects** on the CEO's phone) — purpose, requirements, milestones, progress.
- **Activity** — the audit trail of everything above.

### Act 11b — Compliance the system checks itself (CEO, 3 min)
1. **CEO → Records → Compliance** (phone: **More → Compliance**). The top line: *Demo — reported, not enforced.
   N rule(s) would stop production.*
2. Walk down the findings — each names the rule (R2 contract, R3 host, R4 AI keeps nothing, R6 retention and
   sign-in) and the fix. *"In production — `IS_DEMO=false` — the api, worker and bot refuse to start until every
   one of these passes."*
3. **Where personal data can go** — the record of processing, read from `compliance/processors.json`: each service,
   its country, the legal ground, whether a contract is filed, whether it keeps nothing, and *reachable* for the
   ones this server has keys for.
4. **Sent to AI services** — calls per provider and **identifiers removed**: phone numbers, emails, Emirates IDs,
   IBANs and card numbers are taken out of every prompt before it leaves.
5. Optional, in a spare terminal: `pnpm compliance --production` — the same checks as a production start would
   run, with the exit code a deployment would use.
6. **People → ⬇ Export** — the CEO answers a data request for someone who asked in person.

> "The law's rules are written down once, the system checks itself against them at every start, and the
> evidence is counted in the database. What code cannot do — sign a contract, decide what the law means — is
> listed on the page, not hidden."

### Act 11c — Security in depth (CEO, 3 min, optional)
1. **Records → Compliance → Security** (phone: More → Compliance, scroll down): the virus scanner (*off* unless you
   started ClamAV — COMMANDS.md §7d), files refused as malware, the last backup and whether its restore test passed,
   and phones paused after 10 wrong passwords.
2. In a spare terminal: `pnpm security:scan` — secret files in git, dependency advisories, and (with ClamAV on) the
   scanner refusing the industry's EICAR test file, sent from memory so Windows Defender does not grab it first.
3. `pnpm backup` then `pnpm backup:restore-test` — *"a backup that has never been restored is a hope"*; the Security
   card updates.
4. Say what it does to files: every document is checked when it **arrives** — true type, dangerous names, virus
   scan, and PDFs with active content are read but never passed on to another phone. PDFs are opened in a
   separate, sealed process with a memory and time limit, so a booby-trapped file cannot take the server down.

> "Defence in depth: no single layer is trusted. The scanner can miss something new, so the structure checks and
> the sealed reader are still there; a stolen password is slowed down per phone; and if the worst happens, a tested
> backup sits unplugged in a drawer."

Do **not** demonstrate the sign-in pause on the demo phone — it locks that phone out for 15 minutes.

### Act 12 — Back to the default (CEO, 30 s)
**Alerts → How people hear from us → Telegram.** Recorded in Activity like every other switch.

> "The in-app channel and the notifications are ours: the words are stored on our own server, and
> the message is encrypted to each device — Google, Apple and Microsoft relay it but cannot read it."

---

## 7 · If something goes wrong

| What you see | What to do |
|---|---|
| `/app/` shows **404**, or the dashboard has no **Before you start** notice / no **How people hear from us** switch | The dashboard was not rebuilt after the pull: `pnpm build:web`, then restart the **api**. |
| The task lists say **Request failed (500)** after a pull; the api window logs `column … does not exist` | A migration was not applied: `pnpm migrate`, then restart the **api**. |
| A window says **`refusing to start: N compliance rule(s) block production (IS_DEMO=false)`** | `.env` has `IS_DEMO=false` — that is the production switch. For the demo delete the line (or set `IS_DEMO=true`) and start again. `pnpm compliance --production` lists what production would need. |
| No **Compliance** under Records / More | Only the CEO sees it (the API refuses everyone else). Signed in as the CEO and still missing: `pnpm build:web`, restart the api. |
| **Download my data** does nothing on iPhone | Safari asks where to save — look for the download arrow in the address bar, then *Files*. |
| The bot answers every message with the **privacy notice** | That account has not agreed to notice 2.0 — tap **✅ I agree** under it. |
| Someone gets nothing in **Telegram** (the inbox still fills) | They have not agreed yet; their messages wait and go out the moment they do. Check: `select * from consent_record where employee_id = '<id>' order by consented_at desc;` |
| The app shows **"The privacy notice has changed"** again later | The words changed — usually an AI key added or removed in `.env`, or `RETENTION_DAYS` set. Agree again; that is the point. |
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
| A file is refused: **"The virus scanner could not check this file"** | `CLAMAV_HOST` is in `.env` but ClamAV is not running or still loading. Start it (`docker compose --profile security up -d clamav`) or remove the line and restart **api** and **bot**. |
| The bot says **"I could not download that file from Telegram to check it"** | Documents are now checked on arrival; Telegram's download failed. Send the file again. |
| **"Too many wrong passwords from this device"** | Ten wrong passwords in 15 minutes from that phone. Wait, or restart the **api**. |
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

**Added on 28 Sept (consent notice 2.0)**
- **One notice for Telegram and the app**, naming every service outside our database that the system is
  configured to use, with retention and how to withdraw. Everyone who agreed to an older notice is
  asked again — in Telegram with a button, and in the app.
- **Until someone agrees**, the bot and the dashboard take nothing from them, and messages to them
  wait (except the inbox and the request itself). The API refuses their data too, not just the screen.
- The wording is a **draft** until FreshNow and a lawyer sign it off; Hindi and Malayalam need a native
  speaker — until then everyone sees English.

**Added on 30 Sept (TASK-049, TASK-050)**
- **The phone is an app**: bottom bar Home · My work · Assign · Alerts · More, one page at a time, tables as cards,
  a task as its own page, and the back gesture goes back a page.
- **Progress as a range** (0–10% … 90–100%) with tap-to-fill phrases; totals use the range's midpoint.
- **Policy as code**: `compliance/processors.json` lists every outside service, its country, legal ground,
  contract and controls; rules R0–R6 run at every start (reported in the demo, enforced in production); phone
  numbers, emails, Emirates IDs, IBANs and card numbers are removed from AI prompts (R7); the Compliance page and
  a daily audit snapshot are the evidence (R8); **Download my data** for everyone, **Export** for the CEO.

**Added on 30 Sept (TASK-051 — security in depth)**
- Documents are checked **when they arrive** (Telegram, dashboard) — size, dangerous names, true type, optional
  **ClamAV** virus scan, PDF active content — and a file that must not be passed on is never attached to anything.
- PDFs are read in a **sealed child process** (256 MB, 20 s, no keys in its environment).
- **Browser rules** (Content-Security-Policy and friends) on every page; notification taps open only this app.
- **Sign-in brake**: 10 wrong passwords per phone → 15-minute pause.
- **Backups** with checksum, optional encryption (age), restore test, offline copy; **`pnpm security:scan`**.
- Production now also requires a virus scanner (rule R6).

**Added on 30 Sept (TASK-052 — audit: who gets the work)**
- **A chat assignment is made only when the name fits exactly one person.** "Ask Ahmed to count stock" with two Ahmeds now
  answers *"Ahmed" could be Ahmed Khan or Ahmed Ali* with just those two buttons; a nickname or a name in another script
  gets *"did you mean …?"*. Before, the AI's pick was assigned straight away. Documents show a shared name the same way and
  mark the AI's guesses *"my guess — check"* before the CEO taps Create.
- Phone numbers and emails in a document still never reach the AI, but now **come back in the task** the person receives
  (before, they read "[phone]").
- The retention sweep and "erase this person" now also clear the copies of people's words kept for replay.

**Limits — say them if asked**
- **Policy as code checks what it can see.** It cannot see Groq's console (zero retention is a switch a person
  flips and records in the registry), sign a contract, or decide what the law means. Names are not removed from
  prompts — the document planner routes work by name. Voice notes go to Groq as audio.
- **The tunnel passes through Cloudflare**, a US company. For a demo with test data that is fine; for
  real employee data it is a cross-border transfer. Production needs a domain on a UAE host (see the
  CEO decks), after which the tunnel is not used at all.
- **The phone's board refreshes every 20 seconds, not instantly.** Cloudflare documents that quick tunnels do
  not carry Server-Sent Events, which is how the dashboard hears "something changed"; it then falls back to
  its 20-second refresh (or reopen the app). Notifications are unaffected — they never pass through the
  tunnel. The laptop screens, on `localhost`, stay instant. Taken from Cloudflare's documentation, not observed.
- **A real phone has not been tested by the developer.** Everything up to the push service was tested,
  and the notification display was tested in Chrome; the first real phone is this demo.
- **New staff still join through Telegram** (invite code → bot). An app-only sign-up is not built yet.
- **Files attached to an assignment** are still delivered in Telegram only.
- **Antivirus catches known malware, not everything.** A brand-new sample has no signature yet — that is why the
  other layers stay. Photos are not virus-scanned: Telegram re-encodes them into a new image before we see them.
- **The PDF sandbox is a separate process, not a separate machine.** It has no keys and a memory cap, but it runs as
  the same user; production can move it into its own container.
- **iPhone needs iOS 16.4+** and the Home Screen step; the EU restriction on iPhone web apps does not
  apply in the UAE.
