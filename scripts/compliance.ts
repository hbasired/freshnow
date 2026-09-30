import "dotenv/config";
import { closeDb, complianceEvidence, evaluatePolicy, readRegistry, registryPath, type Finding } from "../packages/core/src/index.js";

/**
 * `pnpm compliance` — the policy checks, the record of processing, and the evidence, in the terminal.
 *
 *   pnpm compliance                 as configured now (demo: reported, never enforced)
 *   pnpm compliance --production    what would happen with IS_DEMO=false — run it before going live
 *
 * Exits 1 only when the checks run as production and a rule blocks, so it can gate a deploy.
 */

const asProduction = process.argv.includes("--production");
const env = asProduction ? { ...process.env, IS_DEMO: "false" } : process.env;
const reg = readRegistry(registryPath(env));
const report = evaluatePolicy({ registry: reg, env });

const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n - 1) + "…" : s + " ".repeat(n - s.length));
const line = (f: Finding) => `  ${f.rule}  ${pad(f.level.toUpperCase(), 6)} ${f.service ? `[${f.service}] ` : ""}${f.message}\n            → ${f.fix}`;

console.log(`\nFreshNow compliance — ${report.production ? "PRODUCTION (enforced)" : "demo (reported, not enforced)"}${asProduction ? " — preview" : ""}`);
console.log(`Registry: ${registryPath(env)}${"error" in reg ? `  ✗ ${reg.error}` : `  (reviewed ${reg.registry.reviewed_on})`}`);
console.log(`Reachable from this configuration: ${report.reachable.length ? report.reachable.join(", ") : "nothing outside the database"}`);

const blocks = report.findings.filter((f) => f.level === "block");
const warns = report.findings.filter((f) => f.level === "warn");
console.log(`\n${blocks.length} blocking, ${warns.length} warning(s)${report.production ? "" : " — in the demo, nothing is blocked"}:`);
for (const f of [...blocks, ...warns]) console.log(line(f));
if (!report.findings.length) console.log("  none");

if (!("error" in reg)) {
  const r = reg.registry;
  console.log(`\nRecord of processing — where personal data can go (host: ${r.hosting.name}, ${r.hosting.country}; retention: ${r.retention_days ?? "not set"} days)`);
  console.log(`  ${pad("service", 26)}${pad("role", 12)}${pad("country", 22)}${pad("ground", 22)}${pad("DPA", 14)}now`);
  for (const s of r.services) {
    console.log(
      `  ${pad(s.name, 26)}${pad(s.role, 12)}${pad(s.country, 22)}${pad(s.ground.join("+"), 22)}${pad(s.dpa.status + (s.dpa.accepted_on ? ` ${s.dpa.accepted_on}` : ""), 14)}${report.reachable.includes(s.id) ? "reachable" : "—"}`,
    );
  }
}

try {
  const e = await complianceEvidence({ days: 30 });
  console.log(`\nEvidence, last ${e.days} days (from the database)`);
  console.log(`  consent to notice ${e.consent.version}: ${e.consent.current} of ${e.consent.people} people · ${e.consent.older} on an older version · ${e.consent.none} never`);
  for (const a of e.ai) console.log(`  AI ${pad(a.provider, 12)} ${a.calls} calls (${a.ok} ok) · ${a.redacted} identifier(s) removed before sending`);
  for (const c of e.channels) console.log(`  channel ${pad(c.channel, 9)} ${c.sent} sent · ${c.held} waiting`);
  console.log(`  retention: ${e.retention.days ?? "not set"} · last aged ${e.retention.lastAgedAt ?? "never"} · ${e.retention.notesAged} note(s) aged`);
  console.log(`  rights: ${e.rights.exports} export(s) · ${e.rights.erasures} erasure(s) · ${e.rights.withdrawals} withdrawal(s) · last daily snapshot ${e.lastSnapshotAt ?? "none yet"}`);
} catch (err) {
  console.log(`\nEvidence: the database is not reachable (${err instanceof Error ? err.message : String(err)}) — start it and run again.`);
} finally {
  await closeDb();
}
console.log("");
process.exit(report.refuse ? 1 : 0);
