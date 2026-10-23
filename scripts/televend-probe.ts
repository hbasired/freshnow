/**
 * Televend probe (TASK-055): what can the connector read, and in what shape?
 *
 *   pnpm televend:probe [--day 2026-10-12]
 *
 * Read-only by construction: every request goes through TelevendClient, so anything not on
 * the allow-list is refused before it leaves this machine (GET only, plus the one sign-in).
 * Paced at the configured minimum interval (1 request/second by default).
 *
 * What it prints: field names, types, counts, pagination — never a person's name or e-mail.
 * What it saves: the raw JSON of each response under private-data/televend-probe/ (git-ignored),
 * so schemas and synthetic test fixtures can be written from the real shapes.
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  HOSTS,
  PasswordSession,
  TelevendClient,
  readTelevendConfig,
  type CallRecord,
} from "../packages/televend/src/index.js";

const args = process.argv.slice(2);
const dayArg = args[args.indexOf("--day") + 1];
const day = args.includes("--day") && dayArg ? dayArg : "2026-10-12";
if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("--day must be YYYY-MM-DD");

const config = readTelevendConfig();
if (!config || config.mode !== "bridge" || !config.username || !config.password) {
  throw new Error("Set TELEVEND_MODE=bridge with TELEVEND_USERNAME/TELEVEND_PASSWORD in .env");
}

const outDir = join("private-data", "televend-probe", day);
mkdirSync(outDir, { recursive: true });

const calls: CallRecord[] = [];
const session = new PasswordSession({ username: config.username, password: config.password }, { fetch: globalThis.fetch as never, now: Date.now });
const client = new TelevendClient(session, {
  tenantId: config.tenantId,
  companyId: config.companyId,
  minIntervalMs: Math.max(config.minIntervalMs, 1_000),
  onCall: (c) => calls.push(c),
});

const T = `tenants/${config.tenantId}/companies/${config.companyId}`;
const C = config.companyId;
// The company's day in Asia/Dubai (UTC+4, no daylight saving).
const from = `${day}T00:00:00+04:00`;
const nextDay = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const to = `${nextDay}T00:00:00+04:00`;

/** Shape of a JSON value: keys and types, recursing into the first array element. */
function shape(v: unknown, depth = 0): unknown {
  if (depth > 4) return "…";
  if (Array.isArray(v)) return v.length ? [shape(v[0], depth + 1), `(${v.length} items)`] : ["(empty)"];
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, shape(x, depth + 1)]));
  }
  return v === null ? "null" : typeof v;
}

interface Probe {
  name: string;
  host: string;
  path: string;
  query?: Record<string, string | number | boolean | readonly (string | number)[]>;
}

const probes: Probe[] = [
  { name: "user-details", host: HOSTS.routeApi, path: "/user/get/user-details" },
  { name: "acl", host: HOSTS.cloudApi, path: "/warden/televendcloud/access-control-list" },
  { name: "machines", host: HOSTS.cloudApi, path: `/machinist/api/v1/${T}/machines`, query: { page: 1, page_size: 5 } },
  {
    name: "vends",
    host: HOSTS.cloudApi,
    path: `/machinist/api/v1/${T}/vends`,
    query: { page: 1, page_size: 5, from_timestamp: from, to_timestamp: to, machine_mode: "live" },
  },
  {
    name: "vends-aggregates",
    host: HOSTS.cloudApi,
    path: `/machinist/api/v1/${T}/vends/aggregates`,
    query: { from_timestamp: from, to_timestamp: to, machine_mode: "live" },
  },
  {
    name: "events",
    host: HOSTS.cloudApi,
    path: `/machinist/api/v1/${T}/events`,
    query: { page: 1, page_size: 5, from_timestamp: from, to_timestamp: to },
  },
  { name: "collections", host: HOSTS.cloudApi, path: `/cashtrack/v1/${T}/collections`, query: { page: 1, page_size: 5 } },
  { name: "refills-details", host: HOSTS.cloudApi, path: `/refillator/api/v1/refill-log-list/${C}/details`, query: { date: from, page: 1, page_size: 5 } },
  { name: "refills-statistic", host: HOSTS.cloudApi, path: `/refillator/api/v1/refill-log-list/${C}/statistic`, query: { date: day } },
  { name: "dashboard-vends-today", host: HOSTS.webApi, path: `/api/dashboard/v1/${C}/stats/vends/today` },
  { name: "machine-status-now", host: HOSTS.webApi, path: `/api/dashboard/v1/${C}/stats/machine/status-now` },
];

const summary: Record<string, unknown> = {};
for (const p of probes) {
  const url = TelevendClient.url(p.host, p.path, p.query);
  const before = calls.length;
  try {
    const body = await client.get(url);
    writeFileSync(join(outDir, `${p.name}.json`), JSON.stringify(body, null, 2));
    summary[p.name] = { ok: true, shape: shape(body) };
  } catch (err) {
    const last = calls.slice(before).at(-1);
    if (last?.body) writeFileSync(join(outDir, `${p.name}.error.json`), JSON.stringify(last.body, null, 2));
    summary[p.name] = {
      ok: false,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      status: last?.status,
      errorShape: last?.body ? shape(last.body) : undefined,
    };
  }
}

writeFileSync(join(outDir, "_summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(
  `\nRequests sent: ${client.sent} (+ ${session.passwordSignIns} sign-in). Statuses: ${calls.map((c) => `${c.ruleId}=${c.status}`).join(", ")}`,
);
console.log(`Raw responses saved under ${outDir} (git-ignored).`);
