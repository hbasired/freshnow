// Prints the URLs to use right now, and whether each service is actually up.
// The wifi IP changes every time the machine reconnects, so rather than hunting
// through ipconfig before a demo: `pnpm urls`.
import "dotenv/config";
import { networkInterfaces } from "node:os";
import { execFileSync } from "node:child_process";

function wifiIp() {
  const nets = networkInterfaces();
  // Prefer a Wi-Fi adapter; skip loopback, link-local and the WSL/Hyper-V bridge.
  for (const [name, addrs] of Object.entries(nets)) {
    if (!/wi-?fi|wlan/i.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254.")) return a.address;
    }
  }
  for (const [name, addrs] of Object.entries(nets)) {
    if (/vethernet|wsl|loopback|docker/i.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254.")) return a.address;
    }
  }
  return null;
}

async function probe(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    return `HTTP ${r.status}`;
  } catch {
    return "DOWN";
  }
}

/** host:port/db of a connection string, never the password. */
function where(url) {
  if (!url) return "not set";
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || 5432}${u.pathname} as ${u.username}`;
  } catch {
    return "unparseable";
  }
}

/**
 * The Cloudflare quick tunnel's public name, asked of cloudflared itself: its local metrics
 * server (the first free port of 20241–20245) answers GET /quicktunnel with
 * {"hostname":"<words>.trycloudflare.com"}. Reading the log instead meant scrolling back past
 * cloudflared's connectivity checks to find a box printed once at start-up.
 */
async function tunnelHost() {
  for (let port = 20241; port <= 20245; port++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/quicktunnel`, { signal: AbortSignal.timeout(1500) });
      if (!r.ok) continue;
      const d = await r.json();
      if (typeof d?.hostname === "string" && d.hostname) return d.hostname.replace(/^https?:\/\//, "").replace(/\/$/, "");
    } catch {
      /* nothing on this port */
    }
  }
  return null;
}

const ip = wifiIp();
const tunnel = await tunnelHost();
const supabase = process.env.SUPABASE_URL ? new URL(process.env.SUPABASE_URL) : null;
// Since 2026-09-28 a phone signs in THROUGH the API on port 3001 (routes/auth-proxy.ts), so
// it no longer needs Supabase's own port. Probe that the API can reach Supabase Auth — the
// JWKS path answers without an API key.
const authProbe = () => `http://127.0.0.1:${supabase.port}/auth/v1/.well-known/jwks.json`;

console.log("\n═══ FreshNow — current URLs ═══\n");

console.log("  ON YOUR PHONE (any network — mobile data works)");
if (tunnel) {
  // Probed from this PC through Cloudflare and back, so HTTP 200 means the whole path works.
  // A tunnel started seconds ago can still say DOWN while its name spreads; try again shortly.
  console.log(`    Phone      https://${tunnel}/app/   ${await probe(`https://${tunnel}/health`)}`);
  console.log("    Send that address to your phone (e.g. Telegram → Saved Messages) and open it there.");
  console.log("    Keep the cloudflared window open: a restart gives a new address (DEMO-GUIDE-APP.md §5.3).");
} else {
  console.log("    No Cloudflare tunnel found. Start one in its own window:");
  console.log("      cloudflared tunnel --url http://localhost:3001");
}
if (ip) {
  const lan = await probe(`http://${ip}:3001/app/`);
  console.log(`    Wi-Fi      http://${ip}:3001/app/   ${lan}` +
    (lan === "DOWN" ? "   (expected with HOST=127.0.0.1 — the API listens on this PC only; use the tunnel)" : "   (no notifications on plain http — use the tunnel)"));
}

console.log("\n  ON THIS PC");
console.log(`    Dashboard  http://localhost:3001/app/   ${await probe("http://localhost:3001/health")}`);
if (supabase) {
  console.log(`    Sign-in    Supabase Auth ${await probe(authProbe())}   (reached through the API; nothing to open on the phone)`);
  console.log(`    Studio     http://localhost:54323       ${await probe("http://localhost:54323/")}   (Supabase database browser)`);
}
console.log(`    Web push   ${process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT ? "VAPID keys set" : "NOT set up — no VAPID_* keys in .env (DEMO-GUIDE-APP.md §2)"}`);
console.log(`    Adminer    http://localhost:8080        ${await probe("http://localhost:8080/")}   (the old Postgres, kept for rollback)`);

console.log("\n  SIGN-IN");
console.log(
  supabase
    ? "    Required. Accounts are linked with: pnpm link:user \"<employee>\" <email>"
    : "    Off (demo mode): anyone on the wifi can open the dashboard as any viewer.",
);

// The bot needs no local network at all — it only makes outbound calls to Telegram.
const token = process.env.BOT_TOKEN;
let bot = "BOT_TOKEN not set";
if (token) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(8000) });
    const d = await r.json();
    bot = d.ok ? `@${d.result.username} reachable` : "token rejected";
  } catch {
    bot = "cannot reach api.telegram.org from this network right now (the bot retries on its own)";
  }
}
console.log("\n  TELEGRAM (outbound only — no local network needed)");
console.log(`    Bot        ${bot}`);

function containers(args) {
  try {
    return execFileSync("docker", args, { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  } catch {
    return null;
  }
}
const compose = containers(["compose", "ps", "--format", "{{.Name}} {{.Status}}"]);
const sb = containers(["ps", "--filter", "label=com.supabase.cli.project=freshnow", "--format", "{{.Names}} {{.Status}}"]);
if (!compose && !sb) {
  console.log("\n  CONTAINERS: docker not reachable");
} else {
  console.log("\n  CONTAINERS");
  for (const line of [...(compose ?? []), ...(sb ?? [])]) console.log(`    ${line}`);
  if (supabase && sb && sb.length === 0) console.log("    Supabase is not running — start it with: npx supabase start");
}

console.log(`\n  Database   ${where(process.env.DATABASE_URL)}`);
console.log(`  Redis      ${process.env.REDIS_URL ?? "not set"}\n`);
