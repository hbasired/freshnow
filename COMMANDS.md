# Commands — running FreshNow yourself

Everything you need to start, check, reset and stop the system. Run these from the project
folder in **one terminal per service** (PowerShell or Git Bash both work):

```
cd C:\Users\acer\Downloads\freshnow
```

---

## 0 · Get the latest code (`git pull`)

New work arrives as a pull request on GitHub. Once it is **merged**, it is on `main`:

```powershell
cd C:\Users\acer\Downloads\freshnow
git status                                 # anything listed as modified is yours: git stash (or commit it) first
git checkout main
git pull origin main
```

To try work **before** its pull request is merged, pull its branch instead (the name is on the pull
request page), then go back to `main` afterwards:

```powershell
git fetch origin
git checkout claude/elegant-curie-bgpzqh   # the branch name from the pull request
git pull origin claude/elegant-curie-bgpzqh
git checkout main                          # later, to go back
```

Then, **after every pull** — with Docker and Supabase running (§1):

```bash
pnpm install                               # new or updated packages
pnpm migrate                               # new database changes — safe every time: already-applied ones print "skip"
pnpm build:web                             # the dashboard at /app/ — build output, not in git
```

and restart the **api**, **worker** and **bot** windows (`Ctrl+C`, start again) — they run the code as
it was when they started. Leave the **tunnel**, Docker and Supabase running; reload the browsers (on a
phone: close and reopen the app). Details: `DEMO-GUIDE-APP.md` §1.1.

> **Skipping `pnpm migrate` breaks the dashboard** whenever a pull adds a migration: the task lists
> fail with *Request failed (500)* and the api window logs `column … does not exist`. Run it, restart
> the api. (TASK-049 added `0018_progress_band.sql`; TASK-053 adds `0020_email.sql` and `0021_task_number.sql`.)

---

## 1 · Start, in this order

```bash
docker compose up -d                       # Redis + the old Postgres (rollback copy) + Adminer
docker compose --profile security up -d clamav   # OPTIONAL virus scanner — see §7d before turning it on

npx supabase start -x realtime,storage-api,imgproxy,edge-runtime,logflare,vector,supavisor,mailpit,postgrest

pnpm migrate                               # only needed after a pull (§0); harmless otherwise

pnpm start:api                             # terminal 1 — leave it running
pnpm start:worker                          # terminal 2 — leave it running
pnpm start:bot                             # terminal 3 — leave it running

cloudflared tunnel --url http://localhost:3001   # terminal 4 — only for the phone/app demo; leave it running

pnpm urls                                  # the addresses to use right now (the phone's is the "Phone" line)
```

The app demo (phone notifications) needs the tunnel: `cloudflared` gives the laptop an `https://` address the
phone can use. Install it once with `winget install --id Cloudflare.cloudflared`. Every restart of the tunnel
gives a **new** address, so keep terminal 4 running for the whole demo. Cloudflare can read what passes through a
quick tunnel — test accounts and the synthetic data only. Full walk-through: **`DEMO-GUIDE-APP.md` §3 and §5.3**.

**Local-only start** (this PC only — nothing reachable from the Wi-Fi, so a changing
Wi-Fi address does not matter):

```powershell
$env:HOST = "127.0.0.1"; pnpm start:api    # PowerShell
HOST=127.0.0.1 pnpm start:api              # Git Bash
```

The worker and bot are started exactly as above; they never listen on the network. Supabase
already binds to `127.0.0.1` only. The dashboard is then **http://localhost:3001/app/** and
Supabase Studio **http://127.0.0.1:54323**; the Wi-Fi address is refused on purpose.

Wait until each terminal prints its ready line:

| Service | Ready line |
|---|---|
| api | `API listening on http://127.0.0.1:3001 — React dashboard at .../app/` |
| worker | `[worker] outbox relay every 3000ms; sla_sweep every 60000ms` (and one line per channel sender it found keys for — `web push sender ready`, `email sender ready`, `chat sender ready`; with the inbox set up, `email inbox <address>: checked every 60s (BullMQ job scheduler)` — §7f) |
| bot | `[bot] @freshnow1bot polling concurrently …` |
| tunnel | an `https://<words>.trycloudflare.com` address (the exact lines vary by `cloudflared` version) — `pnpm urls` then shows `Phone … HTTP 200` |

Each of api, worker and bot first prints one **`policy: demo mode, not enforced — N rule(s) would stop
production`** line. That is expected: the configuration is checked against `compliance/processors.json`
(policy as code, §7c) and in the demo nothing is blocked. **`refusing to start`** means `.env` has
`IS_DEMO=false` — remove it for the demo.

Supabase takes about 30 seconds on a warm machine. `docker compose up -d` is instant. ClamAV's first
start takes several minutes (it downloads its virus signatures); later starts about a minute.

---

## 2 · Check it is actually working

```bash
pnpm urls                                  # addresses, bot reachability, containers, which database
curl http://localhost:3001/health          # {"status":"ok","db":"ok","redis":"ok","antivirus":"not_configured" | "ok" | "down", ...}
docker ps                                  # 5 supabase_* + 3 freshnow-* containers
```

`pnpm urls` is the one to trust: **your Wi-Fi address changes** whenever the laptop
reconnects, so check it before every demo rather than reusing an old link.

---

## 3 · Open the dashboard

- **On this PC:** http://localhost:3001/app/
- **On your phone:** the address `pnpm urls` prints, e.g. `http://10.74.102.148:3001/app/`
  (not available after a local-only start — see §1)
- **Supabase Studio** (look inside the database): http://127.0.0.1:54323
- **Supabase API / sign-in:** http://127.0.0.1:54321 — the dashboard uses it; you do not open it

Sign-in accounts (and their passwords) are in **`CREDENTIALS.local.md`**, which git ignores.

Since 2026-09-28 the phone reaches **one** port on this laptop: `3001`. Sign-in goes through
the dashboard's own address (the API passes it to Supabase), so port 54321 no longer has to be
open. If the dashboard does not load on the phone, allow 3001 once, in **PowerShell run as
Administrator**:

```powershell
New-NetFirewallRule -DisplayName "FreshNow demo" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3001
```

**Phone notifications need HTTPS**, which the Wi-Fi address is not. For the web push / in-app
demo use the tunnel in **`DEMO-GUIDE-APP.md` §3** — one command, and it also means the phone does
not need to be on the same Wi-Fi.

---

## 4 · Stop everything

```bash
# Ctrl+C in the three service terminals, then:
npx supabase stop                          # keeps all data
docker compose stop                        # keeps all data
```

If you started the services in the background and lost the terminals:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'packages/(api|bot|worker)/src/index.ts' } |
  ForEach-Object { taskkill /PID $_.ProcessId /T /F }
```

> `npx supabase stop --no-backup` **deletes the Supabase database**. Only use it when a
> start fails with `network supabase_network_freshnow not found`, and expect to restore data.

---

## 5 · Reset between test runs

Always look first — `--dry-run` changes nothing and prints what is there:

```bash
npx tsx scripts/reset-employee.ts --telegram 8903000291 --dry-run
```

| What you want | Command |
|---|---|
| Wipe what an employee did, keep them registered | `npx tsx scripts/reset-employee.ts --telegram 8903000291 --activity` |
| Wipe what the CEO did (assignments, files, reports) | `npx tsx scripts/reset-employee.ts --ceo --activity` |
| Unregister an employee so they can onboard again | `npx tsx scripts/reset-employee.ts --telegram 8903000291` |
| Remove a colleague you registered while testing | `npx tsx scripts/reset-employee.ts --name "Their Name"` |
| Remove every real (non-DEMO) person | `npx tsx scripts/reset-employee.ts --all-real` |
| Also clear the DEMO staff | add `--include-demo` |

It never deletes the CEO row, never touches the audit log, and keeps the five `DEMO –`
employees so the dashboard still has something to show.

Your two Telegram accounts: **CEO `6051615734`**, **employee (Hemanth) `8903000291`**.

Bring back the demo history if you ever clear it: `pnpm seed`.

---

## 6 · Dashboard accounts

```bash
pnpm link:user "Hemanth" hemanth@freshnow.local                 # creates the login, prints a password once
pnpm link:user "Hemanth" hemanth@freshnow.local NewPassword123  # changes the password
pnpm link:user "DEMO CEO" ceo@freshnow.local
```

Record any new password in `CREDENTIALS.local.md`.

---

## 7 · Checks, tests and reports

```bash
pnpm verify            # typecheck + the full test suite (~670 tests, ~3 minutes, makes real model calls)
pnpm e2e               # 19 end-to-end checks against the real database and model — sends real Telegram messages
python scripts/render-guides.py   # re-render docs/guides/*.html from the .md guides (DB-WALKTHROUGH, BACKEND-OPERATIONS, FRESH-RUN, CHANNELS-GUIDE)
pnpm test              # tests only
pnpm typecheck
pnpm migrate           # apply any new migrations to the live database (21 so far)
pnpm email:check       # can this machine log in to the mail server (send + read)? sends nothing (§7f)
pnpm email:setup       # store the demo's two email addresses on the right people (§7f)
pnpm compliance        # the policy checks, the record of processing and the evidence (§7c)
pnpm security:scan     # secrets in git, dependency advisories, virus-scanner self-test; with Docker also gitleaks/OSV/Trivy (§7d)
pnpm backup            # database backup + checksum; then backup:verify, backup:restore-test (§7e)
pnpm bench             # benchmark models (costs a few cents)
pnpm bench:report      # rebuild docs/reports/model-benchmark.html
```

Nine tests need a live model provider: eight call the model for real (and **fail with a 30 s
timeout whenever Groq is slow** — it was timing out at 25 s per call on 19 Sep 2026), and one
checks the fall-back to a second provider, so it needs two provider keys in `.env`. The other 657
do not depend on a provider (counted 5 Oct 2026, TASK-053) — the ClamAV file needs ClamAV running (or is
skipped unless `CLAMAV_TEST_HOST=127.0.0.1` is set), and four inbox tests are skipped unless
`EMAIL_TEST_IMAP_HOST` points at a test mail server. The eight real-model tests are the ones
that read documents and messages into assignments: **run `pnpm test` with a working Groq key after this update**
to see routing with the live model. `curl localhost:3001/health` shows `load.llm`
if you want to know before running.

---

## 7b · Notification channels (all shipped OFF except Telegram)

The CEO switches a channel on in **Dashboard → Alerts → Channels**. A switch only does
something when the server also has the keys for that channel in `.env`:

| Channel | Keys in `.env` | Needs |
|---|---|---|
| Telegram | `BOT_TOKEN` | nothing — live today |
| Dashboard inbox | — | nothing — always on |
| Web push (phone/desktop notifications) | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | an **https** address (localhost works for testing) |
| Email out | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` (+ `EMAIL_ALLOWLIST`) | Gmail + an App Password (demo, §7f) — or a domain + an SMTP account |
| Email in — replies and work by email | `EMAIL_IMAP_HOST`, `EMAIL_IMAP_USER`, `EMAIL_IMAP_PASS`, `EMAIL_INBOX_ADDRESS` | the same Gmail account (§7f); Redis running (the worker reads it through BullMQ) |
| Email in — webhook (domain only) | `INBOUND_EMAIL_SECRET` (≥ 16 chars) | Cloudflare Email Routing → `POST /inbound/email` |
| Company chat | `CHAT_WEBHOOK_URL` | a Mattermost (or any) incoming webhook |

```bash
npx web-push generate-vapid-keys                       # once; paste into .env, never into a report
docker compose -f docker-compose.mattermost.yml up -d  # ONLY if you decide to run a chat server (~2 GB RAM)
docker compose -f docker-compose.mattermost.yml down
```

Restart the worker after changing any of these keys — it builds its senders at start-up.
Details and what to click: `CHANNELS-GUIDE.md` (rendered at `docs/guides/channels-guide.html`).

---

## 7c · Policy as code — the compliance checks

`compliance/processors.json` is the registry: every outside service personal data can reach, its country,
the legal ground (PDPL Art. 22–23), the contract (DPA) and the controls that must be on. The api, worker and bot
check the configuration against it at every start; the CEO sees the same checks on **Records → Compliance**.

```bash
pnpm compliance                  # as configured now — the demo reports, never blocks
pnpm compliance --production     # what a production start (IS_DEMO=false) would check; exits 1 if anything blocks
```

| Rule | Checks | Fix by |
|---|---|---|
| R0 | the registry exists and parses | restore it from git |
| R1 | every service the config can reach (a key in `.env`) is registered | add an entry, or remove the key |
| R2 | a legal ground; a "contract" ground has a filed DPA | file the DPA, set `dpa.status` and `dpa.accepted_on` |
| R3 | the host is named and in an allowed country — not a laptop | set `hosting` to the real server |
| R4 | AI providers keep nothing (zero data retention, confirmed with a date) | switch it on in the provider's console, then record it |
| R5 | the consent notice names every service receiving personal data, and a host abroad | the notice is built from `.env`; a host abroad needs a line |
| R6 | a retention period, sign-in on, **a virus scanner**, no quick tunnel, no prompt copies to tracing | set `RETENTION_DAYS`, `SUPABASE_URL`, `CLAMAV_HOST` (§7d); use a real domain |
| R7 | every AI prompt has phone numbers, emails, Emirates IDs, IBANs, card numbers removed | automatic — counted per call in `llm_call.redacted` |
| R8 | evidence: consent by version, transfers, removals, retention, rights — plus a daily snapshot in the audit log | automatic (the worker) |

Edit the registry when a contract is filed or a setting is switched on, then restart the api, worker and bot.
Everyone can **Download my data** (Alerts → Your consent); the CEO can **Export** anyone's (People).

---

## 7d · Security in depth — what protects the system, and how to check it

Every file anyone sends (a PDF from the CEO, a document from an employee's phone, an upload in the
dashboard) and every page the phones open passes through these layers. All open source. (Email in carries
text only — attachments are not read.)

| Layer | What it stops | Where |
|---|---|---|
| File gate: size, dangerous names (`.exe`, `.apk`, `.js`, double extensions), true type from the bytes | executables dressed as documents | `document-security.ts` |
| **ClamAV virus scan** before anything opens a file | known malware, ransomware droppers, macro viruses | `antivirus.ts` · `docker compose --profile security up -d clamav` |
| PDF active content (JavaScript, auto-actions, launch, embedded files) — readable, never passed on | booby-trapped PDFs reaching another phone | `document-security.ts` |
| **PDF reader in a sandbox**: a separate process, 256 MB, 20 s, no keys in its environment | parser exploits (e.g. CVE-2024-4367) and "PDF bombs" taking the server down | `pdf-sandbox.ts` |
| Documents sent in Telegram are checked **on arrival**, not only when read | an unchecked file forwarded from one phone to another | `attachments.ts` (`gateIncomingDocument`) |
| Browser rules on every page (Content-Security-Policy, no framing, nosniff…) | an injected script running, or sending data anywhere | `api/src/security-headers.ts` |
| Sign-in brake: 10 wrong passwords per device → 15-minute pause | password guessing through the tunnel | `routes/auth-proxy.ts` |
| Notification taps open only this app's pages | a forged push sending someone to a phishing page | `dashboard/public/sw.js` |
| Prompt-injection screening, rate limits, audit log | (unchanged — earlier tasks) | `injection.ts`, `rate-limit.ts` |
| Backups: checksummed, optionally encrypted, restore-tested, one copy offline | ransomware, deletion, a dead disk | §7e |
| Supply-chain scans: pinned versions, pnpm's 1-day release quarantine, audits | a poisoned package or scanner image | `pnpm security:scan` |

**Turning the virus scanner on (optional in the demo, required in production):**

```powershell
docker compose --profile security up -d clamav    # first time: several minutes to download signatures
docker logs -f freshnow-clamav                    # wait for clamd to say it is listening; Ctrl+C to stop watching
```

Then add to `.env` and restart the **api** and **bot**:

```
CLAMAV_HOST=127.0.0.1
```

```powershell
curl http://localhost:3001/health                 # "antivirus":"ok"
pnpm security:scan                                # first line: virus scanner self-test ✓ (EICAR refused)
```

Once `CLAMAV_HOST` is set, a file is **refused if ClamAV is down** (fail closed — a scanner that can be
bypassed by stopping it is not a scanner). ClamAV holds its signatures in memory: give Docker Desktop at
least **4 GB** (Settings → Resources). To switch it off again: remove the line, restart api and bot, then
`docker compose --profile security stop clamav`.

**The supply-chain scan:**

```powershell
pnpm security:scan
```

Always: tracked secret files, `pnpm audit` (HIGH/CRITICAL fail it), the ClamAV self-test. With Docker Desktop
running it also runs **gitleaks** (every commit, no network), **OSV-Scanner** and **Trivy** in containers, on a
fresh clone in a temp folder — never this folder, whose `.env` holds the real keys. The images are pinned:
Trivy's own releases were hijacked in March 2026 (0.69.4–0.69.6); 0.69.3 is the release its advisory names as
clean. First run downloads the images (~300 MB).

---

## 7e · Backups — ransomware resilience (3-2-1-1-0)

Three copies, two kinds of media, one off site, **one offline**, **zero errors** on a restore test.

```powershell
pnpm backup                   # dump → backups\freshnow-<time>.dump + .sha256 + .json; keeps the newest 14
pnpm backup:verify            # checksum + the archive's table of contents (newest; or give a file name)
pnpm backup:restore-test      # restores into a scratch database, counts rows, drops it
```

With Supabase running, `pg_dump` runs **inside** its container — nothing to install on Windows. Every backup and
restore test is recorded in the audit log and shown on **Records → Compliance → Security**.

**Encrypt them** before a copy leaves the laptop (age — open source; the server gets only the public half):

```powershell
winget install --id FiloSottile.age           # once
age-keygen -o freshnow-backup.key             # once — prints "Public key: age1…"
```

Put the **public** key in `.env` as `BACKUP_AGE_RECIPIENT=age1…`. Move `freshnow-backup.key` to a USB drive or a
password manager — **not** this laptop or the server: whoever has it can read every backup. To check an
encrypted backup, point to it only for that command:

```powershell
$env:BACKUP_AGE_IDENTITY = "E:\freshnow-backup.key"; pnpm backup:restore-test; Remove-Item Env:BACKUP_AGE_IDENTITY
```

**The offline copy** — the part ransomware cannot touch (E: is the USB drive):

```powershell
robocopy backups E:\freshnow-backups /E /XO     # copy new backups
# then eject the drive and unplug it
```

**Daily** on the production server (cron is UTC — 22:15 UTC is 02:15 in Dubai):

```bash
15 22 * * * cd /opt/freshnow && (pnpm backup && pnpm backup:verify) >> backups/backup.log 2>&1   # /opt/freshnow = your install folder
```

A restore test once a month is the minimum; after any change to the database version, run one the same day.

---

## 7f · Email — tasks out, replies in (TASK-053)

Work and alerts go out by email; replies come back and are filed as updates. The demo uses two personal
Gmail accounts — the CEO's sends and reads, Hemanth's only receives and replies. Full walk-through and demo
acts: **`EMAIL-DEMO-GUIDE.md`** (rendered at `docs/guides/email-demo-guide.html`).

Once, on the CEO's Google account: turn on 2-Step Verification, then create an **App Password** at
https://myaccount.google.com/apppasswords. Then in `.env` (real addresses only here — never in a file git
uploads):

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=<CEO Gmail>
SMTP_PASS=<App Password, no spaces>
EMAIL_FROM="FreshNow Ops <CEO Gmail>"
EMAIL_IMAP_HOST=imap.gmail.com
EMAIL_IMAP_USER=<CEO Gmail>
EMAIL_IMAP_PASS=<the same App Password>
EMAIL_INBOX_ADDRESS=<CEO Gmail with +freshnow before the @>
EMAIL_ALLOWLIST=<CEO Gmail>,<Hemanth Gmail>
EMAIL_CEO_ADDRESS=<CEO Gmail>
EMAIL_EMPLOYEE_ADDRESS=<Hemanth Gmail>
EMAIL_EMPLOYEE_NAME=Hemanth
```

```powershell
docker compose up -d          # Redis — the worker's inbox checks run as BullMQ jobs
pnpm migrate                  # 0020_email.sql, 0021_task_number.sql
pnpm email:check              # ✓ sending … ✓ reading … — logs in, sends nothing
pnpm email:check --send       # optional: one test email to each address on EMAIL_ALLOWLIST
pnpm email:setup              # addresses onto the CEO and Hemanth, email channel on, sensible opt-ins; safe to re-run
```

Restart the **api**, **worker** and **bot**. The worker then prints `email sender ready` and `email inbox …:
checked every 60s`. `curl http://localhost:3001/health` shows `"email":{"sending":true,"receiving":true,…}`.
The privacy notice now names email, so each person taps **I agree** once more.

| Rule | Why |
|---|---|
| Nothing is sent to, or accepted from, an address not on `EMAIL_ALLOWLIST` | no one else can be emailed by mistake during the demo |
| Only mail **to the `+freshnow` address** is read; nothing is marked read, moved or deleted | the CEO's own mail is never touched |
| A reply finds its task by the key in the subject (`[FN-42]`), else by the email thread | the Jira pattern — survives a changed subject |
| The sender must pass Google's SPF/DKIM/DMARC checks (or be the account's own Sent mail) and be the task's owner | a forged From: cannot file an update |
| Email from the CEO or a manager becomes a **proposal** (Assign → From email); nothing is assigned until someone taps | the LLM never decides who |
| A model outage leaves an email unread; it is retried every 5 minutes, at most 4 times | bounded retries |

---

## 8 · When something is wrong

| Symptom | Cause and fix |
|---|---|
| Bot does not answer | Check the Telegram line in `pnpm urls`. If it says it cannot reach Telegram, it is the Wi-Fi, not the code — it retries by itself. Otherwise restart `pnpm start:bot`. |
| Phone cannot open the dashboard | The Wi-Fi address changed (`pnpm urls`), the phone is on another network, or the firewall rule in §3 is missing. |
| Dashboard loads, sign-in spins or says "Sign-in service is not reachable" | Supabase is not running (`npx supabase start …`, §1). Sign-in goes through port 3001, so no firewall rule for 54321 is needed. |
| `/app/` is a 404, or the dashboard looks like it did before a pull | Not rebuilt: `pnpm build:web`, then restart the api. |
| After a pull, the task lists say **Request failed (500)**; the api window logs `column … does not exist` | A migration was not applied: `pnpm migrate`, then restart the api. |
| A window says **`refusing to start: N compliance rule(s) block production (IS_DEMO=false)`** | `.env` has `IS_DEMO=false`. For the demo delete that line. For a real deployment fix what `pnpm compliance --production` lists (§7c). |
| The phone's address stopped working | The tunnel was restarted or closed — it has a new address now: `pnpm urls`, send the `Phone` line to the phone again, and turn notifications on again there. |
| `git pull` refuses: *"Your local changes … would be overwritten"* | You changed a tracked file. `git stash`, pull, then `git stash pop` (or `git stash drop` if you do not need the change). |
| Nothing arrives in Telegram | The worker is not running; it is what delivers messages. |
| "429" or slow replies | The provider rate-limited us; the wrapper backs off and falls through the provider order (`LLM_PROVIDER_ORDER`). `curl localhost:3001/health` shows `load.llm`. |
| `supabase start` fails, "network … not found" | Leftover containers from an interrupted start: `npx supabase stop`, then start again. Only if that fails: `npx supabase stop --no-backup` (this wipes Supabase data). |
| Want to look inside the database | Supabase Studio: http://127.0.0.1:54323 |
| A channel shows **NOT SET UP** in Alerts → Channels | Switched on, but `.env` has no keys for it (§7b). Add them and restart the worker. |
| Notifications say "need a secure (https) address" | You are on the Wi-Fi IP. Use `http://localhost:3001` on this PC; a phone needs the Cloudflare tunnel address (DEMO-GUIDE-APP.md §3) or, in production, a domain. |
| A file is refused: *"The virus scanner could not check this file"* | `CLAMAV_HOST` is set but ClamAV is not running or is still loading signatures: `docker compose --profile security up -d clamav`, `docker logs freshnow-clamav`. Or remove `CLAMAV_HOST` from `.env` and restart api and bot. |
| *"Too many wrong passwords from this device"* | Ten wrong passwords in 15 minutes from that phone. Wait, or restart the api (the count is in memory). |
| The bot says *"I could not download that file from Telegram to check it"* | Documents are checked on arrival now; Telegram's file download failed. Send the file again. |
| `pnpm backup` fails with *"server version mismatch"* | The local `pg_dump` is older than the database. Start Supabase (the backup then runs inside its container) or set `BACKUP_PG_CONTAINER=supabase_db_freshnow`. |
| `pnpm security:scan` fails on `pnpm audit` | A new advisory. Update the package (`pnpm update <name>`) or add an override in `pnpm-workspace.yaml`, then run it again. |
| `pnpm install` says a version is *"within the minimumReleaseAge cutoff"* | pnpm's quarantine: it will not install a version published in the last 24 h. Wait a day, or pick the previous version — do not add an exclusion. |
| `pnpm email:check` → `✗ sending: Invalid login` / `535`, or `✗ reading: Invalid credentials` | Not an App Password, or 2-Step Verification is off. Paste the 16 letters without spaces; `EMAIL_IMAP_USER` is the full address (§7f). |
| The worker says `background jobs could not start (is Redis running?)` | `docker compose up -d`, then restart the worker. Telegram and email still go out meanwhile; only reading the inbox waits. |
| An emailed reply did nothing | Dashboard → Records → Email lists every email and what became of it: *refused — not on EMAIL_ALLOWLIST*, *ignored — has not agreed to the notice*, *ignored — nothing written above the quote*. Not listed at all → the worker or Redis is not running. |
| `pnpm email:setup` says a name *fits 2 people* or *nobody is called* | Set `EMAIL_EMPLOYEE_NAME` in `.env` to the name exactly as FreshNow shows it. |
| `pnpm start:api` prints "AUTHENTICATION IS OFF … This is demo mode" | `SUPABASE_URL` is missing from `.env` (or misspelt) **and** the API is on the network (`0.0.0.0`). Fix `.env`; the warning is silenced only by a real `SUPABASE_URL` or by binding `HOST=127.0.0.1` (§1). |

Quick database look:

```bash
docker exec supabase_db_freshnow psql -U postgres -d postgres -c "select display_name, status, telegram_user_id from employee order by display_name"
```

---

## 9 · Where things live

| What | Where |
|---|---|
| Secrets and settings | `.env` (git-ignored) |
| Security layers (TASK-051) | `packages/core/src/{antivirus,pdf-sandbox,document-security,attachments}.ts` · `packages/api/src/security-headers.ts` · `scripts/{backup,security-scan}.ts` |
| Backups | `backups\` (git-ignored — it holds employee data) · the key file: offline, never here |
| Where personal data may go (policy as code) | `compliance/processors.json` · checks `packages/core/src/compliance.ts` · `pnpm compliance` |
| Dashboard logins | `CREDENTIALS.local.md` (git-ignored) |
| Demo runbook | `DEMO-GUIDE.md` |
| What state the system is in | `SESSION-STATUS.md` |
| Reports | `docs/reports/` · task write-ups `docs/tasks/` · CEO decks `docs/reports/ceo-deck-hostinger-final-verdict.html` (Hostinger, Groq, OpenRouter — latest), `ceo-deck-azure-aws-uae.html`, `ceo-deck-data-residency.html` |
| Guides for people | `docs/guides/index.html` (rendered from the `.md` files at the root) |
| Channel keys (VAPID, SMTP, IMAP, chat) | `.env` — templates and comments in `.env.example` |
| Email (TASK-053) | `packages/core/src/email-{reply,config,outbound,inbound,people}.ts` · `packages/worker/src/{email-inbox,email-sender,jobs}.ts` · `scripts/email-setup.ts` · tables `email_message`, `email_proposal` |
| Context scoping (only what a request needs reaches a prompt) | `packages/core/src/context-scope.ts` · `query/schema-prune.ts` |
| Optional chat server | `docker-compose.mattermost.yml` (separate file; never starts by itself) |
| Live database | Supabase Postgres on `127.0.0.1:54322` · Studio `:54323` |
| Old database (rollback copy) | `localhost:5433` · Adminer `http://localhost:8080` |
