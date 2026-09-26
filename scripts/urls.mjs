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

const ip = wifiIp();
const supabase = process.env.SUPABASE_URL ? new URL(process.env.SUPABASE_URL) : null;
// The phone signs in against Supabase Auth directly, so it must reach that port too.
// The JWKS path answers without an API key, which makes it a clean reachability probe.
const authProbe = (host) => `http://${host}:${supabase.port}/auth/v1/.well-known/jwks.json`;

console.log("\n═══ FreshNow — current URLs ═══\n");

if (!ip) {
  console.log("  Could not find a Wi-Fi IPv4 address. Are you on wifi?");
} else {
  console.log(`  Wi-Fi IP: ${ip}\n`);
  console.log("  ON YOUR PHONE (must be on the same wifi)");
  console.log(`    Dashboard  http://${ip}:3001/app/   ${await probe(`http://${ip}:3001/app/`)}`);
  if (supabase) {
    console.log(`    Sign-in    http://${ip}:${supabase.port}      ${await probe(authProbe(ip))}   (Supabase Auth; the phone must reach it to log in)`);
  }
}

console.log("\n  ON THIS PC");
console.log(`    Dashboard  http://localhost:3001/app/   ${await probe("http://localhost:3001/health")}`);
if (supabase) {
  console.log(`    Studio     http://localhost:54323       ${await probe("http://localhost:54323/")}   (Supabase database browser)`);
}
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
