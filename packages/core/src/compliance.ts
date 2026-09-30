import { channelAvailability } from "./channels.js";
import { consentNotice } from "./consent.js";
import { retentionDays } from "./retention.js";
import { isProduction, registry, type Finding, type PolicyReport, type readRegistry } from "./compliance-registry.js";

export * from "./compliance-registry.js";

type Env = NodeJS.ProcessEnv;

/**
 * Policy as code — the compliance rules, written down once and checked by the system itself.
 *
 * `compliance/processors.json` (the registry) says where personal data may go: every outside
 * service, its country, the legal ground for sending data there, the contract, and the controls
 * that must be on. This module checks the running configuration against it:
 *
 *   R0  the registry exists and parses
 *   R1  every service the configuration can reach is in the registry
 *   R2  every reachable processor has a ground, and a contract ground has a filed DPA
 *   R3  the host is named and in an allowed country; a laptop is not a production host
 *   R4  every AI provider that reads employee words has zero data retention on
 *   R5  the consent notice names every service that receives personal data (and a host abroad)
 *   R6  production essentials: a retention period, sign-in on, no quick tunnel, no prompt copies,
 *       and a virus scanner for attached files (TASK-051)
 *
 * Demo mode (IS_DEMO not "false") only REPORTS: the local demo runs on synthetic data and must
 * start whatever the registry says. Production (IS_DEMO=false) ENFORCES: the api, worker and bot
 * refuse to start while any rule blocks. Rules R7 (identifiers removed from prompts, llm/redact.ts)
 * and R8 (evidence, compliance-evidence.ts) act per call and per day rather than at start-up.
 *
 * What this cannot do (deck slide 13): sign a contract, decide what the law means, or see a
 * setting inside someone else's console. The registry records what a PERSON confirmed, and when;
 * the code refuses to proceed until they have.
 */

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

interface Detector {
  id: string;
  /** Which setting makes it reachable — named in a finding so the fix is obvious. */
  setting: string;
  reachable: (env: Env) => boolean;
  /** Whether what it receives is personal data, so the notice must name it (R5). */
  personal: (env: Env) => boolean;
  /** A phrase the consent notice must contain when this service receives personal data. */
  noticeMentions: (env: Env) => string;
  /** An AI provider that reads employees' words (R4). */
  ai?: boolean;
}

/**
 * Every outside service the code can send to, and how to tell from the environment whether it
 * will. The same tests the senders and the model client use — `channelAvailability` for
 * channels, "a key is set" for AI providers — so "reachable" cannot disagree with "used".
 */
export const DETECTORS: readonly Detector[] = [
  { id: "telegram", setting: "BOT_TOKEN", reachable: (e) => channelAvailability("telegram", e).available, personal: () => true, noticeMentions: () => "Telegram" },
  { id: "groq", setting: "GROQ_API_KEY", reachable: (e) => !!e.GROQ_API_KEY, personal: () => true, noticeMentions: () => "Groq", ai: true },
  { id: "openrouter", setting: "OPENROUTER_API_KEY", reachable: (e) => !!e.OPENROUTER_API_KEY, personal: () => true, noticeMentions: () => "OpenRouter", ai: true },
  { id: "nvidia", setting: "NVIDIA_API_KEY", reachable: (e) => !!e.NVIDIA_API_KEY, personal: () => true, noticeMentions: () => "NVIDIA", ai: true },
  { id: "webpush", setting: "VAPID_* keys", reachable: (e) => channelAvailability("webpush", e).available, personal: () => true, noticeMentions: () => "Google, Apple or Microsoft" },
  { id: "email", setting: "SMTP_HOST", reachable: (e) => channelAvailability("email", e).available, personal: () => true, noticeMentions: (e) => e.SMTP_HOST ?? "SMTP" },
  { id: "chat", setting: "CHAT_WEBHOOK_URL", reachable: (e) => channelAvailability("chat", e).available, personal: () => true, noticeMentions: (e) => hostOf(e.CHAT_WEBHOOK_URL) ?? "chat" },
  {
    id: "langfuse",
    setting: "LANGFUSE_* keys",
    // Self-hosted on this machine sends nothing anywhere; only an outside instance counts.
    reachable: (e) => !!(e.LANGFUSE_PUBLIC_KEY && e.LANGFUSE_SECRET_KEY) && !LOCAL_HOSTS.has(hostOf(e.LANGFUSE_BASE_URL ?? "http://localhost:3000") ?? "localhost"),
    // Metadata only by default (D97); prompts go only with capture switched on.
    personal: (e) => e.LANGFUSE_CAPTURE_CONTENT === "1",
    noticeMentions: () => "Langfuse",
  },
];

/** True when a request arrived through a Cloudflare quick tunnel (the demo's phone path). */
export function isQuickTunnel(host: string | undefined | null): boolean {
  const h = (host ?? "").split(":")[0]!.toLowerCase();
  return h === "trycloudflare.com" || h.endsWith(".trycloudflare.com");
}

/**
 * Check the configuration against the registry. Pure: the environment and the registry in,
 * findings out — so every rule is a unit test, and `pnpm compliance` and the dashboard show
 * exactly what start-up checked.
 */
export function evaluatePolicy(p: {
  registry: ReturnType<typeof readRegistry>;
  env?: Env;
  /** The Host a request came in on, when checked from a request (quick-tunnel detection). */
  requestHost?: string | null;
  /** The request carried Cloudflare's `cf-ray` header: it passed through Cloudflare's edge. */
  viaCloudflare?: boolean;
}): PolicyReport {
  const env = p.env ?? process.env;
  const production = isProduction(env);
  const findings: Finding[] = [];
  const reachable = DETECTORS.filter((d) => d.reachable(env));

  if ("error" in p.registry) {
    findings.push({ rule: "R0", level: "block", message: p.registry.error, fix: "Restore compliance/processors.json from git, or fix the field named." });
    return { production, findings, refuse: production, reachable: reachable.map((d) => d.id) };
  }
  const reg = p.registry.registry;
  const entry = (id: string) => reg.services.find((s) => s.id === id);

  for (const d of reachable) {
    const s = entry(d.id);
    // R1 — nothing is reachable that nobody registered.
    if (!s) {
      findings.push({
        rule: "R1", level: "block", service: d.id,
        message: `${d.setting} is set, so data can reach "${d.id}", but it is not in the registry.`,
        fix: `Add a "${d.id}" entry to compliance/processors.json (country, ground, DPA), or remove ${d.setting}.`,
      });
      continue;
    }
    // R2 — a ground for every transfer; a contract ground needs the contract.
    if (s.ground.length === 0) {
      findings.push({ rule: "R2", level: "block", service: s.id, message: `${s.name} has no legal ground in the registry.`, fix: "Name the ground (consent, contract) under PDPL Art. 22–23." });
    }
    if (s.ground.includes("not_for_real_data")) {
      findings.push({ rule: "R2", level: "block", service: s.id, message: `${s.name} is registered as demo-only but is configured.`, fix: s.how_to_confirm });
    }
    const contractMissing = s.dpa.status !== "accepted" || !s.dpa.accepted_on;
    if (s.ground.includes("contract") && contractMissing) {
      findings.push({
        rule: "R2", level: "block", service: s.id,
        message: `${s.name}: the registry claims a contract ground but no DPA is filed.`,
        fix: s.dpa.note ?? `File the DPA, then set dpa.status "accepted" and dpa.accepted_on.`,
      });
    } else if (s.role === "processor" && contractMissing) {
      findings.push({
        rule: "R2", level: s.dpa.status === "not_available" ? "block" : "warn", service: s.id,
        message: `${s.name} processes data for FreshNow without a filed processor contract${s.dpa.status === "not_available" ? " — none is offered on this account" : ""}.`,
        fix: s.dpa.note ?? "File the processor's DPA.",
      });
    }
    // R4 — an AI provider reading employees' words keeps nothing.
    if (d.ai) {
      if (s.controls.zero_data_retention !== true || !s.controls.confirmed_on) {
        findings.push({
          rule: "R4", level: "block", service: s.id,
          message: `${s.name}: zero data retention is not confirmed on.`,
          fix: s.how_to_confirm,
        });
      }
      if (s.id === "openrouter" && s.controls.data_collection !== "deny") {
        findings.push({ rule: "R4", level: "block", service: s.id, message: "OpenRouter may route to providers that store prompts (data_collection is not 'deny').", fix: s.how_to_confirm });
      }
    }
  }

  // R3 — where the database lives.
  if (!reg.hosting_countries_allowed.includes(reg.hosting.country)) {
    findings.push({ rule: "R3", level: "block", message: `The host country ${reg.hosting.country} is not in hosting_countries_allowed (${reg.hosting_countries_allowed.join(", ")}).`, fix: "Host in an allowed country (the deck recommends the UAE)." });
  }
  if (reg.hosting.provider === "this-computer") {
    findings.push({ rule: "R3", level: "block", message: "The registry names a laptop as the host — fine for the demo, not for employees' real data.", fix: "Set hosting to the production server and its country before real data goes in." });
  }

  // R5 — the notice names everyone who receives personal data (built from the same env).
  const notice = consentNotice("en", env);
  for (const d of reachable) {
    if (!d.personal(env)) continue;
    const mention = d.noticeMentions(env);
    if (!notice.includes(mention)) {
      findings.push({ rule: "R5", level: "block", service: d.id, message: `The consent notice does not name "${mention}", which receives personal data.`, fix: "Add it to dataRecipientLines() in consent.ts; everyone is then asked again." });
    }
  }
  if (reg.hosting.country !== "AE" && !notice.includes(reg.hosting.name)) {
    findings.push({ rule: "R5", level: "block", message: `The database is hosted outside the UAE (${reg.hosting.country}) but the notice does not name the host.`, fix: "Add a host line to the notice (PDPL Art. 23(1)(b) consent must be specific)." });
  }

  // R6 — production essentials.
  const days = retentionDays(env);
  if (days === null) {
    findings.push({ rule: "R6", level: "block", message: "No retention period (RETENTION_DAYS): employees' own words are kept indefinitely.", fix: "The company chooses a number of days (at least 30); set RETENTION_DAYS and retention_days in the registry." });
  } else if (reg.retention_days !== null && reg.retention_days !== days) {
    findings.push({ rule: "R6", level: "warn", message: `RETENTION_DAYS is ${days} but the registry says ${reg.retention_days}.`, fix: "Make them agree — the registry is the record of processing." });
  }
  if (!env.SUPABASE_URL) {
    findings.push({ rule: "R6", level: "block", message: "Sign-in is off (no SUPABASE_URL): anyone who reaches the dashboard sees every employee's data.", fix: "Configure Supabase Auth." });
  }
  if (!env.CLAMAV_HOST) {
    // PDPL Art. 20 asks for technical measures that fit the risk. Here the risk is concrete:
    // employees' phones and the CEO's inbox are where malicious files come from, and every
    // attachment is opened by this server next to all of their data.
    findings.push({ rule: "R6", level: "block", message: "No virus scanner (CLAMAV_HOST): files people attach are opened without a malware scan.", fix: "Start ClamAV (docker compose --profile security up -d clamav) and set CLAMAV_HOST — COMMANDS.md §7d." });
  }
  if (isQuickTunnel(hostOf(env.PUBLIC_URL))) {
    findings.push({ rule: "R6", level: "block", message: "PUBLIC_URL is a Cloudflare quick tunnel: Cloudflare decrypts that traffic.", fix: "Use the company's own domain and certificate." });
  }
  if ((p.requestHost !== undefined && isQuickTunnel(p.requestHost)) || p.viaCloudflare) {
    findings.push({
      rule: "R6", level: "block", service: "cloudflare_quick_tunnel",
      message: `This page was reached through ${isQuickTunnel(p.requestHost) ? "a Cloudflare quick tunnel" : "Cloudflare"}. Cloudflare decrypts this traffic at its edge, sign-in included.`,
      fix: "Synthetic data and test accounts only. Real employees use the company's own domain.",
    });
  }
  if (env.LANGFUSE_CAPTURE_CONTENT === "1" && DETECTORS.find((d) => d.id === "langfuse")!.reachable(env)) {
    findings.push({ rule: "R6", level: "warn", service: "langfuse", message: "Prompts — employees' own words — are copied to an outside tracing service.", fix: "Turn LANGFUSE_CAPTURE_CONTENT off for real data (D97)." });
  }

  return { production, findings, refuse: production && findings.some((f) => f.level === "block"), reachable: reachable.map((d) => d.id) };
}

/**
 * Run at the start of the api, worker and bot. Demo: one summary line — nothing is enforced.
 * Production: every finding is printed and a blocking one stops the process, because a system
 * that starts anyway has made the violation the default.
 */
export function checkPolicyAtStartup(service: string, env: Env = process.env): PolicyReport {
  const report = evaluatePolicy({ registry: registry(env), env });
  const blocks = report.findings.filter((f) => f.level === "block");
  if (!report.production) {
    console.log(
      `[${service}] policy: demo mode, not enforced — ${blocks.length} rule(s) would stop production, ` +
        `${report.findings.length - blocks.length} warning(s). Details: pnpm compliance, or the dashboard's Compliance page.`,
    );
    return report;
  }
  for (const f of report.findings) console.log(`[${service}] policy ${f.rule} ${f.level.toUpperCase()}${f.service ? ` (${f.service})` : ""}: ${f.message} → ${f.fix}`);
  if (report.refuse) {
    throw new Error(`[${service}] refusing to start: ${blocks.length} compliance rule(s) block production (IS_DEMO=false). Run pnpm compliance.`);
  }
  console.log(`[${service}] policy: production — all rules pass${report.findings.length ? ` (${report.findings.length} warning(s))` : ""}.`);
  return report;
}
