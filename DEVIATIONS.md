# DEVIATIONS — demo vs. production

The demo mirrors the production architecture. **Behaviour is never mocked.** What
differs is transport, packaging, the LLM vendor, and where voice models run — plus
which *data* is real. Every difference below has a one-line switch back to the
production design. Company-supplied facts are still absent, so all seeded data is
synthetic and flagged `is_synthetic = true` (see `knowledge-base/assumptions.md`).

| # | Production (per specs) | Demo (local) | Why | Switch back to production |
|---|---|---|---|---|
| 1 | Telegram **webhook** + Caddy TLS + secret-token header check | **Long polling** (`getUpdates`) | Local Windows host has no public HTTPS URL | **Built 2026-09-18 (TASK-037).** Set `TELEGRAM_MODE=webhook`, `TELEGRAM_WEBHOOK_SECRET` (≥16 chars), `PUBLIC_URL=https://<domain>`; the bot calls `setWebhook` itself and verifies the header in constant time before grammY sees the body. Caddy proxies `PUBLIC_URL/telegram/webhook` → `127.0.0.1:3002`. Never yet called by Telegram — no domain |
| 2 | Self-hosted **Supabase** stack | **Supabase CLI local stack** since 2026-09-11 (TASK-025): Postgres 17 + Auth + Kong + Studio. Realtime, Storage, the Data API and the Supavisor pooler are left out locally | Same product as production, minus services this system does not use. The pooler is the one real difference: locally every connection is direct | Point `DATABASE_URL`, `DATABASE_URL_SERVICE` and `SUPABASE_URL` at the production project, run `pnpm migrate`, link accounts with `pnpm link:user`. Worker keeps a direct connection; the API may use the transaction pooler |
| 3 | **OpenRouter** via the single LLM wrapper | **Groq primary, OpenRouter fallback, NVIDIA NIM last resort**, all through the same wrapper. The OpenRouter fallback (`openai/gpt-4o-mini`) has worked since 2026-09-12 (TASK-026); before that its key was dead | Groq serves the benchmark-best model (gpt-oss-120b) fastest; OpenRouter is an independent company, so one outage cannot take out both | Put OpenRouter first with `LLM_PROVIDER_ORDER=openrouter,groq,nvidia`, or keep Groq first. Either way pin the upstream for open-weight models (G63) |
| 4 | **No local LLM** (VPS has no GPU) | **Local faster-whisper (STT) + Piper (TTS)** on CPU (Tasks 016/017) | This is a dev machine, not the VPS; STT/TTS are not the reasoning LLM (that still goes to Groq) | Move STT/TTS to a managed API or a GPU node; job interface unchanged |
| 5 | Phase discipline: assignment + NL-query are Phase 2 | **Pulled into the demo** (Tasks 013/014) | The demo must show the closed loop + guarded query to earn trust | No code change; production simply gates them behind the Phase-1 response-rate exit criteria |
| 6 | Retention sweep, off-box backups, Uptime Kuma from Phase 1 | **Retention + erasure built 2026-09-18 (TASK-037), disabled until `RETENTION_DAYS` is set**; backups and Uptime Kuma still deferred | The window is the data controller's decision; backups need the production box | Set `RETENTION_DAYS` (≥30); add the backup job + Uptime Kuma container |
| 7 | Multilingual incl. Arabic | **English + Hindi only** (Arabic deferred at user request) | Arabic STT/TTS quality is poor on Gulf dialect; reduces demo risk | Add Arabic parser examples + Whisper/Piper Arabic models |
| 8 | Blocker routing `(category, site, shift) → resolver` across the org | **Degenerate: everything → CEO** | Company has not supplied the real routing table (questions A7/A8/A9) | Populate `routing_rule` with real resolvers; engine code unchanged |
| 9 | **Next.js** dashboard (Tailwind + shadcn) | **React 19 + Vite + Tailwind 4 app served by the API at `/app/`** (TASK-024/025). With sign-in on, `/` redirects there; the old hand-written page remains only for demo mode | An internal dashboard needs no server rendering; one static build served same-origin needs no CORS and no second server | None required. The RLS-scoped `/dashboard/*` endpoints serve any frontend; move to Next.js only if server rendering is ever needed |
| 10 | Email as a notification channel | **Not built.** `notification_outbox.channel` accepts `email`, the worker picks a sender per channel, and people can express an email preference — but there is no sender and no `employee.email` column | No domain, no provider account, and adding an address is a PDPL step (new consent notice version) — see `docs/EMAIL-SETUP-GUIDE.md` | Add `employee.email`, write `makeEmailSender()`, set `EMAIL_ENABLED=1`. No business logic changes |
| 11 | Web push / PWA as a Telegram-independent channel | **Built 2026-09-19 (TASK-043), shipped OFF.** Proposed in `docs/reports/messaging-resilience.html` | Awaiting a company decision; the in-app inbox already gives a channel that needs no external service | Set VAPID keys in `.env` and switch it on in Dashboard → Alerts → Channels. Needs HTTPS: service workers do not run on a LAN IP |
| 12 | Escalation ladder across a real org | **Degenerate: every rung resolves to the CEO**, because `seed.ts` makes everyone report to the CEO and nobody has `access_role = 'lead'` | The company has not supplied reporting lines (A-T31.2). The ladder mechanism is real and tested with a genuine manager in the fixtures | Enter real managers and leads in the People tab; the ladder needs no code change |
| 13 | LLM tracing | **Configured but off** — `core/llm/langfuse.ts` is written and tested; no API keys are set, so it is inert | Nobody has issued keys yet. A Langfuse instance runs locally on port 3000, belonging to another project's Docker stack | Set `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY`; leave `LANGFUSE_CAPTURE_CONTENT` unset until the consent notice covers prompt text |

## Onboarding note (security preserved, details self-served)

Production requires a manager/CEO-issued **single-use invite code** — identity is never
self-declared (`05-TELEGRAM-DATA-FLOW.md` §3). The demo **keeps that security gate**:
the CEO issues a code (from the dashboard or a `/invite` command). What the demo changes
is that after redeeming the code the **employee self-fills their own descriptive
profile** (department, role, site, shift, language) via chat, instead of the CEO typing
it. The security property — no open self-enrolment — is intact; only non-sensitive
descriptive details are self-provided.

## D10 — Speech-to-text is a hosted API, not a local model [added 2026-09-04]

The plan assumed local faster-whisper on CPU. Groq already serves **whisper-large-v3**
on the key we hold, so voice uses that instead: no Python dependency, and the FULL large
model — materially better on Hindi and Malayalam than a local `small` would be. This also
suits the no-GPU VPS better than the original plan did. Telegram's OGG/Opus is accepted
directly, so no ffmpeg transcode is needed.
**Switch to production:** unchanged — it is already an API call; only the key rotates.

## D11 — Adminer console + services bound to 0.0.0.0 [added 2026-09-04, DEMO ONLY]

So the dashboard and the database console can be opened from the demo phones, the API
(`:3001`) and Adminer (`:8080`) bind `0.0.0.0` instead of `127.0.0.1`. **Anyone on the
same wifi can reach both, and Adminer is unauthenticated until you type the DB password.**
This is acceptable only on a trusted network for a demo.
**Switch to production:** set `HOST=127.0.0.1`, remove the `adminer` service from
`docker-compose.yml`, and reach Postgres over an SSH tunnel only.

## The invariant

Six things now differ from production: **transport** (polling), **DB packaging**
(plain Postgres), **LLM vendor** (Groq/NVIDIA), **STT location** (hosted Whisper),
**network binding** (0.0.0.0 for the phones), and **the Adminer console**.
Everything else — the schema, RLS, deterministic routing/escalation, the outbox, the
audit/replay spine — is the real thing. And only the *data* is synthetic, always
labelled as such.
